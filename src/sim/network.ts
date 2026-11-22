import { ProcessTopology, StreamKind, UnitSpec, findUnit } from '../model/topology';
import { PLANT } from './config';
import { deriveEdgeGeometry, splitByResistance, type EdgeGeometry, type SplitBranch } from './hydraulics';

/**
 * 拓扑 → 可求解网络的编译器。
 *
 * 这一层解决"图上画几个池，引擎就解几个池"：把 train 里的单元编译成反应器，
 * 按连通性做拓扑排序，并把回流边标记为"已知流量"（由控制变量给出），
 * 其余边的流量由前向物料平衡推导。
 */

export type ReactorKind = 'anaerobic' | 'anoxic' | 'aerobic';

export interface CompiledReactor {
  id: string;
  name: string;
  kind: ReactorKind;
  volume: number;
  /** 拓扑序，0 为最上游 */
  order: number;
}

export interface CompiledEdge {
  id: string;
  from: string;
  to: string;
  fromPort: string;
  toPort: string;
  stream: StreamKind;
  /** 回流边：流量由控制变量决定，不由物料平衡推导 */
  recycle: boolean;
  /** 回流类型，用于取对应的控制量 */
  recycleKind?: 'ras' | 'internal' | 'was';
  /**
   * 厂外来水的语义表达式名：'influentFlow'=主进水干管，'stepFeedFraction'=多点进水，
   * 'returnFlow'=调蓄回流，'stormDivertFlow'=暴雨旁通（不进反应器）。
   * 流量分流必须按此语义确定，不能依赖边的声明顺序。
   */
  flowRef?: string;
  /** 所属系列（train）id；单系列拓扑为空串 */
  trainId?: string;
  /** 边几何/设备参数（WP3 水力学） */
  geometry: EdgeGeometry;
}

/** 一条完整系列：自己的反应器链 + 二沉池 + 独立 RAS/WAS 回流 */
export interface CompiledTrain {
  id: string;
  reactorIds: string[];
  clarifierId: string;
}

export interface CompiledClarifier {
  id: string;
  area: number;
  depth: number;
}

export interface CompiledNetwork {
  topologyId: string;
  reactors: CompiledReactor[];
  edges: CompiledEdge[];
  /** 主序列最后一个反应器 → 二沉池（向后兼容：第一条系列） */
  clarifierFrom: string;
  clarifierId: string;
  /** 全部二沉池（多系列） */
  clarifiers: CompiledClarifier[];
  /** 全部系列 */
  trains: CompiledTrain[];
  bioVolume: number;
  aerobicVolume: number;
  anoxicVolume: number;
  anaerobicVolume: number;
  /** 拓扑校验发现的问题（编译期），非空则不可求解 */
  problems: string[];
  /**
   * 编译期索引（只读）。
   *
   * 计算路径每步都会用「某反应器的入边/出边」「按拓扑序的反应器」，
   * 旧实现每步都对 edges 做 filter + sort：单步 0.017 ms 里有一半花在这里，
   * 而且返回值顺序依赖数组顺序，属于隐式耦合。编译一次、按 id 取值。
   */
  incomingByReactor: Record<string, CompiledEdge[]>;
  outgoingByReactor: Record<string, CompiledEdge[]>;
  /** 按拓扑序排列的反应器 id（0 = 最上游） */
  order: string[];
}

function kindOf(unit: UnitSpec): ReactorKind | null {
  if (unit.kind === 'anaerobic') return 'anaerobic';
  if (unit.kind === 'anoxic') return 'anoxic';
  if (unit.kind === 'aerobic') return 'aerobic';
  return null;
}

function recycleKindOf(stream: StreamKind): 'ras' | 'internal' | 'was' | undefined {
  if (stream === 'return_activated_sludge') return 'ras';
  if (stream === 'internal_recycle') return 'internal';
  if (stream === 'waste_sludge') return 'was';
  return undefined;
}

/**
 * 编译拓扑。只把 train 里的单元当作反应器；其余单元（格栅、初沉、消毒）
 * 视为无反应的通路，其流量直接传递，不进入状态方程。
 */
export function compileNetwork(topo: ProcessTopology): CompiledNetwork {
  const problems: string[] = [];
  const reactorIds = new Set(topo.train);
  const reactors: CompiledReactor[] = [];

  for (const id of topo.train) {
    const unit = findUnit(topo, id);
    if (!unit) {
      problems.push(`主序列引用了不存在的单元 ${id}`);
      continue;
    }
    const kind = kindOf(unit);
    if (!kind) {
      problems.push(`单元 ${unit.name} 的类型 ${unit.kind} 不是反应器，不能放入主序列`);
      continue;
    }
    if (!unit.volume || unit.volume <= 0) {
      problems.push(`反应器 ${unit.name} 缺少有效容积`);
      continue;
    }
    reactors.push({
      id: unit.id,
      name: unit.name,
      kind,
      volume: unit.volume,
      order: 0,
    });
  }

  const clarifierUnits = topo.units.filter((u) => u.kind === 'clarifier');
  if (clarifierUnits.length === 0) problems.push('缺少二沉池');
  if (reactors.length === 0) problems.push('主序列没有可求解的反应器');

  const unitById = new Map(topo.units.map((u) => [u.id, u]));

  // 边：只保留与反应器相关的连接
  const edges: CompiledEdge[] = [];
  for (const conn of topo.connections) {
    const fromReactor = reactorIds.has(conn.from.unit);
    const toReactor = reactorIds.has(conn.to.unit);
    if (!fromReactor && !toReactor) continue;
    const recycleKind = recycleKindOf(conn.stream);
    const recycle = Boolean(recycleKind) || Boolean(conn.recycle);
    const fromUnit = unitById.get(conn.from.unit);
    const toUnit = unitById.get(conn.to.unit);
    edges.push({
      id: conn.id,
      from: conn.from.unit,
      to: conn.to.unit,
      fromPort: conn.from.port,
      toPort: conn.to.port,
      stream: conn.stream,
      recycle,
      recycleKind,
      flowRef: conn.flowRef,
      geometry: deriveEdgeGeometry(fromUnit?.meta, toUnit?.meta),
    });
  }

  // 拓扑排序：只用非回流边，保证前向顺序。
  // 回流判定以 recycleKind（由物流种类推导）为准，不信任 recycle 标志——
  // 那是客户端可控的界面绘制方向，曾被用来给普通边打标绕过环路检测
  const order = topologicalOrder(
    reactors.map((r) => r.id),
    edges.filter((e) => e.recycleKind === undefined),
  );
  if (order.length !== reactors.length) {
    problems.push('主序列存在环路，无法确定求解顺序');
  }
  const orderIndex = new Map(order.map((id, i) => [id, i]));
  for (const r of reactors) r.order = orderIndex.get(r.id) ?? reactors.length;

  // ── 多系列识别：每个二沉池向上回溯自己的反应器链 ──
  // 前向反应器间边（非回流）用于回溯；系列内的边与回流边打上 trainId。
  const forwardReactorEdges = edges.filter(
    (e) => e.recycleKind === undefined && reactorIds.has(e.from) && reactorIds.has(e.to),
  );
  const clarifiers: CompiledClarifier[] = clarifierUnits.map((u) => ({
    id: u.id,
    area: u.area ?? PLANT.clarifier.area,
    depth: u.depth ?? PLANT.clarifier.depth,
  }));

  const trains: CompiledTrain[] = clarifierUnits.map((clarUnit, trainIdx) => {
    const seedReactors = edges.filter((e) => e.to === clarUnit.id && reactorIds.has(e.from)).map((e) => e.from);
    const chain = new Set<string>(seedReactors);
    const queue = [...seedReactors];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const prev of forwardReactorEdges.filter((e) => e.to === cur)) {
        if (!chain.has(prev.from)) {
          chain.add(prev.from);
          queue.push(prev.from);
        }
      }
    }
    const reactorIdsInChain = reactors
      .filter((r) => chain.has(r.id))
      .sort((a, b) => a.order - b.order)
      .map((r) => r.id);
    const trainId = trainIdx === 0 ? clarUnit.id : `train-${clarUnit.id}`;
    // 系列内前向边 + 该二沉池引出的回流边归属本系列
    for (const e of edges) {
      if (chain.has(e.from) || chain.has(e.to)) e.trainId = trainId;
      if (e.recycleKind && e.from === clarUnit.id) e.trainId = trainId;
    }
    return { id: trainId, reactorIds: reactorIdsInChain, clarifierId: clarUnit.id };
  });

  // 二沉池的来水：主序列里最靠后的反应器（没有前向出边的那个）
  let lastReactor = reactors[0];
  for (const r of reactors) {
    if (r.order > lastReactor.order) lastReactor = r;
  }
  const clarifierFrom = lastReactor?.id ?? '';

  const incomingByReactor: Record<string, CompiledEdge[]> = {};
  const outgoingByReactor: Record<string, CompiledEdge[]> = {};
  for (const r of reactors) {
    incomingByReactor[r.id] = edges.filter((e) => e.to === r.id);
    outgoingByReactor[r.id] = edges.filter((e) => e.from === r.id);
  }

  const bioVolume = reactors.reduce((s, r) => s + r.volume, 0);
  const aerobicVolume = reactors.filter((r) => r.kind === 'aerobic').reduce((s, r) => s + r.volume, 0);
  const anoxicVolume = reactors.filter((r) => r.kind === 'anoxic').reduce((s, r) => s + r.volume, 0);
  const anaerobicVolume = reactors.filter((r) => r.kind === 'anaerobic').reduce((s, r) => s + r.volume, 0);

  return {
    topologyId: topo.id,
    reactors,
    edges,
    clarifierFrom,
    clarifierId: clarifiers[0]?.id ?? 'clarifier',
    clarifiers,
    trains,
    bioVolume,
    aerobicVolume,
    anoxicVolume,
    anaerobicVolume,
    problems,
    incomingByReactor,
    outgoingByReactor,
    order: [...reactors].sort((a, b) => a.order - b.order).map((r) => r.id),
  };
}

function topologicalOrder(ids: string[], forwardEdges: CompiledEdge[]): string[] {
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of forwardEdges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const nxt of adj.get(cur) ?? []) {
      const d = (indegree.get(nxt) ?? 1) - 1;
      indegree.set(nxt, d);
      if (d === 0) queue.push(nxt);
    }
  }
  return out;
}

/** 单条支路在分流求解时的阻力描述（由水力学层按边几何给出） */
export interface FlowBranchHydraulics {
  resistance: number;
  closed: boolean;
  capacityM3h: number;
}

/**
 * 求每条边在给定控制量下的流量（m³/h）。
 *
 * 规则：
 * - 回流边流量由控制变量决定：RAS = ras×Q，IR = ir×Q，WAS = was×Q
 * - 前向边：节点入流减去被抽走的回流，按**支路阻力**分配（等阻力时退化为均分）
 * - 若某反应器没有入流但有进水干管进入，则按 Q 计
 *
 * `branchHydraulics` 缺省时所有支路阻力相同，保持旧的均分语义；
 * 传入后按 Qᵢ ∝ 1/√Rᵢ 阻力分流，总量守恒。
 */
export function resolveFlows(
  network: CompiledNetwork,
  inflow: number,
  controls: { ras: number; ir: number; was: number; stepFeed?: number },
  branchHydraulics?: Map<string, FlowBranchHydraulics>,
): {
  edgeFlow: Map<string, number>;
  reactorInflow: Map<string, number>;
  reactorOutflow: Map<string, number>;
  splitStatus: Map<string, 'ok' | 'unsolvable'>;
} {
  const edgeFlow = new Map<string, number>();
  const reactorInflow = new Map<string, number>();
  const reactorOutflow = new Map<string, number>();
  const splitStatus = new Map<string, 'ok' | 'unsolvable'>();

  const Qir = inflow * controls.ir;

  const reactorIds = new Set(network.reactors.map((r) => r.id));
  const ordered = [...network.reactors].sort((a, b) => a.order - b.order);

  /** 水力边（排除空气与药剂）；编译期已按反应器建好索引 */
  const hydraulicIn = (id: string) =>
    (network.incomingByReactor[id] ?? []).filter((e) => e.stream !== 'air' && e.stream !== 'chemical');
  const hydraulicOut = (id: string) =>
    (network.outgoingByReactor[id] ?? []).filter((e) => e.stream !== 'air' && e.stream !== 'chemical');

  // 1. 厂外来水分配（全图一次）。
  // 支持多点进水：直接进入缺氧池的那条支线（flowRef='stepFeedFraction'）
  // 按 stepFeed 比例分走一部分原水，其余原水进主进水边。
  const stepFeedShare = Math.min(0.5, Math.max(0, controls.stepFeed ?? 0));
  const stepFeedEdges = network.edges.filter(
    (x) => x.flowRef === 'stepFeedFraction' && !reactorIds.has(x.from) && !x.recycle,
  );
  const stepFeedFlow = stepFeedEdges.length > 0 ? inflow * stepFeedShare : 0;
  for (const se of stepFeedEdges) {
    edgeFlow.set(se.id, stepFeedFlow / stepFeedEdges.length);
  }

  // 主进水边：外部进水边中带 'influentFlow' 语义的那些；没有则退化为第一条（确定性兜底）。
  // 多系列拓扑可有多个主进水头，剩余原水在主进水边间均分。
  const externalInfluent = network.edges.filter(
    (x) => !reactorIds.has(x.from) && !x.recycle && x.stream === 'influent',
  );
  const mainEdges = externalInfluent.filter((x) => x.flowRef === 'influentFlow');
  const mainList = mainEdges.length > 0 ? mainEdges : externalInfluent.filter((x) => !stepFeedEdges.includes(x));
  const mainFlow = inflow - stepFeedFlow;
  for (const x of externalInfluent) {
    if (!edgeFlow.has(x.id)) edgeFlow.set(x.id, 0);
  }
  if (mainList.length > 0) {
    for (const me of mainList) edgeFlow.set(me.id, mainFlow / mainList.length);
  }

  // 2. 回流边按系列定值：RAS/WAS = 本系列进水总量（主进水 + 多点进水）× 控制比；
  // 内回流按全厂流量。单系列进水总量 = 全厂进水，与旧口径一致（RAS = ras×Q）。
  const trainFeed = new Map<string, number>();
  for (const x of externalInfluent) {
    const t = x.trainId ?? network.trains[0]?.id ?? '';
    trainFeed.set(t, (trainFeed.get(t) ?? 0) + (edgeFlow.get(x.id) ?? 0));
  }
  const legacyFeed = mainList.length > 0 ? mainFlow : inflow;
  const feedOf = (e: CompiledEdge) => trainFeed.get(e.trainId ?? '') ?? legacyFeed;

  for (const e of network.edges) {
    if (e.recycleKind === 'ras') edgeFlow.set(e.id, feedOf(e) * controls.ras);
    else if (e.recycleKind === 'internal') edgeFlow.set(e.id, Qir);
    else if (e.recycleKind === 'was') edgeFlow.set(e.id, feedOf(e) * controls.was);
    else if (e.stream === 'air' || e.stream === 'chemical') edgeFlow.set(e.id, 0);
  }

  // 3. 按拓扑序做一次水力传播。每个节点的入流只由「已确定的上游出流」+「回流」+「厂外来水」组成。
  for (const reactor of ordered) {
    let qIn = 0;

    for (const e of hydraulicIn(reactor.id)) {
      if (e.recycle) {
        qIn += edgeFlow.get(e.id) ?? 0; // 回流边已在第 1 步定值
        continue;
      }
      if (reactorIds.has(e.from)) {
        // 上游出流：拓扑序保证此时已算出
        qIn += edgeFlow.get(e.id) ?? 0;
        continue;
      }
      // 厂外来水（主进水 / 多点进水 / 调蓄回流）已在第 2 步定值
      qIn += edgeFlow.get(e.id) ?? 0;
    }

    reactorInflow.set(reactor.id, qIn);

    // 该节点出流 = 入流 - 被抽走的回流
    const outs = hydraulicOut(reactor.id);
    const recycleOut = outs.filter((e) => e.recycle).reduce((sum, e) => sum + (edgeFlow.get(e.id) ?? 0), 0);
    const forwardOut = outs.filter((e) => !e.recycle);
    const available = Math.max(0, qIn - recycleOut);
    reactorOutflow.set(reactor.id, available);

    if (forwardOut.length > 0) {
      const branches: SplitBranch[] = forwardOut.map((e) => {
        const h = branchHydraulics?.get(e.id);
        return {
          edgeId: e.id,
          resistance: h?.resistance ?? 1,
          closed: h?.closed ?? false,
          capacityM3h: h?.capacityM3h ?? Number.POSITIVE_INFINITY,
        };
      });
      // 阻力分流：等阻力 → 均分（旧语义）；阻力不同 → Qᵢ ∝ 1/√Rᵢ
      const outcome = splitByResistance(available, branches);
      splitStatus.set(reactor.id, outcome.status);
      forwardOut.forEach((e, i) => edgeFlow.set(e.id, Math.max(0, outcome.flows[i])));
    }
  }

  return { edgeFlow, reactorInflow, reactorOutflow, splitStatus };
}

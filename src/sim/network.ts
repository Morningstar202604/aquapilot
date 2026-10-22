import { ProcessTopology, StreamKind, UnitSpec, findUnit } from '../model/topology';

/**
 * 拓扑 → 可求解网络的编译器。
 *
 * 这一层解决"图上画几个池，引擎就解几个池"：把 train 里的单元编译成反应器，
 * 按连通性做拓扑排序，并把回流边标记为"已知流量"（由控制变量给出），
 * 其余边的流量由前向物料平衡推导。
 */

export type ReactorKind = 'anaerobic' | 'anoxic' | 'aerobic';

export interface CompiledInlet {
  edgeId: string;
  fromReactor: string;
  stream: StreamKind;
}

export interface CompiledReactor {
  id: string;
  name: string;
  kind: ReactorKind;
  volume: number;
  /** 拓扑序，0 为最上游 */
  order: number;
  inlets: CompiledInlet[];
  /** 是否承接进水干管（而非只承接上游反应器） */
  receivesInfluent: boolean;
  /** 是否承接回流污泥 */
  receivesRas: boolean;
  /** 是否承接内回流 */
  receivesInternalRecycle: boolean;
}

export interface CompiledEdge {
  id: string;
  from: string;
  to: string;
  stream: StreamKind;
  /** 回流边：流量由控制变量决定，不由物料平衡推导 */
  recycle: boolean;
  /** 回流类型，用于取对应的控制量 */
  recycleKind?: 'ras' | 'internal' | 'was';
}

export interface CompiledNetwork {
  topologyId: string;
  reactors: CompiledReactor[];
  edges: CompiledEdge[];
  /** 主序列最后一个反应器 → 二沉池 */
  clarifierFrom: string;
  clarifierId: string;
  bioVolume: number;
  aerobicVolume: number;
  anoxicVolume: number;
  anaerobicVolume: number;
  /** 拓扑校验发现的问题（编译期），非空则不可求解 */
  problems: string[];
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
      inlets: [],
      receivesInfluent: false,
      receivesRas: false,
      receivesInternalRecycle: false,
    });
  }

  const clarifier = topo.units.find((u) => u.kind === 'clarifier');
  if (!clarifier) problems.push('缺少二沉池');
  if (reactors.length === 0) problems.push('主序列没有可求解的反应器');

  // 边：只保留与反应器相关的连接
  const edges: CompiledEdge[] = [];
  for (const conn of topo.connections) {
    const fromReactor = reactorIds.has(conn.from.unit);
    const toReactor = reactorIds.has(conn.to.unit);
    if (!fromReactor && !toReactor) continue;
    const recycleKind = recycleKindOf(conn.stream);
    const recycle = Boolean(recycleKind) || Boolean(conn.recycle);
    edges.push({
      id: conn.id,
      from: conn.from.unit,
      to: conn.to.unit,
      stream: conn.stream,
      recycle,
      recycleKind,
    });
  }

  // 入口类型标记
  for (const reactor of reactors) {
    const incoming = edges.filter((e) => e.to === reactor.id);
    for (const e of incoming) {
      reactor.inlets.push({
        edgeId: e.id,
        fromReactor: reactorIds.has(e.from) ? e.from : `__${e.stream}__`,
        stream: e.stream,
      });
      if (e.stream === 'influent' || e.stream === 'mixed_liquor') {
        if (!reactorIds.has(e.from)) reactor.receivesInfluent = true;
      }
      if (e.recycleKind === 'ras') reactor.receivesRas = true;
      if (e.recycleKind === 'internal') reactor.receivesInternalRecycle = true;
    }
  }

  // 拓扑排序：只用非回流边，保证前向顺序
  const order = topologicalOrder(
    reactors.map((r) => r.id),
    edges.filter((e) => !e.recycle),
  );
  if (order.length !== reactors.length) {
    problems.push('主序列存在环路，无法确定求解顺序');
  }
  const orderIndex = new Map(order.map((id, i) => [id, i]));
  for (const r of reactors) r.order = orderIndex.get(r.id) ?? reactors.length;

  // 二沉池的来水：主序列里最靠后的反应器（没有前向出边的那个）
  const lastReactor = [...reactors].sort((a, b) => b.order - a.order)[0];
  const clarifierFrom = lastReactor?.id ?? '';

  const bioVolume = reactors.reduce((s, r) => s + r.volume, 0);
  const aerobicVolume = reactors.filter((r) => r.kind === 'aerobic').reduce((s, r) => s + r.volume, 0);
  const anoxicVolume = reactors.filter((r) => r.kind === 'anoxic').reduce((s, r) => s + r.volume, 0);
  const anaerobicVolume = reactors.filter((r) => r.kind === 'anaerobic').reduce((s, r) => s + r.volume, 0);

  return {
    topologyId: topo.id,
    reactors,
    edges,
    clarifierFrom,
    clarifierId: clarifier?.id ?? 'clarifier',
    bioVolume,
    aerobicVolume,
    anoxicVolume,
    anaerobicVolume,
    problems,
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

/**
 * 求每条边在给定控制量下的流量（m³/h）。
 *
 * 规则：
 * - 回流边流量由控制变量决定：RAS = ras×Q，IR = ir×Q，WAS = was×Q
 * - 前向边：节点入流减去被抽走的回流，按出边平分
 * - 若某反应器没有入流但有进水干管进入，则按 Q 计
 */
export function resolveFlows(
  network: CompiledNetwork,
  inflow: number,
  controls: { ras: number; ir: number; was: number; stepFeed?: number },
): { edgeFlow: Map<string, number>; reactorInflow: Map<string, number>; reactorOutflow: Map<string, number> } {
  const edgeFlow = new Map<string, number>();
  const reactorInflow = new Map<string, number>();
  const reactorOutflow = new Map<string, number>();

  const Qr = inflow * controls.ras;
  const Qir = inflow * controls.ir;
  const Qw = inflow * controls.was;

  const reactorIds = new Set(network.reactors.map((r) => r.id));
  const ordered = [...network.reactors].sort((a, b) => a.order - b.order);

  /** 水力边（排除空气与药剂） */
  const hydraulicIn = (id: string) =>
    network.edges.filter((e) => e.to === id && e.stream !== 'air' && e.stream !== 'chemical');
  const hydraulicOut = (id: string) =>
    network.edges.filter((e) => e.from === id && e.stream !== 'air' && e.stream !== 'chemical');

  // 1. 回流边先定流量（由控制量决定，不参与前向平衡）
  for (const e of network.edges) {
    if (e.recycleKind === 'ras') edgeFlow.set(e.id, Qr);
    else if (e.recycleKind === 'internal') edgeFlow.set(e.id, Qir);
    else if (e.recycleKind === 'was') edgeFlow.set(e.id, Qw);
    else if (e.stream === 'air' || e.stream === 'chemical') edgeFlow.set(e.id, 0);
  }

  // 2. 按拓扑序做一次水力传播。每个节点的入流只由「已确定的上游出流」+「回流」+「厂外来水」组成。
  for (const reactor of ordered) {
    let qIn = 0;
    let externalAssigned = false;

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
      if (edgeFlow.has(e.id)) {
        // 多点进水等已在上游分配过的厂外支线
        qIn += edgeFlow.get(e.id) ?? 0;
        continue;
      }
      /**
       * 厂外来水分配。
       *
       * 支持多点进水：直接进入缺氧池的那条支线按 stepFeed 比例分走一部分原水，
       * 其余原水进首个反应器（厌氧池）。这样缺氧区才有碳源做反硝化，
       * 否则内回流会把 COD 稀释到几 mg/L，硝酸盐累积、TN 超标。
       */
      if (!externalAssigned) {
        const stepFeedEdges = network.edges.filter(
          (x) => x.stream === 'influent' && x.to !== reactor.id && !reactorIds.has(x.from) && !x.recycle,
        );
        const stepFeedShare = Math.min(0.5, Math.max(0, controls.stepFeed ?? 0));
        const stepFeedFlow = stepFeedEdges.length > 0 ? inflow * stepFeedShare : 0;

        for (const se of stepFeedEdges) {
          edgeFlow.set(se.id, stepFeedFlow / stepFeedEdges.length);
        }

        edgeFlow.set(e.id, inflow - stepFeedFlow);
        qIn += inflow - stepFeedFlow;
        externalAssigned = true;
      } else {
        edgeFlow.set(e.id, edgeFlow.get(e.id) ?? 0);
        qIn += edgeFlow.get(e.id) ?? 0;
      }
    }

    reactorInflow.set(reactor.id, qIn);

    // 该节点出流 = 入流 - 被抽走的回流
    const outs = hydraulicOut(reactor.id);
    const recycleOut = outs.filter((e) => e.recycle).reduce((sum, e) => sum + (edgeFlow.get(e.id) ?? 0), 0);
    const forwardOut = outs.filter((e) => !e.recycle);
    const available = Math.max(0, qIn - recycleOut);
    reactorOutflow.set(reactor.id, available);

    if (forwardOut.length > 0) {
      const each = available / forwardOut.length;
      for (const e of forwardOut) edgeFlow.set(e.id, each);
    }
  }

  return { edgeFlow, reactorInflow, reactorOutflow };
}

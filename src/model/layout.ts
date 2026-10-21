import { Connection, ProcessTopology, UnitSpec, outgoing, incoming } from '../model/topology';

/**
 * 自动布局：分层（主序列从左到右）+ 支线上下分流 + 回流走外侧。
 *
 * 这套规则来自主流流程模拟器（Aspen、HYSYS、GPS-X）的共同做法：
 * 主工艺链是读图主线，永远保持水平且不被打断；公用工程（鼓风、加药）
 * 挂在主线下方；污泥线挂在主线更下方；回流线绕到上方或下方外侧，
 * 避免与主物料流交叉。
 */

export type Layer = 'main' | 'utility' | 'sludge' | 'recycle';

export interface PlacedNode {
  unit: UnitSpec;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: Layer;
  lane: number;
}

export interface PlacedEdge {
  connection: Connection;
  path: string;
  labelX: number;
  labelY: number;
  reverse: boolean;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  lanes: { layer: Layer; y: number; label: string }[];
}

const GAP_X = 46;
const GAP_Y = 96;
const PAD = 32;

function sizeOf(unit: UnitSpec): { w: number; h: number } {
  switch (unit.kind) {
    case 'inlet':
    case 'outlet':
      return { w: 108, h: 62 };
    case 'clarifier':
      return { w: 148, h: 150 };
    case 'storage':
      return { w: 124, h: 92 };
    case 'blower':
    case 'chemical':
      return { w: 132, h: 88 };
    case 'thickener':
    case 'dewatering':
      return { w: 128, h: 88 };
    case 'screening':
    case 'grit':
    case 'primary':
    case 'disinfection':
      return { w: 128, h: 92 };
    default:
      return { w: 124, h: 112 };
  }
}

function layerOf(unit: UnitSpec, topo: ProcessTopology): Layer {
  // 主序列优先：参与回流不代表它是支线，二沉池就是回流链上的主工艺单元
  if (topo.train.includes(unit.id)) return 'main';
  if (unit.kind === 'blower' || unit.kind === 'chemical') return 'utility';
  if (unit.kind === 'thickener' || unit.kind === 'dewatering') return 'sludge';
  if (unit.kind === 'storage') return 'utility';
  // 其余参与水线的单元（二沉池、消毒池、进出水口）都属于主线
  return 'main';
}

export function layoutTopology(
  topo: ProcessTopology,
  opts: { compact?: boolean; maxRowWidth?: number; laneGap?: number } = {},
): Layout {
  const gapX = opts.compact ? 30 : GAP_X;
  const gapY = opts.laneGap ?? (opts.compact ? 88 : GAP_Y);

  const nodeMap = new Map<string, PlacedNode>();
  const laneY: Record<Layer, number> = { main: 0, utility: 0, sludge: 0, recycle: 0 };

  const mains = topo.units.filter((u) => layerOf(u, topo) === 'main' || layerOf(u, topo) === 'recycle');
  const utilities = topo.units.filter((u) => layerOf(u, topo) === 'utility');
  const sludges = topo.units.filter((u) => layerOf(u, topo) === 'sludge');

  // 主线顺序从水线连通性推导：从进水口沿非回流边做深度优先，
  // 这样"进水→格栅→初沉→生物池→二沉池→消毒→排放"才是真实读图顺序，
  // 而不是把 train 里的池子单独拎出来排。
  const ordered = orderMainLine(topo, mains);

  // 主线过长时折行，模拟 DCS 总览图的"分排"读图方式：
  // 第一排走到二沉池为止，第二排从消毒池继续，读图顺序不变。
  const maxRow = opts.maxRowWidth ?? Infinity;
  const xOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const rowHeights: number[] = [];
  let cursor = PAD;
  let row = 0;
  for (const unit of ordered) {
    const size = sizeOf(unit);
    if (maxRow !== Infinity && cursor > PAD && cursor + size.w > maxRow) {
      rowHeights[row] = rowHeights[row] ?? 0;
      row += 1;
      cursor = PAD;
    }
    xOf.set(unit.id, cursor);
    rowOf.set(unit.id, row);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.h);
    cursor += size.w + gapX;
  }
  const mainWidth = cursor - gapX;

  const rowY: number[] = [];
  let acc = PAD;
  for (let r = 0; r <= row; r++) {
    rowY[r] = acc;
    acc += (rowHeights[r] ?? 120) + (opts.compact ? 52 : 66);
  }

  for (const unit of ordered) {
    const size = sizeOf(unit);
    const r = rowOf.get(unit.id) ?? 0;
    nodeMap.set(unit.id, { unit, x: xOf.get(unit.id)!, y: rowY[r], w: size.w, h: size.h, layer: 'main', lane: r });
  }
  const mainBottom = Math.max(...[...nodeMap.values()].map((n) => n.y + n.h));

  // 公用工程：吸附在其主要输出目标的正下方，避免斜跨主线
  let utilY = mainBottom + gapY;
  const utilCursor = new Map<string, number>();
  for (const unit of utilities) {
    const targets = outgoing(topo, unit.id).map((c) => c.to.unit);
    const anchor = targets.find((t) => xOf.has(t));
    const anchorX = anchor ? xOf.get(anchor)! : PAD;
    const size = sizeOf(unit);
    const key = anchor ?? '_';
    const used = utilCursor.get(key) ?? 0;
    const x = anchorX + used * (size.w + gapX);
    utilCursor.set(key, used + 1);
    nodeMap.set(unit.id, { unit, x, y: utilY, w: size.w, h: size.h, layer: 'utility', lane: 0 });
  }
  const utilBottom = utilities.length ? utilY + Math.max(...utilities.map((u) => sizeOf(u).h)) : mainBottom;

  // 污泥线：对齐到二沉池正下方，让"泥从哪来"一眼可见
  const sludgeY = utilBottom + gapY;
  const clarifierX = nodeMap.get('clarifier')?.x ?? Math.max(...[...nodeMap.values()].map((n) => n.x)) - 300;
  let sludgeCursor = Math.max(PAD, clarifierX - 60);
  for (const unit of sludges) {
    const size = sizeOf(unit);
    nodeMap.set(unit.id, { unit, x: sludgeCursor, y: sludgeY, w: size.w, h: size.h, layer: 'sludge', lane: 0 });
    sludgeCursor += size.w + gapX;
  }
  const bottom = sludges.length ? sludgeY + Math.max(...sludges.map((u) => sizeOf(u).h)) : utilBottom;

  for (const layer of ['main', 'utility', 'sludge'] as Layer[]) {
    const nodes = [...nodeMap.values()].filter((n) => n.layer === layer);
    if (nodes.length) laneY[layer] = nodes[0].y;
  }

  const edges = topo.connections.map((conn) => placeEdge(conn, nodeMap, topo));

  const maxX = Math.max(...[...nodeMap.values()].map((n) => n.x + n.w), mainWidth + PAD);
  const maxY = Math.max(bottom, ...edges.map((e) => e.labelY + 10));

  return {
    nodes: [...nodeMap.values()],
    edges,
    width: maxX + PAD,
    height: maxY + PAD,
    lanes: (
      [
        { layer: 'main', y: laneY.main, label: '主处理线' },
        { layer: 'utility', y: laneY.utility, label: '公用工程' },
        { layer: 'sludge', y: laneY.sludge, label: '污泥线' },
      ] satisfies { layer: Layer; y: number; label: string }[]
    ).filter((l) => Number.isFinite(l.y) && l.y > 0),
  };
}

/** 从进水口沿非回流物流推导主线顺序；未连通的单元追加在末尾，避免丢失 */
function orderMainLine(topo: ProcessTopology, mains: UnitSpec[]): UnitSpec[] {
  const mainIds = new Set(mains.map((u) => u.id));
  const adj = new Map<string, string[]>();
  for (const c of topo.connections) {
    if (isRecycleStream(c)) continue;
    if (!mainIds.has(c.from.unit) || !mainIds.has(c.to.unit)) continue;
    if (!adj.has(c.from.unit)) adj.set(c.from.unit, []);
    adj.get(c.from.unit)!.push(c.to.unit);
  }

  const start = topo.units.find((u) => u.kind === 'inlet')?.id ?? mains[0]?.id;
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = start ? [start] : [];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    order.push(cur);
    // 逆序压栈，保证连接声明顺序被尊重
    const nexts = (adj.get(cur) ?? []).slice().reverse();
    for (const n of nexts) if (!seen.has(n)) stack.push(n);
  }

  const byId = new Map(mains.map((u) => [u.id, u]));
  const result: UnitSpec[] = order.map((id) => byId.get(id)).filter((u): u is UnitSpec => Boolean(u));
  for (const u of mains) if (!seen.has(u.id)) result.push(u);
  return result;
}

function anchorOut(node: PlacedNode, portId: string): { x: number; y: number } {
  const ports = node.unit.ports.filter((p) => p.kind === 'out');
  const idx = Math.max(0, ports.findIndex((p) => p.id === portId));
  const step = node.h / (ports.length + 1);
  return { x: node.x + node.w, y: node.y + step * (idx + 1) };
}

function anchorIn(node: PlacedNode, portId: string): { x: number; y: number } {
  const ports = node.unit.ports.filter((p) => p.kind === 'in');
  const idx = Math.max(0, ports.findIndex((p) => p.id === portId));
  const step = node.h / (ports.length + 1);
  return { x: node.x, y: node.y + step * (idx + 1) };
}

function isRecycleStream(conn: Connection): boolean {
  return (
    Boolean(conn.recycle) ||
    conn.stream === 'internal_recycle' ||
    conn.stream === 'return_activated_sludge'
  );
}

function placeEdge(conn: Connection, nodes: Map<string, PlacedNode>, topo: ProcessTopology): PlacedEdge {
  const from = nodes.get(conn.from.unit);
  const to = nodes.get(conn.to.unit);
  if (!from || !to) {
    return { connection: conn, path: '', labelX: 0, labelY: 0, reverse: false };
  }
  const a = anchorOut(from, conn.from.port);
  const b = anchorIn(to, conn.to.port);

  // 回流与跨层物流：走外侧折线，避免与主物料流交叉
  const isRecycle = isRecycleStream(conn);
  const crossLayer = from.layer !== to.layer;

  if (isRecycle) {
    // 内回流走主线上方、污泥回流走生物池与公用工程之间的走廊：
    // 两条回流都不穿过任何池体，读图时能直接看出"从哪回到哪"
    const isRas = conn.stream === 'return_activated_sludge';
    const offset = isRas ? from.y + from.h + 30 : Math.min(from.y, to.y) - 26;
    const midX1 = a.x + 22;
    const midX2 = b.x - 22;
    const path = `M ${a.x} ${a.y} H ${midX1} V ${offset} H ${midX2} V ${b.y} H ${b.x}`;
    return {
      connection: conn,
      path,
      labelX: (midX1 + midX2) / 2,
      labelY: isRas ? offset + 12 : offset - 8,
      reverse: true,
    };
  }

  if (crossLayer) {
    const midY = b.y - 22;
    const path = `M ${a.x} ${a.y} H ${a.x + 20} V ${midY} H ${b.x - 20} V ${b.y} H ${b.x}`;
    return { connection: conn, path, labelX: (a.x + b.x) / 2, labelY: midY - 5, reverse: false };
  }

  // 折行回转：上一排末端 → 下一排首端，走两排之间的走廊，不穿过任何池体
  if (from.lane !== to.lane) {
    const gutterY = from.y + from.h + (to.y - (from.y + from.h)) * 0.55;
    const outX = a.x + 26;
    const inX = b.x - 26;
    const path = `M ${a.x} ${a.y} H ${outX} V ${gutterY} H ${inX} V ${b.y} H ${b.x}`;
    return { connection: conn, path, labelX: (outX + inX) / 2, labelY: gutterY - 5, reverse: false };
  }

  if (Math.abs(a.y - b.y) < 2) {
    const path = `M ${a.x} ${a.y} H ${b.x}`;
    return { connection: conn, path, labelX: (a.x + b.x) / 2, labelY: a.y - 7, reverse: false };
  }

  const midX = (a.x + b.x) / 2;
  const path = `M ${a.x} ${a.y} H ${midX} V ${b.y} H ${b.x}`;
  return { connection: conn, path, labelX: midX, labelY: (a.y + b.y) / 2, reverse: false };
}

/** 供编排器使用：拓扑变化时的连通性提示（哪些单元与进/出水不连通） */
export function unreachableUnits(topo: ProcessTopology): string[] {
  const start = topo.units.find((u) => u.kind === 'inlet')?.id;
  const end = topo.units.find((u) => u.kind === 'outlet')?.id;
  if (!start || !end) return [];

  const forward = new Map<string, Set<string>>();
  for (const c of topo.connections) {
    if (c.recycle) continue;
    if (!forward.has(c.from.unit)) forward.set(c.from.unit, new Set());
    forward.get(c.from.unit)!.add(c.to.unit);
  }

  const reach = (from: string, map: Map<string, Set<string>>) => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nxt of map.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return seen;
  };

  const fromInlet = reach(start, forward);
  const reversed = new Map<string, Set<string>>();
  for (const [k, set] of forward) {
    for (const v of set) {
      if (!reversed.has(v)) reversed.set(v, new Set());
      reversed.get(v)!.add(k);
    }
  }
  const toOutlet = reach(end, reversed);

  return topo.units.filter((u) => !fromInlet.has(u.id) || !toOutlet.has(u.id)).map((u) => u.id);
}

export function neighboringUnits(topo: ProcessTopology, unitId: string): { upstream: string[]; downstream: string[] } {
  return {
    upstream: incoming(topo, unitId).map((c) => c.from.unit),
    downstream: outgoing(topo, unitId).map((c) => c.to.unit),
  };
}

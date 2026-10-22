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
  /**
   * 是否为主线上的一段直连（端点同高）。
   *
   * 只有这类边画物流名：绕行走廊上的边如果也标名字，几条线会在同一条
   * 走廊里叠出四五个「进水」，比不标更难读。绕行线靠颜色与线型区分，
   * 图例已经给出对应关系。
   */
  straight: boolean;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  lanes: { layer: Layer; y: number; label: string }[];
}

const GAP_X = 46;
const GAP_Y = 78;
const PAD = 26;

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
  opts: { compact?: boolean; maxRowWidth?: number; laneGap?: number; rowGap?: number } = {},
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
  const rowGapPx = opts.rowGap ?? (opts.compact ? 52 : 66);
  for (let r = 0; r <= row; r++) {
    rowY[r] = acc;
    acc += (rowHeights[r] ?? 120) + rowGapPx;
  }

  for (const unit of ordered) {
    const size = sizeOf(unit);
    const r = rowOf.get(unit.id) ?? 0;
    nodeMap.set(unit.id, { unit, x: xOf.get(unit.id)!, y: rowY[r], w: size.w, h: size.h, layer: 'main', lane: r });
  }
  const mainBottom = Math.max(...[...nodeMap.values()].map((n) => n.y + n.h));

  // 公用工程：吸附在其主要输出目标的正下方，避免斜跨主线
  const utilY = mainBottom + gapY;
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
  for (const layer of ['main', 'utility', 'sludge'] as Layer[]) {
    const nodes = [...nodeMap.values()].filter((n) => n.layer === layer);
    if (nodes.length) laneY[layer] = nodes[0].y;
  }

  const edges = topo.connections.map((conn, i) => placeEdge(conn, nodeMap, i));

  const maxX = Math.max(...[...nodeMap.values()].map((n) => n.x + n.w), mainWidth + PAD);
  /**
   * 画布高度按内容收口。
   *
   * 之前用 `bottom`（最下层节点的底边）再加上边距，但没有考虑回流线可能绕到
   * 节点下方很远；同时 `edges` 参与的 max 会把高度撑到不需要的位置。
   * 这里只取「节点底边」与「回流线实际折返点」的较大者，避免大片空白。
   */
  const nodeBottom = Math.max(...[...nodeMap.values()].map((n) => n.y + n.h));
  const edgeBottom = edges.reduce((m, e) => Math.max(m, e.labelY + 8), 0);
  const maxY = Math.max(nodeBottom, edgeBottom);

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
  const idx = Math.max(
    0,
    ports.findIndex((p) => p.id === portId),
  );
  const step = node.h / (ports.length + 1);
  return { x: node.x + node.w, y: node.y + step * (idx + 1) };
}

function anchorIn(node: PlacedNode, portId: string): { x: number; y: number } {
  const ports = node.unit.ports.filter((p) => p.kind === 'in');
  const idx = Math.max(
    0,
    ports.findIndex((p) => p.id === portId),
  );
  const step = node.h / (ports.length + 1);
  return { x: node.x, y: node.y + step * (idx + 1) };
}

function isRecycleStream(conn: Connection): boolean {
  return Boolean(conn.recycle) || conn.stream === 'internal_recycle' || conn.stream === 'return_activated_sludge';
}

function placeEdge(conn: Connection, nodes: Map<string, PlacedNode>, index: number): PlacedEdge {
  const placed = placeEdgeRaw(conn, nodes, index);
  /**
   * 只有同排的顺流边标注物流名。
   *
   * 回流与跨层边都走走廊，几条线在同一走廊里并排时，标签会叠成
   * 一串「进水/进水/进水」。这类线靠颜色与线型区分，图例已给对应关系。
   */
  const from = nodes.get(conn.from.unit);
  const to = nodes.get(conn.to.unit);
  const labelable = Boolean(from && to) && !isRecycleStream(conn) && from!.layer === to!.layer;
  return { ...placed, straight: placed.path.length > 0 && labelable };
}

function placeEdgeRaw(conn: Connection, nodes: Map<string, PlacedNode>, index: number): Omit<PlacedEdge, 'straight'> {
  const from = nodes.get(conn.from.unit);
  const to = nodes.get(conn.to.unit);
  if (!from || !to) {
    return { connection: conn, path: '', labelX: 0, labelY: 0, reverse: false };
  }
  const a = anchorOut(from, conn.from.port);
  const b = anchorIn(to, conn.to.port);

  const isRecycle = isRecycleStream(conn);
  const crossLayer = from.layer !== to.layer;

  /**
   * 走廊高度：所有跨层/绕行线都走主排下方、公用工程上方的空白带。
   *
   * 早期实现用「端口 y - 22」当作走廊高度，而端口本身就在节点内部，
   * 结果水平段横穿池体顶部的标题栏，把 DO/MLSS 数字压在连线下。
   * 这里改为以节点边界为基准，并按边序号错开，避免多条线重叠成一条。
   */
  const mainBottom = Math.max(...[...nodes.values()].filter((n) => n.layer === 'main').map((n) => n.y + n.h));
  /**
   * 三条互不重叠的走廊，全部落在空白带里：
   * 内回流贴主排下方；公用工程线在主排与公用工程排之间；
   * 污泥回流在公用工程排下方、污泥排上方——否则会横穿鼓风机房与加药间。
   */
  const utilityBottom = Math.max(
    mainBottom,
    ...[...nodes.values()].filter((n) => n.layer === 'utility').map((n) => n.y + n.h),
  );
  const irTrack = mainBottom + 24;
  const utilTrack = mainBottom + 52 + (index % 3) * 7;
  const rasTrack = utilityBottom + 22;

  if (isRecycle) {
    // 回流走主排下方走廊：内回流在上、污泥回流在下，互不重叠
    const isRas = conn.stream === 'return_activated_sludge';
    const corridor = isRas ? rasTrack : irTrack;
    const outX = a.x + 24;
    const inX = b.x - 24;
    return {
      connection: conn,
      path: `M ${a.x} ${a.y} H ${outX} V ${corridor} H ${inX} V ${b.y} H ${b.x}`,
      labelX: (outX + inX) / 2,
      labelY: corridor - 7,
      reverse: true,
    };
  }

  if (crossLayer) {
    if (to.layer === 'sludge') {
      // 污泥线：从主排下来，走污泥排上方的走廊，从顶部进料
      const corridor = to.y - 18 - (index % 3) * 6;
      const cx = to.x + to.w / 2;
      const outX = a.x + 20;
      return {
        connection: conn,
        path: `M ${a.x} ${a.y} H ${outX} V ${corridor} H ${cx} V ${to.y}`,
        labelX: (outX + cx) / 2,
        labelY: corridor - 7,
        reverse: false,
      };
    }
    // 公用工程 → 主排：走主排下方走廊，从池底进入（空气/药剂本来就是从底部进池）
    if (to.layer === 'main') {
      const cx = to.x + to.w / 2;
      const outX = a.x + 18;
      return {
        connection: conn,
        path: `M ${a.x} ${a.y} H ${outX} V ${utilTrack} H ${cx} V ${to.y + to.h}`,
        labelX: (outX + cx) / 2,
        labelY: utilTrack - 7,
        reverse: false,
      };
    }
    // 主排 → 调蓄池：从顶部进池，避免竖线纵穿池体
    const sx = to.x + to.w / 2;
    const ox = a.x + 18;
    return {
      connection: conn,
      path: `M ${a.x} ${a.y} H ${ox} V ${to.y - 20} H ${sx} V ${to.y}`,
      labelX: (ox + sx) / 2,
      labelY: to.y - 27,
      reverse: false,
    };
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

  /**
   * 同排跨单元（如多点进水从初沉池直接进缺氧池）：不能贴着端口高度横穿
   * 中间的池体，改为下到主排下方走廊，再从目标池左侧进入。
   */
  if (Math.abs(a.y - b.y) >= 2 && b.x > a.x && crossesIntermediate(from, to, nodes)) {
    const outX = a.x + 18;
    const inX = b.x - 24;
    return {
      connection: conn,
      path: `M ${a.x} ${a.y} H ${outX} V ${utilTrack} H ${inX} V ${b.y} H ${b.x}`,
      labelX: (outX + inX) / 2,
      labelY: utilTrack - 7,
      reverse: false,
    };
  }

  const midX = (a.x + b.x) / 2;
  const path = `M ${a.x} ${a.y} H ${midX} V ${b.y} H ${b.x}`;
  return { connection: conn, path, labelX: midX, labelY: (a.y + b.y) / 2, reverse: false };
}

/** 同一排里，起点与终点之间是否夹着别的单元 */
function crossesIntermediate(from: PlacedNode, to: PlacedNode, nodes: Map<string, PlacedNode>): boolean {
  const left = Math.min(from.x + from.w, to.x);
  const right = Math.max(from.x, to.x + to.w);
  for (const n of nodes.values()) {
    if (n.unit.id === from.unit.id || n.unit.id === to.unit.id) continue;
    if (n.layer !== from.layer) continue;
    if (n.x + n.w > left && n.x < right) return true;
  }
  return false;
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

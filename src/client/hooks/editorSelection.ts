import type { PlacedNode } from '../../model/layout';

/**
 * 画布编排的选择与对齐运算（纯函数）。
 *
 * 为什么单独拆出来：这些规则（框选命中、加选、对齐、等距分布）都是纯几何，
 * 放进组件里就只能靠点页面验证；拆出来后可以用最小矩形做断言，
 * 也方便以后做多选拖动、键盘微调等扩展。
 */

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectOf(node: PlacedNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

/** 两个矩形是否相交（含接触）；框选用它判断哪些单元落在框内 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 框选：返回与矩形相交的单元 id */
export function nodesInRect(nodes: PlacedNode[], rect: Rect): string[] {
  return nodes.filter((n) => rectsIntersect(rectOf(n), rect)).map((n) => n.unit.id);
}

/**
 * 选择语义：
 * - 普通点击：单选
 * - Shift / Ctrl / Cmd 点击：加选或取消
 * - 点已选中的单元但不按修饰键：保持多选（否则拖多选时会先塌成单选）
 */
export function nextSelection(current: string[], id: string, additive: boolean): string[] {
  if (additive) return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  return current.includes(id) ? current : [id];
}

/** 选中集合的外接矩形；空集返回 null */
export function boundsOf(nodes: PlacedNode[], ids: string[]): Rect | null {
  const picked = nodes.filter((n) => ids.includes(n.unit.id));
  if (picked.length === 0) return null;
  const x = Math.min(...picked.map((n) => n.x));
  const y = Math.min(...picked.map((n) => n.y));
  const right = Math.max(...picked.map((n) => n.x + n.w));
  const bottom = Math.max(...picked.map((n) => n.y + n.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** 对齐到选中集合的外接矩形；少于 2 个返回空补丁 */
export function alignNodes(
  nodes: PlacedNode[],
  ids: string[],
  mode: AlignMode,
): Record<string, { x: number; y: number }> {
  const bounds = boundsOf(nodes, ids);
  if (!bounds || ids.length < 2) return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (!ids.includes(node.unit.id)) continue;
    let x = node.x;
    let y = node.y;
    if (mode === 'left') x = bounds.x;
    if (mode === 'right') x = bounds.x + bounds.w - node.w;
    if (mode === 'top') y = bounds.y;
    if (mode === 'bottom') y = bounds.y + bounds.h - node.h;
    if (mode === 'centerX') x = Math.round(bounds.x + (bounds.w - node.w) / 2);
    if (mode === 'centerY') y = Math.round(bounds.y + (bounds.h - node.h) / 2);
    out[node.unit.id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/**
 * 等距分布：保持两个端点不动，中间节点按中心点均匀铺开。
 *
 * 按中心点而不是按左边界算：节点宽度不同时，按左边界分会让视觉间距不均。
 */
export function distributeNodes(
  nodes: PlacedNode[],
  ids: string[],
  axis: 'x' | 'y',
): Record<string, { x: number; y: number }> {
  const picked = nodes.filter((n) => ids.includes(n.unit.id));
  if (picked.length < 3) return {};
  const sorted = [...picked].sort((a, b) =>
    axis === 'x' ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2),
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const startCenter = axis === 'x' ? first.x + first.w / 2 : first.y + first.h / 2;
  const endCenter = axis === 'x' ? last.x + last.w / 2 : last.y + last.h / 2;
  const step = (endCenter - startCenter) / (sorted.length - 1);
  const out: Record<string, { x: number; y: number }> = {};
  sorted.forEach((node, i) => {
    if (i === 0 || i === sorted.length - 1) return;
    const center = startCenter + step * i;
    out[node.unit.id] =
      axis === 'x'
        ? { x: Math.round(center - node.w / 2), y: node.y }
        : { x: node.x, y: Math.round(center - node.h / 2) };
  });
  return out;
}

/**
 * 批量位移；用于多选拖动。
 *
 * `origins` 是拖动开始时的坐标快照。画布每帧都会用最新布局重算，
 * 若直接拿「当前节点坐标 + 位移」，同一段位移会被逐帧累加
 * （实测拖两格变成三格）。传入 origins 后只按「原点 + 总位移」计算。
 */
export function moveNodes(
  nodes: PlacedNode[],
  ids: string[],
  dx: number,
  dy: number,
  snap = 14,
  origins?: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const snappedDx = Math.round(dx / snap) * snap;
  const snappedDy = Math.round(dy / snap) * snap;
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (!ids.includes(node.unit.id)) continue;
    const base = origins?.[node.unit.id] ?? { x: node.x, y: node.y };
    out[node.unit.id] = { x: Math.max(0, base.x + snappedDx), y: Math.max(0, base.y + snappedDy) };
  }
  return out;
}

import type { ProcessTopology } from './topology';
import { layoutTopology } from './layout';

/**
 * 拓扑编辑的纯函数。
 *
 * 删除、折点、绝对位移都只产出新的拓扑对象，不修改入参——撤销栈里的每一步
 * 必须是独立快照，否则「撤销」会把几个状态一起改掉。组件只负责把结果交回
 * 历史栈，规则本身可以单测。
 */

/** 单条连线允许的最大折点数：再多也读不清，还会把路径变成迷宫 */
export const MAX_ROUTE_POINTS = 8;

/** 画布坐标上限：与布局层的健康范围一致，防止脏坐标把画布撑到百万像素 */
export const MAX_COORD = 20000;

export interface Point {
  x: number;
  y: number;
}

function finitePoint(p: unknown): Point | null {
  if (!p || typeof p !== 'object') return null;
  const { x, y } = p as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.min(MAX_COORD, Math.max(0, Math.round(x))),
    y: Math.min(MAX_COORD, Math.max(0, Math.round(y))),
  };
}

/**
 * 批量删除单元。
 *
 * 之前 Del 只删「最后一个选中项」，因为担心批量删会把厂拆散。但厂是否被拆散
 * 由校验决定，不该由删除动作替用户做决定：删完立刻能在校验页看到阻断，
 * 且整步可撤销。这里一次删干净，连线/主序列/坐标/折点一并清理，避免断头线。
 */
export function deleteUnits(topo: ProcessTopology, ids: string[]): ProcessTopology {
  const drop = new Set(ids);
  if (drop.size === 0) return topo;
  const connections = topo.connections.filter((c) => !drop.has(c.from.unit) && !drop.has(c.to.unit));
  const kept = new Set(connections.map((c) => c.id));

  const positions = { ...(topo.positions ?? {}) };
  for (const id of drop) delete positions[id];

  const routes = { ...(topo.routes ?? {}) };
  for (const id of Object.keys(routes)) if (!kept.has(id)) delete routes[id];

  const next: ProcessTopology = {
    ...topo,
    units: topo.units.filter((u) => !drop.has(u.id)),
    connections,
    train: topo.train.filter((id) => !drop.has(id)),
  };
  if (Object.keys(positions).length > 0) next.positions = positions;
  else delete next.positions;
  if (Object.keys(routes).length > 0) next.routes = routes;
  else delete next.routes;
  return next;
}

/**
 * 写入或清除一条连线的折点。
 *
 * `null` 表示恢复自动走线。折点只存界面层（引擎不读），
 * 因此清理它不会影响任何仿真口径。
 */
export function setRoute(topo: ProcessTopology, connectionId: string, points: Point[] | null): ProcessTopology {
  const exists = topo.connections.some((c) => c.id === connectionId);
  if (!exists) return topo;

  const routes = { ...(topo.routes ?? {}) };
  if (points === null || points.length === 0) {
    if (!(connectionId in routes)) return topo;
    delete routes[connectionId];
  } else {
    const clean = points
      .map(finitePoint)
      .filter((p): p is Point => Boolean(p))
      .slice(0, MAX_ROUTE_POINTS);
    if (clean.length === 0) {
      if (!(connectionId in routes)) return topo;
      delete routes[connectionId];
    } else {
      routes[connectionId] = clean;
    }
  }
  const next: ProcessTopology = { ...topo };
  if (Object.keys(routes).length > 0) next.routes = routes;
  else delete next.routes;
  return next;
}

/** 以绝对坐标移动多个单元（拖动/方向键都用它，避免相对增量被重复累加） */
export function moveUnitsTo(topo: ProcessTopology, moves: Record<string, Point>): ProcessTopology {
  const known = new Set(topo.units.map((u) => u.id));
  const positions = { ...(topo.positions ?? {}) };
  let changed = false;
  for (const [id, raw] of Object.entries(moves)) {
    if (!known.has(id)) continue;
    const p = finitePoint(raw);
    if (!p) continue;
    positions[id] = p;
    changed = true;
  }
  if (!changed) return topo;
  return { ...topo, positions };
}

/**
 * 方向键微调：以「当前渲染坐标」为基准。
 *
 * 旧实现取 `positions[id] ?? {0,0}`，自动布局的单元按一次方向键会瞬移到左上角。
 * 这里复用布局函数拿到真实坐标，再换算成绝对位置。
 */
export function nudgeUnit(topo: ProcessTopology, id: string, dx: number, dy: number): ProcessTopology {
  const node = layoutTopology(topo).nodes.find((n) => n.unit.id === id);
  if (!node) return topo;
  return moveUnitsTo(topo, { [id]: { x: node.x + dx, y: node.y + dy } });
}

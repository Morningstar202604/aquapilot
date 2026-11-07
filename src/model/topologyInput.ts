import { UNIT_KINDS, type Connection, type ProcessTopology, type UnitSpec, validateTopology } from './topology';
import { MAX_COORD, MAX_ROUTE_POINTS } from './topologyEdit';

/**
 * 拓扑输入的信任边界校验。
 *
 * 界面传来的 topology 是任意 JSON：`as ProcessTopology` 只是骗编译器。
 * 一个 null 单元、NaN 容积或 100 万个节点都会进入引擎，轻则每 tick 抛错，
 * 重则把服务拖死。所有入口（WebSocket apply / 未来的导入）必须先过这里。
 *
 * 设计取舍：只做「结构 + 上限」校验，不做工艺合理性判断——那由
 * validateTopology 与 checkRunReadiness 负责，两者职责分开。
 */

export type TopologySanitizeResult = { ok: true; topology: ProcessTopology } | { ok: false; error: string };

const MAX_UNITS = 80;
const MAX_CONNECTIONS = 240;
const MAX_ID_LEN = 64;
const MAX_TEXT_LEN = 120;

const KNOWN_KINDS = new Set<string>(UNIT_KINDS);
const STREAMS = new Set([
  'influent',
  'mixed_liquor',
  'return_activated_sludge',
  'waste_sludge',
  'internal_recycle',
  'effluent',
  'air',
  'chemical',
  'sludge_cake',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 单元/连线 id 的字符白名单。
 *
 * 这些 id 会被当作对象键使用（`positions[id]`、`routes[connId]`），
 * 只校验「非空且不超长」是不够的：`__proto__`、`constructor`、`prototype`
 * 作为键写入/删除会触到原型链，轻则界面状态错乱，重则污染所有对象。
 * 白名单限定为小写字母、数字、连字符与下划线——界面生成的 id 全部满足，
 * 手写拓扑 JSON 也能用它自查。
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.has(value.toLowerCase());
}

function str(v: unknown, max = MAX_TEXT_LEN): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 正数参数的工程上限。
 *
 * `>0 && finite` 是不够的：1e308 的池容能通过校验，但两个池相加即 Infinity，
 * 派生量（HRT、生物量）变成 NaN 并污染整个求解器——引擎跑十分钟后出水全 NaN。
 * 上限按真实水厂量级取：单池容积 1e6 m³、面积 1e5 m²、水深 30 m 已远超任何工程。
 */
const MAX_VOLUME = 1e6;
const MAX_AREA = 1e5;
const MAX_DEPTH = 30;

function boundedPositive(v: unknown, max: number): number | undefined | false {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) return false;
  return v;
}

function coord(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(MAX_COORD, Math.max(0, Math.round(v)));
}

function sanitizeUnit(raw: unknown): UnitSpec | null {
  if (!isObject(raw)) return null;
  const id = isSafeId(raw.id) ? raw.id : null;
  const kind = typeof raw.kind === 'string' && KNOWN_KINDS.has(raw.kind) ? raw.kind : null;
  const name = str(raw.name);
  const role = typeof raw.role === 'string' ? raw.role.slice(0, MAX_TEXT_LEN) : '';
  if (!id || !kind || !name) return null;
  if (!Array.isArray(raw.ports) || raw.ports.length === 0 || raw.ports.length > 24) return null;

  const ports: UnitSpec['ports'] = [];
  const seenPorts = new Set<string>();
  for (const p of raw.ports) {
    if (!isObject(p)) return null;
    const pid = isSafeId(p.id) ? p.id : null;
    if (!pid || seenPorts.has(pid)) return null;
    seenPorts.add(pid);
    if (p.kind !== 'in' && p.kind !== 'out') return null;
    if (typeof p.stream !== 'string' || !STREAMS.has(p.stream)) return null;
    ports.push({ id: pid, kind: p.kind, stream: p.stream as UnitSpec['ports'][number]['stream'] });
  }

  const volume = boundedPositive(raw.volume, MAX_VOLUME);
  const area = boundedPositive(raw.area, MAX_AREA);
  const depth = boundedPositive(raw.depth, MAX_DEPTH);
  if (volume === false || area === false || depth === false) return null;

  const unit: UnitSpec = { id, kind: kind as UnitSpec['kind'], name, role, ports };
  if (volume !== undefined) unit.volume = volume;
  if (area !== undefined) unit.area = area;
  if (depth !== undefined) unit.depth = depth;
  if (Array.isArray(raw.states))
    unit.states = raw.states.filter((s): s is string => typeof s === 'string').slice(0, 24);
  if (Array.isArray(raw.interventions)) {
    unit.interventions = raw.interventions
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 12) as UnitSpec['interventions'];
  }
  if (isObject(raw.meta)) {
    const meta: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(raw.meta).slice(0, 16)) {
      if (typeof v === 'string') meta[k.slice(0, 40)] = v.slice(0, 120);
      else if (typeof v === 'number' && Number.isFinite(v)) meta[k.slice(0, 40)] = v;
    }
    unit.meta = meta;
  }
  return unit;
}

function sanitizeConnection(
  raw: unknown,
  unitIds: Set<string>,
  portIndex: Map<string, Set<string>>,
): Connection | null {
  if (!isObject(raw)) return null;
  const id = isSafeId(raw.id) ? raw.id : null;
  if (!id) return null;
  if (!isObject(raw.from) || !isObject(raw.to)) return null;
  const fromUnit = str(raw.from.unit, MAX_ID_LEN);
  const toUnit = str(raw.to.unit, MAX_ID_LEN);
  const fromPort = str(raw.from.port, 32);
  const toPort = str(raw.to.port, 32);
  if (!fromUnit || !toUnit || !fromPort || !toPort) return null;
  if (!unitIds.has(fromUnit) || !unitIds.has(toUnit)) return null;
  if (!portIndex.get(fromUnit)?.has(fromPort) || !portIndex.get(toUnit)?.has(toPort)) return null;
  if (typeof raw.stream !== 'string' || !STREAMS.has(raw.stream)) return null;
  const conn: Connection = {
    id,
    from: { unit: fromUnit, port: fromPort },
    to: { unit: toUnit, port: toPort },
    stream: raw.stream as Connection['stream'],
  };
  if (typeof raw.flowRef === 'string' && raw.flowRef.length <= 64) conn.flowRef = raw.flowRef;
  if (typeof raw.recycle === 'boolean') conn.recycle = raw.recycle;
  return conn;
}

export function sanitizeTopologyInput(raw: unknown): TopologySanitizeResult {
  if (!isObject(raw)) return { ok: false, error: '拓扑必须是对象' };
  if (!Array.isArray(raw.units) || raw.units.length === 0) return { ok: false, error: '缺少单元列表' };
  if (raw.units.length > MAX_UNITS) return { ok: false, error: `单元数量超过上限 ${MAX_UNITS}` };
  if (!Array.isArray(raw.connections)) return { ok: false, error: '缺少连线列表' };
  if (raw.connections.length > MAX_CONNECTIONS) return { ok: false, error: `连线数量超过上限 ${MAX_CONNECTIONS}` };
  if (!Array.isArray(raw.train)) return { ok: false, error: '缺少主处理序列' };

  const units: UnitSpec[] = [];
  const ids = new Set<string>();
  for (const rawUnit of raw.units) {
    const unit = sanitizeUnit(rawUnit);
    if (!unit) return { ok: false, error: '存在结构不合法的单元（id/类型/端口/容积）' };
    if (ids.has(unit.id)) return { ok: false, error: `单元 ID 重复：${unit.id}` };
    ids.add(unit.id);
    units.push(unit);
  }

  const portIndex = new Map<string, Set<string>>();
  for (const u of units) portIndex.set(u.id, new Set(u.ports.map((p) => p.id)));

  const connections: Connection[] = [];
  const connIds = new Set<string>();
  for (const rawConn of raw.connections) {
    const conn = sanitizeConnection(rawConn, ids, portIndex);
    if (!conn) return { ok: false, error: '存在结构不合法的连线（端口/物流/单元引用）' };
    if (connIds.has(conn.id)) return { ok: false, error: `连线 ID 重复：${conn.id}` };
    connIds.add(conn.id);
    connections.push(conn);
  }

  /**
   * 主序列必须去重且不能超过单元数。
   *
   * 重复 id 会编译出多个同 id 反应器：池容/生物量口径直接翻倍，
   * 而界面上看不出任何异常；超长 train 还能在 applyTopology 里同步阻塞数秒。
   */
  const train: string[] = [];
  const seenTrain = new Set<string>();
  if (raw.train.length > units.length) {
    return { ok: false, error: `主序列长度 ${raw.train.length} 超过单元数 ${units.length}` };
  }
  for (const id of raw.train) {
    if (typeof id !== 'string' || !ids.has(id)) return { ok: false, error: `主序列引用了不存在的单元 ${String(id)}` };
    if (seenTrain.has(id)) return { ok: false, error: `主序列重复引用单元 ${id}` };
    seenTrain.add(id);
    train.push(id);
  }

  const topology: ProcessTopology = {
    id: str(raw.id, MAX_ID_LEN) ?? 'custom',
    name: str(raw.name) ?? '自定义工艺',
    units,
    connections,
    train,
  };

  if (isObject(raw.positions)) {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(raw.positions)) {
      if (!ids.has(id) || !isObject(p)) continue;
      const x = coord(p.x);
      const y = coord(p.y);
      if (x === null || y === null) continue;
      positions[id] = { x, y };
    }
    if (Object.keys(positions).length > 0) topology.positions = positions;
  }

  if (isObject(raw.routes)) {
    const routes: Record<string, { x: number; y: number }[]> = {};
    for (const [id, pts] of Object.entries(raw.routes)) {
      if (!connIds.has(id) || !Array.isArray(pts)) continue;
      const clean = pts
        .map((p) => {
          if (!isObject(p)) return null;
          const x = coord(p.x);
          const y = coord(p.y);
          return x === null || y === null ? null : { x, y };
        })
        .filter((p): p is { x: number; y: number } => Boolean(p))
        .slice(0, MAX_ROUTE_POINTS);
      if (clean.length > 0) routes[id] = clean;
    }
    if (Object.keys(routes).length > 0) topology.routes = routes;
  }

  /**
   * 最后再过一遍结构校验：端口重复、自连、重复连线这类问题
   * 在 sanitize 阶段就应该拒绝，而不是留给引擎在 tick 里抛错。
   */
  const structural = validateTopology(topology).filter((i) => i.severity === 'error');
  if (structural.length > 0) return { ok: false, error: structural[0].message };

  return { ok: true, topology };
}

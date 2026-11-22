import * as v from 'valibot';
import {
  INTERVENTION_KEYS,
  STREAM_KINDS,
  UNIT_KINDS,
  type Connection,
  type ProcessTopology,
  type UnitSpec,
  validateTopology,
} from './topology';
import { MAX_COORD, MAX_ROUTE_POINTS } from './topologyEdit';

/**
 * 拓扑输入的信任边界校验。
 *
 * 界面传来的 topology 是任意 JSON：`as ProcessTopology` 只是骗编译器。
 * 一个 null 单元、NaN 容积或 100 万个节点都会进入引擎，轻则每 tick 抛错，
 * 重则把服务拖死。所有入口（WebSocket apply / 导入 / 落盘恢复）必须先过这里。
 *
 * 结构校验交给 valibot schema，跨引用（端口存在、单元存在、train 去重）继续
 * 在这里做——这两类规则依赖整棵树，不是单字段 validator 能表达的。
 */

export type TopologySanitizeResult = { ok: true; topology: ProcessTopology } | { ok: false; error: string };

const MAX_UNITS = 80;
const MAX_CONNECTIONS = 240;
const MAX_ID_LEN = 64;
const MAX_TEXT_LEN = 120;

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

const Positive = (max: number) =>
  v.pipe(
    v.number(),
    v.finite(),
    v.check((n) => n > 0 && n <= max, '必需是有限正数且不超过工程上限'),
  );

const PortSchema = v.object({
  id: v.pipe(
    v.string(),
    v.check((s) => isSafeId(s), '端口 id 不合法'),
  ),
  kind: v.picklist(['in', 'out'] as const),
  stream: v.picklist(STREAM_KINDS),
});

const UnitSchema = v.object({
  id: v.pipe(
    v.string(),
    v.check((s) => isSafeId(s), '单元 id 不合法'),
  ),
  kind: v.picklist(UNIT_KINDS),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TEXT_LEN)),
  role: v.optional(v.pipe(v.string(), v.maxLength(MAX_TEXT_LEN)), ''),
  volume: v.optional(Positive(MAX_VOLUME)),
  area: v.optional(Positive(MAX_AREA)),
  depth: v.optional(Positive(MAX_DEPTH)),
  ports: v.pipe(
    v.array(PortSchema),
    v.minLength(1),
    v.maxLength(24),
    v.check((ports) => new Set(ports.map((p) => p.id)).size === ports.length, '端口 id 重复'),
  ),
  states: v.optional(v.pipe(v.array(v.string()), v.maxLength(24)), []),
  interventions: v.optional(
    v.pipe(
      v.array(v.string()),
      v.maxLength(12),
      v.transform((items) =>
        items.filter((k): k is (typeof INTERVENTION_KEYS)[number] =>
          (INTERVENTION_KEYS as readonly string[]).includes(k),
        ),
      ),
    ),
    [],
  ),
  meta: v.optional(v.record(v.string(), v.union([v.string(), v.number()])), {}),
});

const EndpointSchema = v.object({
  unit: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ID_LEN)),
  port: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32)),
});

const ConnectionSchema = v.object({
  id: v.pipe(
    v.string(),
    v.check((s) => isSafeId(s), '连线 id 不合法'),
  ),
  from: EndpointSchema,
  to: EndpointSchema,
  stream: v.picklist(STREAM_KINDS),
  flowRef: v.optional(v.pipe(v.string(), v.maxLength(64))),
  recycle: v.optional(v.boolean()),
});

function coord(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_COORD, Math.max(0, Math.round(value)));
}

/**
 * 把 valibot 解析出的 unit 收敛成领域对象，并剔除空字段。
 *
 * `states` / `interventions` / `meta` 在原实现里是「尽力保留」而不是硬性拒绝；
 * schema 负责类型与上限，这里负责不把空数组/空对象写进拓扑，避免导出的 JSON
 * 多出一堆没意义的 `meta: {}`。
 */
function toUnit(parsed: v.InferOutput<typeof UnitSchema>): UnitSpec {
  const unit: UnitSpec = {
    id: parsed.id,
    kind: parsed.kind,
    name: parsed.name,
    role: parsed.role ?? '',
    ports: parsed.ports.map((p) => ({ id: p.id, kind: p.kind, stream: p.stream })),
  };
  if (parsed.volume !== undefined) unit.volume = parsed.volume;
  if (parsed.area !== undefined) unit.area = parsed.area;
  if (parsed.depth !== undefined) unit.depth = parsed.depth;
  if (parsed.states && parsed.states.length > 0) unit.states = parsed.states;
  if (parsed.interventions && parsed.interventions.length > 0) unit.interventions = parsed.interventions;

  if (parsed.meta) {
    const meta: Record<string, string | number> = {};
    for (const [k, val] of Object.entries(parsed.meta).slice(0, 16)) {
      if (typeof val === 'string') meta[k.slice(0, 40)] = val.slice(0, 120);
      else if (typeof val === 'number' && Number.isFinite(val)) meta[k.slice(0, 40)] = val;
    }
    if (Object.keys(meta).length > 0) unit.meta = meta;
  }
  return unit;
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
    const parsed = v.safeParse(UnitSchema, rawUnit);
    if (!parsed.success) return { ok: false, error: '存在结构不合法的单元（id/类型/端口/容积）' };
    const unit = toUnit(parsed.output);
    if (ids.has(unit.id)) return { ok: false, error: `单元 ID 重复：${unit.id}` };
    ids.add(unit.id);
    units.push(unit);
  }

  const portIndex = new Map<string, Set<string>>();
  for (const u of units) portIndex.set(u.id, new Set(u.ports.map((p) => p.id)));

  const connections: Connection[] = [];
  const connIds = new Set<string>();
  for (const rawConn of raw.connections) {
    const parsed = v.safeParse(ConnectionSchema, rawConn);
    if (!parsed.success) return { ok: false, error: '存在结构不合法的连线（端口/物流/单元引用）' };
    const conn = parsed.output;
    if (!ids.has(conn.from.unit) || !ids.has(conn.to.unit)) {
      return { ok: false, error: '存在结构不合法的连线（端口/物流/单元引用）' };
    }
    if (!portIndex.get(conn.from.unit)?.has(conn.from.port) || !portIndex.get(conn.to.unit)?.has(conn.to.port)) {
      return { ok: false, error: '存在结构不合法的连线（端口/物流/单元引用）' };
    }
    if (connIds.has(conn.id)) return { ok: false, error: `连线 ID 重复：${conn.id}` };
    connIds.add(conn.id);
    connections.push(conn as Connection);
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

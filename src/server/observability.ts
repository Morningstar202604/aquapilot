/**
 * 可观测性：结构化日志 + 运行时指标。
 *
 * 设计取舍：
 * - 日志走 JSON Lines（一行一个事件），便于被 Loki/CloudWatch 直接采集；
 *   人类可读性靠 `msg` 字段，不靠对齐空格。
 * - 指标用进程内计数器 + 直方图桶，`/api/metrics` 同时输出 Prometheus 文本
 *   与 JSON。不引入 prom-client：这里只有单进程、十几个指标，
 *   拉一个依赖进来反而增加升级面。
 * - 所有记录函数都必须永不抛出：观测代码不能成为故障源。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

/** 密钥类字段一律不落日志 */
const REDACT_KEYS = /^(authorization|token|password|cookie|set-cookie|secret)$/i;

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  // 循环引用必须降级成标记：否则 JSON.stringify 抛错会吞掉整条日志
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1, seen);
  }
  return out;
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  try {
    if (LEVEL_ORDER[level] < threshold()) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact(fields) as Record<string, unknown>),
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch {
    /* 观测失败不能影响主流程 */
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};

/** 直方图桶（秒），覆盖 5ms–10s */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

function newHistogram(): Histogram {
  return { buckets: HTTP_BUCKETS, counts: HTTP_BUCKETS.map(() => 0), sum: 0, count: 0 };
}

function observe(h: Histogram, seconds: number): void {
  h.sum += seconds;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (seconds <= h.buckets[i]) h.counts[i] += 1;
  }
}

const startedAt = Date.now();

export const metrics = {
  httpRequests: new Map<string, number>(),
  httpErrors: 0,
  httpDuration: newHistogram(),
  wsConnections: 0,
  wsDisconnections: 0,
  authFailures: 0,
  rateLimited: 0,
  invalidMessages: 0,
  aiCycles: 0,
  aiCycleErrors: 0,
  simTicks: 0,
  tickErrors: 0,
  persistenceFlushes: 0,
  persistenceErrors: 0,
  /** 最近一次 tick 的耗时（毫秒），用于发现"仿真跟不上节拍" */
  lastTickMs: 0,
  maxTickMs: 0,
};

export function recordHttp(method: string, path: string, status: number, seconds: number): void {
  const route = normalizeRoute(path);
  const key = `${method} ${route} ${status}`;
  metrics.httpRequests.set(key, (metrics.httpRequests.get(key) ?? 0) + 1);
  if (status >= 500) metrics.httpErrors += 1;
  observe(metrics.httpDuration, seconds);
}

/** 把 /api/history/snapshots?from=1 归一成 /api/history/snapshots，避免指标基数爆炸 */
export function normalizeRoute(path: string): string {
  const clean = path.split('?')[0];
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

export function recordTick(ms: number): void {
  metrics.simTicks += 1;
  metrics.lastTickMs = ms;
  if (ms > metrics.maxTickMs) metrics.maxTickMs = ms;
}

export interface SloDefinition {
  name: string;
  target: string;
  window: string;
  description: string;
}

/**
 * SLO 以"代码里的事实"形式给出，README 只是复述。
 * 单进程原型没有长期时序库，因此实现上只暴露当前进程的实时值，
 * 真正的 30 天窗口需要在部署侧用 Prometheus 汇总——这一点写在 docs/SLO.md。
 */
export const SLO: SloDefinition[] = [
  {
    name: 'availability',
    target: '99.5% / 30d',
    window: '30d',
    description: '非 5xx 响应占比',
  },
  {
    name: 'api_latency_p95',
    target: '300ms / 30d',
    window: '30d',
    description: '/api/snapshot 与 /api/topology 的 p95 延迟',
  },
  {
    name: 'sim_tick_budget',
    target: 'p99 < 1000ms',
    window: '1h',
    description: '单次仿真 tick 的耗时上限（tick 间隔为 1s，超过即积压）',
  },
  {
    name: 'ws_stability',
    target: '断开率 < 1% / 24h',
    window: '24h',
    description: 'WebSocket 非预期断开占连接数的比例',
  },
];

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

/** Prometheus 文本格式；同时是唯一需要稳定的对外契约 */
export function renderPrometheus(): string {
  const lines: string[] = [];
  const counter = (name: string, help: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name}${labels} ${fmt(value)}`);
  };
  const gauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${fmt(value)}`);
  };

  counter('aquapilot_http_requests_total', 'HTTP requests by method, route and status', 0);
  for (const [key, value] of metrics.httpRequests) {
    const [method, route, status] = key.split(' ');
    lines.push(`aquapilot_http_requests_total{method="${method}",route="${route}",status="${status}"} ${value}`);
  }
  counter('aquapilot_http_errors_total', 'Responses with status >= 500', metrics.httpErrors);
  counter('aquapilot_auth_failures_total', 'Rejected API/WS authentications', metrics.authFailures);
  counter('aquapilot_rate_limited_total', 'Rate-limited client operations', metrics.rateLimited);
  counter('aquapilot_invalid_messages_total', 'Rejected WebSocket messages', metrics.invalidMessages);
  counter('aquapilot_ai_cycles_total', 'Completed AI decision cycles', metrics.aiCycles);
  counter('aquapilot_ai_cycle_errors_total', 'AI decision cycles that threw', metrics.aiCycleErrors);
  counter('aquapilot_sim_ticks_total', 'Simulation ticks executed', metrics.simTicks);
  counter('aquapilot_tick_errors_total', 'Simulation ticks that threw', metrics.tickErrors);
  counter('aquapilot_persistence_flushes_total', 'SQLite flush operations', metrics.persistenceFlushes);
  counter('aquapilot_persistence_errors_total', 'Failed SQLite flush operations', metrics.persistenceErrors);

  gauge('aquapilot_ws_connections', 'Currently open WebSocket connections', metrics.wsConnections);
  gauge(
    'aquapilot_ws_connections_total',
    'WebSocket connections accepted',
    metrics.wsConnections + metrics.wsDisconnections,
  );
  gauge('aquapilot_ws_disconnections_total', 'WebSocket connections closed', metrics.wsDisconnections);
  gauge('aquapilot_uptime_seconds', 'Process uptime in seconds', (Date.now() - startedAt) / 1000);
  gauge('aquapilot_tick_duration_last_ms', 'Duration of the last simulation tick', metrics.lastTickMs);
  gauge('aquapilot_tick_duration_max_ms', 'Slowest simulation tick since start', metrics.maxTickMs);

  lines.push('# HELP aquapilot_http_request_duration_seconds HTTP request latency');
  lines.push('# TYPE aquapilot_http_request_duration_seconds histogram');
  for (let i = 0; i < metrics.httpDuration.buckets.length; i++) {
    lines.push(
      `aquapilot_http_request_duration_seconds_bucket{le="${metrics.httpDuration.buckets[i]}"} ${metrics.httpDuration.counts[i]}`,
    );
  }
  lines.push(`aquapilot_http_request_duration_seconds_bucket{le="+Inf"} ${metrics.httpDuration.count}`);
  lines.push(`aquapilot_http_request_duration_seconds_sum ${fmt(metrics.httpDuration.sum)}`);
  lines.push(`aquapilot_http_request_duration_seconds_count ${metrics.httpDuration.count}`);

  return `${lines.join('\n')}\n`;
}

export function metricsJson(): Record<string, unknown> {
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    http: {
      requests: Object.fromEntries(metrics.httpRequests),
      errors5xx: metrics.httpErrors,
      durationSeconds: {
        count: metrics.httpDuration.count,
        sum: Number(metrics.httpDuration.sum.toFixed(3)),
        buckets: metrics.httpDuration.buckets,
        counts: metrics.httpDuration.counts,
      },
    },
    ws: {
      open: metrics.wsConnections,
      accepted: metrics.wsConnections + metrics.wsDisconnections,
      closed: metrics.wsDisconnections,
    },
    security: {
      authFailures: metrics.authFailures,
      rateLimited: metrics.rateLimited,
      invalidMessages: metrics.invalidMessages,
    },
    ai: { cycles: metrics.aiCycles, errors: metrics.aiCycleErrors },
    simulation: {
      ticks: metrics.simTicks,
      errors: metrics.tickErrors,
      lastTickMs: Number(metrics.lastTickMs.toFixed(1)),
      maxTickMs: Number(metrics.maxTickMs.toFixed(1)),
    },
    persistence: { flushes: metrics.persistenceFlushes, errors: metrics.persistenceErrors },
    slo: SLO,
  };
}

/** 测试用：重置全部指标，避免用例之间互相污染 */
export function resetMetrics(): void {
  metrics.httpRequests.clear();
  metrics.httpErrors = 0;
  metrics.httpDuration = newHistogram();
  metrics.wsConnections = 0;
  metrics.wsDisconnections = 0;
  metrics.authFailures = 0;
  metrics.rateLimited = 0;
  metrics.invalidMessages = 0;
  metrics.aiCycles = 0;
  metrics.aiCycleErrors = 0;
  metrics.simTicks = 0;
  metrics.tickErrors = 0;
  metrics.persistenceFlushes = 0;
  metrics.persistenceErrors = 0;
  metrics.lastTickMs = 0;
  metrics.maxTickMs = 0;
}

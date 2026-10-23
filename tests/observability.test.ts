import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logger,
  log,
  metrics,
  metricsJson,
  normalizeRoute,
  recordHttp,
  recordTick,
  renderPrometheus,
  resetMetrics,
  SLO,
} from '../src/server/observability';

afterEach(() => {
  resetMetrics();
  vi.restoreAllMocks();
});

describe('结构化日志', () => {
  it('输出单行 JSON，含时间、级别与消息', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'hello', { route: '/api/snapshot' });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.route).toBe('/api/snapshot');
    expect(typeof parsed.ts).toBe('string');
  });

  it('密钥类字段被脱敏，不落原文', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log('warn', 'auth', { authorization: 'Bearer super-secret', nested: { token: 'abc' } });
    const line = spy.mock.calls[0][0] as string;
    expect(line.includes('super-secret')).toBe(false);
    expect(line.includes('"abc"')).toBe(false);
    expect(line.includes('[redacted]')).toBe(true);
  });

  it('低于阈值的级别被丢弃', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    logger.debug('should not appear');
    logger.info('should not appear either');
    expect(spy).not.toHaveBeenCalled();
    process.env.LOG_LEVEL = before;
  });

  it('error 级日志走 stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', { code: 500 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string).level).toBe('error');
  });

  it('循环引用不会让日志抛错', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => log('info', 'cyclic', { cyclic })).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe('指标采集', () => {
  it('HTTP 请求按 method/route/status 聚合', () => {
    recordHttp('GET', '/api/snapshot', 200, 0.012);
    recordHttp('GET', '/api/snapshot?x=1', 200, 0.02);
    recordHttp('POST', '/api/topology', 500, 0.3);
    expect(metrics.httpRequests.get('GET /api/snapshot 200')).toBe(2);
    expect(metrics.httpRequests.get('POST /api/topology 500')).toBe(1);
    expect(metrics.httpErrors).toBe(1);
    expect(metrics.httpDuration.count).toBe(3);
  });

  it('查询串不会进入指标标签（避免基数爆炸）', () => {
    expect(normalizeRoute('/api/history/snapshots?from=1&to=2')).toBe('/api/history/snapshots');
  });

  it('未知路径折叠成固定标签，随机路径不能制造新序列', () => {
    // 回归：只做截断时，10 万个随机 /api/xxx 会生成 10 万条时间序列
    expect(normalizeRoute('/api/nope')).toBe('/api/__unmatched__');
    expect(normalizeRoute(`/api/${'x'.repeat(200)}`)).toBe('/api/__unmatched__');
    expect(normalizeRoute('/assets/index-abc123.js')).toBe('/assets/*');
    expect(normalizeRoute('/replay')).toBe('__static__');
    expect(normalizeRoute('/')).toBe('/');
    expect(normalizeRoute('/api/snapshot')).toBe('/api/snapshot');
  });

  it('直方图按桶累计且 +Inf 等于总数', () => {
    recordHttp('GET', '/a', 200, 0.003);
    recordHttp('GET', '/a', 200, 0.4);
    const text = renderPrometheus();
    expect(text).toContain('aquapilot_http_request_duration_seconds_bucket{le="0.005"} 1');
    expect(text).toContain(`aquapilot_http_request_duration_seconds_bucket{le="+Inf"} 2`);
  });

  it('tick 指标记录最后一次与最慢一次', () => {
    recordTick(12);
    recordTick(80);
    recordTick(30);
    expect(metrics.simTicks).toBe(3);
    expect(metrics.lastTickMs).toBe(30);
    expect(metrics.maxTickMs).toBe(80);
  });

  it('Prometheus 输出可被逐行解析', () => {
    recordHttp('GET', '/api/snapshot', 200, 0.01);
    recordTick(5);
    const text = renderPrometheus();
    const sampleLines = text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(sampleLines.length).toBeGreaterThan(5);
    for (const line of sampleLines) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.eE+-]+$/);
    }
  });

  it('带标签的指标不能混入无标签样本，也不能重复声明 HELP', () => {
    recordHttp('GET', '/api/snapshot', 200, 0.01);
    recordHttp('GET', '/api/nope', 404, 0.01);
    const text = renderPrometheus();
    const lines = text.split('\n');
    const helps = lines.filter((l) => l.startsWith('# HELP aquapilot_http_requests_total '));
    expect(helps).toHaveLength(1);
    const bare = lines.filter((l) => l === 'aquapilot_http_requests_total 0');
    expect(bare).toHaveLength(0);
  });

  it('JSON 视图含 SLO 定义与各子系统计数', () => {
    recordHttp('GET', '/api/snapshot', 200, 0.01);
    const json = metricsJson();
    const http = json.http as { requests: Record<string, number> };
    expect(http.requests['GET /api/snapshot 200']).toBe(1);
    expect(Array.isArray(json.slo)).toBe(true);
    expect((json.slo as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it('WebSocket 指标区分「当前连接」与「累计接受」', () => {
    // 回归：早先把只增不减的计数器当成 gauge 输出，且 error+close 会重复计断开
    metrics.wsActive = 2;
    metrics.wsAccepted = 7;
    metrics.wsDisconnections = 5;
    const json = metricsJson();
    const ws = json.ws as { open: number; accepted: number; closed: number };
    expect(ws).toEqual({ open: 2, accepted: 7, closed: 5 });
    const text = renderPrometheus();
    expect(text).toContain('aquapilot_ws_connections 2');
    expect(text).toContain('aquapilot_ws_connections_total 7');
    expect(text).toContain('aquapilot_ws_disconnections_total 5');
    expect(text).toContain('# TYPE aquapilot_ws_connections gauge');
    expect(text).toContain('# TYPE aquapilot_ws_connections_total counter');
  });

  it('SLO 目标值都是可解析的字符串', () => {
    for (const slo of SLO) {
      expect(slo.name.length).toBeGreaterThan(0);
      expect(slo.target.length).toBeGreaterThan(0);
      expect(slo.description.length).toBeGreaterThan(0);
    }
  });
});

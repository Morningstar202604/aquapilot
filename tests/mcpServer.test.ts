import { describe, expect, it } from 'vitest';
import { handleMcpRequest, type McpFacade } from '../src/server/mcp';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * MCP Streamable HTTP 端点的协议级测试（无 HTTP 壳，直接驱动纯逻辑）。
 * 覆盖：握手、Origin 校验、协议版本协商、notification 语义、
 * 工具枚举/调用/错误约定（-32602 与 isError:true）、headless 推演。
 */

const facade: McpFacade = {
  serverVersion: '0.0.0-test',
  getTopology: () => PLANT_TOPOLOGY,
  getState: () => ({ timeMin: 120, effluent: { cod: 30, nh: 1 } }),
  setControl: () => ({ ok: true, clamped: [] }),
  startScenario: () => ({ ok: true }),
  clearScenario: () => ({ ok: true }),
  resetSim: () => ({ ok: true }),
  applyRecommendation: () => ({ ok: true }),
  getMetrics: () => '# HELP test\n',
  getReport: () => '# 运营报告\n',
};

const post = (body: unknown, opts: { origin?: string; host?: string; pv?: string } = {}) =>
  handleMcpRequest({
    httpMethod: 'POST',
    origin: opts.origin ?? null,
    host: opts.host ?? 'localhost:5173',
    protocolVersionHeader: opts.pv ?? null,
    body,
    facade,
  });

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });

describe('MCP 传输层语义', () => {
  it('GET 回 405（无 SSE 的合法实现）', () => {
    const out = handleMcpRequest({
      httpMethod: 'GET',
      origin: null,
      host: 'localhost:5173',
      protocolVersionHeader: null,
      body: null,
      facade,
    });
    expect(out.status).toBe(405);
    expect(out.headers?.Allow).toBe('POST');
  });

  it('DELETE（会话终止）回 405', () => {
    const out = handleMcpRequest({
      httpMethod: 'DELETE',
      origin: null,
      host: null,
      protocolVersionHeader: null,
      body: null,
      facade,
    });
    expect(out.status).toBe(405);
  });

  it('跨站 Origin 被拒（403），同源与本机回环放行', () => {
    const evil = post(rpc(1, 'tools/list'), { origin: 'http://evil.example', host: 'localhost:5173' });
    expect(evil.status).toBe(403);
    const same = post(rpc(1, 'tools/list'), { origin: 'http://localhost:5173', host: 'localhost:5173' });
    expect(same.status).toBe(200);
    const loopback = post(rpc(1, 'tools/list'), { origin: 'http://127.0.0.1:9', host: 'localhost:5173' });
    expect(loopback.status).toBe(200);
    // 无 Origin（SDK/curl）放行
    const noOrigin = post(rpc(1, 'tools/list'));
    expect(noOrigin.status).toBe(200);
  });

  it('协议版本：缺失假定默认可继续；无效值必须 400', () => {
    const ok = post(rpc(1, 'initialize'), { pv: undefined as unknown as string });
    expect(ok.status).toBe(200);
    const bad = post(rpc(1, 'initialize'), { pv: '1999-01-01' });
    expect(bad.status).toBe(400);
  });

  it('非 JSON-RPC 消息回 400', () => {
    expect(post({ hello: 1 }).status).toBe(400);
    expect(post(null).status).toBe(400);
  });

  it('notification 回 202 无响应体', () => {
    const out = post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(out.status).toBe(202);
    expect(out.body).toBeUndefined();
  });
});

describe('MCP 握手与工具枚举', () => {
  it('initialize 返回协议版本、capabilities 与 serverInfo', () => {
    const out = post(rpc(1, 'initialize'));
    expect(out.status).toBe(200);
    const result = (out.body as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect((result.serverInfo as Record<string, unknown>).name).toBe('aquapilot');
  });

  it('tools/list 暴露全部工具并带 readOnlyHint 注解', () => {
    const out = post(rpc(2, 'tools/list'));
    const { tools } = (out.body as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } })
      .result;
    const names = tools.map((t) => t.name);
    expect(names).toContain('plant_state');
    expect(names).toContain('set_control');
    expect(names).toContain('simulate_headless');
    expect(names).toContain('list_scenarios');
    expect(names).toContain('reset_sim');
    const sim = tools.find((t) => t.name === 'simulate_headless')!;
    expect(sim.annotations.readOnlyHint).toBe(true);
    const setCtrl = tools.find((t) => t.name === 'set_control')!;
    expect(setCtrl.annotations.readOnlyHint).toBe(false);
  });

  it('ping 回空结果', () => {
    const out = post(rpc(3, 'ping'));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});

describe('MCP 工具调用与错误约定', () => {
  it('plant_state 返回文本 + structuredContent', () => {
    const out = post(rpc(4, 'tools/call', { name: 'plant_state', arguments: {} }));
    const { result } = out.body as { result: { content: { type: string; text: string }[]; structuredContent: unknown } };
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ timeMin: 120, effluent: { cod: 30, nh: 1 } });
    expect(result.structuredContent).toBeTruthy();
    expect('isError' in result).toBe(false);
  });

  it('未知工具回 JSON-RPC -32602（而非 isError）', () => {
    const out = post(rpc(5, 'tools/call', { name: 'no_such_tool', arguments: {} }));
    const err = (out.body as { error: { code: number } }).error;
    expect(err.code).toBe(-32602);
  });

  it('缺少工具名回 -32602', () => {
    const out = post(rpc(6, 'tools/call', {}));
    expect((out.body as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('start_scenario 未知场景 → isError:true 的业务错误', () => {
    const out = post(rpc(7, 'tools/call', { name: 'start_scenario', arguments: { scenario: 'meteor' } }));
    const { result } = out.body as { result: { isError?: boolean; content: { text: string }[] } };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('未知场景');
  });

  it('set_control 把数字参数传给门面；非数字被拒', () => {
    let received: Record<string, unknown> | null = null;
    const spy: McpFacade = { ...facade, setControl: (patch) => ((received = patch), { ok: true, clamped: [] }) };
    const out = handleMcpRequest({
      httpMethod: 'POST',
      origin: null,
      host: null,
      protocolVersionHeader: null,
      body: rpc(8, 'tools/call', { name: 'set_control', arguments: { doSetpoint: 2.5, carbonDose: 20 } }),
      facade: spy,
    });
    expect(out.status).toBe(200);
    expect(received).toEqual({ doSetpoint: 2.5, carbonDose: 20 });
    const bad = handleMcpRequest({
      httpMethod: 'POST',
      origin: null,
      host: null,
      protocolVersionHeader: null,
      body: rpc(9, 'tools/call', { name: 'set_control', arguments: { doSetpoint: 'high' } }),
      facade,
    });
    const { result } = bad.body as { result: { isError?: boolean } };
    expect(result.isError).toBe(true);
  });

  it('simulate_headless 推演 60 分钟返回达标汇总', () => {
    const out = post(rpc(10, 'tools/call', { name: 'simulate_headless', arguments: { durationMin: 60 } }));
    const { result } = out.body as { result: { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> } };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.durationMin).toBe(60);
    expect(Array.isArray(parsed.samples)).toBe(true);
    expect(typeof parsed.compliant).toBe('boolean');
    expect(result.structuredContent).toBeTruthy();
  });

  it('simulate_headless 叠加暴雨场景与自定义控制量', () => {
    const out = post(
      rpc(11, 'tools/call', {
        name: 'simulate_headless',
        arguments: { durationMin: 120, scenario: 'storm', controls: { doSetpoint: 2.5 } },
      }),
    );
    const { result } = out.body as { result: { structuredContent: { scenario: string; samples: unknown[] } } };
    expect(result.structuredContent.scenario).toBe('storm');
    expect(result.structuredContent.samples.length).toBeGreaterThanOrEqual(2);
  });

  it('simulate_headless 参数越界 → isError:true', () => {
    const out = post(rpc(12, 'tools/call', { name: 'simulate_headless', arguments: { durationMin: 9999 } }));
    const { result } = out.body as { result: { isError?: boolean } };
    expect(result.isError).toBe(true);
  });

  it('未知方法回 -32600；未知通知回 202', () => {
    const out = post(rpc(13, 'resources/list'));
    expect((out.body as { error: { code: number } }).error.code).toBe(-32600);
    const note = post({ jsonrpc: '2.0', method: 'other/notification' });
    expect(note.status).toBe(202);
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApiHandler, type ApiHandlerDeps } from '../src/server/apiRoutes';
import type { Store } from '../src/server/store';
import type { TopologyStore } from '../src/server/topologyStore';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { PRESETS } from '../src/model/presets';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * HTTP API 路由契约。
 *
 * 抽取 apiRoutes 的收益必须能在这里兑现：不用起仿真服务器，就能锁住
 * 「公开端点免鉴权」「写方法 405」「未知 /api 404 而不是 index.html」。
 */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: string) {
      captured.body = body ?? '';
      return this;
    },
    setHeader() {},
    on() {},
  } as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function makeHandler(activePresetId: string | null = 'design-duty') {
  const snapshot = makeSnapshot();
  const deps: ApiHandlerDeps = {
    runtime: () => ({
      topology: PLANT_TOPOLOGY,
      topologyRevision: 1,
      net: { ...snapshot, modelMode: 'asm1' } as never,
      activePresetId,
      paused: false,
    }),
    snapshot: () => snapshot,
    store: { enabled: false } as Store,
    topologyStore: { history: () => [] } as unknown as TopologyStore,
  };
  return createApiHandler(deps);
}

describe('apiRoutes', () => {
  it('公开端点 auth-required 不需要令牌', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/auth-required'), res, '/api/auth-required');
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toHaveProperty('required');
  });

  it('limits 返回限值与控制量程', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/limits'), res, '/api/limits');
    const body = JSON.parse(captured.body) as { limits: { cod: number }; bounds: object; plant: object };
    expect(captured.status).toBe(200);
    expect(body.limits.cod).toBe(50);
    expect(Object.keys(body.bounds).length).toBeGreaterThan(0);
    expect(body.plant).toBeTruthy();
  });

  it('presets 返回模板列表并标出当前模板', () => {
    const handle = makeHandler(PRESETS[0].id);
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/presets'), res, '/api/presets');
    const body = JSON.parse(captured.body) as { presets: { id: string }[]; activeId: string | null };
    expect(body.presets.length).toBeGreaterThan(0);
    expect(body.activeId).toBe(PRESETS[0].id);
  });

  it('非 GET/HEAD 返回 405 和 Allow 头', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('POST', '/api/limits'), res, '/api/limits');
    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe('GET, HEAD');
  });

  it('未知 /api/* 返回 404，不退化成静态首页', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/nope'), res, '/api/nope');
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body).error).toBe('not found');
  });
});

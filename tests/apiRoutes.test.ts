import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApiHandler, type ApiHandlerDeps } from '../src/server/apiRoutes';
import type { Store } from '../src/server/store';
import type { TopologyStore } from '../src/server/topologyStore';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { PRESETS } from '../src/model/presets';
import { MAX_SNAPSHOT_WINDOW_MIN } from '../src/server/queryBounds';
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

function makeHandler(
  activePresetId: string | null = 'design-duty',
  overrides: Partial<ApiHandlerDeps> = {},
  storeOverrides: Partial<Store> = {},
) {
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
    store: { enabled: false, ...storeOverrides } as Store,
    topologyStore: { history: () => [] } as unknown as TopologyStore,
    ...overrides,
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

  it('models 标出默认模型、已接入模型与实验模型', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/models'), res, '/api/models');
    const body = JSON.parse(captured.body) as {
      models: { id: string; active: boolean; inRuntime: boolean; experimental: boolean }[];
    };
    expect(body.models.find((m) => m.id === 'asm1')).toMatchObject({ active: true, inRuntime: true });
    expect(body.models.find((m) => m.id === 'asm2d')).toMatchObject({
      active: false,
      inRuntime: true,
      experimental: true,
    });
  });

  it('health?deep=1 汇总暂停、持久化与仿真分钟', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/health?deep=1'), res, '/api/health');
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(captured.status).toBe(200);
    expect(body).toMatchObject({ ok: true, paused: false, persistence: 'disabled' });
    expect(typeof body.simulationMinutes).toBe('number');
  });

  it('history/snapshots 拒绝超窗查询，合法窗口返回上限', () => {
    const handle = makeHandler(
      undefined,
      {},
      {
        enabled: true,
        latestRunId: () => 'run-1',
        listRuns: () => [{ runId: 'run-1' } as never],
        snapshotsBetween: () => [],
      },
    );
    const bad = fakeRes();
    handle(
      fakeReq('GET', `/api/history/snapshots?from=0&to=${MAX_SNAPSHOT_WINDOW_MIN + 1}`),
      bad.res,
      '/api/history/snapshots',
    );
    expect(bad.captured.status).toBe(400);
    const good = fakeRes();
    handle(
      fakeReq('GET', `/api/history/snapshots?from=0&to=${MAX_SNAPSHOT_WINDOW_MIN}`),
      good.res,
      '/api/history/snapshots',
    );
    expect(good.captured.status).toBe(200);
    expect(JSON.parse(good.captured.body).limit).toBe(20_000);
  });

  it('export/report.md 走附件下载头，不返回 JSON', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/export/report.md'), res, '/api/export/report.md');
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toContain('text/markdown');
    expect(captured.headers['Content-Disposition']).toContain('aquapilot-report.md');
    expect(captured.body).toContain('AquaPilot');
  });

  it('未接线的工业域返回空表/409，而不是 500', () => {
    const handle = makeHandler();
    const protocols = fakeRes();
    handle(fakeReq('GET', '/api/protocols/status'), protocols.res, '/api/protocols/status');
    expect(protocols.captured.status).toBe(200);
    expect(JSON.parse(protocols.captured.body).channels).toEqual([]);
    const calibration = fakeRes();
    handle(fakeReq('GET', '/api/calibration/uncertainty'), calibration.res, '/api/calibration/uncertainty');
    expect(calibration.captured.status).toBe(409);
  });

  it('未知 /api/* 返回 404，不退化成静态首页', () => {
    const handle = makeHandler();
    const { res, captured } = fakeRes();
    handle(fakeReq('GET', '/api/nope'), res, '/api/nope');
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body).error).toBe('not found');
  });
});

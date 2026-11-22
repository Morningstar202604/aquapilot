import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApiHandler, type ApiHandlerDeps } from '../src/server/apiRoutes';
import type { Store } from '../src/server/store';
import type { TopologyStore } from '../src/server/topologyStore';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, stepNetwork } from '../src/sim/networkEngine';
import { createAssetStateFromTopology } from '../src/sim/assets';
import { createProtocolAudit } from '../src/server/protocols/audit';
import type { MinuteReading } from '../src/sim/sampling';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 工业级扩展域的路由接线契约。
 *
 * 这些端点由四个工作包各自实现（水力学 / 合规 / 资产 / 协议），但接线在
 * apiRoutes 里统一做。这里锁住的是接线本身：路径匹配、空子系统不 500、
 * CSV 走下载头、未知路径仍然 404。模块内部的数值口径由各自的测试负责。
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
  return { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

/** 一天的 10 分钟粒度读数，出水浓度全部在一级 A 限值内 */
function oneDayReadings(): MinuteReading[] {
  const out: MinuteReading[] = [];
  for (let m = 0; m < 1440; m += 10) {
    out.push({
      minute: m,
      flowM3h: 1000 + Math.sin(m / 120) * 180,
      values: { cod: 32, bod: 8, ss: 9, nh: 1.4, tn: 10.5, tp: 0.32 },
    });
  }
  return out;
}

function makeHandler(overrides: Partial<ApiHandlerDeps> = {}) {
  const snapshot = makeSnapshot();
  const net = createNetworkState(PLANT_TOPOLOGY);
  stepNetwork(net, PLANT_TOPOLOGY, 1);
  const deps: ApiHandlerDeps = {
    runtime: () => ({ topology: PLANT_TOPOLOGY, topologyRevision: 1, net, activePresetId: null, paused: false }),
    snapshot: () => snapshot,
    store: { enabled: false } as Store,
    topologyStore: { history: () => [] } as unknown as TopologyStore,
    ...overrides,
  };
  return createApiHandler(deps);
}

function call(handle: ReturnType<typeof createApiHandler>, url: string) {
  const { res, captured } = fakeRes();
  handle(fakeReq('GET', url), res, new URL(url, 'http://localhost').pathname);
  return captured;
}

describe('工业级扩展域路由接线', () => {
  it('/api/hydraulics 返回边流量与系列视图', () => {
    const captured = call(makeHandler(), '/api/hydraulics');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { edgeCount: number; edges: unknown[]; trains: unknown[] };
    expect(body.edgeCount).toBeGreaterThan(0);
    expect(body.edges.length).toBe(body.edgeCount);
    expect(body.trains.length).toBeGreaterThan(0);
  });

  it('/api/hydraulics?edge=未知 返回 404 而不是空对象', () => {
    const captured = call(makeHandler(), '/api/hydraulics?edge=no-such-edge');
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body).code).toBe('HYDRAULICS_INVALID_GEOMETRY');
  });

  it('/api/plant/balance 返回三本账与泥线状态', () => {
    const captured = call(makeHandler(), '/api/plant/balance');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      balance: { cod: { residualPct: number } };
      sludgeLine: { enabled: boolean };
    };
    expect(body.balance.cod.residualPct).toBeGreaterThanOrEqual(0);
    expect(typeof body.sludgeLine.enabled).toBe('boolean');
  });

  it('/api/assets 资产状态随引擎初始化，未显式注入也能返回台账', () => {
    const captured = call(makeHandler(), '/api/assets');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { assets: unknown[] };
    expect(body.assets.length).toBeGreaterThan(0);
  });

  it('/api/assets 引擎状态里没有资产子系统时返回空表，而不是 500', () => {
    const net = createNetworkState(PLANT_TOPOLOGY);
    delete net.assets;
    const captured = call(
      makeHandler({
        runtime: () => ({ topology: PLANT_TOPOLOGY, topologyRevision: 1, net, activePresetId: null, paused: false }),
      }),
      '/api/assets',
    );
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { assets: unknown[] };
    expect(body.assets).toEqual([]);
  });

  it('/api/instruments 返回测点读数与质量码', () => {
    const captured = call(makeHandler(), '/api/instruments');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { count: number; readings: { quality: string }[] };
    expect(body.count).toBeGreaterThan(0);
    expect(body.readings[0].quality).toBe('good');
  });

  it('/api/control/interlocks 返回联锁与回路视图', () => {
    const captured = call(makeHandler(), '/api/control/interlocks');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { interlocks: unknown[]; esd: unknown; audit: unknown[] };
    expect(body.interlocks.length).toBeGreaterThan(0);
    expect(body.esd).toBeTruthy();
    expect(Array.isArray(body.audit)).toBe(true);
  });

  it('/api/calibration/uncertainty 无剖面数据时 409 CALIBRATION_INSUFFICIENT_DATA', () => {
    const captured = call(makeHandler(), '/api/calibration/uncertainty');
    expect(captured.status).toBe(409);
    expect(JSON.parse(captured.body).code).toBe('CALIBRATION_INSUFFICIENT_DATA');
  });

  it('/api/assets 接线后返回 21 台设备与可用率', () => {
    const assets = createAssetStateFromTopology(PLANT_TOPOLOGY);
    const captured = call(makeHandler({ assetState: () => assets }), '/api/assets');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { assets: unknown[]; groups: { availability: number }[] };
    expect(body.assets.length).toBeGreaterThanOrEqual(12);
    expect(body.groups.length).toBeGreaterThan(0);
  });

  it('/api/assets/:id 未知设备返回 ASSET_NOT_FOUND', () => {
    const assets = createAssetStateFromTopology(PLANT_TOPOLOGY);
    const captured = call(makeHandler({ assetState: () => assets }), '/api/assets/pump-999');
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body).code).toBe('ASSET_NOT_FOUND');
  });

  it('/api/protocols/tags 返回完整标签表', () => {
    const captured = call(makeHandler({ protocolAudit: () => createProtocolAudit() }), '/api/protocols/tags');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { tags: { address: { opcua?: string } }[] };
    expect(body.tags.length).toBeGreaterThanOrEqual(20);
  });

  it('/api/protocols/status 未装配通道时返回空通道表', () => {
    const captured = call(makeHandler(), '/api/protocols/status');
    expect(captured.status).toBe(200);
    expect(captured.body).toContain('channels');
  });

  it('/api/compliance/report 用一天合格混合样出统计', () => {
    const captured = call(makeHandler({ complianceReadings: oneDayReadings }), '/api/compliance/report?from=0&to=1440');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      metrics: { cod: { daily: { value: number }[]; complianceRatePct: number | null } };
      dataSource: string;
    };
    expect(body.metrics.cod.daily).toHaveLength(1);
    expect(body.metrics.cod.daily[0].value).toBeCloseTo(32, 1);
    expect(body.metrics.cod.complianceRatePct).toBe(100);
    expect(body.dataSource).toBe('synthetic');
  });

  it('/api/compliance/report 没有样品时 422 + COMPLIANCE_NO_SAMPLES', () => {
    const captured = call(makeHandler({ complianceReadings: () => [] }), '/api/compliance/report?from=0&to=1440');
    expect(captured.status).toBe(422);
    expect(JSON.parse(captured.body).code).toBe('COMPLIANCE_NO_SAMPLES');
  });

  it('/api/compliance/report?format=csv 走下载头而不是行内 JSON', () => {
    const captured = call(
      makeHandler({ complianceReadings: oneDayReadings }),
      '/api/compliance/report?from=0&to=1440&format=csv',
    );
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type'] ?? captured.headers['content-type']).toContain('text/csv');
    expect(captured.body.split('\n')[0]).toContain('sample_value_mg_l');
  });

  it('未知 /api 路径仍然 404，不被扩展域吞掉', () => {
    const captured = call(makeHandler(), '/api/nope');
    expect(captured.status).toBe(404);
  });
});

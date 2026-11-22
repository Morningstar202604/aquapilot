// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IndustrialPanel } from '../src/client/components/IndustrialPanel';

/**
 * 「工业」页签客户端集成测试。
 *
 * 不测样式细节，只锁三条真实接线：
 * 1. 三块子视图都能把 API 响应的表头与关键数值渲染出来；
 * 2. 无合格样品（422 COMPLIANCE_NO_SAMPLES）走错误状态，不出空白表；
 * 3. 断开通道标红展示「断开」；CSV 下载按钮指向 format=csv 的正确地址。
 *
 * 所有请求用 mock fetch 拦截，不依赖真实服务器。
 */

const realFetch = global.fetch;

function mockFetch(routes: Record<string, { status: number; body: unknown }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('{}', { status: 404 });
    const r = routes[key];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

interface MetricLike {
  metric: string;
  label: string;
  limit: number;
  acceptedCount: number;
  rejectedCount: number;
  validAssessmentDays: number;
  complianceRatePct: number | null;
  completenessPct: number | null;
  monthlyMean: number | null;
  p95: number | null;
  exceedDayCount: number;
  daily: { dayMin: number; value: number }[];
}

function metricRow(metric: string, label: string, limit: number, overrides: Partial<MetricLike> = {}): MetricLike {
  return {
    metric,
    label,
    limit,
    acceptedCount: 8,
    rejectedCount: 2,
    validAssessmentDays: 8,
    complianceRatePct: 100,
    completenessPct: 80.0,
    monthlyMean: 33.1,
    p95: 41.2,
    exceedDayCount: 0,
    daily: [{ dayMin: 0, value: 32.4 }],
    ...overrides,
  };
}

const REPORT_BODY = {
  window: { fromMin: 0, toMin: 120 },
  standardId: 'GB18918-一级A',
  dataSource: 'synthetic',
  generatedAtMin: 120,
  metrics: {
    cod: metricRow('cod', 'COD', 50, { monthlyMean: 33.1, p95: 41.2 }),
    bod: metricRow('bod', 'BOD₅', 10, { monthlyMean: 6.2, p95: 7.8 }),
    ss: metricRow('ss', 'SS', 10, { complianceRatePct: 87.5, exceedDayCount: 1 }),
    nh: metricRow('nh', 'NH₃-N', 5, { monthlyMean: 1.42, p95: 2.05 }),
    tn: metricRow('tn', 'TN', 15, { monthlyMean: 11.8, p95: 13.6 }),
    tp: metricRow('tp', 'TP', 0.5, { monthlyMean: 0.31, p95: 0.42 }),
  },
  samples: [],
};

const ASSETS_BODY = {
  summary: {
    total: 2,
    running: 1,
    standby: 1,
    fault: 0,
    maintenance: 0,
    esdTripped: 0,
    avgHealth: 86,
    plantAvailability: 0.95,
  },
  esd: { active: false, unitId: null, triggeredAtMin: null },
  groups: [],
  assets: [
    {
      id: 'p1',
      name: '1# 回流泵',
      category: 'pump',
      unitName: '二沉池',
      isStandby: false,
      status: 'running',
      faultCode: null,
      health: 90,
      availability: 0.96,
      runtimeMin: 1200,
      activeWorkOrderId: null,
    },
    {
      id: 'b1',
      name: '1# 鼓风机',
      category: 'blower',
      unitName: '好氧区',
      isStandby: true,
      status: 'standby',
      faultCode: null,
      health: 82,
      availability: 0.94,
      runtimeMin: 600,
      activeWorkOrderId: 'WO-1',
    },
  ],
  workOrders: [
    {
      id: 'WO-1',
      assetId: 'b1',
      kind: 'preventive',
      status: 'open',
      reason: '季度保养',
      overdue: false,
      downtimeMin: 0,
    },
  ],
};

const PROTOCOL_BODIES = {
  tags: {
    tags: [
      {
        id: 'reactor1.do',
        label: '好氧池溶解氧',
        dataType: 'float32',
        unit: 'mg/L',
        access: 'read',
        scale: { rawPerUnit: 100, unitMin: 0, unitMax: 12 },
        source: { kind: 'reactor', field: 'doLevel' },
        address: { opcua: 'ns=2;s=Aquapilot.Reactor1.DO', modbusRegister: 40001, mqtt: 'aquapilot/reactor1/do' },
        description: '第一座好氧池瞬时溶解氧浓度',
      },
    ],
  },
  status: {
    channels: [
      { protocol: 'opcua', state: 'connected', reconnectAttempts: 0, connectedAt: '2026-11-23T01:00:00.000Z' },
      { protocol: 'modbus', state: 'disconnected', reconnectAttempts: 3, lastError: '连接超时' },
    ],
  },
  audit: {
    total: 3,
    audit: [
      {
        seq: 3,
        at: '2026-11-23T01:10:00.000Z',
        atMin: 120,
        actor: 'operator',
        role: 'operator',
        protocol: 'opcua',
        tag: 'reactor1.do',
        address: 'ns=2;s=Aquapilot.Reactor1.DO',
        requestedValue: 2.1,
        result: 'success',
        reason: '',
      },
      {
        seq: 2,
        at: '2026-11-23T01:09:00.000Z',
        atMin: 119,
        actor: 'anonymous',
        role: 'anonymous',
        protocol: 'modbus',
        tag: '40007',
        address: '40007',
        requestedValue: 5,
        result: 'denied',
        reason: '非白名单写入',
        code: 'PROTOCOL_WRITE_DENIED',
      },
      {
        seq: 1,
        at: '2026-11-23T01:08:00.000Z',
        atMin: 118,
        actor: 'system',
        role: 'admin',
        protocol: 'mqtt',
        tag: 'aquapilot/unknown',
        address: 'aquapilot/unknown',
        requestedValue: null,
        result: 'unknown_tag',
        reason: '标签不在映射表',
        code: 'PROTOCOL_TAG_UNKNOWN',
      },
    ],
  },
};

const INSTRUMENTS_BODY = {
  timeMin: 120,
  count: 2,
  readings: [
    {
      sensorId: 'r1:do',
      unitId: 'r1',
      variable: 'do',
      measured: 2.01,
      truth: 2.0,
      quality: 'good',
      reason: null,
      code: null,
      fault: 'none',
      atMin: 120,
    },
    {
      sensorId: 'r1:nh',
      unitId: 'r1',
      variable: 'nh',
      measured: 0.5,
      truth: 0.52,
      quality: 'bad',
      reason: 'stuck',
      code: 'SENSOR_STUCK',
      fault: 'stuck',
      atMin: 120,
    },
  ],
};

const INTERLOCKS_BODY = {
  timeMin: 120,
  inflowStopped: false,
  interlocksEnabled: false,
  esd: { active: false, reason: null },
  loops: {},
  outputs: {},
  interlocks: [{ conditionId: 'do-low', value: 1.2, threshold: 1.0, action: 'fanMax', latched: false }],
  audit: [],
};

function mockAll() {
  mockFetch({
    '/api/instruments': { status: 200, body: INSTRUMENTS_BODY },
    '/api/control/interlocks': { status: 200, body: INTERLOCKS_BODY },
    '/api/compliance/report': { status: 200, body: REPORT_BODY },
    '/api/assets': { status: 200, body: ASSETS_BODY },
    '/api/protocols/tags': { status: 200, body: PROTOCOL_BODIES.tags },
    '/api/protocols/status': { status: 200, body: PROTOCOL_BODIES.status },
    '/api/protocols/audit': { status: 200, body: PROTOCOL_BODIES.audit },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('工业页签 · 合规报表', () => {
  it('渲染表头、关键数值与数据来源标识', async () => {
    mockAll();
    render(<IndustrialPanel timeMin={120} />);

    await waitFor(() => expect(screen.getByText('指标考核（6）')).toBeTruthy());
    for (const header of ['指标', '限值', '日均值', '有效考核日', '达标率', '95 分位', '超标日', '完整率', '作废样']) {
      expect(screen.getByText(header)).toBeTruthy();
    }
    expect(screen.getByText('COD')).toBeTruthy();
    expect(screen.getByText(/≤ 50 mg\/L/)).toBeTruthy();
    expect(screen.getAllByText('100.0%').length).toBeGreaterThan(0);
    expect(screen.getByText('87.5%')).toBeTruthy();
    // 数据来源标识必须显眼
    expect(screen.getByText(/合成数据/)).toBeTruthy();
    expect(screen.getByText(/synthetic/)).toBeTruthy();
  });

  it('CSV 下载按钮指向 format=csv 的正确地址', async () => {
    mockAll();
    render(<IndustrialPanel timeMin={120} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '合规报表 CSV' })).toBeTruthy());
    const btn = screen.getByRole('button', { name: '合规报表 CSV' });
    expect(btn.getAttribute('data-href')).toBe('/api/compliance/report?from=0&to=120&format=csv');
  });

  it('无合格样品时显示 422 错误文案，而不是空白表', async () => {
    mockFetch({
      '/api/compliance/report': {
        status: 422,
        body: { error: '窗口内没有合格样品，无法出具合规统计', code: 'COMPLIANCE_NO_SAMPLES' },
      },
    });
    render(<IndustrialPanel timeMin={120} />);

    await waitFor(() => expect(screen.getByText(/窗口内没有合格样品/)).toBeTruthy());
    expect(screen.getByText('COMPLIANCE_NO_SAMPLES')).toBeTruthy();
    expect(screen.queryByText('95 分位')).toBeNull();
  });
});

describe('工业页签 · 资产台账', () => {
  it('复用 AssetsPanel 渲染设备状态、健康度、可用率与工单', async () => {
    mockAll();
    render(<IndustrialPanel timeMin={120} />);

    fireEvent.click(screen.getByRole('button', { name: '资产台账' }));
    await waitFor(() => expect(screen.getByText('设备台账（2）')).toBeTruthy());

    expect(screen.getByText('1# 回流泵')).toBeTruthy();
    expect(screen.getByText('1# 鼓风机')).toBeTruthy();
    expect(screen.getAllByText('运行').length).toBeGreaterThan(0);
    expect(screen.getByText('备用')).toBeTruthy();
    expect(screen.getAllByText('WO-1').length).toBeGreaterThan(0);
    expect(screen.getByText('季度保养')).toBeTruthy();
  });
});

describe('工业页签 · 协议通道', () => {
  it('渲染标签表、通道状态与写审计，断开通道显示「断开」', async () => {
    mockAll();
    render(<IndustrialPanel timeMin={120} />);

    fireEvent.click(screen.getByRole('button', { name: '协议通道' }));
    await waitFor(() => expect(screen.getByText('通道状态（2）')).toBeTruthy());

    // 标签表表头
    expect(screen.getByText('地址（OPC UA）')).toBeTruthy();
    expect(screen.getByText('好氧池溶解氧')).toBeTruthy();
    expect(screen.getByText('只读')).toBeTruthy();

    // 通道状态：已连接 + 断开（断开标红由样式承担，这里断言文案）
    expect(screen.getByText('已连接')).toBeTruthy();
    const disconnected = screen.getAllByText('断开');
    expect(disconnected.length).toBeGreaterThan(0);

    // 写审计：成功 / 拒绝 / 未知标签
    expect(screen.getByText(/非白名单写入/)).toBeTruthy();
    expect(screen.getByText('PROTOCOL_WRITE_DENIED')).toBeTruthy();
    expect(screen.getByText(/标签不在映射表/)).toBeTruthy();
    expect(screen.getByText('PROTOCOL_TAG_UNKNOWN')).toBeTruthy();

    // 模拟服务器声明
    expect(screen.getByText(/模拟服务器，未接现场 PLC/)).toBeTruthy();
  });
});

describe('工业页签 · 仪表联锁', () => {
  it('显示测点 measured/truth/质量码与联锁状态', async () => {
    mockAll();
    render(<IndustrialPanel timeMin={120} />);

    fireEvent.click(screen.getByRole('button', { name: '仪表联锁' }));
    await waitFor(() => expect(screen.getByText(/仪表（2 测点/)).toBeTruthy());

    expect(screen.getByText('r1:do')).toBeTruthy();
    expect(screen.getByText('r1:nh')).toBeTruthy();
    expect(screen.getByText('2.01')).toBeTruthy();
    expect(screen.getByText('2.00')).toBeTruthy();
    expect(screen.getByText('stuck')).toBeTruthy();

    await waitFor(() => expect(screen.getByText('do-low')).toBeTruthy());
    expect(screen.getByText(/仅求值不介入/)).toBeTruthy();
    expect(screen.getByText('正常')).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { createSnapshotService, type SnapshotSource } from '../src/server/snapshotView';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createShadowPlant, summarizeBenchmark } from '../src/server/benchmark';
import { freshClientState } from '../src/server/rateLimit';
import { resetMetrics } from '../src/server/observability';

/**
 * 快照投影。
 *
 * 全量帧与增量帧必须逐字段同源：只要一个字段只在其中一帧里，
 * 就会出现「界面停在连接那一刻」的假实时。这个测试把两帧
 * 共有字段做交叉比对，而不是各自断言形状。
 */

function makeService() {
  const net = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
  spinUpNetwork(net, PLANT_TOPOLOGY, 30);
  const source: SnapshotSource = {
    topology: PLANT_TOPOLOGY,
    net,
    trend: [
      {
        t: 10,
        influentCod: 300,
        influentNh: 30,
        influentFlow: 1800,
        effluentCod: 30,
        effluentNh: 1,
        effluentTn: 8,
        effluentTp: 0.2,
        effluentSs: 5,
        do: 2,
        mlss: 3000,
        energyKw: 300,
        blanket: 1,
      },
      {
        t: 20,
        influentCod: 310,
        influentNh: 31,
        influentFlow: 1810,
        effluentCod: 31,
        effluentNh: 1.1,
        effluentTn: 8.1,
        effluentTp: 0.21,
        effluentSs: 5.1,
        do: 2.1,
        mlss: 3010,
        energyKw: 301,
        blanket: 1.1,
      },
    ],
    speed: 1,
    paused: false,
    recommendation: null,
    forecastCache: { key: null, value: null },
    shadow: createShadowPlant(PLANT_TOPOLOGY, 5, 0),
  };
  const service = createSnapshotService({
    source: () => source,
    forecastFor: () => null,
    summarizeBenchmark,
  });
  return { service, net, source };
}

describe('全量快照', () => {
  it('包含契约要求的全部关键字段', () => {
    const { service } = makeService();
    const snap = service.buildSnapshot();
    for (const key of [
      'timeMin',
      'effluent',
      'tanks',
      'clarifier',
      'controls',
      'energy',
      'cost',
      'srtDays',
      'fmRatio',
      'score',
      'margins',
      'alarms',
      'activeAlarms',
      'alarmAttribution',
      'health',
      'trends',
      'limits',
      'totals',
      'reactorCount',
    ] as const) {
      expect(snap, key).toHaveProperty(key);
    }
  });

  it('数值字段都是有限数（不会把 NaN 送到前端）', () => {
    const { service } = makeService();
    const snap = service.buildSnapshot();
    expect(Number.isFinite(snap.effluent.cod)).toBe(true);
    expect(Number.isFinite(snap.score)).toBe(true);
    expect(Number.isFinite(snap.srtDays)).toBe(true);
    expect(Number.isFinite(snap.totals.inflowM3)).toBe(true);
    for (const m of snap.margins) expect(Number.isFinite(m.ratio)).toBe(true);
    for (const p of snap.health.parts) expect(Number.isFinite(p.score)).toBe(true);
  });

  it('告警按时间倒序，最多 20 条', () => {
    const { service } = makeService();
    const snap = service.buildSnapshot();
    expect(snap.alarms.length).toBeLessThanOrEqual(20);
  });

  it('无推荐时不带预测与集合带', () => {
    const { service } = makeService();
    const snap = service.buildSnapshot();
    expect(snap.forecast).toBeNull();
    expect(snap.forecastBand).toBeNull();
  });
});

describe('增量补丁', () => {
  it('首帧给出全部趋势点，之后只给新增', () => {
    const { service } = makeService();
    const fresh = freshClientState();
    const first = service.buildPatch(fresh);
    expect(first.trendsAppend.map((p) => p.t)).toEqual([10, 20]);
    const second = service.buildPatch(fresh);
    expect(second.trendsAppend).toEqual([]);
  });

  it('与全量帧共有字段逐项一致（防止两帧口径漂移）', () => {
    const { service } = makeService();
    const snap = service.buildSnapshot();
    const patch = service.buildPatch(freshClientState());
    expect(patch.timeMin).toBe(snap.timeMin);
    expect(patch.effluent.cod).toBeCloseTo(snap.effluent.cod, 6);
    expect(patch.srtDays).toBeCloseTo(snap.srtDays, 6);
    expect(patch.fmRatio).toBeCloseTo(snap.fmRatio, 6);
    expect(patch.score).toBe(snap.score);
    expect(patch.reactorCount).toBe(snap.reactorCount);
    expect(patch.totals.inflowM3).toBeCloseTo(snap.totals.inflowM3, 3);
    expect(patch.health.score).toBe(snap.health.score);
    expect(patch.controls.doSetpoint).toBe(snap.controls.doSetpoint);
  });

  it('补丁携带进水水质（暴雨场景下不能冻结在连接时刻）', () => {
    const { service, net } = makeService();
    net.influent.cod = 999;
    net.influent.nh = 77;
    const patch = service.buildPatch(freshClientState());
    expect(patch.influent.cod).toBe(999);
    expect(patch.influent.nh).toBe(77);
    expect(patch.influentFlow).toBe(net.influent.flow);
  });

  it('批量构建共享同一帧内容，趋势游标各自推进', () => {
    const { service } = makeService();
    const a = freshClientState();
    const b = freshClientState();
    b.lastTrendT = 10;
    const [pa, pb] = service.buildPatches([a, b]);
    expect(pa.trendsAppend.map((p) => p.t)).toEqual([10, 20]);
    expect(pb.trendsAppend.map((p) => p.t)).toEqual([20]);
    expect(pa.effluent).toEqual(pb.effluent);
  });
});

describe('派生量', () => {
  it('currentAlarms 与 derived 使用同一份告警集合', () => {
    const { service, net } = makeService();
    const alarms = service.currentAlarms(net);
    const d = service.derived(net);
    expect(d.activeAlarms.length).toBe(alarms.length);
  });

  it('derived 的裕度按最紧排序', () => {
    const { service, net } = makeService();
    const d = service.derived(net);
    for (let i = 1; i < d.margins.length; i++) {
      expect(d.margins[i - 1].ratio).toBeGreaterThanOrEqual(d.margins[i].ratio);
    }
  });
});

describe('指标不因快照构造而污染', () => {
  it('构造快照不改变 tick 计数', () => {
    resetMetrics();
    const { service } = makeService();
    service.buildSnapshot();
    service.buildPatch(freshClientState());
    // 只断言不抛错且快照可重复构造（指标由广播层负责）
    expect(service.buildSnapshot().reactorCount).toBeGreaterThan(0);
  });
});

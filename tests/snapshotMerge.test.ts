import { describe, expect, it } from 'vitest';
import { mergeSnapshot } from '../src/client/hooks/snapshotMerge';
import { DEFAULT_CONTROLS } from '../src/sim/config';
import { makeSnapshot } from './fixtures/snapshot';
import type { SnapshotPatch } from '../src/shared/protocol';

/**
 * 增量合并。
 *
 * 三个真实缺陷锁在这里：
 * 1. controls 不合并 → AI 自动执行后滑块停在旧值；
 * 2. totals 不合并 → 「累计处理水量 / 电耗 / 成本」永远停在连接时的数字；
 * 3. fmRatio 不合并 → F/M 一直是旧值。
 */

const basePatch = (over: Partial<SnapshotPatch> = {}): SnapshotPatch => {
  const snap = makeSnapshot();
  return {
    timeMin: snap.timeMin + 2,
    influentFlow: 2100,
    effluent: snap.effluent,
    tanks: snap.tanks.map((t) => ({
      id: t.id,
      do: t.do,
      mlss: t.mlss,
      cod: t.cod,
      nh: t.nh,
      no3: t.no3,
      tp: t.tp,
      alkalinity: t.alkalinity,
    })),
    clarifier: {
      blanketM: snap.clarifier.blanketM,
      xRas: snap.clarifier.xRas,
      xEff: snap.clarifier.xEff,
      slr: snap.clarifier.slr,
    },
    energy: snap.energy,
    cost: { totalToday: snap.cost.totalToday, total: snap.cost.total },
    srtDays: snap.srtDays,
    fmRatio: 0.071,
    controls: { ...DEFAULT_CONTROLS, doSetpoint: 1.4 },
    scenario: snap.scenario,
    totals: { ...snap.totals, inflowM3: 9999 },
    score: snap.score,
    margins: snap.margins,
    trendsAppend: [{ ...snap.trends[0], t: 5 } as never].filter(Boolean) as SnapshotPatch['trendsAppend'],
    alarms: snap.alarms,
    activeAlarms: snap.activeAlarms,
    alarmAttribution: snap.alarmAttribution,
    health: snap.health,
    stormStorageM3: snap.stormStorageM3,
    reactorCount: snap.reactorCount,
    forecastBand: null,
    benchmark: null,
    ...over,
  };
};

describe('mergeSnapshot', () => {
  it('合并 AI 执行后的控制量（滑块必须跟随服务端）', () => {
    const next = mergeSnapshot(makeSnapshot(), basePatch());
    expect(next.controls.doSetpoint).toBe(1.4);
  });

  it('合并累计量（累计水量/电耗/成本不能停在连接时）', () => {
    const next = mergeSnapshot(makeSnapshot(), basePatch());
    expect(next.totals.inflowM3).toBe(9999);
  });

  it('合并场景状态（否则场景结束后界面仍显示进行中）', () => {
    const active = { type: 'storm', durationMin: 360, magnitude: 1, startedAt: 100 } as never;
    const withScenario = mergeSnapshot(makeSnapshot(), basePatch({ scenario: active }));
    expect(withScenario.scenario?.type).toBe('storm');
    const cleared = mergeSnapshot(withScenario, basePatch({ scenario: null }));
    expect(cleared.scenario).toBeNull();
  });

  it('合并 F/M', () => {
    const next = mergeSnapshot(makeSnapshot(), basePatch());
    expect(next.fmRatio).toBe(0.071);
  });

  it('合并新触发的告警历史（否则运行中新告警不会进历史记录）', () => {
    const alarm = { id: 'A9', at: 90, severity: 'warning' as const, code: 'DO_LOW', message: '低溶解氧' };
    const next = mergeSnapshot(makeSnapshot(), basePatch({ alarms: [alarm] }));
    expect(next.alarms).toHaveLength(1);
    expect(next.alarms[0].code).toBe('DO_LOW');
  });

  it('补丁不带告警时保留上一帧历史', () => {
    const snap = makeSnapshot();
    snap.alarms = [{ id: 'A1', at: 10, severity: 'warning', code: 'OLD', message: 'x' }];
    const next = mergeSnapshot(snap, basePatch({ alarms: undefined }));
    expect(next.alarms[0].code).toBe('OLD');
  });

  it('追加趋势并裁剪到 720 点', () => {
    const snap = makeSnapshot();
    snap.trends = Array.from({ length: 720 }, (_, i) => ({ ...snap.trends[0], t: i })).map((p) => ({
      ...p,
    })) as typeof snap.trends;
    const next = mergeSnapshot(snap, basePatch({ trendsAppend: [{ ...snap.trends[0], t: 720 }] as never }));
    expect(next.trends).toHaveLength(720);
    expect(next.trends.at(-1)!.t).toBe(720);
  });

  it('畸形补丁原样返回上一帧', () => {
    const snap = makeSnapshot();
    const next = mergeSnapshot(snap, { ...basePatch(), tanks: null } as unknown as SnapshotPatch);
    expect(next).toBe(snap);
  });
});

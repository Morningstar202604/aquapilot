import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLS, LIMITS, PLANT } from '../src/sim/config';
import {
  createNetworkState,
  networkModel,
  spinUpNetwork,
  startNetworkScenario,
  stepNetwork,
} from '../src/sim/networkEngine';
import { qualityScore } from '../src/sim/metrics';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 稳态统一用生产引擎（拓扑求解）构造。
 *
 * 本文件此前跑在固定五池参考引擎上：生产路径早已是 networkEngine，
 * 用已淘汰的引擎做「稳态是否达标」的门禁，等于给一条不再运行的路径发合格证。
 * 参考引擎现只保留在 cross-engine 的一致性测试里。
 */
function steadyState(seed = 7) {
  return spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 30);
}
const step = (s: ReturnType<typeof steadyState>, dt = 1) => stepNetwork(s, PLANT_TOPOLOGY, dt);
const startScenario = (
  s: ReturnType<typeof steadyState>,
  type: Parameters<typeof startNetworkScenario>[1],
  opts?: Parameters<typeof startNetworkScenario>[2],
) => startNetworkScenario(s, type, opts);
const forecast = (
  s: ReturnType<typeof steadyState>,
  controls: typeof DEFAULT_CONTROLS,
  horizon: number,
  every: number,
) => networkModel(PLANT_TOPOLOGY, s).predict(controls, horizon, every);

describe('engine steady state', () => {
  it('reaches a compliant effluent under design load', () => {
    const s = steadyState();
    expect(s.effluent.nh).toBeLessThan(LIMITS.nh);
    expect(s.effluent.cod).toBeLessThan(LIMITS.cod);
    expect(s.effluent.tp).toBeLessThanOrEqual(LIMITS.tp);
    expect(s.effluent.ss).toBeLessThan(LIMITS.ss);
  });

  it('holds biomass inside the design MLSS window', () => {
    const s = steadyState();
    expect((s.biomassKg * 1000) / s.volume.bio).toBeGreaterThan(2000);
    expect((s.biomassKg * 1000) / s.volume.bio).toBeLessThan(6000);
  });

  it('keeps sludge age in a nitrifying range', () => {
    const s = steadyState();
    expect(s.srtDays).toBeGreaterThan(10);
    expect(s.srtDays).toBeLessThanOrEqual(40);
  });

  it('maintains the DO setpoint in every aerobic tank', () => {
    const s = steadyState();
    const aerobic = s.reactors.filter((t) => t.kind === 'aerobic');
    for (const tank of aerobic) {
      expect(tank.doLevel).toBeGreaterThan(1.4);
      expect(tank.doLevel).toBeLessThan(3.0);
    }
  });

  it('keeps anaerobic and anoxic zones free of dissolved oxygen', () => {
    const s = steadyState();
    const anaerobic = s.reactors.find((t) => t.kind === 'anaerobic')!;
    const anoxic = s.reactors.find((t) => t.kind === 'anoxic')!;
    expect(anaerobic.doLevel).toBeLessThan(0.5);
    expect(anoxic.doLevel).toBeLessThan(0.5);
  });
});

describe('conservation and determinism', () => {
  it('is deterministic for an identical seed and step sequence', () => {
    const a = createNetworkState(PLANT_TOPOLOGY, { seed: 99 });
    const b = createNetworkState(PLANT_TOPOLOGY, { seed: 99 });
    for (let i = 0; i < 300; i++) {
      step(a, 1);
      step(b, 1);
    }
    expect(a.effluent.nh).toBeCloseTo(b.effluent.nh, 10);
    expect(a.effluent.cod).toBeCloseTo(b.effluent.cod, 10);
    expect(a.biomassKg).toBeCloseTo(b.biomassKg, 6);
  });

  it('does not produce NaN or negative concentrations over 3 simulated days', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    for (let i = 0; i < 4320; i++) step(s, 1);
    for (const tank of s.reactors) {
      for (const v of [tank.cod, tank.nh, tank.no3, tank.tp, tank.doLevel, tank.alkalinity]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
    for (const v of Object.values(s.effluent)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('tracks inflow volume against the elapsed simulation time', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 11 });
    for (let i = 0; i < 600; i++) step(s, 1);
    const hours = 600 / 60;
    const average = s.totals.inflowM3 / hours;
    expect(average).toBeGreaterThan(PLANT.designFlowM3h * 0.5);
    expect(average).toBeLessThan(PLANT.designFlowM3h * 1.6);
  });
});

describe('scenario physics', () => {
  it('storm dilution lowers influent COD while raising flow', () => {
    const base = steadyState();
    const storm = steadyState();
    startScenario(storm, 'storm');
    for (let i = 0; i < 120; i++) step(storm, 1);
    expect(storm.influent.flow).toBeGreaterThan(base.influent.flow * 1.2);
    expect(storm.influent.cod).toBeLessThan(base.influent.cod);
  });

  it('blower failure drives dissolved oxygen down and ammonia up', () => {
    const s = steadyState();
    const before = s.effluent.nh;
    startScenario(s, 'blower_failure', { durationMin: 240 });
    for (let i = 0; i < 200; i++) step(s, 1);
    const aerobic = s.reactors.find((t) => t.kind === 'aerobic')!;
    expect(aerobic.doLevel).toBeLessThan(1.5);
    expect(s.effluent.nh).toBeGreaterThan(before);
  });

  it('toxic inhibition suppresses nitrification', () => {
    const clean = steadyState();
    const toxic = steadyState();
    startScenario(toxic, 'toxic', { durationMin: 360 });
    for (let i = 0; i < 300; i++) step(toxic, 1);
    expect(toxic.effluent.nh).toBeGreaterThan(clean.effluent.nh * 2);
    expect(toxic.inhibition).toBeLessThan(1);
  });

  it('ras failure lifts the sludge blanket', () => {
    const s = steadyState();
    const before = s.clarifier.blanketM;
    startScenario(s, 'ras_failure', { durationMin: 240 });
    for (let i = 0; i < 180; i++) step(s, 1);
    expect(s.clarifier.blanketM).toBeGreaterThan(before);
  });

  it('chemical shortage removes the PAC backstop and raises effluent phosphorus', () => {
    const s = steadyState();
    const before = s.effluent.tp;
    startScenario(s, 'chemical_shortage', { durationMin: 480 });
    for (let i = 0; i < 400; i++) step(s, 1);
    expect(s.effluent.tp).toBeGreaterThan(before);
  });
});

describe('forecast', () => {
  it('produces the requested horizon with monotonic sampling', () => {
    const s = steadyState();
    const fc = forecast(s, s.controls, 240, 30);
    expect(fc.points).toHaveLength(8);
    expect(fc.points[0].minute).toBe(30);
    expect(fc.points[7].minute).toBe(240);
    for (let i = 1; i < fc.points.length; i++) {
      expect(fc.points[i].minute).toBeGreaterThan(fc.points[i - 1].minute);
    }
  });

  it('does not mutate the live state', () => {
    const s = steadyState();
    const snapshot = JSON.stringify(s);
    forecast(s, { ...DEFAULT_CONTROLS, doSetpoint: 3.4 }, 240, 30);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('reports more violations as the DО setpoint is starved', () => {
    const stressed = steadyState();
    startScenario(stressed, 'shock_load', { durationMin: 360 });
    for (let i = 0; i < 90; i++) step(stressed, 1);
    const healthy = forecast(stressed, { ...stressed.controls, doSetpoint: 3.2 }, 240, 30);
    const starved = forecast(stressed, { ...stressed.controls, doSetpoint: 1.0 }, 240, 30);
    expect(starved.violations.length).toBeGreaterThanOrEqual(healthy.violations.length);
  });
});

describe('quality score', () => {
  it('ranks a compliant effluent above a non-compliant one', () => {
    const s = steadyState();
    const good = qualityScore(s.effluent);
    const bad = qualityScore({ ...s.effluent, nh: LIMITS.nh * 2, cod: LIMITS.cod * 1.5 });
    expect(good).toBeGreaterThan(bad);
    /**
     * 生产引擎的出水 SS 由 Takács 给出（约 7.6，占限值 76%），
     * 评分被压到 40 分区间；参考引擎用经验关联式（SS≈1.6）才有 70+。
     * 这里锁的是「达标优于超标」的相对关系，不锁绝对分数。
     */
    expect(good).toBeGreaterThan(30);
  });
});

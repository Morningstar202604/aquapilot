import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import {
  createNetworkState,
  spinUpNetwork,
  startNetworkScenario,
  stepNetwork,
  type NetworkSimState,
} from '../src/sim/networkEngine';

function steady(seed = 7): NetworkSimState {
  const s = createNetworkState(PLANT_TOPOLOGY, { seed, model: 'asm1' });
  spinUpNetwork(s, PLANT_TOPOLOGY, 25);
  for (let i = 0; i < 15; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
  return s;
}

describe('网络引擎工业物理回归', () => {
  it('冬季场景把实际水温降到目标值，并让硝化变差', () => {
    const warm = steady();
    const cold = createNetworkState(PLANT_TOPOLOGY, { seed: 7, model: 'asm1' });
    cold.scenario = { type: 'winter', durationMin: 30 * 1440, magnitude: 12, startedAt: 0 };
    spinUpNetwork(cold, PLANT_TOPOLOGY, 25);
    for (let i = 0; i < 15; i++) stepNetwork(cold, PLANT_TOPOLOGY, 1);

    const warmTemp = warm.reactors.find((r) => r.kind === 'aerobic')!.temperature;
    const coldTemp = cold.reactors.find((r) => r.kind === 'aerobic')!.temperature;
    expect(coldTemp).toBeCloseTo(12, 1);
    expect(warmTemp).toBeGreaterThan(coldTemp);

    // 低温下 Arrhenius 速率下降，出水氨氮应高于常温；同时不应发散到不可能值
    expect(cold.effluent.nh).toBeGreaterThan(warm.effluent.nh);
    expect(cold.effluent.nh).toBeLessThan(50);
  }, 120_000);

  it('鼓风机故障时 DO 脱离设定值，风机功率随实际氧传递下降', () => {
    const s = steady();
    const baseDo = s.reactors.find((r) => r.kind === 'aerobic')!.doLevel;
    const baseKw = s.energy.blowerKw;

    startNetworkScenario(s, 'blower_failure', { durationMin: 60, magnitude: 0.2 });
    for (let i = 0; i < 12; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);

    const failedDo = s.reactors.find((r) => r.kind === 'aerobic')!.doLevel;
    expect(failedDo).toBeLessThan(baseDo - 0.1);
    expect(s.energy.blowerKw).toBeLessThan(baseKw);
    expect(Number.isFinite(failedDo)).toBe(true);
    expect(failedDo).toBeGreaterThanOrEqual(0.02);
  }, 120_000);

  it('默认 ASM1 稳态 DO 由 KLa 与耗氧平衡得到，不是直接贴设定值', () => {
    const s = steady();
    const aerobic = s.reactors.filter((r) => r.kind === 'aerobic');
    expect(aerobic.length).toBeGreaterThan(0);
    for (const r of aerobic) {
      expect(r.kla).toBeGreaterThan(0);
      expect(r.doLevel).toBeGreaterThan(1.7);
      expect(r.doLevel).toBeLessThan(2.3);
    }
  }, 120_000);
});

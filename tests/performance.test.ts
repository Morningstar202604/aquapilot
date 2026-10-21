import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

/**
 * 性能回归测试。
 *
 * 目的不是追求速度，而是防止"某次改动让仿真慢十倍"这种静默退化。
 * 阈值取实测值的 5–10 倍，只在数量级变化时报警，避免在慢机器上抖动。
 */

function measure(fn: () => void, iterations: number): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - t0) / iterations;
}

describe('性能基线', () => {
  it('单步仿真在 5ms 以内', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 1 });
    const perStep = measure(() => stepNetwork(s, PLANT_TOPOLOGY, 1), 200);
    expect(perStep).toBeLessThan(5);
  });

  it('4 小时预测在 100ms 以内', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 5);
    const model = networkModel(PLANT_TOPOLOGY, s);
    const perPredict = measure(() => model.predict(s.controls, 240, 30), 10);
    expect(perPredict).toBeLessThan(100);
  });

  it('30 天预热在 5 秒以内', () => {
    const t0 = performance.now();
    spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 30);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

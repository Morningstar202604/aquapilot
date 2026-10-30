import { describe, expect, it } from 'vitest';
import {
  createEstimatorRuntime,
  measureFromState,
  stepEstimator,
  DEFAULT_ESTIMATOR_CONFIG,
} from '../src/server/estimatorRuntime';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 估计器运行时接线（服务端）。
 *
 * 这层负责三件可能出错的事：
 * ① 每 tick 预测-测量-更新 的顺序；
 * ② 校正限幅（不能把噪声放大成状态跳变）；
 * ③ 默认关闭（不破坏既有确定性测试）。
 */

function makeNet() {
  const net = createNetworkState(PLANT_TOPOLOGY, { seed: 11 });
  spinUpNetwork(net, PLANT_TOPOLOGY, 30);
  return net;
}

describe('默认配置', () => {
  it('默认关闭且噪声量级合理', () => {
    expect(DEFAULT_ESTIMATOR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_ESTIMATOR_CONFIG.applyCorrection).toBe(true);
    expect(DEFAULT_ESTIMATOR_CONFIG.noiseSigma.mlss).toBeLessThan(500);
  });
});

describe('stepEstimator 在真实状态上', () => {
  it('连续 100 步不产生 NaN（含确定性噪声）', () => {
    const net = makeNet();
    const rt = createEstimatorRuntime(measureFromState(net), { enabled: true });
    for (let i = 0; i < 100; i++) {
      stepNetwork(net, PLANT_TOPOLOGY, 1);
      const truth = measureFromState(net);
      const out = stepEstimator(rt, truth, net.seed);
      for (const v of Object.values(out.estimated!)) expect(Number.isFinite(v)).toBe(true);
    }
    expect(rt.corrections).toBe(100);
  });

  it('估计值与真值的偏差有界（不发散）', () => {
    const net = makeNet();
    const rt = createEstimatorRuntime(measureFromState(net), { enabled: true });
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      stepNetwork(net, PLANT_TOPOLOGY, 1);
      const truth = measureFromState(net);
      const { deviation } = stepEstimator(rt, truth, net.seed);
      if (deviation) {
        for (const d of Object.values(deviation)) maxDev = Math.max(maxDev, Math.abs(d!));
      }
    }
    // 偏差有界：估计器追得上模型演化
    expect(maxDev).toBeLessThan(2000);
  });

  it('确定性：同 seed 同序列得到相同估计', () => {
    const netA = makeNet();
    const netB = makeNet();
    const rtA = createEstimatorRuntime(measureFromState(netA), { enabled: true });
    const rtB = createEstimatorRuntime(measureFromState(netB), { enabled: true });
    for (let i = 0; i < 10; i++) {
      stepNetwork(netA, PLANT_TOPOLOGY, 1);
      stepNetwork(netB, PLANT_TOPOLOGY, 1);
      const outA = stepEstimator(rtA, measureFromState(netA), netA.seed);
      const outB = stepEstimator(rtB, measureFromState(netB), netB.seed);
      expect(outA.estimated).toEqual(outB.estimated);
    }
  });
});

describe('辅助导出', () => {
  it('estimatorCoverage 返回每维度可观测性', async () => {
    const { estimatorCoverage } = await import('../src/server/estimatorRuntime');
    const full = estimatorCoverage({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    expect(full.every((f) => f.observed)).toBe(true);
    const partial = estimatorCoverage({ doLevel: 2 });
    expect(partial.filter((f) => f.observed)).toHaveLength(1);
  });

  it('toObservation 把仿真状态映射成标定观测', async () => {
    const { toObservation } = await import('../src/server/estimatorRuntime');
    const net = makeNet();
    const obs = toObservation(net);
    for (const k of ['cod', 'ss', 'nh', 'tn'] as const) {
      expect(Number.isFinite(obs[k])).toBe(true);
    }
  });

  it('createEstimatorRuntime 合并自定义配置', async () => {
    const { createEstimatorRuntime } = await import('../src/server/estimatorRuntime');
    const rt = createEstimatorRuntime(
      { doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 },
      { enabled: true, applyCorrection: false, noiseSigma: { doLevel: 0.5 } },
    );
    expect(rt.config.enabled).toBe(true);
    expect(rt.config.applyCorrection).toBe(false);
    expect(rt.config.noiseSigma.doLevel).toBe(0.5);
    // Partial<...> 展开后未覆盖的键是 undefined（按需读取时回退 DEFAULT）
    expect(rt.config.noiseSigma.mlss).toBeUndefined();
  });
});

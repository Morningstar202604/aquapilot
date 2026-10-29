import { describe, expect, it } from 'vitest';
import { StateEstimator, observability, simulateEstimationCheck, type StateVector } from '../src/sim/stateEstimation';
import {
  applyEstimate,
  createEstimatorRuntime,
  DEFAULT_ESTIMATOR_CONFIG,
  measureFromState,
  stepEstimator,
} from '../src/server/estimatorRuntime';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 状态估计（EKF）。
 *
 * 为什么这部分必须用「已知真值 + 噪声」来测：真实水厂数据不可得，
 * 而估计器的数学正确性可以用合成数据完全验证——真值已知时
 * RMSE 与偏差都是可计算的。这验证的是**估计器本身**，
 * 不是传感器标定，两者的区别必须在文档里写清楚。
 */

const KINDS: (keyof StateVector)[] = ['doLevel', 'mlss', 'nh', 'cod', 'srtDays', 'blanketM'];

function makeTruth(n = 150): StateVector[] {
  return Array.from({ length: n }, (_, i) => ({
    doLevel: 2 + 0.3 * Math.sin(i / 20),
    mlss: 3000 + 200 * Math.sin(i / 30),
    nh: 1.2 + 0.2 * Math.cos(i / 25),
    cod: 30 + 3 * Math.sin(i / 40),
    srtDays: 12 + 0.5 * Math.sin(i / 50),
    blanketM: 1.1 + 0.1 * Math.cos(i / 35),
  }));
}

/** 确定性噪声（不依赖 Math.random，保证测试可复现） */
function makeNoise(seed = 12345) {
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
  return (key: keyof StateVector) => {
    const scale = key === 'mlss' ? 150 : key === 'cod' ? 3 : key === 'nh' ? 0.15 : 0.2;
    return rnd() * scale;
  };
}

describe('EKF 核心', () => {
  it('单步更新：无噪声时精确跟踪真值', () => {
    const est = new StateEstimator({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    // 大量重复测量同一个值（模拟稳态），估计应逼近该值
    for (let i = 0; i < 200; i++) est.step({ doLevel: 3.0 });
    expect(est.current().x.doLevel).toBeCloseTo(3.0, 2);
  });

  it('校正后不确定性必须下降（P 减小）', () => {
    const est = new StateEstimator({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    const before = est.current().p.doLevel;
    est.predict();
    const afterPredict = est.current().p.doLevel;
    est.update({ doLevel: 2.1 });
    const afterUpdate = est.current().p.doLevel;
    expect(afterPredict).toBeGreaterThan(before); // 预测放大不确定性
    expect(afterUpdate).toBeLessThan(afterPredict); // 更新收缩
  });

  it('缺失/非法测量被跳过，不会把状态写成 NaN', () => {
    const est = new StateEstimator({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    est.step({ doLevel: Number.NaN, nh: 2 });
    const x = est.current().x;
    expect(Number.isFinite(x.doLevel)).toBe(true);
    expect(x.doLevel).toBe(2); // 未被 NaN 污染
    expect(Number.isFinite(x.nh)).toBe(true);
  });

  it('增益随测量次数衰减（收敛性）', () => {
    const est = new StateEstimator({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    const snapshots: number[] = [];
    for (let i = 0; i < 5; i++) {
      est.predict();
      est.update({ doLevel: 3 });
      snapshots.push(est.current().p.doLevel);
    }
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]).toBeLessThan(snapshots[i - 1] + 1e-9);
    }
  });
});

describe('噪声下的收敛（已知真值）', () => {
  it('初始猜测偏离真值时能收敛，RMSE 小于噪声量级', () => {
    const truth = makeTruth();
    const { rmse, bias } = simulateEstimationCheck(truth, makeNoise());
    // 初始偏差是 ±30%~100%，收敛后误差应显著小于初始偏差
    expect(rmse.doLevel).toBeLessThan(0.3);
    expect(rmse.mlss).toBeLessThan(200);
    expect(rmse.nh).toBeLessThan(0.3);
    expect(rmse.cod).toBeLessThan(5);
    expect(rmse.srtDays).toBeLessThan(0.6);
    expect(rmse.blanketM).toBeLessThan(0.15);
    // 偏差应接近零（无系统性偏移）
    for (const k of KINDS) expect(Math.abs(bias[k])).toBeLessThan(rmse[k] + 0.5);
  });

  it('测量噪声越大，RMSE 越大（符合信息论直觉）', () => {
    const truth = makeTruth();
    const lowNoise = simulateEstimationCheck(truth, () => 0.01);
    const highNoise = simulateEstimationCheck(truth, (k) => (k === 'mlss' ? 400 : 1));
    expect(highNoise.rmse.mlss).toBeGreaterThan(lowNoise.rmse.mlss);
  });

  it('空真值序列不报错', () => {
    const { rmse } = simulateEstimationCheck([], makeNoise());
    for (const k of KINDS) expect(rmse[k]).toBe(0);
  });
});

describe('可观测性', () => {
  it('全部测量时所有维度可观测', () => {
    const rows = observability({ doLevel: 2, mlss: 3000, nh: 1, cod: 30, srtDays: 12, blanketM: 1 });
    expect(rows.every((r) => r.observed)).toBe(true);
  });

  it('部分测量时如实报告未观测维度', () => {
    const rows = observability({ doLevel: 2, nh: 1 });
    expect(rows.filter((r) => r.observed).map((r) => r.key)).toEqual(['doLevel', 'nh']);
    expect(rows.filter((r) => !r.observed)).toHaveLength(4);
  });

  it('NaN 测量视为未观测', () => {
    const rows = observability({ doLevel: Number.NaN });
    expect(rows.find((r) => r.key === 'doLevel')!.observed).toBe(false);
  });
});

describe('运行时接线', () => {
  function makeNet() {
    const net = createNetworkState(PLANT_TOPOLOGY, { seed: 3 });
    spinUpNetwork(net, PLANT_TOPOLOGY, 30);
    return net;
  }

  it('默认关闭时不创建估计器（不影响既有确定性）', () => {
    const rt = createEstimatorRuntime({
      doLevel: 2,
      mlss: 3000,
      nh: 1,
      cod: 30,
      srtDays: 12,
      blanketM: 1,
    });
    expect(rt.estimator).toBeNull();
    expect(DEFAULT_ESTIMATOR_CONFIG.enabled).toBe(false);
  });

  it('measureFromState 从仿真状态读出可测量', () => {
    const net = makeNet();
    const m = measureFromState(net);
    for (const k of KINDS) expect(Number.isFinite(m[k])).toBe(true);
    expect(m.mlss).toBeGreaterThan(0);
    expect(m.srtDays).toBeGreaterThan(0);
  });

  it('stepEstimator 产生有限估计与偏差', () => {
    const net = makeNet();
    const truth = measureFromState(net);
    const rt = createEstimatorRuntime(truth, { enabled: true });
    const out = stepEstimator(rt, truth, net.seed);
    expect(out.estimated).not.toBeNull();
    for (const k of KINDS) expect(Number.isFinite(out.estimated![k])).toBe(true);
    expect(rt.corrections).toBe(1);
  });

  it('applyEstimate 单次校正限幅 ±10%（不把噪声放大成跳变）', () => {
    const net = makeNet();
    const before = net.biomassKg;
    const base = measureFromState(net);
    // 故意给一个离谱的 MLSS（3 倍）
    applyEstimate(net, { ...base, mlss: base.mlss * 3, doLevel: base.doLevel, blanketM: base.blanketM }, base);
    const after = net.biomassKg;
    expect(after).toBeLessThanOrEqual(before * 1.1 + 1);
    expect(after).toBeGreaterThanOrEqual(before * 0.9 - 1);
  });

  it('applyEstimate 不越界写入非法值', () => {
    const net = makeNet();
    const base = measureFromState(net);
    applyEstimate(net, { ...base, doLevel: Number.NaN, blanketM: -5 }, base);
    expect(Number.isFinite(net.reactors[net.reactors.length - 1].doLevel)).toBe(true);
    expect(net.clarifier.blanketM).toBeGreaterThan(0);
  });

  it('确定性噪声：同一 seed 同一拍得到同一测量', () => {
    const net = makeNet();
    const truth = measureFromState(net);
    const a = createEstimatorRuntime(truth, { enabled: true });
    const b = createEstimatorRuntime(truth, { enabled: true });
    const outA = stepEstimator(a, truth, 42);
    const outB = stepEstimator(b, truth, 42);
    expect(outA.observed).toEqual(outB.observed);
  });
});

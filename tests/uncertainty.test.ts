import { describe, expect, it } from 'vitest';
import {
  calibrate,
  type CalibrationDataset,
  type CalibratableParam,
  type DatasetPrediction,
} from '../src/sim/calibration';
import { ASM1_PARAMS, type Asm1Params } from '../src/sim/asm1';
import { mulberry32, type Rng } from '../src/sim/rng';
import {
  analyzeUncertainty,
  assessSufficiency,
  auditMassBalance,
  CalibrationError,
  countObservations,
  monteCarloPrediction,
  type UncertaintyResult,
} from '../src/sim/uncertainty';

/**
 * WP5 不确定性测试：真值恢复、区间覆盖、相关矩阵、蒙特卡洛分位数、
 * 充分性错误码、质量平衡审计。
 *
 * 全部使用解析代理模型（单次求值 O(1)），不跑 BSM1 稳态仿真；
 * 区间与分位数都来自实际自助重抽样 / 蒙特卡洛抽样，不是解析近似。
 */

const TRUTH = { mu_A: 1.1, K_NH: 1.6, b_H: 0.55 };
const FITTED: CalibratableParam[] = ['mu_A', 'K_NH', 'b_H'];

/** 代理（参数正交）：NH 由 mu_A 决定；剖面 NO3 由 K_NH 决定；COD/TN 由 b_H 决定 */
function proxyFull(p: Asm1Params): DatasetPrediction {
  return {
    effluent: {
      nh: 3 / p.mu_A,
      cod: 24 + (p.b_H - 0.62) * 14,
      ss: 8,
      tn: 11 + (p.b_H - 0.62) * 5,
      tp: 2,
    },
    profiles: [
      { reactorId: 'aer1', do: 2.0, nh: 2.5 / p.mu_A, no3: 8 - p.K_NH * 1.5, mlss: 3000 },
      { reactorId: 'aer2', do: 1.5, nh: 2.0 / p.mu_A, no3: 7.5 - p.K_NH * 1.5, mlss: 2800 },
    ],
  };
}

function noisy(value: number, rng: Rng, relSd: number): number {
  return Math.max(value * (1 + rng.normal() * relSd), 1e-3);
}

function makeDataset(seed: number, relSd: number): CalibrationDataset {
  const rng = mulberry32(seed);
  const pred = proxyFull({ ...ASM1_PARAMS, ...TRUTH });
  const effluent = {
    cod: noisy(pred.effluent.cod, rng, relSd),
    ss: noisy(pred.effluent.ss, rng, relSd),
    nh: noisy(pred.effluent.nh, rng, relSd),
    tn: noisy(pred.effluent.tn, rng, relSd),
    tp: noisy(pred.effluent.tp ?? 2, rng, relSd),
  };
  const profiles = (pred.profiles ?? []).map((prof) => ({
    reactorId: prof.reactorId,
    do: noisy(prof.do ?? 2, rng, relSd),
    nh: noisy(prof.nh ?? 2, rng, relSd),
    no3: noisy(prof.no3 ?? 8, rng, relSd),
    mlss: noisy(prof.mlss ?? 3000, rng, relSd),
    tp: noisy(prof.tp ?? 2, rng, relSd),
  }));
  return { effluent, profiles };
}

async function fitPoint(dataset: CalibrationDataset): Promise<Asm1Params> {
  const start = { ...ASM1_PARAMS, mu_A: 0.6, K_NH: 0.8, b_H: 0.9 };
  const result = await calibrate(proxyFull, dataset, {
    baseParams: start,
    maxIterations: 3,
    onlyIdentifiable: false,
  });
  return result.params;
}

describe('合成真值恢复', () => {
  it('点估计落在真值 ±20% 以内', async () => {
    const dataset = makeDataset(42, 0.03);
    const point = await fitPoint(dataset);
    for (const param of FITTED) {
      const truth = TRUTH[param as keyof typeof TRUTH];
      const rel = Math.abs(point[param] - truth) / truth;
      expect(rel).toBeLessThan(0.2);
    }
  });
});

describe('区间覆盖（残差自助法）', () => {
  it('20 次重复中 90% 区间覆盖真值 ≥ 14 次', async () => {
    const repeats = 20;
    let covered = 0;
    const coverages: number[] = [];

    for (let i = 0; i < repeats; i += 1) {
      const dataset = makeDataset(100 + i, 0.03);
      const point = await fitPoint(dataset);
      const uncertainty = await analyzeUncertainty(proxyFull, dataset, point, {
        fittedParams: FITTED,
        bootstrapSamples: 30,
        seed: 1000 + i,
      });
      const muA = uncertainty.intervals.find((r) => r.param === 'mu_A')!;
      const inside = TRUTH.mu_A >= muA.p10 && TRUTH.mu_A <= muA.p90;
      if (inside) covered += 1;
      coverages.push(uncertainty.coverage.observations);
    }

    expect(covered).toBeGreaterThanOrEqual(14);
    // 每次重复观测点都满足充分性
    for (const n of coverages) expect(n).toBeGreaterThanOrEqual(6);
  }, 60000);
});

describe('参数相关矩阵', () => {
  it('灵敏度平行的两个参数在协方差上呈强负相关（补偿方向）', async () => {
    // 观测只含 mu_A + b_A：两列灵敏度平行，(JᵀJ)⁻¹  off-diagonal 为强负相关
    const correlatedProxy = (p: Asm1Params): DatasetPrediction => {
      const sum = p.mu_A + p.b_A;
      return {
        effluent: { nh: sum, cod: 24, ss: 8, tn: 11, tp: 2 },
        profiles: [{ reactorId: 'aer1', do: 2, nh: sum, no3: 8, mlss: 3000 }],
      };
    };
    const truthParams = { ...ASM1_PARAMS, mu_A: 0.8, b_A: 0.15 };
    const rng = mulberry32(7);
    const pred = correlatedProxy(truthParams);
    const dataset: CalibrationDataset = {
      effluent: {
        nh: noisy(pred.effluent.nh, rng, 0.03),
        cod: 24,
        ss: 8,
        tn: 11,
        tp: 2,
      },
      profiles: [{ reactorId: 'aer1', do: 2, nh: noisy(pred.profiles![0].nh!, rng, 0.03), no3: 8, mlss: 3000 }],
    };

    const uncertainty = await analyzeUncertainty(correlatedProxy, dataset, truthParams, {
      fittedParams: ['mu_A', 'b_A'],
      bootstrapSamples: 30,
      seed: 11,
    });

    const idxA = uncertainty.correlation.params.indexOf('mu_A');
    const idxB = uncertainty.correlation.params.indexOf('b_A');
    const r = uncertainty.correlation.matrix[idxA][idxB];
    expect(Math.abs(r)).toBeGreaterThan(0.5);
    // 平行灵敏度在 Fisher 逆协方差上表现为补偿方向：一升一降，相关系数为负
    expect(r).toBeLessThan(0);
  }, 30000);
});

describe('蒙特卡洛预测不确定性', () => {
  async function uncertaintyFor(
    relSd: number,
    seed: number,
  ): Promise<{ uncertainty: UncertaintyResult; point: Asm1Params }> {
    const dataset = makeDataset(seed, relSd);
    const point = await fitPoint(dataset);
    const uncertainty = await analyzeUncertainty(proxyFull, dataset, point, {
      fittedParams: FITTED,
      bootstrapSamples: 30,
      seed: seed + 500,
    });
    return { uncertainty, point };
  }

  it('P10 < P50 < P90，分位数由样本排序得出', async () => {
    const { uncertainty, point } = await uncertaintyFor(0.03, 42);
    const prediction = monteCarloPrediction(uncertainty.intervals, point, proxyFull, {
      samples: 50,
      seed: 7,
    });
    for (const metric of ['cod', 'nh', 'tn', 'tp'] as const) {
      const band = prediction.bands[metric];
      expect(band.p10).toBeLessThanOrEqual(band.p50);
      expect(band.p50).toBeLessThanOrEqual(band.p90);
      expect(Number.isFinite(band.p10)).toBe(true);
      expect(Number.isFinite(band.p90)).toBe(true);
    }
    expect(prediction.samples).toBe(50);
  });

  it('噪声增大时预测区间变宽', async () => {
    const low = await uncertaintyFor(0.02, 42);
    const high = await uncertaintyFor(0.1, 43);
    const lowPred = monteCarloPrediction(low.uncertainty.intervals, low.point, proxyFull, { samples: 50, seed: 7 });
    const highPred = monteCarloPrediction(high.uncertainty.intervals, high.point, proxyFull, { samples: 50, seed: 7 });
    const lowWidth = lowPred.bands.nh.p90 - lowPred.bands.nh.p10;
    const highWidth = highPred.bands.nh.p90 - highPred.bands.nh.p10;
    expect(highWidth).toBeGreaterThan(lowWidth);
  }, 30000);
});

describe('数据充分性判定', () => {
  it('只有出水、没有剖面 → CALIBRATION_INSUFFICIENT_DATA', async () => {
    const dataset: CalibrationDataset = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
    };
    await expect(
      analyzeUncertainty(proxyFull, dataset, ASM1_PARAMS, { fittedParams: FITTED, bootstrapSamples: 10 }),
    ).rejects.toMatchObject({ code: 'CALIBRATION_INSUFFICIENT_DATA' });
  });

  it('观测点少于参数数 × 2 → CALIBRATION_INSUFFICIENT_DATA', async () => {
    const dataset: CalibrationDataset = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
      profiles: [{ reactorId: 'aer1', mlss: 3000 }],
    };
    expect(countObservations(dataset)).toBeLessThan(FITTED.length * 2);
    const report = assessSufficiency(dataset, FITTED.length);
    expect(report.sufficient).toBe(false);
    await expect(
      analyzeUncertainty(proxyFull, dataset, ASM1_PARAMS, { fittedParams: FITTED, bootstrapSamples: 10 }),
    ).rejects.toBeInstanceOf(CalibrationError);
  });
});

describe('质量平衡审计', () => {
  it('按行给出残差百分比与告警，超阈值不抛错', () => {
    const rows = auditMassBalance(
      [
        // 残差 5 kg / 100 = 5.0%，阈值 5% 时不告警（严格大于）
        { substance: 'COD', inflowKg: 100, outflowKg: 60, wasteSludgeKg: 20, transformedKg: 15, inventoryChangeKg: 0 },
        // 残差 1 kg / 12 ≈ 8.33% → 告警
        { substance: 'N', inflowKg: 12, outflowKg: 5, wasteSludgeKg: 2, transformedKg: 4, inventoryChangeKg: 0 },
        // 库存变化为负（期末库存下降）也能闭合
        {
          substance: 'P',
          inflowKg: 4,
          outflowKg: 1.5,
          wasteSludgeKg: 1.0,
          transformedKg: 2.5,
          inventoryChangeKg: -1.0,
        },
      ],
      5,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].alert).toBe(false);
    expect(rows[0].residualKg).toBeCloseTo(5, 10);
    expect(rows[0].residualPct).toBeCloseTo(5, 1);
    expect(rows[1].alert).toBe(true);
    expect(rows[1].residualPct).toBeGreaterThan(5);
    expect(rows[2].alert).toBe(false);
    expect(rows[2].residualKg).toBeCloseTo(0, 10);
  });

  it('非有限台账不抛错，直接标告警', () => {
    const rows = auditMassBalance([
      {
        substance: 'COD',
        inflowKg: Number.NaN,
        outflowKg: 0,
        wasteSludgeKg: 0,
        transformedKg: 0,
        inventoryChangeKg: 0,
      },
    ]);
    expect(rows[0].alert).toBe(true);
  });
});

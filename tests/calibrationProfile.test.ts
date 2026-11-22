import { describe, expect, it } from 'vitest';
import {
  objective,
  objectiveBreakdown,
  normalizePredictor,
  type CalibrationDataset,
  type EffluentObservation,
  type Predictor,
} from '../src/sim/calibration';
import { ASM1_PARAMS, type Asm1Params } from '../src/sim/asm1';
import { calibrationRoute, type CalibrationRouteInput } from '../src/server/routes/calibration';
import type { UncertaintyResult } from '../src/sim/uncertainty';

/**
 * WP5 剖面观测与路由契约测试。
 *
 * 与 tests/calibration.test.ts 相同：用解析代理模型，不跑 BSM1 稳态仿真。
 */

const proxyPredict: Predictor = (p: Asm1Params): EffluentObservation => ({
  nh: 6 / p.mu_A + p.K_NH * 0.35,
  cod: 22 + (p.b_H - 0.62) * 18 + p.K_S * 0.06,
  ss: 8 + (p.k_h - 3) * 0.4,
  tn: 10 + (p.b_H - 0.62) * 6,
});

function profileDataset(): CalibrationDataset {
  return {
    effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
    profiles: [
      { reactorId: 'aer1', do: 2.0, nh: 2.0, no3: 8, mlss: 3000, tp: 2 },
      { reactorId: 'aer2', do: 1.5, nh: 1.6, no3: 7, mlss: 2800, tp: 1.8 },
    ],
  };
}

describe('剖面目标函数', () => {
  it('残差按出水/剖面分组输出', () => {
    const dataset = profileDataset();
    const predicted = {
      effluent: { cod: 26, ss: 8, nh: 1.5, tn: 10 },
      profiles: [
        { reactorId: 'aer1', do: 2.0, nh: 2.4, no3: 8, mlss: 3300, tp: 2 },
        { reactorId: 'aer2', do: 1.5, nh: 1.6, no3: 7, mlss: 2800, tp: 1.8 },
      ],
    };
    const breakdown = objectiveBreakdown(dataset, predicted);
    const effluentRows = breakdown.rows.filter((r) => r.group === 'effluent');
    const profileRows = breakdown.rows.filter((r) => r.group === 'profile');
    expect(effluentRows.length).toBeGreaterThan(0);
    expect(profileRows.length).toBeGreaterThan(0);
    expect(breakdown.effluentObjective).toBeGreaterThanOrEqual(0);
    expect(breakdown.profileObjective).toBeGreaterThan(0);
    expect(breakdown.total).toBeCloseTo(breakdown.effluentObjective + breakdown.profileObjective, 10);
  });

  it('量程归一化：MLSS 大残差不压过 NH 小残差', () => {
    const dataset: CalibrationDataset = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
      profiles: [{ reactorId: 'aer1', do: 2, nh: 2.0, no3: 8, mlss: 3000 }],
    };
    // MLSS +10%（300 mg/L），NH +50%（1 mg/L）
    const predicted = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
      profiles: [{ reactorId: 'aer1', do: 2, nh: 3.0, no3: 8, mlss: 3300 }],
    };
    const breakdown = objectiveBreakdown(dataset, predicted);
    const nhRow = breakdown.rows.find((r) => r.metric === 'nh' && r.group === 'profile');
    const mlssRow = breakdown.rows.find((r) => r.metric === 'mlss');
    expect(nhRow).toBeDefined();
    expect(mlssRow).toBeDefined();
    // NH 归一化残差 1/5=0.2；MLSS 归一化残差 300/3000=0.1
    expect(Math.abs(nhRow!.normalized)).toBeGreaterThan(Math.abs(mlssRow!.normalized));
  });

  it('旧 CalibrationTarget 调用路径行为不变', () => {
    const target = { observed: { cod: 30, ss: 8, nh: 1.5, tn: 10 } };
    const predicted: EffluentObservation = { cod: 33, ss: 8, nh: 1.5, tn: 10 };
    // 旧口径：相对误差 0.1，平方 0.01
    expect(objective(target, predicted)).toBeCloseTo(0.01, 10);
    const breakdown = objectiveBreakdown(target, predicted);
    expect(breakdown.profileObjective).toBe(0);
    expect(breakdown.rows.every((r) => r.group === 'effluent')).toBe(true);
  });

  it('normalizePredictor 把旧预测器包装成全量预测器', () => {
    const wrapped = normalizePredictor(proxyPredict);
    const out = wrapped(ASM1_PARAMS);
    expect(out.effluent.nh).toBeCloseTo(proxyPredict(ASM1_PARAMS).nh, 10);
    expect(out.profiles).toBeUndefined();
  });

  it('剖面缺测字段跳过，不补零参与拟合', () => {
    const dataset: CalibrationDataset = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
      profiles: [{ reactorId: 'aer1', mlss: 3000 }],
    };
    const predicted = {
      effluent: { cod: 25, ss: 8, nh: 1.5, tn: 10 },
      profiles: [{ reactorId: 'aer1', mlss: 3100 }],
    };
    const breakdown = objectiveBreakdown(dataset, predicted);
    const profileMetrics = breakdown.rows.filter((r) => r.group === 'profile').map((r) => r.metric);
    expect(profileMetrics).toContain('mlss');
    expect(profileMetrics).not.toContain('do');
    expect(profileMetrics).not.toContain('nh');
  });
});

function okUncertainty(): UncertaintyResult {
  return {
    code: 'OK',
    identifiable: true,
    reasons: [],
    intervals: [
      { param: 'mu_A', estimate: 1.1, p10: 0.95, p90: 1.25, standardError: 0.09, atBound: false, flat: false },
    ],
    correlation: { params: ['mu_A'], matrix: [[1]] },
    coverage: { observations: 15, minRequired: 6, hasProfiles: true, sufficient: true, reasons: [] },
    bootstrapSamples: 30,
    confidence: 0.9,
    seed: 1,
    dataSource: 'synthetic',
    residuals: [],
  };
}

describe('标定不确定性路由', () => {
  const path = '/api/calibration/uncertainty';

  it('无标定结果 → 409 CALIBRATION_INSUFFICIENT_DATA', () => {
    const input: CalibrationRouteInput = { uncertainty: null, predictions: null, dataSource: 'synthetic' };
    const reply = calibrationRoute(path, new URL('http://localhost/api/calibration/uncertainty'), input);
    expect(reply?.status).toBe(409);
    expect((reply?.body as { code: string }).code).toBe('CALIBRATION_INSUFFICIENT_DATA');
  });

  it('不可辨识 → 409 CALIBRATION_NOT_IDENTIFIABLE 并带原因', () => {
    const notIdentifiable: UncertaintyResult = {
      ...okUncertainty(),
      code: 'CALIBRATION_NOT_IDENTIFIABLE',
      identifiable: false,
      reasons: ['参数 mu_A 区间过宽（相对宽度 > 0.6），数据约束平坦'],
    };
    const input: CalibrationRouteInput = { uncertainty: notIdentifiable, predictions: null, dataSource: 'synthetic' };
    const reply = calibrationRoute(path, new URL('http://localhost/api/calibration/uncertainty'), input);
    expect(reply?.status).toBe(409);
    const body = reply?.body as { code: string; reasons: string[] };
    expect(body.code).toBe('CALIBRATION_NOT_IDENTIFIABLE');
    expect(body.reasons).toHaveLength(1);
  });

  it('正常返回区间、相关矩阵、预测区间与 dataSource', () => {
    const input: CalibrationRouteInput = {
      uncertainty: okUncertainty(),
      predictions: {
        samples: 50,
        seed: 7,
        bands: {
          cod: { p10: 22, p50: 25, p90: 28 },
          nh: { p10: 1.0, p50: 1.4, p90: 1.9 },
          tn: { p10: 9, p50: 10, p90: 11 },
          tp: { p10: 1.6, p50: 2.0, p90: 2.4 },
        },
      },
      dataSource: 'synthetic',
    };
    const reply = calibrationRoute(path, new URL('http://localhost/api/calibration/uncertainty'), input);
    expect(reply?.status).toBe(200);
    const body = reply?.body as {
      dataSource: string;
      intervals: unknown[];
      correlation: { params: string[] };
      predictions: { samples: number };
    };
    expect(body.dataSource).toBe('synthetic');
    expect(body.intervals).toHaveLength(1);
    expect(body.correlation.params).toEqual(['mu_A']);
    expect(body.predictions?.samples).toBe(50);
  });

  it('param 查询参数过滤区间', () => {
    const input: CalibrationRouteInput = { uncertainty: okUncertainty(), predictions: null, dataSource: 'synthetic' };
    const reply = calibrationRoute(path, new URL('http://localhost/api/calibration/uncertainty?param=mu_A'), input);
    expect(reply?.status).toBe(200);
    expect((reply?.body as { intervals: { param: string }[] }).intervals).toHaveLength(1);
  });

  it('未知 param → 400', () => {
    const input: CalibrationRouteInput = { uncertainty: okUncertainty(), predictions: null, dataSource: 'synthetic' };
    const reply = calibrationRoute(
      path,
      new URL('http://localhost/api/calibration/uncertainty?param=not_a_param'),
      input,
    );
    expect(reply?.status).toBe(400);
  });

  it('to<from → 400', () => {
    const input: CalibrationRouteInput = { uncertainty: okUncertainty(), predictions: null, dataSource: 'synthetic' };
    const reply = calibrationRoute(path, new URL('http://localhost/api/calibration/uncertainty?from=100&to=50'), input);
    expect(reply?.status).toBe(400);
  });

  it('不匹配的路径返回 null', () => {
    const input: CalibrationRouteInput = { uncertainty: null, predictions: null, dataSource: 'synthetic' };
    expect(calibrationRoute('/api/other', new URL('http://localhost/api/other'), input)).toBeNull();
  });
});

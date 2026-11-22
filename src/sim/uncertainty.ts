/**
 * WP5 标定不确定性：参数区间、相关矩阵、可辨识性判定、蒙特卡洛预测区间、
 * 质量平衡审计。
 *
 * 方法选择（写清算法，不拍脑袋给区间）：
 * - 参数区间用 **残差自助法（residual bootstrap）**：先在数据上做点估计，
 *   取出逐行残差；每次自助重抽样残差、重构观测、重新做有界坐标下降拟合，
 *   收集 B 组参数样本，区间由样本分位数给出（90% 区间 = P10/P90），
 *   标准误为样本标准差。所有随机数走固定 seed 的 mulberry32，同 seed 可复现。
 * - 参数相关矩阵由标定解处灵敏度矩阵的 Gauss-Newton 协方差导出
 *   （相关系数，不是协方差）；平行灵敏度表现为强补偿负相关。
 * - 可辨识性：区间贴边界、区间过宽（平坦）、参数对 |r|>0.95 任一命中即判
 *   不可辨识，错误码 CALIBRATION_NOT_IDENTIFIABLE。
 * - 预测不确定性：蒙特卡洛从参数区间抽样（截断到物理边界），逐条预测出水，
 *   P10/P50/P90 由样本排序得出，不做解析近似。
 *
 * 现场边界（如实标注）：没有真实历史数据时，本模块只能在合成数据上验证
 * 算法正确性；输出里 dataSource 标为 'synthetic'，不是这座厂的置信区间。
 */

import { quantile } from './quantile';
import type { Asm1Params } from './asm1';
import {
  CALIBRATABLE_PARAMS,
  PARAM_BOUNDS,
  normalizePredictor,
  objectiveBreakdown,
  type CalibrationDataset,
  type CalibratableParam,
  type DatasetPrediction,
  type DatasetPredictor,
  type Predictor,
  type ProfileObservation,
  type ResidualRow,
} from './calibration';
import { mulberry32, type Rng } from './rng';

export type CalibrationErrorCode = 'CALIBRATION_INSUFFICIENT_DATA' | 'CALIBRATION_NOT_IDENTIFIABLE';

export class CalibrationError extends Error {
  readonly code: CalibrationErrorCode;

  constructor(code: CalibrationErrorCode, message: string) {
    super(message);
    this.name = 'CalibrationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 数据充分性
// ---------------------------------------------------------------------------

/** 观测点计数：出水每个有限指标算 1 点，剖面每个有限测量算 1 点 */
export function countObservations(dataset: CalibrationDataset): number {
  let n = 0;
  const eff = dataset.effluent;
  for (const m of ['cod', 'ss', 'nh', 'tn', 'tp'] as const) {
    if (eff[m] !== undefined && Number.isFinite(eff[m])) n += 1;
  }
  for (const prof of dataset.profiles ?? []) {
    for (const m of ['do', 'nh', 'no3', 'mlss', 'tp', 'po4'] as const) {
      const v = prof[m];
      if (v !== undefined && Number.isFinite(v)) n += 1;
    }
  }
  return n;
}

export interface SufficiencyReport {
  observations: number;
  minRequired: number;
  hasProfiles: boolean;
  sufficient: boolean;
  reasons: string[];
}

/**
 * 充分性判据（契约 WP5）：
 * - 剖面为空、只有出水 → 数据不足（出水 4 项约束不了池内动力学）；
 * - 观测点少于「参与拟合参数数 × 2」→ 数据不足。
 * 数据不足时不得返回点估计冒充标定完成。
 */
export function assessSufficiency(dataset: CalibrationDataset, fittedCount: number): SufficiencyReport {
  const observations = countObservations(dataset);
  const minRequired = fittedCount * 2;
  const hasProfiles = (dataset.profiles ?? []).length > 0;
  const reasons: string[] = [];
  if (!hasProfiles) reasons.push('缺少池内剖面观测：仅靠出水指标无法约束池内动力学参数');
  if (observations < minRequired) {
    reasons.push(`观测点 ${observations} 少于参数数 × 2（${minRequired}），参数无法被数据约束`);
  }
  return { observations, minRequired, hasProfiles, sufficient: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 自助重拟合内部工具
// ---------------------------------------------------------------------------

function clampToBound(param: CalibratableParam, v: number): number {
  const b = PARAM_BOUNDS[param];
  if (!Number.isFinite(v)) return b.min;
  return Math.min(b.max, Math.max(b.min, v));
}

/** 单坐标细粒度线搜索（三分搜索），返回更优值与其目标值 */
function lineSearch(
  predict: DatasetPredictor,
  dataset: CalibrationDataset,
  current: Asm1Params,
  param: CalibratableParam,
  currentJ: number,
): { value: number; j: number } {
  const bounds = PARAM_BOUNDS[param];
  let lo = bounds.min;
  let hi = bounds.max;
  const evalAt = (v: number): number => objectiveBreakdown(dataset, predict({ ...current, [param]: v })).total;

  for (let k = 0; k < 10; k += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const j1 = evalAt(m1);
    const j2 = evalAt(m2);
    if (!Number.isFinite(j1) && !Number.isFinite(j2)) break;
    if (j1 < j2) hi = m2;
    else lo = m1;
  }
  const best = (lo + hi) / 2;
  const j = evalAt(best);
  if (Number.isFinite(j) && j < currentJ - 1e-12) return { value: best, j };
  return { value: current[param], j: currentJ };
}

/**
 * 有界坐标下降重拟合（自助样本用）。
 *
 * 与 `calibrate()` 同一套有界坐标下降思路，但每坐标用三分搜索做细粒度
 * 线搜索：自助扰动是噪声量级的小偏移，五点几何步长追不上会让抽样塌缩
 * 到点估计、区间变成装饰。只在给定参数集上跑、同步执行。
 */
function refitPoint(
  predict: DatasetPredictor,
  dataset: CalibrationDataset,
  start: Asm1Params,
  fitted: CalibratableParam[],
  rounds: number,
  rng?: Rng,
): Asm1Params {
  let current = { ...start };
  let currentJ = objectiveBreakdown(dataset, predict(current)).total;

  for (let round = 0; round < rounds; round += 1) {
    let improved = false;
    // 随机化坐标顺序：近退化方向上，先拟合哪个参数会决定偏差落到谁身上；
    // 固定顺序会让偏差被第一个参数独占，相关矩阵被优化器偏置污染。
    const order = [...fitted];
    if (rng) {
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng.next() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    for (const param of order) {
      const { value, j } = lineSearch(predict, dataset, current, param, currentJ);
      if (value !== current[param]) {
        current = { ...current, [param]: value };
        currentJ = j;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return current;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

/** 小方阵求逆（Gauss-Jordan）；奇异时返回 null */
function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const aug = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const piv = aug[col][col];
    for (let j = 0; j < 2 * n; j += 1) aug[col][j] /= piv;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let j = 0; j < 2 * n; j += 1) aug[r][j] -= factor * aug[col][j];
    }
  }
  return aug.map((row) => row.slice(n));
}

function rowKey(row: ResidualRow): string {
  return `${row.group}:${row.reactorId ?? ''}:${row.metric}`;
}

/**
 * 标定解处的灵敏度矩阵 S（观测行 × 参数），元素为归一化残差对参数的
 * 中心差分灵敏度。相关矩阵由 Gauss-Newton 协方差 C = (S·Sᵀ)⁻¹ 导出：
 * 两列灵敏度平行（参数不可区分）时，C 的非对角项为强负相关——这是
 * 补偿方向：一个参数上升必须由另一个下降来抵消，|r| 越大越不可区分。
 *
 * 不用自助样本算相关：近退化方向上重拟合会塌缩到同一特解，抽样方差
 * 接近零，相关系数被优化器顺序偏置污染；局部灵敏度矩阵在解处直接
 * 反映参数方向是否可区分。
 */
function sensitivityCorrelation(
  predict: DatasetPredictor,
  dataset: CalibrationDataset,
  point: Asm1Params,
  fitted: CalibratableParam[],
): CorrelationMatrix {
  const baseRows = objectiveBreakdown(dataset, predict(point)).rows;
  const n = baseRows.length;
  const S: number[][] = fitted.map(() => new Array<number>(n).fill(0));

  for (let c = 0; c < fitted.length; c += 1) {
    const param = fitted[c];
    const v = point[param];
    const delta = Math.max(Math.abs(v) * 0.02, 1e-6);
    const up = clampToBound(param, v + delta);
    const down = clampToBound(param, v - delta);
    const rowsUp = objectiveBreakdown(dataset, predict({ ...point, [param]: up })).rows;
    const rowsDown = objectiveBreakdown(dataset, predict({ ...point, [param]: down })).rows;
    for (let i = 0; i < n; i += 1) {
      const key = rowKey(baseRows[i]);
      const ru = rowsUp.find((r) => rowKey(r) === key);
      const rd = rowsDown.find((r) => rowKey(r) === key);
      const du = ru?.normalized ?? baseRows[i].normalized;
      const dd = rd?.normalized ?? baseRows[i].normalized;
      S[c][i] = (du - dd) / Math.max(up - down, 1e-9);
    }
  }

  const p = fitted.length;
  const F: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += S[i][k] * S[j][k];
      return sum + (i === j ? 1e-8 : 0);
    }),
  );
  const C = invertMatrix(F);
  const matrix: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      if (i === j) return 1;
      if (!C) return 0;
      const denom = Math.sqrt(Math.max(C[i][i] * C[j][j], 1e-12));
      return Math.max(-1, Math.min(1, C[i][j] / denom));
    }),
  );
  return { params: fitted.map((x) => x), matrix };
}

// ---------------------------------------------------------------------------
// 自助法区间与相关矩阵
// ---------------------------------------------------------------------------

export interface ParamInterval {
  param: CalibratableParam;
  /** 点估计（传入的标定结果） */
  estimate: number;
  p10: number;
  p90: number;
  standardError: number;
  /** 点估计贴在物理边界附近（5% 带宽内） */
  atBound: boolean;
  /** 区间相对宽度过大：数据对该参数近乎平坦 */
  flat: boolean;
}

export interface CorrelationMatrix {
  params: string[];
  matrix: number[][];
}

export interface UncertaintyResidual {
  group: string;
  reactorId?: string;
  metric: string;
  observed: number;
  predicted: number;
  residual: number;
}

export interface UncertaintyResult {
  code: 'OK' | 'CALIBRATION_NOT_IDENTIFIABLE';
  identifiable: boolean;
  reasons: string[];
  intervals: ParamInterval[];
  correlation: CorrelationMatrix;
  coverage: SufficiencyReport;
  bootstrapSamples: number;
  confidence: number;
  seed: number;
  dataSource: 'synthetic' | 'field';
  residuals: UncertaintyResidual[];
}

export interface UncertaintyOptions {
  /** 参与拟合的参数（标定结果的 fitted 列表） */
  fittedParams: CalibratableParam[];
  bootstrapSamples?: number;
  seed?: number;
  /** 名义置信水平，默认 0.90 */
  confidence?: number;
  dataSource?: 'synthetic' | 'field';
  /** 自助重拟合轮数，默认 2 */
  rounds?: number;
  beforeEvaluate?: () => Promise<void> | void;
  shouldCancel?: () => boolean;
}

/** 区间相对宽度超过该阈值判为平坦（数据约束不足） */
export const FLAT_RELATIVE_WIDTH = 0.6;
/** 点估计距边界带宽（相对边界跨度）小于该值判为贴边 */
export const BOUND_PROXIMITY = 0.05;
/** 相关系数绝对值超过该阈值判为强相关（不可辨识方向） */
export const STRONG_CORRELATION = 0.95;

function bootstrapDataset(
  pred0: DatasetPrediction,
  rows: ResidualRow[],
  picks: number[],
  source: CalibrationDataset,
): CalibrationDataset {
  const effluent = { ...pred0.effluent };
  rows.forEach((row, i) => {
    const r = rows[picks[i]];
    const perturbed = row.predicted + (r.observed - r.predicted);
    if (row.group === 'effluent') {
      effluent[row.metric as keyof typeof effluent] = perturbed;
    }
  });

  const profiles: ProfileObservation[] = (pred0.profiles ?? []).map((prof) => ({ ...prof }));
  rows.forEach((row, i) => {
    if (row.group !== 'profile' || row.reactorId === undefined) return;
    const r = rows[picks[i]];
    const target = profiles.find((p) => p.reactorId === row.reactorId);
    if (target) {
      (target as unknown as Record<string, number | undefined>)[row.metric] =
        row.predicted + (r.observed - r.predicted);
    }
  });

  return {
    effluent,
    profiles,
    weights: source.weights,
    timestampsMin: source.timestampsMin,
  };
}

/**
 * 残差自助法：区间、标准误、相关矩阵、可辨识性判定。
 *
 * 数据不足时抛 CalibrationError(CALIBRATION_INSUFFICIENT_DATA)，
 * 不返回一组漂亮参数冒充标定完成。
 */
export async function analyzeUncertainty(
  predict: Predictor | DatasetPredictor,
  dataset: CalibrationDataset,
  point: Asm1Params,
  options: UncertaintyOptions,
): Promise<UncertaintyResult> {
  const predictor = normalizePredictor(predict);
  const fitted = options.fittedParams.length > 0 ? options.fittedParams : [...CALIBRATABLE_PARAMS];
  const coverage = assessSufficiency(dataset, fitted.length);
  if (!coverage.sufficient) {
    throw new CalibrationError('CALIBRATION_INSUFFICIENT_DATA', coverage.reasons.join('；'));
  }

  const bootstrapSamples = options.bootstrapSamples ?? 40;
  const seed = options.seed ?? 20261123;
  const confidence = options.confidence ?? 0.9;
  const rounds = options.rounds ?? 2;
  const dataSource = options.dataSource ?? 'synthetic';
  const rng: Rng = mulberry32(seed);

  const pred0 = predictor(point);
  const breakdown = objectiveBreakdown(dataset, pred0);
  const rows = breakdown.rows;
  const residuals: UncertaintyResidual[] = rows.map((row) => ({
    group: row.group,
    reactorId: row.reactorId,
    metric: row.metric,
    observed: row.observed,
    predicted: row.predicted,
    residual: row.observed - row.predicted,
  }));

  // 自助样本：参数列
  const draws = {} as Record<CalibratableParam, number[]>;
  for (const p of fitted) draws[p] = [];

  for (let b = 0; b < bootstrapSamples; b += 1) {
    if (options.shouldCancel?.()) break;
    await options.beforeEvaluate?.();
    const sampleRng = mulberry32(seed + b * 7919);
    const picks = rows.map(() => Math.floor(rng.next() * rows.length));
    const bootDataset = bootstrapDataset(pred0, rows, picks, dataset);
    const fittedParams = refitPoint(predictor, bootDataset, point, fitted, rounds, sampleRng);
    for (const p of fitted) draws[p].push(fittedParams[p]);
  }

  const intervals: ParamInterval[] = fitted.map((param) => {
    const values = [...draws[param]].sort((a, b) => a - b);
    const estimate = point[param];
    const tail = (1 - confidence) / 2;
    const p10 = quantile(values, tail);
    const p90 = quantile(values, 1 - tail);
    const standardError = sampleStd(values);
    const bounds = PARAM_BOUNDS[param];
    const span = Math.max(bounds.max - bounds.min, 1e-9);
    const atBound =
      (estimate - bounds.min) / span < BOUND_PROXIMITY || (bounds.max - estimate) / span < BOUND_PROXIMITY;
    const flat = (p90 - p10) / Math.max(Math.abs(estimate), 1e-6) > FLAT_RELATIVE_WIDTH;
    return { param, estimate, p10, p90, standardError, atBound, flat };
  });

  // 相关矩阵：标定解处灵敏度矩阵导出的 Gauss-Newton 相关系数
  const correlation = sensitivityCorrelation(predictor, dataset, point, fitted);

  const reasons: string[] = [];
  for (const interval of intervals) {
    if (interval.atBound) reasons.push(`参数 ${interval.param} 点估计贴在物理边界上，边界外不可辨识`);
    if (interval.flat)
      reasons.push(`参数 ${interval.param} 区间过宽（相对宽度 > ${FLAT_RELATIVE_WIDTH}），数据约束平坦`);
  }
  for (let i = 0; i < fitted.length; i += 1) {
    for (let j = i + 1; j < fitted.length; j += 1) {
      const r = correlation.matrix[i][j];
      if (Math.abs(r) > STRONG_CORRELATION) {
        reasons.push(`参数 ${fitted[i]} 与 ${fitted[j]} 强相关（r=${r.toFixed(2)}），二者不能同时被数据区分`);
      }
    }
  }

  return {
    code: reasons.length === 0 ? 'OK' : 'CALIBRATION_NOT_IDENTIFIABLE',
    identifiable: reasons.length === 0,
    reasons,
    intervals,
    correlation,
    coverage,
    bootstrapSamples,
    confidence,
    seed,
    dataSource,
    residuals,
  };
}

// ---------------------------------------------------------------------------
// 蒙特卡洛预测不确定性
// ---------------------------------------------------------------------------

export type PredictionMetric = 'cod' | 'nh' | 'tn' | 'tp';

export interface PredictionBand {
  p10: number;
  p50: number;
  p90: number;
}

export interface PredictionUncertainty {
  samples: number;
  seed: number;
  bands: Record<PredictionMetric, PredictionBand>;
}

/**
 * 蒙特卡洛预测区间。
 *
 * 参数从自助区间的估计值 ± 标准误按正态抽样（截断到物理边界），逐条预测
 * 出水 COD/NH/TN/TP；分位数由样本排序得出，禁止解析近似。
 */
export function monteCarloPrediction(
  intervals: ParamInterval[],
  base: Asm1Params,
  predict: Predictor | DatasetPredictor,
  options: { samples?: number; seed?: number } = {},
): PredictionUncertainty {
  const predictor = normalizePredictor(predict);
  const samples = options.samples ?? 60;
  const seed = options.seed ?? 20261124;
  const rng: Rng = mulberry32(seed);

  const collected: Record<PredictionMetric, number[]> = {
    cod: [],
    nh: [],
    tn: [],
    tp: [],
  };

  for (let s = 0; s < samples; s += 1) {
    const params = { ...base };
    for (const interval of intervals) {
      const se = interval.standardError;
      const v = se > 0 ? interval.estimate + rng.normal() * se : interval.estimate;
      params[interval.param] = clampToBound(interval.param, v);
    }
    const pred = predictor(params).effluent;
    const values: Record<PredictionMetric, number | undefined> = {
      cod: pred.cod,
      nh: pred.nh,
      tn: pred.tn,
      tp: pred.tp,
    };
    for (const metric of ['cod', 'nh', 'tn', 'tp'] as const) {
      const v = values[metric];
      if (v !== undefined && Number.isFinite(v)) collected[metric].push(v);
    }
  }

  const bands = {} as Record<PredictionMetric, PredictionBand>;
  for (const metric of ['cod', 'nh', 'tn', 'tp'] as const) {
    const sorted = [...collected[metric]].sort((a, b) => a - b);
    bands[metric] = {
      p10: quantile(sorted, 0.1),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
    };
  }

  return { samples, seed, bands };
}

// ---------------------------------------------------------------------------
// 质量平衡审计（WP2 全厂账本 / WP6 报表复用）
// ---------------------------------------------------------------------------

export type BalanceSubstance = 'COD' | 'N' | 'P';

export interface MassBalanceLedger {
  substance: BalanceSubstance;
  /** 进水负荷 kg */
  inflowKg: number;
  /** 出水负荷 kg */
  outflowKg: number;
  /** 排泥带走 kg */
  wasteSludgeKg: number;
  /** 化学转化（氧化 / 反硝化 / 曝气吹脱等）kg */
  transformedKg: number;
  /** 库存变化（期末 − 期初）kg，可为负 */
  inventoryChangeKg: number;
}

export interface BalanceAuditRow {
  substance: BalanceSubstance;
  inflowKg: number;
  outflowKg: number;
  wasteSludgeKg: number;
  transformedKg: number;
  inventoryChangeKg: number;
  /** 残差 = 进水 − 出水 − 排泥 − 转化 − 库存变化 */
  residualKg: number;
  /** 残差占进水百分比（绝对值） */
  residualPct: number;
  thresholdPct: number;
  alert: boolean;
}

/**
 * 三本账（COD/N/P）通用行式审计。
 *
 * 平衡关系：进水 = 出水 + 排泥 + 转化 + 库存变化 + 残差。
 * 残差超阈值只返回行级告警，不抛错——审计是诊断工具，不能让一条残差
 * 打断全厂报表生成。输入是显式台账结构，WP2 全厂账本与 WP6 报表各自
 * 填账后调用本函数。
 */
export function auditMassBalance(ledger: MassBalanceLedger[], thresholdPct = 5): BalanceAuditRow[] {
  return ledger.map((entry) => {
    const finite = [
      entry.inflowKg,
      entry.outflowKg,
      entry.wasteSludgeKg,
      entry.transformedKg,
      entry.inventoryChangeKg,
    ].every(Number.isFinite);

    if (!finite || entry.inflowKg < 0) {
      return {
        substance: entry.substance,
        inflowKg: entry.inflowKg,
        outflowKg: entry.outflowKg,
        wasteSludgeKg: entry.wasteSludgeKg,
        transformedKg: entry.transformedKg,
        inventoryChangeKg: entry.inventoryChangeKg,
        residualKg: 0,
        residualPct: 0,
        thresholdPct,
        alert: true,
      };
    }

    const residualKg =
      entry.inflowKg - entry.outflowKg - entry.wasteSludgeKg - entry.transformedKg - entry.inventoryChangeKg;
    const residualPct = (Math.abs(residualKg) / Math.max(entry.inflowKg, 1e-6)) * 100;
    return {
      substance: entry.substance,
      inflowKg: entry.inflowKg,
      outflowKg: entry.outflowKg,
      wasteSludgeKg: entry.wasteSludgeKg,
      transformedKg: entry.transformedKg,
      inventoryChangeKg: entry.inventoryChangeKg,
      residualKg,
      residualPct,
      thresholdPct,
      alert: residualPct > thresholdPct,
    };
  });
}

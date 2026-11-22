/**
 * 合规统计与报表数据（WP6 合规）。
 *
 * 统计口径（与 docs/COMPLIANCE.md 一一对应，可复算）：
 * - 日 24h 均值：只由 accepted 的日混合样计算；同一天有多份合格混合样时取平均；
 * - 月度滚动均值：窗口内最近 N 个有效日值的算术平均，不缺测补零；
 * - 95 分位：最近 N 个日值，升序后按 type-7 线性插值（与 numpy 默认分位法一致）；
 * - 达标率分母：**有效考核日**（当天至少有一份该指标的合格样品），不是分钟数；
 * - 数据完整率：有效考核日 / 窗口内应考核日；缺测日、仪器故障日计入缺失；
 * - 任何统计都能追溯到具体样品 id 与其 QA 状态；作废样品不进统计。
 *
 * 错误路径：窗口非法抛 PERMIT_WINDOW_INVALID；窗口内无合格样品抛
 * COMPLIANCE_NO_SAMPLES。不读模块全局状态，输入全部由调用方显式传入。
 */

import type { DischargeLimits } from './standards';
import { METRIC_KEYS, METRIC_LABELS, type MetricKey, type Sample } from './sampling';

export const COMPLIANCE_MAX_WINDOW_MIN = 31 * 24 * 60;
export const DEFAULT_P95_WINDOW_DAYS = 30;
export const DEFAULT_MONTH_WINDOW_DAYS = 30;

export type ComplianceErrorCode = 'PERMIT_WINDOW_INVALID' | 'COMPLIANCE_NO_SAMPLES';

export class ComplianceError extends Error {
  readonly code: ComplianceErrorCode;

  constructor(code: ComplianceErrorCode, message: string) {
    super(message);
    this.name = 'ComplianceError';
    this.code = code;
  }
}

export interface DayValue {
  /** 当天起始仿真分钟 */
  dayMin: number;
  /** 当日 24h 均值（合格混合样平均） */
  value: number;
  /** 参与当日均值的样品 id */
  sampleIds: string[];
  acceptedSamples: number;
}

export interface MetricReport {
  metric: MetricKey;
  label: string;
  limit: number;
  /** 窗口内全部样品（含作废）条数 */
  sampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  daily: DayValue[];
  /** 分母：有效考核日数 */
  validAssessmentDays: number;
  compliantDays: number;
  /** 达标率 % = 达标有效日 / 有效考核日；无有效日为 null */
  complianceRatePct: number | null;
  /** 数据完整率 % = 有效考核日 / 窗口内应考核日 */
  completenessPct: number | null;
  /** 月度滚动均值（最近 monthWindowDays 个有效日） */
  monthlyMean: number | null;
  monthlyMeanDays: number;
  /** 95 分位（最近 p95WindowDays 个日值，type-7 线性插值） */
  p95: number | null;
  p95Days: number;
  exceedDayCount: number;
  exceedSampleCount: number;
  /** 最大超标倍数（value / limit）；无超标为 null */
  maxExceedRatio: number | null;
  /** 最大超标幅度 mg/L（value − limit）；无超标为 null */
  maxExceedAmount: number | null;
}

export interface ComplianceReport {
  window: { fromMin: number; toMin: number };
  standardId: string;
  dataSource: string;
  generatedAtMin: number;
  config: {
    compositeWindowMin: number;
    p95WindowDays: number;
    monthWindowDays: number;
  };
  metrics: Record<MetricKey, MetricReport>;
  /** 窗口内全部样品（含作废），供明细导出追溯 */
  samples: Sample[];
}

export interface ComplianceReportOptions {
  limits: DischargeLimits;
  standardId: string;
  fromMin: number;
  toMin: number;
  p95WindowDays?: number;
  monthWindowDays?: number;
  maxWindowMin?: number;
  generatedAtMin?: number;
  dataSource?: string;
  compositeWindowMin?: number;
}

/** 窗口边界校验：非法数字 / to<from / 超窗宽一律 PERMIT_WINDOW_INVALID */
export function validateWindow(fromMin: number, toMin: number, maxWindowMin: number): void {
  if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) {
    throw new ComplianceError('PERMIT_WINDOW_INVALID', 'from/to 必须是有限数值');
  }
  if (toMin < fromMin) {
    throw new ComplianceError('PERMIT_WINDOW_INVALID', 'to 必须大于等于 from');
  }
  if (toMin - fromMin > maxWindowMin) {
    throw new ComplianceError('PERMIT_WINDOW_INVALID', `单次最多查询 ${maxWindowMin} 仿真分钟`);
  }
}

/**
 * 95 分位（type-7 线性插值，numpy / R 默认口径）。
 *
 * 算法：样本升序排序；rank = 0.95 × (n − 1)；在 floor(rank) 与 ceil(rank)
 * 之间按小数部分线性插值。n = 1 时返回唯一值；空数组返回 null。
 * 明确不使用「最近邻」「向上取整」等其它分位法，避免同一报表两个口径。
 */
export function percentile95(values: readonly number[]): number | null {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = 0.95 * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 窗口内应考核日数：半开区间 [from, to) 覆盖到的自然日桶数（按 1440 min 归桶）。
 * to 恰好落在日界上时，该边界属于下一天，不计入本窗口。
 */
export function expectedAssessmentDays(fromMin: number, toMin: number): number {
  const first = Math.floor(fromMin / 1440);
  const last = Math.ceil(toMin / 1440) - 1;
  return Math.max(1, last - first + 1);
}

function acceptedForMetric(samples: Sample[], metric: MetricKey): Sample[] {
  return samples.filter((s) => s.results[metric].validity === 'accepted' && s.results[metric].value !== null);
}

function reportMetric(
  samples: Sample[],
  metric: MetricKey,
  limit: number,
  fromMin: number,
  toMin: number,
  p95WindowDays: number,
  monthWindowDays: number,
): MetricReport {
  const inWindow = samples.filter((s) => s.sampledAtMin >= fromMin && s.sampledAtMin <= toMin);
  const accepted = acceptedForMetric(inWindow, metric);
  const rejected = inWindow.length - accepted.length;

  // 日混合样按天归组；抓样不参与日均值考核（口径见文档）
  const byDay = new Map<number, Sample[]>();
  for (const s of accepted) {
    if (s.type !== 'composite') continue;
    const day = Math.floor(s.sampledAtMin / 1440);
    const list = byDay.get(day) ?? [];
    list.push(s);
    byDay.set(day, list);
  }

  const daily: DayValue[] = [...byDay.entries()]
    .map(([day, list]) => {
      const values = list.map((s) => s.results[metric].value as number);
      return {
        dayMin: day * 1440,
        value: mean(values) as number,
        sampleIds: list.map((s) => s.id),
        acceptedSamples: list.length,
      };
    })
    .sort((a, b) => a.dayMin - b.dayMin);

  const dailyValues = daily.map((d) => d.value);
  const validDays = daily.length;
  const compliantDays = daily.filter((d) => d.value <= limit).length;

  const monthlySlice = dailyValues.slice(-monthWindowDays);
  const monthlyMean = mean(monthlySlice);
  const p95 = percentile95(dailyValues.slice(-p95WindowDays));

  const exceedDayCount = daily.filter((d) => d.value > limit).length;
  const exceedSampleCount = accepted.filter((s) => (s.results[metric].value as number) > limit).length;

  let maxExceedRatio: number | null = null;
  let maxExceedAmount: number | null = null;
  for (const d of daily) {
    if (d.value > limit) {
      maxExceedRatio = maxExceedRatio === null ? d.value / limit : Math.max(maxExceedRatio, d.value / limit);
      maxExceedAmount = maxExceedAmount === null ? d.value - limit : Math.max(maxExceedAmount, d.value - limit);
    }
  }

  const expectedDays = expectedAssessmentDays(fromMin, toMin);

  return {
    metric,
    label: METRIC_LABELS[metric],
    limit,
    sampleCount: inWindow.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected,
    daily,
    validAssessmentDays: validDays,
    compliantDays,
    complianceRatePct: validDays > 0 ? (compliantDays / validDays) * 100 : null,
    completenessPct: expectedDays > 0 ? (validDays / expectedDays) * 100 : null,
    monthlyMean,
    monthlyMeanDays: monthlySlice.length,
    p95,
    p95Days: Math.min(dailyValues.length, p95WindowDays),
    exceedDayCount,
    exceedSampleCount,
    maxExceedRatio,
    maxExceedAmount,
  };
}

/**
 * 生成合规报表。样品需已通过 QA 判定（sampling.ts 的 evaluateSample）。
 * 窗口内没有任何合格样品时抛 COMPLIANCE_NO_SAMPLES。
 */
export function buildComplianceReport(samples: Sample[], opts: ComplianceReportOptions): ComplianceReport {
  const maxWindowMin = opts.maxWindowMin ?? COMPLIANCE_MAX_WINDOW_MIN;
  validateWindow(opts.fromMin, opts.toMin, maxWindowMin);

  const p95WindowDays = opts.p95WindowDays ?? DEFAULT_P95_WINDOW_DAYS;
  const monthWindowDays = opts.monthWindowDays ?? DEFAULT_MONTH_WINDOW_DAYS;

  const inWindow = samples.filter((s) => s.sampledAtMin >= opts.fromMin && s.sampledAtMin <= opts.toMin);

  const anyAccepted = METRIC_KEYS.some((metric) => acceptedForMetric(inWindow, metric).length > 0);
  if (!anyAccepted) {
    throw new ComplianceError('COMPLIANCE_NO_SAMPLES', '窗口内没有合格样品，无法出具合规统计');
  }

  const metrics = {} as Record<MetricKey, MetricReport>;
  for (const metric of METRIC_KEYS) {
    metrics[metric] = reportMetric(
      inWindow,
      metric,
      opts.limits[metric],
      opts.fromMin,
      opts.toMin,
      p95WindowDays,
      monthWindowDays,
    );
  }

  return {
    window: { fromMin: opts.fromMin, toMin: opts.toMin },
    standardId: opts.standardId,
    dataSource: opts.dataSource ?? 'synthetic',
    generatedAtMin: opts.generatedAtMin ?? opts.toMin,
    config: {
      compositeWindowMin: opts.compositeWindowMin ?? 24 * 60,
      p95WindowDays,
      monthWindowDays,
    },
    metrics,
    samples: inWindow,
  };
}

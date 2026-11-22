/**
 * 采样与样品模型（WP6 合规）。
 *
 * 为什么单独成模块：许可证考核的样品口径是**日混合样 / 24h 均值 / 月均值 /
 * 95 分位**，不是分钟瞬时值。早先界面上的「达标率」直接拿分钟读数比较限值，
 * 瞬时值既不能冒充日混合样，也不能冒充达标率的分母。这里把采样链条拆成
 * 可追溯的样品记录：采样时刻 → 实验室结果可用时刻 → QA 判定 → 有效/作废。
 *
 * 口径边界（详见 docs/COMPLIANCE.md）：
 * - 流量比例日混合样按 Σ(C·Q)/ΣQ 加权，算术均值只在测试里作为对照，不进报表；
 * - 检出限以下（<DL）按许可证可配置规则处理，默认 1/2 DL；
 * - 样品三态：accepted（合格，可参与统计）/ qa-failed（QA 失败，作废留痕）/
 *   void（无效：缺测、留样超期、数值非法）；后两态一律不进达标统计；
 * - 采样频次、检出限、留样时限、平行样 RPD 阈值属于现场许可证参数，这里给默认值，
 *   现场接入时由调用方覆盖；法定签字 / 备案 / LIMS 对接不在本模块内。
 */

import type { DischargeLimits } from './standards';
import type { TrendPoint } from '../shared/protocol';

/** 六项基本控制指标，键名与 standards.ts 的 DischargeLimits 一致 */
export const METRIC_KEYS = ['cod', 'bod', 'ss', 'nh', 'tn', 'tp'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABELS: Record<MetricKey, string> = {
  cod: 'COD',
  bod: 'BOD₅',
  ss: 'SS',
  nh: 'NH₃-N',
  tn: 'TN',
  tp: 'TP',
};

/**
 * 分钟读数（显式数组输入）。
 *
 * 本模块不读服务器内部缓冲；集成方把 TrendPoint（或历史快照行）映射成这个结构
 * 再喂进来：`flowM3h` 为该分钟出水/进水流量，`values` 为该分钟各指标浓度 mg/L。
 */
export interface MinuteReading {
  minute: number;
  flowM3h: number;
  values: Partial<Record<MetricKey, number>>;
}

/** 样品类型：composite = 流量比例日混合样；grab = 瞬时抓样 */
export type SampleType = 'composite' | 'grab';

/**
 * 样品有效性三态。
 * - accepted：QA 通过，结果可参与达标统计；
 * - qa-failed：平行样 RPD 超限 / 校准失效，结果作废但保留记录；
 * - void：留样超期 / 缺测 / 数值非法，样品无效。
 * qa-failed 与 void 都不得参与达标统计，区别只在作废原因与复盘用途。
 */
export type SampleValidity = 'accepted' | 'qa-failed' | 'void';

/** <DL（低于检出限）处理规则，规则可配置，默认 half-dl */
export type CensoringRule = 'half-dl' | 'zero' | 'raw';

export interface SamplingConfig {
  /** 日混合样窗口（min），默认 1440（24h） */
  compositeWindowMin: number;
  /** 实验室结果滞后（min）：采样时刻 → 结果可用时刻，按样品类型区分 */
  resultLagMin: Record<SampleType, number>;
  /** 各指标检出限 mg/L；低于该值按删失处理 */
  detectionLimit: Record<MetricKey, number>;
  /** <DL 处理：half-dl 记 1/2 DL；zero 记 0；raw 保留实测值并标删失 */
  belowDlRule: CensoringRule;
  /** 留样时限（min）：结果可用时刻 − 采样时刻超过此值即判 void */
  holdingTimeMin: number;
  /** 平行样相对偏差 RPD 上限（%），超过判 qa-failed */
  rpdLimitPct: number;
  /** 校准是否有效；false 时全部样品判 qa-failed */
  calibrationValid: boolean;
  /** 数据来源标识，写进报表与 CSV（synthetic / lab / online …） */
  dataSource: string;
}

/** 默认口径：一级 A 配套的常见检出限与实验室滞后；现场许可证参数以现场为准 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  compositeWindowMin: 24 * 60,
  resultLagMin: { composite: 24 * 60, grab: 4 * 60 },
  detectionLimit: { cod: 2, bod: 2, ss: 1, nh: 0.05, tn: 0.1, tp: 0.02 },
  belowDlRule: 'half-dl',
  holdingTimeMin: 24 * 60,
  rpdLimitPct: 20,
  calibrationValid: true,
  dataSource: 'synthetic',
};

export interface MetricResult {
  /** 原始读数；缺测 / 仪器故障为 null */
  raw: number | null;
  /** 进入统计的数值（按 <DL 规则处理后）；非 accepted 或缺测为 null */
  value: number | null;
  /** 是否低于检出限 */
  belowDL: boolean;
  /** 是否删失（<DL 且按规则替换了数值） */
  censored: boolean;
  validity: SampleValidity;
  /** 平行样相对偏差（%）；无平行样为 null */
  rpdPct: number | null;
  note?: string;
}

export interface Sample {
  id: string;
  type: SampleType;
  sampledAtMin: number;
  resultAvailableAtMin: number;
  /** 代表流量 m³/h：混合样为窗口内平均流量，抓样为瞬时流量 */
  flowM3h: number;
  results: Record<MetricKey, MetricResult>;
  source: string;
}

export interface ParallelPair {
  replicateA: number;
  replicateB: number;
}

const VOID_RESULT: MetricResult = {
  raw: null,
  value: null,
  belowDL: false,
  censored: false,
  validity: 'void',
  rpdPct: null,
};

function emptyResults(): Record<MetricKey, MetricResult> {
  return {
    cod: { ...VOID_RESULT },
    bod: { ...VOID_RESULT },
    ss: { ...VOID_RESULT },
    nh: { ...VOID_RESULT },
    tn: { ...VOID_RESULT },
    tp: { ...VOID_RESULT },
  };
}

/** TrendPoint → MinuteReading 的适配层；本模块只依赖这个结构，不碰服务器内部 */
export function trendPointsToReadings(points: TrendPoint[]): MinuteReading[] {
  return points.map((p) => ({
    minute: p.t,
    flowM3h: p.influentFlow,
    values: {
      cod: p.effluentCod,
      bod: p.effluentBod,
      ss: p.effluentSs,
      nh: p.effluentNh,
      tn: p.effluentTn,
      tp: p.effluentTp,
    },
  }));
}

/**
 * 流量加权均值：Σ(C·Q)/ΣQ。
 *
 * 高低流量交替时，加权均值偏向高流量时段的浓度，与算术均值一般不相等；
 * 这正是日混合样的法定口径。总流量 ≤ 0 或没有有效读数时返回 null。
 */
export function weightedMean(
  series: ReadonlyArray<{ value: number; flow: number }>,
): { mean: number; totalFlow: number } | null {
  let mass = 0;
  let totalFlow = 0;
  for (const pt of series) {
    if (!Number.isFinite(pt.value) || !Number.isFinite(pt.flow)) continue;
    if (pt.flow <= 0) continue;
    mass += pt.value * pt.flow;
    totalFlow += pt.flow;
  }
  if (totalFlow <= 0) return null;
  return { mean: mass / totalFlow, totalFlow };
}

/** 平行样相对偏差 RPD（%）：|A−B| / ((A+B)/2) × 100；两份都 ≤ 0 时无法计算 */
export function parallelRpd(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const denom = (a + b) / 2;
  if (denom <= 0) return null;
  return (Math.abs(a - b) / denom) * 100;
}

/** <DL 删失处理：按配置规则把检出限以下的实测值替换成可统计数值 */
export function applyDetectionLimit(
  raw: number,
  dl: number,
  rule: CensoringRule,
): { value: number; belowDL: boolean; censored: boolean } {
  if (raw >= dl) return { value: raw, belowDL: false, censored: false };
  switch (rule) {
    case 'half-dl':
      return { value: dl / 2, belowDL: true, censored: true };
    case 'zero':
      return { value: 0, belowDL: true, censored: true };
    case 'raw':
      return { value: raw, belowDL: true, censored: false };
  }
}

function readingConstituents(readings: MinuteReading[], metric: MetricKey): { value: number; flow: number }[] {
  const out: { value: number; flow: number }[] = [];
  for (const r of readings) {
    const v = r.values[metric];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({ value: v, flow: r.flowM3h });
  }
  return out;
}

/**
 * 构造流量比例日混合样。
 *
 * 窗口内同一指标的缺测读数在加权时跳过；若该指标窗口内没有任何有效读数，
 * 结果为 null 且样品判 void。加权结果低于检出限时按配置规则删失。
 */
export function buildCompositeSample(
  readings: MinuteReading[],
  dayStartMin: number,
  config: SamplingConfig,
  id: string,
): Sample {
  const results = emptyResults();
  let flowSum = 0;
  let flowCount = 0;
  for (const r of readings) {
    if (Number.isFinite(r.flowM3h) && r.flowM3h > 0) {
      flowSum += r.flowM3h;
      flowCount += 1;
    }
  }
  const flowM3h = flowCount > 0 ? flowSum / flowCount : 0;

  for (const metric of METRIC_KEYS) {
    const constituents = readingConstituents(readings, metric);
    const w = weightedMean(constituents);
    if (w === null) {
      results[metric] = { ...VOID_RESULT, note: '窗口内无有效读数' };
      continue;
    }
    const dl = config.detectionLimit[metric];
    const dlApplied = applyDetectionLimit(w.mean, dl, config.belowDlRule);
    results[metric] = {
      raw: w.mean,
      value: dlApplied.value,
      belowDL: dlApplied.belowDL,
      censored: dlApplied.censored,
      validity: 'accepted',
      rpdPct: null,
    };
  }

  return {
    id,
    type: 'composite',
    sampledAtMin: dayStartMin,
    resultAvailableAtMin: dayStartMin + config.resultLagMin.composite,
    flowM3h,
    results,
    source: config.dataSource,
  };
}

/** 构造瞬时抓样；不做流量加权，只做检出限处理 */
export function buildGrabSample(reading: MinuteReading, config: SamplingConfig, id: string): Sample {
  const results = emptyResults();
  for (const metric of METRIC_KEYS) {
    const raw = reading.values[metric];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      results[metric] = { ...VOID_RESULT, note: '读数缺测' };
      continue;
    }
    const dl = config.detectionLimit[metric];
    const dlApplied = applyDetectionLimit(raw, dl, config.belowDlRule);
    results[metric] = {
      raw,
      value: dlApplied.value,
      belowDL: dlApplied.belowDL,
      censored: dlApplied.censored,
      validity: 'accepted',
      rpdPct: null,
    };
  }
  return {
    id,
    type: 'grab',
    sampledAtMin: reading.minute,
    resultAvailableAtMin: reading.minute + config.resultLagMin.grab,
    flowM3h: reading.flowM3h,
    results,
    source: config.dataSource,
  };
}

/**
 * QA 判定：校准有效性、留样时限、平行样 RPD。
 *
 * 规则顺序：留样超期 → void（样品作废，不再谈 QA）；校准失效 → qa-failed；
 * 平行样 RPD 超限 → qa-failed。判为非 accepted 的指标，`value` 置 null，
 * 保证下游统计拿不到作废数值。
 */
export function evaluateSample(
  sample: Sample,
  config: SamplingConfig,
  parallelPairs?: Partial<Record<MetricKey, ParallelPair>>,
): Sample {
  const results = emptyResults();
  const holdingExpired = sample.resultAvailableAtMin - sample.sampledAtMin > config.holdingTimeMin;

  for (const metric of METRIC_KEYS) {
    const prev = sample.results[metric];
    if (prev.raw === null) {
      results[metric] = { ...prev };
      continue;
    }

    let validity: SampleValidity = 'accepted';
    let note = prev.note;
    if (holdingExpired) {
      validity = 'void';
      note = '留样时限超过 holdingTimeMin';
    } else if (!config.calibrationValid) {
      validity = 'qa-failed';
      note = '校准失效';
    }

    const pair = parallelPairs?.[metric];
    let rpdPct = prev.rpdPct;
    if (pair) {
      const rpd = parallelRpd(pair.replicateA, pair.replicateB);
      rpdPct = rpd;
      if (rpd !== null && rpd > config.rpdLimitPct && validity === 'accepted') {
        validity = 'qa-failed';
        note = `平行样 RPD ${rpd.toFixed(1)}% 超阈值 ${config.rpdLimitPct}%`;
      }
    }

    results[metric] = {
      ...prev,
      validity,
      rpdPct,
      note,
      value: validity === 'accepted' ? prev.value : null,
    };
  }

  return { ...sample, results };
}

/** 由分钟读数批量生成日混合样（按天归组）+ 瞬时抓样，并跑 QA 判定 */
export function samplesFromReadings(
  readings: MinuteReading[],
  config: SamplingConfig,
  parallelPairs?: Partial<Record<MetricKey, ParallelPair>>,
): Sample[] {
  const byDay = new Map<number, MinuteReading[]>();
  for (const r of readings) {
    const day = Math.floor(r.minute / config.compositeWindowMin);
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }

  const composites = [...byDay.entries()].map(([day, list]) => {
    const sample = buildCompositeSample(list, day * config.compositeWindowMin, config, `c-day-${day}`);
    return evaluateSample(sample, config, parallelPairs);
  });

  const grabs = readings.map((r, i) => {
    const sample = buildGrabSample(r, config, `g-${i}`);
    return evaluateSample(sample, config, parallelPairs);
  });

  return [...composites, ...grabs];
}

/** 限值表的键集合与 DischargeLimits 对齐，供报表逐指标遍历 */
export type { DischargeLimits };

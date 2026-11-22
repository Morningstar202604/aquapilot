import { CONTROL_BOUNDS, CONTROL_KEYS, ControlSettings, LIMITS, type Limits } from './config';
import type { EffluentState } from './plantTypes';

/**
 * 与引擎无关的纯函数：控制量夹紧、出水评分、限值裕度。
 * 两套引擎与决策层都从这里取，避免各自实现导致口径漂移。
 */

/**
 * 数值夹紧。
 *
 * 非有限值必须回落到下限，不能原样穿过去：
 * `Math.min(max, Math.max(min, NaN))` 等于 NaN，控制量一旦被写成 NaN，
 * 后续每个 tick 的求解结果都是 NaN，且界面上只看到一串 null。
 */
export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export function clampControls(c: ControlSettings): ControlSettings {
  const out: ControlSettings = { ...c };
  // 控制量清单只有 CONTROL_KEYS 一份；新增控制量不需要再改这里
  for (const key of CONTROL_KEYS) {
    out[key] = clamp(c[key], CONTROL_BOUNDS[key].min, CONTROL_BOUNDS[key].max);
  }
  out.aiEnabled = c.aiEnabled;
  return out;
}

/**
 * 0–100 的出水综合评分：最差指标超标重罚，整体裕度轻罚。
 *
 * 非有限输入按「严重超标」处理而不是让整个分数变 0 或 NaN：
 * 一个 NaN 指标乘出来会让 `Math.max` 得到 NaN，界面显示 null，
 * 运营方看不到任何可行动信息。
 */
export function qualityScore(e: EffluentState): number {
  const ratios = effluentMarginRows(e).map((row) => row.ratio);
  const worst = Math.max(...ratios);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.round(clamp(100 - Math.max(0, worst - 0.5) * 100 - Math.max(0, mean - 0.45) * 40, 0, 100));
}

export type EffluentMetric = 'cod' | 'bod' | 'ss' | 'nh' | 'tn' | 'tp';

export interface MarginRow {
  /** 指标键，供违规列表/图表按机器名索引 */
  key: EffluentMetric;
  metric: string;
  ratio: number;
  value: number;
  limit: number;
  /** 原始读数是否有限；NaN/Infinity 不参与违规判定 */
  finite: boolean;
}

/** 六项出水指标的唯一顺序与显示名；所有比值/裕度逻辑都从这里派生 */
export const EFFLUENT_METRICS: { key: EffluentMetric; label: string }[] = [
  { key: 'cod', label: 'COD' },
  { key: 'bod', label: 'BOD₅' },
  { key: 'ss', label: 'SS' },
  { key: 'nh', label: 'NH₃-N' },
  { key: 'tn', label: 'TN' },
  { key: 'tp', label: 'TP' },
];

export type EffluentLimits = Pick<Limits, 'cod' | 'bod' | 'ss' | 'nh' | 'tn' | 'tp'>;

/**
 * 各指标占限值的比例，未排序。
 *
 * 比值必须是有限数：NaN 参与 `sort` 会让排序结果不确定，界面上
 * 「最紧指标」显示 null，AI 的接地事实也会带一个 NaN 百分比。
 * 非有限值按「极紧」处理（ratio 取正无穷），宁可报警也不静默。
 */
export function effluentMarginRows(e: EffluentState, limits: EffluentLimits = LIMITS): MarginRow[] {
  return EFFLUENT_METRICS.map(({ key, label: metric }) => {
    const value = e[key];
    const finite = Number.isFinite(value) && value >= 0;
    return {
      key,
      metric,
      ratio: finite ? value / limits[key] : Number.POSITIVE_INFINITY,
      value: Number.isFinite(value) ? value : 0,
      limit: limits[key],
      finite,
    };
  });
}

/**
 * 最差指标占限值的比例（>1 即超标）。
 *
 * 决策评分、集合预测、灵敏度分析都需要同一个数；此前三处各写一遍
 * 六项 Math.max，漏一项或口径不同就会让「同一出水、不同风险等级」。
 */
export function worstRatio(e: EffluentState, limits: EffluentLimits = LIMITS): number {
  return Math.max(...effluentMarginRows(e, limits).map((row) => row.ratio));
}

/** 各指标占限值的比例，按最紧张排序 */
export function estimateMargin(e: EffluentState, limits: EffluentLimits = LIMITS): MarginRow[] {
  return effluentMarginRows(e, limits).sort((a, b) => b.ratio - a.ratio);
}

import { CONTROL_BOUNDS, ControlSettings, LIMITS } from './config';
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
  return {
    doSetpoint: clamp(c.doSetpoint, CONTROL_BOUNDS.doSetpoint.min, CONTROL_BOUNDS.doSetpoint.max),
    internalRecirc: clamp(c.internalRecirc, CONTROL_BOUNDS.internalRecirc.min, CONTROL_BOUNDS.internalRecirc.max),
    rasRatio: clamp(c.rasRatio, CONTROL_BOUNDS.rasRatio.min, CONTROL_BOUNDS.rasRatio.max),
    wasRatio: clamp(c.wasRatio, CONTROL_BOUNDS.wasRatio.min, CONTROL_BOUNDS.wasRatio.max),
    pacDose: clamp(c.pacDose, CONTROL_BOUNDS.pacDose.min, CONTROL_BOUNDS.pacDose.max),
    carbonDose: clamp(c.carbonDose, CONTROL_BOUNDS.carbonDose.min, CONTROL_BOUNDS.carbonDose.max),
    alkDose: clamp(c.alkDose, CONTROL_BOUNDS.alkDose.min, CONTROL_BOUNDS.alkDose.max),
    stormStore: clamp(c.stormStore, CONTROL_BOUNDS.stormStore.min, CONTROL_BOUNDS.stormStore.max),
    stepFeed: clamp(c.stepFeed, CONTROL_BOUNDS.stepFeed.min, CONTROL_BOUNDS.stepFeed.max),
    aiEnabled: c.aiEnabled,
  };
}

/**
 * 0–100 的出水综合评分：最差指标超标重罚，整体裕度轻罚。
 *
 * 非有限输入按「严重超标」处理而不是让整个分数变 0 或 NaN：
 * 一个 NaN 指标乘出来会让 `Math.max` 得到 NaN，界面显示 null，
 * 运营方看不到任何可行动信息。
 */
export function qualityScore(e: EffluentState): number {
  const safe = (v: number) => (Number.isFinite(v) && v >= 0 ? v : LIMITS.cod * 10);
  const ratios = [
    safe(e.cod) / LIMITS.cod,
    safe(e.bod) / LIMITS.bod,
    safe(e.ss) / LIMITS.ss,
    safe(e.nh) / LIMITS.nh,
    safe(e.tn) / LIMITS.tn,
    safe(e.tp) / LIMITS.tp,
  ];
  const worst = Math.max(...ratios);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.round(clamp(100 - Math.max(0, worst - 0.5) * 100 - Math.max(0, mean - 0.45) * 40, 0, 100));
}

export interface MarginRow {
  metric: string;
  ratio: number;
  value: number;
  limit: number;
}

/**
 * 各指标占限值的比例，按最紧张排序。
 *
 * 比值必须是有限数：NaN 参与 `sort` 会让排序结果不确定，界面上
 * 「最紧指标」显示 null，AI 的接地事实也会带一个 NaN 百分比。
 * 非有限值按「极紧」处理（ratio 取一个明确的大数），宁可报警也不静默。
 */
export function estimateMargin(e: EffluentState): MarginRow[] {
  const row = (metric: string, value: number, limit: number): MarginRow => ({
    metric,
    ratio: Number.isFinite(value) && value >= 0 ? value / limit : Number.POSITIVE_INFINITY,
    value: Number.isFinite(value) ? value : 0,
    limit,
  });
  return [
    row('COD', e.cod, LIMITS.cod),
    row('BOD₅', e.bod, LIMITS.bod),
    row('SS', e.ss, LIMITS.ss),
    row('NH₃-N', e.nh, LIMITS.nh),
    row('TN', e.tn, LIMITS.tn),
    row('TP', e.tp, LIMITS.tp),
  ].sort((a, b) => b.ratio - a.ratio);
}

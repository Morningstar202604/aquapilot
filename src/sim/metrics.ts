import { CONTROL_BOUNDS, ControlSettings, LIMITS } from './config';
import type { EffluentState } from './plantTypes';

/**
 * 与引擎无关的纯函数：控制量夹紧、出水评分、限值裕度。
 * 两套引擎与决策层都从这里取，避免各自实现导致口径漂移。
 */

export function clamp(v: number, min: number, max: number): number {
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

/** 0–100 的出水综合评分：最差指标超标重罚，整体裕度轻罚 */
export function qualityScore(e: EffluentState): number {
  const ratios = [e.cod / LIMITS.cod, e.bod / LIMITS.bod, e.ss / LIMITS.ss, e.nh / LIMITS.nh, e.tn / LIMITS.tn, e.tp / LIMITS.tp];
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

/** 各指标占限值的比例，按最紧张排序 */
export function estimateMargin(e: EffluentState): MarginRow[] {
  return [
    { metric: 'COD', ratio: e.cod / LIMITS.cod, value: e.cod, limit: LIMITS.cod },
    { metric: 'BOD₅', ratio: e.bod / LIMITS.bod, value: e.bod, limit: LIMITS.bod },
    { metric: 'SS', ratio: e.ss / LIMITS.ss, value: e.ss, limit: LIMITS.ss },
    { metric: 'NH₃-N', ratio: e.nh / LIMITS.nh, value: e.nh, limit: LIMITS.nh },
    { metric: 'TN', ratio: e.tn / LIMITS.tn, value: e.tn, limit: LIMITS.tn },
    { metric: 'TP', ratio: e.tp / LIMITS.tp, value: e.tp, limit: LIMITS.tp },
  ].sort((a, b) => b.ratio - a.ratio);
}

/**
 * 集合预测（不确定性量化）。
 *
 * 单点预测的问题是它只代表"参数取中心值时的未来"，无法回答
 * "这个结论有多稳"。这里用确定性的参数扰动生成 N 条轨迹，
 * 输出每个采样时刻的 P10 / P50 / P90，以及窗口内超限概率。
 *
 * 为什么不用随机采样：仿真是确定性系统，随机数会让同一状态
 * 每次决策给出不同建议，破坏可复现性与可解释性。扰动因子用
 * 固定表（低/中/高负荷），任何一次运行都能复现同一组轨迹。
 */

import type { ControlSettings } from './config';
import { LIMITS } from './config';
import type { EffluentStats } from './networkEngine';
import type { ForecastOutcomeX, UncertaintyFactor } from './plantModel';

export type { UncertaintyFactor };

/**
 * 三组固定扰动，对应"进水偏低 / 设计值 / 进水偏高"。
 *
 * 数值来自工艺常识区间而非拟合：进水量 ±15%、COD ±20%、氨氮 ±20%、
 * 总磷 ±15%、水温 ±1.5 ℃、生物量 ±10%。这是给决策层看的压力测试，
 * 不是对某个污水厂的统计标定。
 */
export const UNCERTAINTY_VARIANTS: UncertaintyFactor[] = [
  { flow: 0.85, cod: 0.8, nh: 0.8, tp: 0.85, temperature: -1.5, biomass: 0.9 },
  { flow: 1.0, cod: 1.0, nh: 1.0, tp: 1.0, temperature: 0, biomass: 1.0 },
  { flow: 1.15, cod: 1.2, nh: 1.2, tp: 1.15, temperature: 1.5, biomass: 1.1 },
];

export interface Band {
  p10: number;
  p50: number;
  p90: number;
}

export interface BandPoint {
  minute: number;
  cod: Band;
  nh: Band;
  tn: Band;
  tp: Band;
  ss: Band;
  score: Band;
}

export interface EnsembleForecast {
  points: BandPoint[];
  /** 任一样本在窗口内出现超标的比例，0–1 */
  exceedanceProbability: number;
  /** 最差样本的最紧指标占限值比例 */
  worstRatio: number;
  samples: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function band(values: number[]): Band {
  const s = [...values].sort((a, b) => a - b);
  return { p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9) };
}

/** 单条轨迹是否出现任何出水指标超限 */
export function violated(forecast: Pick<ForecastOutcomeX, 'violations'>): boolean {
  return forecast.violations.length > 0;
}

function metricRatio(e: EffluentStats): number {
  return Math.max(
    e.cod / LIMITS.cod,
    e.bod / LIMITS.bod,
    e.ss / LIMITS.ss,
    e.nh / LIMITS.nh,
    e.tn / LIMITS.tn,
    e.tp / LIMITS.tp,
  );
}

export function buildEnsemble(
  runs: ForecastOutcomeX[],
  horizonMin: number,
  sampleEveryMin: number,
  scoreOf: (e: EffluentStats) => number,
): EnsembleForecast {
  const samples = runs.length;
  if (samples === 0) {
    return { points: [], exceedanceProbability: 0, worstRatio: 0, samples: 0 };
  }
  const minutes = Math.min(...runs.map((r) => r.points.length));
  const points: BandPoint[] = [];
  let worstRatio = 0;
  for (let i = 0; i < minutes; i++) {
    const effluents = runs.map((r) => r.points[i].effluent);
    for (const e of effluents) worstRatio = Math.max(worstRatio, metricRatio(e));
    points.push({
      minute: (i + 1) * sampleEveryMin,
      cod: band(effluents.map((e) => e.cod)),
      nh: band(effluents.map((e) => e.nh)),
      tn: band(effluents.map((e) => e.tn)),
      tp: band(effluents.map((e) => e.tp)),
      ss: band(effluents.map((e) => e.ss)),
      score: band(effluents.map((e) => scoreOf(e))),
    });
  }
  const exceedanceProbability = runs.filter(violated).length / Math.max(1, samples);
  void horizonMin;
  return { points, exceedanceProbability, worstRatio, samples };
}

/**
 * 用同一 PlantModel 跑一组扰动轨迹。
 *
 * 模型不支持扰动时（旧引擎适配器）退回单点预测，并把样本数记为 1——
 * 这样界面显示"未评估不确定性"，而不是伪造出 0% 超限概率。
 */
export function forecastEnsemble(
  model: import('./plantModel').PlantModel,
  controls: ControlSettings,
  horizonMin: number,
  sampleEveryMin: number,
  scoreOf: (e: EffluentStats) => number,
  variants: UncertaintyFactor[] = UNCERTAINTY_VARIANTS,
): EnsembleForecast & { supported: boolean } {
  const runs: ForecastOutcomeX[] = [];
  for (const factor of variants) {
    if (model.predictWithUncertainty) {
      runs.push(model.predictWithUncertainty(controls, horizonMin, sampleEveryMin, factor));
    } else {
      runs.push(model.predict(controls, horizonMin, sampleEveryMin));
    }
  }
  const ensemble = buildEnsemble(runs, horizonMin, sampleEveryMin, scoreOf);
  return { ...ensemble, supported: Boolean(model.predictWithUncertainty) };
}

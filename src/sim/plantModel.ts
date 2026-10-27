import type { ControlSettings } from './config';
import type { EffluentStats, NetworkSimState } from './networkEngine';
import type { ScenarioType } from './scenarios';

/**
 * 厂模型抽象：AI 决策只依赖这个接口，不依赖具体引擎。
 *
 * 这样"拓扑求解引擎"和"固定五池引擎"可以互换，而 AI 的预测永远和被控制的
 * 那个引擎一致——避免"改图改了 A 引擎，AI 却在用 B 引擎预测"的假闭环。
 */

export interface PlantSnapshotForAi {
  timeMin: number;
  effluent: EffluentStats;
  influent: { flow: number; cod: number; nh: number; tp: number; temperature: number };
  controls: ControlSettings;
  srtDays: number;
  fmRatio: number;
  mlss: number;
  reactorCount: number;
  lastDo: number;
  clarifier: { blanketM: number; depth: number; slr: number; xRas: number };
  energy: { totalKw: number; specificKwhM3: number };
  cost: { total: number };
  scenario: { type: string; startedAt: number; durationMin: number; magnitude: number } | null;
  inhibition: number;
}

export interface ForecastPointX {
  minute: number;
  effluent: EffluentStats;
  doLevel: number;
  blanket: number;
  score: number;
  energyKw: number;
}

export interface ForecastOutcomeX {
  points: ForecastPointX[];
  violations: { metric: string; minute: number; value: number; limit: number }[];
  costDelta: number;
  peakEnergyKw: number;
  endSrt: number;
  endBlanket: number;
  endDilute: number;
}

/**
 * 预测用的参数扰动因子。
 *
 * 定义在模型抽象层，避免 ensemble ↔ plantModel 之间出现运行时循环依赖；
 * 具体取值在 ensemble.ts 里给出（固定表，保证可复现）。
 */
export interface UncertaintyFactor {
  flow: number;
  cod: number;
  nh: number;
  tp: number;
  temperature: number;
  biomass: number;
}

export interface PlantModel {
  snapshot(): PlantSnapshotForAi;
  predict(controls: ControlSettings, horizonMin: number, sampleEveryMin: number): ForecastOutcomeX;
  /** 假设推演：在当前状态上叠加一个场景再预测 */
  predictWithScenario(
    controls: ControlSettings,
    horizonMin: number,
    sampleEveryMin: number,
    scenario: ScenarioType,
  ): ForecastOutcomeX;
  /** 参数扰动预测；旧引擎适配器不实现时退化为单点预测 */
  predictWithUncertainty?(
    controls: ControlSettings,
    horizonMin: number,
    sampleEveryMin: number,
    factor: UncertaintyFactor,
  ): ForecastOutcomeX;
}

export function blankStats(): EffluentStats {
  return { flow: 0, cod: 0, bod: 0, ss: 0, nh: 0, tn: 0, tp: 0, ph: 7, temperature: 20 };
}

export function networkSnapshot(state: NetworkSimState): PlantSnapshotForAi {
  const last = state.reactors[state.reactors.length - 1];
  return {
    timeMin: state.timeMin,
    effluent: state.effluent,
    influent: {
      flow: state.influent.flow,
      cod: state.influent.cod,
      nh: state.influent.nh,
      tp: state.influent.tp,
      temperature: state.influent.temperature,
    },
    controls: state.controls,
    srtDays: state.srtDays,
    fmRatio: state.fmRatio,
    // 无反应器时不能报设计值：界面会显示一个根本没有的污泥浓度
    mlss: state.reactors.length === 0 ? 0 : Math.round((state.biomassKg * 1000) / Math.max(1, state.volume.bio)),
    reactorCount: state.reactors.length,
    lastDo: last?.doLevel ?? 0,
    clarifier: {
      blanketM: state.clarifier.blanketM,
      depth: state.clarifier.depth,
      slr: state.clarifier.slr,
      xRas: state.clarifier.xRas,
    },
    energy: {
      totalKw: state.energy.totalKw,
      specificKwhM3: state.energy.totalKw / Math.max(1, state.influent.flow),
    },
    cost: { total: state.cost.total },
    scenario: state.scenario,
    inhibition: state.inhibition,
  };
}

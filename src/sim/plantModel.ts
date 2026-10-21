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
    mlss: Math.round((state.biomassKg * 1000) / Math.max(1, state.volume.bio)),
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

/** 旧引擎适配器：让既有测试与脚本继续可用，同时保证预测与被控对象一致 */
export function legacyModel(state: import('./engine').SimState, forecastFn: typeof import('./engine').forecast): PlantModel {
  const snap = (): PlantSnapshotForAi => {
    const last = state.tanks[state.tanks.length - 1];
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
      mlss: state.tanks[0]?.mlss ?? 0,
      reactorCount: state.tanks.length,
      lastDo: last?.do ?? 0,
      clarifier: {
        blanketM: state.clarifier.blanketM,
        depth: state.clarifier.depth,
        slr: state.clarifier.slr,
        xRas: state.clarifier.xRas,
      },
      energy: { totalKw: state.energy.totalKw, specificKwhM3: state.energy.specificKwhM3 },
      cost: { total: state.cost.total },
      scenario: state.scenario,
      inhibition: state.inhibition,
    };
  };

  const run = (controls: ControlSettings, horizonMin: number, sampleEvery: number, scenario: string | null): ForecastOutcomeX => {
    let base = state;
    if (scenario) {
      base = structuredClone(state);
      base.scenario = { type: scenario as never, durationMin: 360, magnitude: 1, startedAt: base.timeMin };
    }
    const fc = forecastFn(base, controls, horizonMin, sampleEvery);
      return {
      points: fc.points.map((p) => ({
        minute: p.minute,
        effluent: p.effluent,
        doLevel: p.doLevel,
        blanket: p.blanket,
        score: p.score,
        energyKw: p.energyKw,
      })),
      violations: fc.violations,
      costDelta: fc.costDelta,
      peakEnergyKw: fc.peakEnergyKw,
      endSrt: fc.end.srtDays,
      endBlanket: fc.end.clarifier.blanketM,
      endDilute: fc.end.inhibition,
    };
  };

  return {
    snapshot: snap,
    predict: (c, h, s) => run(c, h, s, null),
    predictWithScenario: (c, h, s, sc) => run(c, h, s, sc),
  };
}

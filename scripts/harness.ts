import { decide, Recommendation } from '../src/ai/agent';
import { forecast, qualityScore, step } from '../src/sim/engine';
import { legacyModel } from '../src/sim/plantModel';
import { PLANT } from '../src/sim/config';
import { SCENARIO_ORDER, SCENARIOS, ScenarioType } from '../src/sim/scenarios';

const types = process.argv.slice(2);
const chosen: ScenarioType[] = types.length ? (types as ScenarioType[]) : SCENARIO_ORDER;

for (const type of chosen) {
  const meta = SCENARIOS[type];
  console.log(`\n=== AI 值守仿真：${meta.label} ===`);
  const { createInitialState, spinUp, startScenario } = await import('../src/sim/engine');
  const state = spinUp(createInitialState({ seed: 2026 }), 30);
  const baselineViolations = { count: 0 };
  let rec: Recommendation | null = null;

  startScenario(state, type);

  for (let cycle = 0; cycle < 8; cycle++) {
    rec = decide({ model: legacyModel(state, forecast), horizonMin: 240 });
    if (state.controls.aiEnabled && rec.action !== 'hold') {
      state.controls = rec.chosens.controls;
    }
    for (let m = 0; m < 30; m++) {
      step(state, 1);
      const e = state.effluent;
      if (e.nh > 5 || e.cod > 50 || e.tp > 0.5 || e.ss > 10) baselineViolations.count++;
    }
    console.log(
      `${String(cycle * 30).padStart(4)}min | ${rec.action.padEnd(9)} | 评分${qualityScore(state.effluent)} | 出水 NH₄ ${state.effluent.nh.toFixed(2)} COD ${state.effluent.cod.toFixed(1)} TP ${state.effluent.tp.toFixed(3)} SS ${state.effluent.ss.toFixed(1)} | DO ${state.tanks[4].do.toFixed(2)} | 能耗 ${state.energy.totalKw.toFixed(0)}kW`,
    );
    console.log(`        AI: ${rec.summary}`);
  }
  const final = forecast(state, state.controls, 240, 30);
  console.log(`场景结束：累计超标采样点 ${baselineViolations.count}，剩余场景窗口预测超标 ${final.violations.length}`);
  console.log(`告警：${state.alarms.slice(-3).map((a) => a.message).join(' / ') || '无'}`);
  console.log(`二沉池界面 ${state.clarifier.blanketM.toFixed(2)}m | MLSS ${state.tanks[0].mlss} | SRT ${state.srtDays.toFixed(1)}d | ${PLANT.name}`);
}

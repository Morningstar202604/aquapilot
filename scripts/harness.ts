import { decide, Recommendation } from '../src/ai/agent';
import { PLANT } from '../src/sim/config';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import {
  createNetworkState,
  networkModel,
  spinUpNetwork,
  startNetworkScenario,
  stepNetwork,
} from '../src/sim/networkEngine';
import { qualityScore } from '../src/sim/metrics';
import { SCENARIO_ORDER, SCENARIOS, ScenarioType } from '../src/sim/scenarios';

/**
 * 场景演示器（命令行）。
 *
 * 跑生产引擎（拓扑求解）——与浏览器里看到的是同一条路径。
 * 旧版本跑固定五池参考引擎，演示结论与线上行为无关。
 */

const types = process.argv.slice(2);
const chosen: ScenarioType[] = types.length ? (types as ScenarioType[]) : SCENARIO_ORDER;

for (const type of chosen) {
  const meta = SCENARIOS[type];
  console.log(`\n=== AI 值守仿真：${meta.label} ===`);
  const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 2026 }), PLANT_TOPOLOGY, 30);
  const baselineViolations = { count: 0 };
  let rec: Recommendation | null = null;

  startNetworkScenario(state, type);

  for (let cycle = 0; cycle < 8; cycle++) {
    rec = decide({ model: networkModel(PLANT_TOPOLOGY, state), horizonMin: 240 });
    if (state.controls.aiEnabled && rec.action !== 'hold') {
      state.controls = rec.chosens.controls;
    }
    for (let m = 0; m < 30; m++) {
      stepNetwork(state, PLANT_TOPOLOGY, 1);
      const e = state.effluent;
      if (e.nh > 5 || e.cod > 50 || e.tp > 0.5 || e.ss > 10) baselineViolations.count += 1;
    }
    const lastDo = state.reactors[state.reactors.length - 1]?.doLevel ?? 0;
    console.log(
      `${String(cycle * 30).padStart(4)}min | ${rec.action.padEnd(9)} | 评分${qualityScore(state.effluent)} | 出水 NH₄ ${state.effluent.nh.toFixed(2)} COD ${state.effluent.cod.toFixed(1)} TP ${state.effluent.tp.toFixed(3)} SS ${state.effluent.ss.toFixed(1)} | DO ${lastDo.toFixed(2)} | 能耗 ${state.energy.totalKw.toFixed(0)}kW`,
    );
    console.log(`        AI: ${rec.summary}`);
  }
  const final = networkModel(PLANT_TOPOLOGY, state).predict(state.controls, 240, 30);
  console.log(`场景结束：累计超标采样点 ${baselineViolations.count}，剩余场景窗口预测超标 ${final.violations.length}`);
  console.log(`告警：${state.alarms.slice(-3).map((a) => a.message).join(' / ') || '无'}`);
  console.log(
    `二沉池界面 ${state.clarifier.blanketM.toFixed(2)}m | MLSS ${((state.biomassKg * 1000) / state.volume.bio).toFixed(0)} | SRT ${state.srtDays.toFixed(1)}d | ${PLANT.name}`,
  );
}

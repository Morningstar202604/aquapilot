import {
  createInitialState,
  forecast,
  qualityScore,
  spinUp,
  startScenario,
  step,
} from '../src/sim/engine';
import { DEFAULT_CONTROLS } from '../src/sim/config';
import { SCENARIO_ORDER, SCENARIOS } from '../src/sim/scenarios';

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'NaN';
}

const base = spinUp(createInitialState({ seed: 42 }), 40);
const e = base.effluent;
console.log('== 稳态（40 d 培养，默认控制）==');
console.log(
  `流量 ${fmt(base.influent.flow, 0)} m³/h | 进水 COD ${fmt(base.influent.cod, 0)} NH4 ${fmt(base.influent.nh, 1)} TN ${fmt(base.influent.tn, 1)} TP ${fmt(base.influent.tp, 2)} T ${fmt(base.influent.temperature, 1)}`,
);
console.log(
  `出水 COD ${fmt(e.cod, 1)} BOD ${fmt(e.bod, 1)} SS ${fmt(e.ss, 1)} NH4 ${fmt(e.nh, 2)} TN ${fmt(e.tn, 2)} TP ${fmt(e.tp, 3)} pH ${fmt(e.ph, 2)}`,
);
console.log(
  `MLSS ${fmt(base.tanks[0].mlss, 0)} SRT ${fmt(base.srtDays, 1)} d F/M ${fmt(base.fmRatio, 3)} DO ${fmt(base.tanks[4].do, 2)} 能耗 ${fmt(base.energy.totalKw, 0)} kW (${fmt(base.energy.specificKwhM3, 3)} kWh/m³)`,
);
console.log(
  `DO 分布 ${base.tanks.map((t) => `${t.short}:${fmt(t.do, 2)}`).join(' ')}`,
);
console.log(`评分 ${qualityScore(e)} | 污泥界面 ${fmt(base.clarifier.blanketM, 2)} m | xEff ${fmt(base.clarifier.xEff, 1)}`);

console.log('\n== 默认控制 24 h 预测 ==');
const fc = forecast(base, DEFAULT_CONTROLS, 1440, 60);
console.log(
  `超额次数 ${fc.violations.length} | 能耗峰值 ${fmt(fc.peakEnergyKw, 0)} kW | 预测成本增量 ¥${fmt(fc.costDelta, 0)}`,
);
if (fc.violations.length) {
  console.log(fc.violations.slice(0, 8).map((v) => `${v.minute}min ${v.metric}=${fmt(v.value)}/${v.limit}`).join(' | '));
}

console.log('\n== 场景压力测试（每个场景 6 h）==');
for (const type of SCENARIO_ORDER) {
  const sim = spinUp(createInitialState({ seed: 42 }), 40);
  const meta = SCENARIOS[type];
  startScenario(sim, type, { durationMin: 360 });
  let worstNh = 0;
  let worstTp = 0;
  let worstCod = 0;
  let worstSs = 0;
  for (let m = 0; m < 360; m++) {
    step(sim, 1);
    worstNh = Math.max(worstNh, sim.effluent.nh);
    worstTp = Math.max(worstTp, sim.effluent.tp);
    worstCod = Math.max(worstCod, sim.effluent.cod);
    worstSs = Math.max(worstSs, sim.effluent.ss);
  }
  console.log(
    `${meta.label.padEnd(6)} 6h末 NH4 ${fmt(sim.effluent.nh, 2)} TP ${fmt(sim.effluent.tp, 3)} COD ${fmt(sim.effluent.cod, 1)} SS ${fmt(sim.effluent.ss, 1)} | 峰值 NH4 ${fmt(worstNh, 2)} COD ${fmt(worstCod, 1)} SS ${fmt(worstSs, 1)} | 界面 ${fmt(sim.clarifier.blanketM, 2)}m SRT ${fmt(sim.srtDays, 1)}d 评分 ${qualityScore(sim.effluent)}`,
  );
}

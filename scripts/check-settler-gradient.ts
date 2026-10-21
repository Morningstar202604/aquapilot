import { BSM1_SETTLER, runSettlerToSteady, sludgeBlanketHeight } from '../src/sim/takacs';

const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.0 };
const Q = 18446;

console.log('=== 稳态剖面与质量守恒 ===\n');
for (const [label, mlss, ras] of [
  ['BSM1 标准', 3000, 1.0],
  ['低负荷', 2000, 1.0],
  ['高负荷', 5000, 1.0],
  ['低回流', 3000, 0.4],
] as const) {
  const Qf = Q * (1 + ras);
  const Qu = Q * ras;
  const r = runSettlerToSteady(cfg, { flow: Qf, concentration: mlss }, { flow: Qu }, { maxDays: 80, dtDays: 1 / 1440 });
  const Qe = Qf - Qu;
  const inKg = (Qf * mlss) / 1000;
  const outKg = (Qe * r.xEffluent + Qu * r.xUnderflow) / 1000;
  const err = Math.abs(inKg - outKg) / inKg * 100;
  console.log(`${label.padEnd(10)} 出水 ${r.xEffluent.toFixed(1).padStart(5)}  回流 ${r.xUnderflow.toFixed(0).padStart(6)}  浓缩比 ${(r.xUnderflow / mlss).toFixed(2)}  泥层 ${sludgeBlanketHeight(r.state, cfg).toFixed(2)}m  守恒误差 ${err.toFixed(2)}%`);
  console.log(`           剖面 ${r.state.x.map((v) => v.toFixed(0)).join(', ')}`);
}

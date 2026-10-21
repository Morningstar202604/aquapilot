import { BSM1_SETTLER, runSettlerToSteady, sludgeBlanketHeight, settlingVelocity } from '../src/sim/takacs';

const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.0 };

console.log('=== 沉降速度曲线（双指数）===');
for (const x of [500, 1000, 2000, 3000, 5000, 8000]) {
  console.log(`  X=${String(x).padStart(5)} g/m³  v_s=${settlingVelocity(x, cfg).toFixed(1)} m/d`);
}

console.log('\n=== 稳态剖面（BSM1 工况：Q=18446 m³/d, MLSS 3000, RAS 18446）===');
const Q = 18446; // m3/d
const feed = { flow: Q + Q, concentration: 3000 }; // 进水 + 回流
const underflow = { flow: Q }; // RAS
const r = runSettlerToSteady(cfg, feed, underflow, { maxDays: 60, dtDays: 1 / 720 });

console.log('  层 浓度 g/m³');
r.state.x.forEach((v, i) => console.log(`  ${String(i + 1).padStart(2)}  ${v.toFixed(0).padStart(6)}`));
console.log(`\n  出水 SS  ${r.xEffluent.toFixed(1)} g/m³`);
console.log(`  回流浓度 ${r.xUnderflow.toFixed(0)} g/m³`);
console.log(`  固体负荷 ${r.solidsLoading.toFixed(2)} kg/(m²·h)`);
console.log(`  泥层高度 ${sludgeBlanketHeight(r.state, cfg).toFixed(2)} m`);
console.log('\n预期：出水 SS < 20（尤其 <10），回流浓度 5000–12000，泥层 < 4 m');

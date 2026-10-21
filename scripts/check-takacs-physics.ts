import { BSM1_SETTLER, runSettlerToSteady, sludgeBlanketHeight } from '../src/sim/takacs';

const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.0 };
const Q = 18446;

console.log('=== 1. 固体负荷升高 → 出水 SS 恶化、泥层抬升 ===');
for (const mlss of [2000, 3000, 4000, 5000, 6000]) {
  const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: mlss }, { flow: Q }, { maxDays: 40, dtDays: 1 / 720 });
  console.log(`  MLSS ${String(mlss).padStart(4)} → 出水 SS ${r.xEffluent.toFixed(1).padStart(6)}  回流 ${r.xUnderflow.toFixed(0).padStart(5)}  泥层 ${sludgeBlanketHeight(r.state, cfg).toFixed(2)}m  负荷 ${r.solidsLoading.toFixed(1)}`);
}

console.log('\n=== 2. 回流比降低 → 回流浓度升高、泥层抬升 ===');
for (const ras of [1.0, 0.7, 0.5, 0.3]) {
  const r = runSettlerToSteady(cfg, { flow: Q * (1 + ras), concentration: 3000 }, { flow: Q * ras }, { maxDays: 40, dtDays: 1 / 720 });
  console.log(`  RAS ${ras.toFixed(1)}×Q → 出水 SS ${r.xEffluent.toFixed(1).padStart(6)}  回流 ${r.xUnderflow.toFixed(0).padStart(5)}  泥层 ${sludgeBlanketHeight(r.state, cfg).toFixed(2)}m`);
}

console.log('\n=== 3. 池面积翻倍 → 负荷减半、出水更好 ===');
for (const area of [1500, 3000]) {
  const c = { ...cfg, area };
  const r = runSettlerToSteady(c, { flow: Q * 2, concentration: 4000 }, { flow: Q }, { maxDays: 40, dtDays: 1 / 720 });
  console.log(`  面积 ${String(area).padStart(4)} m² → 出水 SS ${r.xEffluent.toFixed(1).padStart(6)}  负荷 ${r.solidsLoading.toFixed(2)}  泥层 ${sludgeBlanketHeight(r.state, c).toFixed(2)}m`);
}

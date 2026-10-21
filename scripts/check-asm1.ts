import { conservationResiduals, reactionRates, emptyAsm1State } from '../src/sim/asm1';

console.log('=== ASM1 守恒残差 ===');
for (const r of conservationResiduals()) {
  console.log(
    `${r.process.padEnd(34)} COD ${r.cod.toExponential(2).padStart(10)}  N ${r.n.toExponential(2).padStart(10)}  ALK ${r.alk.toExponential(2).padStart(10)}`,
  );
}

console.log('\n=== 反应速率检查 ===');
const alive = emptyAsm1State({ S_S: 70, X_S: 200, X_B_H: 2500, X_B_A: 150, S_O: 2, S_NO: 5, S_NH: 30, S_ND: 5, X_ND: 10 });
const r = reactionRates(alive);
for (const [k, v] of Object.entries(r)) {
  if (Math.abs(v) > 1e-6) console.log(`  ${k.padEnd(6)} ${v.toFixed(4)}`);
}

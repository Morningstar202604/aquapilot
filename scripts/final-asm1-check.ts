import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { LIMITS } from '../src/sim/config';

console.log('=== ASM1 最终验证（Takács 二沉池）===\n');
const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
const mlss = (s.biomassKg * 1000) / s.volume.bio;

console.log('出水水质:');
const checks = [
  ['COD', s.effluent.cod, LIMITS.cod],
  ['NH₄-N', s.effluent.nh, LIMITS.nh],
  ['TN', s.effluent.tn, LIMITS.tn],
  ['SS', s.effluent.ss, LIMITS.ss],
] as const;
for (const [name, v, lim] of checks) {
  console.log(`  ${name.padEnd(6)} ${v.toFixed(2).padStart(7)} / ${lim}  ${v <= lim ? '✓' : '✗'}`);
}
console.log(`\n生物: MLSS ${mlss.toFixed(0)} | SRT ${s.srtDays.toFixed(1)}d | 泥位 ${s.clarifier.blanketM.toFixed(2)}m`);
console.log(`\n各池: ${s.reactors.map((r) => `${r.name}(NH${r.nh.toFixed(1)})`).join(' ')}`);
console.log(`\nASM1 组分（好氧A）: ${s.reactors.find((r) => r.id === 'aerobic1')?.asm1 ? Object.entries(s.reactors.find((r) => r.id === 'aerobic1')!.asm1!).map(([k, v]) => `${k}=${(v as number).toFixed(0)}`).join(' ') : 'none'}`);

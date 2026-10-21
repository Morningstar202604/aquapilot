import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';

console.log('=== Takács 接入后的稳态 ===\n');

for (const days of [5, 20, 40]) {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, days);
  const mlss = (s.biomassKg * 1000) / s.volume.bio;
  console.log(
    `${String(days).padStart(2)}d: MLSS ${mlss.toFixed(0).padStart(5)} | 出水 COD ${s.effluent.cod.toFixed(1).padStart(5)} NH4 ${s.effluent.nh.toFixed(2).padStart(5)} SS ${s.effluent.ss.toFixed(1).padStart(4)} | 回流 ${s.clarifier.xRas.toFixed(0).padStart(5)} | 泥位 ${s.clarifier.blanketM.toFixed(2)}m | SLR ${s.clarifier.slr.toFixed(2)}`,
  );
}

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, 30);
console.log('\n剖面:', s.clarifier.settler.x.map((v) => v.toFixed(0)).join(', '));
console.log('SRT', s.srtDays.toFixed(1), 'd');

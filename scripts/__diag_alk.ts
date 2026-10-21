import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
for (const r of s.reactors) {
  const a = r.asm1 as any;
  console.log(r.id, 'S_ALK', a?.S_ALK?.toFixed(3), 'alk mg/L', r.alkalinity.toFixed(1), 'pH', s.effluent.ph.toFixed(2));
}
console.log('influent alk', s.influent.alkalinity.toFixed(0));

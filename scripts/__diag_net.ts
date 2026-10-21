import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
console.log('order', s.order);
for (const r of s.reactors) console.log(r.id, 'inflow', r.inflow.toFixed(0), 'vol', r.volume, 'cod', r.cod.toFixed(0), 'mlssEst', (r.cod*1.42).toFixed(0));
console.log('edgeFlows', JSON.stringify(s.edgeFlows, null, 1));

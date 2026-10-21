import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
console.log('energy', s.energy);
console.log('o2Demand per reactor', s.reactors.map(r => `${r.id}:${r.o2Demand.toFixed(0)}`).join(' '));
console.log('biomassKg', s.biomassKg.toFixed(0), 'srt', s.srtDays.toFixed(1), 'fm', s.fmRatio.toFixed(3));
console.log('xRas', s.clarifier.xRas.toFixed(0), 'xEff', s.clarifier.xEff.toFixed(1), 'slr', s.clarifier.slr.toFixed(2));

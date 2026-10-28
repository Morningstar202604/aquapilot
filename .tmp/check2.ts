import { createNetworkState, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { fromAsm1 } from '../src/sim/asm1Mapping';

const s = createNetworkState(PLANT_TOPOLOGY, { model: 'asm1' });
console.log('init alkalinity per reactor:', s.reactors.map(r => r.alkalinity.toFixed(1)).join(','));
for (let i = 0; i < 1440 * 3; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
console.log('3d alkalinity:', s.reactors.map(r => r.alkalinity.toFixed(1)).join(','));
console.log('3d S_ALK:', s.reactors.map(r => (r.asm1?.S_ALK ?? NaN).toFixed(2)).join(','));
console.log('3d NH:', s.reactors.map(r => r.nh.toFixed(2)).join(','));
console.log('3d NO3:', s.reactors.map(r => r.no3.toFixed(2)).join(','));
console.log('3d COD:', s.reactors.map(r => r.cod.toFixed(1)).join(','));
console.log('effluent', s.effluent);
console.log('xRas', s.clarifier.xRas.toFixed(1), 'xEff', s.clarifier.xEff.toFixed(2), 'slr', s.clarifier.slr.toFixed(2));
console.log('biomassKg', s.biomassKg.toFixed(0), 'srt', s.srtDays.toFixed(1), 'fm', s.fmRatio.toFixed(3));
const last = s.reactors[s.reactors.length-1];
console.log('last asm1', last.asm1);

import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
console.log('effluent', s.effluent);
console.log('biomassKg', s.biomassKg.toFixed(0), 'xRas', s.clarifier.xRas.toFixed(0), 'xEff', s.clarifier.xEff.toFixed(2));
console.log('profile', s.clarifier.settler.x.map(v => v.toFixed(0)).join(','));
for (const r of s.reactors) {
  const a = r.asm1 as any;
  console.log(r.id, 'cod', r.cod.toFixed(0), 'nh', r.nh.toFixed(2), 'do', r.doLevel.toFixed(2),
    'XBH', a?.X_B_H?.toFixed(0), 'XBA', a?.X_B_A?.toFixed(0), 'XI', a?.X_I?.toFixed(0), 'XS', a?.X_S?.toFixed(0), 'XP', a?.X_P?.toFixed(0),
    'SNH', a?.S_NH?.toFixed(2), 'SNO', a?.S_NO?.toFixed(2), 'SALK', a?.S_ALK?.toFixed(2));
}

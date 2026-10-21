import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
const before = s.reactors.find(r => r.id === 'aerobic1')!.asm1!;
const b = { ...before };
stepNetwork(s, PLANT_TOPOLOGY, 1);
const after = s.reactors.find(r => r.id === 'aerobic1')!.asm1!;
console.log('XBH before', b.X_B_H.toFixed(1), 'after', after.X_B_H.toFixed(1), 'delta', (after.X_B_H-b.X_B_H).toFixed(2));
console.log('XBA before', b.X_B_A.toFixed(1), 'after', after.X_B_A.toFixed(1), 'delta', (after.X_B_A-b.X_B_A).toFixed(2));
console.log('XP before', b.X_P.toFixed(1), 'after', after.X_P.toFixed(1), 'delta', (after.X_P-b.X_P).toFixed(2));
console.log('XS before', b.X_S.toFixed(1), 'after', after.X_S.toFixed(1), 'delta', (after.X_S-b.X_S).toFixed(2));
console.log('SS before', b.S_S.toFixed(2), 'after', after.S_S.toFixed(2));
console.log('SNH before', b.S_NH.toFixed(2), 'after', after.S_NH.toFixed(2));
console.log('SO before', b.S_O.toFixed(2), 'after', after.S_O.toFixed(2));

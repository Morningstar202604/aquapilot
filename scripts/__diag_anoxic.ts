import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, stepNetwork, spinUpNetwork } from '../src/sim/networkEngine';
import { emptyAsm1State } from '../src/sim/asm1';
import { reactionRates } from '../src/sim/asm1';

// Manually build anoxic feed state and check reaction
const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
const anx = s.reactors.find(r => r.id === 'anoxic')!;
console.log('anoxic state', { XBH: anx.asm1!.X_B_H.toFixed(1), XBA: anx.asm1!.X_B_A.toFixed(1), SS: anx.asm1!.S_S.toFixed(1), SNH: anx.asm1!.S_NH.toFixed(1), SNO: anx.asm1!.S_NO.toFixed(1), SO: anx.asm1!.S_O.toFixed(2) });
const r = reactionRates(anx.asm1!);
console.log('anoxic reaction rates per h', Object.fromEntries(Object.entries(r).map(([k,v]) => [k, (v as number).toFixed(4)])));

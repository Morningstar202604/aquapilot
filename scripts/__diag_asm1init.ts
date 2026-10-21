import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, stepNetwork, spinUpNetwork } from '../src/sim/networkEngine';

const s = createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' });
// step a few minutes, print aerobic1 composition growth
for (let i=0;i<10;i++){
  stepNetwork(s, PLANT_TOPOLOGY, 1);
  const a = s.reactors.find(r=>r.id==='aerobic1')!.asm1!;
  console.log(i, 'XBH', a.X_B_H.toFixed(0), 'XBA', a.X_B_A.toFixed(0), 'XI', a.X_I.toFixed(0), 'XS', a.X_S.toFixed(0), 'XP', a.X_P.toFixed(0), 'SO', a.S_O.toFixed(2), 'SNH', a.S_NH.toFixed(1));
}

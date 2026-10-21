import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, stepNetwork } from '../src/sim/networkEngine';
const s = createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' });
for (let d = 0; d < 10; d++) {
  for (let i = 0; i < 720; i++) stepNetwork(s, PLANT_TOPOLOGY, 2);
  const a = s.reactors.find(r => r.id === 'anaerobic')!.asm1!;
  console.log(`day ${d+1}: anaerobic XBH ${a.X_B_H.toFixed(0)} XBA ${a.X_B_A.toFixed(0)} XS ${a.X_S.toFixed(0)} XP ${a.X_P.toFixed(0)}`);
}

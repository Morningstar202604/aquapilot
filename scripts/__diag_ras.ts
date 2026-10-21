import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
for (const ras of [0.5, 0.8, 1.2]) {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1', controls: { rasRatio: ras } }), PLANT_TOPOLOGY, 30);
  const a1 = s.reactors.find(r=>r.id==='aerobic1')!.asm1!;
  console.log(`RAS ${ras}: biomass ${s.biomassKg.toFixed(0)} XBH(a1) ${a1.X_B_H.toFixed(0)} XBA(a1) ${a1.X_B_A.toFixed(0)} xRas ${s.clarifier.xRas.toFixed(0)} effNH ${s.effluent.nh.toFixed(2)}`);
}

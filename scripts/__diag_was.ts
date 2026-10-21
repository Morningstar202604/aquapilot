import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';

for (const was of [0.002, 0.0085, 0.022, 0.03]) {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1', controls: { wasRatio: was } }), PLANT_TOPOLOGY, 30);
  console.log(`WAS ${was}: biomassKg ${s.biomassKg.toFixed(0)} SRT ${s.srtDays.toFixed(1)} MLSS ${(s.biomassKg*1000/s.volume.bio).toFixed(0)} XBA( aerobic1) ${(s.reactors.find(r=>r.id==='aerobic1')?.asm1 as any)?.X_B_A?.toFixed(0)}`);
}

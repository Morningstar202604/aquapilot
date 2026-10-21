import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';

for (const days of [5, 15, 30]) {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, days);
  const mlss = (s.biomassKg * 1000) / s.volume.bio;
  const bodLoad = (s.influent.flow * 24 * s.influent.bod) / 1000;
  const manual = bodLoad / s.biomassKg;
  console.log(
    `预热 ${days}d: F/M ${s.fmRatio.toFixed(3)} (手算 ${manual.toFixed(3)}) | 进水 BOD ${s.influent.bod.toFixed(0)} | 生物量 ${(s.biomassKg / 1000).toFixed(1)} t | MLSS ${mlss.toFixed(0)} | SRT ${s.srtDays.toFixed(1)}d`,
  );
}

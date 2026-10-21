import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 30);
console.log('controls', s.controls);
const Q = s.influent.flow;
const Qr = Q * s.controls.rasRatio, Qw = Q * s.controls.wasRatio;
const Qf = Q * (1 + Math.max(s.controls.rasRatio, 0.3));
const Qu = Qr + Qw;
console.log({Q: Q.toFixed(1), Qr: Qr.toFixed(1), Qw: Qw.toFixed(1), Qf: Qf.toFixed(1), Qu: Qu.toFixed(1), QePlant: (Q-Qw).toFixed(1), QeSettler: (Qf-Qu).toFixed(1)});
const xBio = s.biomassKg*1000/s.volume.bio;
console.log('xBiomass used as settler feed', xBio.toFixed(0));
for (const r of s.reactors) {
  const a = r.asm1!;
  const ss = (a.X_I+a.X_S+a.X_B_H+a.X_B_A+a.X_P)/1.42;
  console.log(r.id, 'actual SS', ss.toFixed(0), 'biomass SS', ((a.X_B_H+a.X_B_A)/1.42).toFixed(0), 'XP', a.X_P.toFixed(0));
}
console.log('settler xEff', s.clarifier.xEff.toFixed(2), 'xRas', s.clarifier.xRas.toFixed(0));
console.log('mass in', (Qf*xBio/1000).toFixed(0), 'mass out', ((Qu*s.clarifier.xRas + (Qf-Qu)*s.clarifier.xEff)/1000).toFixed(0));

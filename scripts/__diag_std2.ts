import { BSM1_SETTLER, settlingVelocity, type SettlerConfig } from '../src/sim/takacs';

function run(cfg: SettlerConfig, feed: {flow:number;concentration:number}, uf:{flow:number}, days:number) {
  const n = cfg.layers, z = cfg.depth/n, m = cfg.feedLayer;
  const Qf = feed.flow, Qu = Math.min(Qf*0.95, uf.flow), Qe = Qf-Qu;
  const vUp = Qe/cfg.area, vDn = Qu/cfg.area;
  let X = new Array(n).fill(3000);
  const dt = 1/1440;
  const sub = Math.max(1, Math.ceil((0.4*z/cfg.v0Max)/dt));
  const h = dt/sub;
  for (let d=0; d<days*1440; d++) {
    for (let s=0; s<sub; s++) {
      const J = X.map(x => settlingVelocity(x,cfg)*x);
      const next = new Array(n).fill(0);
      for (let i=0;i<n;i++) {
        const layer=i+1;
        const Jup = i===0 ? 0 : J[i-1];
        const Jdn = i===n-1 ? 0 : J[i];
        let adv=0;
        if (layer < m) adv = vUp*(X[i+1]-X[i]);
        else if (layer > m) adv = vDn*(X[i-1]-X[i]);
        else adv = (Qf*feed.concentration/cfg.area) - vUp*X[i] - vDn*X[i];
        next[i] = Math.max(0, X[i] + h*(adv + Jup - Jdn)/z);
      }
      X = next;
    }
  }
  const inKg = Qf*feed.concentration/1000;
  const outKg = (Qu*X[n-1] + Qe*X[0])/1000;
  return {X, inKg, outKg};
}
const cfg={...BSM1_SETTLER,area:1500,depth:4};
const Q=18446;
for (const ras of [0.5,1.0,1.5]) {
  const r = run(cfg,{flow:Q*(1+ras),concentration:3000},{flow:Q*ras},200);
  console.log(`RAS ${ras}: ${r.X.map(v=>v.toFixed(0)).join(',')} | in ${r.inKg.toFixed(0)} out ${r.outKg.toFixed(0)} ratio ${(r.outKg/r.inKg).toFixed(3)} | xRas/xf ${(r.X[9]/3000).toFixed(2)}`);
}

import { BSM1_SETTLER, settlingVelocity, type SettlerConfig } from '../src/sim/takacs';

function run(cfg: SettlerConfig, feed: {flow:number;concentration:number}, uf:{flow:number}, days:number, init: number[]) {
  const n = cfg.layers, z = cfg.depth/n, m = cfg.feedLayer;
  const Qf = feed.flow, Qu = Math.min(Qf*0.95, uf.flow), Qe = Qf-Qu;
  const vUp = Qe/cfg.area, vDn = Qu/cfg.area;
  let X = [...init];
  const dt = 1/1440;
  const sub = Math.max(1, Math.ceil((0.4*z/cfg.v0Max)/dt));
  const h = dt/sub;
  for (let d=0; d<days*1440; d++) {
    for (let s=0; s<sub; s++) {
      const J = X.map((x,i) => i===n-1 ? 0 : settlingVelocity(x,cfg)*x);
      const next = new Array(n).fill(0);
      for (let i=0;i<n;i++) {
        const layer=i+1;
        const Jup = i===0 ? 0 : J[i-1];
        const Jdn = J[i];
        let adv=0;
        if (layer < m) adv = vUp*(X[i+1]-X[i]);
        else if (layer > m) adv = vDn*(X[i-1]-X[i]);
        else adv = (Qf*feed.concentration/cfg.area) - vUp*X[i] - vDn*X[i];
        next[i] = Math.max(0, X[i] + h*(adv + Jup - Jdn)/z);
      }
      X = next;
    }
  }
  return X;
}
const Q=18446;
for (const n of [10, 20, 50]) {
  const cfg={...BSM1_SETTLER,layers:n,feedLayer:Math.round(n*0.6),area:1500,depth:4};
  const init = Array.from({length:n},(_,i)=> i < cfg.feedLayer ? 20 : 3000);
  const X = run(cfg,{flow:Q*2,concentration:3000},{flow:Q},200,init);
  console.log(`n=${n} feed=${cfg.feedLayer}:`, X.map(v=>v.toFixed(0)).join(','));
}

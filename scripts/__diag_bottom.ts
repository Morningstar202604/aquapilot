import { BSM1_SETTLER, settlingVelocity, type SettlerConfig } from '../src/sim/takacs';

function run(cfg: SettlerConfig, feed: {flow:number;concentration:number}, uf:{flow:number}, days:number, mode: 'current'|'noExtra'|'std') {
  const n = cfg.layers, z = cfg.depth/n, m = cfg.feedLayer;
  const Qf = feed.flow, Qu = Math.min(Qf*0.95, uf.flow), Qe = Qf-Qu;
  const vUp = Qe/cfg.area, vDn = Qu/cfg.area;
  let X = new Array(n).fill(3000);
  const dt = 1/1440;
  const sub = Math.max(1, Math.ceil((0.4*z/cfg.v0Max)/dt));
  const h = dt/sub;
  for (let d=0; d<days*1440; d++) {
    for (let s=0; s<sub; s++) {
      const J = X.map((x,i) => {
        if (mode==='std' && i===n-1) return settlingVelocity(x,cfg)*x;
        if (i===n-1) return 0;
        const xu = Math.min(X[i], X[i+1]);
        return settlingVelocity(xu,cfg)*xu;
      });
      const next = new Array(n).fill(0);
      for (let i=0;i<n;i++) {
        const layer=i+1;
        const Jup = i===0 ? 0 : J[i-1];
        const Jdn = J[i];
        let adv=0;
        if (layer < m) adv = vUp*(X[i+1]-X[i]);
        else if (layer > m) adv = vDn*(X[i-1]-X[i]);
        else adv = (Qf*feed.concentration/cfg.area) - vUp*X[i] - vDn*X[i];
        let flux = adv + Jup - Jdn;
        if (mode==='current' && layer===n) flux -= vDn*X[i];
        next[i] = Math.max(0, X[i] + h*flux/z);
      }
      X = next;
    }
  }
  const xU = mode==='std' ? X[n-1] + settlingVelocity(X[n-1],cfg)*X[n-1]/vDn : X[n-1];
  const inKg = Qf*feed.concentration/1000;
  const outKg = (Qu*xU + Qe*X[0])/1000;
  return {X, xU, inKg, outKg};
}
const cfg={...BSM1_SETTLER,area:1500,depth:4};
const Q=18446;
for (const mode of ['current','noExtra','std'] as const) {
  const r = run(cfg,{flow:Q*2,concentration:3000},{flow:Q},120,mode);
  console.log(`${mode}: ${r.X.map(v=>v.toFixed(0)).join(',')} | xU ${r.xU.toFixed(0)} | in ${r.inKg.toFixed(0)} out ${r.outKg.toFixed(0)} ratio ${(r.outKg/r.inKg).toFixed(3)}`);
}

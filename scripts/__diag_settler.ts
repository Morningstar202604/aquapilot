import { BSM1_SETTLER, runSettlerToSteady, stepSettler, settlingVelocity } from '../src/sim/takacs';

const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.0 };
const Q = 18446;
const feed = { flow: Q * 2, concentration: 3000 };
const uf = { flow: Q };

let r = runSettlerToSteady(cfg, feed, uf, { maxDays: 60, dtDays: 1 / 1440 });
console.log('after run:', r.state.x.map(v => v.toFixed(1)).join(','));
console.log('mass kg', (r.state.x.reduce((a,b)=>a+b,0)*cfg.area*(cfg.depth/cfg.layers)/1000).toFixed(0));

// one step change
const s2 = stepSettler(r.state, cfg, feed, uf, 1/1440);
console.log('delta per min:', s2.state.x.map((v,i)=>(v-r.state.x[i]).toFixed(2)).join(','));
console.log('mass after 1 min kg', (s2.state.x.reduce((a,b)=>a+b,0)*cfg.area*(cfg.depth/cfg.layers)/1000).toFixed(0));

// flux terms at final state
const n=cfg.layers, z=cfg.depth/n, Qf=feed.flow, Qu=Math.min(Qf*0.95,uf.flow), Qe=Qf-Qu;
const vUp=Qe/cfg.area, vDn=Qu/cfg.area;
console.log('vUp',vUp.toFixed(2),'vDn',vDn.toFixed(2));
for(let i=0;i<n;i++){
  const layer=i+1, x=r.state.x[i];
  const sf=(iface:number)=>{ if(iface<=0||iface>=n) return 0; const xu=r.state.x[iface-1], xl=r.state.x[iface], xm=Math.min(xu,xl); return settlingVelocity(xm,cfg)*xm; };
  const Ja=sf(i), Jb=sf(i+1);
  let bulk=0;
  if(layer<cfg.feedLayer) bulk=vUp*(r.state.x[i+1]-x);
  else if(layer>cfg.feedLayer) bulk=vDn*(r.state.x[i-1]-x);
  else bulk=(Qf*feed.concentration)/cfg.area - vUp*x - vDn*x;
  let flux=bulk+Ja-Jb;
  if(layer===n) flux-=vDn*x;
  console.log(`L${layer} x=${x.toFixed(0)} bulk=${bulk.toFixed(0)} Ja=${Ja.toFixed(0)} Jb=${Jb.toFixed(0)} flux=${flux.toFixed(0)} dx/dt=${(flux/z).toFixed(0)}`);
}

import { BSM1_SETTLER, settlingVelocity, type SettlerConfig, type SettlerState } from '../src/sim/takacs';

function stepFixed(state: SettlerState, cfg: SettlerConfig, feed: {flow:number;concentration:number}, uf:{flow:number}, dtDays:number) {
  const n = cfg.layers, z = cfg.depth/n, feedLayer = cfg.feedLayer;
  const Qf = Math.max(1e-6, feed.flow);
  const Qu = Math.min(Qf*0.95, Math.max(0, uf.flow));
  const Qe = Math.max(1e-6, Qf-Qu);
  const vUp = Qe/cfg.area, vDn = Qu/cfg.area;
  const maxDt = (0.4*z)/Math.max(1e-6,cfg.v0Max);
  const subSteps = Math.max(1, Math.min(2000, Math.ceil(dtDays/maxDt)));
  const dt = dtDays/subSteps;
  let xs=[...state.x];
  for(let step=0; step<subSteps; step++){
    const next=new Array<number>(n).fill(0);
    for(let i=0;i<n;i++){
      const layer=i+1, xHere=xs[i];
      const sf=(iface:number)=>{ if(iface<=0||iface>=n) return 0; const xu=xs[iface-1], xl=xs[iface], xm=Math.min(xu,xl); return settlingVelocity(xm,cfg)*xm; };
      const Ja=sf(i), Jb=sf(i+1);
      let bulk=0;
      if(layer<feedLayer) bulk=vUp*(xs[i+1]-xHere);
      else if(layer>feedLayer) bulk=vDn*(xs[i-1]-xHere);
      else bulk=(Qf*feed.concentration)/cfg.area - vUp*xHere - vDn*xHere;
      let flux=bulk+Ja-Jb;
      next[i]=Math.max(0, Math.min(cfg.xMax, xHere+(flux/z)*dt));
    }
    xs=next;
  }
  return { state:{x:xs}, xEffluent:xs[0], xUnderflow:xs[n-1], solidsLoading:(Qf/24)*(feed.concentration/1000)/cfg.area };
}
const cfg={...BSM1_SETTLER,area:1500,depth:4};
const Q=18446;
let st={x:Array(10).fill(3000)};
const feed={flow:Q*2,concentration:3000}, uf={flow:Q};
for(let d=0;d<60;d++){ const r=stepFixed(st,cfg,feed,uf,1/1440); st=r.state; }
console.log('fixed profile', st.x.map(v=>v.toFixed(0)).join(','));
console.log('xEff',st.x[0].toFixed(2),'xRas',st.x[9].toFixed(0));
const inKg=Q*2*3000/1000, outKg=(Q*st.x[9]+Q*st.x[0])/1000;
console.log('in',inKg.toFixed(0),'out',outKg.toFixed(0),'ratio',(outKg/inKg).toFixed(3));

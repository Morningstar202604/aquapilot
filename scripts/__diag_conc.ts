import { BSM1_SETTLER, settlingVelocity, type SettlerConfig } from '../src/sim/takacs';

function run(cfg: SettlerConfig, feed: {flow:number;concentration:number}, uf:{flow:number}, days:number, initBottom: number) {
  const n = cfg.layers, z = cfg.depth/n, m = cfg.feedLayer;
  const Qf = feed.flow, Qu = Math.min(Qf*0.95, uf.flow), Qe = Qf-Qu;
  const vUp = Qe/cfg.area, vDn = Qu/cfg.area;
  let X = new Array(n).fill(3000); X[n-1]=initBottom;
  const dt=1/1440, sub=Math.max(1,Math.ceil((0.4*z/cfg.v0Max)/dt)), h=dt/sub;
  for(let d=0;d<days*1440;d++) for(let s=0;s<sub;s++){
    const J=X.map((x,i)=> i===n-1?0:settlingVelocity(x,cfg)*x);
    const next=new Array(n).fill(0);
    for(let i=0;i<n;i++){
      const layer=i+1, Jup=i===0?0:J[i-1], Jdn=J[i];
      let adv=0;
      if(layer<m) adv=vUp*(X[i+1]-X[i]);
      else if(layer>m) adv=vDn*(X[i-1]-X[i]);
      else adv=(Qf*feed.concentration/cfg.area)-vUp*X[i]-vDn*X[i];
      next[i]=Math.max(0,X[i]+h*(adv+Jup-Jdn)/z);
    }
    X=next;
  }
  return X;
}
const cfg={...BSM1_SETTLER,area:1500,depth:4}; const Q=18446;
for (const init of [10000, 20000]) {
  const X=run(cfg,{flow:Q*2,concentration:3000},{flow:Q},120,init);
  console.log(`init ${init}: ${X.map(v=>v.toFixed(0)).join(',')} xRas/xf ${(X[9]/3000).toFixed(2)}`);
}

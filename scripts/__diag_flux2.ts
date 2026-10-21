import { BSM1_SETTLER, settlingVelocity } from '../src/sim/takacs';
const cfg={...BSM1_SETTLER,area:1500,depth:4}; const n=10, z=cfg.depth/n;
const X=[6,10,15,26,64,334,334,334,334,5994];
const Qf=18446*2, Qu=18446, Qe=Qf-Qu, vUp=Qe/cfg.area, vDn=Qu/cfg.area;
console.log('vUp',vUp,'vDn',vDn,'feed flux',Qf*3000/cfg.area);
for(let i=0;i<n;i++){
  const layer=i+1;
  const Jup = i===0?0:settlingVelocity(Math.min(X[i-1],X[i]),cfg)*Math.min(X[i-1],X[i]);
  const Jdn = i===n-1?0:settlingVelocity(Math.min(X[i],X[i+1]),cfg)*Math.min(X[i],X[i+1]);
  let adv;
  if(layer<cfg.feedLayer) adv=vUp*(X[i+1]-X[i]);
  else if(layer>cfg.feedLayer) adv=vDn*(X[i-1]-X[i]);
  else adv=(Qf*3000/cfg.area)-vUp*X[i]-vDn*X[i];
  console.log(`L${layer} X=${X[i]} Jup=${Jup.toFixed(0)} Jdn=${Jdn.toFixed(0)} adv=${adv.toFixed(0)} net=${(adv+Jup-Jdn).toFixed(0)}`);
}

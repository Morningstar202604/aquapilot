import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';

const t0 = performance.now();
const base = createRuntime(PLANT_TOPOLOGY);
console.log('base spin-up ms:', (performance.now()-t0).toFixed(0), 'reactors:', base.compiled.reactors.length, 'clarifierId:', base.compiled.clarifierId);

const two = JSON.parse(JSON.stringify(PLANT_TOPOLOGY)) as ProcessTopology;
two.units.push({ id:'clarifier2', kind:'clarifier', name:'二沉池 2', role:'泥水分离', area:2400, depth:4.5, ports:[
  {id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'effluent'},{id:'ras',kind:'out',stream:'return_activated_sludge'},{id:'was',kind:'out',stream:'waste_sludge'}]});
// reroute clarifier -> clarifier2 -> disinfection
two.connections = two.connections.filter(c=>c.id!=='c-clarifier-effluent');
two.connections.push({id:'c-clar2',from:{unit:'clarifier',port:'out'},to:{unit:'clarifier2',port:'in'},stream:'effluent'});
two.connections.push({id:'c-clar2-out',from:{unit:'clarifier2',port:'out'},to:{unit:'disinfection',port:'in'},stream:'effluent'});
const t1 = performance.now();
const rt2 = createRuntime(two);
console.log('two-clarifier spin-up ms:', (performance.now()-t1).toFixed(0), 'reactors:', rt2.compiled.reactors.length, 'clarifierId:', rt2.compiled.clarifierId);
console.log('clarifier2 in compiled edges:', rt2.compiled.edges.some(e=>e.to==='clarifier2'||e.from==='clarifier2'));
console.log('effluent nh:', rt2.net.effluent.nh.toFixed(3), 'vs base', base.net.effluent.nh.toFixed(3));

// +3 aerobic pools spin-up cost
const big = JSON.parse(JSON.stringify(PLANT_TOPOLOGY)) as ProcessTopology;
let prev='aerobic3';
const idx=big.train.indexOf('aerobic3');
for(let i=1;i<=3;i++){
  const id=`ax${i}`;
  big.units.push({id,kind:'aerobic',name:`好氧 ${i}`,role:'硝化',volume:5000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
  big.train.splice(idx+i,0,id);
  big.connections=big.connections.filter(c=>!(c.from.unit===prev&&c.to.unit==='clarifier'));
  big.connections.push({id:`e${i}`,from:{unit:prev,port:'out'},to:{unit:id,port:'in'},stream:'mixed_liquor'});
  prev=id;
}
big.connections.push({id:'last-clar',from:{unit:prev,port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'});
const t2=performance.now();
const rt3=createRuntime(big);
console.log('+3 pools spin-up ms:', (performance.now()-t2).toFixed(0), 'reactors:', rt3.compiled.reactors.length, 'mlss:', ((rt3.net.biomassKg*1000)/rt3.net.volume.bio).toFixed(0), 'nh:', rt3.net.effluent.nh.toFixed(3));

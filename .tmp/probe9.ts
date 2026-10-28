import { PLANT_TOPOLOGY } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
let t:any=clone();
// disconnected branch reactor with a non-reactor mixed-liquor feed, placed first in train
t.units.push({id:'aerobicX',kind:'aerobic',name:'X',role:'',volume:1000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.units.push({id:'aerobicY',kind:'aerobic',name:'Y',role:'',volume:1000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.units.push({id:'splitX',kind:'splitter',name:'splitX',role:'',ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.connections.push({id:'sx-in',from:{unit:'aerobic3',port:'out'},to:{unit:'splitX',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'sx-out',from:{unit:'splitX',port:'out'},to:{unit:'aerobicX',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'xy',from:{unit:'aerobicX',port:'out'},to:{unit:'aerobicY',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'y-out',from:{unit:'aerobicY',port:'out'},to:{unit:'aerobic2',port:'in'},stream:'mixed_liquor'});
t.train=['aerobicX','anaerobic','anoxic','aerobic1','aerobic2','aerobic3'];
const sv=sanitizeTopologyInput(t);
console.log('sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){
  console.log('ready',checkRunReadiness(sv.topology).ready,checkRunReadiness(sv.topology).blockers);
  const c=compileNetwork(sv.topology);
  console.log('problems',c.problems,'order',c.order);
  try{const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3});console.log('flows ok',f.reactorInflow.get('aerobicX'));}catch(e:any){console.log('RESOLVE CRASH:',e.constructor?.name,e.message);}
}

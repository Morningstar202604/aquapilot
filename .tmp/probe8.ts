import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// external waste sludge to anaerobic; remove external influents
let t:any=clone();
t.connections=t.connections.filter((c:any)=>!['c-primary-anaerobic','c-primary-anoxic-stepfeed','c-storm-anaerobic'].includes(c.id));
t.connections.push({id:'thick-anaerobic',from:{unit:'thickener',port:'out'},to:{unit:'anaerobic',port:'in'},stream:'waste_sludge'});
const sv=sanitizeTopologyInput(t);
console.log('sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){
  console.log('validate errors',validateTopology(sv.topology).filter((i:any)=>i.severity==='error').map((i:any)=>i.code));
  console.log('ready',checkRunReadiness(sv.topology).ready);
  const c=compileNetwork(sv.topology);
  console.log('edges into anaerobic',c.incomingByReactor['anaerobic']?.map((e:any)=>({id:e.id,stream:e.stream,from:e.from,recycle:e.recycle})));
  try{const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3});console.log('flows anaerobic',f.reactorInflow.get('anaerobic'),'thick',f.edgeFlow.get('thick-anaerobic'));}catch(e:any){console.log('RESOLVE CRASH',e.constructor?.name,e.message);}
}

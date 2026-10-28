import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
let t:any=clone();
// mark a genuine forward edge (anaerobic -> anoxic) as recycle
const fwd=t.connections.find((c:any)=>c.id==='c-anaerobic-anoxic');
fwd.recycle=true;
const sv=sanitizeTopologyInput(t);
console.log('recycle forward sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){const c=compileNetwork(sv.topology); console.log('edge',c.edges.find((e:any)=>e.id==='c-anaerobic-anoxic')); const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3}); console.log('flow',f.edgeFlow.get('c-anaerobic-anoxic'),'anoxic inflow',f.reactorInflow.get('anoxic'),'anaerobic outflow',f.reactorOutflow.get('anaerobic'));}
// duplicate connection ids
let t2:any=clone();
t2.connections[1].id=t2.connections[0].id;
console.log('dup conn id validate errors',validateTopology(t2).filter((i:any)=>i.code==='DUP_CONN').length, 'sanitize',sanitizeTopologyInput(t2).ok);
// port direction + stream
let t3:any=clone();
t3.connections.push({id:'rev2',from:{unit:'anaerobic',port:'in'},to:{unit:'anoxic',port:'out'},stream:'mixed_liquor'});
console.log('reverse dir validate errors',validateTopology(t3).filter((i:any)=>i.severity==='error').map((i:any)=>i.code),'sanitize',sanitizeTopologyInput(t3).ok);
// source stream mismatch but target matches
let t4:any=clone();
t4.connections.push({id:'srcbad',from:{unit:'aerobic1',port:'out'},to:{unit:'aerobic2',port:'air'},stream:'air'});
console.log('source stream mismatch validate errors',validateTopology(t4).filter((i:any)=>i.severity==='error').map((i:any)=>i.code),'sanitize',sanitizeTopologyInput(t4).ok);

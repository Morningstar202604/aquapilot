import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { layoutTopology } from '../src/model/layout';
import { createRuntime } from '../src/server/topologyRuntime';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// disconnected biological loop
let t:any=clone();
t.connections=t.connections.filter((c:any)=>!['c-primary-storm-route','c-primary-anaerobic','c-primary-anoxic-stepfeed','c-storm-anaerobic'].includes(c.id));
const sv=sanitizeTopologyInput(t);
console.log('disconnected sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){
  const v=validateTopology(sv.topology);
  console.log('errors',v.filter((i:any)=>i.severity==='error').map((i:any)=>i.code),'warnings',v.filter((i:any)=>i.severity==='warning').map((i:any)=>i.code));
  const r=checkRunReadiness(sv.topology); console.log('ready',r.ready,'blockers',r.blockers,'warnings',r.warnings);
  const c=compileNetwork(sv.topology); console.log('compile problems',c.problems);
  try{const rt=createRuntime(sv.topology); console.log('createRuntime OK reactors',rt.net.reactors.length,'effluent',rt.net.effluent.cod);}catch(e:any){console.log('createRuntime ERR',e.message);}
}
// route height clipping
const t2:any=clone();
t2.routes={'c-inlet-screen':[{x:500,y:20000},{x:500,y:100}]};
const l=layoutTopology(t2);
const e=l.edges.find((x:any)=>x.connection.id==='c-inlet-screen')!;
console.log('route vertical extremes: height',l.height,'labelY',e.labelY,'path',e.path);
// huge volume
let t3:any=clone(); t3.units.find((u:any)=>u.id==='anaerobic').volume=1e308; t3.units.find((u:any)=>u.id==='anoxic').volume=1e308;
const s3=sanitizeTopologyInput(t3); console.log('huge vol sanitize',s3.ok,'bio',s3.ok?compileNetwork(s3.topology).bioVolume:'');
// duplicate train
let t4:any=clone(); t4.train.push('aerobic3'); const s4=sanitizeTopologyInput(t4);
console.log('dup train sanitize',s4.ok,s4.ok?s4.topology.train.length:'');
if(s4.ok){const c4=compileNetwork(s4.topology);console.log('dup train reactors',c4.reactors.length,'problems',c4.problems);}

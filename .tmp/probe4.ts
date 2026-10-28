import { PLANT_TOPOLOGY } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { layoutTopology } from '../src/model/layout';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// remove all external influent into anaerobic, add waste sludge from thickener
let t:any=clone();
t.connections=t.connections.filter((c:any)=>!['c-primary-anaerobic','c-primary-anoxic-stepfeed','c-storm-anaerobic'].includes(c.id));
t.connections.push({id:'sludge-to-anaerobic',from:{unit:'thickener',port:'out'},to:{unit:'anaerobic',port:'in'},stream:'waste_sludge'});
const sv=sanitizeTopologyInput(t);
console.log('sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){console.log('ready',checkRunReadiness(sv.topology).ready, checkRunReadiness(sv.topology).blockers);const c=compileNetwork(sv.topology);console.log('problems',c.problems);try{const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3});console.log('flows',f.reactorInflow.get('anaerobic'));}catch(e:any){console.log('RESOLVE CRASH:',e.message);}}

// manual route clipping
const topo:any=clone();
topo.routes={'c-inlet-screen':[{x:200,y:20000},{x:400,y:20000}]};
const l=layoutTopology(topo);
console.log('layout height',l.height,'route edge labelY',l.edges.find((e:any)=>e.connection.id==='c-inlet-screen')?.labelY, l.edges.find((e:any)=>e.connection.id==='c-inlet-screen')?.path.slice(0,120));
// width clipping
const l2=layoutTopology(clone());
const maxNodeRight=Math.max(...l2.nodes.map(n=>n.x+n.w));
const maxPathX=Math.max(...l2.edges.flatMap(e=>[...e.path.matchAll(/[MH] (-?[\d.]+)/g)].map(m=>Number(m[1]))));
console.log('width',l2.width,'maxNodeRight',maxNodeRight,'maxPathX',maxPathX);

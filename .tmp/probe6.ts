import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { layoutTopology, unreachableUnits } from '../src/model/layout';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
let t:any=clone();
t.routes={'c-inlet-screen':[{x:20000,y:20000},{x:19000,y:20000}]};
let l=layoutTopology(t);
console.log('route far: width',l.width,'height',l.height,'label',l.edges.find((e:any)=>e.connection.id==='c-inlet-screen')?.labelY, 'path',l.edges.find((e:any)=>e.connection.id==='c-inlet-screen')?.path.slice(0,100));
// recycle flag omitted
t=clone();
const ir=t.connections.find((c:any)=>c.id==='c-aerobic3-anoxic-ir'); delete ir.recycle;
const ras=t.connections.find((c:any)=>c.id==='c-clarifier-anaerobic-ras'); delete ras.recycle;
const sv=sanitizeTopologyInput(t); console.log('recycle omitted sanitize',sv.ok);
if(sv.ok){console.log('unreachable',unreachableUnits(sv.topology));}
// validate warns isolated
t=clone();
t.units.push({id:'orphan',kind:'pump',name:'orphan',role:'',ports:[{id:'in',kind:'in',stream:'influent'},{id:'out',kind:'out',stream:'influent'}]});
t.connections.push({id:'orphan-in',from:{unit:'primary',port:'out'},to:{unit:'orphan',port:'in'},stream:'influent'});
t.connections.push({id:'orphan-out',from:{unit:'orphan',port:'out'},to:{unit:'storage',port:'in'},stream:'influent'});
const sv2=sanitizeTopologyInput(t);console.log('orphan chain sanitize',sv2.ok);
if(sv2.ok) console.log('orphan issues',validateTopology(sv2.topology).map((i:any)=>i.code+':'+i.severity));

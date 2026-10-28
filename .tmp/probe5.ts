import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { createRuntime } from '../src/server/topologyRuntime';
import { numbersAreGrounded } from '../src/ai/llm';
import { buildGroundingText } from '../src/ai/llm';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// isolated island cycle
let t:any=clone();
t.units.push({id:'pumpX',kind:'pump',name:'pumpX',role:'',ports:[{id:'in',kind:'in',stream:'influent'},{id:'out',kind:'out',stream:'influent'}]});
t.units.push({id:'storeX',kind:'storage',name:'storeX',role:'',ports:[{id:'in',kind:'in',stream:'influent'},{id:'out',kind:'out',stream:'influent'}]});
t.connections.push({id:'x1',from:{unit:'pumpX',port:'out'},to:{unit:'storeX',port:'in'},stream:'influent'});
t.connections.push({id:'x2',from:{unit:'storeX',port:'out'},to:{unit:'pumpX',port:'in'},stream:'influent'});
let sv=sanitizeTopologyInput(t); console.log('island sanitize',sv.ok, sv.ok?'':sv.error);
if(sv.ok){console.log('island validate errors',validateTopology(sv.topology).filter((i:any)=>i.severity==='error').map((i:any)=>i.code)); console.log('island readiness',checkRunReadiness(sv.topology).ready,checkRunReadiness(sv.topology).blockers); console.log('island compile',compileNetwork(sv.topology).problems); try{const r=createRuntime(sv.topology); console.log('island createRuntime OK',r.net.reactors.length);}catch(e:any){console.log('island createRuntime ERR',e.message);} }

// disconnected train end
t=clone();
t.connections=t.connections.filter((c:any)=>c.id!=='c-disinfection-outlet');
t.connections.push({id:'dead-end',from:{unit:'disinfection',port:'out'},to:{unit:'thickener',port:'in'},stream:'effluent'});
// outlet fed by storage
t.units.push({id:'storeY',kind:'storage',name:'storeY',role:'',ports:[{id:'in',kind:'in',stream:'effluent'},{id:'out',kind:'out',stream:'effluent'}]});
t.connections.push({id:'y1',from:{unit:'storeY',port:'out'},to:{unit:'outlet',port:'in'},stream:'effluent'});
sv=sanitizeTopologyInput(t); console.log('disconnect sanitize',sv.ok,sv.ok?'':sv.error);
if(sv.ok){console.log('disconnect errors',validateTopology(sv.topology).filter((i:any)=>i.severity==='error').map((i:any)=>i.code));console.log('disconnect ready',checkRunReadiness(sv.topology).ready,checkRunReadiness(sv.topology).blockers);console.log('disconnect compile',compileNetwork(sv.topology).problems);}
// grounding
const g=buildGroundingText({plant:'p',simClock:'D1',facts:[{label:'氨氮',value:0.59,unit:'mg/L'},{label:'COD',value:20}],recommendation:null,risks:[]});
for(const s of ['出水氨氮 11 mg/L。','出水氨氮 11.5 mg/L。','出水氨氮 12 mg/L。','氨氮 42.7 mg/L。']) console.log(s, numbersAreGrounded(s,g));

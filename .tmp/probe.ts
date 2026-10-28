import { PLANT_TOPOLOGY } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { validateTopology } from '../src/model/topology';
import { layoutTopology } from '../src/model/layout';

const clone = () => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// 1. cycle
let t = clone();
t.connections.push({ id: 'cyc', from: {unit:'aerobic1',port:'out'}, to: {unit:'anaerobic',port:'in'}, stream:'mixed_liquor' });
console.log('cycle validate errors', validateTopology(t).filter((i:any)=>i.severity==='error').map((i:any)=>i.code));
const s = sanitizeTopologyInput(t);
console.log('cycle sanitize', s.ok, s.ok ? '' : s.error);
if (s.ok) { try { const c = compileNetwork(s.topology); console.log('compile problems', c.problems); } catch(e:any){console.log('compile throw',e.message)} }
// 2. direction
t = clone();
// add fake connection from an in port to an out port
t.connections.push({ id:'rev', from:{unit:'anaerobic',port:'in'}, to:{unit:'anoxic',port:'out'}, stream:'mixed_liquor' });
console.log('reverse ports validate', validateTopology(t).filter((i:any)=>i.severity==='error').map((i:any)=>i.code));
console.log('reverse sanitize', sanitizeTopologyInput(t).ok);
// 3. empty layout
const empty = { ...clone(), units: [], connections: [], train: [] };
const l = layoutTopology(empty as any);
console.log('empty layout', l.width, l.height, l.nodes.length);
// 4. external mixed liquor edge crash
t = clone();
t.units.push({ id:'pump1', kind:'pump', name:'pump', role:'', ports:[{id:'in',kind:'in',stream:'influent'},{id:'out',kind:'out',stream:'mixed_liquor'}] });
t.connections.push({ id:'p1', from:{unit:'primary',port:'out'}, to:{unit:'pump1',port:'in'}, stream:'influent' });
t.connections.push({ id:'p2', from:{unit:'pump1',port:'out'}, to:{unit:'aerobic1',port:'in'}, stream:'mixed_liquor' });
const sv = sanitizeTopologyInput(t);
console.log('pump sanitize', sv.ok, sv.ok?'':sv.error);
if (sv.ok) { try { const c=compileNetwork(sv.topology); console.log('pump compile problems',c.problems); const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3}); console.log('flows ok',f.edgeFlow.get('p2')); } catch(e:any){ console.log('FLOW CRASH',e.message); } }

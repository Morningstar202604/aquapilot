import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { layoutTopology } from '../src/model/layout';
import { checkRunReadiness } from '../src/sim/topologyEngine';

const clone = () => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// cycle among reactors with compatible streams
let t = clone();
t.connections.push({ id: 'cyc2', from: {unit:'aerobic1',port:'out'}, to: {unit:'anoxic',port:'in'}, stream:'mixed_liquor' });
console.log('reactor cycle errors', validateTopology(t).filter((i:any)=>i.severity==='error').map((i:any)=>i.code), 'sanitize', sanitizeTopologyInput(t).ok, 'ready', checkRunReadiness(t).ready);
if (sanitizeTopologyInput(t).ok) { const c=compileNetwork((sanitizeTopologyInput(t) as any).topology); console.log('compile cycle problems',c.problems); }

// duplicate train
t = clone();
t.train.push('aerobic1');
const sv = sanitizeTopologyInput(t);
console.log('dup train sanitize', sv.ok, sv.ok?'':sv.error);
if (sv.ok) { const c=compileNetwork(sv.topology); console.log('dup train reactors',c.reactors.map((r:any)=>r.id), 'bio',c.bioVolume, 'problems',c.problems, 'order',c.order); }

// layout only blower/chemical
const util = { id:'u', name:'u', train:[], units:[
 {id:'b',kind:'blower',name:'b',role:'',ports:[{id:'out',kind:'out',stream:'air'}]},
 {id:'c',kind:'chemical',name:'c',role:'',ports:[{id:'out',kind:'out',stream:'chemical'}]}
], connections:[] } as any;
const l = layoutTopology(util);
console.log('util-only layout', l.nodes.map(n=>({id:n.unit.id,x:n.x,y:n.y})), 'w/h',l.width,l.height);

// source stream mismatch
t = clone();
t.connections.push({ id:'bad-src', from:{unit:'aerobic1',port:'out'}, to:{unit:'aerobic2',port:'air'}, stream:'air' });
console.log('source stream mismatch errors', validateTopology(t).filter((i:any)=>i.severity==='error').map((i:any)=>i.code), 'sanitize', sanitizeTopologyInput(t).ok);

// recycled forward edge
t = clone();
t.connections.push({ id:'r-forward', from:{unit:'primary',port:'out'}, to:{unit:'aerobic1',port:'in'}, stream:'influent', recycle:true });
const sv2 = sanitizeTopologyInput(t);
console.log('recycle flag on influent sanitize', sv2.ok);
if(sv2.ok){const c=compileNetwork(sv2.topology); const f=resolveFlows(c,2000,{ras:0.8,ir:2,was:0.0085,stepFeed:0.3}); console.log('r-forward flow',f.edgeFlow.get('r-forward'),'reactor inflow anoxic',f.reactorInflow.get('anoxic'));}

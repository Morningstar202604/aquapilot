import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { createRuntime } from '../src/server/topologyRuntime';
import { decide } from '../src/ai/agent';
import { networkModel } from '../src/sim/networkEngine';

const clone = (t:ProcessTopology):ProcessTopology=>JSON.parse(JSON.stringify(t));

// parallel trains reachable in UI
const par = clone(PLANT_TOPOLOGY);
const mk=(id:string,name:string)=>({id,kind:'aerobic' as const,name,role:'硝化',volume:5000,ports:[{id:'in',kind:'in' as const,stream:'mixed_liquor' as const},{id:'out',kind:'out' as const,stream:'mixed_liquor' as const}]});
par.units=par.units.filter(u=>!['aerobic1','aerobic2','aerobic3'].includes(u.id));
par.connections=par.connections.filter(c=>!c.from.unit.startsWith('aerobic')&&!c.to.unit.startsWith('aerobic')&&c.id!=='c-anaerobic-anoxic');
par.train=['anaerobic','anoxic','aerobicA','aerobicB'];
par.units.push(mk('aerobicA','好氧池 A'),mk('aerobicB','好氧池 B'));
par.connections.push(
 {id:'c-anoxic-a',from:{unit:'anoxic',port:'out'},to:{unit:'aerobicA',port:'in'},stream:'mixed_liquor'},
 {id:'c-anoxic-b',from:{unit:'anoxic',port:'out'},to:{unit:'aerobicB',port:'in'},stream:'mixed_liquor'},
 {id:'c-a-clar',from:{unit:'aerobicA',port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'},
 {id:'c-b-clar',from:{unit:'aerobicB',port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'},
);
const rpar = checkRunReadiness(par);
console.log('parallel readiness:', rpar.ready, rpar.blockers);
const cpar = createRuntime(par);
console.log('parallel clarifierFrom:', cpar.compiled.clarifierFrom, 'reactors:', cpar.compiled.reactors.map(r=>r.id+':'+r.order).join(','));

// train reorder: make aerobic1 last
const re = clone(PLANT_TOPOLOGY);
re.train = ['anaerobic','anoxic','aerobic2','aerobic3','aerobic1'];
const rr = checkRunReadiness(re);
console.log('reorder readiness:', rr.ready, rr.blockers, 'warnings:', rr.warnings);
const cr = createRuntime(re);
const base = createRuntime(PLANT_TOPOLOGY);
console.log('reorder clarifierFrom:', cr.compiled.clarifierFrom, 'vs base', base.compiled.clarifierFrom, '| effluent cod', cr.net.effluent.cod.toFixed(2), 'vs', base.net.effluent.cod.toFixed(2), '| nh', cr.net.effluent.nh.toFixed(3), 'vs', base.net.effluent.nh.toFixed(3));

// two clarifiers, wired
const two = clone(PLANT_TOPOLOGY);
two.units.push({id:'clarifier2',kind:'clarifier',name:'二沉池2',role:'泥水分离',area:2400,depth:4.5,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'effluent'}]});
console.log('two-clarifier readiness:', checkRunReadiness(two).ready);

// decide() cost
const model = networkModel(PLANT_TOPOLOGY, base.net);
const t0=performance.now(); for(let i=0;i<10;i++) decide({model, horizonMin:240}); const dt=(performance.now()-t0)/10;
console.log('decide() avg ms:', dt.toFixed(1));

// engine alarm hysteresis?

import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../src/model/topology';
import { checkRunReadiness } from '../src/sim/topologyEngine';
const clone=(t:ProcessTopology):ProcessTopology=>JSON.parse(JSON.stringify(t));

// 1. stream mismatch: screening.influent out -> clarifier.mixed_liquor in
const mm = clone(PLANT_TOPOLOGY);
mm.connections.push({id:'mm',from:{unit:'screening',port:'out'},to:{unit:'clarifier',port:'in'},stream:'influent'});
console.log('stream-mismatch issues:', validateTopology(mm).filter(i=>i.severity==='error').map(i=>i.code));

// 2. duplicate connection
const dup = clone(PLANT_TOPOLOGY);
const c0 = dup.connections[0];
dup.connections.push({...c0, id:'dup'});
console.log('duplicate conn issues:', validateTopology(dup).filter(i=>i.code.includes('DUP')).map(i=>i.code), 'ready:', checkRunReadiness(dup).ready);

// 3. second clarifier added via palette, unconnected
const c2 = clone(PLANT_TOPOLOGY);
c2.units.push({id:'clarifier1',kind:'clarifier',name:'二沉池',role:'泥水分离',area:2400,depth:4.5,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'effluent'},{id:'ras',kind:'out',stream:'return_activated_sludge'},{id:'was',kind:'out',stream:'waste_sludge'}]});
console.log('2nd clarifier errors:', validateTopology(c2).filter(i=>i.severity==='error').length, 'readiness:', checkRunReadiness(c2).ready, 'warnings:', validateTopology(c2).filter(i=>i.severity==='warning').map(i=>i.code));

// 4. remove blower entirely
const nb = clone(PLANT_TOPOLOGY);
nb.units = nb.units.filter(u=>u.kind!=='blower');
nb.connections = nb.connections.filter(c=>c.from.unit!=='blower');
console.log('no blower readiness:', checkRunReadiness(nb).ready, 'blockers:', checkRunReadiness(nb).blockers);

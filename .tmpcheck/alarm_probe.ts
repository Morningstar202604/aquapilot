import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';
import { stepNetwork } from '../src/sim/networkEngine';
const rt = createRuntime(PLANT_TOPOLOGY);
const s = rt.net;
// force a marginal condition: raise influent load
s.scenario = { type:'load_shock', durationMin: 600, magnitude: 1.0, startedAt: s.timeMin } as any;
let before = s.alarms.length;
for (let i=0;i<120;i++) stepNetwork(s, PLANT_TOPOLOGY, 10);
console.log('alarms after 20h sim:', s.alarms.length, 'new:', s.alarms.length-before);
const codes = new Map<string, number>();
for (const a of s.alarms) codes.set(a.code, (codes.get(a.code)??0)+1);
console.log('by code:', [...codes.entries()].slice(0,10));
console.log('first 6:', s.alarms.slice(-6).map(a=>`${a.code}@${a.at}`).join(', '));
console.log('alarm array capped? last id', s.alarms[s.alarms.length-1]?.id);

import { conservationResiduals, reactionRates, emptyAsm1State, ASM1_PARAMS } from '../src/sim/asm1';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { PLANT_TOPOLOGY } from '../src/model/topology';

const rows = conservationResiduals();
console.log('--- conservation residuals ---');
for (const r of rows) console.log(r.process, 'cod=', r.cod.toFixed(6), 'n=', r.n.toFixed(6), 'alk=', r.alk.toExponential(2));

const net = compileNetwork(PLANT_TOPOLOGY);
console.log('problems:', net.problems);
const f = resolveFlows(net, 2000, { ras: 0.8, ir: 2.0, was: 0.022, stepFeed: 0.3 });
console.log('--- edge flows ---');
for (const e of net.edges) console.log(e.id, e.stream, (f.edgeFlow.get(e.id) ?? NaN).toFixed(2));
console.log('--- reactor inflow ---');
for (const [k, v] of f.reactorInflow) console.log(k, v.toFixed(2));
console.log('--- reactor outflow ---');
for (const [k, v] of f.reactorOutflow) console.log(k, v.toFixed(2));
console.log('total outflow of last reactor', f.reactorOutflow.get('aerobic3'));

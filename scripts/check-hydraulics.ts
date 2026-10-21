import { PLANT_TOPOLOGY } from '../src/model/topology';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { INFLUENT_DESIGN, DEFAULT_CONTROLS } from '../src/sim/config';

const net = compileNetwork(PLANT_TOPOLOGY);
const Q = INFLUENT_DESIGN.flow;
const f = resolveFlows(net, Q, { ras: DEFAULT_CONTROLS.rasRatio, ir: DEFAULT_CONTROLS.internalRecirc, was: DEFAULT_CONTROLS.wasRatio });

console.log(`Q=${Q}  RAS=${DEFAULT_CONTROLS.rasRatio}  IR=${DEFAULT_CONTROLS.internalRecirc}\n`);
for (const r of net.reactors) {
  const q = f.reactorInflow.get(r.id) ?? 0;
  console.log(`${r.name.padEnd(8)} V=${String(r.volume).padStart(5)} Q=${q.toFixed(0).padStart(5)} HRT=${(r.volume / q).toFixed(2)}h (按进水 ${(r.volume / Q).toFixed(2)}h)`);
}
console.log('\n真实 A²/O 的池内 HRT（考虑内回流）：');
console.log('  厌氧: V/(Q+Qr)  缺氧: V/(Q+Qr+Qir)  好氧: V/(Q+Qr+Qir)');
console.log('  以 3000 m³ 厌氧池为例: 3000/(1573+1258) =', (3000 / (1573 + 1258)).toFixed(2), 'h  ← 合理');
console.log('  但好氧池 5000/(1573+1258+3146) =', (5000 / (1573 + 1258 + 3146)).toFixed(2), 'h  ← 也合理');
console.log('\n问题：ASM1 的生物量增长需要 SRT，而 SRT 由回流维持，不是 HRT。');
console.log('当前 SRT 由排泥决定，但生物量还是流失了 → 说明二沉池没有把生物量截留住。');

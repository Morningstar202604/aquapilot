import { BSM1_SETTLER, stepSettler, createSettler } from '../src/sim/takacs';

console.log('=== 非法几何不得挂死 ===');
for (const [label, cfg] of [
  ['depth=0', { ...BSM1_SETTLER, area: 1500, depth: 0 }],
  ['area=0', { ...BSM1_SETTLER, area: 0, depth: 4 }],
  ['depth=NaN', { ...BSM1_SETTLER, area: 1500, depth: NaN }],
] as const) {
  const t0 = Date.now();
  const r = stepSettler(createSettler({ ...cfg, depth: Math.max(0.001, cfg.depth) }), cfg as never, { flow: 1000, concentration: 3000 }, { flow: 800 }, 1 / 1440);
  console.log(`  ${label.padEnd(12)} 返回 ${Date.now() - t0}ms  xEff=${r.xEffluent.toFixed(1)}`);
}

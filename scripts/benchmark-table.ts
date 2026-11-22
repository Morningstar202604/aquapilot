/**
 * 生成 BSM1 Table 6 对照表（Markdown）。
 *
 * 用途：README / docs/BENCHMARKS.md 里的数字必须能由一条命令复现。
 * 运行 `npx tsx scripts/benchmark-table.ts`，把输出贴回文档；CI 另有
 * tests/docsConsistency.test.ts 锁住文档与基准表之间的偏差。
 */
import { BSM1_TABLE6_EFFLUENT, runBsm1OpenLoopSteady } from '../src/sim/bsm1';
import { toConventional } from '../src/sim/asm1Cstr';

const result = runBsm1OpenLoopSteady();
const conventional = toConventional(result.effluent);

const pct = (actual: number, official: number) => `${((actual / official - 1) * 100).toFixed(1)} %`;
const rows: [string, number, number, string][] = [
  ['S_S (g COD/m³)', result.effluent.S_S, BSM1_TABLE6_EFFLUENT.S_S, '±10 %'],
  ['S_NO (g N/m³)', result.effluent.S_NO, BSM1_TABLE6_EFFLUENT.S_NO, '±10 %'],
  ['S_NH (g N/m³)', result.effluent.S_NH, BSM1_TABLE6_EFFLUENT.S_NH, '±25 %'],
  ['S_ALK (mol/m³)', result.effluent.S_ALK, BSM1_TABLE6_EFFLUENT.S_ALK, '±10 %'],
  ['S_O (g O₂/m³)', result.effluent.S_O, BSM1_TABLE6_EFFLUENT.S_O, '±20 %'],
  ['TSS (g/m³)', conventional.ss, BSM1_TABLE6_EFFLUENT.tss, 'known settler limit'],
];

console.log(`Converged: ${result.converged} after ${result.steadyDays} simulated days`);
console.log('');
console.log('| Metric | Engine | Official | Deviation | Gate |');
console.log('|---|---:|---:|---:|---|');
for (const [name, actual, official, gate] of rows) {
  console.log(`| ${name} | ${actual.toFixed(3)} | ${official} | ${pct(actual, official)} | ${gate} |`);
}

import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';

const clone = () => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
const summarize = (label: string, rt: ReturnType<typeof createRuntime>) => {
  const n = rt.net;
  console.log(`${label}: 反应器 ${n.reactors.length} | 池容 ${(n.volume.bio / 1000).toFixed(1)}k m³ | 出水 COD ${n.effluent.cod.toFixed(1)} NH₄ ${n.effluent.nh.toFixed(2)} TP ${n.effluent.tp.toFixed(3)} | 泥位 ${n.clarifier.blanketM.toFixed(2)} m`);
  return n;
};

const base = summarize('标准厂', createRuntime(PLANT_TOPOLOGY));

const doubled = clone();
for (const u of doubled.units) if (u.kind === 'aerobic') u.volume = (u.volume ?? 0) * 2;
const big = summarize('好氧池 ×2', createRuntime(doubled));

const halved = clone();
for (const u of halved.units) if (u.kind === 'aerobic') u.volume = Math.round((u.volume ?? 0) / 2);
const small = summarize('好氧池 ÷2', createRuntime(halved));

const bigClar = clone();
bigClar.units.find((u: { kind: string }) => u.kind === 'clarifier')!.area = 4800;
const clar = summarize('二沉池 2400→4800', createRuntime(bigClar));

console.log('\n=== 结论 ===');
console.log(`池容变化 → 影响出水氨氮: ${Math.abs(small.effluent.nh - base.effluent.nh) > 0.01}`);
console.log(`好氧池扩容 → 氨氮下降: ${big.effluent.nh <= base.effluent.nh + 0.02}`);
console.log(`二沉池扩容 → 固体负荷下降: ${clar.clarifier.slr < base.clarifier.slr * 0.75}`);
console.log(`二沉池扩容 → 泥位变薄: ${clar.clarifier.blanketM < base.clarifier.blanketM}`);

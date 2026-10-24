import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';
import { createShadowPlant, stepShadow, summarizeBenchmark } from '../src/server/benchmark';
import { networkModel, stepNetwork } from '../src/sim/networkEngine';
import { decide } from '../src/ai/agent';

/**
 * 可复现的双跑对照：AI 值守 vs 固定策略，同一 seed、同一进水。
 *
 * 默认跑 2 个仿真日（96 个 30 分钟决策周期）。输出刻意只打真实累计量，
 * 不做年化外推——年化需要假设负荷不变，那是另一件事。
 */

const DAYS = Number(process.env.BENCH_DAYS ?? 2);
const seed = 20261019;
const rt = createRuntime(PLANT_TOPOLOGY, seed);
const shadow = createShadowPlant(PLANT_TOPOLOGY, seed, rt.net.timeMin);

const cycles = Math.round((DAYS * 1440) / 30);
for (let c = 0; c < cycles; c++) {
  const rec = decide({ model: networkModel(rt.topology, rt.net), horizonMin: 240, robust: false });
  if (rt.net.controls.aiEnabled && rec.action !== 'hold') {
    rt.net.controls = { ...rec.chosens.controls, aiEnabled: true };
  }
  for (let m = 0; m < 30; m++) {
    stepNetwork(rt.net, rt.topology, 1);
    stepShadow(shadow, rt.net, 1, rt.topology);
  }
}

const b = summarizeBenchmark(shadow.benchmark);
const pct = (x: number) => (x * 100).toFixed(1);
const aiCompliance = b.ai.compliantMinutes / Math.max(1, b.ai.minutes);
const manualCompliance = b.manual.compliantMinutes / Math.max(1, b.manual.minutes);
const aiScore = b.ai.scoreSum / Math.max(1, b.ai.minutes);
const manualScore = b.manual.scoreSum / Math.max(1, b.manual.minutes);

console.log(`双跑对照（${DAYS} 仿真日，seed ${seed}，${cycles} 个决策周期）`);
console.log('');
console.log('指标                      AI 值守      固定策略      差值');
console.log(
  `出水合规率 %          ${pct(aiCompliance).padStart(10)}  ${pct(manualCompliance).padStart(10)}  ${(b.complianceDeltaPct >= 0 ? '+' : '') + b.complianceDeltaPct.toFixed(1)} pct`,
);
console.log(
  `吨水电耗 kWh/m³       ${b.ai.specificKwhM3.toFixed(3).padStart(10)}  ${b.manual.specificKwhM3.toFixed(3).padStart(10)}  ${b.specificEnergyDelta.toFixed(3)}`,
);
console.log(
  `吨水成本 元/m³        ${(b.ai.cost / Math.max(1, b.ai.inflowM3)).toFixed(4).padStart(10)}  ${(b.manual.cost / Math.max(1, b.manual.inflowM3)).toFixed(4).padStart(10)}  ${b.costDeltaPct.toFixed(1)}%`,
);
console.log(
  `平均出水评分          ${aiScore.toFixed(1).padStart(10)}  ${manualScore.toFixed(1).padStart(10)}  ${b.scoreDelta.toFixed(1)}`,
);
console.log('');
console.log('当前主厂出水：', {
  cod: +rt.net.effluent.cod.toFixed(2),
  nh: +rt.net.effluent.nh.toFixed(3),
  tn: +rt.net.effluent.tn.toFixed(2),
  tp: +rt.net.effluent.tp.toFixed(3),
  ss: +rt.net.effluent.ss.toFixed(2),
});
console.log('污泥龄 d:', +rt.net.srtDays.toFixed(1), 'MLSS mg/L:', Math.round((rt.net.biomassKg * 1000) / rt.net.volume.bio));

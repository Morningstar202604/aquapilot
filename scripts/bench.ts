import { decide } from '../src/ai/agent';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

/**
 * 性能基准（全部跑生产引擎）。
 *
 * 旧版本同时测固定五池参考引擎与拓扑引擎，读者无法判断哪个数字对应线上；
 * 参考引擎已退居 cross-engine 一致性测试，这里只测真正服务的那条路径。
 */

const prodState = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 10);
const prodModel = networkModel(PLANT_TOPOLOGY, prodState);

{
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 5);
  const N = 20000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
  const per = (performance.now() - t0) / N;
  console.log(
    `单步仿真: ${per.toFixed(4)} ms/step → ${(1000 / per).toFixed(0)} step/s → 单核可实时模拟 ${(1000 / per / 1440).toFixed(1)} 座厂（1 min 步长）`,
  );
}

{
  const N = 30;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) prodModel.predict(prodState.controls, 240, 30);
  const per = (performance.now() - t0) / N;
  console.log(`单次 4h 预测: ${per.toFixed(2)} ms`);
}

{
  const N = 10;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) decide({ model: prodModel, horizonMin: 240, robust: false });
  const per = (performance.now() - t0) / N;
  console.log(`单次决策（名义）: ${per.toFixed(1)} ms（含 ~17 个候选 × 4h 预测）`);
}

{
  const N = 5;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) decide({ model: prodModel, horizonMin: 240 });
  const robust = (performance.now() - t0) / N;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) decide({ model: prodModel, horizonMin: 240, robust: false });
  const nominal = (performance.now() - t1) / N;
  console.log(`生产引擎决策（鲁棒）: ${robust.toFixed(1)} ms/次 · 名义: ${nominal.toFixed(1)} ms/次`);
}

{
  const t0 = performance.now();
  spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 2 }), PLANT_TOPOLOGY, 30);
  console.log(`30 天预热: ${(performance.now() - t0).toFixed(0)} ms`);
}

const mem = process.memoryUsage();
console.log(`内存: heapUsed ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / rss ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);

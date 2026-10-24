import { createInitialState, forecast, spinUp, step } from '../src/sim/engine';
import { decide } from '../src/ai/agent';
import { legacyModel } from '../src/sim/plantModel';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';

const warm = spinUp(createInitialState({ seed: 1 }), 5);
const prodState = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 10);
const prodModel = networkModel(PLANT_TOPOLOGY, prodState);

{
  const s = createInitialState({ seed: 1 });
  const N = 20000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step(s, 1);
  const per = (performance.now() - t0) / N;
  console.log(`单步仿真: ${per.toFixed(4)} ms/step  →  ${(1000 / per).toFixed(0)} step/s  →  单核可实时模拟 ${(1000 / per / 1440).toFixed(1)} 座厂（1 min 步长）`);
}

{
  const N = 30;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) forecast(warm, warm.controls, 240, 30);
  const per = (performance.now() - t0) / N;
  console.log(`单次 4h 预测: ${per.toFixed(2)} ms`);
}

{
  const N = 10;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    decide({ model: legacyModel(warm, forecast), horizonMin: 240 });
  }
  const per = (performance.now() - t0) / N;
  console.log(`单次决策: ${per.toFixed(2)} ms（含 ~17 个候选 × 4h 预测）`);
  console.log(`蒙特卡洛 100 次扰动重算决策预估: ${(per * 100 / 1000).toFixed(1)} s`);
}

{
  // 生产引擎 + 鲁棒评估：服务端实际运行的那一条路径
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
  spinUp(createInitialState({ seed: 2 }), 30);
  console.log(`30 天预热(spinUp): ${(performance.now() - t0).toFixed(0)} ms`);
}

const mem = process.memoryUsage();
console.log(`内存: heapUsed ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / rss ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);

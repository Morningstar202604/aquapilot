import { createInitialState, forecast, spinUp, step } from '../src/sim/engine';
import { decide } from '../src/ai/agent';
import { legacyModel } from '../src/sim/plantModel';

const warm = spinUp(createInitialState({ seed: 1 }), 5);

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
  let count = 0;
  for (let i = 0; i < N; i++) {
    const rec = decide({ model: legacyModel(warm, forecast), horizonMin: 240 });
    count = 1 + rec.alternatives.length;
  }
  const per = (performance.now() - t0) / N;
  console.log(`单次决策: ${per.toFixed(2)} ms（含 ~17 个候选 × 4h 预测）`);
  console.log(`蒙特卡洛 100 次扰动重算决策预估: ${(per * 100 / 1000).toFixed(1)} s`);
}

{
  const t0 = performance.now();
  const s = spinUp(createInitialState({ seed: 2 }), 30);
  console.log(`30 天预热(spinUp): ${(performance.now() - t0).toFixed(0)} ms`);
}

const mem = process.memoryUsage();
console.log(`内存: heapUsed ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / rss ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);

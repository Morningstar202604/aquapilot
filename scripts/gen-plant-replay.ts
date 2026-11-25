/**
 * 生成整厂 production trace golden。
 *
 * 运行方式：`npx tsx scripts/gen-plant-replay.ts`
 *
 * 不是把模块函数单拉出来摆场景：这里跑的是真实 `spinUpNetwork` + `stepNetwork`，
 * trace hook 在引擎内部捕获每一步**实际送入** ASM2d 网络、Takács、泥线和三本账的
 * 输入与回写结果。Rust `plant_replay_parity.rs` 按同一批输入逐步复算。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import type { NetworkStepTrace } from '../src/sim/networkTrace';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../rust/golden/plant-replay-96step.json');

const state = createNetworkState(PLANT_TOPOLOGY, { seed: 21, model: 'asm2d', plantEnabled: true });
spinUpNetwork(state, PLANT_TOPOLOGY, 20);
state.controls.carbonDose = 8;

const steps: NetworkStepTrace[] = [];
for (let i = 0; i < 96; i++) {
  stepNetwork(state, PLANT_TOPOLOGY, 15, (step) => steps.push(step));
}

const missing = steps.filter(
  (s) => !s.asm2d || !s.settlers?.length || !s.sludge || !s.balance || !s.inventory || !s.effluent || !s.biomass,
);
if (missing.length) {
  throw new Error(`trace 不完整：${missing.length} 步缺模块，首步 ${missing[0]?.timeMin}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    plant: PLANT_TOPOLOGY.id,
    seed: 21,
    spinUpDays: 20,
    dtMin: 15,
    carbonDose: 8,
    steps,
  }),
);
console.log(`wrote ${out}: ${steps.length} steps, ${(JSON.stringify(steps).length / 1024).toFixed(0)} KiB`);

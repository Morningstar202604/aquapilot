import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';
import { decide } from '../src/ai/agent';
import { networkModel, spinUpNetwork, createNetworkState } from '../src/sim/networkEngine';

const rt = createRuntime(PLANT_TOPOLOGY);
const model = networkModel(rt.topology, rt.net);

let t0 = performance.now();
for (let i = 0; i < 5; i++) decide({ model, horizonMin: 240 });
console.log(`decide() 平均耗时: ${((performance.now() - t0) / 5).toFixed(0)}ms`);

t0 = performance.now();
createRuntime(PLANT_TOPOLOGY);
console.log(`createRuntime (含 30 天预热): ${(performance.now() - t0).toFixed(0)}ms`);

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 1 }), PLANT_TOPOLOGY, 20);
t0 = performance.now();
for (let i = 0; i < 100; i++) model.predict(s.controls, 240, 30);
console.log(`predict(4h) 平均: ${((performance.now() - t0) / 100).toFixed(1)}ms`);

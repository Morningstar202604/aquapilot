import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, 20);
console.log(`预热后: today ¥${s.costToday.total.toFixed(0)} / 累计 ¥${s.cost.total.toFixed(0)} | timeMin ${s.timeMin} lastDay ${s.lastDay}`);

// 推进一整天
for (let i = 0; i < 1440; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
console.log(`+1 天(1440min): today ¥${s.costToday.total.toFixed(0)} / 累计 ¥${s.cost.total.toFixed(0)} | timeMin ${s.timeMin} lastDay ${s.lastDay}`);

// 再推进 12 小时（跨过 0 点）
for (let i = 0; i < 720; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
console.log(`+1.5 天: today ¥${s.costToday.total.toFixed(0)} / 累计 ¥${s.cost.total.toFixed(0)} | timeMin ${s.timeMin} lastDay ${s.lastDay}`);

// 再推进一整天（确认再次重置）
for (let i = 0; i < 1440; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
console.log(`+2.5 天: today ¥${s.costToday.total.toFixed(0)} / 累计 ¥${s.cost.total.toFixed(0)} | timeMin ${s.timeMin} lastDay ${s.lastDay}`);
console.log(`\n判定: today 应明显小于累计 = ${s.costToday.total < s.cost.total}`);

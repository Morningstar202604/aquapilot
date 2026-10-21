import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState } from '../src/sim/networkEngine';

console.log('=== 控制量是否真正生效 ===');
for (const [label, controls] of [
  ['默认', {}],
  ['DO 1.2', { doSetpoint: 1.2 }],
  ['DO 3.5', { doSetpoint: 3.5 }],
  ['内回流 0.5', { internalRecirc: 0.5 }],
] as const) {
  const s = createNetworkState(PLANT_TOPOLOGY, { seed: 1, controls });
  console.log(`  ${label.padEnd(12)} doSetpoint=${s.controls.doSetpoint}  internalRecirc=${s.controls.internalRecirc}  wasRatio=${s.controls.wasRatio}`);
}

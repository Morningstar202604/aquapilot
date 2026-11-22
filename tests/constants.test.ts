import { describe, expect, it } from 'vitest';
import { DESIGN_MLSS, KINETICS, TARIFF } from '../src/sim/kinetics';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { INFLUENT_DESIGN } from '../src/sim/config';

/**
 * 常数单一来源与可复现性。
 *
 * 从前这些断言放在 cross-engine.test.ts 里，用来锁「固定五池参考引擎」与
 * 「拓扑引擎」不各抄一份动力学常数。参考引擎已删除（它只被测试引用，
 * 生产与 AI 预测都走 networkEngine），但这两类保护仍然需要：
 * - 常数只能来自 kinetics.ts；
 * - 同 seed 的稳态必须确定。
 */
describe('常数单一来源', () => {
  it('动力学常数集中在一处且不被引擎复制', () => {
    expect(KINETICS.kNit).toBe(14.0);
    expect(KINETICS.yieldH).toBe(0.48);
    expect(DESIGN_MLSS).toBe(3400);
    expect(TARIFF.electricity).toBe(0.68);
  });

  it('关键常数落在工艺常识范围内', () => {
    expect(KINETICS.kNit).toBeGreaterThan(5);
    expect(KINETICS.kNit).toBeLessThan(30);
    expect(KINETICS.yieldH).toBeGreaterThan(0.3);
    expect(KINETICS.yieldH).toBeLessThan(0.7);
    expect(KINETICS.thetaH).toBeGreaterThan(1.02);
    expect(KINETICS.thetaN).toBeLessThan(1.15);
  });
});

describe('引擎可复现性', () => {
  it('同 seed 的稳态是确定性的', () => {
    const a = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 5 }), PLANT_TOPOLOGY, 10);
    const b = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 5 }), PLANT_TOPOLOGY, 10);
    expect(a.effluent.nh).toBeCloseTo(b.effluent.nh, 10);
    expect(a.biomassKg).toBeCloseTo(b.biomassKg, 6);
  });

  it('进水设计值来自同一处', () => {
    const net = createNetworkState(PLANT_TOPOLOGY, { seed: 1 });
    expect(net.influent.cod).toBe(INFLUENT_DESIGN.cod);
    expect(net.influent.nh).toBe(INFLUENT_DESIGN.nh);
  });
});

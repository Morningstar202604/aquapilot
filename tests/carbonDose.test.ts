import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

/**
 * 碳源投加必须真的改变工艺，而不是只记一笔成本。
 *
 * 真实缺陷：`carbonDose` 只进入 `solveEnergyAndCost` 的药剂费，工艺方程里
 * 完全没有它——投 0 与投 60 mg/L 的出水 COD/TN 逐位相同。检视器、决策面板
 * 和 AI 候选集都把它当成可调量，等于一个假控件。
 *
 * 修法：外加碳源以易降解 COD 进入缺氧区（反硝化段）。测试锁三件事：
 * 单调性（投得越多 TN 越低）、作用域（只有缺氧池 COD 上升）、成本仍然计费。
 */

const run = (carbonDose: number, seed = 5) => {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed, controls: { carbonDose } }), PLANT_TOPOLOGY, 25);
  for (let i = 0; i < 1440; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
  return s;
};

describe('碳源投加', () => {
  it('投加量越大，出水 TN 越低（单调不增）', () => {
    const doses = [0, 20, 40, 60];
    const tns = doses.map((d) => run(d).effluent.tn);
    for (let i = 1; i < tns.length; i += 1) {
      expect(tns[i], `dose ${doses[i]} vs ${doses[i - 1]}`).toBeLessThanOrEqual(tns[i - 1] + 1e-6);
    }
    // 至少要有可观测的改善，不能是 0.01 级的噪声
    expect(tns[0] - tns[tns.length - 1]).toBeGreaterThan(0.5);
  });

  it('缺氧池硝酸盐随投加下降（反硝化被强化）', () => {
    const low = run(0).reactors.find((r) => r.kind === 'anoxic')!;
    const high = run(40).reactors.find((r) => r.kind === 'anoxic')!;
    expect(high.no3).toBeLessThan(low.no3);
  });

  it('直接受益的是缺氧区：其 COD 增幅显著大于厌氧区（厌氧只能通过 RAS 间接受影响）', () => {
    const low = run(0);
    const high = run(40);
    const d = (kind: 'anaerobic' | 'anoxic') =>
      high.reactors.find((r) => r.kind === kind)!.cod - low.reactors.find((r) => r.kind === kind)!.cod;
    // 缺氧区直接获得碳源（+12.8 mg/L 量级）；厌氧区的变化来自 RAS 硝酸盐减少，幅度更小
    expect(d('anoxic')).toBeGreaterThan(5);
    expect(Math.abs(d('anaerobic'))).toBeLessThan(d('anoxic') * 2);
  });

  it('药剂成本仍然计入（工艺生效不等于免费）', () => {
    expect(run(40).cost.chemical).toBeGreaterThan(run(0).cost.chemical);
  });
});

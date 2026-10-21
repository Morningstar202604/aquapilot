import { describe, expect, it } from 'vitest';
import { decide, answer } from '../src/ai/agent';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';
import { CONTROL_BOUNDS } from '../src/sim/config';

/**
 * 生产路径的 AI 测试。
 *
 * 为什么单独一组：原有 tests/agent.test.ts 全部使用 legacyModel（已淘汰的固定五池引擎），
 * 而服务端实际运行的是 networkModel。护栏与决策逻辑必须在**真实使用的引擎**上验证，
 * 否则测的是一个不会被部署的实现。
 */

function productionPlant(seed = 42) {
  const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 25);
  return { state, model: networkModel(PLANT_TOPOLOGY, state) };
}

describe('AI 在生产引擎上的护栏', () => {
  it('DO 设定不低于工艺下限', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(1.5);
  });

  it('PAC 不跌破化学除磷底线', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.chosens.controls.pacDose).toBeGreaterThanOrEqual(18);
  });

  it('所有控制量在物理边界内', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    for (const [key, value] of Object.entries(rec.chosens.controls)) {
      if (key === 'aiEnabled') continue;
      const b = CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS];
      expect(value).toBeGreaterThanOrEqual(b.min);
      expect(value).toBeLessThanOrEqual(b.max);
    }
  });

  it('预测不污染实时状态', () => {
    const { state, model } = productionPlant();
    const before = JSON.stringify(state);
    decide({ model, horizonMin: 120 });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('决策确定性：同一状态两次结果一致', () => {
    const { model } = productionPlant();
    const a = decide({ model, horizonMin: 120 });
    const b = decide({ model, horizonMin: 120 });
    expect(a.chosens.controls).toEqual(b.chosens.controls);
    expect(a.summary).toBe(b.summary);
  });

  it('方案区分度在 0–1 之间', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.separation).toBeGreaterThan(0.3);
    expect(rec.separation).toBeLessThanOrEqual(1);
  });

  it('每个调整项都有可读理由且确实发生了变化', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    for (const t of rec.tweaks) {
      expect(t.reason.length).toBeGreaterThan(8);
      expect(t.to).not.toBe(t.from);
    }
  });

  it('候选方案按分数降序，最优在首位', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    const scores = [rec.chosens.score, ...rec.alternatives.map((a) => a.score)];
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1] + 1e-9);
    }
  });
});

describe('AI 问答在生产引擎上', () => {
  it('状态问答引用真实出水数据', () => {
    const { state, model } = productionPlant();
    const a = answer('现在运行怎么样', model, null);
    expect(a.kind).toBe('status');
    expect(a.body).toContain(state.effluent.nh.toFixed(2));
  });

  it('假设推演不改变实时状态', () => {
    const { state, model } = productionPlant();
    const before = JSON.stringify(state);
    const a = answer('如果发生暴雨会怎样', model, null);
    expect(a.kind).toBe('whatif');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('无法识别的问题给出可用问法', () => {
    const { model } = productionPlant();
    const a = answer('今天午饭吃什么', model, null);
    expect(a.kind).toBe('unknown');
    expect(a.bullets.length).toBeGreaterThan(0);
  });
});

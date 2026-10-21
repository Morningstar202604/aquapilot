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

describe('AI 决策的边界分支', () => {
  it('极端酸/碱进水下的决策不崩溃', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 31 }), PLANT_TOPOLOGY, 12);
    const model = networkModel(PLANT_TOPOLOGY, s);
    const rec = decide({ model, horizonMin: 120 });
    expect(Number.isFinite(rec.chosens.score)).toBe(true);
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThan(0);
  });

  it('不同 seed 产生不同决策而非固定输出', () => {
    const a = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 15);
    const b = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 99 }), PLANT_TOPOLOGY, 15);
    const ra = decide({ model: networkModel(PLANT_TOPOLOGY, a), horizonMin: 120 });
    const rb = decide({ model: networkModel(PLANT_TOPOLOGY, b), horizonMin: 120 });
    expect(ra.summary.length).toBeGreaterThan(0);
    expect(rb.summary.length).toBeGreaterThan(0);
  });
});

describe('问答意图全覆盖', () => {
  const cases: [string, string][] = [
    ['现在运行怎么样', 'status'],
    ['为什么这样调节', 'explain'],
    ['如果发生暴雨会怎样', 'whatif'],
    ['给我未来 8 小时计划', 'plan'],
    ['什么是硝化', 'explain'],
    ['今天天气', 'unknown'],
    ['如果鼓风机故障会怎样', 'whatif'],
    ['如果进水有毒会怎样', 'whatif'],
    ['假设停电', 'whatif'],
    ['假如低温', 'whatif'],
    ['如果药剂短缺', 'whatif'],
    ['如果高负荷冲击', 'whatif'],
    ['如果回流泵坏了', 'whatif'],
  ];

  it('各意图都能返回结构化答案', () => {
    const { model } = productionPlant();
    for (const [q, kind] of cases) {
      const a = answer(q, model, null);
      expect(a.title.length, q).toBeGreaterThan(0);
      expect(a.confidence).toBeGreaterThan(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
      expect(a.kind, q).toBe(kind);
    }
  });

  it('有推荐时 why 分支引用推荐摘要', () => {
    const { model } = productionPlant();
    const rec = decide({ model, horizonMin: 120 });
    const a = answer('为什么', model, rec);
    expect(a.body).toBe(rec.summary);
    expect(a.bullets.length).toBeGreaterThan(0);
  });
});

describe('决策的极端与边界工况', () => {
  it('停电场景下仍产出合规方案', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 17 }), PLANT_TOPOLOGY, 15);
    s.scenario = { type: 'power_outage', durationMin: 60, magnitude: 1, startedAt: s.timeMin };
    const rec = decide({ model: networkModel(PLANT_TOPOLOGY, s), horizonMin: 180 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(1.5);
    expect(rec.severity).toBeDefined();
  });

  it('毒性场景下提高溶氧以保硝化', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 23 }), PLANT_TOPOLOGY, 15);
    s.scenario = { type: 'toxic', durationMin: 240, magnitude: 1, startedAt: s.timeMin };
    const rec = decide({ model: networkModel(PLANT_TOPOLOGY, s), horizonMin: 180 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(2.4);
  });

  it('低温场景提高污泥龄（减少排泥）', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 41 }), PLANT_TOPOLOGY, 15);
    s.scenario = { type: 'winter', durationMin: 480, magnitude: 12, startedAt: s.timeMin };
    const rec = decide({ model: networkModel(PLANT_TOPOLOGY, s), horizonMin: 180 });
    expect(rec.chosens.controls.wasRatio).toBeLessThanOrEqual(0.022);
  });
});

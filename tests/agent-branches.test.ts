import { describe, expect, it } from 'vitest';
import { answer, decide } from '../src/ai/agent';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';

/**
 * AI 回答的分支覆盖。
 *
 * 重点不是"问句能不能答"，而是**答不出来时是否给出可执行的下一步**——
 * 未知场景、未知问题、无推荐这三种情况最容易被写成"抱歉"，那对操作员毫无用处。
 */

const model = () =>
  networkModel(PLANT_TOPOLOGY, spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 9 }), PLANT_TOPOLOGY, 5));

describe('假设推演的分支', () => {
  it('提到暴雨时走 whatif 并给出推演结论', () => {
    const a = answer('如果发生暴雨会怎样', model(), null);
    expect(a.kind).toBe('whatif');
    expect(a.title).toContain('假设推演');
    expect(a.bullets.length).toBeGreaterThan(2);
  });

  it('识别不出场景时告诉用户该怎么问', () => {
    const a = answer('如果明天涨工资会怎样', model(), null);
    expect(a.kind).toBe('unknown');
    expect(a.body).toContain('暴雨');
    expect(a.confidence).toBeLessThan(0.7);
  });

  it('毒性场景会被识别', () => {
    const a = answer('如果进水有毒会怎样', model(), null);
    expect(a.title).toMatch(/毒性|抑制/);
  });
});

describe('计划与解释分支', () => {
  it('没有推荐时计划给出滚动生成说明', () => {
    const a = answer('给我未来 8 小时计划', model(), null);
    expect(a.kind).toBe('plan');
    expect(a.body).toContain('滚动');
  });

  it('有推荐时计划引用推荐摘要', () => {
    const m = model();
    const rec = decide({ model: m, horizonMin: 240 });
    const a = answer('下一步安排', m, rec);
    expect(a.kind).toBe('plan');
    expect(a.body.length).toBeGreaterThan(0);
  });

  it('原理类问题给出工艺解释', () => {
    const a = answer('解释一下什么是硝化', model(), null);
    expect(a.kind).toBe('explain');
    expect(a.bullets.length).toBeGreaterThan(2);
  });
});

describe('状态问答', () => {
  it('现在怎么样返回评分与最紧指标', () => {
    const a = answer('现在运行怎么样', model(), null);
    expect(a.kind).toBe('status');
    expect(a.confidence).toBeGreaterThan(0.8);
  });

  it('为什么这样调在没有推荐时给出等待说明而不是空答案', () => {
    const a = answer('为什么这样调节', model(), null);
    expect(a.body).toContain('决策周期');
    expect(a.confidence).toBeLessThan(0.6);
  });
});

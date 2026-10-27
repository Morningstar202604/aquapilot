import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { buildTankStates } from '../src/server/tankStates';

/**
 * 分池 MLSS 的口径。
 *
 * 真实问题：简化模型只有一个全局生物量，快照却把它平摊给每个池子——
 * 界面上五个池全部显示 2475 mg/L，看起来像"每池实测"。真实厂里厌氧、
 * 缺氧、好氧的污泥浓度并不相同。这里锁住两件事：
 * 1. 简化模式必须如实标注为「全厂均值」，不能伪装成分池测量；
 * 2. ASM1 模式有分池组分，必须给出真实的分池浓度。
 */

describe('分池 MLSS', () => {
  it('简化模式：所有池同值且标记为全厂均值', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 25);
    const tanks = buildTankStates(s);
    const values = new Set(tanks.map((t) => t.mlss));
    expect(values.size).toBe(1);
    const expected = Math.round((s.biomassKg * 1000) / Math.max(1, s.volume.bio));
    expect(tanks[0].mlss).toBe(expected);
    for (const t of tanks) expect(t.mlssSource).toBe('plant-average');
  });

  it('ASM1 模式：按池内颗粒组分给出分池浓度，并标记为 reactor', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7, model: 'asm1' }), PLANT_TOPOLOGY, 25);
    const tanks = buildTankStates(s);
    for (const t of tanks) expect(t.mlssSource).toBe('reactor');
    // 不同池的浓度不应全部相同（厌氧/缺氧 vs 好氧）
    const values = tanks.map((t) => t.mlss);
    expect(new Set(values).size).toBeGreaterThan(1);
    // 量级合理：500–8000 mg/L
    for (const v of values) {
      expect(v).toBeGreaterThan(500);
      expect(v).toBeLessThan(8000);
    }
  });

  it('ASM1 分池值与组分换算一致（1.42 gCOD/gVSS）', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 9, model: 'asm1' }), PLANT_TOPOLOGY, 20);
    const tanks = buildTankStates(s);
    for (const tank of tanks) {
      const r = s.reactors.find((x) => x.id === tank.id)!;
      const a = r.asm1!;
      const expected = Math.round((a.X_I + a.X_S + a.X_B_H + a.X_B_A + a.X_P) / 1.42);
      expect(tank.mlss).toBe(expected);
    }
  });

  it('空反应器列表返回空数组而不是崩溃', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 1 });
    s.reactors = [];
    expect(buildTankStates(s)).toEqual([]);
  });
});

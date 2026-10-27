import { describe, expect, it } from 'vitest';
import { AI_DECISION_INTERVAL_MIN, aiCycleDue } from '../src/server/aiCadence';

/**
 * 决策节拍回归。
 *
 * 真实缺陷：决策按「tick 次数 % 30」触发，1× 时 60 仿真分钟一次、4× 时 240 分钟一次，
 * 与界面标注的「每 15 分钟仿真时间」不符，且倍速越高越迟钝。
 */

describe('AI 决策节拍', () => {
  it('间隔常量是界面承诺的 15 分钟', () => {
    expect(AI_DECISION_INTERVAL_MIN).toBe(15);
  });

  it('不足 15 仿真分钟不触发', () => {
    expect(aiCycleDue(0, 14)).toBe(false);
  });

  it('满 15 分钟触发（与倍速无关，只比较仿真时间）', () => {
    expect(aiCycleDue(0, 15)).toBe(true);
    expect(aiCycleDue(100, 115)).toBe(true);
    expect(aiCycleDue(100, 116)).toBe(true);
  });

  it('仿真重置（时钟回退）立即触发一次', () => {
    expect(aiCycleDue(5000, 0)).toBe(true);
  });

  it('NaN 输入不触发（避免时钟异常时刷决策）', () => {
    expect(aiCycleDue(Number.NaN, 100)).toBe(false);
    expect(aiCycleDue(0, Number.NaN)).toBe(false);
  });
});

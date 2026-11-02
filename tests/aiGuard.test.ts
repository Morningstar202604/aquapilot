import { describe, expect, it } from 'vitest';
import { applyGuards, describeMoves, type GuardableRecommendation } from '../src/server/aiGuard';
import { defaultAgentConfig } from '../src/shared/agentConfig';
import { DEFAULT_CONTROLS } from '../src/sim/config';
import type { ControlSettings } from '../src/sim/config';

/**
 * AI 护栏后处理。
 *
 * 这里守的是一个**静默失败**：AI 判定应急、日志写着「立即执行」，
 * 但护栏把每一步都夹回原值，于是控制量一次都没变。现象是
 * 「AI 已执行：…应急调节：」后面空无一物，且每轮重复广播。
 *
 * 这类缺陷不会让任何测试变红（接口都返回正常），只能靠专门断言
 * 「动作 ↔ 实际位移」的一致性来抓。
 */

const baseControls = (): ControlSettings => ({ ...DEFAULT_CONTROLS, aiEnabled: true });
const DEFAULT_AGENT_CONFIG = defaultAgentConfig();

const rec = (over: Partial<GuardableRecommendation> = {}): GuardableRecommendation => ({
  action: 'emergency',
  severity: 'critical',
  summary: '预测到 出水超标风险，立即执行应急调节：',
  tweaks: [{ key: 'doSetpoint', from: 2, to: 3, reason: '提高溶解氧' }],
  chosens: { controls: { ...baseControls(), doSetpoint: 3 } },
  ...over,
});

describe('护栏后处理：白名单', () => {
  it('allowedControls 之外的控制量被强制保持当前值', () => {
    const current = baseControls();
    const allowed = { ...DEFAULT_AGENT_CONFIG.constraints, allowedControls: ['doSetpoint' as const] };
    const input = rec({
      chosens: { controls: { ...current, doSetpoint: 3, internalRecirc: 2.5 } },
    });
    const { recommendation } = applyGuards(input, current, allowed);
    expect(recommendation.chosens.controls.internalRecirc).toBe(current.internalRecirc);
    expect(recommendation.chosens.controls.doSetpoint).not.toBe(current.doSetpoint);
  });
});

describe('护栏后处理：单步限幅', () => {
  it('超出 maxStepPct 的目标被夹到允许的最大一步', () => {
    const current = baseControls();
    const constraints = { ...DEFAULT_AGENT_CONFIG.constraints, maxStepPct: 1 };
    const input = rec({
      chosens: { controls: { ...current, doSetpoint: current.doSetpoint + 5 } },
    });
    const { recommendation, movedKeys } = applyGuards(input, current, constraints);
    expect(movedKeys.length).toBeGreaterThan(0);
    const moved = (recommendation.chosens.controls.doSetpoint as number) - (current.doSetpoint as number);
    expect(Math.abs(moved)).toBeLessThanOrEqual(5 * 0.01 + 1e-9);
  });
});

describe('护栏后处理：空动作降级（回归）', () => {
  it('限幅后一步都动不了时，emergency 降级为 hold', () => {
    const current = baseControls();
    // maxStepPct = 0：任何目标都被夹回当前值
    const constraints = { ...DEFAULT_AGENT_CONFIG.constraints, maxStepPct: 0 };
    const input = rec({
      chosens: { controls: { ...current, doSetpoint: current.doSetpoint + 3 } },
    });
    const { recommendation, movedKeys, degradedByGuard } = applyGuards(input, current, constraints);
    expect(movedKeys).toEqual([]);
    expect(degradedByGuard).toBe(true);
    expect(recommendation.action).toBe('hold');
    expect(recommendation.tweaks).toEqual([]);
  });

  it('降级后摘要必须说明「被护栏挡住」，且不能以冒号结尾', () => {
    const current = baseControls();
    const constraints = { ...DEFAULT_AGENT_CONFIG.constraints, maxStepPct: 0 };
    const { recommendation } = applyGuards(
      rec({ chosens: { controls: { ...current, doSetpoint: current.doSetpoint + 3 } } }),
      current,
      constraints,
    );
    expect(recommendation.summary).toMatch(/无可执行的调节/);
    expect(recommendation.summary).not.toMatch(/[：:]$/);
    expect(recommendation.summary.length).toBeGreaterThan(20);
  });

  it('降级只改动作，不改风险等级——critical 仍然是 critical', () => {
    const current = baseControls();
    const constraints = { ...DEFAULT_AGENT_CONFIG.constraints, maxStepPct: 0 };
    const { recommendation } = applyGuards(rec(), current, constraints);
    expect(recommendation.severity).toBe('critical');
  });

  it('人工确认模式会体现在降级原因里', () => {
    const current = baseControls();
    const constraints = {
      ...DEFAULT_AGENT_CONFIG.constraints,
      maxStepPct: 0,
      requireHumanApproval: true,
    };
    const { recommendation } = applyGuards(rec(), current, constraints);
    expect(recommendation.summary).toMatch(/人工确认模式/);
  });

  it('本来就动不了、动作已是 hold 的，不会被重复改写', () => {
    const current = baseControls();
    const input = rec({
      action: 'hold',
      severity: 'normal',
      summary: 'AI 判定当前工况稳定，维持现有控制，继续滚动监视。',
      tweaks: [],
      chosens: { controls: { ...current } },
    });
    const { recommendation, degradedByGuard } = applyGuards(input, current, DEFAULT_AGENT_CONFIG.constraints);
    expect(degradedByGuard).toBe(false);
    expect(recommendation.summary).toBe(input.summary);
  });
});

describe('护栏后处理：正常路径不被误伤', () => {
  it('有实际位移时保持原动作与原摘要', () => {
    const current = baseControls();
    const constraints = { ...DEFAULT_AGENT_CONFIG.constraints, maxStepPct: 20 };
    const input = rec({ summary: '预测到 出水超标风险，立即执行应急调节：溶解氧设定 2.00→3.00' });
    const { recommendation, movedKeys, degradedByGuard } = applyGuards(input, current, constraints);
    expect(degradedByGuard).toBe(false);
    expect(movedKeys).toContain('doSetpoint');
    expect(recommendation.action).toBe('emergency');
    expect(recommendation.summary).toBe(input.summary);
  });

  it('chosens.controls 之外的字段在类型上不承诺，但运行时也不被丢弃', () => {
    // 判断依据是「不主动删除」：applyGuards 只重建 chosens.controls 这一层，
    // 上层对象用展开复制，未来新增字段不会被静默吃掉。
    const current = baseControls();
    const extra = { controls: { ...current, doSetpoint: current.doSetpoint + 0.5 }, label: '提高供氧' };
    const input = rec({ chosens: extra });
    const { recommendation } = applyGuards(input, current, DEFAULT_AGENT_CONFIG.constraints);
    expect((recommendation.chosens as typeof extra).label).toBe('提高供氧');
  });
});

describe('位移描述', () => {
  it('按控制量精度格式化，供通知直接展示', () => {
    const current = baseControls();
    const next = { ...current, doSetpoint: current.doSetpoint + 0.5 };
    const text = describeMoves(['doSetpoint'], current, next);
    expect(text).toHaveLength(1);
    expect(text[0]).toMatch(/溶解氧/);
    expect(text[0]).toMatch(/→/);
  });

  it('空位移返回空数组（界面据此判断「只建议未动作」）', () => {
    expect(describeMoves([], baseControls(), baseControls())).toEqual([]);
  });
});

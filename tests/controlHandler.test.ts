import { describe, expect, it, vi } from 'vitest';
import { handleControlMessage, type ControlHandlerDeps } from '../src/server/controlHandler';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol';

/**
 * 运行态操作处理器。
 *
 * 抽出来的动机不是「文件太长」，而是这八个分支共享三条必须一起成立的不变式：
 * 1. 改变控制量必须进入人工优先期（否则用户拖完滑块立刻被 AI 改回）；
 * 2. 改变运行态必须广播快照（否则界面停在旧值）；
 * 3. 采纳与拒绝必须都写审计（只写一半就无法复盘）。
 * 这些是跨分支约束，分散在 800 行 switch 里时没人能一眼看出。
 */

type ControlMsg = Exclude<ClientMessage, { type: 'hello' | 'chat' | 'topology' | 'preset' }>;

function harness(over: Partial<ControlHandlerDeps> = {}) {
  const state = {
    controls: { doSetpoint: 2 } as Record<string, number>,
    aiEnabled: false,
    timeMin: 100,
    scenario: null as ControlHandlerDeps['state'] extends () => infer R
      ? R extends { scenario: infer S }
        ? S
        : never
      : never,
    paused: false,
    speed: 1,
  };
  const sent: ServerMessage[] = [];
  const broadcasted: ServerMessage[] = [];
  let snapshots = 0;
  let simStates = 0;
  const reviews: { verdict: string; reason: string }[] = [];
  const deps: ControlHandlerDeps = {
    /**
     * 故意返回**快照副本**，与生产实现一致。
     *
     * 上一个版本这里直接返回同一个对象，于是「处理器改 state 副本后丢弃」
     * 这类 bug 测不出来——真实环境里场景注入静默失效，单测却全绿。
     * 快照语义迫使所有写入必须走 mutator。
     */
    state: () => ({
      controls: { ...state.controls },
      aiEnabled: state.aiEnabled,
      timeMin: state.timeMin,
      scenario: state.scenario,
      paused: state.paused,
      speed: state.speed,
    }),
    recommendation: () =>
      ({
        action: 'adjust',
        severity: 'normal',
        summary: 's',
        rationale: [],
        chosens: { controls: { doSetpoint: 2.5, aiEnabled: true } },
      }) as never,
    adoptRecommendation: (controls) => {
      state.controls = { ...controls };
    },
    setControls: (next) => {
      state.controls = { ...next };
    },
    setAiEnabled: (enabled) => {
      state.aiEnabled = enabled;
    },
    setScenario: (scenario) => {
      state.scenario = scenario;
    },
    setPaused: (paused) => {
      state.paused = paused;
    },
    setSpeed: (speed) => {
      state.speed = speed;
    },
    enterManualWindow: () => {
      state.timeMin += 30;
    },
    resetSimulation: () => {
      state.timeMin = 0;
      state.paused = false;
    },
    refreshDecision: () => {},
    rateLimited: () => false,
    throttledNotice: () => {},
    send: (m) => sent.push(m),
    broadcast: (m) => broadcasted.push(m),
    broadcastSnapshot: () => {
      snapshots += 1;
    },
    broadcastSimState: () => {
      simStates += 1;
    },
    recordReview: (verdict, _actor, _action, reason) => reviews.push({ verdict, reason }),
    actor: 'operator',
    onInvalid: () => {},
    onRateLimited: () => {},
    allowedControls: () => [
      'doSetpoint',
      'internalRecirc',
      'rasRatio',
      'wasRatio',
      'pacDose',
      'carbonDose',
      'alkDose',
      'stormStore',
      'stepFeed',
    ],
    ...over,
  };
  return { state, deps, sent, broadcasted, reviews, snapshots: () => snapshots, simStates: () => simStates };
}

describe('control · 合法与非法输入', () => {
  it('合法控制量写入并进入人工优先期、广播快照', () => {
    const h = harness();
    const ok = handleControlMessage({ type: 'control', patch: { doSetpoint: 3 } } as ControlMsg, h.deps);
    expect(ok).toBe(true);
    expect(h.state.controls.doSetpoint).toBe(3);
    expect(h.state.timeMin).toBe(130); // 优先期前移
    expect(h.snapshots()).toBe(1);
  });

  it('非法控制量被拒且不改状态', () => {
    const h = harness();
    handleControlMessage({ type: 'control', patch: { doSetpoint: 'x' } } as unknown as ControlMsg, h.deps);
    expect(h.state.controls.doSetpoint).toBe(2);
    expect((h.sent[0] as { text: string }).text).toContain('非法');
  });

  it('被约束禁用的控制量连人工也不能写', () => {
    const h = harness({ allowedControls: () => [] });
    handleControlMessage({ type: 'control', patch: { doSetpoint: 3 } } as ControlMsg, h.deps);
    expect(h.state.controls.doSetpoint).toBe(2);
    expect((h.sent[0] as { text: string }).text).toContain('约束禁用');
  });

  it('aiEnabled 非布尔被拒', () => {
    const h = harness();
    handleControlMessage({ type: 'aiEnabled', enabled: 'yes' } as unknown as ControlMsg, h.deps);
    expect(h.state.aiEnabled).toBe(false);
    expect((h.sent[0] as { text: string }).text).toContain('布尔');
  });
});

describe('control · 审计不变式', () => {
  it('采纳写 approve', () => {
    const h = harness();
    handleControlMessage({ type: 'applyRecommendation' } as ControlMsg, h.deps);
    expect(h.reviews).toEqual([{ verdict: 'approve', reason: '' }]);
    expect(h.state.controls.doSetpoint).toBe(2.5);
  });

  it('拒绝写 reject 并保留理由（与采纳同等保真度）', () => {
    const h = harness();
    handleControlMessage({ type: 'dismissRecommendation', reason: '成本不划算' } as ControlMsg, h.deps);
    expect(h.reviews).toEqual([{ verdict: 'reject', reason: '成本不划算' }]);
    // 拒绝不改变控制量
    expect(h.state.controls.doSetpoint).toBe(2);
  });

  it('没有建议时拒绝给出提示且不写审计', () => {
    const h = harness({ recommendation: () => null });
    handleControlMessage({ type: 'dismissRecommendation' } as ControlMsg, h.deps);
    expect(h.reviews).toHaveLength(0);
    expect((h.sent[0] as { text: string }).text).toContain('没有可拒绝');
  });

  it('拒绝理由被截断到 300 字，避免超长正文进审计表', () => {
    const h = harness();
    handleControlMessage({ type: 'dismissRecommendation', reason: 'x'.repeat(500) } as ControlMsg, h.deps);
    expect(h.reviews[0].reason.length).toBe(300);
  });
});

describe('control · 场景与仿真', () => {
  it('注入场景会广播 warn 级通知并刷新决策', () => {
    const refresh = vi.fn();
    const h = harness({ refreshDecision: refresh });
    handleControlMessage({ type: 'scenario', kind: 'start', scenario: 'storm' } as ControlMsg, h.deps);
    expect(h.state.scenario).toMatchObject({ type: 'storm' });
    expect(h.broadcasted.some((m) => (m as { level?: string }).level === 'warn')).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it('未知场景类型被拒', () => {
    const h = harness();
    handleControlMessage({ type: 'scenario', kind: 'start', scenario: 'nope' } as unknown as ControlMsg, h.deps);
    expect(h.state.scenario).toBeNull();
    expect((h.sent[0] as { text: string }).text).toContain('未知');
  });

  it('清除场景同时把 stormStore 归零', () => {
    const h = harness();
    h.state.controls.stormStore = 1.2;
    handleControlMessage({ type: 'scenario', kind: 'clear' } as ControlMsg, h.deps);
    expect(h.state.controls.stormStore).toBe(0);
  });

  it('未知 sim 动作计入非法输入', () => {
    const onInvalid = vi.fn();
    const h = harness({ onInvalid });
    handleControlMessage({ type: 'sim', action: 'nope' } as unknown as ControlMsg, h.deps);
    expect(onInvalid).toHaveBeenCalled();
  });

  it('pause 只改暂停态并广播 simState', () => {
    const h = harness();
    handleControlMessage({ type: 'sim', action: 'pause' } as ControlMsg, h.deps);
    expect(h.state.paused).toBe(true);
    expect(h.simStates()).toBe(1);
  });

  it('reset 走注入的重置函数', () => {
    const h = harness();
    h.state.timeMin = 500;
    handleControlMessage({ type: 'sim', action: 'reset' } as ControlMsg, h.deps);
    expect(h.state.timeMin).toBe(0);
  });

  it('速度越界被拒', () => {
    const h = harness();
    handleControlMessage({ type: 'speed', value: 99 } as ControlMsg, h.deps);
    expect(h.state.speed).toBe(1);
    expect((h.sent[0] as { text: string }).text).toContain('0.25');
  });
});

describe('control · 限流', () => {
  it('control 被限流时给出提示且不写状态', () => {
    const throttled = vi.fn();
    const h = harness({ rateLimited: (k) => k === 'control', throttledNotice: throttled });
    handleControlMessage({ type: 'control', patch: { doSetpoint: 3 } } as ControlMsg, h.deps);
    expect(throttled).toHaveBeenCalled();
    expect(h.state.controls.doSetpoint).toBe(2);
  });

  it('refreshDecision 被限流时不重算', () => {
    const refresh = vi.fn();
    const h = harness({ rateLimited: (k) => k === 'decision', refreshDecision: refresh });
    handleControlMessage({ type: 'refreshDecision' } as ControlMsg, h.deps);
    expect(refresh).not.toHaveBeenCalled();
  });
});

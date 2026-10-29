import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/server/messageSchema';

/**
 * WS 消息 schema 校验。
 *
 * 锁的是三处真实缺口（手写校验放行、schema 必须拒绝）：
 *   ① scenario.kind 任意值都按 start 处理；
 *   ② sim.action 非法值静默成功（只回一条 simState）；
 *   ③ llmConfig.protocol 未知值落入 Google 适配分支。
 */

describe('已知消息类型', () => {
  it('接受合法的最小消息', () => {
    for (const msg of [
      { type: 'hello' },
      { type: 'chat', text: '现在怎么样' },
      { type: 'control', patch: { doSetpoint: 2 } },
      { type: 'aiEnabled', enabled: true },
      { type: 'applyRecommendation' },
      { type: 'sim', action: 'pause' },
      { type: 'speed', value: 2 },
      { type: 'refreshDecision' },
      { type: 'preset', id: 'a2o-standard' },
      { type: 'watchdog', action: 'get' },
      { type: 'analysis', action: 'run', requestId: 'a1' },
    ]) {
      const r = parseClientMessage(msg);
      expect(r.ok, JSON.stringify(msg)).toBe(true);
    }
  });

  it('接受完整场景消息', () => {
    expect(
      parseClientMessage({ type: 'scenario', kind: 'start', scenario: 'storm', durationMin: 300, magnitude: 1 }).ok,
    ).toBe(true);
    expect(parseClientMessage({ type: 'scenario', kind: 'clear' }).ok).toBe(true);
  });

  it('接受拓扑与配置类消息', () => {
    expect(parseClientMessage({ type: 'topology', action: 'get' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'topology', action: 'history' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'topology', action: 'revert', revision: 3 }).ok).toBe(true);
    expect(parseClientMessage({ type: 'topology', action: 'apply', topology: { units: [] } }).ok).toBe(true);
    expect(parseClientMessage({ type: 'llmConfig', action: 'get' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'llmConfig', action: 'clear', requestId: 'x' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'agentConfig', action: 'get' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'agentConfig', action: 'reset', requestId: 'x' }).ok).toBe(true);
  });
});

describe('拒绝非法输入（三处真实缺口）', () => {
  it('scenario.kind 必须是 start 或 clear', () => {
    expect(parseClientMessage({ type: 'scenario', kind: 'explode' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'scenario' }).ok).toBe(false);
  });

  it('sim.action 必须是 pause/resume/reset', () => {
    expect(parseClientMessage({ type: 'sim', action: 'kill' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'sim' }).ok).toBe(false);
  });

  it('llmConfig.protocol 必须是三种受支持协议之一', () => {
    const base = { type: 'llmConfig', action: 'discover', requestId: 'r', baseUrl: 'https://x.example.com' };
    expect(parseClientMessage({ ...base, protocol: 'openai' }).ok).toBe(true);
    expect(parseClientMessage({ ...base, protocol: 'anthropic' }).ok).toBe(true);
    expect(parseClientMessage({ ...base, protocol: 'google' }).ok).toBe(true);
    expect(parseClientMessage({ ...base, protocol: 'grpc' }).ok).toBe(false);
    expect(parseClientMessage(base).ok).toBe(false);
  });
});

describe('边界与类型', () => {
  it('拒绝非对象 / 数组 / 缺 type', () => {
    for (const raw of [null, 42, 'hello', [], {}, { type: 123 }]) {
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });

  it('拒绝超长文本与非法数值', () => {
    expect(parseClientMessage({ type: 'chat', text: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseClientMessage({ type: 'speed', value: Number.NaN }).ok).toBe(false);
    expect(parseClientMessage({ type: 'control', patch: { doSetpoint: 'high' } }).ok).toBe(false);
    expect(parseClientMessage({ type: 'control', patch: { unknownKey: 1 } }).ok).toBe(true);
  });

  it('拒绝未知消息类型', () => {
    expect(parseClientMessage({ type: 'exec', cmd: 'rm -rf /' }).ok).toBe(false);
  });

  it('错误信息给出字段路径，不回显输入内容', () => {
    const r = parseClientMessage({ type: 'sim', action: 'kill' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('action');
      expect(r.error).not.toContain('kill');
    }
  });
});

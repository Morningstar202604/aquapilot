import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookRuntime, type HookEffects } from '../src/server/hooks';
import { defaultAgentConfig, type AgentConfig, type HookSpec } from '../src/shared/agentConfig';

/**
 * 钩子运行时。
 *
 * 关键契约：
 * - 只做声明式动作，永不执行脚本；
 * - webhook 只在 open 权限下执行，并先过 SSRF 守卫；
 * - 同一事件在冷却期内只触发一次。
 */

function makeEffects(): HookEffects & {
  notices: string[];
  logs: string[];
  skills: string[];
  webhooks: string[];
  ok: boolean;
} {
  const effects = {
    notices: [] as string[],
    logs: [] as string[],
    skills: [] as string[],
    webhooks: [] as string[],
    ok: true,
    notice: (text: string) => effects.notices.push(text),
    logLine: (text: string) => effects.logs.push(text),
    skill: (id: string) => effects.skills.push(id),
    webhook: async (url: string) => {
      effects.webhooks.push(url);
      return effects.ok;
    },
  };
  return effects;
}

const cfg = (): AgentConfig => defaultAgentConfig();

function hook(overrides: Partial<HookSpec>): HookSpec {
  return {
    id: 'h-test',
    name: '测试钩子',
    event: 'alarm',
    match: '',
    action: 'notice',
    target: '提醒：{{detail}}',
    level: 'warn',
    enabled: true,
    cooldownMin: 5,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('事件匹配与动作', () => {
  it('只触发事件匹配的钩子', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ event: 'decision' })];
    await rt.fire(c, { event: 'alarm', detail: 'EFF_NH 超标', key: 'EFF_NH' });
    expect(effects.notices).toHaveLength(0);
    await rt.fire(c, { event: 'decision', detail: 'adjust', key: 'adjust' });
    expect(effects.notices).toHaveLength(1);
  });

  it('match 关键字不命中则跳过', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ match: 'EFF_' })];
    await rt.fire(c, { event: 'alarm', detail: 'DO_LOW 低溶氧', key: 'DO_LOW' });
    expect(effects.notices).toHaveLength(0);
  });

  it('match 命中 code 也能触发', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ match: 'EFF_' })];
    await rt.fire(c, { event: 'alarm', detail: '出水超标', key: 'EFF_COD' });
    expect(effects.notices).toHaveLength(1);
  });

  it('notice 模板替换 detail', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ target: '告警：{{detail}} @{{event}}' })];
    await rt.fire(c, { event: 'alarm', detail: 'NH 超限', key: 'EFF_NH' });
    expect(effects.notices[0]).toBe('告警：NH 超限 @alarm');
  });

  it('log 动作走日志通道', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ action: 'log' })];
    await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(effects.logs).toHaveLength(1);
  });

  it('skill 动作登记技能并可通过 skillFor 取回', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ action: 'skill', target: 's-storm' })];
    await rt.fire(c, { event: 'alarm', detail: 'storm', key: 'storm' });
    expect(effects.skills).toEqual(['s-storm']);
    expect(rt.skillFor('alarm', 'storm')).toBe('s-storm');
  });

  it('禁用的钩子不执行', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ enabled: false })];
    const out = await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(out[0].skipped).toBe('disabled');
    expect(effects.notices).toHaveLength(0);
  });

  it('空模板跳过', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ target: '  ' })];
    const out = await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(out[0].skipped).toBe('empty-target');
  });
});

describe('冷却去重', () => {
  it('同一 key 在冷却期内只触发一次', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ cooldownMin: 5 })];
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'EFF_NH' });
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'EFF_NH' });
    expect(effects.notices).toHaveLength(1);
  });

  it('不同 key 各自触发', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ cooldownMin: 5 })];
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'EFF_NH' });
    await rt.fire(c, { event: 'alarm', detail: 'b', key: 'EFF_COD' });
    expect(effects.notices).toHaveLength(2);
  });

  it('冷却结束后可再次触发', async () => {
    let now = 1_000_000;
    const effects = makeEffects();
    const rt = new HookRuntime(effects, () => now);
    const c = cfg();
    c.hooks = [hook({ cooldownMin: 1 })];
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'K' });
    now += 61_000;
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'K' });
    expect(effects.notices).toHaveLength(2);
  });

  it('reset 清空去重状态', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.hooks = [hook({ cooldownMin: 5 })];
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'K' });
    rt.reset();
    await rt.fire(c, { event: 'alarm', detail: 'a', key: 'K' });
    expect(effects.notices).toHaveLength(2);
  });
});

describe('Webhook 权限与 SSRF', () => {
  it('standard 权限下 webhook 被跳过', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.permission = 'standard';
    c.hooks = [hook({ action: 'webhook', target: 'https://example.com/hook' })];
    const out = await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(out[0].skipped).toBe('permission');
    expect(effects.webhooks).toHaveLength(0);
  });

  it('open 权限下合法地址会调用 webhook', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.permission = 'open';
    c.hooks = [hook({ action: 'webhook', target: 'https://example.com/hook' })];
    const out = await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(out[0].skipped).toBeUndefined();
    expect(effects.webhooks).toEqual(['https://example.com/hook']);
  });

  it('open 权限下云元数据地址被拦', async () => {
    const effects = makeEffects();
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.permission = 'open';
    c.hooks = [hook({ action: 'webhook', target: 'http://169.254.169.254/latest/meta-data' })];
    const out = await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(out[0].skipped).toBe('unsafe-target');
    expect(effects.webhooks).toHaveLength(0);
  });

  it('webhook 抛异常不影响其他钩子', async () => {
    const effects = makeEffects();
    effects.webhook = async () => {
      throw new Error('boom');
    };
    const rt = new HookRuntime(effects);
    const c = cfg();
    c.permission = 'open';
    c.hooks = [
      hook({ id: 'h1', action: 'webhook', target: 'https://example.com/a' }),
      hook({ id: 'h2', action: 'notice', target: '第二个' }),
    ];
    await rt.fire(c, { event: 'alarm', detail: 'x', key: 'x' });
    expect(effects.notices).toEqual(['第二个']);
  });
});

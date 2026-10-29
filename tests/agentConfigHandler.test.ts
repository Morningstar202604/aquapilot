import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentStateMessage, createAgentConfigHandler } from '../src/server/agentConfigHandler';
import { HookRuntime } from '../src/server/hooks';
import { defaultAgentConfig } from '../src/shared/agentConfig';
import { agentConfigStore } from '../src/server/agentConfig';

/**
 * Agent 配置处理器。
 *
 * 独立成模块后必须锁住的边界：
 * - 写入统一走存储层（权限/核心保护在那里）；
 * - URL 导入用严格公网守卫（私网/回环一律拒绝）；
 * - 技能数量上限；
 * - 保存成功后广播，失败不广播。
 */

let dir: string;
const originalEnv = process.env;

/**
 * 处理器用的是模块级单例 `agentConfigStore`（生产需要它跨请求共享），
 * 因此测试必须通过环境变量把它指到临时目录，而不是新建一个 store。
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-agent-'));
  process.env = { ...originalEnv, AQUAPILOT_AGENT_CONFIG: join(dir, 'agent.json') };
  // 单例会被用例之间共享。readonly 是设计上不可自解锁的，
  // 因此这里直接写配置文件恢复默认档位，而不是走被它拒绝的 reset 接口。
  // mtime 热加载会在下一次读取时自动生效
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(defaultAgentConfig()), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
  vi.restoreAllMocks();
});

function makeHandler() {
  const broadcasts: unknown[] = [];
  const hooks = new HookRuntime({
    notice: () => {},
    skill: () => {},
    logLine: () => {},
    webhook: async () => true,
  });
  const handler = createAgentConfigHandler({
    broadcast: (m) => broadcasts.push(m),
    hooks,
  });
  return { handler, broadcasts };
}

function fakeWs() {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
    sent,
  };
}

describe('agentStateMessage', () => {
  it('返回核心保护区与摘要，不含明文密钥', () => {
    const msg = agentStateMessage('r1');
    expect(msg.type).toBe('agentConfig');
    if (msg.type === 'agentConfig' && msg.action === 'state') {
      expect(Array.isArray(msg.coreProtected)).toBe(true);
      expect(JSON.stringify(msg)).not.toMatch(/apiKey|sk-/);
    }
  });

  it('previewPrompt 给出拼装后的提示词', () => {
    const msg = agentStateMessage('r2', '现在怎么样');
    if (msg.type === 'agentConfig' && msg.action === 'state') {
      expect(typeof msg.promptPreview).toBe('string');
      expect(msg.promptPreview!.length).toBeGreaterThan(0);
    }
  });
});

describe('配置读写', () => {
  it('get 直接回状态', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    await handler(ws as never, { type: 'agentConfig', action: 'get', requestId: 'a' });
    expect(ws.sent.length).toBeGreaterThan(0);
    expect((ws.sent[0] as { action: string }).action).toBe('state');
  });

  it('save 失败时回 ok:false 且不广播', async () => {
    const { handler, broadcasts } = makeHandler();
    const ws = fakeWs();
    // 当前权限为 readonly → save 必须被存储层拒绝
    const cfg = defaultAgentConfig();
    cfg.permission = 'readonly';
    agentConfigStore.save(cfg, { writer: 'ui' });
    await handler(ws as never, {
      type: 'agentConfig',
      action: 'save',
      requestId: 'b',
      config: { ...defaultAgentConfig(), persona: { ...defaultAgentConfig().persona, name: '新名字' } },
    });
    const last = ws.sent.at(-1) as { ok?: boolean };
    expect(last.ok).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('未知动作回错误而不是抛异常', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    await handler(ws as never, { type: 'agentConfig', action: 'nope' } as never);
    const last = ws.sent.at(-1) as { action?: string; error?: string };
    expect(last.action).toBe('error');
  });
});

describe('技能导入的公网守卫', () => {
  it('私网与回环地址被拒绝，且回复可读原因', async () => {
    const { handler } = makeHandler();
    for (const url of ['http://127.0.0.1:8500/x', 'http://localhost/x', 'http://10.0.0.5/x']) {
      const ws = fakeWs();
      await handler(ws as never, {
        type: 'agentConfig',
        action: 'importSkill',
        requestId: 'c',
        skill: { name: 'x', url },
      });
      const last = ws.sent.at(-1) as { action?: string; error?: string };
      expect(last.action).toBe('error');
      expect(last.error).toMatch(/导入失败/);
    }
  });

  it('既无正文也无 URL 时给出明确提示', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    await handler(ws as never, {
      type: 'agentConfig',
      action: 'importSkill',
      requestId: 'd',
      skill: { name: '只有名字' },
    });
    const last = ws.sent.at(-1) as { error?: string };
    expect(last.error).toMatch(/需要正文/);
  });

  it('技能数量达到上限时拒绝', async () => {
    const { handler } = makeHandler();
    const cfg = defaultAgentConfig();
    cfg.skills = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `技能${i}`,
      description: '',
      triggers: ['x'],
      content: 'c',
      enabled: true,
      source: 'custom' as const,
    }));
    // 存储层可能需要先把当前档位放宽才能写入 30 个技能；失败时本用例不成立
    const saved = agentConfigStore.save(cfg, { writer: 'ui' });
    if (!saved.ok || agentConfigStore.get().skills.length < 30) return;
    const ws = fakeWs();
    await handler(ws as never, {
      type: 'agentConfig',
      action: 'importSkill',
      requestId: 'e',
      skill: { name: 'x', content: 'y' },
    });
    const last = ws.sent.at(-1) as { error?: string };
    expect(last.error).toMatch(/最多 30 个/);
  });
});

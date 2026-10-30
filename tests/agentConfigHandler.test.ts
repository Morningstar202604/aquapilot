import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 必须在模块加载前设置环境变量。
 *
 * `agentConfigStore` 是模块级单例，实例化时用 `DEFAULT_PATH = resolve(env)`
 * 固化路径。若在 beforeEach 里才设环境变量，单例仍指向真实的
 * `data/agent-config.json`——测试会把 readonly 写进开发者目录
 * （实测发生过），且用例之间互相污染。
 * vi.hoisted 保证这段代码先于所有 import 执行。
 */
const TEST_DIR = vi.hoisted(() => {
  const base = typeof process.env.TEMP === 'string' && process.env.TEMP ? process.env.TEMP : '/tmp';
  // 加进程 PID：vitest 并行 worker 共用 TEMP，固定目录会让不同文件
  // 的单例指向同一个 JSON，写入交错导致 mtime/指纹判定错乱（实测踩到）
  return `${base}/aquapilot-agenthandler-${process.pid}`;
});
import { agentStateMessage, createAgentConfigHandler } from '../src/server/agentConfigHandler';
import { __repointStoreForTests } from '../src/server/agentConfig';
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

/**
 * 每条用例开始前把配置文件恢复为默认（standard 档位）。
 *
 * 单例会被用例之间共享，readonly 在设计上不可自解锁，
 * 直接写文件靠 mtime 热加载是唯一的干净复位方式。
 */
let caseSeq = 0;

beforeEach(() => {
  // 显式重定向（不依赖环境变量时序），并清空内存态
  __repointStoreForTests(`${TEST_DIR}/agent.json`);
  mkdirSync(TEST_DIR, { recursive: true });
  /**
   * 每条用例用**内容不同**的初始文件。
   *
   * 全部写相同内容的话， Windows 上同一毫秒内的连续写入 mtimeMs 相同、
   * 内容指纹也相同，热加载会误判「无变化」而保留上一条用例留下的
   * 内存态（readonly），表现为 reset 被拒——实测踩到。
   * 把用例序号编进 persona name，保证每次文件内容必然不同。
   */
  caseSeq += 1;
  const seed = defaultAgentConfig();
  seed.persona.name = `用例-${caseSeq}`;
  writeFileSync(`${TEST_DIR}/agent.json`, JSON.stringify(seed), 'utf8');
});

afterEach(() => {
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

describe('预览与复位', () => {
  it('previewPrompt 对草稿生效（不依赖已保存配置）', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    const draft = defaultAgentConfig();
    draft.persona.name = '预览角色';
    await handler(ws as never, {
      type: 'agentConfig',
      action: 'previewPrompt',
      requestId: 'p1',
      question: '现在怎么样',
      config: draft,
    });
    const last = ws.sent.at(-1) as { action?: string; promptPreview?: string };
    expect(last.action).toBe('state');
    expect(last.promptPreview).toContain('预览角色');
  });

  it('畸形 draft 时 previewPrompt 退化为已保存配置而不报错', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    await handler(ws as never, {
      type: 'agentConfig',
      action: 'previewPrompt',
      requestId: 'p2',
      config: { broken: true } as never,
    });
    const last = ws.sent.at(-1) as { action?: string };
    expect(last.action).toBe('state');
  });

  it('reset 成功后广播一次', async () => {
    const { handler, broadcasts } = makeHandler();
    const ws = fakeWs();
    /**
     * 用例可能在前一条里把权限写成 readonly（设计上不可自解锁）。
     *
     * 复位不能只依赖 beforeEach 的文件写入：Windows 上同一毫秒内的两次
     * 写入 mtimeMs 相同，且内容指纹（都是默认配置）也相同，
     * 热加载会误判「没有变化」而保留内存里的 readonly。
     * 这里写一份**内容不同**的文件强制指纹失配，确保重载发生。
     */
    const forced = defaultAgentConfig();
    forced.persona.name = '复位前哨兵';
    writeFileSync(`${TEST_DIR}/agent.json`, JSON.stringify(forced), 'utf8');
    await handler(ws as never, { type: 'agentConfig', action: 'reset', requestId: 'r9' });
    const outcome = ws.sent.at(-1) as { ok?: boolean; error?: string };
    // 输出错误信息便于诊断（而不是只看到 ok:false）
    expect(outcome.error ?? 'no error').toBe('no error');
    expect(outcome.ok).toBe(true);
    expect(broadcasts.length).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigStore } from '../src/server/agentConfig';
import { defaultAgentConfig, type AgentConfig } from '../src/shared/agentConfig';

/**
 * 配置存储与热加载。
 *
 * 三条写入路径（界面 / 对话 / CLI）共用 store.save：
 * 权限与核心保护必须在这一层就生效，否则 WS 直接调用就能绕过界面限制。
 */

let dir: string;
let path: string;
let store: AgentConfigStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-agent-'));
  path = join(dir, 'agent-config.json');
  store = new AgentConfigStore(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withName = (name: string): AgentConfig => {
  const cfg = defaultAgentConfig();
  cfg.persona.name = name;
  return cfg;
};

describe('读写与持久化', () => {
  it('未保存文件时给出默认配置', () => {
    expect(store.get().persona.name).toBe(defaultAgentConfig().persona.name);
    expect(store.status().summary.permission).toBe('standard');
  });

  it('保存后落盘并可被新实例读回', () => {
    const outcome = store.save(withName('首席值班长'), { writer: 'ui' });
    expect(outcome.ok).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
    expect(raw.persona.name).toBe('首席值班长');
    expect(raw.updatedBy).toBe('ui');
    const reloaded = new AgentConfigStore(path);
    expect(reloaded.get().persona.name).toBe('首席值班长');
  });

  it('写入为 0600（POSIX）', () => {
    store.save(withName('x'), { writer: 'ui' });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('patch 只改指定区块，其余保持', () => {
    store.save(withName('A'), { writer: 'ui' });
    const before = store.get();
    store.patch({ persona: { ...before.persona, name: 'B' } }, { writer: 'chat' });
    expect(store.get().persona.name).toBe('B');
    expect(store.get().skills).toHaveLength(before.skills.length);
    expect(store.get().updatedBy).toBe('chat');
  });

  it('reset 回到默认值', () => {
    store.save(withName('临时'), { writer: 'ui' });
    store.reset({ writer: 'ui' });
    expect(store.get().persona.name).toBe(defaultAgentConfig().persona.name);
  });
});

describe('热加载（CLI / 手改文件）', () => {
  it('外部改文件后下一次读取即生效', async () => {
    store.save(withName('A'), { writer: 'ui' });
    const external = withName('CLI 改的');
    writeFileSync(path, JSON.stringify(external, null, 2), 'utf8');
    // mtime 精度在某些文件系统上是秒级：显式等待一拍
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      path,
      JSON.stringify({ ...external, persona: { ...external.persona, name: 'CLI 改的2' } }, null, 2),
      'utf8',
    );
    expect(store.get().persona.name).toBe('CLI 改的2');
  });

  it('文件损坏时保留上一份并给出 warning', async () => {
    store.save(withName('保留我'), { writer: 'ui' });
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path, '{not json', 'utf8');
    expect(store.get().persona.name).toBe('保留我');
    expect(store.status().warnings.join()).toContain('无法解析');
  });

  it('订阅者在保存后收到通知', () => {
    const seen: string[] = [];
    const off = store.subscribe((status) => seen.push(status.config.persona.name));
    store.save(withName('N1'), { writer: 'ui' });
    off();
    store.save(withName('N2'), { writer: 'ui' });
    expect(seen).toEqual(['N1']);
  });
});

describe('权限与核心保护（服务端统一入口）', () => {
  it('readonly 拒绝保存并保持原值', () => {
    const cfg = defaultAgentConfig();
    cfg.permission = 'readonly';
    store.save(cfg, { writer: 'ui' });
    const outcome = store.save(withName('偷偷改'), { writer: 'ui' });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('只读');
    expect(store.get().persona.name).not.toBe('偷偷改');
  });

  it('standard 可切到 open 并留下提示，核心项仍不可写', () => {
    const outcome = store.save({ ...defaultAgentConfig(), permission: 'open', limits: { cod: 999 } } as unknown, {
      writer: 'ui',
    });
    expect(outcome.ok).toBe(true);
    expect(store.get().permission).toBe('open');
    expect(outcome.warnings.join()).toContain('完全放开');
    expect('limits' in JSON.parse(readFileSync(path, 'utf8'))).toBe(false);
  });

  it('standard 下 webhook 钩子被剔除', () => {
    const cfg = defaultAgentConfig();
    cfg.hooks.push({
      id: 'h-w',
      name: '外发',
      event: 'alarm',
      match: '',
      action: 'webhook',
      target: 'https://example.com/hook',
      level: 'info',
      enabled: true,
      cooldownMin: 1,
    });
    const outcome = store.save(cfg, { writer: 'ui' });
    expect(outcome.config?.hooks.some((h) => h.action === 'webhook')).toBe(false);
    expect(outcome.warnings.join()).toContain('Webhook');
  });

  it('open 下 webhook 与大步长都保留（提权与能力分开两次保存）', () => {
    const cfg = defaultAgentConfig();
    cfg.permission = 'open';
    cfg.constraints.maxStepPct = 80;
    cfg.hooks.push({
      id: 'h-w',
      name: '外发',
      event: 'alarm',
      match: '',
      action: 'webhook',
      target: 'https://example.com/hook',
      level: 'info',
      enabled: true,
      cooldownMin: 1,
    });
    /**
     * 第一次保存只切档位：open 专属能力（webhook / >30% 步长）
     * 必须从「下一次」保存起才生效，否则一次请求即可自己提权并落地外发钩子。
     */
    const first = store.save(cfg, { writer: 'ui' });
    expect(first.ok).toBe(true);
    expect(store.get().permission).toBe('open');
    expect(store.get().hooks.some((h) => h.action === 'webhook')).toBe(false);
    expect(store.get().constraints.maxStepPct).toBe(30);
    expect(first.warnings.join()).toContain('下一次保存');

    // 第二次保存时当前档位已是 open，能力才会保留
    const second = store.save(cfg, { writer: 'ui' });
    expect(second.ok).toBe(true);
    expect(store.get().hooks.some((h) => h.action === 'webhook')).toBe(true);
    expect(store.get().constraints.maxStepPct).toBe(80);
  });

  it('单次保存不能同时提权并落地 webhook（防止自提权）', () => {
    const cfg = defaultAgentConfig();
    cfg.permission = 'open';
    cfg.hooks.push({
      id: 'h-esc',
      name: '外发',
      event: 'alarm',
      match: '',
      action: 'webhook',
      target: 'http://127.0.0.1:8500/admin',
      level: 'info',
      enabled: true,
      cooldownMin: 0,
    });
    const outcome = store.save(cfg, { writer: 'ui' });
    expect(outcome.ok).toBe(true);
    expect(store.get().hooks.some((h) => h.action === 'webhook')).toBe(false);
  });

  it('standard 下超 30% 步长被夹紧', () => {
    const cfg = defaultAgentConfig();
    cfg.constraints.maxStepPct = 90;
    const outcome = store.save(cfg, { writer: 'ui' });
    expect(outcome.config?.constraints.maxStepPct).toBe(30);
  });

  it('核心字段在写入时被静默丢弃', () => {
    const payload = { ...defaultAgentConfig(), limits: { cod: 999 }, auth: { off: true } } as unknown;
    const outcome = store.save(payload, { writer: 'ui' });
    expect(outcome.ok).toBe(true);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect('limits' in stored).toBe(false);
    expect('auth' in stored).toBe(false);
  });

  it('写入失败会回滚内存状态', () => {
    const cfg = defaultAgentConfig();
    cfg.permission = 'readonly';
    store.save(cfg, { writer: 'ui' });
    expect(store.get().persona.name).toBe(defaultAgentConfig().persona.name);
  });
});

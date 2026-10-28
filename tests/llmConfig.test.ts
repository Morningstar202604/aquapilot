import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmConfigStore, sanitizeDraft } from '../src/server/llmConfig';
import { DEFAULT_CAPABILITIES } from '../src/shared/llm';

/**
 * 自定义模型配置的持久化与脱敏。
 *
 * 关键回归点：
 * - 浏览器可见视图绝不能出现明文 key；
 * - 界面留空 key 时必须沿用已保存的密钥（否则每次改模型都要重填）；
 * - 非法草稿要给出中文原因而不是抛异常。
 */

let dir: string;
let store: LlmConfigStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-llm-'));
  store = new LlmConfigStore(join(dir, 'llm-config.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const draft = {
  protocol: 'openai' as const,
  baseUrl: 'https://maas-api.example.com/v1',
  apiKey: 'sk-secret-value-123456',
  model: 'u2-flash',
  capabilities: { ...DEFAULT_CAPABILITIES, contextWindow: 1048576, maxOutput: 32768 },
  autoCapabilities: true,
};

describe('配置校验', () => {
  it('缺协议/地址/模型都给出中文原因', () => {
    expect(sanitizeDraft(null).ok).toBe(false);
    expect(sanitizeDraft({ protocol: 'x', baseUrl: 'https://a', model: 'm' })).toEqual({
      ok: false,
      error: '不支持的协议类型',
    });
    expect(sanitizeDraft({ protocol: 'openai', baseUrl: ' ', model: 'm' })).toEqual({
      ok: false,
      error: '请填写 Base URL',
    });
    expect(sanitizeDraft({ protocol: 'openai', baseUrl: 'https://a', model: '' })).toEqual({
      ok: false,
      error: '请选择或填写模型',
    });
  });

  it('合法草稿去掉尾部斜杠并按范围夹紧数值', () => {
    const res = sanitizeDraft({
      protocol: 'openai',
      baseUrl: 'https://a/v1///',
      model: ' u2-flash ',
      apiKey: ' k ',
      capabilities: { contextWindow: 1, maxOutput: 99999999, tools: 'yes' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.baseUrl).toBe('https://a/v1');
    expect(res.draft.model).toBe('u2-flash');
    expect(res.draft.apiKey).toBe('k');
    expect(res.draft.capabilities.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);
    expect(res.draft.capabilities.maxOutput).toBe(DEFAULT_CAPABILITIES.maxOutput);
    expect(res.draft.capabilities.tools).toBe(true);
  });
});

describe('持久化', () => {
  it('保存后能读回，文件权限为 0600（POSIX）', () => {
    const saved = store.save(draft);
    expect(saved.ok).toBe(true);
    const runtime = store.getRuntime();
    expect(runtime).toMatchObject({ protocol: 'openai', baseUrl: draft.baseUrl, model: 'u2-flash', maxOutput: 32768 });
    expect(runtime?.apiKey).toBe(draft.apiKey);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'llm-config.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('公开视图只给掩码与 hasKey', () => {
    store.save(draft);
    const pub = store.getPublic();
    expect(pub?.hasKey).toBe(true);
    expect(pub?.apiKeyMasked).toContain('sk-');
    expect(JSON.stringify(pub)).not.toContain('secret-value');
  });

  it('再次保存时留空 key 沿用旧密钥', () => {
    store.save(draft);
    const second = store.save({ ...draft, model: 'glm-5.2', apiKey: '' });
    expect(second.ok).toBe(true);
    expect(store.getRuntime()?.apiKey).toBe(draft.apiKey);
    expect(store.getRuntime()?.model).toBe('glm-5.2');
  });

  it('首次保存且没有 key 时拒绝', () => {
    const res = store.save({ ...draft, apiKey: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/API Key/);
  });

  it('文件损坏时当作未配置而不是崩溃', () => {
    const path = join(dir, 'llm-config.json');
    store.save(draft);
    writeFileSync(path, '{not json');
    const fresh = new LlmConfigStore(path);
    expect(fresh.getPublic()).toBeNull();
  });

  it('clear 删除文件并清空运行时', () => {
    store.save(draft);
    store.clear();
    expect(store.getPublic()).toBeNull();
    expect(store.getRuntime()).toBeNull();
    expect(() => readFileSync(join(dir, 'llm-config.json'))).toThrow();
  });

  it('新实例能从磁盘恢复', () => {
    store.save(draft);
    const reloaded = new LlmConfigStore(join(dir, 'llm-config.json'));
    expect(reloaded.getPublic()?.model).toBe('u2-flash');
  });
});

describe('密钥与地址绑定（防外带）', () => {
  it('界面留空时，同源地址可以复用已存密钥', () => {
    store.save(draft);
    expect(store.resolveKey('', 'https://maas-api.example.com/v1')).toBe('sk-secret-value-123456');
    // 路径不同但同源
    expect(store.resolveKey('', 'https://maas-api.example.com')).toBe('sk-secret-value-123456');
  });

  it('目标地址换主机或换端口时，绝不回落到已存密钥', () => {
    store.save(draft);
    expect(store.resolveKey('', 'https://attacker.example.com/v1')).toBe('');
    expect(store.resolveKey('', 'https://maas-api.example.com:8443/v1')).toBe('');
    expect(store.resolveKey('', 'http://maas-api.example.com/v1')).toBe('');
  });

  it('显式传入的新密钥始终优先，不受绑定限制', () => {
    store.save(draft);
    expect(store.resolveKey('sk-new', 'https://attacker.example.com')).toBe('sk-new');
  });

  it('hasKeyForOtherOrigin 能提示界面需要重填', () => {
    store.save(draft);
    expect(store.hasKeyForOtherOrigin('https://attacker.example.com')).toBe(true);
    expect(store.hasKeyForOtherOrigin('https://maas-api.example.com/v1')).toBe(false);
  });

  it('未配置密钥时任何地址都返回空', () => {
    expect(store.resolveKey('', 'https://maas-api.example.com')).toBe('');
    expect(store.hasKeyForOtherOrigin('https://any.example.com')).toBe(false);
  });
});

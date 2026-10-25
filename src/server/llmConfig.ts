import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_CAPABILITIES,
  PROTOCOLS,
  maskApiKey,
  type LlmProtocol,
  type LlmPublicConfig,
  type LlmDraft,
  type ModelCapabilities,
} from '../shared/llm';

/**
 * 自定义模型配置的持久化。
 *
 * 为什么不用环境变量：用户要在界面里改完立刻生效，而不是改 .env 再重启。
 * 因此落一个 0600 权限的 JSON 文件，运行时热读取。
 *
 * 安全边界：
 * - 文件只存服务端，浏览器拿到的永远是 LlmPublicConfig（掩码 + hasKey）；
 * - 保存接口不允许把 key 回传，前端留空表示「沿用已保存的密钥」；
 * - 不写日志、不进 git（data/ 已在 .gitignore）。
 */

const DEFAULT_PATH = resolve(process.env.AQUAPILOT_LLM_CONFIG ?? 'data/llm-config.json');

interface StoredConfig extends LlmDraft {
  updatedAt: string;
}

export interface LlmRuntimeConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutput: number;
  timeoutMs: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  config?: LlmPublicConfig;
}

function isProtocol(v: unknown): v is LlmProtocol {
  return typeof v === 'string' && (PROTOCOLS as string[]).includes(v);
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : fallback;
}

function sanitizeCapabilities(raw: unknown): ModelCapabilities {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    contextWindow: num(src.contextWindow, 1024, 10_000_000, DEFAULT_CAPABILITIES.contextWindow),
    maxOutput: num(src.maxOutput, 64, 1_000_000, DEFAULT_CAPABILITIES.maxOutput),
    tools: flag(src.tools, DEFAULT_CAPABILITIES.tools),
    vision: flag(src.vision, DEFAULT_CAPABILITIES.vision),
    reasoning: flag(src.reasoning, DEFAULT_CAPABILITIES.reasoning),
    streaming: flag(src.streaming, DEFAULT_CAPABILITIES.streaming),
  };
}

/** 校验界面草稿；返回中文错误而不是抛异常 */
export function sanitizeDraft(raw: unknown): { ok: true; draft: LlmDraft } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '配置必须是对象' };
  const src = raw as Record<string, unknown>;
  if (!isProtocol(src.protocol)) return { ok: false, error: '不支持的协议类型' };
  if (typeof src.baseUrl !== 'string' || src.baseUrl.trim().length === 0)
    return { ok: false, error: '请填写 Base URL' };
  if (src.baseUrl.length > 500) return { ok: false, error: 'Base URL 过长' };
  if (typeof src.model !== 'string' || src.model.trim().length === 0) return { ok: false, error: '请选择或填写模型' };
  if (src.model.length > 200) return { ok: false, error: '模型名过长' };
  if (src.apiKey !== undefined && typeof src.apiKey !== 'string') return { ok: false, error: 'API Key 必须是字符串' };
  if (typeof src.apiKey === 'string' && src.apiKey.length > 500) return { ok: false, error: 'API Key 过长' };
  return {
    ok: true,
    draft: {
      protocol: src.protocol,
      baseUrl: src.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim() : '',
      model: src.model.trim(),
      capabilities: sanitizeCapabilities(src.capabilities),
      autoCapabilities: typeof src.autoCapabilities === 'boolean' ? src.autoCapabilities : true,
    },
  };
}

export class LlmConfigStore {
  private current: StoredConfig | null = null;
  private loaded = false;

  constructor(private readonly path: string = DEFAULT_PATH) {}

  /** 惰性加载：文件不存在不是错误，只是「未配置」 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredConfig>;
      if (isProtocol(raw.protocol) && typeof raw.baseUrl === 'string' && typeof raw.model === 'string') {
        this.current = {
          protocol: raw.protocol,
          baseUrl: raw.baseUrl,
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
          model: raw.model,
          capabilities: sanitizeCapabilities(raw.capabilities),
          autoCapabilities: raw.autoCapabilities !== false,
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        };
      }
    } catch {
      this.current = null;
    }
  }

  /** 浏览器可见视图：绝不含明文 key */
  getPublic(): LlmPublicConfig | null {
    this.ensureLoaded();
    const c = this.current;
    if (!c) return null;
    return {
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      model: c.model,
      capabilities: { ...c.capabilities },
      autoCapabilities: c.autoCapabilities,
      hasKey: c.apiKey.length > 0,
      apiKeyMasked: maskApiKey(c.apiKey),
      updatedAt: c.updatedAt,
    };
  }

  /** 聊天链路用的运行配置；未配置返回 null */
  getRuntime(): LlmRuntimeConfig | null {
    this.ensureLoaded();
    const c = this.current;
    if (!c) return null;
    return {
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      maxOutput: c.capabilities.maxOutput,
      timeoutMs: 12000,
    };
  }

  /** 已有密钥但界面留空时沿用旧密钥 */
  resolveKey(incoming: string): string {
    this.ensureLoaded();
    return incoming.length > 0 ? incoming : (this.current?.apiKey ?? '');
  }

  save(draft: LlmDraft): SaveResult {
    this.ensureLoaded();
    const apiKey = this.resolveKey(draft.apiKey);
    if (!apiKey) return { ok: false, error: '请填写 API Key' };
    const stored: StoredConfig = {
      ...draft,
      apiKey,
      updatedAt: new Date().toISOString(),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const staging = `${this.path}.staging-${process.pid}`;
      writeFileSync(staging, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(staging, this.path);
      this.current = stored;
      return { ok: true, config: this.getPublic() ?? undefined };
    } catch {
      return { ok: false, error: '写入配置失败：检查 data/ 目录是否可写' };
    }
  }

  clear(): void {
    this.ensureLoaded();
    this.current = null;
    try {
      rmSync(this.path, { force: true });
    } catch {
      /* 文件不存在即可 */
    }
  }
}

export const llmConfigStore = new LlmConfigStore();

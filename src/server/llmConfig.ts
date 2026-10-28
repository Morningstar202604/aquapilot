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
  type ReasoningEffort,
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
  reasoningEffort: ReasoningEffort;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  config?: LlmPublicConfig;
}

function isProtocol(v: unknown): v is LlmProtocol {
  return typeof v === 'string' && (PROTOCOLS as string[]).includes(v);
}

/**
 * 两个 baseUrl 是否同源。
 *
 * 只比较 protocol + hostname + port：路径不同（`/v1` vs `/`）仍算同一端点，
 * 但主机或端口一换就意味着密钥会被发往另一方，必须视为不同来源。
 * 解析失败一律视为不同源（fail-closed）。
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a.trim());
    const ub = new URL(b.trim());
    return ua.protocol === ub.protocol && ua.hostname.toLowerCase() === ub.hostname.toLowerCase() && ua.port === ub.port;
  } catch {
    return false;
  }
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
      reasoningEffort: (['auto', 'low', 'off'] as const).includes(src.reasoningEffort as never)
        ? (src.reasoningEffort as ReasoningEffort)
        : 'auto',
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
          reasoningEffort: (['auto', 'low', 'off'] as const).includes(raw.reasoningEffort as never)
            ? (raw.reasoningEffort as ReasoningEffort)
            : 'auto',
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
      reasoningEffort: c.reasoningEffort ?? 'auto',
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
      timeoutMs: 25000,
      reasoningEffort: c.reasoningEffort ?? 'auto',
    };
  }

  /**
   * 已有密钥但界面留空时沿用旧密钥。
   *
   * 必须绑定 origin：`discover` / `test` 的 baseUrl 完全由客户端提供，
   * 若无条件回落已存密钥，任意 WS 客户端只要把 baseUrl 指向自己的服务器，
   * 就能收到 `Authorization: Bearer <已存密钥>`——一次消息即可把密钥外带。
   * 因此只有目标地址与保存时的地址同源才允许复用；换地址必须重新输入。
   */
  resolveKey(incoming: string, baseUrl?: string): string {
    this.ensureLoaded();
    const provided = incoming.trim();
    if (provided.length > 0) return provided;
    const stored = this.current?.apiKey ?? '';
    if (!stored) return '';
    if (baseUrl === undefined) return stored;
    return this.keyBelongsTo(baseUrl) ? stored : '';
  }

  /** 已存密钥是否可用于该地址（同 origin 才算） */
  keyBelongsTo(baseUrl: string): boolean {
    const saved = this.current;
    if (!saved || !saved.apiKey) return false;
    return sameOrigin(saved.baseUrl, baseUrl);
  }

  /** 是否存在「已存密钥但与目标地址不同源」的情况：用于给出明确提示 */
  hasKeyForOtherOrigin(baseUrl: string): boolean {
    const saved = this.current;
    if (!saved || !saved.apiKey) return false;
    return !sameOrigin(saved.baseUrl, baseUrl);
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

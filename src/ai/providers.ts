import type { DiscoveredModel, LlmDiscoverInput, LlmProtocol, LlmTestInput, LlmTestResult } from '../shared/llm';
import { inferCapabilities, isChatModel } from '../shared/llm';

/**
 * 自定义模型端点适配层。
 *
 * 只支持三个主流协议（OpenAI 兼容 / Anthropic Messages / Google Gemini），
 * 不为每家厂商写 SDK：全部用内置 fetch，零新增依赖。
 *
 * 约束：
 * 1. baseUrl 来自用户输入，属于信任边界输入，先过 SSRF 守卫；
 * 2. 任何失败都返回可读中文原因，不抛出到 WS 处理器；
 * 3. 不记录 apiKey，不把请求体写日志。
 */

export const DISCOVER_TIMEOUT_MS = 12000;
export const TEST_TIMEOUT_MS = 30000;

/** 元数据服务与链路本地地址：任何情况下都不允许作为模型端点 */
const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
]);

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * SSRF 守卫。
 *
 * 允许 localhost / 私网（自建 Ollama、vLLM 就在内网），
 * 但拒绝非 http(s)、URL 内嵌凭据、链路本地与云元数据主机。
 */
export function assertSafeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(normalizeBaseUrl(raw));
  } catch {
    throw new ProviderError('地址不是合法的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('地址必须使用 http 或 https');
  }
  if (url.username || url.password) {
    throw new ProviderError('地址里不允许内嵌账号密码，请把密钥填在 API Key 字段');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new ProviderError('该地址属于云元数据服务，禁止访问');
  if (/^169\.254\./.test(host)) throw new ProviderError('链路本地地址不可用');
  if (host.startsWith('[') && host.startsWith('[fe80')) throw new ProviderError('链路本地地址不可用');
  return url;
}

function joinUrl(base: string, path: string): string {
  return `${normalizeBaseUrl(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

function anthropicBase(base: string): string {
  const normalized = normalizeBaseUrl(base);
  return /\/v1$/.test(normalized) ? normalized : `${normalized}/v1`;
}

function googleBase(base: string): string {
  const normalized = normalizeBaseUrl(base);
  if (/\/v1beta$/.test(normalized) || /\/v1$/.test(normalized)) return normalized;
  return `${normalized}/v1beta`;
}

function headersFor(protocol: LlmProtocol, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 把 HTTP 状态映射成用户能看懂的中文原因 */
export function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：API Key 无效或没有该模型的权限`;
  if (status === 404) return '端点不存在（HTTP 404）：检查 Base URL 是否少了或多了 /v1';
  if (status === 429) return '触发限流（HTTP 429）：稍后重试或更换密钥';
  if (status >= 500) return `服务端错误（HTTP ${status}）：供应商暂时不可用`;
  return `请求失败（HTTP ${status}）`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function errorMessageOf(json: Record<string, unknown>): string | undefined {
  const err = json.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  const msg = json.message;
  return typeof msg === 'string' ? msg : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new ProviderError('请求超时，端点没有响应');
    throw new ProviderError('无法连接端点：检查地址与网络，或该端点是否允许跨域访问');
  } finally {
    clearTimeout(timer);
  }
}

/** 各协议的模型列表请求 */
function buildDiscoverRequest(input: LlmDiscoverInput): { url: string; init: RequestInit } {
  const base = input.baseUrl;
  assertSafeBaseUrl(base);
  const apiKey = input.apiKey?.trim() ?? '';
  if (input.protocol === 'openai') {
    return { url: joinUrl(base, '/models'), init: { method: 'GET', headers: headersFor('openai', apiKey) } };
  }
  if (input.protocol === 'anthropic') {
    return {
      url: joinUrl(anthropicBase(base), '/models?limit=1000'),
      init: { method: 'GET', headers: headersFor('anthropic', apiKey) },
    };
  }
  const url = new URL(joinUrl(googleBase(base), '/models'));
  if (apiKey) url.searchParams.set('key', apiKey);
  return { url: url.toString(), init: { method: 'GET', headers: { 'Content-Type': 'application/json' } } };
}

/** 解析各协议的模型列表响应 */
export function parseModelList(protocol: LlmProtocol, json: Record<string, unknown>): DiscoveredModel[] {
  const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const out: DiscoveredModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    let id = '';
    if (typeof item.id === 'string') id = item.id;
    else if (typeof item.name === 'string') id = item.name;
    if (!id) continue;
    if (protocol === 'google') id = id.replace(/^models\//, '');
    if (!isChatModel(id)) continue;
    const displayName =
      typeof item.display_name === 'string'
        ? item.display_name
        : typeof item.displayName === 'string'
          ? item.displayName
          : id;
    out.push({
      id,
      label: displayName,
      ownedBy:
        typeof item.owned_by === 'string' ? item.owned_by : typeof item.ownedBy === 'string' ? item.ownedBy : undefined,
      contextWindow:
        asNumber(item.context_window) ??
        asNumber(item.contextWindow) ??
        asNumber(item.max_input) ??
        asNumber(item.inputTokenLimit),
      maxOutput: asNumber(item.max_output) ?? asNumber(item.maxOutput) ?? asNumber(item.outputTokenLimit),
    });
  }
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export async function discoverModels(input: LlmDiscoverInput): Promise<DiscoveredModel[]> {
  const { url, init } = buildDiscoverRequest(input);
  const res = await fetchWithTimeout(url, init, DISCOVER_TIMEOUT_MS);
  const json = await readJson(res);
  if (!res.ok) {
    const detail = errorMessageOf(json);
    throw new ProviderError(
      detail ? `${describeHttpFailure(res.status)}：${detail}` : describeHttpFailure(res.status),
      res.status,
    );
  }
  const models = parseModelList(input.protocol, json);
  if (models.length === 0) throw new ProviderError('端点返回的模型列表为空，或全部是非对话模型');
  return models;
}

interface ChatOutcome {
  reply: string;
  emptyBecauseTruncated: boolean;
}

function buildChatRequest(input: LlmTestInput, maxOutput: number): { url: string; init: RequestInit } {
  const base = input.baseUrl;
  assertSafeBaseUrl(base);
  const apiKey = input.apiKey?.trim() ?? '';
  const prompt = '你是连通性测试助手。请只回复两个字：正常。';

  if (input.protocol === 'openai') {
    return {
      url: joinUrl(base, '/chat/completions'),
      init: {
        method: 'POST',
        headers: headersFor('openai', apiKey),
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxOutput,
          temperature: 0,
          stream: false,
        }),
      },
    };
  }
  if (input.protocol === 'anthropic') {
    return {
      url: joinUrl(anthropicBase(base), '/messages'),
      init: {
        method: 'POST',
        headers: headersFor('anthropic', apiKey),
        body: JSON.stringify({
          model: input.model,
          max_tokens: Math.max(maxOutput, 16),
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
    };
  }
  const url = new URL(joinUrl(googleBase(base), `/models/${encodeURIComponent(input.model)}:generateContent`));
  if (apiKey) url.searchParams.set('key', apiKey);
  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: Math.max(maxOutput, 16) },
      }),
    },
  };
}

/** 解析各协议的对话响应 */
export function parseChatReply(protocol: LlmProtocol, json: Record<string, unknown>): ChatOutcome {
  if (protocol === 'openai') {
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const first = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (first.message ?? {}) as Record<string, unknown>;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
    return {
      reply: content || (toolCalls > 0 ? `（模型返回 ${toolCalls} 个工具调用）` : ''),
      emptyBecauseTruncated: !content && first.finish_reason === 'length',
    };
  }
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const text = blocks
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
      .trim();
    return { reply: text, emptyBecauseTruncated: !text && json.stop_reason === 'max_tokens' };
  }
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = (candidates[0] ?? {}) as Record<string, unknown>;
  const content = (first.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim();
  return { reply: text, emptyBecauseTruncated: !text && first.finishReason === 'MAX_TOKENS' };
}

export async function testConnection(input: LlmTestInput): Promise<LlmTestResult> {
  const started = Date.now();
  const budget = Math.min(Math.max(input.maxOutput ?? 512, 64), 4096);
  try {
    let { url, init } = buildChatRequest(input, budget);
    let res = await fetchWithTimeout(url, init, TEST_TIMEOUT_MS);
    let json = await readJson(res);
    if (!res.ok) {
      const detail = errorMessageOf(json);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: detail ? `${describeHttpFailure(res.status)}：${detail}` : describeHttpFailure(res.status),
      };
    }
    let outcome = parseChatReply(input.protocol, json);
    // 推理模型常见：小预算全部烧在 reasoning_content 上，content 为空且 finish_reason=length。
    // 这种情形不是链路失败，放宽预算重试一次再判定。
    if (!outcome.reply && outcome.emptyBecauseTruncated) {
      ({ url, init } = buildChatRequest(input, Math.max(budget, 2048)));
      res = await fetchWithTimeout(url, init, TEST_TIMEOUT_MS);
      json = await readJson(res);
      if (!res.ok) {
        const detail = errorMessageOf(json);
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: detail ? `${describeHttpFailure(res.status)}：${detail}` : describeHttpFailure(res.status),
        };
      }
      outcome = parseChatReply(input.protocol, json);
    }
    if (!outcome.reply) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: '连接成功但模型没有返回内容（可能是推理模型预算不足或模型名不对）',
      };
    }
    return { ok: true, latencyMs: Date.now() - started, reply: outcome.reply.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof ProviderError ? err.message : '连接测试失败：未知错误',
    };
  }
}

/** 供服务端聊天链路复用：把用户问题发到已保存的端点 */
export async function chatComplete(
  config: { protocol: LlmProtocol; baseUrl: string; apiKey: string; model: string; maxOutput: number },
  system: string,
  user: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const input: LlmTestInput = { ...config, maxOutput: config.maxOutput };
  let request: { url: string; init: RequestInit };
  try {
    request = buildChatRequest(input, Math.min(Math.max(config.maxOutput, 64), 4096));
  } catch (err) {
    return { ok: false, reason: err instanceof ProviderError ? 'invalid-base-url' : 'invalid-request' };
  }
  const body = JSON.parse(String(request.init.body ?? '{}')) as Record<string, unknown>;
  if (config.protocol === 'openai') {
    body.messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    body.max_tokens = Math.min(Math.max(config.maxOutput, 64), 4096);
  } else if (config.protocol === 'anthropic') {
    body.system = system;
    body.messages = [{ role: 'user', content: user }];
    body.max_tokens = Math.min(Math.max(config.maxOutput, 64), 4096);
  } else {
    body.systemInstruction = { parts: [{ text: system }] };
    body.contents = [{ role: 'user', parts: [{ text: user }] }];
  }
  request.init.body = JSON.stringify(body);
  try {
    const res = await fetchWithTimeout(request.url, request.init, timeoutMs);
    const json = await readJson(res);
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const outcome = parseChatReply(config.protocol, json);
    if (!outcome.reply) return { ok: false, reason: 'empty-response' };
    return { ok: true, text: outcome.reply };
  } catch (err) {
    if (err instanceof ProviderError && err.message.includes('超时')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network-error' };
  }
}

export function capabilitiesFor(model: DiscoveredModel, protocol: LlmProtocol) {
  return inferCapabilities(model, protocol);
}

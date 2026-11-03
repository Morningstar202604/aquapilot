import { Resolver } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Transform } from 'node:stream';
import type { DiscoveredModel, LlmDiscoverInput, LlmProtocol, LlmTestInput, LlmTestResult } from '../shared/llm';
import { isChatModel } from '../shared/llm';

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

/** 主机名归一：小写、去尾点、IPv6 去方括号 */
function canonicalHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^\[|\]$/g, '');
}

/**
 * IPv6 地址段判定（只覆盖与 SSRF 相关的危险段）。
 *
 * `URL.hostname` 会把 IPv4-mapped 地址归一成 `[::ffff:a9fe:a9fe]` 这种形式，
 * 正则匹配 `169.254.` 永远命中不了——必须按 IPv6 段单独判定，
 * 否则 `http://[::ffff:169.254.169.254]/` 可直达云元数据。
 *
 * 同一台机器上 IPv4 还能以 IPv4-compatible（`::a.b.c.d`）、NAT64（`64:ff9b::/96`）
 * 和 6to4（`2002:AABB:CCDD::/48`）三种形式嵌进 IPv6。只认 `::ffff:` 会让
 * `http://[::a9fe:a9fe]/` 一类写法绕过字面量黑名单，所以统一解析后按八段判定。
 */
function isDangerousIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const parts = parseIpv6(host);
  if (!parts) return true;
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1) return true;
  const embedded = embeddedIpv4(parts);
  if (embedded && isDangerousIpv4(embedded)) return true;
  // 链路本地 fe80::/10、唯一本地 fc00::/7（AWS IMDS IPv6 fd00:ec2::254 落在 ULA 内）
  if ((parts[0] & 0xffc0) === 0xfe80) return true;
  if ((parts[0] & 0xfe00) === 0xfc00) return true;
  // 未指定地址；回环 ::1 由调用方的严格公网策略单独处理
  if (parts.every((part) => part === 0)) return true;
  return false;
}

/** 把 IPv6 文本解析成 8 个 16 位段；无法解析返回 null（调用方按危险处理） */
function parseIpv6(host: string): number[] | null {
  const lower = canonicalHost(host);
  if (!lower.includes(':') || lower.includes('%')) return null;
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const toParts = (text: string): number[] | null => {
    const out: number[] = [];
    for (const piece of text.split(':').filter((p) => p !== '')) {
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = toParts(halves[0] ?? '');
  const tail = halves.length === 2 ? toParts(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * 取出 IPv6 里内嵌的 IPv4。
 *
 * 覆盖四种把 IPv4 塞进 IPv6 的写法，任何一种漏判都能绕过链路本地检查：
 * - IPv4-mapped `::ffff:a.b.c.d`（`::ffff:0:0/96`）
 * - IPv4-compatible `::a.b.c.d`（`::/96`，已废弃但部分栈仍接受）
 * - IPv4-translated `::ffff:0:a.b.c.d`（`::ffff:0:0/96`，SIIT）
 * - NAT64：RFC 6052 的 `64:ff9b::/96`
 * - 6to4 `2002:AABB:CCDD::/48`
 */
function embeddedIpv4(parts: number[]): string | null {
  const octets = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const firstFourZero = parts.slice(0, 4).every((part) => part === 0);
  const firstFiveZero = firstFourZero && parts[4] === 0;
  // IPv4-compatible `::a.b.c.d` 与 IPv4-mapped `::ffff:a.b.c.d`
  if (firstFiveZero && (parts[5] === 0 || parts[5] === 0xffff)) return octets(parts[6], parts[7]);
  // IPv4-translated `::ffff:0:a.b.c.d`（SIIT）：0:0:0:0:ffff:0:hi:lo
  if (firstFourZero && parts[4] === 0xffff && parts[5] === 0) return octets(parts[6], parts[7]);
  if (parts[0] === 0x64 && parts[1] === 0xff9b) return octets(parts[6], parts[7]);
  if (parts[0] === 0x2002) return octets(parts[1], parts[2]);
  return null;
}

function isDangerousIpv4(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host === '100.100.100.200') return true;
  return false;
}

function isNonPublicIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    a === 224 ||
    a >= 225
  );
}

/**
 * SSRF 守卫。
 *
 * 允许 localhost / 私网（自建 Ollama、vLLM 就在内网），
 * 但拒绝非 http(s)、URL 内嵌凭据、链路本地与云元数据主机。
 *
 * 归一化是必须的：`metadata.google.internal.`（尾点）、`[::ffff:169.254.169.254]`
 * （IPv4-mapped IPv6）都能绕过朴素的字面量匹配。
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
  const host = canonicalHost(url.hostname);
  if (BLOCKED_HOSTS.has(host) || isDangerousIpv4(host) || isDangerousIpv6(host)) {
    throw new ProviderError('该地址属于云元数据或链路本地服务，禁止访问');
  }
  return url;
}

/**
 * 严格公网守卫（供「服务端主动抓取第三方内容」的场景使用）。
 *
 * `assertSafeBaseUrl` 故意允许私网（自建 Ollama 需要），但同一份守卫
 * 被技能 URL 导入复用时就成了**可回读的内网 SSRF**：抓回正文写进技能，
 * 再通过 agentConfig/get 原样返回给攻击者。
 * 因此抓取类场景必须额外拒绝回环、私网、链路本地与 .local 域名。
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /\.local$/,
  /\.internal$/,
];

function isPrivateFetchHost(host: string): boolean {
  const parts = host.includes(':') ? parseIpv6(host) : null;
  const embedded = parts ? embeddedIpv4(parts) : null;
  return (
    PRIVATE_HOST_PATTERNS.some((re) => re.test(host)) ||
    isNonPublicIpv4(host) ||
    (embedded !== null && isNonPublicIpv4(embedded)) ||
    isDangerousIpv6(host)
  );
}

function isForbiddenResolvedHost(host: string): boolean {
  return isDangerousIpv4(host) || isDangerousIpv6(host);
}

export function assertPublicFetchUrl(raw: string): URL {
  const url = assertSafeBaseUrl(raw);
  const host = canonicalHost(url.hostname);
  if (isPrivateFetchHost(host)) {
    throw new ProviderError('该地址属于内网或回环地址，服务端不允许抓取');
  }
  return url;
}

type PublicAddress = { address: string; family: 4 | 6 };
type PublicAddressLookup = (hostname: string, signal?: AbortSignal) => Promise<PublicAddress[]>;

function deadlineError(): ProviderError {
  return new ProviderError('请求超时，端点没有响应');
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(deadlineError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(deadlineError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

const lookupPublicAddresses: PublicAddressLookup = async (hostname, signal) => {
  if (hostname === 'localhost')
    return [
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ];
  const resolver = new Resolver();
  if (signal?.aborted) throw deadlineError();
  return new Promise<PublicAddress[]>((resolve, reject) => {
    let settled = false;
    let pending = 2;
    let lastError: Error | null = null;
    const addresses: PublicAddress[] = [];
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = () => {
      if (settled || pending > 0) return;
      settled = true;
      cleanup();
      if (addresses.length > 0) resolve(addresses);
      else reject(lastError ?? new Error('DNS lookup returned no address'));
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      resolver.cancel();
      cleanup();
      reject(deadlineError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    const done = (family: 4 | 6, error: NodeJS.ErrnoException | null, values: string[]) => {
      if (settled) return;
      if (error) lastError = error;
      else addresses.push(...values.map((address) => ({ address, family })));
      pending -= 1;
      finish();
    };
    resolver.resolve4(hostname, (error, values) => done(4, error, values ?? []));
    resolver.resolve6(hostname, (error, values) => done(6, error, values ?? []));
  });
};

export async function resolvePublicFetchAddress(
  raw: string,
  lookup: PublicAddressLookup = lookupPublicAddresses,
  signal?: AbortSignal,
  allowPrivate = false,
): Promise<{ url: URL; address: string; addresses: string[] }> {
  const url = allowPrivate ? assertSafeBaseUrl(raw) : assertPublicFetchUrl(raw);
  const host = canonicalHost(url.hostname);
  if (isIP(host)) {
    if (isForbiddenResolvedHost(host)) throw new ProviderError('该地址属于云元数据或链路本地服务，禁止访问');
    if (!allowPrivate && isPrivateFetchHost(host))
      throw new ProviderError('该地址属于内网或回环地址，服务端不允许抓取');
    return { url, address: host, addresses: [host] };
  }
  let addresses: PublicAddress[];
  try {
    addresses = await awaitWithSignal(lookup(host, signal), signal);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('无法解析公网地址');
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => {
      const host = canonicalHost(entry.address);
      return isForbiddenResolvedHost(host) || (!allowPrivate && isPrivateFetchHost(host));
    })
  ) {
    throw new ProviderError(
      allowPrivate
        ? '该地址解析到了云元数据或链路本地服务，禁止访问'
        : '该地址解析到了内网或回环地址，服务端不允许抓取',
    );
  }
  return { url, address: addresses[0].address, addresses: addresses.map((entry) => entry.address) };
}

interface PublicFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  lookup?: PublicAddressLookup;
  requestImpl?: typeof httpRequest;
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

export async function fetchPublicUrl(raw: string, options: PublicFetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const { url, address } = await resolvePublicFetchAddress(
      raw,
      options.lookup,
      controller.signal,
      options.allowPrivate ?? false,
    );
    const method = options.method ?? 'GET';
    const maxBytes = options.maxBytes ?? 1_000_000;
    const transport = options.requestImpl ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    headers.Host = url.host;
    /**
     * 显式要 identity。
     *
     * 这一层用 `node:http` 直接拿原始字节，没有 `fetch` 那层自动解压；
     * 反代或 CDN 强制 gzip 时，正文会变成无法解析的二进制，报错还会
     * 误导成「模型列表为空」。不要压缩，语义最清晰。
     */
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept-encoding')) {
      headers['Accept-Encoding'] = 'identity';
    }
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let decoder: Transform | undefined;
      let incoming: import('node:http').IncomingMessage | undefined;
      const requestHolder: { current?: ReturnType<typeof httpRequest> } = {};
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => {
        const error = deadlineError();
        fail(error);
        decoder?.destroy();
        incoming?.destroy();
        requestHolder.current?.destroy();
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) {
        abort();
        return;
      }
      requestHolder.current = transport(
        {
          protocol: url.protocol,
          hostname: address,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          timeout: timeoutMs,
          ...(url.protocol === 'https:' ? { servername: canonicalHost(url.hostname) } : {}),
        },
        (response) => {
          incoming = response;
          const chunks: Buffer[] = [];
          let compressedSize = 0;
          let decodedSize = 0;
          const status = response.statusCode ?? 502;
          const emptyBody = method.toUpperCase() === 'HEAD' || status === 204 || status === 205 || status === 304;
          const encoding = String(response.headers['content-encoding'] ?? '')
            .trim()
            .toLowerCase();
          const stop = (error: Error) => {
            fail(error);
            decoder?.destroy();
            response.destroy();
            requestHolder.current?.destroy();
          };
          if (!emptyBody && encoding && encoding !== 'identity') {
            if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
            else if (encoding === 'deflate') decoder = createInflate();
            else if (encoding === 'br') decoder = createBrotliDecompress();
            else {
              stop(new ProviderError('不支持的响应内容编码'));
              return;
            }
          }
          const append = (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            decodedSize += data.length;
            if (decodedSize > maxBytes) {
              stop(new ProviderError('响应体过大，已拒绝读取'));
              return;
            }
            chunks.push(data);
          };
          response.on('error', (error) => stop(error));
          response.on('data', (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            compressedSize += data.length;
            if (compressedSize > maxBytes) {
              stop(new ProviderError('响应体过大，已拒绝读取'));
              return;
            }
            if (!decoder && !emptyBody) append(data);
          });
          if (decoder) {
            decoder.on('data', append);
            decoder.on('error', () => stop(new ProviderError('响应体解压失败')));
            response.pipe(decoder);
          }
          const output = decoder ?? response;
          output.on('end', () => {
            if (settled) return;
            try {
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
                else if (value !== undefined) responseHeaders.set(key, value);
              }
              if (decoder) {
                responseHeaders.delete('content-encoding');
                responseHeaders.delete('content-length');
              }
              const body = emptyBody ? null : new Uint8Array(Buffer.concat(chunks));
              const result = new Response(body, { status, headers: responseHeaders });
              settled = true;
              cleanup();
              resolve(result);
            } catch {
              fail(new ProviderError('响应构造失败'));
            }
          });
        },
      );
      requestHolder.current.on('timeout', abort);
      requestHolder.current.on('error', (error) => fail(error));
      if (options.body !== undefined) requestHolder.current.write(options.body);
      requestHolder.current.end();
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
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

/**
 * 推理强度开关。
 *
 * 实测 u2-flash：不干预时推理内容会把 token 预算吃光、content 为空。
 * OpenAI 兼容端普遍认 `enable_thinking` / `reasoning_effort` / `thinking`，
 * 这里同时下发前两个——供应商忽略不认识的字段，认识的就生效。
 * Anthropic / Gemini 走各自的原生字段（Anthropic 用 thinking.budget_tokens）。
 */
export function reasoningFields(
  protocol: LlmProtocol,
  effort: 'auto' | 'low' | 'off' = 'auto',
): Record<string, unknown> {
  if (effort === 'auto') return {};
  if (protocol === 'openai') {
    // off 不下发 reasoning_effort：很多兼容端只认这个字段，
    // 带上 'low' 会把「关闭思考」变成「低档思考」——假关闭
    return effort === 'off'
      ? { enable_thinking: false, thinking: { type: 'disabled' } }
      : { enable_thinking: true, reasoning_effort: 'low' };
  }
  if (protocol === 'anthropic') {
    return effort === 'off' ? {} : { thinking: { type: 'enabled', budget_tokens: 1024 } };
  }
  return {};
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

const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const nativeFetch = globalThis.fetch;

async function readResponseText(res: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await awaitWithSignal(res.text(), signal);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ProviderError('响应体过大，已拒绝读取');
    return text;
  }
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await awaitWithSignal(reader.read(), signal);
      if (next.done) return chunks.join('') + decoder.decode();
      const value = next.value;
      total += value.byteLength;
      if (total > maxBytes) throw new ProviderError('响应体过大，已拒绝读取');
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

async function readJson(
  res: Response,
  signal: AbortSignal,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  const text = await readResponseText(res, signal, maxBytes);
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

/**
 * 带超时的请求 + 读体。
 *
 * 超时必须覆盖「拿到响应头」和「读完响应体」两段：
 * 旧实现只给 fetch 套了 AbortSignal，一旦端点先回头再挂住 body，
 * `res.text()` 没有任何超时约束，连接与 Promise 会永久挂起。
 * 同时固定 `redirect:'manual'`：跟随重定向会让 SSRF 守卫只看第一跳，
 * 公网地址 302 到云元数据即可绕过。
 */
async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const activeFetch = globalThis.fetch;
    let res: Response;
    if (activeFetch === nativeFetch) {
      const resolved = await resolvePublicFetchAddress(url, undefined, controller.signal, true);
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === 'string' ? init.body : undefined;
      let response: Response | undefined;
      for (const [index, address] of resolved.addresses.entries()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || controller.signal.aborted) throw deadlineError();
        try {
          response = await fetchPublicUrl(url, {
            method: init.method,
            headers,
            body,
            timeoutMs: remaining,
            maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
            allowPrivate: true,
            signal: controller.signal,
            lookup: async () => [{ address, family: isIP(address) === 6 ? 6 : 4 }],
          });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (
            index === resolved.addresses.length - 1 ||
            !['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code ?? '')
          )
            throw error;
        }
      }
      if (!response) throw new ProviderError('无法连接端点');
      res = response;
    } else {
      res = await activeFetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError(`端点返回重定向（HTTP ${res.status}），已拒绝跟随`, res.status);
    }
    const json = await readJson(res, controller.signal, MAX_PROVIDER_RESPONSE_BYTES);
    return { res, json };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
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
  return {
    url: joinUrl(googleBase(base), '/models'),
    init: {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) },
    },
  };
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
  const { res, json } = await requestJson(url, init, DISCOVER_TIMEOUT_MS);
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
          ...reasoningFields(input.protocol, input.reasoningEffort),
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
  return {
    url: joinUrl(googleBase(base), `/models/${encodeURIComponent(input.model)}:generateContent`),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) },
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
    let { res, json } = await requestJson(url, init, TEST_TIMEOUT_MS);
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
      ({ res, json } = await requestJson(url, init, TEST_TIMEOUT_MS));
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
  config: {
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey: string;
    model: string;
    maxOutput: number;
    reasoningEffort?: 'auto' | 'low' | 'off';
  },
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
  Object.assign(body, reasoningFields(config.protocol, config.reasoningEffort));
  request.init.body = JSON.stringify(body);
  /**
   * 推理模型的预算可能全部烧在 reasoning 上（content 为空、finish_reason=length）。
   * 这种情况不是链路失败，抬一轮预算再试；两轮都空才算 empty-response。
   */
  const budgets = [Math.min(Math.max(config.maxOutput, 64), 4096), 8192];
  try {
    for (const budget of budgets) {
      const attempt = JSON.parse(String(request.init.body)) as Record<string, unknown>;
      if (config.protocol === 'openai' || config.protocol === 'anthropic') attempt.max_tokens = budget;
      else {
        const gc = (attempt.generationConfig ?? {}) as Record<string, unknown>;
        gc.maxOutputTokens = budget;
        attempt.generationConfig = gc;
      }
      const init: RequestInit = { ...request.init, body: JSON.stringify(attempt) };
      const { res, json } = await requestJson(request.url, init, timeoutMs);
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      const outcome = parseChatReply(config.protocol, json);
      if (outcome.reply) return { ok: true, text: outcome.reply };
      if (!outcome.emptyBecauseTruncated) return { ok: false, reason: 'empty-response' };
    }
    return { ok: false, reason: 'empty-response' };
  } catch (err) {
    if (err instanceof ProviderError && err.message.includes('超时')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network-error' };
  }
}

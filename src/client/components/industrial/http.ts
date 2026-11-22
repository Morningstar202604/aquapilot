/**
 * 「工业」页签共用的只读 fetch 小工具。
 *
 * 鉴权口径与 InsightsPanel / ReplayPanel 一致：令牌存 sessionStorage，
 * 请求头带 `Authorization: Bearer <token>`，不把令牌写进 URL。
 * 错误统一抛 {@link ApiError}，面板按状态码与错误码渲染三态，不在展示层猜字段。
 */

const TOKEN_KEY = 'aquapilot_token';

export function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function authHeaders(token?: string | null): HeadersInit {
  const t = token ?? readStoredToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 只读 JSON 请求；非 2xx 按服务端错误形状 `{ error, code }` 解析后抛出。 */
export async function fetchJson<T>(url: string, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(token) });
  } catch (err) {
    throw new ApiError(0, `无法连接仿真服务（${err instanceof Error ? err.message : String(err)}）`);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const errBody = (body ?? {}) as { error?: string; code?: string };
    throw new ApiError(res.status, errBody.error ?? `请求失败（HTTP ${res.status}）`, errBody.code);
  }
  return body as T;
}

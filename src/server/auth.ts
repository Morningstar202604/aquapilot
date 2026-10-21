import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * 轻量访问控制。
 *
 * 定位：这是一个本地仿真原型，默认不启用认证。
 * 但当它被放到局域网/服务器上给多人用时，"任何能连上的人都能改控制参数"
 * 是不可接受的——本模块提供最小可用的令牌认证。
 *
 * 设计取舍：
 * - 默认关闭：设置了 AQUAPILOT_TOKEN 才启用，本地开发零配置
 * - 恒定时间比较：避免通过响应时间推断令牌
 * - 只校验不存储：令牌不进日志、不回显
 * - WebSocket 与 HTTP 共用同一套校验
 */

const TOKEN_ENV = 'AQUAPILOT_TOKEN';

export function accessControlEnabled(): boolean {
  return Boolean(process.env[TOKEN_ENV]?.trim());
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 恒定时间比较，避免计时侧信道 */
export function tokenMatches(provided: string | null | undefined): boolean {
  const expected = process.env[TOKEN_ENV]?.trim();
  if (!expected) return true; // 未配置 = 不启用认证
  if (!provided) return false;
  const a = digest(provided);
  const b = digest(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 从请求中提取令牌：Authorization: Bearer / ?token= / Sec-WebSocket-Protocol */
export function extractToken(req: IncomingMessage, fallback?: string | null): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const url = req.url ?? '';
  const q = url.indexOf('?');
  if (q >= 0) {
    const params = new URLSearchParams(url.slice(q + 1));
    const t = params.get('token');
    if (t) return t;
  }

  // 浏览器 WebSocket 无法自定义 header；用子协议传令牌是常见做法
  if (fallback) return fallback;
  return null;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export function authorize(req: IncomingMessage, fallbackToken?: string | null): AccessDecision {
  if (!accessControlEnabled()) return { allowed: true };
  const token = extractToken(req, fallbackToken);
  if (!tokenMatches(token)) {
    return { allowed: false, reason: '缺少或无效的访问令牌' };
  }
  return { allowed: true };
}

/** 供前端判断是否需要提示输入令牌（不暴露令牌本身） */
export function authRequired(): boolean {
  return accessControlEnabled();
}

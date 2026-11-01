import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * 轻量访问控制 + 角色。
 *
 * 定位：这是一个本地仿真原型，默认不启用认证。
 * 但当它被放到局域网/服务器上给多人用时，"任何能连上的人都能改控制参数"
 * 是不可接受的——本模块提供最小可用的令牌认证。
 *
 * 角色模型（对标 wwtw-digital-twin 的四角色，收敛到三个）：
 * - viewer   ：只读。能看实时数据、历史、分析结果；
 * - operator ：可操作。能改控制量、注入场景、采纳建议；
 * - admin    ：可配置。能改拓扑、模型/Agent 配置、导入技能。
 *
 * 为什么需要：单令牌等于「所有人都是 admin」。观察大屏的值班员
 * 与能改拓扑的工艺工程师不该是同一个权限。
 *
 * 配置方式（保持零依赖、不引入用户库）：
 *   AQUAPILOT_TOKEN=xxx                     → 单令牌，等价 admin（向后兼容）
 *   AQUAPILOT_OPERATOR_TOKEN=yyy            → 操作员令牌
 *   AQUAPILOT_VIEWER_TOKEN=zzz              → 观察员令牌
 * 令牌只进环境变量，不落盘、不进日志、不回显。
 */

const ADMIN_ENV = 'AQUAPILOT_TOKEN';
const OPERATOR_ENV = 'AQUAPILOT_OPERATOR_TOKEN';
const VIEWER_ENV = 'AQUAPILOT_VIEWER_TOKEN';

export type Role = 'viewer' | 'operator' | 'admin';

/** 角色能力上限：数值越大权限越高 */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

export function accessControlEnabled(): boolean {
  return Boolean(
    process.env[ADMIN_ENV]?.trim() || process.env[OPERATOR_ENV]?.trim() || process.env[VIEWER_ENV]?.trim(),
  );
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 恒定时间比较。
 *
 * 遍历全部候选、不提前返回：若按顺序找到匹配就 return，
 * 响应时间会随「匹配到第几个令牌」变化，足以区分 viewer/operator/admin。
 */
function matchesAny(provided: string, candidates: { token: string; role: Role }[]): Role | null {
  const providedDigest = digest(provided);
  let matched: Role | null = null;
  for (const candidate of candidates) {
    const expected = digest(candidate.token);
    const same = expected.length === providedDigest.length && timingSafeEqual(expected, providedDigest);
    if (same && matched === null) matched = candidate.role;
  }
  return matched;
}

function configuredTokens(): { token: string; role: Role }[] {
  const out: { token: string; role: Role }[] = [];
  const admin = process.env[ADMIN_ENV]?.trim();
  const operator = process.env[OPERATOR_ENV]?.trim();
  const viewer = process.env[VIEWER_ENV]?.trim();
  if (admin) out.push({ token: admin, role: 'admin' });
  if (operator) out.push({ token: operator, role: 'operator' });
  if (viewer) out.push({ token: viewer, role: 'viewer' });
  return out;
}

/** 校验令牌并返回角色；未配置认证时返回 admin（本地开发零配置） */
export function roleForToken(provided: string | null | undefined): Role | null {
  const tokens = configuredTokens();
  if (tokens.length === 0) return 'admin';
  if (!provided) return null;
  return matchesAny(provided, tokens);
}

/** 恒定时间比较，避免计时侧信道（保留给只需要布尔的调用方） */
export function tokenMatches(provided: string | null | undefined): boolean {
  return roleForToken(provided) !== null;
}

/** 从请求中提取令牌：Authorization: Bearer / ?token= / Sec-WebSocket-Protocol */
export function extractToken(req: IncomingMessage, fallback?: string | null): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const url = req.url ?? '';
  const q = url.indexOf('?');
  const pathname = q >= 0 ? url.slice(0, q) : url;
  if (pathname === '/ws' && q >= 0) {
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
  role?: Role;
}

export function authorize(
  req: IncomingMessage,
  fallbackToken?: string | null,
  needed: Role = 'viewer',
): AccessDecision {
  if (!accessControlEnabled()) return { allowed: true, role: 'admin' };
  const token = extractToken(req, fallbackToken);
  const role = roleForToken(token);
  if (!role) {
    return { allowed: false, reason: '缺少或无效的访问令牌' };
  }
  if (!roleAtLeast(role, needed)) {
    return { allowed: false, reason: `当前令牌权限不足（需要 ${needed}）`, role };
  }
  return { allowed: true, role };
}

/** 供前端判断是否需要提示输入令牌（不暴露令牌本身） */
export function authRequired(): boolean {
  return accessControlEnabled();
}

/**
 * 每条客户端消息所需的最低角色。
 *
 * 只读消息（hello/chat/分析/历史查询）viewer 即可；
 * 会改变运行状态的消息需要 operator；
 * 改拓扑与配置需要 admin。
 */
export function canEditAgentConfig(role: Role): boolean {
  return role === 'admin';
}

export function requiredRoleFor(messageType: string): Role {
  switch (messageType) {
    case 'control':
    case 'aiEnabled':
    case 'applyRecommendation':
    case 'scenario':
    case 'sim':
    case 'speed':
    case 'refreshDecision':
    case 'preset':
      return 'operator';
    case 'topology':
    case 'llmConfig':
    case 'agentConfig':
    case 'calibration':
    case 'influent':
      return 'admin';
    default:
      return 'viewer';
  }
}

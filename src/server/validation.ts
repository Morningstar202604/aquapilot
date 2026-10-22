import { CONTROL_BOUNDS, ControlSettings } from '../sim/config';

/**
 * 运行时输入校验。
 *
 * 为什么需要：客户端消息经过 JSON.parse 后只是一个任意值。
 * TypeScript 的 `as ClientMessage` 只骗编译器，不校验运行时——
 * 一个 `null` 或 `{patch:{doSetpoint:null}}` 就能让服务端产生 NaN 甚至崩溃。
 *
 * 所有来自网络的输入都必须过这里。
 */

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验并夹紧控制量补丁；未知键与非法值一律丢弃，不做部分信任 */
export function sanitizeControlPatch(patch: unknown): ValidationResult<Partial<ControlSettings>> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' };
  }

  const src = patch as Record<string, unknown>;
  const out: Record<string, number> = {};
  const numericKeys = Object.keys(CONTROL_BOUNDS) as string[];

  for (const key of numericKeys) {
    if (!(key in src)) continue;
    const raw = src[key];
    if (!isFiniteNumber(raw)) {
      return { ok: false, error: `${key} 必须是有限数值` };
    }
    const b = CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS];
    if (raw < b.min || raw > b.max) {
      return { ok: false, error: `${key} 超出范围 [${b.min}, ${b.max}]` };
    }
    out[key] = raw;
  }

  return { ok: true, value: out as Partial<ControlSettings> };
}

/** 校验倍速 */
export function sanitizeSpeed(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < 0.25 || value > 8) return null;
  return value;
}

/** 校验 AI 开关 */
export function sanitizeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 校验聊天文本：长度上限，防止超长文本打满内存 */
export function sanitizeChatText(value: unknown, maxLen = 2000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/** 场景类型白名单 */
export const VALID_SCENARIOS = new Set([
  'storm',
  'shock_load',
  'toxic',
  'blower_failure',
  'ras_failure',
  'power_outage',
  'winter',
  'chemical_shortage',
]);

/** 校验数值在合理区间（用于场景时长、幅度） */
export function sanitizeRange(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/**
 * 校验客户端消息的基本形状。
 * 返回 null 表示不可处理（调用方应当拒绝而不是继续）。
 */
export function sanitizeMessage(raw: unknown): ({ type: string } & Record<string, unknown>) | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > 64) return null;
  return msg as { type: string } & Record<string, unknown>;
}

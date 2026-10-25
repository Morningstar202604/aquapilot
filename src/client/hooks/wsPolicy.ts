import type { ClientMessage } from '../../shared/protocol';

/**
 * WebSocket 客户端策略（纯函数，便于单测）。
 *
 * - 重连退避带抖动：多客户端同时断线时避免「同步撞击」服务端。
 * - 发送背压：socket 缓冲堆积（发送快于带宽）时合并为「最后一条胜出」，
 *   不丢弃用户最新的控制意图，也不无限堆积历史帧。
 */

/** 重连退避：base × retry，封顶 cap，再加 ≤jitterMs 的随机抖动 */
export function reconnectDelayMs(
  retry: number,
  opts: { base?: number; cap?: number; jitter?: () => number } = {},
): number {
  const base = opts.base ?? 600;
  const cap = opts.cap ?? 8000;
  const jitter = opts.jitter ?? (() => Math.random() * 400);
  return Math.min(cap, base * retry) + jitter();
}

/** 发送缓冲高水位（128 KiB）。超过即触发背压合并 */
export const BACKPRESSURE_LIMIT_BYTES = 128 * 1024;

/**
 * 计算本次发送计划：
 * - 缓冲超限 → 合并 pending（最后一条胜出），本轮不发；
 * - 有积压 → 先发积压再发当前；
 * - 正常 → 直接发当前。
 */
export function nextSendPlan(
  pending: ClientMessage | null,
  msg: ClientMessage,
  bufferedAmount: number,
  limit = BACKPRESSURE_LIMIT_BYTES,
): { pending: ClientMessage | null; toSend: ClientMessage[] } {
  if (bufferedAmount > limit) {
    return { pending: msg, toSend: [] };
  }
  if (pending) {
    return { pending: null, toSend: [pending, msg] };
  }
  return { pending: null, toSend: [msg] };
}

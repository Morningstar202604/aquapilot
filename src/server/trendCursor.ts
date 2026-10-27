/**
 * 增量趋势推送的游标（纯函数）。
 *
 * 为什么单独一个文件：这段逻辑出过一个真实缺陷——用「已收到的点数量」
 * 当游标，趋势缓冲写满 720 点后 `slice(count)` 永远为空，客户端从此
 * 收不到任何新点，曲线在后台静止。用时间戳做游标与缓冲长度无关。
 *
 * 第二个真实缺陷：重置仿真或应用新拓扑后，服务端清空趋势缓冲并从 t=0
 * 重新推点，但客户端游标仍停在旧时间（如 5000），`t > cursor` 永不成立，
 * 曲线再次静止。因此每次发送「全量快照」时必须调用 syncCursorToBuffer，
 * 把游标对齐到当前缓冲末尾。
 */

export interface TrendLike {
  t: number;
}

export interface TrendCursor {
  lastTrendT: number;
}

export function createCursor(): TrendCursor {
  // 起始游标必须早于任何合法仿真时刻（t=0 也算新点）
  return { lastTrendT: -1 };
}

/** 返回严格晚于游标的新点，并推进游标 */
export function takeNewPoints<T extends TrendLike>(buffer: T[], cursor: TrendCursor): T[] {
  const fresh = buffer.filter((p) => p.t > cursor.lastTrendT);
  if (fresh.length > 0) cursor.lastTrendT = fresh[fresh.length - 1].t;
  return fresh;
}

/**
 * 把游标对齐到缓冲末尾。
 *
 * 全量快照已经把整段趋势发给客户端了，游标若不同步，下一帧就会把同一段
 * 再发一遍（浪费带宽）；而重置后缓冲变短，游标若停在旧高点则会永久吞掉新点。
 * 两条都属于「快照与增量的一致性」问题，收口在这一个函数里。
 */
export function syncCursorToBuffer<T extends TrendLike>(buffer: T[], cursor: TrendCursor): void {
  cursor.lastTrendT = buffer.length > 0 ? buffer[buffer.length - 1].t : -1;
}

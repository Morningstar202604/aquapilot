/**
 * 增量趋势推送的游标（纯函数）。
 *
 * 为什么单独一个文件：这段逻辑出过一个真实缺陷——用「已收到的点数量」
 * 当游标，趋势缓冲写满 720 点后 `slice(count)` 永远为空，客户端从此
 * 收不到任何新点，曲线在后台静止。用时间戳做游标与缓冲长度无关。
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

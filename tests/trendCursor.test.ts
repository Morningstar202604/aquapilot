import { describe, expect, it } from 'vitest';
import { createCursor, syncCursorToBuffer, takeNewPoints } from '../src/server/trendCursor';

/**
 * 增量趋势游标。
 *
 * 曾经的真实缺陷：重置/换拓扑后服务端清空趋势缓冲并重新从 t=0 推点，
 * 但客户端游标还停在旧时间（如 5000），`t > cursor` 永远不成立，
 * 曲线从此静止。修复方式是在发送全量快照时把游标同步到缓冲末尾。
 */

const points = [{ t: 0 }, { t: 20 }, { t: 40 }];

describe('趋势游标', () => {
  it('初始游标能收到 t=0 的第一个点', () => {
    const cursor = createCursor();
    expect(takeNewPoints(points, cursor).map((p) => p.t)).toEqual([0, 20, 40]);
  });

  it('只返回严格新于游标的点', () => {
    const cursor = createCursor();
    takeNewPoints(points, cursor);
    expect(takeNewPoints([...points, { t: 60 }], cursor).map((p) => p.t)).toEqual([60]);
  });

  it('同步到缓冲末尾后不会重发历史点', () => {
    const cursor = createCursor();
    syncCursorToBuffer(points, cursor);
    expect(cursor.lastTrendT).toBe(40);
    expect(takeNewPoints(points, cursor)).toEqual([]);
  });

  it('重置到 t=0 后仍能继续收到新点（真实回归）', () => {
    const cursor = createCursor();
    takeNewPoints(points, cursor);
    expect(cursor.lastTrendT).toBe(40);
    // 服务端重置：缓冲清空后重新推 t=0
    const afterReset = [{ t: 0 }, { t: 20 }];
    syncCursorToBuffer(afterReset, cursor);
    expect(takeNewPoints(afterReset, cursor)).toEqual([]);
    expect(takeNewPoints([...afterReset, { t: 40 }], cursor).map((p) => p.t)).toEqual([40]);
  });

  it('空缓冲同步后游标回到 -1，不吞掉后续首个点', () => {
    const cursor = createCursor();
    takeNewPoints(points, cursor);
    syncCursorToBuffer([], cursor);
    expect(cursor.lastTrendT).toBe(-1);
    expect(takeNewPoints([{ t: 0 }], cursor).map((p) => p.t)).toEqual([0]);
  });
});

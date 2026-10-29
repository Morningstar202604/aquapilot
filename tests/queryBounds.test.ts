import { describe, expect, it } from 'vitest';
import { boundedWindow, MAX_SNAPSHOT_POINTS, MAX_SNAPSHOT_WINDOW_MIN } from '../src/server/queryBounds';

/**
 * 历史查询边界。
 *
 * 这一段是防 OOM 的唯一闸门：没有上限时 `to` 缺省为 MAX_SAFE_INTEGER，
 * 一次请求会把整张快照表读进内存并在主线程拼 JSON/CSV。
 */

describe('boundedWindow', () => {
  it('缺省 to 时给出 7 天窗口', () => {
    const r = boundedWindow(new URLSearchParams('from=100'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe(100);
      expect(r.to).toBe(100 + MAX_SNAPSHOT_WINDOW_MIN);
    }
  });

  it('接受区间内的显式窗口', () => {
    const r = boundedWindow(new URLSearchParams('from=0&to=1440'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.to - r.from).toBe(1440);
  });

  it('拒绝超长窗口', () => {
    const r = boundedWindow(new URLSearchParams('from=0&to=999999'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/最多查询/);
  });

  it('拒绝非有限数值', () => {
    expect(boundedWindow(new URLSearchParams('from=abc')).ok).toBe(false);
    expect(boundedWindow(new URLSearchParams('from=0&to=Infinity')).ok).toBe(false);
  });

  it('拒绝反向区间', () => {
    const r = boundedWindow(new URLSearchParams('from=10&to=5'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/大于等于/);
  });

  it('行数上限是有限正数', () => {
    expect(MAX_SNAPSHOT_POINTS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_SNAPSHOT_POINTS)).toBe(true);
  });
});

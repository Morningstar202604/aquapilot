// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  autoYMax,
  lttb,
  loadRangePreference,
  saveRangePreference,
  sliceByRange,
} from '../src/client/components/trendData';

/**
 * 趋势图纯逻辑测试。
 *
 * 这里断言的都不是"函数被调用过"，而是可观测的结果：
 * 窗口边界、峰谷是否被保留、坐标轴留白规则、偏好读写的容错。
 */

interface P {
  t: number;
  v: number;
}

function series(n: number, step = 2): P[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * step, v: 10 + (i % 7) }));
}

describe('sliceByRange', () => {
  it('all 原样返回，不复制数组', () => {
    const pts = series(10);
    expect(sliceByRange(pts, 'all')).toBe(pts);
  });

  it('空数组不报错', () => {
    expect(sliceByRange([], '6h')).toEqual([]);
  });

  it('按仿真分钟从末尾回看：24h 窗口取最后 1440 分钟', () => {
    // 每点 2 分钟，2000 点 => 覆盖 0..3998 分钟
    const pts = series(2000);
    const out = sliceByRange(pts, '24h');
    const lastT = pts[pts.length - 1].t;
    expect(out[out.length - 1].t).toBe(lastT);
    expect(out[0].t).toBeGreaterThanOrEqual(lastT - 1440);
    // 首点必须是窗口内第一个满足条件的点，不能多留
    expect(out[0].t - 2).toBeLessThan(lastT - 1440);
  });

  it('数据不足窗口长度时返回全部（退化为全部可用数据）', () => {
    const pts = series(10); // 只覆盖 18 分钟
    expect(sliceByRange(pts, '72h')).toHaveLength(10);
  });

  it('6h 窗口严格窄于 24h 窗口', () => {
    const pts = series(2000);
    expect(sliceByRange(pts, '6h').length).toBeLessThan(sliceByRange(pts, '24h').length);
  });
});

describe('lttb', () => {
  const value = (p: P) => p.v;

  it('点数不超过阈值时原样返回', () => {
    const pts = series(50);
    expect(lttb(pts, 100, value)).toBe(pts);
  });

  it('阈值过小（<=2）时原样返回，不产生退化输出', () => {
    const pts = series(50);
    expect(lttb(pts, 2, value)).toBe(pts);
  });

  it('输出点数等于阈值，且首尾点必被保留', () => {
    const pts = series(1000);
    const out = lttb(pts, 100, value);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  it('保留尖峰——简单等距抽稀会丢掉它', () => {
    // 200 点平值，第 97 点插一个 10 倍尖峰
    const pts: P[] = Array.from({ length: 200 }, (_, i) => ({ t: i * 2, v: 10 }));
    pts[97].v = 100;
    const out = lttb(pts, 50, value);
    expect(out.some((p) => p.v === 100)).toBe(true);
  });

  it('保序：输出时间戳严格递增', () => {
    const pts = series(500);
    const out = lttb(pts, 80, value);
    for (let i = 1; i < out.length; i += 1) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });
});

describe('autoYMax', () => {
  it('数据最大值留 60% 余量', () => {
    expect(autoYMax([10], 5)).toBeCloseTo(16, 5);
  });

  it('限值占主导时按限值的 1.35 倍留白', () => {
    // 数据最大值 1，限值 50 => 50*1.35 远大于 1*1.6
    expect(autoYMax([1], 50)).toBeCloseTo(67.5, 5);
  });

  it('空数据也有下限，不会算出 0 或 NaN', () => {
    expect(autoYMax([], 0)).toBe(0.5);
  });

  it('全零数据不返回 0（否则 Y 轴退化）', () => {
    expect(autoYMax([0, 0], 0)).toBeGreaterThan(0);
  });
});

describe('范围偏好持久化', () => {
  it('无记录时回落到 all', () => {
    localStorage.clear();
    expect(loadRangePreference()).toBe('all');
  });

  it('写入后可读回', () => {
    localStorage.clear();
    saveRangePreference('12h');
    expect(loadRangePreference()).toBe('12h');
  });

  it('存储里是非法值时回落到 all，不抛异常', () => {
    localStorage.clear();
    localStorage.setItem('aquapilot.trend.range', 'banana');
    expect(loadRangePreference()).toBe('all');
  });
});

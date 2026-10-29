import { describe, expect, it } from 'vitest';
import { checkQuality } from '../src/sim/dataQuality';
import { parseInfluentCsv, type InfluentSeries } from '../src/sim/influentSeries';

/**
 * 进水数据质量校验。
 *
 * 对标 wwtw-digital-twin 的 `ingest/quality.ts`：真实水厂数据有探头漂移、
 * 通讯丢包、单位错填。脏数据进模型不会报错，只会让结果悄悄偏掉。
 * 这里锁住四类检查：取值范围、突变、卡值、断档。
 */

function series(rows: (string | number)[][]): InfluentSeries {
  return parseInfluentCsv(rows.map((r) => r.join(',')).join('\n'));
}

/** 生成有真实波动的数据（避免卡值检测误报） */
function realistic(n = 96): InfluentSeries {
  return series(
    Array.from({ length: n }, (_, i) => [
      i * 15,
      (2000 + Math.sin(i / 5) * 200 + Math.sin(i / 2) * 30).toFixed(1),
      (350 + Math.sin(i / 4) * 30).toFixed(1),
      (34 + Math.cos(i / 6) * 3).toFixed(2),
      (4.8 + Math.sin(i / 7) * 0.3).toFixed(2),
      (180 + Math.sin(i / 9) * 15).toFixed(1),
      (20 + Math.sin(i / 20) * 0.4).toFixed(2),
    ]),
  );
}

describe('正常数据', () => {
  it('有真实波动时满分且无问题', () => {
    const r = checkQuality(realistic());
    expect(r.score).toBe(100);
    expect(r.usable).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('给出分指标的统计摘要', () => {
    const r = checkQuality(realistic());
    expect(r.perMetric.flow.min).toBeGreaterThan(0);
    expect(r.perMetric.flow.max).toBeGreaterThan(r.perMetric.flow.min);
    expect(Number.isFinite(r.perMetric.cod.mean)).toBe(true);
    for (const k of ['flow', 'cod', 'nh', 'tp', 'ss', 'temperature']) {
      expect(r.perMetric[k]).toBeDefined();
    }
  });
});

describe('取值范围', () => {
  it('超出物理可能的读数报 error 并标记不可用', () => {
    const r = checkQuality(
      series([
        [0, 99999, 350, 34, 4.8, 180, 20],
        [60, 2001, 351, 35, 4.8, 181, 20],
      ]),
    );
    expect(r.usable).toBe(false);
    expect(r.issues.some((i) => i.code === 'out-of-range' && i.severity === 'error')).toBe(true);
  });

  it('负值同样被拒绝', () => {
    const r = checkQuality(
      series([
        [0, -500, 350, 34, 4.8, 180, 20],
        [60, 2000, 351, 35, 4.8, 181, 20],
      ]),
    );
    expect(r.issues.some((i) => i.code === 'out-of-range')).toBe(true);
  });

  it('同一指标只报第一条越界（不刷屏）', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i * 15, 99999, 350 + i, 34, 4.8, 180, 20]);
    const r = checkQuality(series(rows));
    expect(r.issues.filter((i) => i.code === 'out-of-range' && i.metric === 'flow')).toHaveLength(1);
  });
});

describe('突变', () => {
  it('单步剧变报 warning', () => {
    const rows = [
      [0, 2000, 350, 34, 4.8, 180, 20],
      [60, 2000, 350, 34, 4.8, 180, 20],
      [120, 4000, 350, 34, 4.8, 180, 20], // 流量翻倍
    ];
    const r = checkQuality(series(rows));
    expect(r.issues.some((i) => i.code === 'spike' && i.metric === 'flow')).toBe(true);
  });

  it('缓慢变化不报突变', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i * 15, 2000 + i * 20, 350, 34, 4.8, 180, 20]);
    const r = checkQuality(series(rows));
    expect(r.issues.some((i) => i.code === 'spike')).toBe(false);
  });
});

describe('卡值（探头冻结）', () => {
  it('快变量连续 12 点相同报 warning', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i * 15, 2000, 350, 34, 4.8, 180, 20]);
    const r = checkQuality(series(rows));
    expect(r.issues.some((i) => i.code === 'stuck' && i.metric === 'flow')).toBe(true);
  });

  it('慢变量用更宽的阈值（6 小时恒定才报）', () => {
    // 48 点（12 小时）温度恒定 → 超过 24 点阈值，应报
    const rows = Array.from({ length: 48 }, (_, i) => [
      i * 15,
      2000 + Math.sin(i / 3) * 100,
      350 + Math.sin(i / 4) * 20,
      34 + Math.sin(i / 5) * 2,
      4.8,
      180,
      20,
    ]);
    const r = checkQuality(series(rows));
    expect(r.issues.some((i) => i.code === 'stuck' && i.metric === 'temperature')).toBe(true);
    // 但快变量有波动，不应误报
    expect(r.issues.some((i) => i.code === 'stuck' && i.metric === 'flow')).toBe(false);
  });
});

describe('断档', () => {
  it('采样间隔远大于中位数时报 warning', () => {
    const rows = [
      [0, 2000, 350, 34, 4.8, 180, 20],
      [15, 2001, 351, 34.1, 4.8, 181, 20],
      [30, 2002, 352, 34.2, 4.8, 182, 20],
      [2000, 2003, 353, 34.3, 4.8, 183, 20], // 巨大断档
      [2015, 2004, 354, 34.4, 4.8, 184, 20],
    ];
    const r = checkQuality(series(rows));
    expect(r.issues.some((i) => i.code === 'gap')).toBe(true);
  });
});

describe('样本量', () => {
  it('少于 24 点报样本不足（warning，不是 error）', () => {
    const r = checkQuality(realistic(5));
    const issue = r.issues.find((i) => i.code === 'insufficient');
    expect(issue?.severity).toBe('warning');
    expect(r.usable).toBe(true);
  });
});

describe('空数据', () => {
  it('返回 0 分且不可用', () => {
    const r = checkQuality({ name: 'x', samples: [], durationMin: 0, warnings: [] });
    expect(r.score).toBe(0);
    expect(r.usable).toBe(false);
    expect(r.issues[0].code).toBe('insufficient');
  });
});

describe('评分与可用性', () => {
  it('error 权重高于 warning', () => {
    const withError = checkQuality(
      series([
        [0, 99999, 350, 34, 4.8, 180, 20],
        [60, 2001, 351, 35, 4.8, 181, 20],
      ]),
    );
    const withWarning = checkQuality(realistic(10)); // 只有样本不足 warning
    expect(withError.score).toBeLessThan(withWarning.score);
    expect(withError.usable).toBe(false);
    expect(withWarning.usable).toBe(true);
  });

  it('每个问题都带可执行建议', () => {
    const r = checkQuality(
      series([
        [0, 99999, 350, 34, 4.8, 180, 20],
        [60, 2001, 351, 35, 4.8, 181, 20],
      ]),
    );
    for (const issue of r.issues) {
      expect(issue.action.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

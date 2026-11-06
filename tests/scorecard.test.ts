import { describe, expect, it } from 'vitest';
import {
  SCORECARD_WEIGHTS,
  STANDARD_30_DAY_CRISIS,
  computeScorecard,
  scorecardFromTrend,
  violationsOf,
  type ScorecardSample,
} from '../src/sim/scorecard';
import { BSM1_REFERENCE, GB18918_1A, GB18918_1B, standardById } from '../src/sim/standards';

/**
 * 运营评分卡测试。
 *
 * 断言的焦点是「分数必须可复算、可解释」：
 * - 同一份样本换标准，达标维度必须跟着变（否则口径是假的）；
 * - 扣分项必须指向具体指标与样本数，不能只给一个数字；
 * - 空/单点/全超标这些边界不能产出 NaN 或 -0。
 */

const ok = (minute: number, extra: Partial<ScorecardSample> = {}): ScorecardSample => ({
  minute,
  effluent: { flow: 2000, cod: 30, bod: 6, ss: 6, nh: 1, tn: 10, tp: 0.2, ph: 7.2, temperature: 20 },
  energyKw: 300,
  mlss: 3000,
  srtDays: 15,
  inScenario: false,
  ...extra,
});

const bad = (minute: number, extra: Partial<ScorecardSample> = {}): ScorecardSample => ({
  ...ok(minute),
  effluent: { flow: 2000, cod: 90, bod: 20, ss: 25, nh: 9, tn: 20, tp: 1.2, ph: 7.2, temperature: 20 },
  ...extra,
});

describe('violationsOf', () => {
  it('全部达标时返回空数组', () => {
    expect(violationsOf(ok(0).effluent)).toEqual([]);
  });

  it('逐项列出超限指标与实际值', () => {
    const v = violationsOf(bad(0).effluent);
    const metrics = v.map((x) => x.metric).sort();
    expect(metrics).toEqual(['bod', 'cod', 'nh', 'ss', 'tn', 'tp']);
    const cod = v.find((x) => x.metric === 'cod')!;
    expect(cod.value).toBe(90);
    expect(cod.limit).toBe(GB18918_1A.limits.cod);
  });

  it('换标准会改变判定结果', () => {
    // SS 12：一级 A（10）超标，一级 B（20）达标
    const e = { ...ok(0).effluent, ss: 12 };
    expect(violationsOf(e, GB18918_1A.limits).map((v) => v.metric)).toContain('ss');
    expect(violationsOf(e, GB18918_1B.limits).map((v) => v.metric)).not.toContain('ss');
  });

  it('NaN 不会被误判为超标', () => {
    const e = { ...ok(0).effluent, cod: Number.NaN };
    expect(violationsOf(e).some((v) => v.metric === 'cod')).toBe(false);
  });
});

describe('computeScorecard 四维', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ok(i));

  it('全达标 / 合理能耗 / 稳定生物量时接近满分', () => {
    const card = computeScorecard(samples, 2000);
    expect(card.dimensions).toHaveLength(4);
    const byKey = Object.fromEntries(card.dimensions.map((d) => [d.key, d.score]));
    expect(byKey.compliance).toBe(100);
    expect(byKey.stability).toBe(100);
    expect(byKey.crisis).toBe(100); // 无场景时不惩罚
    expect(card.total).toBeGreaterThanOrEqual(90);
  });

  it('权重之和为 100，总分与加权平均一致', () => {
    const card = computeScorecard(samples, 2000);
    const weightSum = card.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(weightSum).toBe(100);
    const expected = Math.round(card.dimensions.reduce((s, d) => s + (d.score * d.weight) / 100, 0));
    expect(card.total).toBe(expected);
    expect(SCORECARD_WEIGHTS.compliance).toBe(40);
  });

  it('全超标时达标维度为 0，并逐项列出扣分指标', () => {
    const card = computeScorecard(
      Array.from({ length: 50 }, (_, i) => bad(i)),
      2000,
    );
    const compliance = card.dimensions.find((d) => d.key === 'compliance')!;
    expect(compliance.score).toBe(0);
    expect(compliance.deductions.length).toBeGreaterThan(1);
    expect(compliance.deductions.join(' ')).toContain('ss');
    expect(card.violations.length).toBe(6);
  });

  it('达标率映射：95% 以上满分，之后快速下降', () => {
    const nineteenOf20 = Array.from({ length: 20 }, (_, i) => (i < 19 ? ok(i) : bad(i)));
    const card = computeScorecard(nineteenOf20, 2000);
    expect(card.dimensions.find((d) => d.key === 'compliance')!.score).toBe(100);

    const half = Array.from({ length: 20 }, (_, i) => (i < 10 ? ok(i) : bad(i)));
    expect(computeScorecard(half, 2000).dimensions.find((d) => d.key === 'compliance')!.score).toBe(0);
  });

  it('能耗越高分越低，且封顶 100、封底 0', () => {
    const low = computeScorecard([ok(0, { energyKw: 100 })], 2000);
    const high = computeScorecard([ok(0, { energyKw: 5000 })], 2000);
    expect(low.dimensions.find((d) => d.key === 'energy')!.score).toBe(100);
    expect(high.dimensions.find((d) => d.key === 'energy')!.score).toBe(0);
  });

  it('MLSS 与 SRT 越界都计入生物稳定扣分', () => {
    const card = computeScorecard([ok(0, { mlss: 800 }), ok(1, { srtDays: 2 })], 2000);
    const stability = card.dimensions.find((d) => d.key === 'stability')!;
    expect(stability.score).toBe(50); // 2 个样本 × 2 指标，各挂 1 个
    expect(stability.deductions.join(' ')).toContain('MLSS');
    expect(stability.deductions.join(' ')).toContain('SRT');
  });

  it('场景内违规率高于常态时，危机维度扣分并说明差值', () => {
    const mid = Array.from({ length: 100 }, (_, i) => ok(i));
    const inScenario = Array.from({ length: 50 }, (_, i) => bad(100 + i, { inScenario: true }));
    const card = computeScorecard([...mid, ...inScenario], 2000);
    const crisis = card.dimensions.find((d) => d.key === 'crisis')!;
    expect(crisis.score).toBe(0);
    expect(crisis.deductions.join(' ')).toContain('场景内违规率');
  });
});

describe('computeScorecard 边界', () => {
  it('空样本返回零值结构，不抛异常', () => {
    const card = computeScorecard([], 2000);
    expect(card.total).toBe(0);
    expect(card.dimensions).toEqual([]);
    expect(card.samples).toBe(0);
  });

  it('单点样本可算，不产生 NaN', () => {
    const card = computeScorecard([ok(0)], 2000);
    expect(Number.isFinite(card.total)).toBe(true);
    expect(card.spanMin).toBe(0);
  });

  it('结果里写明判读口径', () => {
    const card = computeScorecard([ok(0)], 2000);
    expect(card.standard.id).toBe(GB18918_1A.id);
    expect(card.standard.label).toContain('一级 A');
  });

  it('换 BSM1 口径后，同一份样本的达标率只升不降', () => {
    // SS 12 / COD 80：一级 A 两项都超，BSM1 口径两项都过
    const samples = Array.from({ length: 10 }, (_, i) => ({
      ...ok(i),
      effluent: { ...ok(i).effluent, ss: 12, cod: 80 },
    }));
    const strict = computeScorecard(samples, 2000, GB18918_1A);
    const loose = computeScorecard(samples, 2000, BSM1_REFERENCE);
    expect(strict.dimensions.find((d) => d.key === 'compliance')!.score).toBe(0);
    expect(loose.dimensions.find((d) => d.key === 'compliance')!.score).toBe(100);
  });
});

describe('scorecardFromTrend', () => {
  const trendPoint = (t: number) => ({
    t,
    effluentCod: 30,
    effluentBod: 6,
    effluentNh: 1,
    effluentTn: 10,
    effluentTp: 0.2,
    effluentSs: 6,
    mlss: 3000,
    srtDays: 15,
    energyKw: 300,
  });

  it('把趋势点映射成样本并标记场景区间', () => {
    const card = scorecardFromTrend([trendPoint(100), trendPoint(200), trendPoint(300)], {
      flowM3h: 2000,
      scenarioWindow: { from: 150, to: 250 },
    });
    expect(card.samples).toBe(3);
    expect(card.spanMin).toBe(200);
  });

  it('无场景时危机维度满分', () => {
    const card = scorecardFromTrend([trendPoint(0), trendPoint(10)], { flowM3h: 2000, scenarioWindow: null });
    expect(card.dimensions.find((d) => d.key === 'crisis')!.score).toBe(100);
  });
});

describe('标准档案', () => {
  it('按 id 查得到，大小写不敏感', () => {
    expect(standardById('gb18918-1a')?.id).toBe('gb18918-1a');
    expect(standardById('GB18918-1A')?.id).toBe('gb18918-1a');
  });

  it('未知 id 返回 undefined 而不是默认值', () => {
    expect(standardById('iso-9999')).toBeUndefined();
  });

  it('一级 A 严于一级 B（每项都不宽松）', () => {
    for (const key of ['cod', 'bod', 'ss', 'nh', 'tn', 'tp'] as const) {
      expect(GB18918_1A.limits[key]).toBeLessThanOrEqual(GB18918_1B.limits[key]);
    }
  });
});

describe('标准 30 天危机脚本', () => {
  it('六次扰动按时间排序', () => {
    const days = STANDARD_30_DAY_CRISIS.map((s) => s.day);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it('全部落在 30 天窗口内', () => {
    for (const step of STANDARD_30_DAY_CRISIS) {
      expect(step.day + step.durationDays).toBeLessThanOrEqual(30);
    }
  });

  it('每次扰动都有可读意图，不是纯类型名', () => {
    for (const step of STANDARD_30_DAY_CRISIS) {
      expect(step.intent.length).toBeGreaterThan(6);
    }
  });
});

/**
 * 置信度门槛。
 *
 * 存在的原因是一个实测缺陷：只喂 3 个采样点（6 分钟仿真）时评分卡给出
 * 98 分，与跑满 8 小时的 98 分视觉上完全一样。分数不压制，但必须标明
 * 它有多硬，否则就是假精度。
 */
describe('置信度', () => {
  const samplesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      minute: i * 2,
      effluent: { flow: 2000, cod: 30, bod: 6, ss: 6, nh: 1, tn: 10, tp: 0.2, ph: 7.2, temperature: 20 },
      energyKw: 300,
      mlss: 3000,
      srtDays: 15,
      inScenario: false,
    }));

  it('少于 12 点为 insufficient', () => {
    expect(computeScorecard(samplesOf(1), 2000).confidence).toBe('insufficient');
    expect(computeScorecard(samplesOf(11), 2000).confidence).toBe('insufficient');
  });

  it('12 点起为 provisional', () => {
    expect(computeScorecard(samplesOf(12), 2000).confidence).toBe('provisional');
    expect(computeScorecard(samplesOf(239), 2000).confidence).toBe('provisional');
  });

  it('240 点起为 stable', () => {
    expect(computeScorecard(samplesOf(240), 2000).confidence).toBe('stable');
  });

  it('空样本为 insufficient', () => {
    expect(computeScorecard([], 2000).confidence).toBe('insufficient');
  });

  it('置信度不影响分数本身（分数照算，只是标注可信度）', () => {
    const few = computeScorecard(samplesOf(5), 2000);
    const many = computeScorecard(samplesOf(300), 2000);
    expect(few.total).toBe(many.total);
    expect(few.confidence).not.toBe(many.confidence);
  });
});

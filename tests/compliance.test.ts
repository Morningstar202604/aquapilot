import { describe, expect, it } from 'vitest';
import { parse as parseCsv } from 'csv-parse/sync';
import { DEFAULT_STANDARD } from '../src/sim/standards';
import {
  DEFAULT_SAMPLING_CONFIG,
  buildCompositeSample,
  buildGrabSample,
  evaluateSample,
  samplesFromReadings,
  trendPointsToReadings,
  weightedMean,
  type MetricKey,
  type MinuteReading,
  type SamplingConfig,
} from '../src/sim/sampling';
import { ComplianceError, buildComplianceReport, expectedAssessmentDays, percentile95 } from '../src/sim/compliance';
import { buildComplianceCsv, complianceRoute } from '../src/server/routes/compliance';

const DAY = 24 * 60;

const cfg = (over?: Partial<SamplingConfig>): SamplingConfig => ({
  ...DEFAULT_SAMPLING_CONFIG,
  ...over,
});

function reading(minute: number, flowM3h: number, values: Partial<Record<MetricKey, number>>): MinuteReading {
  return { minute, flowM3h, values };
}

const limits = DEFAULT_STANDARD.limits;

function reportOf(
  samples: Parameters<typeof buildComplianceReport>[0],
  over: Partial<Parameters<typeof buildComplianceReport>[1]> = {},
) {
  return buildComplianceReport(samples, {
    limits,
    standardId: DEFAULT_STANDARD.id,
    fromMin: 0,
    toMin: 2 * DAY,
    ...over,
  });
}

describe('流量加权日混合样', () => {
  it('高低流量交替：加权均值偏向高流量时段，不等于算术均值', () => {
    // 高流量带低浓度、低流量带高浓度
    const readings = [reading(0, 1000, { cod: 20 }), reading(1, 100, { cod: 38 })];
    const w = weightedMean(readings.map((r) => ({ value: r.values.cod as number, flow: r.flowM3h })));
    expect(w).not.toBeNull();
    expect(w!.totalFlow).toBe(1100);
    // Σ(C·Q)/ΣQ = (20·1000 + 38·100)/1100 ≈ 21.6364
    expect(w!.mean).toBeCloseTo(23800 / 1100, 6);

    const arithmetic = (20 + 38) / 2;
    expect(w!.mean).not.toBeCloseTo(arithmetic, 6);
    expect(w!.mean).toBeLessThan(arithmetic);

    const sample = buildCompositeSample(readings, 0, cfg(), 'c1');
    expect(sample.results.cod.value).toBeCloseTo(w!.mean, 6);
  });

  it('总流量 ≤ 0 时加权结果为 null，不产出假均值', () => {
    expect(weightedMean([{ value: 20, flow: 0 }])).toBeNull();
    expect(weightedMean([])).toBeNull();
  });
});

describe('QA 判定与样品三态', () => {
  it('校准失效样品判 qa-failed，value 置 null，不进达标统计', () => {
    const ok = buildCompositeSample([reading(0, 500, { cod: 30 })], 0, cfg(), 'ok');
    const bad = evaluateSample(
      buildCompositeSample([reading(DAY, 500, { cod: 90 })], DAY, cfg(), 'bad'),
      cfg({ calibrationValid: false }),
    );

    expect(bad.results.cod.validity).toBe('qa-failed');
    expect(bad.results.cod.value).toBeNull();

    const report = reportOf([ok, bad]);
    const m = report.metrics.cod;
    expect(m.acceptedCount).toBe(1);
    expect(m.rejectedCount).toBe(1);
    expect(m.validAssessmentDays).toBe(1);
    expect(m.compliantDays).toBe(1);
    expect(m.complianceRatePct).toBeCloseTo(100);
    expect(m.exceedDayCount).toBe(0);
    expect(m.exceedSampleCount).toBe(0);
  });

  it('平行样 RPD 超阈值判 qa-failed；阈值内保留 accepted', () => {
    const sample = buildGrabSample(reading(0, 500, { cod: 30 }), cfg(), 'g1');
    const failed = evaluateSample(sample, cfg(), { cod: { replicateA: 30, replicateB: 45 } });
    expect(failed.results.cod.validity).toBe('qa-failed');
    expect(failed.results.cod.rpdPct).toBeCloseTo(40, 5);

    const passed = evaluateSample(sample, cfg(), { cod: { replicateA: 30, replicateB: 33 } });
    expect(passed.results.cod.validity).toBe('accepted');
  });

  it('留样超期判 void', () => {
    const raw = buildGrabSample(reading(0, 500, { cod: 30 }), cfg(), 'g1');
    const sample = evaluateSample(raw, cfg({ holdingTimeMin: 60 }));
    expect(sample.results.cod.validity).toBe('void');
    expect(sample.results.cod.value).toBeNull();
  });
});

describe('检出限（<DL）处理', () => {
  it('half-dl：低于检出限记 1/2 DL，标 belowDL + censored', () => {
    const sample = buildGrabSample(reading(0, 500, { cod: 1 }), cfg(), 'g1');
    const r = sample.results.cod;
    expect(r.belowDL).toBe(true);
    expect(r.censored).toBe(true);
    expect(r.raw).toBeCloseTo(1, 6);
    expect(r.value).toBeCloseTo(1, 6); // DL cod = 2 → 1/2 DL = 1
  });

  it('zero 规则记 0；raw 规则保留实测值且不标删失', () => {
    const zero = buildGrabSample(reading(0, 500, { cod: 1 }), cfg({ belowDlRule: 'zero' }), 'g2');
    expect(zero.results.cod.value).toBe(0);
    expect(zero.results.cod.censored).toBe(true);

    const raw = buildGrabSample(reading(0, 500, { cod: 1 }), cfg({ belowDlRule: 'raw' }), 'g3');
    expect(raw.results.cod.value).toBeCloseTo(1, 6);
    expect(raw.results.cod.censored).toBe(false);
  });

  it('高于检出限不触发删失', () => {
    const sample = buildGrabSample(reading(0, 500, { cod: 10 }), cfg(), 'g4');
    expect(sample.results.cod.belowDL).toBe(false);
    expect(sample.results.cod.censored).toBe(false);
  });
});

describe('95 分位算法（type-7 线性插值）', () => {
  it('1..100 分布：P95 = 95.05', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile95(values)).toBeCloseTo(95.05, 10);
  });

  it('n = 2：[0, 100] → 95；n = 1 返回唯一值；空集为 null', () => {
    expect(percentile95([0, 100])).toBeCloseTo(95, 10);
    expect(percentile95([42])).toBeCloseTo(42, 10);
    expect(percentile95([])).toBeNull();
  });
});

describe('合规统计口径', () => {
  it('月度滚动均值：31 个有效日只取最近 30 日，边界天数可追溯', () => {
    const readings = Array.from({ length: 31 }, (_, d) => reading(d * DAY, 500, { cod: d + 1 }));
    const report = reportOf(samplesFromReadings(readings, cfg()), {
      toMin: 31 * DAY - 1,
      monthWindowDays: 30,
      p95WindowDays: 30,
    });
    const m = report.metrics.cod;
    // 最近 30 日为 2..31，均值 = (2+31)/2 = 16.5
    expect(m.monthlyMeanDays).toBe(30);
    expect(m.monthlyMean).toBeCloseTo(16.5, 6);
    expect(m.daily).toHaveLength(31);
  });

  it('有效日不足窗口长度时按实际有效日计算，不补零', () => {
    const readings = Array.from({ length: 5 }, (_, d) => reading(d * DAY, 500, { cod: d + 1 }));
    const report = reportOf(samplesFromReadings(readings, cfg()), {
      toMin: 5 * DAY,
      monthWindowDays: 30,
    });
    const m = report.metrics.cod;
    expect(m.monthlyMeanDays).toBe(5);
    expect(m.monthlyMean).toBeCloseTo(3, 6);
  });

  it('达标率分母是有效考核日；缺测日拉低完整率', () => {
    // 第 0 天合格；第 1 天完全缺测
    const readings = [reading(0, 500, { cod: 30 })];
    const report = reportOf(samplesFromReadings(readings, cfg()), { toMin: 2 * DAY });
    const m = report.metrics.cod;
    expect(m.validAssessmentDays).toBe(1);
    expect(expectedAssessmentDays(0, 2 * DAY)).toBe(2);
    expect(m.completenessPct).toBeCloseTo(50, 6);
    expect(m.complianceRatePct).toBeCloseTo(100, 6);
  });

  it('超标次数与幅度按日均值统计', () => {
    const readings = [
      reading(0, 500, { cod: 30 }),
      reading(DAY, 500, { cod: 60 }), // 限值 50，超标 10 mg/L，1.2 倍
    ];
    const report = reportOf(samplesFromReadings(readings, cfg()), { toMin: 2 * DAY });
    const m = report.metrics.cod;
    expect(m.exceedDayCount).toBe(1);
    expect(m.maxExceedRatio).toBeCloseTo(1.2, 6);
    expect(m.maxExceedAmount).toBeCloseTo(10, 6);
    expect(m.complianceRatePct).toBeCloseTo(50, 6);
  });

  it('窗口内无合格样品：抛 COMPLIANCE_NO_SAMPLES', () => {
    expect.assertions(2);
    try {
      reportOf([]);
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceError);
      expect((err as ComplianceError).code).toBe('COMPLIANCE_NO_SAMPLES');
    }
  });

  it('窗口非法：to < from 抛 PERMIT_WINDOW_INVALID', () => {
    expect.assertions(2);
    const sample = buildCompositeSample([reading(0, 500, { cod: 30 })], 0, cfg(), 'x');
    try {
      reportOf([sample], { fromMin: 100, toMin: 50 });
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceError);
      expect((err as ComplianceError).code).toBe('PERMIT_WINDOW_INVALID');
    }
  });
});

describe('合规路由（纯函数）', () => {
  const urlOf = (query: string) => new URL(`http://localhost/api/compliance/${query}`);
  const readings = [reading(0, 500, { cod: 30 }), reading(DAY, 500, { cod: 60 })];

  it('未知路径返回 null，交回调用方 404', () => {
    expect(complianceRoute('/api/compliance/other', urlOf(''), { readings })).toBeNull();
  });

  it('report JSON：200，逐指标含限值/达标率/分位口径', () => {
    const reply = complianceRoute('/api/compliance/report', urlOf('report?from=0&to=2880'), { readings });
    expect(reply?.status).toBe(200);
    const body = reply?.body as { metrics: Record<string, { limit: number; complianceRatePct: number }> };
    expect(body.metrics.cod.limit).toBe(limits.cod);
    expect(body.metrics.cod.complianceRatePct).toBeCloseTo(50, 6);
  });

  it('report CSV：表头齐全，行数 = 样品数 × 指标数', () => {
    const reply = complianceRoute('/api/compliance/report', urlOf('report?from=0&to=2880&format=csv'), { readings });
    expect(reply?.status).toBe(200);
    const body = reply?.body as { csv: string };
    const rows = parseCsv(body.csv, { columns: true }) as Record<string, string>[];
    expect(rows.length).toBe(4 * 6); // 2 份混合样 + 2 份抓样 × 6 指标
    const headers = Object.keys(rows[0]);
    for (const h of [
      'metric',
      'limit_mg_l',
      'sample_value_mg_l',
      'sample_type',
      'sampled_at_min',
      'result_available_at_min',
      'qa_status',
      'below_dl',
      'censored',
      'verdict',
      'statistical_basis',
      'sample_id',
      'data_source',
    ]) {
      expect(headers).toContain(h);
    }
    const compositeRows = rows.filter((r) => r.sample_type === 'composite');
    expect(compositeRows.length).toBe(2 * 6);
    expect(compositeRows.every((r) => r.statistical_basis === 'daily-composite-24h')).toBe(true);
  });

  it('samples 端点返回样品明细与 QA 状态', () => {
    const reply = complianceRoute('/api/compliance/samples', urlOf('samples?from=0&to=2880'), {
      readings,
    });
    expect(reply?.status).toBe(200);
    const body = reply?.body as { count: number; samples: { id: string; results: object }[] };
    expect(body.count).toBe(4);
    expect(body.samples[0].results).toHaveProperty('cod');
  });

  it('非法 format 返回 400 PERMIT_WINDOW_INVALID', () => {
    const reply = complianceRoute('/api/compliance/report', urlOf('report?from=0&to=2880&format=xml'), { readings });
    expect(reply?.status).toBe(400);
    expect((reply?.body as { code: string }).code).toBe('PERMIT_WINDOW_INVALID');
  });

  it('窗口非法返回 400；无合格样品返回 422', () => {
    const badWindow = complianceRoute('/api/compliance/report', urlOf('report?from=100&to=50'), { readings });
    expect(badWindow?.status).toBe(400);
    expect((badWindow?.body as { code: string }).code).toBe('PERMIT_WINDOW_INVALID');

    const empty = complianceRoute('/api/compliance/report', urlOf('report?from=0&to=2880'), {
      readings: [],
    });
    expect(empty?.status).toBe(422);
    expect((empty?.body as { code: string }).code).toBe('COMPLIANCE_NO_SAMPLES');
  });

  it('TrendPoint 适配器字段映射一致', () => {
    const tp = [
      {
        t: 0,
        influentCod: 300,
        influentNh: 30,
        influentFlow: 500,
        effluentCod: 30,
        effluentBod: 8,
        effluentNh: 1,
        effluentTn: 12,
        effluentTp: 0.4,
        effluentSs: 8,
        do: 2,
        mlss: 3000,
        srtDays: 10,
        energyKw: 100,
        blanket: 0.5,
      },
    ];
    const out = trendPointsToReadings(tp);
    expect(out[0].minute).toBe(0);
    expect(out[0].flowM3h).toBe(500);
    expect(out[0].values.cod).toBe(30);
    expect(out[0].values.tp).toBe(0.4);
  });

  it('CSV 可由报表直接生成，作废样品标 unevaluated', () => {
    const ok = buildCompositeSample([reading(0, 500, { cod: 30 })], 0, cfg(), 'ok');
    const bad = evaluateSample(
      buildCompositeSample([reading(DAY, 500, { cod: 90 })], DAY, cfg(), 'bad'),
      cfg({ calibrationValid: false }),
    );
    const report = reportOf([ok, bad]);
    const rows = parseCsv(buildComplianceCsv(report), { columns: true }) as Record<string, string>[];
    const badRows = rows.filter((r) => r.sample_id === 'bad');
    expect(badRows.every((r) => r.verdict === 'unevaluated')).toBe(true);
    const okRows = rows.filter((r) => r.sample_id === 'ok');
    expect(okRows.some((r) => r.verdict === 'pass')).toBe(true);
  });
});

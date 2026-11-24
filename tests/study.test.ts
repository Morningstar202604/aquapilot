import { describe, expect, it } from 'vitest';
import {
  STUDY_LIMITS,
  aggregateStudy,
  planStudy,
  studyMarkdown,
  type StudyChildRow,
  type StudySpec,
} from '../src/sim/study';
import type { ExperimentSpec, ExperimentSummary, ExperimentValidation } from '../src/sim/experiment';

const base: ExperimentSpec = {
  name: 'base',
  model: 'asm1',
  seed: 100,
  warmupDays: 2,
  durationMin: 1440,
  sampleEveryMin: 30,
  scenario: null,
  controls: { doSetpoint: 2 },
  plantEnabled: false,
  bioPRemoval: true,
  standardId: 'gb18918-1a',
  policy: 'fixed',
  decisionIntervalMin: 240,
  validation: 'basic',
};

function summary(totalCost: number, cod: number, nh: number): ExperimentSummary {
  return {
    name: 'child',
    model: 'asm1',
    seed: 1,
    warmupDays: 2,
    durationMin: 1440,
    sampleEveryMin: 30,
    sampleCount: 49,
    policy: 'fixed',
    decisions: 0,
    standardId: 'gb18918-1a',
    standardLabel: 'GB 18918—2002 一级 A',
    compliant: true,
    effluent: {
      cod: { min: 1, mean: cod, p50: cod, p95: cod, max: cod },
      bod: { min: 1, mean: 10, p50: 10, p95: 10, max: 10 },
      ss: { min: 1, mean: 5, p50: 5, p95: 5, max: 5 },
      nh: { min: 1, mean: nh, p50: nh, p95: nh, max: nh },
      tn: { min: 1, mean: 10, p50: 10, p95: 10, max: 10 },
      tp: { min: 1, mean: 0.5, p50: 0.5, p95: 0.5, max: 0.5 },
    },
    compliance: [],
    energyKwh: 100,
    chemicalCost: 0,
    totalCost,
    inflowM3: 1000,
    specificEnergyKwhM3: 0.1,
    meanMlss: 2500,
    finalMlss: 2600,
    finalSrtDays: 20,
    finalDo: 2,
    finalBlanketM: 1,
    alarms: { count: 0, codes: [] },
    scenario: null,
  };
}

const validation: ExperimentValidation = {
  level: 'basic',
  scope: 'waterline',
  certified: true,
  operatingCompliant: true,
  checks: [{ id: 'numeric.finite', label: 'finite', status: 'pass', detail: 'ok' }],
};

const spec: StudySpec = {
  name: 'energy study',
  base,
  variants: [
    { name: 'low DO', controls: { doSetpoint: 1.5 } },
    { name: 'high DO', controls: { doSetpoint: 3 } },
    { name: 'storm', scenario: { type: 'storm', magnitude: 1 } },
  ],
  replicates: 2,
  objectives: [
    { metric: 'totalCost', direction: 'min' },
    { metric: 'effluent.nh', direction: 'min' },
  ],
};

describe('Study planning', () => {
  it('展开成 6 个子实验，名称/种子确定且互不重复', () => {
    const plan = planStudy(spec);
    expect(plan.children).toHaveLength(6);
    expect(new Set(plan.children.map((c) => c.spec.seed)).size).toBe(6);
    const again = planStudy(spec);
    expect(again.children.map((c) => c.spec.seed)).toEqual(plan.children.map((c) => c.spec.seed));
    expect(plan.children[0]!.spec.controls?.doSetpoint).toBe(1.5);
    expect(plan.children[2]!.spec.controls?.doSetpoint).toBe(3);
    expect(plan.children[4]!.spec.scenario?.type).toBe('storm');
    expect(plan.children[1]!.replicate).toBe(1);
  });

  it('拒绝超过队列容量的展开', () => {
    const tooMany: StudySpec = { ...spec, variants: Array.from({ length: 13 }, (_, i) => ({ name: `v${i}` })) };
    expect(planStudy(tooMany).children.length).toBeGreaterThan(STUDY_LIMITS.maxChildren);
  });
});

describe('Study aggregation', () => {
  it('按目标排序并给出 Pareto 前沿，认证/合规率按成功子实验计算', () => {
    const rows: (StudyChildRow | null)[] = [
      { id: 'a', name: 'a', status: 'succeeded', summary: summary(90, 40, 1), validation, error: null },
      { id: 'b', name: 'b', status: 'succeeded', summary: summary(85, 50, 4), validation, error: null },
      { id: 'c', name: 'c', status: 'succeeded', summary: summary(95, 35, 2), validation, error: null },
      { id: 'd', name: 'd', status: 'succeeded', summary: summary(120, 30, 1.5), validation, error: null },
      { id: 'e', name: 'e', status: 'succeeded', summary: summary(80, 55, 5), validation, error: null },
      { id: 'f', name: 'f', status: 'failed', summary: null, validation: null, error: 'boom' },
    ];
    const result = aggregateStudy(spec, rows);
    expect(result.total).toBe(6);
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.best?.name).toBe('storm');
    expect(result.ranking[0].score).toBe(80);
    // 三个变体在“成本—NH”上各有取舍，均应留在 Pareto 前沿
    expect(result.pareto.map((p) => p.name)).toEqual(expect.arrayContaining(['storm', 'low DO', 'high DO']));
    expect(result.variants[0].complianceRate).toBe(1);
    expect(result.variants[0].certifiedRate).toBe(1);
    expect(result.variants[2].certifiedRate).toBe(1);
    expect(result.variants[2].succeeded).toBe(1);
    expect(result.variants[2].failed).toBe(1);
  });

  it('全部取消时状态是 cancelled，全部成功时是 succeeded', () => {
    const allCancelled = aggregateStudy({ ...spec, variants: [{ name: 'only' }], replicates: 1 }, [
      { id: 'x', name: 'x', status: 'cancelled', summary: null, validation: null, error: null },
    ]);
    expect(allCancelled.status).toBe('cancelled');
    const allSuccess = aggregateStudy(
      { ...spec, variants: [{ name: 'only' }], replicates: 1, objectives: [{ metric: 'totalCost', direction: 'min' }] },
      [{ id: 'x', name: 'x', status: 'succeeded', summary: summary(10, 10, 1), validation, error: null }],
    );
    expect(allSuccess.status).toBe('succeeded');
    expect(allSuccess.pareto).toHaveLength(1);
  });

  it('Markdown 报告写入变体、排名与复现 ID', () => {
    const rows: StudyChildRow[] = planStudy(spec).children.map((child, i) => ({
      id: `exp_${i}`,
      name: child.spec.name ?? 'child',
      status: 'succeeded',
      summary: summary(100 + i, 40, 2),
      validation,
      error: null,
    }));
    const aggregate = aggregateStudy(spec, rows);
    const md = studyMarkdown(
      'energy study',
      spec,
      aggregate,
      rows.map((r) => r.id),
    );
    expect(md).toContain('# AquaPilot 仿真研究：energy study');
    expect(md).toContain('| 1 |');
    expect(md).toContain('Pareto 前沿');
    expect(md).toContain('`exp_0`');
  });
});

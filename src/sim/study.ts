/**
 * 仿真研究（Study）：把“一次实验”提升为“一组可比较的模型问题”。
 *
 * 一个 Study 由 base experiment、若干 variant 和重复次数组成：
 * - variant 覆盖控制量、场景、模型、边界开关；
 * - 每个 variant × replicate 生成一个独立子实验，种子由 base seed 偏移，
 *   保证同 variant 的重复实验共享边界但使用不同随机扰动；
 * - 聚合层只读取子实验的 summary/validation，不重新跑仿真，
 *   因此可以按目标函数排序、做 Pareto 前沿、给出认证率与合规率。
 *
 * 约束：最多 12 个 variant × 2 次重复 = 24 个子实验，与默认实验队列容量一致；
 * 这是单机“研究批次”的边界，不是 HPC 调度器。
 */

import type { ControlSettings } from './config';
import type {
  ExperimentModel,
  ExperimentScenarioSpec,
  ExperimentSpec,
  ExperimentSummary,
  ExperimentValidation,
} from './experiment';

export const STUDY_LIMITS = {
  maxVariants: 12,
  maxReplicates: 2,
  maxObjectives: 3,
  maxChildren: 24,
} as const;

export const STUDY_METRICS = [
  'totalCost',
  'energyKwh',
  'specificEnergyKwhM3',
  'meanMlss',
  'finalSrtDays',
  'finalDo',
  'effluent.cod',
  'effluent.bod',
  'effluent.ss',
  'effluent.nh',
  'effluent.tn',
  'effluent.tp',
] as const;

export type StudyMetric = (typeof STUDY_METRICS)[number];
export type StudyDirection = 'min' | 'max';

export interface StudyObjective {
  metric: StudyMetric;
  direction: StudyDirection;
}

export interface StudyVariant {
  name?: string;
  /** 覆盖 base.controls 的部分字段；未给出的字段沿用 base */
  controls?: Partial<ControlSettings>;
  /** null 表示显式清空场景；undefined 表示沿用 base */
  scenario?: ExperimentScenarioSpec | null;
  seedOffset?: number;
  model?: ExperimentModel;
  plantEnabled?: boolean;
  bioPRemoval?: boolean;
}

export interface StudySpec {
  name?: string;
  base: ExperimentSpec;
  variants: StudyVariant[];
  /** 每个 variant 重复次数；用于估计 batch 内离散度 */
  replicates: number;
  objectives: StudyObjective[];
}

export interface StudyChildSpec {
  variantIndex: number;
  replicate: number;
  variantName: string;
  spec: ExperimentSpec;
}

export interface PlannedStudy {
  studyName: string;
  children: StudyChildSpec[];
}

export type StudyStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface StudyChildRow {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  summary: ExperimentSummary | null;
  validation: ExperimentValidation | null;
  error: string | null;
}

export interface MetricAggregate {
  count: number;
  mean: number;
  min: number;
  max: number;
  p95: number;
}

export interface StudyVariantResult {
  index: number;
  name: string;
  experiments: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  complianceRate: number;
  certifiedRate: number;
  operatingComplianceRate: number;
  metrics: Partial<Record<StudyMetric, MetricAggregate>>;
  objectiveValues: Partial<Record<StudyMetric, number>>;
  rank: number | null;
}

export interface StudyParetoPoint {
  variantIndex: number;
  name: string;
  values: Partial<Record<StudyMetric, number>>;
}

export interface StudyValidationRollup {
  checked: number;
  certified: number;
  operatingCompliant: number;
  failedChecks: { id: string; count: number }[];
}

export interface StudyAggregate {
  status: StudyStatus;
  progressPercent: number;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  variants: StudyVariantResult[];
  ranking: { variantIndex: number; name: string; score: number }[];
  pareto: StudyParetoPoint[];
  best: { variantIndex: number; name: string; score: number } | null;
  validation: StudyValidationRollup;
  objectives: StudyObjective[];
}

function clampSeed(seed: number): number {
  return Math.min(2_147_483_647, Math.max(0, Math.round(seed)));
}

function trimName(value: string, max = 80): string {
  return value.trim().slice(0, max);
}

/** 把 StudySpec 展开成确定性的子实验清单；相同 spec 永远得到相同名称与种子。 */
export function planStudy(spec: StudySpec): PlannedStudy {
  const base = spec.base;
  const studyName = trimName(spec.name || base.name || `study-${base.seed}`);
  const children: StudyChildSpec[] = [];
  for (let variantIndex = 0; variantIndex < spec.variants.length; variantIndex += 1) {
    const variant = spec.variants[variantIndex];
    const variantName = trimName(variant.name || `variant-${variantIndex + 1}`, 40);
    for (let replicate = 0; replicate < spec.replicates; replicate += 1) {
      const seed = clampSeed(base.seed + (variant.seedOffset ?? 0) + variantIndex * 104_729 + replicate * 7_919);
      const controls = { ...(base.controls ?? {}), ...(variant.controls ?? {}) };
      const childSpec: ExperimentSpec = {
        ...base,
        name: trimName(`${studyName} / ${variantName} / r${replicate + 1}`, 80),
        seed,
        controls,
        scenario: variant.scenario === undefined ? base.scenario : variant.scenario,
        model: variant.model ?? base.model,
        plantEnabled: variant.plantEnabled ?? base.plantEnabled,
        bioPRemoval: variant.bioPRemoval ?? base.bioPRemoval,
      };
      children.push({ variantIndex, replicate, variantName, spec: childSpec });
    }
  }
  return { studyName, children };
}

function metricValue(summary: ExperimentSummary, metric: StudyMetric): number | null {
  if (metric === 'totalCost') return summary.totalCost;
  if (metric === 'energyKwh') return summary.energyKwh;
  if (metric === 'specificEnergyKwhM3') return summary.specificEnergyKwhM3;
  if (metric === 'meanMlss') return summary.meanMlss;
  if (metric === 'finalSrtDays') return summary.finalSrtDays;
  if (metric === 'finalDo') return summary.finalDo;
  const key = metric.slice('effluent.'.length) as keyof ExperimentSummary['effluent'];
  return summary.effluent[key]?.mean ?? null;
}

function aggregateMetric(values: number[]): MetricAggregate {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return { count: 0, mean: 0, min: 0, max: 0, p95: 0 };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const p95 = clean[Math.min(clean.length - 1, Math.floor(clean.length * 0.95))];
  return { count: clean.length, mean, min: clean[0], max: clean[clean.length - 1], p95 };
}

function isTerminal(status: StudyChildRow['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function dominates(a: StudyParetoPoint, b: StudyParetoPoint, objectives: StudyObjective[]): boolean {
  let strict = false;
  for (const objective of objectives) {
    const av = a.values[objective.metric];
    const bv = b.values[objective.metric];
    if (av === undefined || bv === undefined) return false;
    const better = objective.direction === 'min' ? av <= bv : av >= bv;
    const worse = objective.direction === 'min' ? av > bv : av < bv;
    if (worse) return false;
    if (better && av !== bv) strict = true;
  }
  return strict;
}

function scoreVariant(result: StudyVariantResult, objective: StudyObjective): number | null {
  return result.objectiveValues[objective.metric] ?? null;
}

/**
 * 聚合子实验。children 与 planStudy(spec).children 按同一顺序一一对应；
 * 缺失的子实验按 failed 处理，不伪造成功。
 */
export function aggregateStudy(spec: StudySpec, rows: (StudyChildRow | null)[]): StudyAggregate {
  const plan = planStudy(spec);
  const byVariant: StudyVariantResult[] = spec.variants.map((variant, index) => ({
    index,
    name: trimName(variant.name || `variant-${index + 1}`, 40),
    experiments: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    complianceRate: 0,
    certifiedRate: 0,
    operatingComplianceRate: 0,
    metrics: {},
    objectiveValues: {},
    rank: null,
  }));

  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let running = 0;
  let queued = 0;
  const failedChecks = new Map<string, number>();
  const valuesByVariant = new Map<number, Map<StudyMetric, number[]>>();
  const checksByVariant = new Map<
    number,
    { checked: number; certified: number; operating: number; compliant: number }
  >();

  for (let i = 0; i < plan.children.length; i += 1) {
    const child = plan.children[i];
    const row = rows[i] ?? null;
    const target = byVariant[child.variantIndex];
    target.experiments += 1;
    if (!row) {
      failed += 1;
      target.failed += 1;
      target.completed += 1;
      completed += 1;
      continue;
    }
    if (row.status === 'queued') queued += 1;
    else if (row.status === 'running') running += 1;
    if (!isTerminal(row.status)) continue;
    completed += 1;
    target.completed += 1;
    if (row.status === 'succeeded') {
      succeeded += 1;
      target.succeeded += 1;
      if (row.summary) {
        let bucket = valuesByVariant.get(child.variantIndex);
        if (!bucket) {
          bucket = new Map();
          valuesByVariant.set(child.variantIndex, bucket);
        }
        for (const metric of STUDY_METRICS) {
          const value = metricValue(row.summary, metric);
          if (value === null || !Number.isFinite(value)) continue;
          const list = bucket.get(metric) ?? [];
          list.push(value);
          bucket.set(metric, list);
        }
      }
    } else if (row.status === 'cancelled') {
      cancelled += 1;
      target.cancelled += 1;
    } else {
      failed += 1;
      target.failed += 1;
    }
    if (row.status === 'succeeded' && row.summary) {
      const stats = checksByVariant.get(child.variantIndex) ?? { checked: 0, certified: 0, operating: 0, compliant: 0 };
      stats.compliant += row.summary.compliant ? 1 : 0;
      if (row.validation) {
        stats.checked += 1;
        if (row.validation.certified) stats.certified += 1;
        if (row.validation.operatingCompliant) stats.operating += 1;
        for (const check of row.validation.checks) {
          if (check.status === 'fail') failedChecks.set(check.id, (failedChecks.get(check.id) ?? 0) + 1);
        }
      }
      checksByVariant.set(child.variantIndex, stats);
    }
  }

  for (const variant of byVariant) {
    const bucket = valuesByVariant.get(variant.index);
    if (bucket) {
      for (const [metric, values] of bucket) {
        variant.metrics[metric] = aggregateMetric(values);
        variant.objectiveValues[metric] = variant.metrics[metric]!.mean;
      }
    }
    const stats = checksByVariant.get(variant.index);
    if (stats) {
      variant.complianceRate = variant.succeeded > 0 ? stats.compliant / variant.succeeded : 0;
      variant.certifiedRate = stats.checked > 0 ? stats.certified / stats.checked : 0;
      variant.operatingComplianceRate = stats.checked > 0 ? stats.operating / stats.checked : 0;
    }
  }

  let certified = 0;
  let operatingCompliant = 0;
  let checked = 0;
  for (const stats of checksByVariant.values()) {
    checked += stats.checked;
    certified += stats.certified;
    operatingCompliant += stats.operating;
  }

  const objectives = spec.objectives;
  const primary = objectives[0];
  const scored = byVariant
    .filter((v) => v.succeeded > 0 && scoreVariant(v, primary) !== null)
    .map((v) => ({ variantIndex: v.index, name: v.name, score: scoreVariant(v, primary)! }));
  scored.sort((a, b) => {
    const delta = primary.direction === 'min' ? a.score - b.score : b.score - a.score;
    if (Math.abs(delta) > 1e-12) return delta;
    return a.variantIndex - b.variantIndex;
  });
  for (let i = 0; i < scored.length; i += 1) {
    const result = byVariant[scored[i].variantIndex];
    result.rank = i + 1;
  }

  const points: StudyParetoPoint[] = byVariant
    .filter((v) => v.succeeded > 0)
    .map((v) => ({ variantIndex: v.index, name: v.name, values: { ...v.objectiveValues } }));
  const pareto: StudyParetoPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    let dominated = false;
    for (let j = 0; j < points.length; j += 1) {
      if (i !== j && dominates(points[j], points[i], objectives)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) pareto.push(points[i]);
  }
  pareto.sort((a, b) => {
    const av = a.values[primary.metric] ?? Number.POSITIVE_INFINITY;
    const bv = b.values[primary.metric] ?? Number.POSITIVE_INFINITY;
    return primary.direction === 'min' ? av - bv : bv - av;
  });

  const status: StudyStatus =
    running > 0
      ? 'running'
      : queued > 0
        ? 'queued'
        : succeeded === plan.children.length
          ? 'succeeded'
          : cancelled === plan.children.length
            ? 'cancelled'
            : succeeded > 0
              ? 'partial'
              : 'failed';

  return {
    status,
    progressPercent: plan.children.length === 0 ? 0 : Math.round((completed / plan.children.length) * 100),
    total: plan.children.length,
    completed,
    succeeded,
    failed,
    cancelled,
    variants: byVariant,
    ranking: scored,
    pareto,
    best: scored[0] ?? null,
    validation: {
      checked,
      certified,
      operatingCompliant,
      failedChecks: [...failedChecks.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    },
    objectives,
  };
}

function fmt(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function studyMarkdown(name: string, spec: StudySpec, aggregate: StudyAggregate, childIds: string[]): string {
  const objectiveLabel = (o: StudyObjective) => `${o.metric}${o.direction === 'min' ? '↓' : '↑'}`;
  const rows = aggregate.variants
    .map((v) => {
      const objective = aggregate.objectives.map((o) => fmt(v.objectiveValues[o.metric], 4)).join(' | ');
      return `| ${v.index + 1} | ${v.name} | ${v.succeeded}/${v.experiments} | ${(v.complianceRate * 100).toFixed(0)}% | ${(v.certifiedRate * 100).toFixed(0)}% | ${fmt(v.metrics.totalCost?.mean, 0)} | ${fmt(v.metrics['effluent.cod']?.mean)} | ${fmt(v.metrics['effluent.nh']?.mean)} | ${fmt(v.metrics['effluent.tn']?.mean)} | ${fmt(v.metrics['effluent.tp']?.mean)} | ${objective} | ${v.rank ?? '—'} |`;
    })
    .join('\n');
  const paretoLines = aggregate.pareto
    .map(
      (p) =>
        `- **${p.name}**：${aggregate.objectives.map((o) => `${o.metric} ${fmt(p.values[o.metric], 4)}`).join('；')}`,
    )
    .join('\n');
  const failed = aggregate.validation.failedChecks.map((c) => `- \`${c.id}\`：${c.count} 个子实验失败`).join('\n');
  return `# AquaPilot 仿真研究：${name}

> 一次研究 = 一组共享 base 边界、但控制/场景/模型不同的子实验。结果由 spec、拓扑快照和种子唯一确定；相同输入可复现。

## 运行概览

- 子实验：${aggregate.total} 个；完成 ${aggregate.completed}，成功 ${aggregate.succeeded}，失败 ${aggregate.failed}，取消 ${aggregate.cancelled}
- 状态：\`${aggregate.status}\`（进度 ${aggregate.progressPercent}%）
- 目标：${aggregate.objectives.map(objectiveLabel).join('；')}
- 模型/数值认证：${aggregate.validation.certified}/${aggregate.validation.checked}
- 运行合规：${aggregate.validation.operatingCompliant}/${aggregate.validation.checked}

## 变体排名

| # | 变体 | 成功/总数 | 合规率 | 认证率 | 总成本 | COD | NH₃-N | TN | TP | 目标值 | 排名 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
${rows}

## Pareto 前沿

${paretoLines || '（没有足够成功的子实验计算 Pareto 前沿）'}

## 校验失败

${failed || '无失败检查；所有已完成子实验的 mandatory checks 均通过。'}

## 复现

子实验 ID：

${childIds.map((id) => `- \`${id}\``).join('\n')}

用以下 spec 重新创建同一研究：

\`\`\`bash
curl -X POST /api/v1/studies \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(spec).replace(/'/g, "'\\''")}'
\`\`\`
`;
}

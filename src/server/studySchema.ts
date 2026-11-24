/**
 * Study 请求的结构与跨字段校验。
 *
 * base 复用 ExperimentSpec 的同一套校验（不能用第二套“差不多”的规则）；
 * variant 只允许覆盖控制/场景/模型/边界开关，seed 由 planStudy 派生。
 */

import * as v from 'valibot';
import { SCENARIO_ORDER } from '../sim/scenarios';
import { STUDY_LIMITS, STUDY_METRICS, type StudySpec } from '../sim/study';
import { ExperimentSpecError, parseExperimentSpec, type SchemaIssue } from './experimentSchema';

const FiniteNumber = v.pipe(v.number(), v.finite());
const Integer = v.pipe(v.number(), v.integer());

const Scenario = v.strictObject({
  type: v.picklist(SCENARIO_ORDER),
  durationMin: v.optional(v.pipe(Integer, v.minValue(5), v.maxValue(4_320))),
  magnitude: v.optional(v.pipe(FiniteNumber, v.minValue(0), v.maxValue(3))),
});

const Variant = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  controls: v.optional(v.record(v.string(), FiniteNumber)),
  scenario: v.optional(v.nullable(Scenario)),
  seedOffset: v.optional(v.pipe(Integer, v.minValue(0), v.maxValue(100_000))),
  model: v.optional(v.picklist(['simple', 'asm1', 'asm2d'])),
  plantEnabled: v.optional(v.boolean()),
  bioPRemoval: v.optional(v.boolean()),
});

const Objective = v.strictObject({
  metric: v.picklist(STUDY_METRICS),
  direction: v.picklist(['min', 'max']),
});

const Shape = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
  base: v.unknown(),
  variants: v.pipe(v.array(Variant), v.minLength(1), v.maxLength(STUDY_LIMITS.maxVariants)),
  replicates: v.optional(v.pipe(Integer, v.minValue(1), v.maxValue(STUDY_LIMITS.maxReplicates)), 1),
  objectives: v.optional(v.pipe(v.array(Objective), v.minLength(1), v.maxLength(STUDY_LIMITS.maxObjectives)), [
    { metric: 'totalCost', direction: 'min' },
  ]),
});

export class StudySpecError extends Error {
  constructor(
    message: string,
    readonly issues: SchemaIssue[] = [],
  ) {
    super(message);
  }
}

function issuePath(issue: v.BaseIssue<unknown>): string {
  return issue.path?.map((p) => String(p.key)).join('.') || 'body';
}

export function parseStudySpec(input: unknown): StudySpec {
  const parsed = v.safeParse(Shape, input);
  if (!parsed.success) {
    throw new StudySpecError(
      '请求参数不符合 study schema',
      parsed.issues.map((issue) => ({ path: issuePath(issue), message: issue.message })),
    );
  }
  const out = parsed.output;
  const issues: SchemaIssue[] = [];

  let base;
  try {
    base = parseExperimentSpec(out.base);
  } catch (err) {
    if (err instanceof ExperimentSpecError) {
      throw new StudySpecError(
        'study.base 不是合法实验',
        err.issues.map((i) => ({ ...i, path: `base.${i.path}` })),
      );
    }
    throw err;
  }

  if (out.variants.length * out.replicates > STUDY_LIMITS.maxChildren) {
    issues.push({
      path: 'replicates',
      message: `${out.variants.length} 个变体 × ${out.replicates} 次重复 = ${out.variants.length * out.replicates}，超过子实验上限 ${STUDY_LIMITS.maxChildren}`,
    });
  }

  const seenObjectives = new Set<string>();
  for (const objective of out.objectives) {
    const key = `${objective.metric}:${objective.direction}`;
    if (seenObjectives.has(key)) {
      issues.push({ path: 'objectives', message: `目标 ${key} 重复` });
    }
    seenObjectives.add(key);
  }

  for (let i = 0; i < out.variants.length; i += 1) {
    const variant = out.variants[i];
    const controls = { ...(base.controls ?? {}), ...(variant.controls ?? {}) };
    try {
      parseExperimentSpec({
        ...base,
        name: `variant-${i + 1}`,
        controls,
        scenario: variant.scenario === undefined ? base.scenario : variant.scenario,
        model: variant.model ?? base.model,
        plantEnabled: variant.plantEnabled ?? base.plantEnabled,
        bioPRemoval: variant.bioPRemoval ?? base.bioPRemoval,
      });
    } catch (err) {
      if (err instanceof ExperimentSpecError) {
        for (const issue of err.issues) issues.push({ ...issue, path: `variants.${i}.${issue.path}` });
        continue;
      }
      throw err;
    }
  }

  if (issues.length > 0) throw new StudySpecError('study 参数超出边界', issues);

  return {
    ...(out.name ? { name: out.name } : {}),
    base,
    variants: out.variants.map((variant) => ({
      ...variant,
      ...(variant.controls ? { controls: variant.controls } : {}),
    })) as StudySpec['variants'],
    replicates: out.replicates,
    objectives: out.objectives,
  };
}

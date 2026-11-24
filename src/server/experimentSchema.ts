/**
 * 实验请求的 schema 与跨字段校验。
 *
 * valibot 只负责“结构与类型可信”；业务边界（控制量上下限、场景倍率、
 * 采样点数上限）放在同一个函数里显式校验并抛出可读错误。路由层再把
 * 错误映射成 RFC 9457 problem+json。
 */

import * as v from 'valibot';
import { CONTROL_BOUNDS, CONTROL_KEYS } from '../sim/config';
import { SCENARIOS, SCENARIO_ORDER } from '../sim/scenarios';
import { EXPERIMENT_LIMITS, type ExperimentSpec } from '../sim/experiment';

const FiniteNumber = v.pipe(v.number(), v.finite());
const Integer = v.pipe(v.number(), v.integer());
const BoundedText = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));

const controlEntries: Record<string, typeof FiniteNumber> = Object.fromEntries(
  CONTROL_KEYS.map((key) => [key, FiniteNumber]),
);
const Controls = v.partial(v.strictObject(controlEntries));

const Scenario = v.strictObject({
  type: v.picklist(SCENARIO_ORDER),
  durationMin: v.optional(v.pipe(Integer, v.minValue(5), v.maxValue(4_320))),
  magnitude: v.optional(v.pipe(FiniteNumber, v.minValue(0), v.maxValue(3))),
});

export const ExperimentSpecSchema = v.strictObject({
  name: v.optional(BoundedText(80), ''),
  model: v.optional(v.picklist(['simple', 'asm1', 'asm2d']), 'asm1'),
  seed: v.optional(v.pipe(Integer, v.minValue(0), v.maxValue(2_147_483_647)), 20_261_019),
  warmupDays: v.optional(v.pipe(Integer, v.minValue(0), v.maxValue(EXPERIMENT_LIMITS.maxWarmupDays)), 5),
  durationMin: v.pipe(Integer, v.minValue(60), v.maxValue(EXPERIMENT_LIMITS.maxDurationMin)),
  sampleEveryMin: v.optional(
    v.pipe(Integer, v.minValue(EXPERIMENT_LIMITS.minSampleEveryMin), v.maxValue(EXPERIMENT_LIMITS.maxSampleEveryMin)),
    30,
  ),
  scenario: v.optional(v.nullable(Scenario), null),
  controls: v.optional(Controls, {}),
  plantEnabled: v.optional(v.boolean(), false),
  bioPRemoval: v.optional(v.boolean(), true),
  standardId: v.optional(v.picklist(['gb18918-1a', 'gb18918-1b', 'bsm1-reference']), 'gb18918-1a'),
  policy: v.optional(v.picklist(['fixed', 'ai']), 'fixed'),
  decisionIntervalMin: v.optional(v.pipe(Integer, v.minValue(15), v.maxValue(1_440)), 240),
  validation: v.optional(v.picklist(['basic', 'full']), 'basic'),
});

export interface SchemaIssue {
  path: string;
  message: string;
}

export class ExperimentSpecError extends Error {
  constructor(
    message: string,
    readonly issues: SchemaIssue[] = [],
  ) {
    super(message);
    this.name = 'ExperimentSpecError';
  }
}

function issuePath(issue: v.BaseIssue<unknown>): string {
  return issue.path?.map((p) => String(p.key)).join('.') || 'body';
}

export function parseExperimentSpec(input: unknown): ExperimentSpec {
  const parsed = v.safeParse(ExperimentSpecSchema, input);
  if (!parsed.success) {
    throw new ExperimentSpecError(
      '请求参数不符合实验 schema',
      parsed.issues.map((issue) => ({ path: issuePath(issue), message: issue.message })),
    );
  }
  const out = parsed.output;
  const issues: SchemaIssue[] = [];

  if (out.scenario) {
    const meta = SCENARIOS[out.scenario.type];
    if (out.scenario.magnitude !== undefined) {
      if (out.scenario.magnitude < meta.magnitudeRange.min || out.scenario.magnitude > meta.magnitudeRange.max) {
        issues.push({
          path: 'scenario.magnitude',
          message: `${meta.label} 的 magnitude 必须在 ${meta.magnitudeRange.min}–${meta.magnitudeRange.max}`,
        });
      }
    }
  }

  for (const key of CONTROL_KEYS) {
    const value = out.controls[key];
    if (value === undefined) continue;
    const bound = CONTROL_BOUNDS[key];
    if (value < bound.min || value > bound.max) {
      issues.push({
        path: `controls.${key}`,
        message: `${bound.label} 必须在 ${bound.min}–${bound.max} ${bound.unit}`.trim(),
      });
    }
  }

  const expectedSamples = Math.floor(out.durationMin / out.sampleEveryMin) + 1;
  if (expectedSamples > EXPERIMENT_LIMITS.maxSamples) {
    issues.push({
      path: 'sampleEveryMin',
      message: `采样点 ${expectedSamples} 超过上限 ${EXPERIMENT_LIMITS.maxSamples}；请增大 sampleEveryMin 或缩短 durationMin`,
    });
  }

  if (out.policy === 'ai') {
    const decisions = Math.floor(out.durationMin / out.decisionIntervalMin) + 1;
    if (decisions > EXPERIMENT_LIMITS.maxAiDecisions) {
      issues.push({
        path: 'decisionIntervalMin',
        message: `AI 策略将产生 ${decisions} 次决策，超过上限 ${EXPERIMENT_LIMITS.maxAiDecisions}；请增大 decisionIntervalMin 或缩短 durationMin`,
      });
    }
  }

  if (issues.length > 0) throw new ExperimentSpecError('请求参数超出实验边界', issues);

  return {
    ...out,
    controls: out.controls as ExperimentSpec['controls'],
    scenario: out.scenario ?? null,
  };
}

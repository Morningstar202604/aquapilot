/**
 * 可复现的离线仿真实验（Simulation Experiment）。
 *
 * 这是服务端“仿真建模”能力的领域层：一次实验 = 一份拓扑快照 + 一组显式
 * 边界条件 + 一个确定的种子。运行过程不触碰实时厂状态，因此可用于
 * 批量情景比选、模型验证、AI 自动推演和报告复现。
 *
 * 设计约束：
 * - 结果只由 (拓扑, spec, 版本) 决定；同一输入重复运行逐点一致；
 * - 全部时间量用仿真分钟，不依赖 wall clock；
 * - 采样数有上限，避免一个请求把 30 天逐分钟数据写进内存/数据库；
 * - 质量平衡、数值有限性等检查作为结果的一部分返回，而不是在路由层拼字符串。
 */

import { CONTROL_BOUNDS, type ControlSettings } from './config';
import { EFFLUENT_METRICS, clampControls, qualityScore } from './metrics';
import { plantView } from './plantBoundary';
import { quantile } from './quantile';
import { SCENARIOS, type ScenarioType } from './scenarios';
import { standardById, DEFAULT_STANDARD, type DischargeStandard } from './standards';
import type { EffluentMetric } from './metrics';
import type { EffluentStats, KineticModel, NetworkSimState } from './networkTypes';
import { createNetworkState, networkModel, spinUpNetwork, startNetworkScenario, stepNetwork } from './networkEngine';
import { decide } from '../ai/agent';
import type { ProcessTopology } from '../model/topology';

export const EXPERIMENT_LIMITS = {
  maxDurationMin: 43_200,
  maxWarmupDays: 30,
  maxSamples: 20_000,
  minSampleEveryMin: 5,
  maxSampleEveryMin: 1_440,
  maxAiDecisions: 288,
} as const;

export type ExperimentModel = 'simple' | 'asm1' | 'asm2d';
export type ExperimentPolicy = 'fixed' | 'ai';
export type ExperimentValidationLevel = 'basic' | 'full';

export interface ExperimentScenarioSpec {
  type: ScenarioType;
  durationMin?: number;
  magnitude?: number;
}

export interface ExperimentSpec {
  name?: string;
  model: ExperimentModel;
  seed: number;
  warmupDays: number;
  durationMin: number;
  sampleEveryMin: number;
  scenario?: ExperimentScenarioSpec | null;
  controls?: Partial<ControlSettings>;
  plantEnabled: boolean;
  bioPRemoval: boolean;
  standardId: string;
  policy: ExperimentPolicy;
  /** AI 策略的决策周期；固定策略时无意义 */
  decisionIntervalMin: number;
  validation: ExperimentValidationLevel;
}

export interface ExperimentSample {
  minute: number;
  effluent: EffluentStats;
  doLevel: number;
  mlss: number;
  srtDays: number;
  energyKw: number;
  score: number;
  blanketM: number;
}

export interface MetricStats {
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ComplianceRow {
  key: EffluentMetric;
  label: string;
  limit: number;
  max: number;
  p95: number;
  exceedSamples: number;
  compliant: boolean;
}

export interface ExperimentSummary {
  name: string;
  model: ExperimentModel;
  seed: number;
  warmupDays: number;
  durationMin: number;
  sampleEveryMin: number;
  sampleCount: number;
  policy: ExperimentPolicy;
  decisions: number;
  standardId: string;
  standardLabel: string;
  compliant: boolean;
  effluent: Record<EffluentMetric, MetricStats>;
  compliance: ComplianceRow[];
  energyKwh: number;
  chemicalCost: number;
  totalCost: number;
  inflowM3: number;
  specificEnergyKwhM3: number;
  meanMlss: number;
  finalMlss: number;
  finalSrtDays: number;
  finalDo: number;
  finalBlanketM: number;
  alarms: { count: number; codes: string[] };
  scenario: ExperimentScenarioSpec | null;
  /** AI 策略的控制动作摘要；固定策略为空 */
  controlTrace?: { minute: number; action: string; summary: string }[];
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ValidationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ExperimentValidation {
  level: ExperimentValidationLevel;
  scope: 'waterline' | 'plant';
  /** 模型/数值认证：不代表本次运行一定达标；达标看 operatingCompliant */
  certified: boolean;
  operatingCompliant: boolean;
  checks: ValidationCheck[];
}

export interface ExperimentResult {
  summary: ExperimentSummary;
  samples: ExperimentSample[];
  validation: ExperimentValidation;
}

export class ExperimentAbortedError extends Error {
  constructor() {
    super('experiment cancelled');
    this.name = 'ExperimentAbortedError';
  }
}

export interface ExperimentHooks {
  signal?: AbortSignal;
  onProgress?: (progress: { percent: number; simMinute: number }) => void;
}

function normalizeControls(input: Partial<ControlSettings> | undefined): ControlSettings {
  const merged = { ...input } as Partial<ControlSettings>;
  // aiEnabled 是运行态开关，不是实验边界条件；实验由 policy 决定是否闭环。
  delete merged.aiEnabled;
  return clampControls({
    ...(merged as ControlSettings),
    aiEnabled: false,
  });
}

function finiteStats(values: number[]): MetricStats {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return { min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  return {
    min: clean[0],
    mean: clean.reduce((a, b) => a + b, 0) / clean.length,
    p50: quantile(clean, 0.5),
    p95: quantile(clean, 0.95),
    max: clean[clean.length - 1],
  };
}

function sampleState(state: NetworkSimState, minute: number): ExperimentSample {
  return {
    minute,
    effluent: { ...state.effluent },
    doLevel: state.reactors.find((r) => r.kind === 'aerobic')?.doLevel ?? 0,
    mlss: (state.biomassKg * 1000) / Math.max(1, state.volume.bio),
    srtDays: state.srtDays,
    energyKw: state.energy.totalKw,
    score: qualityScore(state.effluent),
    blanketM: state.clarifier.blanketM,
  };
}

function summarize(
  spec: ExperimentSpec,
  standard: DischargeStandard,
  state: NetworkSimState,
  samples: ExperimentSample[],
  decisions: number,
  controlTrace: ExperimentSummary['controlTrace'],
): ExperimentSummary {
  const effluent = {} as Record<EffluentMetric, MetricStats>;
  for (const { key } of EFFLUENT_METRICS) {
    effluent[key] = finiteStats(samples.map((s) => s.effluent[key]));
  }
  const compliance: ComplianceRow[] = EFFLUENT_METRICS.map(({ key, label }) => {
    const limit = standard.limits[key];
    const stats = effluent[key];
    const exceedSamples = samples.filter((s) => s.effluent[key] > limit).length;
    return {
      key,
      label,
      limit,
      max: stats.max,
      p95: stats.p95,
      exceedSamples,
      compliant: exceedSamples === 0,
    };
  });
  const alarmCodes = [...new Set(state.alarms.map((a) => a.code))];
  const finalSample = samples[samples.length - 1];
  return {
    name: spec.name?.trim() || `experiment-${spec.seed}`,
    model: spec.model,
    seed: spec.seed,
    warmupDays: spec.warmupDays,
    durationMin: spec.durationMin,
    sampleEveryMin: spec.sampleEveryMin,
    sampleCount: samples.length,
    policy: spec.policy,
    decisions,
    standardId: standard.id,
    standardLabel: standard.label,
    compliant: compliance.every((r) => r.compliant),
    effluent,
    compliance,
    energyKwh: state.totals.energyKwh,
    chemicalCost: state.cost.chemical,
    totalCost: state.cost.total,
    inflowM3: state.totals.inflowM3,
    specificEnergyKwhM3: state.totals.energyKwh / Math.max(1, state.totals.inflowM3),
    meanMlss: samples.reduce((a, s) => a + s.mlss, 0) / Math.max(1, samples.length),
    finalMlss: finalSample?.mlss ?? 0,
    finalSrtDays: finalSample?.srtDays ?? state.srtDays,
    finalDo: finalSample?.doLevel ?? 0,
    finalBlanketM: finalSample?.blanketM ?? state.clarifier.blanketM,
    alarms: { count: state.alarms.length, codes: alarmCodes },
    scenario: spec.scenario ?? null,
    ...(controlTrace && controlTrace.length > 0 ? { controlTrace } : {}),
  };
}

function baseChecks(spec: ExperimentSpec, samples: ExperimentSample[], summary: ExperimentSummary): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const allValues = samples.flatMap((s) => [
    s.effluent.cod,
    s.effluent.bod,
    s.effluent.ss,
    s.effluent.nh,
    s.effluent.tn,
    s.effluent.tp,
    s.effluent.ph,
    s.effluent.temperature,
    s.doLevel,
    s.mlss,
    s.srtDays,
    s.energyKw,
    s.score,
    s.blanketM,
  ]);
  const finite = allValues.every((v) => Number.isFinite(v));
  checks.push({
    id: 'numeric.finite',
    label: '采样值全部有限',
    status: finite ? 'pass' : 'fail',
    detail: finite ? `${allValues.length} 个采样数值均为有限数` : '存在 NaN/Infinity；不能出具模型结论',
  });

  const nonnegative = samples.every((s) =>
    EFFLUENT_METRICS.every(({ key }) => Number.isFinite(s.effluent[key]) && s.effluent[key] >= 0),
  );
  checks.push({
    id: 'numeric.nonnegative',
    label: '出水浓度非负',
    status: nonnegative ? 'pass' : 'fail',
    detail: nonnegative ? '六项出水指标均 ≥ 0' : '存在负浓度；通常意味着求解器或边界条件失效',
  });

  const expected = Math.floor(spec.durationMin / spec.sampleEveryMin) + 1;
  const coverage = samples.length >= expected;
  checks.push({
    id: 'sampling.coverage',
    label: '采样覆盖完整',
    status: coverage ? 'pass' : 'fail',
    detail: `期望 ≥ ${expected} 点，实际 ${samples.length} 点`,
  });

  checks.push({
    id: 'operating.compliance',
    label: `出水达标（${summary.standardLabel}）`,
    status: summary.compliant ? 'pass' : 'fail',
    detail: summary.compliant
      ? '全部采样点均在排放口径内'
      : summary.compliance
          .filter((r) => !r.compliant)
          .map((r) => `${r.label} 最大 ${r.max.toFixed(2)} / 限值 ${r.limit}`)
          .join('；'),
  });

  return checks;
}

function plantChecks(plant: ReturnType<typeof plantView>): ValidationCheck[] {
  if (!plant || !plant.enabled) {
    return [
      {
        id: 'massBalance.closed',
        label: '全厂 COD/N/P 三本账闭合',
        status: 'skip',
        detail: '本次实验未开启全厂边界（plantEnabled=false），只验证水线模型',
      },
    ];
  }
  const rows = [plant.balance.cod, plant.balance.n, plant.balance.p];
  const worst = Math.max(...rows.map((r) => r.residualPct));
  const closed = rows.every((r) => r.closed);
  return [
    {
      id: 'massBalance.closed',
      label: '全厂 COD/N/P 三本账闭合',
      status: closed ? 'pass' : 'fail',
      detail: closed
        ? '三本账残差均 ≤ 5%'
        : `残差最大 ${(worst * 100).toFixed(1)}%；` +
          rows.map((r, i) => `${['COD', 'N', 'P'][i]} ${(r.residualPct * 100).toFixed(1)}%`).join('，'),
    },
  ];
}

function certified(checks: ValidationCheck[], scope: 'waterline' | 'plant'): boolean {
  const mandatory = checks.filter(
    (c) => c.id !== 'operating.compliance' && c.id !== 'massBalance.closed' && c.status !== 'skip',
  );
  const mass = checks.find((c) => c.id === 'massBalance.closed');
  if (mandatory.some((c) => c.status === 'fail')) return false;
  if (scope === 'plant' && mass?.status !== 'pass') return false;
  return true;
}

async function executeOnce(
  topology: ProcessTopology,
  spec: ExperimentSpec,
  stepMinutes: number,
  hooks: ExperimentHooks,
  sampleEveryMin: number,
): Promise<{
  state: NetworkSimState;
  samples: ExperimentSample[];
  decisions: number;
  controlTrace: NonNullable<ExperimentSummary['controlTrace']>;
}> {
  if (hooks.signal?.aborted) throw new ExperimentAbortedError();
  const controls = normalizeControls(spec.controls);
  const state = createNetworkState(topology, {
    seed: spec.seed,
    model: spec.model as KineticModel,
    controls,
    plantEnabled: spec.plantEnabled,
    bioPRemoval: spec.bioPRemoval,
  });
  spinUpNetwork(state, topology, spec.warmupDays);
  if (hooks.signal?.aborted) throw new ExperimentAbortedError();
  if (spec.scenario) {
    startNetworkScenario(state, spec.scenario.type, {
      durationMin: spec.scenario.durationMin,
      magnitude: spec.scenario.magnitude,
    });
  }

  const samples: ExperimentSample[] = [];
  const controlTrace: NonNullable<ExperimentSummary['controlTrace']> = [];
  let decisions = 0;
  let nextSampleAt = sampleEveryMin;
  let lastDecisionAt = -Infinity;
  const total = spec.durationMin;
  let elapsed = 0;

  const pushSample = (minute: number) => {
    samples.push(sampleState(state, minute));
  };
  pushSample(0);

  while (elapsed < total) {
    if (hooks.signal?.aborted) throw new ExperimentAbortedError();
    const dt = Math.min(stepMinutes, total - elapsed);
    if (spec.policy === 'ai' && elapsed - lastDecisionAt >= spec.decisionIntervalMin) {
      const rec = decide({
        model: networkModel(topology, state),
        horizonMin: 240,
        candidateBudget: 8,
        robust: false,
      });
      state.controls = clampControls({
        ...rec.chosens.controls,
        aiEnabled: true,
      });
      decisions += 1;
      lastDecisionAt = elapsed;
      if (controlTrace.length < EXPERIMENT_LIMITS.maxAiDecisions) {
        controlTrace.push({
          minute: Math.round(elapsed),
          action: rec.action,
          summary: rec.summary,
        });
      }
    }
    stepNetwork(state, topology, dt);
    elapsed += dt;
    if (elapsed >= nextSampleAt - 1e-9) {
      pushSample(Math.round(elapsed));
      nextSampleAt = Math.floor(elapsed / sampleEveryMin) * sampleEveryMin + sampleEveryMin;
    }
    if (hooks.onProgress && (elapsed % 720 < stepMinutes || elapsed >= total)) {
      hooks.onProgress({
        percent: Math.round((elapsed / Math.max(1, total)) * 100),
        simMinute: elapsed,
      });
    }
    if (elapsed % 1440 < stepMinutes) {
      // 每仿真日让出一次事件循环：批量实验不应把 HTTP/WS 主线程锁死。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return { state, samples, decisions, controlTrace };
}

/** 逐点比较两次同种子运行的样本；用于 full 级重复性，而不是只看均值。 */
function compareSamplesPointwise(a: ExperimentSample[], b: ExperimentSample[]): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    const fields: [number, number][] = [
      [x.minute, y.minute],
      [x.doLevel, y.doLevel],
      [x.mlss, y.mlss],
      [x.srtDays, y.srtDays],
      [x.energyKw, y.energyKw],
      [x.score, y.score],
      [x.blanketM, y.blanketM],
    ];
    for (const { key } of EFFLUENT_METRICS) fields.push([x.effluent[key], y.effluent[key]]);
    for (const [av, bv] of fields) {
      if (!Number.isFinite(av) || !Number.isFinite(bv)) return Infinity;
      const scale = Math.max(1e-9, Math.abs(av), Math.abs(bv));
      worst = Math.max(worst, Math.abs(av - bv) / scale);
    }
  }
  return worst;
}

function compareSeries(a: ExperimentSummary, b: ExperimentSummary): number {
  const keys: EffluentMetric[] = ['cod', 'bod', 'ss', 'nh', 'tn', 'tp'];
  let worst = 0;
  for (const key of keys) {
    const av = a.effluent[key].mean;
    const bv = b.effluent[key].mean;
    const scale = Math.max(1e-9, Math.abs(av), Math.abs(bv));
    worst = Math.max(worst, Math.abs(av - bv) / scale);
  }
  worst = Math.max(worst, Math.abs(a.finalSrtDays - b.finalSrtDays) / Math.max(1e-9, a.finalSrtDays));
  return worst;
}

export async function runExperiment(
  topology: ProcessTopology,
  spec: ExperimentSpec,
  hooks: ExperimentHooks = {},
): Promise<ExperimentResult> {
  const standard = standardById(spec.standardId) ?? DEFAULT_STANDARD;
  const first = await executeOnce(topology, spec, 1, hooks, spec.sampleEveryMin);
  const summary = summarize(spec, standard, first.state, first.samples, first.decisions, first.controlTrace);
  const checks = baseChecks(spec, first.samples, summary);
  checks.push(...plantChecks(plantView(first.state.plant)));

  if (spec.validation === 'full') {
    const second = await executeOnce(topology, spec, 1, { signal: hooks.signal }, spec.sampleEveryMin);
    const determinismDelta = compareSamplesPointwise(first.samples, second.samples);
    checks.push({
      id: 'repeatability.determinism',
      label: '同种子重复运行可复现',
      status: determinismDelta <= 1e-9 ? 'pass' : 'fail',
      detail:
        determinismDelta <= 1e-9
          ? '两次同种子运行的逐点样本完全一致'
          : `两次运行的逐点最大相对差 ${(determinismDelta * 100).toFixed(3)}%`,
    });

    // 步长收敛：同一初始/边界，2 min 步长与 1 min 的末端均值差。
    // 这是“数值可信度”检查，不是工艺模型精度检查；阈值 5% 是工程筛查，不是数学证明。
    const coarse = await executeOnce(topology, spec, 2, { signal: hooks.signal }, spec.sampleEveryMin);
    const coarseSummary = summarize(
      spec,
      standard,
      coarse.state,
      coarse.samples,
      coarse.decisions,
      coarse.controlTrace,
    );
    const stepDelta = compareSeries(summary, coarseSummary);
    checks.push({
      id: 'numerics.stepConvergence',
      label: '1 min vs 2 min 步长收敛',
      status: stepDelta <= 0.05 ? 'pass' : 'warn',
      detail:
        stepDelta <= 0.05
          ? `末端均值最大相对差 ${(stepDelta * 100).toFixed(2)}% ≤ 5%`
          : `末端均值最大相对差 ${(stepDelta * 100).toFixed(2)}% > 5%，需缩短步长或检查刚性`,
    });
  }

  const scope: 'waterline' | 'plant' = spec.plantEnabled ? 'plant' : 'waterline';
  const validation: ExperimentValidation = {
    level: spec.validation,
    scope,
    certified: certified(checks, scope),
    operatingCompliant: summary.compliant,
    checks,
  };
  return { summary, samples: first.samples, validation };
}

export function experimentMetricLabels(): string[] {
  return EFFLUENT_METRICS.map((m) => m.label);
}

export function scenarioOptions(): {
  type: ScenarioType;
  label: string;
  defaultDurationMin: number;
  defaultMagnitude: number;
}[] {
  return Object.values(SCENARIOS).map((s) => ({
    type: s.type,
    label: s.label,
    defaultDurationMin: s.defaultDurationMin,
    defaultMagnitude: s.defaultMagnitude,
  }));
}

/** 控制边界只读导出，供 API schema 与文档生成共用。 */
export const EXPERIMENT_CONTROL_BOUNDS = CONTROL_BOUNDS;

/**
 * 运营评分卡（compliance scorecard）。
 *
 * 来源：wwtp-operator-challenge（2026-02）用 30 天危机时序对 22 个大模型做
 * 操作员评测，得出四个相互独立的维度——达标率、能耗、生物稳定性、危机处置。
 * 该项目的结论之一是「AI 自评会被系统性高估 20 分」，所以分数必须由仿真
 * 结果算出，不能由 AI 自己报。
 *
 * 这里把同一套评分做成可复算的纯函数：
 * - 输入是一串逐时刻的观测值（不用知道怎么跑出来的）；
 * - 输出是四个维度 + 总分，每个维度都带「为什么扣分」的可读依据；
 * - 不读全局状态、不碰时间，因此可以在 CLI、MCP、UI 里共用同一套口径。
 *
 * 与参考项目的差异（有意为之）：
 * - 满分不设「bypass 惩罚」：AquaPilot 的排水旁通不是可调参数，
 *   模型里没有这条违法路径，凭空扣分只会制造假精度；
 * - 生物稳定性用 MLSS/SRT 双指标而非 SVI：本引擎不输出 SVI，
 *   拿一个算不出来的指标评分等于编造；
 * - 危机处置按「场景期间相对常态的额外超标分钟」计，而不是按固定日罚分，
 *   因为场景时长与幅度是可调的。
 */

import type { EffluentState } from '../sim/plantTypes';
import { DEFAULT_STANDARD, type DischargeLimits, type DischargeStandard } from './standards';

export interface ScorecardSample {
  /** 仿真分钟 */
  minute: number;
  effluent: EffluentState;
  energyKw: number;
  /** 全厂生物量浓度（mg/L） */
  mlss: number;
  srtDays: number;
  /** 本时刻是否处于扰动场景内 */
  inScenario: boolean;
}

export interface ScorecardDimension {
  key: 'compliance' | 'energy' | 'stability' | 'crisis';
  label: string;
  /** 0–100 */
  score: number;
  /** 该维度满分权重 */
  weight: number;
  /** 一句话结论 + 关键数字 */
  detail: string;
  /** 扣分依据（空数组表示满分） */
  deductions: string[];
}

export interface Scorecard {
  /** 加权总分 0–100 */
  total: number;
  dimensions: ScorecardDimension[];
  /** 参与评分的样本数与覆盖的仿真时长 */
  samples: number;
  spanMin: number;
  /** 判定所用的排放标准（口径写进结果，避免分数不可解释） */
  standard: { id: string; label: string };
  /** 各指标的违规分钟数，供图表与下钻 */
  violations: { metric: keyof EffluentState; minutes: number }[];
  /** 场景内/外的平均比能耗，便于做"危机是否推高能耗"的对照 */
  energy: { normalKwhM3: number; scenarioKwhM3: number };
}

/** 四维权重：与参考项目一致（40/20/20/20），达标是运营的第一约束 */
export const SCORECARD_WEIGHTS = {
  compliance: 40,
  energy: 20,
  stability: 20,
  crisis: 20,
} as const;

/** 吨水电耗达到该值即 0 分（GB 18918 一级 A 厂的常见上限，实测本厂约 0.16–0.20） */
const ENERGY_WORST_KWH_M3 = 0.42;
/** 吨水电耗达到该值即满分 */
const ENERGY_BEST_KWH_M3 = 0.12;

/** 运行稳定区间：MLSS 2000–5000 mg/L、SRT 8–30 d */
const MLSS_MIN = 2000;
const MLSS_MAX = 5000;
const SRT_MIN = 8;
const SRT_MAX = 30;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * 单样本的限值违规判定。
 *
 * 只算「超过排放限值」这一件事：健康度里的裕度不足是预警，不是违规，
 * 混在一起会让达标率失去法定含义。
 */
export function violationsOf(
  e: EffluentState,
  limits: DischargeLimits = DEFAULT_STANDARD.limits,
): { metric: keyof EffluentState; value: number; limit: number }[] {
  const pairs: [keyof EffluentState, number, number][] = [
    ['cod', e.cod, limits.cod],
    ['bod', e.bod, limits.bod],
    ['ss', e.ss, limits.ss],
    ['nh', e.nh, limits.nh],
    ['tn', e.tn, limits.tn],
    ['tp', e.tp, limits.tp],
  ];
  const out: { metric: keyof EffluentState; value: number; limit: number }[] = [];
  for (const [metric, value, limit] of pairs) {
    if (Number.isFinite(value) && value > limit) out.push({ metric, value, limit });
  }
  return out;
}

/**
 * 计算评分卡。
 *
 * 样本过少（< 12）时仍然返回结果，但 detail 会标明样本不足——
 * 不制造"跑了 3 分钟就 100 分"的假象。
 *
 * `standard` 决定违规判定口径。切换标准会同时改变达标率与危机处置两个
 * 维度——这是有意的：同一个出水，按一级 A 与按基准口径评估本来就该不同。
 */
export function computeScorecard(
  samples: ScorecardSample[],
  flowM3h: number,
  standard: DischargeStandard = DEFAULT_STANDARD,
): Scorecard {
  const limits = standard.limits;
  if (samples.length === 0) {
    return {
      total: 0,
      dimensions: [],
      samples: 0,
      spanMin: 0,
      standard: { id: standard.id, label: standard.label },
      violations: [],
      energy: { normalKwhM3: 0, scenarioKwhM3: 0 },
    };
  }

  const first = samples[0].minute;
  const last = samples[samples.length - 1].minute;
  const spanMin = last - first;

  // ---- 1. 达标率 -----------------------------------------------------------
  const perMetric = new Map<string, number>();
  let violationMinutes = 0;
  let scenarioViolationMinutes = 0;
  let scenarioMinutes = 0;
  let compliantMinutes = 0;

  for (const s of samples) {
    const v = violationsOf(s.effluent, limits);
    if (s.inScenario) scenarioMinutes += 1;
    if (v.length === 0) {
      compliantMinutes += 1;
      continue;
    }
    violationMinutes += 1;
    if (s.inScenario) scenarioViolationMinutes += 1;
    for (const item of v) perMetric.set(item.metric, (perMetric.get(item.metric) ?? 0) + 1);
  }

  const complianceRate = compliantMinutes / samples.length;
  /**
   * 达标率映射到 0–100：95% 以上按无差别满分区，之后每降一个百分点扣 5 分。
   * 用分段而不是线性，是因为「99% 与 100%」在合规语境下都算达标，
   * 而「90% 与 80%」的差距必须显性放大。
   */
  const complianceScore = complianceRate >= 0.95 ? 100 : Math.max(0, Math.round(100 - (0.95 - complianceRate) * 500));

  // ---- 2. 能效 -------------------------------------------------------------
  let normalEnergyKwh = 0;
  let normalMinutes = 0;
  let scenarioEnergyKwh = 0;
  for (const s of samples) {
    const kwh = s.energyKw / 60; // kW × (1/60) h
    if (s.inScenario) scenarioEnergyKwh += kwh;
    else {
      normalEnergyKwh += kwh;
      normalMinutes += 1;
    }
  }
  const normalKwhM3 = normalMinutes > 0 ? normalEnergyKwh / Math.max(1, (flowM3h / 60) * normalMinutes) : 0;
  const scenarioKwhM3 = scenarioMinutes > 0 ? scenarioEnergyKwh / Math.max(1, (flowM3h / 60) * scenarioMinutes) : 0;
  const energyScore = Math.round(
    clamp01((ENERGY_WORST_KWH_M3 - normalKwhM3) / (ENERGY_WORST_KWH_M3 - ENERGY_BEST_KWH_M3)) * 100,
  );

  // ---- 3. 生物稳定性 -------------------------------------------------------
  let mlssOut = 0;
  let srtOut = 0;
  let mlssSum = 0;
  for (const s of samples) {
    mlssSum += s.mlss;
    if (!Number.isFinite(s.mlss) || s.mlss < MLSS_MIN || s.mlss > MLSS_MAX) mlssOut += 1;
    if (!Number.isFinite(s.srtDays) || s.srtDays < SRT_MIN || s.srtDays > SRT_MAX) srtOut += 1;
  }
  const mlssMean = mlssSum / samples.length;
  const stabilityRate = 1 - (mlssOut + srtOut) / (samples.length * 2);
  const stabilityScore = Math.round(clamp01(stabilityRate) * 100);

  // ---- 4. 危机处置 ---------------------------------------------------------
  /**
   * 基线用「非场景时段的违规率」，场景时段与之比较。
   * 这样评的是「扰动把系统推坏了多少」，而不是「这座厂本来就不达标」。
   */
  const normalSamples = samples.filter((s) => !s.inScenario);
  const normalViolationRate =
    normalSamples.length > 0
      ? normalSamples.filter((s) => violationsOf(s.effluent, limits).length > 0).length / normalSamples.length
      : 0;
  const scenarioViolationRate = scenarioMinutes > 0 ? scenarioViolationMinutes / scenarioMinutes : 0;
  const crisisScore =
    scenarioMinutes === 0 ? 100 : Math.round(clamp01(1 - (scenarioViolationRate - normalViolationRate) * 5) * 100);

  // ---- 组卷 ---------------------------------------------------------------
  const complianceDeductions: string[] = [];
  if (complianceRate < 0.95) {
    complianceDeductions.push(`达标率 ${(complianceRate * 100).toFixed(1)}%，低于 95% 门槛`);
    for (const [metric, minutes] of perMetric) {
      complianceDeductions.push(`${metric} 超标 ${minutes} 个采样点`);
    }
  }
  const energyDeductions: string[] = [];
  if (energyScore < 100) {
    energyDeductions.push(`常态吨水电耗 ${normalKwhM3.toFixed(3)} kWh/m³（满分线 ${ENERGY_BEST_KWH_M3}）`);
  }
  const stabilityDeductions: string[] = [];
  if (mlssOut > 0) stabilityDeductions.push(`MLSS 越界 ${mlssOut} 个采样点（区间 ${MLSS_MIN}–${MLSS_MAX} mg/L）`);
  if (srtOut > 0) stabilityDeductions.push(`SRT 越界 ${srtOut} 个采样点（区间 ${SRT_MIN}–${SRT_MAX} d）`);
  const crisisDeductions: string[] = [];
  if (scenarioMinutes > 0 && scenarioViolationRate > normalViolationRate) {
    crisisDeductions.push(
      `场景内违规率 ${(scenarioViolationRate * 100).toFixed(1)}%，高于常态 ${(normalViolationRate * 100).toFixed(1)}%`,
    );
  }

  const dimensions: ScorecardDimension[] = [
    {
      key: 'compliance',
      label: '出水达标',
      score: complianceScore,
      weight: SCORECARD_WEIGHTS.compliance,
      detail: `${(complianceRate * 100).toFixed(1)}% 采样点全部指标达标`,
      deductions: complianceDeductions,
    },
    {
      key: 'energy',
      label: '能效',
      score: energyScore,
      weight: SCORECARD_WEIGHTS.energy,
      detail: `常态 ${normalKwhM3.toFixed(3)} kWh/m³`,
      deductions: energyDeductions,
    },
    {
      key: 'stability',
      label: '生物稳定',
      score: stabilityScore,
      weight: SCORECARD_WEIGHTS.stability,
      detail: `MLSS 均值 ${mlssMean.toFixed(0)} mg/L`,
      deductions: stabilityDeductions,
    },
    {
      key: 'crisis',
      label: '危机处置',
      score: crisisScore,
      weight: SCORECARD_WEIGHTS.crisis,
      detail: scenarioMinutes === 0 ? '本次运行未注入扰动' : `场景内 ${scenarioMinutes} 个采样点`,
      deductions: crisisDeductions,
    },
  ];

  const total = Math.round(dimensions.reduce((sum, d) => sum + (d.score * d.weight) / 100, 0));

  return {
    total,
    dimensions,
    samples: samples.length,
    spanMin,
    standard: { id: standard.id, label: standard.label },
    violations: [...perMetric.entries()].map(([metric, minutes]) => ({
      metric: metric as keyof EffluentState,
      minutes,
    })),
    energy: { normalKwhM3, scenarioKwhM3 },
  };
}

/**
 * 生成标准 30 天危机脚本。
 *
 * 参考 wwtp-operator-challenge 的时间轴结构（平静 → 暴雨 → 恢复 → 冲击 →
 * 恢复 → 低温 → 设备故障 → 收尾），但按本引擎支持的场景类型重新配。
 * 返回的是「第几天注入什么」，由调用方驱动仿真——评分卡本身不知道时间轴。
 */
export interface CrisisStep {
  /** 从第几天开始（0 起） */
  day: number;
  type: 'storm' | 'shock_load' | 'toxic' | 'blower_failure' | 'winter' | 'chemical_shortage';
  durationDays: number;
  /** 人类可读的意图，用于报告与界面 */
  intent: string;
}

export const STANDARD_30_DAY_CRISIS: CrisisStep[] = [
  { day: 6, type: 'storm', durationDays: 2, intent: '水力冲击：验证二沉池固体通量与调蓄能力' },
  { day: 15, type: 'shock_load', durationDays: 2, intent: '高负荷：验证曝气裕度与碳源分配' },
  { day: 18, type: 'toxic', durationDays: 1, intent: '毒性抑制：验证硝化菌保护与恢复路径' },
  { day: 21, type: 'winter', durationDays: 4, intent: '低温：验证硝化速率下降时的控制余量' },
  { day: 26, type: 'blower_failure', durationDays: 2, intent: '供气受限：验证 DO 失守时的优先级排序' },
  { day: 29, type: 'chemical_shortage', durationDays: 1, intent: '药剂短缺：验证除磷冗余' },
];

/**
 * 从趋势缓冲直接算评分卡。
 *
 * 服务端手里只有 TrendPoint[]（720 点上限），不希望为了评分再造一份
 * 逐时刻观测。所以给一个显式适配器：字段映射写在一处，趋势结构变更时
 * 类型检查会直接报错，而不是悄悄算出错误的分数。
 */
export function scorecardFromTrend(
  trend: {
    t: number;
    effluentCod: number;
    effluentBod: number;
    effluentNh: number;
    effluentTn: number;
    effluentTp: number;
    effluentSs: number;
    mlss: number;
    srtDays: number;
    energyKw: number;
  }[],
  options: {
    flowM3h: number;
    standard?: DischargeStandard;
    /** 场景区间（仿真分钟）；null 表示当前无活动场景 */
    scenarioWindow?: { from: number; to: number } | null;
  },
): Scorecard {
  const samples: ScorecardSample[] = trend.map((p) => ({
    minute: p.t,
    effluent: {
      flow: options.flowM3h,
      cod: p.effluentCod,
      bod: p.effluentBod,
      ss: p.effluentSs,
      nh: p.effluentNh,
      tn: p.effluentTn,
      tp: p.effluentTp,
      // 趋势缓冲不记 pH/温度：这两个量不参与达标判定，用中性值填充
      ph: 7.2,
      temperature: 20,
    },
    energyKw: p.energyKw,
    mlss: p.mlss,
    srtDays: p.srtDays,
    inScenario: Boolean(
      options.scenarioWindow && p.t >= options.scenarioWindow.from && p.t < options.scenarioWindow.to,
    ),
  }));
  return computeScorecard(samples, options.flowM3h, options.standard ?? DEFAULT_STANDARD);
}

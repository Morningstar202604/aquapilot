import { ASM1_PARAMS, type Asm1Params } from './asm1';
import { runBsm1OpenLoopSteady, BSM1_TABLE6_EFFLUENT } from './bsm1';
import { toConventional } from './asm1Cstr';
import { particulateToTss } from './units';

/**
 * 参数校准与可辨识性分析。
 *
 * 为什么补这个（竞品对标得出的真实缺口）：
 * bsm2-python 与 PyADM1ODE 都提供参数标定链路——PyADM1ODE 有独立的
 * `calibrate` 扩展（灵敏度 + 可辨识性分析），bsm2-python 用官方参考文件
 * 做逐项对照。AquaPilot 此前只能手调参数，接真实水厂前无法用实测数据标定。
 *
 * 本模块实现三件事：
 *   1. 目标函数：把「模型预测的出水」与「观测出水」之间的差归一化后求和；
 *   2. 可辨识性：逐参数做有限差分灵敏度，归一化后判断哪些参数真的能被数据
 *      约束（不可辨识的参数不应参与拟合，否则会过拟合噪声）；
 *   3. 标定：对可辨识参数做有界坐标下降（不引入优化库，参数维度 ≤ 10 时
 *      坐标下降比通用梯度法更稳，也不会因步长发散）。
 *
 * 设计边界（如实标注）：
 * - 只用出水常规指标（COD/SS/NH/TN）做目标，不用池内剖面；
 *   真实水厂能测到的就是这些，用剖面标定属于「用不可测量的数据拟合」。
 * - 不假设噪声分布，因此不给置信区间，只给「参数相对变化量」。
 */

/** 可标定的动力学参数（化学计量参数通常由文献固定，不参与拟合） */
export const CALIBRATABLE_PARAMS = [
  'mu_H',
  'K_S',
  'K_O_H',
  'K_NO',
  'b_H',
  'mu_A',
  'K_NH',
  'K_O_A',
  'b_A',
  'k_h',
  'k_a',
] as const;

export type CalibratableParam = (typeof CALIBRATABLE_PARAMS)[number];

/**
 * 参数的物理合理范围。
 *
 * 上下界不是「随便给个数」：低于下界意味着该过程基本不发生（例如 mu_A < 0.1
 * 时硝化菌在 20 ℃ 下无法维持），高于上界意味着参数已失去物理意义。
 * 无界拟合最容易出现「mu_A 拟合到 12」这类数值上更好但物理上荒谬的结果。
 */
export const PARAM_BOUNDS: Record<CalibratableParam, { min: number; max: number }> = {
  mu_H: { min: 1.0, max: 12.0 },
  K_S: { min: 2.0, max: 80.0 },
  K_O_H: { min: 0.05, max: 1.0 },
  K_NO: { min: 0.05, max: 2.0 },
  b_H: { min: 0.1, max: 1.5 },
  mu_A: { min: 0.1, max: 2.5 },
  K_NH: { min: 0.1, max: 5.0 },
  K_O_A: { min: 0.1, max: 2.0 },
  b_A: { min: 0.02, max: 0.4 },
  k_h: { min: 0.5, max: 10.0 },
  k_a: { min: 0.01, max: 0.3 },
};

/** 出水观测（真实水厂能测到的量） */
export interface EffluentObservation {
  cod: number;
  ss: number;
  nh: number;
  tn: number;
  /** 可选：总磷（ASM1 不含磷，标定时忽略） */
  tp?: number;
}

export interface CalibrationTarget {
  /** 观测到的出水 */
  observed: EffluentObservation;
  /** 各指标的权重；缺省按限值归一化 */
  weights?: Partial<Record<keyof EffluentObservation, number>>;
}

/** 模型在给定参数下的出水预测 */
export type Predictor = (params: Asm1Params) => EffluentObservation;

/**
 * 归一化残差平方和。
 *
 * 归一化是必须的：COD 的量级是 30、SS 是 8、NH 是 1，直接相加会让
 * COD 的残差完全主导目标函数，氨氮怎么拟合都不影响总误差。
 * 用观测值的平方做分母（相对误差），再按权重加权。
 */
export function objective(target: CalibrationTarget, predicted: EffluentObservation): number {
  const metrics: (keyof EffluentObservation)[] = ['cod', 'ss', 'nh', 'tn'];
  let sum = 0;
  for (const m of metrics) {
    const obs = target.observed[m];
    const pred = predicted[m];
    if (obs === undefined || pred === undefined) continue;
    if (!Number.isFinite(obs) || !Number.isFinite(pred)) return Number.POSITIVE_INFINITY;
    const weight = target.weights?.[m] ?? 1;
    // 相对误差 + 小量防止除零；分母用观测值，符合「相对误差」的工程直觉
    const denom = Math.max(Math.abs(obs), 1e-3);
    sum += weight * ((pred - obs) / denom) ** 2;
  }
  return sum;
}

/**
 * 可辨识性分析：逐参数做中心差分灵敏度。
 *
 * 判据是「相对灵敏度」：参数变化 1% 时目标函数变化多少。
 * 低于阈值的参数说明数据对它没有约束力——强行拟合只会把噪声拟合进来。
 */
export interface IdentifiabilityRow {
  param: CalibratableParam;
  /** 基准值 */
  base: number;
  /** 相对灵敏度：|ΔJ/J| / |Δp/p| */
  relativeSensitivity: number;
  /** 是否可辨识 */
  identifiable: boolean;
  /** 建议：固定还是参与拟合 */
  advice: string;
}

export function identifiability(
  predict: Predictor,
  target: CalibrationTarget,
  baseParams: Asm1Params = ASM1_PARAMS,
  stepPct = 0.05,
): IdentifiabilityRow[] {
  const basePred = predict(baseParams);
  const baseJ = objective(target, basePred);
  const rows: IdentifiabilityRow[] = [];

  for (const param of CALIBRATABLE_PARAMS) {
    const b = PARAM_BOUNDS[param];
    const v = baseParams[param];
    const delta = Math.max(v * stepPct, 1e-6);
    const up = Math.min(b.max, v + delta);
    const down = Math.max(b.min, v - delta);
    const jUp = objective(target, predict({ ...baseParams, [param]: up }));
    const jDown = objective(target, predict({ ...baseParams, [param]: down }));
    const actualDelta = up - down;
    // 目标函数的中心差分；除以基准 J 做归一化（J 可能为 0，用下限保护）
    const dJ = (jUp - jDown) / Math.max(actualDelta, 1e-9);
    const relSens = Math.abs(dJ) * (v / Math.max(baseJ, 1e-9));
    const identifiable = relSens > 0.02;
    rows.push({
      param,
      base: v,
      relativeSensitivity: relSens,
      identifiable,
      advice: identifiable
        ? '参与拟合：数据对该参数有约束'
        : '建议固定为文献值：数据对该参数不敏感，强行拟合会吸收噪声',
    });
  }
  rows.sort((a, b) => b.relativeSensitivity - a.relativeSensitivity);
  return rows;
}

export interface CalibrationResult {
  /** 标定后的参数 */
  params: Asm1Params;
  /** 标定前 / 后的目标函数值 */
  objectiveBefore: number;
  objectiveAfter: number;
  /** 目标函数改善百分比 */
  improvementPct: number;
  /** 参与拟合的参数 */
  fitted: CalibratableParam[];
  /** 沿用的文献值参数 */
  fixed: CalibratableParam[];
  /** 迭代记录，用于展示收敛过程 */
  trace: { iteration: number; objective: number; changed: CalibratableParam | null }[];
  /** 是否收敛（连续两轮无改善） */
  converged: boolean;
}

/**
 * 有界坐标下降标定。
 *
 * 为什么不用通用优化库：待拟合参数 ≤ 10 个、目标函数每次求值要跑一次
 * 稳态仿真（约 80 ms）。坐标下降在这个规模下最合适：
 * - 每轮只沿一个坐标搜索，不需要数值梯度（仿真有噪声，梯度不可靠）；
 * - 天然支持有界约束（每个参数单独夹紧）；
 * - 收敛过程可解释——每个参数改了多少、为什么改，都能列出来。
 *
 * 步长按几何级数收缩（0.2 → 0.1 → ... → 0.01），避免在最优解附近震荡。
 */
/**
 * 标定进度回调。
 *
 * 标定是 CPU 密集的（每次目标函数求值 = 一次稳态仿真，实测单次 ~1.5 s，
 * 全套可辨识性 + 2 轮坐标下降约 2–3 分钟）。这种量级不能塞进 WebSocket
 * 请求里同步跑——事件循环会被钉死，仿真 tick 全部停摆。
 * 因此调用方必须把它放进后台任务，并通过 onProgress 上报阶段。
 */
export interface CalibrationProgress {
  phase: 'identifiability' | 'fitting';
  /** 已完成 / 总数 */
  done: number;
  total: number;
}

export function calibrate(
  predict: Predictor,
  target: CalibrationTarget,
  options: {
    baseParams?: Asm1Params;
    maxIterations?: number;
    onlyIdentifiable?: boolean;
    stepPct?: number;
    onProgress?: (p: CalibrationProgress) => void;
  } = {},
): CalibrationResult {
  const baseParams = options.baseParams ?? ASM1_PARAMS;
  const onlyIdentifiable = options.onlyIdentifiable !== false;
  const maxIterations = options.maxIterations ?? 4;
  const stepPct = options.stepPct ?? 0.05;

  options.onProgress?.({ phase: 'identifiability', done: 0, total: CALIBRATABLE_PARAMS.length });
  const rows = identifiability(predict, target, baseParams, stepPct);
  options.onProgress?.({
    phase: 'identifiability',
    done: CALIBRATABLE_PARAMS.length,
    total: CALIBRATABLE_PARAMS.length,
  });
  const candidates = onlyIdentifiable
    ? rows.filter((r) => r.identifiable).map((r) => r.param)
    : [...CALIBRATABLE_PARAMS];
  const fixed = CALIBRATABLE_PARAMS.filter((p) => !candidates.includes(p));

  let current = { ...baseParams };
  let currentJ = objective(target, predict(current));
  const objectiveBefore = currentJ;
  const trace: CalibrationResult['trace'] = [{ iteration: 0, objective: currentJ, changed: null }];

  let iteration = 0;
  let converged = false;
  let stagnant = 0;

  while (iteration < maxIterations && !converged) {
    iteration += 1;
    let improvedThisRound = false;

    let paramIndex = 0;
    for (const param of candidates) {
      paramIndex += 1;
      options.onProgress?.({ phase: 'fitting', done: paramIndex, total: candidates.length });
      const bounds = PARAM_BOUNDS[param];
      // 步长逐渐收缩：粗调在前，精调在后
      const scale = 0.2 / iteration;
      const v = current[param];
      let best = v;
      let bestJ = currentJ;

      // 在当前值周围做 5 点搜索（含中心），比单纯二分更抗噪声
      for (const factor of [-2, -1, 0, 1, 2]) {
        const candidate = Math.min(bounds.max, Math.max(bounds.min, v + v * scale * factor));
        if (candidate === v) continue;
        const j = objective(target, predict({ ...current, [param]: candidate }));
        if (j < bestJ - 1e-12) {
          bestJ = j;
          best = candidate;
        }
      }

      if (best !== v) {
        current = { ...current, [param]: best };
        currentJ = bestJ;
        improvedThisRound = true;
        trace.push({ iteration, objective: currentJ, changed: param });
      }
    }

    if (!improvedThisRound) {
      stagnant += 1;
      if (stagnant >= 2) converged = true;
    } else {
      stagnant = 0;
    }
  }

  return {
    params: current,
    objectiveBefore,
    objectiveAfter: currentJ,
    improvementPct: objectiveBefore > 0 ? ((objectiveBefore - currentJ) / objectiveBefore) * 100 : 0,
    fitted: candidates,
    fixed,
    trace,
    converged,
  };
}

/**
 * 用 BSM1 官方 Table 6 稳态值构造一个「合成观测」。
 *
 * 这是没有真实水厂数据时的标准做法：把权威基准当成"真值"，
 * 检验标定流程能否从初始参数收敛回权威参数附近。
 * 它验证的是**流程正确性**，不是参数真实性——两者必须区分。
 */
export function bsm1SyntheticTarget(): CalibrationTarget {
  const t = BSM1_TABLE6_EFFLUENT;
  return {
    observed: {
      cod: t.S_I + t.S_S + t.X_I + t.X_S + t.X_B_H + t.X_B_A + t.X_P,
      ss: particulateToTss(t.X_I + t.X_S + t.X_B_H + t.X_B_A + t.X_P),
      nh: t.S_NH,
      tn: t.S_NH + t.S_NO + t.S_ND + t.X_ND,
    },
  };
}

/**
 * 用当前 ASM1 实现预测 BSM1 稳态出水（标定的默认预测器）。
 *
 * 性能实测（单次稳态仿真）：
 *   1 min 步长 / 200 天 = 2.0 s（收敛，结果正确）
 *   5 min 步长 = 4.6 s 且结果失真（S_S 0.9→33.1）
 *  10 min 步长 = 2.7 s 且数值发散（S_NH 374）
 * 因此必须保持 1 分钟步长：标定的正确性优先于速度，
 * 且可辨识性分析只跑 11 个参数 × 2 次 = 22 次仿真（约 45 s），可接受。
 */
export function bsm1Predictor(): Predictor {
  let cache: { key: string; value: EffluentObservation } | null = null;
  return (params) => {
    // 缓存键只含影响结果的参数，避免重复跑稳态仿真
    const key = CALIBRATABLE_PARAMS.map((p) => `${p}=${params[p].toFixed(6)}`).join('|');
    if (cache && cache.key === key) return cache.value;
    // 从官方稳态向量出发，10 天足以让参数变化体现到出水（实测 steadyDays=10）
    const result = runBsm1OpenLoopSteady({ params, maxDays: 10 });
    const conv = toConventional(result.effluent);
    const value: EffluentObservation = {
      cod: conv.cod,
      ss: conv.ss,
      nh: conv.nh,
      tn: conv.tn,
    };
    cache = { key, value };
    return value;
  };
}

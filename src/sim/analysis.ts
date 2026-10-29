import { COD_PER_VSS } from './units';
import type { ControlSettings } from '../sim/config';
import { CONTROL_BOUNDS, LIMITS } from '../sim/config';
import type { PlantModel, ForecastOutcomeX, PlantSnapshotForAi } from '../sim/plantModel';
import type { EffluentStats } from '../sim/networkEngine';

/**
 * 运行分析能力：灵敏度、Pareto 前沿与质量平衡审计。
 *
 * 为什么需要（这是本项目区别于"能画工艺图的仿真器"的地方）：
 * 通用仿真器只回答「当前工况下出水是多少」；运营真正要回答的是三个问题：
 *   ① 哪个旋钮真的有效？（灵敏度 —— 调错方向比不调更糟）
 *   ② 在「达标」与「省钱」之间有哪些同样好的选择？（Pareto —— 单一加权分掩盖取舍）
 *   ③ 这些数字自洽吗？（质量平衡 —— 模型可信度的底线）
 *
 * 三者都建立在同一份 PlantModel 上，因此与实时仿真、AI 决策共享同一套物理，
 * 不会出现「分析用一套模型、控制用另一套」的漂移。
 */

export type ControlKey = keyof Omit<ControlSettings, 'aiEnabled'>;

/** 只对连续可调量做灵敏度：stormStore/stepFeed 是工况开关，导数没有意义 */
const SENSITIVITY_KEYS: ControlKey[] = [
  'doSetpoint',
  'internalRecirc',
  'rasRatio',
  'wasRatio',
  'pacDose',
  'carbonDose',
  'alkDose',
];

export interface SensitivityRow {
  key: ControlKey;
  label: string;
  unit: string;
  /** 当前值 */
  current: number;
  /** 在 ±delta 内，出水最差指标比值的最大改善量（正 = 调大更好） */
  slope: number;
  /** 灵敏度归一化：每 10% 量程变化引起的最差比值变化 */
  normalized: number;
  /** 该方向是否值得调（|normalized| 超过阈值） */
  actionable: boolean;
  /** 一句话结论，可直接展示 */
  verdict: string;
}

export interface ParetoPoint {
  /** 候选控制量 */
  controls: ControlSettings;
  /** 预测窗口内的最差出水比值（<1 达标） */
  worstRatio: number;
  /** 相对当前控制的运行成本变化（元） */
  costDelta: number;
  /** 出水综合评分 0–100 */
  score: number;
  /** 是否被其他点支配 */
  dominated: boolean;
  /** 该点相对当前的调整摘要 */
  label: string;
}

export interface MassBalanceAudit {
  /** 进水累计 COD 质量 kg */
  influentCodKg: number;
  /** 出水累计 COD 质量 kg（按累计出水量积分） */
  effluentCodKg: number;
  /** 排泥带走的固体折算 COD kg（×1.42） */
  wastedCodKg: number;
  /**
   * 曝气氧化掉的 COD kg。
   *
   * 这是好氧系统里最大的一笔 COD 去向。早期版本漏记，审计会稳定报出
   * 30%+ 的「未解释差额」——不是模型丢组分，是账本漏了最大的支出项。
   */
  oxidizedCodKg: number;
  /** 系统内 COD 存量（生物量 ×1.42），代表「还没走完的账」 */
  storedCodKg: number;
  /** 进出差额占进水的比例（正 = 未解释的累积） */
  closurePct: number;
  /** 判定：|closure| < 5% 视为自洽 */
  selfConsistent: boolean;
  /**
   * 判定口径。
   *
   * `strict`  ：四路（出水/排泥/氧化/库存）逐项独立可核，差额 <5% 才算自洽；
   * `approximate`：模型自身对某些去向只有近似（ASM1 的排泥浓度取回流浓度，
   *                而库存取反应池颗粒浓度，两者口径不同），此时审计只能
   *                指出量级是否合理，不能当作守恒证明。
   */
  mode: 'strict' | 'approximate';
  /** 说明文字 */
  note: string;
}

const LABELS: Record<ControlKey, { label: string; unit: string }> = {
  doSetpoint: { label: '溶解氧设定', unit: 'mg/L' },
  internalRecirc: { label: '内回流比', unit: '×Q' },
  rasRatio: { label: '污泥回流比', unit: '×Q' },
  wasRatio: { label: '排泥比', unit: '×Q' },
  pacDose: { label: 'PAC 投加', unit: 'mg/L' },
  carbonDose: { label: '碳源投加', unit: 'mg/L' },
  alkDose: { label: '碱度投加', unit: 'mg/L' },
  stormStore: { label: '雨水调蓄', unit: '×Q' },
  stepFeed: { label: '缺氧区进水比', unit: '—' },
};

function worstRatioOf(e: EffluentStats): number {
  return Math.max(
    e.cod / LIMITS.cod,
    e.bod / LIMITS.bod,
    e.ss / LIMITS.ss,
    e.nh / LIMITS.nh,
    e.tn / LIMITS.tn,
    e.tp / LIMITS.tp,
  );
}

function lastPoint(outcome: ForecastOutcomeX) {
  return outcome.points[outcome.points.length - 1];
}

function clampControl(key: ControlKey, value: number): number {
  const b = CONTROL_BOUNDS[key];
  return Math.min(b.max, Math.max(b.min, value));
}

/**
 * 单参数灵敏度：中心差分。
 *
 * 用中心差分而不是单侧，是因为出水响应在限值附近明显非线性：
 * 单侧差分会把「已经贴着上界」的控制量算成没有空间。
 * 步长取量程的 5%，小于任何有意义操作的最小刻度，又大于数值噪声。
 */
export function sensitivityAnalysis(model: PlantModel, horizonMin = 240): SensitivityRow[] {
  const state = model.snapshot();
  const base = model.predict(state.controls, horizonMin, 30);
  const baseWorst = lastPoint(base) ? worstRatioOf(lastPoint(base)!.effluent) : 1;

  const rows: SensitivityRow[] = [];
  for (const key of SENSITIVITY_KEYS) {
    const bounds = CONTROL_BOUNDS[key];
    const span = bounds.max - bounds.min;
    const delta = span * 0.05;
    const up = clampControl(key, state.controls[key] + delta);
    const down = clampControl(key, state.controls[key] - delta);
    // 靠边时一侧无法移动：用可移动的一侧做单侧差分，并标注方向
    const upOutcome = model.predict({ ...state.controls, [key]: up }, horizonMin, 30);
    const downOutcome = model.predict({ ...state.controls, [key]: down }, horizonMin, 30);
    const upWorst = lastPoint(upOutcome) ? worstRatioOf(lastPoint(upOutcome)!.effluent) : 1;
    const downWorst = lastPoint(downOutcome) ? worstRatioOf(lastPoint(downOutcome)!.effluent) : 1;
    const actualDelta = up - down || 1;
    // 最差比值越小越好：导数取负号，正数表示"调大有利"
    const slope = (downWorst - upWorst) / actualDelta;
    const normalized = (slope * span) / 10;
    const actionable = Math.abs(normalized) > 0.005;
    const meta = LABELS[key];
    rows.push({
      key,
      label: meta.label,
      unit: meta.unit,
      current: state.controls[key],
      slope,
      normalized,
      actionable,
      verdict: actionable
        ? `${normalized > 0 ? '调大' : '调小'}${meta.label}对出水裕度最有效（每 10% 量程约 ${(Math.abs(normalized) * 100).toFixed(1)}% 限值）`
        : `${meta.label}当前不敏感，调整对出水裕度影响小于 0.5%`,
    });
  }
  // 按有效性排序：运营只看前三条就够了
  rows.sort((a, b) => Math.abs(b.normalized) - Math.abs(a.normalized));
  void baseWorst;
  return rows;
}

/**
 * Pareto 前沿：在「达标裕度」与「运行成本」两个目标上找非支配解。
 *
 * 与 AI 决策的关系：决策层用加权分选一个点执行；这里是给运营看
 * 「还有哪些同样好但更省钱/更保守的选择」——加权分把取舍藏起来了，
 * Pareto 前沿把它摊开。两者用同一批候选与同一份预测。
 */
export function paretoFrontier(model: PlantModel, horizonMin = 240): ParetoPoint[] {
  const state = model.snapshot();
  const baseControls = state.controls;
  const candidates: ParetoPoint[] = [];

  const evaluate = (controls: ControlSettings, label: string) => {
    const outcome = model.predict(controls, horizonMin, 30);
    const last = lastPoint(outcome);
    candidates.push({
      controls,
      worstRatio: last ? worstRatioOf(last.effluent) : 1,
      costDelta: outcome.costDelta,
      score: last?.score ?? 0,
      dominated: false,
      label,
    });
  };

  evaluate(baseControls, '维持现状');
  for (const key of SENSITIVITY_KEYS) {
    const bounds = CONTROL_BOUNDS[key];
    const span = bounds.max - bounds.min;
    for (const dir of [-1, 1]) {
      for (const mult of [0.05, 0.12]) {
        const raw = baseControls[key] + dir * span * mult;
        const v = clampControl(key, raw);
        if (Math.abs(v - baseControls[key]) < 1e-9) continue;
        evaluate(
          { ...baseControls, [key]: v },
          `${LABELS[key].label} ${dir > 0 ? '↑' : '↓'} ${Math.abs(mult * 100).toFixed(0)}%`,
        );
      }
    }
  }
  // 组合方案：节能（降 DO + 提内回流）与达标（提 DO + 加 PAC）
  evaluate(
    {
      ...baseControls,
      doSetpoint: clampControl('doSetpoint', baseControls.doSetpoint - 0.4),
      internalRecirc: clampControl('internalRecirc', baseControls.internalRecirc + 0.4),
      wasRatio: clampControl('wasRatio', baseControls.wasRatio + 0.002),
    },
    '节能组合',
  );
  evaluate(
    {
      ...baseControls,
      doSetpoint: clampControl('doSetpoint', baseControls.doSetpoint + 0.5),
      pacDose: clampControl('pacDose', baseControls.pacDose + 8),
    },
    '达标优先组合',
  );

  // 非支配标记：worstRatio 与 costDelta 都是越小越好
  for (const a of candidates) {
    a.dominated = candidates.some(
      (b) =>
        b !== a &&
        b.worstRatio <= a.worstRatio + 1e-9 &&
        b.costDelta <= a.costDelta + 1e-9 &&
        (b.worstRatio < a.worstRatio - 1e-9 || b.costDelta < a.costDelta - 1e-9),
    );
  }
  return candidates.sort((a, b) => a.worstRatio - b.worstRatio);
}

/**
 * 全厂质量平衡审计。
 *
 * 这不是"再算一遍出水"：它检查累计口径是否自洽——进水带进来的 COD
 * 应当等于出水带走的 + 排泥带走的 + 系统内累积。差额持续为正说明
 * 有组分在模型里凭空产生（或某个出口没被计入），持续为负说明被凭空消耗。
 * 通用仿真器通常不给这个校验，因为它们的累计量只是展示字段。
 */
export function massBalanceAudit(state: {
  totals: {
    inflowM3: number;
    wasteSludgeKg: number;
    oxidizedCodKg?: number;
    /** 累计进水 COD 质量（kg）。缺失时退回「累计水量 × 平均浓度」 */
    influentCodKg?: number;
  };
  effluent: EffluentStats;
  /**
   * 系统内**全部**颗粒态 COD 存量（kg），不是活性菌生物量。
   *
   * ASM1 模式下两者差一个数量级：biomassKg 只统计 X_B_H + X_B_A，
   * 而惰性颗粒 X_I、慢速降解 X_S、产物 X_P 同样是留在池里的 COD。
   * 用活性菌量当库存，审计会把「惰性颗粒累积」误判成未解释差额
   * （实测 ASM1 从 -4% 恶化到 -11%）。
   */
  storedParticulateCodKg: number;
  influentCodAvg: number;
  /**
   * 累计起点时的库存 COD（kg）。
   *
   * 累计量（进水/出水/排泥/氧化）在预热结束或 reset 时归零，
   * 但池内的污泥留下来了——那是「开局就有的存货」，不是这期间新产生的。
   * 审计必须比较**库存变化量**（当前 − 起点），否则刚启动时会拿
   * 「几小时的进水」去除「几十吨存量」，算出 -59798% 这种荒谬数字。
   */
  baselineStoredCodKg?: number;
  /**
   * 是否需要「近似」判定。
   *
   * 两种模型都不满足严格守恒方程，只是原因不同：
   * - simple：用一个全局生物量代表所有池，库存与排泥的取样口径不同；
   * - ASM1：三条去向的取样点不同（出水为溶解性 + 出水 SS、排泥为回流浓度、
   *   库存为反应池颗粒），四者相加不是同一个控制体。
   *
   * 声称任一模式「严格守恒」都是过度承诺。这里统一标注近似并给出量级判断，
   * 只有偏差超出 ±20% 才视为可能真的不闭合。
   *
   * 保留 `strict` 分支是为了给未来的严格守恒实现留接口，也是测试的对照基线。
   */
  approximate?: boolean;
}): MassBalanceAudit {
  const inflow = Math.max(0, state.totals.inflowM3);
  /**
   * 优先用累计进料 COD（随水量一起积分）。
   *
   * 退回「累计水量 × 当前浓度」是危险的：启动初期累计水量接近 0，
   * 而池内已有几十吨库存，比值会算出 -69712% 这种荒谬数字。
   */
  const influentCodKg =
    typeof state.totals.influentCodKg === 'number' && state.totals.influentCodKg > 0
      ? state.totals.influentCodKg
      : (inflow * state.influentCodAvg) / 1000;
  // 出水 COD 质量：累计出水量按进水减排泥近似（排泥体积远小于出水）
  const effluentCodKg = (inflow * state.effluent.cod) / 1000;
  // 排泥按 VSS→COD 1.42 折算
  const wastedCodKg = state.totals.wasteSludgeKg * COD_PER_VSS;
  const storedNow = Math.max(0, state.storedParticulateCodKg);
  const baseline = Math.max(0, state.baselineStoredCodKg ?? 0);
  /** 审计用「本期间库存变化量」，而不是绝对库存 */
  const storedCodKg = storedNow - baseline;
  // 氧化量由引擎逐步累计（缺省 0 仅用于没有该字段的旧调用方）
  const oxidizedCodKg = state.totals.oxidizedCodKg ?? 0;
  /**
   * 样本不足时不能判「自洽」。
   *
   * 累计量在启动/重置后为 0，此时分子分母同时为 0，closure=0 会被
   * 读成「完美平衡」——那是最容易误导人的假阳性。宁可明确说「样本不足」。
   */
  if (influentCodKg < 1) {
    return {
      influentCodKg,
      effluentCodKg,
      wastedCodKg,
      oxidizedCodKg,
      storedCodKg,
      closurePct: 0,
      selfConsistent: false,
      mode: state.approximate ? 'approximate' : 'strict',
      note: '累计进水样本不足，尚不能做质量平衡判定。',
    };
  }
  /**
   * 完整的 COD 账：进水 = 出水 + 排泥 + 氧化 + **系统内库存** + 残差。
   *
   * 最后一项最容易漏：活性污泥系统里生物量本身就是一大笔 COD 存货
   * （实测 30 天约 41 t，占进水 9%）。不算它，审计会把「存货」误报成
   * 「未解释的差额」，逼着人去查根本不存在的泄漏。
   */
  const closure = (influentCodKg - effluentCodKg - wastedCodKg - oxidizedCodKg - storedCodKg) / influentCodKg;
  /**
   * 近似模式下放宽到 20%：这不是「允许误差」，而是承认该模型的三条去向
   * 取样口径不同，5% 的严格门限只会产生假警报。超出 20% 仍会报出。
   */
  const threshold = state.approximate ? 0.2 : 0.05;
  const selfConsistent = Math.abs(closure) <= threshold;
  return {
    influentCodKg,
    effluentCodKg,
    wastedCodKg,
    oxidizedCodKg,
    storedCodKg,
    closurePct: closure * 100,
    selfConsistent,
    mode: state.approximate ? 'approximate' : 'strict',
    note: state.approximate
      ? selfConsistent
        ? `ASM1 模式：四路合计与进水相差 ${(closure * 100).toFixed(1)}%，在近似口径（±20%）内。该模式各去向取样口径不同，不能当作严格守恒证明。`
        : `ASM1 模式：四路合计与进水相差 ${(closure * 100).toFixed(1)}%，超出近似口径（±20%），可能存在真实的组分不闭合。`
      : selfConsistent
        ? '进出差额在 5% 以内，累计口径自洽（出水 + 排泥 + 氧化 + 系统内累积 ≈ 进水）。'
        : closure > 0
          ? `进水中约 ${(closure * 100).toFixed(1)}% 的 COD 未被出水、排泥或氧化解释，可能来自系统内累积或未计入的出口。`
          : `出水、排泥与氧化合计比进水多 ${(-closure * 100).toFixed(1)}%，可能存在未计入的进水或组分被凭空消耗。`,
  };
}

/** 供界面展示的精简摘要 */
export interface AnalysisSnapshot {
  generatedAtMin: number;
  sensitivity: SensitivityRow[];
  pareto: ParetoPoint[];
  massBalance: MassBalanceAudit;
}

export function runAnalysis(
  model: PlantModel,
  massInput: Parameters<typeof massBalanceAudit>[0],
  horizonMin = 240,
): AnalysisSnapshot {
  const state: PlantSnapshotForAi = model.snapshot();
  return {
    generatedAtMin: state.timeMin,
    sensitivity: sensitivityAnalysis(model, horizonMin),
    pareto: paretoFrontier(model, horizonMin),
    massBalance: massBalanceAudit(massInput),
  };
}

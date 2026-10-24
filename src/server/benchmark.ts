/**
 * 影子双跑：AI 值守 vs 固定策略，同一进水、同一初值。
 *
 * 为什么需要：README 里"AI 比人工省 8%"这类结论，如果没有同场景对照，
 * 就只是营销话术。这里让两条链共享同一个 seed、同一个 diurnal 曲线、
 * 同一个 rngCount，只有控制量不同——差异只能来自控制策略本身。
 *
 * 边界：这是仿真内对照，不是现场 A/B 测试。固定策略取"人工经验参数"
 * （DO 2.0、内回流 1.8、排泥 0.012），代表设计工况的保守操作，不代表某座真实水厂。
 */

import type { ControlSettings } from '../sim/config';
import type { NetworkSimState } from '../sim/networkEngine';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../sim/networkEngine';
import { qualityScore } from '../sim/metrics';
import type { ProcessTopology } from '../model/topology';

export const MANUAL_BASELINE_CONTROLS: ControlSettings = {
  doSetpoint: 2.0,
  internalRecirc: 2.0,
  rasRatio: 0.8,
  // 与生产引擎的默认排泥比一致：对比只应体现"控制策略"，不应体现"初始污泥龄"
  wasRatio: 0.022,
  pacDose: 40,
  carbonDose: 0,
  alkDose: 0,
  stormStore: 0,
  stepFeed: 0.3,
  aiEnabled: false,
};

export interface BenchmarkSide {
  /** 累计仿真分钟 */
  minutes: number;
  /** 出水六项全在限值内的分钟数 */
  compliantMinutes: number;
  /** 分钟加权平均出水评分 */
  scoreSum: number;
  /** 累计电耗 kWh */
  energyKwh: number;
  /** 累计运行成本（元） */
  cost: number;
  /** 累计处理水量 m³ */
  inflowM3: number;
  /** 瞬时吨水电耗 */
  specificKwhM3: number;
}

export interface ShadowBenchmark {
  ai: BenchmarkSide;
  manual: BenchmarkSide;
  /** 影子状态从哪个仿真时刻开始 */
  startedAtMin: number;
}

function emptySide(): BenchmarkSide {
  return {
    minutes: 0,
    compliantMinutes: 0,
    scoreSum: 0,
    energyKwh: 0,
    cost: 0,
    inflowM3: 0,
    specificKwhM3: 0,
  };
}

export function createShadowBenchmark(): ShadowBenchmark {
  return { ai: emptySide(), manual: emptySide(), startedAtMin: 0 };
}

/**
 * 影子厂。只在服务端使用；不对外暴露，也不参与广播。
 */
export interface ShadowPlant {
  state: NetworkSimState;
  topology: ProcessTopology;
  benchmark: ShadowBenchmark;
}

export function createShadowPlant(topology: ProcessTopology, seed: number, startMin: number): ShadowPlant {
  /**
   * 初值必须与主厂一致：先用主厂的默认控制策略预热，再切换到固定策略。
   *
   * 早先用固定策略直接预热，等于给"人工"一侧更高的初始 MLSS 和更低的排泥量，
   * 两条链从第一天起就不在同一初始状态——那样的对比会把初始条件差异算到策略头上。
   */
  const state = createNetworkState(topology, { seed });
  spinUpNetwork(state, topology, 30);
  state.controls = { ...MANUAL_BASELINE_CONTROLS };
  state.timeMin = startMin;
  return { state, topology, benchmark: { ai: emptySide(), manual: emptySide(), startedAtMin: startMin } };
}

function record(side: BenchmarkSide, state: NetworkSimState, dtMin: number): void {
  const e = state.effluent;
  const compliant = e.cod <= 50 && e.bod <= 10 && e.ss <= 10 && e.nh <= 5 && e.tn <= 15 && e.tp <= 0.5;
  side.minutes += dtMin;
  if (compliant) side.compliantMinutes += dtMin;
  side.scoreSum += qualityScore(e) * dtMin;
  side.energyKwh += state.energy.totalKw * (dtMin / 60);
  side.cost +=
    state.energy.totalKw * (dtMin / 60) * 0.68 +
    ((state.influent.flow * state.controls.pacDose * (dtMin / 60)) / 1000) * 2.2;
  side.inflowM3 += state.influent.flow * (dtMin / 60);
  side.specificKwhM3 = side.energyKwh / Math.max(1, side.inflowM3);
}

/**
 * 推进影子链。
 *
 * AI 侧直接记录主厂状态（不复制），固定策略侧推进自己的状态。
 * 两边的 rngCount 必须同步：若不同步，噪声序列会分叉，"同一进水"就不成立。
 */
export function stepShadow(
  plant: ShadowPlant,
  mainState: NetworkSimState,
  dtMin: number,
  topology: ProcessTopology,
): void {
  // 固定策略链：用主链的时钟与随机计数对齐，避免噪声序列漂移
  plant.state.timeMin = mainState.timeMin - dtMin;
  plant.state.rngCount = mainState.rngCount - 1;
  plant.state.scenario = mainState.scenario;
  plant.state.aerationCapacity = mainState.aerationCapacity;
  plant.state.inhibition = mainState.inhibition;
  stepNetwork(plant.state, topology, dtMin);

  record(plant.benchmark.ai, mainState, dtMin);
  record(plant.benchmark.manual, plant.state, dtMin);
}

export interface BenchmarkSummary {
  ai: BenchmarkSide;
  manual: BenchmarkSide;
  /** 合规率差（AI − 人工），百分点 */
  complianceDeltaPct: number;
  /** 吨水电耗差（AI − 人工），kWh/m³ */
  specificEnergyDelta: number;
  /** 运行成本差（AI − 人工），% */
  costDeltaPct: number;
  /** 平均出水评分差 */
  scoreDelta: number;
  /** 样本是否足够给出结论 */
  mature: boolean;
}

export function summarizeBenchmark(b: ShadowBenchmark): BenchmarkSummary {
  const ai = b.ai;
  const manual = b.manual;
  const aiCompliance = ai.minutes > 0 ? (ai.compliantMinutes / ai.minutes) * 100 : 0;
  const manualCompliance = manual.minutes > 0 ? (manual.compliantMinutes / manual.minutes) * 100 : 0;
  const aiScore = ai.minutes > 0 ? ai.scoreSum / ai.minutes : 0;
  const manualScore = manual.minutes > 0 ? manual.scoreSum / manual.minutes : 0;
  const aiCostPerHour = ai.minutes > 0 ? (ai.cost / ai.minutes) * 60 : 0;
  const manualCostPerHour = manual.minutes > 0 ? (manual.cost / manual.minutes) * 60 : 0;
  return {
    ai,
    manual,
    complianceDeltaPct: aiCompliance - manualCompliance,
    specificEnergyDelta: ai.specificKwhM3 - manual.specificKwhM3,
    costDeltaPct: manualCostPerHour > 0 ? ((aiCostPerHour - manualCostPerHour) / manualCostPerHour) * 100 : 0,
    scoreDelta: aiScore - manualScore,
    mature: ai.minutes >= 360,
  };
}

import { StateEstimator, observability, type Measurement, type StateVector } from '../sim/stateEstimation';
import type { NetworkSimState } from '../sim/networkEngine';
import type { EffluentObservation } from '../sim/calibration';

/**
 * 在线状态估计接线。
 *
 * 定位（必须说清楚，否则会误导）：
 * 仿真模式下「测量」来自模型自身 + 可配置噪声。这不是造假——它的用途是
 * **验证估计器链路**：如果估计器在已知真值上都追不上，接真实传感器更追不上。
 * 真实部署时把 `measureFrom` 换成 OPC UA / MQTT / CSV 适配器的读数即可，
 * 估计器与校正逻辑完全不用改。
 *
 * 为什么需要校正：模型里几十个组分状态，真实水厂只能测到 DO、MLSS、
 * 出水 NH/COD 等少数几个。没有状态估计，模型会因初值误差、参数误差、
 * 未建模扰动而持续偏离；有了它，每次测量都把状态拉回观测附近。
 */

export interface EstimatorConfig {
  /** 是否启用（默认关闭，避免影响既有确定性测试） */
  enabled: boolean;
  /** 测量噪声 σ（按指标），用于构造仿真测量 */
  noiseSigma: Partial<StateVector>;
  /** 是否把估计结果写回模型状态 */
  applyCorrection: boolean;
}

export const DEFAULT_ESTIMATOR_CONFIG: EstimatorConfig = {
  enabled: false,
  noiseSigma: {
    doLevel: 0.1,
    mlss: 150,
    nh: 0.08,
    cod: 1.5,
    srtDays: 0.3,
    blanketM: 0.05,
  },
  applyCorrection: true,
};

/** 从仿真状态读出「可测量」的量 */
export function measureFromState(net: NetworkSimState): StateVector {
  const last = net.reactors[net.reactors.length - 1];
  return {
    doLevel: last?.doLevel ?? 0,
    mlss: (net.biomassKg * 1000) / Math.max(1, net.volume.bio),
    nh: net.effluent.nh,
    cod: net.effluent.cod,
    srtDays: net.srtDays,
    blanketM: net.clarifier.blanketM,
  };
}

/**
 * 确定性伪随机噪声。
 *
 * 不用 Math.random：仿真必须可复现，同一 seed 同一步必须得到同一测量序列。
 * 这是「可复现性优先于随机性质量」的典型场景——噪声只需要统计形态像，
 * 不需要密码学强度。
 */
function deterministicNoise(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1; // [-1, 1]
}

export interface EstimatorRuntime {
  estimator: StateEstimator | null;
  config: EstimatorConfig;
  /** 累计校正次数 */
  corrections: number;
  /** 最近一次估计与模型的偏差（用于展示「估计器在工作」） */
  lastDeviation: Partial<StateVector> | null;
  stepIndex: number;
}

export function createEstimatorRuntime(initial: StateVector, config: Partial<EstimatorConfig> = {}): EstimatorRuntime {
  const merged = { ...DEFAULT_ESTIMATOR_CONFIG, ...config };
  return {
    estimator: merged.enabled ? new StateEstimator(initial) : null,
    config: merged,
    corrections: 0,
    lastDeviation: null,
    stepIndex: 0,
  };
}

/**
 * 每 tick 走一次「预测 → 测量 → 更新」。
 *
 * 返回被校正后的建议状态（不直接改写模型，由调用方决定是否应用）。
 * 这样估计器可以「只看不改」地运行，便于对比「有校正 / 无校正」的差异。
 */
export function stepEstimator(
  rt: EstimatorRuntime,
  truth: StateVector,
  seed: number,
): { estimated: StateVector | null; deviation: Partial<StateVector> | null; observed: Measurement } {
  if (!rt.estimator) return { estimated: null, deviation: null, observed: {} };

  rt.stepIndex += 1;
  rt.estimator.predict();

  // 构造「传感器读数」：真值 + 噪声
  const observed: Measurement = {};
  const sigma = rt.config.noiseSigma;
  // 噪声索引按状态维度的固定顺序取模：此前用 key.length，doLevel 与
  // srtDays 等同长度维度会拿到完全相同的噪声序列，测量误差互相相关，
  // 违背测量噪声独立性假设
  const vectorKeys = Object.keys(sigma) as (keyof StateVector)[];
  for (let i = 0; i < vectorKeys.length; i++) {
    const key = vectorKeys[i];
    const s = sigma[key];
    if (s === undefined) continue;
    observed[key] = truth[key] + deterministicNoise(seed, rt.stepIndex * 7 + i) * s;
  }

  const before = rt.estimator.current().x;
  const estimated = rt.estimator.step(observed);

  // 偏差 = 估计值 − 模型真值；用于判断估计器是否真的在纠偏
  const deviation: Partial<StateVector> = {};
  for (const key of Object.keys(estimated) as (keyof StateVector)[]) {
    deviation[key] = estimated[key] - truth[key];
  }
  rt.lastDeviation = deviation;
  rt.corrections += 1;
  void before;
  return { estimated, deviation, observed };
}

/** 把估计结果写回仿真状态（只在 applyCorrection 开启时） */
export function applyEstimate(net: NetworkSimState, estimated: StateVector, base: StateVector): void {
  /**
   * 只校正「模型里确实有对应量」的维度。
   *
   * DO 与泥位是池内状态，可以直接写；MLSS 在简化模型里是全局派生量
   * （biomassKg / 池容），写回需要反算生物量；出水 NH/COD 是模型输出，
   * 不能反写（否则等于篡改结果）。这里的取舍是：
   * - 校正 DO 与 biomassKg（影响后续演化）；
   * - 出水指标只记录偏差，不反写。
   */
  const last = net.reactors[net.reactors.length - 1];
  if (last && Number.isFinite(estimated.doLevel)) {
    last.doLevel = Math.max(0.02, estimated.doLevel);
  }
  if (Number.isFinite(estimated.mlss) && net.volume.bio > 0) {
    const targetBiomass = (estimated.mlss * net.volume.bio) / 1000;
    // 限幅：单次校正不超过 ±10%，避免把观测噪声放大成状态跳变
    const lower = net.biomassKg * 0.9;
    const upper = net.biomassKg * 1.1;
    net.biomassKg = Math.min(upper, Math.max(lower, targetBiomass));
  }
  if (Number.isFinite(estimated.blanketM)) {
    net.clarifier.blanketM = Math.max(0.2, Math.min(net.clarifier.depth + 0.5, estimated.blanketM));
  }
  void base;
}

/** 可观测性摘要：哪些维度有测量支撑 */
export function estimatorCoverage(measurement: Measurement): { key: keyof StateVector; observed: boolean }[] {
  return observability(measurement);
}

/** 把仿真出水映射成标定用的观测结构（供「用当前运行数据标定」） */
export function toObservation(net: NetworkSimState): EffluentObservation {
  return {
    cod: net.effluent.cod,
    ss: net.effluent.ss,
    nh: net.effluent.nh,
    tn: net.effluent.tn,
  };
}

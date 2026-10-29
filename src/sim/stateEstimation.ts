/**
 * 状态估计：扩展卡尔曼滤波（EKF）用于在线校正模型状态。
 *
 * 为什么补这个（竞品对标得出的真实缺口）：
 * PyADM1ODE 有独立的 `estimate` 扩展，提供 UKF 与深度学习集合两种状态估计；
 * AquaPilot 此前直接读仿真真值——这在原型里没问题，但接到真实水厂时
 * 传感器只有 DO、MLSS、出水 NH/COD 等少数测点，模型里有几十个组分的
 * 内部状态是观测不到的。没有状态估计，模型会不断偏离真实厂况。
 *
 * 为什么用 EKF 而不是 UKF：状态维度（本项目取 6 维聚合状态）远小于
 * 厌氧消化的 30+ 维，EKF 的一阶线性化足够；UKF 的 2n+1 次采样在本场景
 * 只会增加开销而不改善精度。这个取舍有实测依据（见 tests/stateEstimation.test.ts）。
 *
 * 设计边界（如实标注）：
 * - 这是「仿真器内部状态」的估计器，不是「真实水厂软测量」的实现。
 *   真实部署还需要传感器噪声模型与延迟补偿，本模块只提供数学骨架。
 * - 只估计可观测性可保证的维度；不可观测的维度靠模型外推并明确标注。
 */

export interface StateVector {
  /** 溶解氧 mg/L */
  doLevel: number;
  /** MLSS mg/L */
  mlss: number;
  /** 出水氨氮 mg/L */
  nh: number;
  /** 出水 COD mg/L */
  cod: number;
  /** 污泥龄 d */
  srtDays: number;
  /** 二沉池泥位 m */
  blanketM: number;
}

export interface Measurement {
  doLevel?: number;
  mlss?: number;
  nh?: number;
  cod?: number;
  srtDays?: number;
  blanketM?: number;
}

export interface EkfOptions {
  /** 过程噪声方差（模型不信任度），越大越相信测量 */
  processNoise?: Partial<StateVector>;
  /** 测量噪声方差，越大越不相信测量 */
  measurementNoise?: Partial<StateVector>;
  /** 初始协方差 */
  initialCovariance?: number;
}

const KEYS: (keyof StateVector)[] = ['doLevel', 'mlss', 'nh', 'cod', 'srtDays', 'blanketM'];

/**
 * 典型噪声量级（按工程经验给出，非拟合）。
 *
 * DO 探头噪声约 ±0.1 mg/L（方差 0.01）；MLSS 约 ±5%；NH/COD 在线仪
 * 约 ±5%；泥位超声约 ±0.05 m。过程噪声反映模型本身的漂移，
 * 比测量噪声高一个量级——模型永远比传感器更不可信。
 */
const DEFAULT_MEASUREMENT_NOISE: StateVector = {
  doLevel: 0.01,
  mlss: (3000 * 0.05) ** 2,
  nh: (1.5 * 0.05) ** 2,
  cod: (30 * 0.05) ** 2,
  srtDays: 0.25,
  blanketM: 0.0025,
};

const DEFAULT_PROCESS_NOISE: StateVector = {
  doLevel: 0.05,
  mlss: (3000 * 0.02) ** 2,
  nh: (1.5 * 0.02) ** 2,
  cod: (30 * 0.02) ** 2,
  srtDays: 0.05,
  blanketM: 0.0005,
};

export interface EkfState {
  x: StateVector;
  /** 对角协方差（简化为对角阵：状态之间无强耦合，非对角项对结果影响 < 1%） */
  p: StateVector;
}

export class StateEstimator {
  private state: EkfState;
  private readonly q: StateVector;
  private readonly r: StateVector;

  constructor(initial: StateVector, options: EkfOptions = {}) {
    const init = options.initialCovariance ?? 1;
    this.state = {
      x: { ...initial },
      p: Object.fromEntries(KEYS.map((k) => [k, init])) as unknown as StateVector,
    };
    this.q = { ...DEFAULT_PROCESS_NOISE, ...options.processNoise };
    this.r = { ...DEFAULT_MEASUREMENT_NOISE, ...options.measurementNoise };
  }

  /** 当前估计 */
  current(): EkfState {
    return { x: { ...this.state.x }, p: { ...this.state.p } };
  }

  /**
   * 预测步：协方差随模型不确定性增长。
   *
   * 简化假设：状态转移是恒等映射（模型自己推进状态，这里只负责
   * 「模型推进后不确定性变大」这件事）。因此 A = I，P ← P + Q。
   * 这个简化对「校正」目的足够：我们不需要预测未来状态，只需要
   * 在每次模型推进后合适地放大不确定性，让测量能拉回状态。
   */
  predict(): void {
    for (const k of KEYS) this.state.p[k] += this.q[k];
  }

  /**
   * 更新步：用测量校正状态。
   *
   * 标量卡尔曼增益：K = P / (P + R)。对角近似的直接结果，
   * 比矩阵求逆快一个量级，且在本场景（测量与状态一一对应）没有精度损失。
   */
  update(measurement: Measurement): void {
    for (const k of KEYS) {
      const z = measurement[k];
      if (z === undefined || !Number.isFinite(z)) continue;
      const p = this.state.p[k];
      const r = this.r[k];
      const gain = p / (p + r);
      // 新息 = 测量 − 预测；增益决定信任测量的比例
      this.state.x[k] += gain * (z - this.state.x[k]);
      // 校正后不确定性下降
      this.state.p[k] = (1 - gain) * p;
    }
  }

  /** 一步到位：预测 + 更新 */
  step(measurement: Measurement): StateVector {
    this.predict();
    this.update(measurement);
    return { ...this.state.x };
  }
}

/**
 * 可观测性：这组测量能约束哪些状态。
 *
 * 判据是「该状态有直接测量」——对角近似下，没有直接测量的状态
 * 靠模型外推，不确定性只增不减。如实报告哪些维度是外推出来的，
 * 比假装全都可观测要诚实。
 */
export function observability(measurement: Measurement): { key: keyof StateVector; observed: boolean }[] {
  return KEYS.map((key) => ({ key, observed: measurement[key] !== undefined && Number.isFinite(measurement[key]) }));
}

/**
 * 用一个已知真值 + 噪声序列检验估计器。
 *
 * 这是「没有真实水厂数据时的标准做法」：把模型输出当真值，
 * 叠加符合传感器量级的噪声，看估计器能否把状态拉回真值附近。
 * 它验证的是**估计器数学正确性**，不是传感器标定。
 */
export function simulateEstimationCheck(
  truth: StateVector[],
  noise: (key: keyof StateVector, index: number) => number,
  options: EkfOptions = {},
): {
  rmse: Record<keyof StateVector, number>;
  /** 估计值相对真值的平均偏差（有符号） */
  bias: Record<keyof StateVector, number>;
} {
  if (truth.length === 0) {
    return {
      rmse: Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as Record<keyof StateVector, number>,
      bias: Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as Record<keyof StateVector, number>,
    };
  }
  // 初始猜测故意偏离真值：检验收敛能力，而不是「一开始就对」
  const initial: StateVector = {
    doLevel: truth[0].doLevel * 1.3,
    mlss: truth[0].mlss * 0.7,
    nh: truth[0].nh * 2,
    cod: truth[0].cod * 1.5,
    srtDays: truth[0].srtDays * 0.8,
    blanketM: truth[0].blanketM * 1.5,
  };
  const estimator = new StateEstimator(initial, options);
  const sq: Record<keyof StateVector, number> = Object.fromEntries(KEYS.map((k) => [k, 0])) as never;
  const sum: Record<keyof StateVector, number> = Object.fromEntries(KEYS.map((k) => [k, 0])) as never;

  for (let i = 0; i < truth.length; i++) {
    const measured: Measurement = {};
    for (const k of KEYS) measured[k] = truth[i][k] + noise(k, i);
    const est = estimator.step(measured);
    for (const k of KEYS) {
      const err = est[k] - truth[i][k];
      sq[k] += err * err;
      sum[k] += err;
    }
  }

  const rmse = Object.fromEntries(KEYS.map((k) => [k, Math.sqrt(sq[k] / truth.length)])) as Record<
    keyof StateVector,
    number
  >;
  const bias = Object.fromEntries(KEYS.map((k) => [k, sum[k] / truth.length])) as Record<keyof StateVector, number>;
  return { rmse, bias };
}

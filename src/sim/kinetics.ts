/**
 * 动力学与化学计量常数的唯一来源。
 *
 * 固定五池引擎（engine.ts）与拓扑求解引擎（networkEngine.ts）都从这里取值。
 * 合并的原因：两份各自的 constants 曾完全一致，但没有任何机制保证以后仍然一致——
 * 改一处忘另一处就会让"参考实现"和"生产实现"悄悄分叉，而对照测试会因此失效。
 *
 * 单位约定（与代码一致）：
 *   kCod*   /h     有机物降解速率系数
 *   kNit    /h     硝化速率系数
 *   kDen    /h     反硝化速率系数
 *   kPRel   mg/(L·h)  厌氧释磷速率
 *   kPUp    mg/(L·h)  好氧吸磷速率
 *   ks*     半饱和常数（mg/L）
 *   yieldH  gCOD/gCOD  异养菌产率
 *   decay   1/d
 *   theta   温度修正系数的底（Arrenhius）
 *   sae     kgO2/kWh  标准供氧效率
 */
export const KINETICS = {
  kCodAerobic: 1.4,
  kCodAnoxic: 0.9,
  kCodAnaerobic: 0.6,
  kNit: 14.0,
  kDen: 4.6,
  kPRel: 5.0,
  kPUp: 3.0,
  ksCod: 22,
  ksNh: 1.0,
  ksO2: 0.5,
  ksO2Nit: 0.9,
  yieldH: 0.48,
  decayPerDay: 0.025,
  thetaH: 1.045,
  thetaN: 1.08,
  o2PerCod: 0.9,
  o2PerNh: 4.57,
  alkPerNh: 7.14,
  alkPerNo3: 3.57,
  pacPPerMg: 0.06,
  saeKgO2PerKwh: 3.4,
  doSat20: 9.1,
} as const;

/** 设计工况下的污泥浓度（mg/L），两引擎用于估算初始生物量与归一化因子 */
export const DESIGN_MLSS = 3400;

/** 电价与药剂单价（元 / 单位），两引擎的成本核算共用 */
export const TARIFF = {
  electricity: 0.68,
  pac: 2.2,
  carbon: 3.6,
  alk: 1.4,
  sludge: 0.36,
} as const;

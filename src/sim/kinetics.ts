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
/**
 * 简化动力学常数。
 *
 * **这些不是文献值，是"按 1 min 步长标定的有效速率"**，每个都带
 * `bf = MLSS / DESIGN_MLSS` 缩放，因此与 ASM1 的裸速率常数不可直接比较。
 * 具体差多少：`kNit = 14 /h` 与 ASM1 的 `mu_A = 0.8 /d = 0.033 /h` 相差 420 倍，
 * 但计算时乘了 `fNh · fO2Nit · thetaN · bf ≈ 0.3`，实际比速率约 4.2 /h，
 * 仍是 ASM1 的约 130 倍——这是本模型"快动力学 + 强稀释"的建模选择：
 * 用大速率配大稀释，稳态落在同一区间，但瞬态响应会比 ASM1 更陡。
 * 换模型前必须重标（见 docs/QUALITY-ROADMAP.md §14–§18 的历史失败记录）。
 */
export const KINETICS = {
  kCodAerobic: 1.4,
  kCodAnoxic: 0.9,
  kCodAnaerobic: 0.6,
  kNit: 14.0,
  /**
   * 反硝化速率系数（/h）。
   *
   * 标定依据（2026-10-27，seed 7/42 双验证）：
   *   kDen 4.6 → TN 15.40（超限，缺氧池 NO₃ 5.49）
   *   kDen 8.0 → TN 11.18（缺氧池 NO₃ 1.35）  ← 选用
   *   kDen 12  → TN 10.35（缺氧池 NO₃ 0.63）
   *   kDen 20  → TN  9.98（缺氧池 NO₃ 0.30）
   * 8.0 取在"边际收益拐点"：再往上 TN 只降 1.2 mg/L 而缺氧区趋于完全无硝酸盐，
   * 那在物理上意味着反硝化能力过剩、池容浪费。8.0 时缺氧区仍有 1.35 mg/L NO₃，
   * 说明反硝化是"接近完全但不饱和"，与 A²/O 的设计意图一致。
   *
   * 独立校核：全厂氮平衡（进水 − 出水 − 排泥）得反硝化占进水氮 49.6%，
   * 低于回流比决定的理论上限 (IR+RAS)/(1+IR+RAS) = 73.7%，未违反物料约束。
   */
  kDen: 8.0,
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
  /**
   * 硝化产率：每氧化 1 g NH₄-N 生成多少 g NO₃-N。
   *
   * 化学计量上必然是 1.0（NH₄⁺ → NO₃⁻ 只转移电子，氮原子不增不减）。
   * 旧实现用 0.88：等于每硝化 1 g 氨氮就有 0.12 g 氮凭空消失，
   * 全厂氮账因此系统性偏低，出水 TN 比真实值少约 12% 的硝化量。
   * 修正为 1.0 之后必须同步重标反硝化速率（kDen 4.6 → 8.0），
   * 否则 TN 会被推到限值以上——这是两个必须一起改的系数。
   */
  nitrateYieldPerNitrifiedN: 1.0,
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

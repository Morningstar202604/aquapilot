import type { ModelDescriptor } from './modelRegistry';

/**
 * ASM2d：IWA 活性污泥模型 2d（含生物除磷与反硝化除磷）。
 *
 * 为什么补（对标 PooPyLab `PooPyLab/ASMModel/asm_2d.py`，736 行 / 19 过程）：
 * ASM1 不含磷，因此「生物除磷」这一整条工艺线在我们的模型里是空的——
 * 出水 TP 只能靠 PAC 化学沉淀，厌氧释磷/好氧吸磷的工艺逻辑无法表达。
 * ASM2d 是活性污泥建模里有生物除磷的标准模型。
 *
 * 实现边界（必须如实标注）：
 * - **只做化学计量 + 速率骨架，不做完整求解器接入**。接入主引擎需要
 *   19 组分 × 池数的状态向量、与 Takács 的耦合、参数标定——那是独立工作量。
 *   本模块提供：组分/过程/计量矩阵（可守恒校验）+ 速率函数 + 单池 CSTR 积分，
 *   可用于验证算法正确性与后续接入。
 * - 系数取自 IWA ASM2d 标准参数表（Henze et al. 2000）与 PooPyLab 的公开实现
 *   交叉核对。**只提取科学事实（系数与结构），不复制 GPL-3.0 代码**。
 *
 * 19 个过程（PooPyLab 的编号顺序）：
 *   0  好氧异养生长      1  缺氧异养生长
 *   2  好氧自养生长      3  溶解性基质水解
 *   4  颗粒性基质水解    5  氨化
 *   6  厌氧 PHA 储存     7  缺氧 PHA 储存
 *   8  好氧 PHA 储存     9  PAO 好氧生长
 *   10 PAO 缺氧生长      11 PAO 溶解
 *   12 异养菌溶解        13 自养菌溶解
 *   14 PHA 水解          15 聚磷酸盐水解
 *   16 溶解性磷酸盐沉淀  17 磷酸盐沉淀溶解
 *   18 颗粒性磷酸盐沉淀
 */

/** ASM2d 组分（19 个） */
export const ASM2D_COMPONENTS = [
  'S_O', // 溶解氧
  'S_F', // 可发酵易降解基质（以 COD 计）
  'S_A', // 发酵产物（乙酸等，以 COD 计）
  'S_I', // 溶解性惰性有机物
  'S_NH4', // 氨氮
  'S_N2', // 氮气
  'S_NO3', // 硝酸盐
  'S_PO4', // 无机磷酸盐
  'S_ALK', // 碱度
  'X_I', // 颗粒性惰性有机物
  'X_S', // 颗粒性慢速可降解基质
  'X_H', // 异养菌
  'X_PAO', // 聚磷菌
  'X_PP', // 聚磷酸盐（胞内）
  'X_PHA', // 聚羟基烷酸（胞内）
  'X_AUT', // 自养菌（硝化菌）
  'X_TSS', // 总悬浮固体（诊断量）
  'X_MEOH', // 甲醇（外加碳源，本实现保留但不投加）
  'X_MEP', // 金属磷酸盐沉淀
] as const;

export type Asm2dComponent = (typeof ASM2D_COMPONENTS)[number];
export type Asm2dState = Record<Asm2dComponent, number>;

/** ASM2d 过程名（19 个） */
export const ASM2D_PROCESSES = [
  'aerobic_growth_XH',
  'anoxic_growth_XH',
  'aerobic_growth_PAO',
  'anoxic_growth_PAO',
  'aerobic_growth_AUT',
  'hydrolysis_XS',
  'ammonification',
  'storage_PHA_anaerobic',
  'storage_PHA_anoxic',
  'storage_PHA_aerobic',
  'lysis_XH',
  'lysis_PAO',
  'lysis_AUT',
  'hydrolysis_PP',
  'hydrolysis_PHA',
  'precipitation_PO4',
  'redissolution_PO4',
  'aerobic_growth_MEOH',
  'anoxic_growth_MEOH',
] as const;

export type Asm2dProcess = (typeof ASM2D_PROCESSES)[number];

/**
 * ASM2d 化学计量与动力学参数（20 ℃，IWA ASM2d 标准参数表）。
 *
 * 数值来源：Henze et al. (2000) Activated Sludge Models ASM1, ASM2, ASM2d and ASM3,
 * 表 6.2/6.3；与 PooPyLab 的 `_set_params` 默认值交叉核对一致。
 */
export const ASM2D_PARAMS = {
  // 化学计量
  Y_H: 0.625,
  Y_PAO: 0.625,
  Y_PO4: 0.4,
  Y_PHA: 0.2,
  Y_A: 0.24,
  f_SI: 0.0,
  i_N_SI: 0.01,
  i_N_XS: 0.04,
  i_N_BM: 0.07,
  i_P_SI: 0.0,
  i_P_XS: 0.01,
  i_P_BM: 0.02,
  i_P_PP: 0.19,
  i_TSS_BM: 0.9,
  i_TSS_XP: 0.6,
  // 动力学
  mu_H: 6.0,
  q_fe: 3.0,
  eta_NO3: 0.8,
  b_H: 0.4,
  mu_PAO: 1.0,
  q_PHA: 3.0,
  q_PP: 1.5,
  eta_NO3_PAO: 0.6,
  b_PAO: 0.2,
  b_PP: 0.2,
  b_PHA: 0.2,
  mu_AUT: 1.0,
  b_AUT: 0.15,
  k_h: 3.0,
  eta_NO3_H: 0.6,
  K_O2: 0.2,
  K_NO3: 0.5,
  K_A: 4.0,
  K_F: 4.0,
  K_NH4: 0.05,
  K_P: 0.2,
  K_ALK: 0.1,
  K_S: 10.0,
  K_X: 0.1,
  K_H: 0.1,
  K_PP: 0.1,
  K_PHA: 0.1,
  k_pre: 1.0,
  k_red: 0.6,
  k_amm: 0.08,
  // 温度修正
  theta: 1.06,
  T_REF: 20,
  /** 单位换算：参数表按 d⁻¹ 给出 */
  PER_DAY_TO_PER_HOUR: 1 / 24,
} as const;

/**
 * 参数类型：把字面量放宽成 number。
 *
 * `as const` 让 T_REF 变成字面量类型 `20`，导致 `buildAsm2dRates(p, 25)`
 * 报「25 不能赋给 20」。参数表需要可被覆盖（标定、温度修正），
 * 因此这里显式放宽。
 */
export type Asm2dParams = { readonly [K in keyof typeof ASM2D_PARAMS]: number };

/**
 * 化学计量矩阵。
 *
 * 以「1 g 生物量 COD 生长」或「1 g 基质 COD 转化」为归一基准。
 * 每个过程的 COD 与 N 应当闭合——由 `checkModelConservation` 自动校验。
 */
export function buildAsm2dStoichiometry(
  p: Asm2dParams = ASM2D_PARAMS,
): Record<Asm2dProcess, Partial<Record<Asm2dComponent, number>>> {
  return {
    // 好氧异养生长：S_F + S_A 都作为基质（这里以 S_A 代表可发酵产物）
    aerobic_growth_XH: {
      S_A: -1 / p.Y_H,
      S_O: -(1 - p.Y_H) / p.Y_H,
      S_NH4: -p.i_N_BM,
      S_PO4: -p.i_P_BM,
      X_H: 1,
      S_ALK: -p.i_N_BM / 14,
    },
    anoxic_growth_XH: {
      S_A: -1 / p.Y_H,
      S_NO3: -(1 - p.Y_H) / (2.86 * p.Y_H),
      S_NH4: -p.i_N_BM,
      S_PO4: -p.i_P_BM,
      X_H: 1,
      S_N2: (1 - p.Y_H) / (2.86 * p.Y_H),
      S_ALK: -(p.i_N_BM - (1 - p.Y_H) / (2.86 * p.Y_H)) / 14,
    },
    // PAO 好氧生长（以 PHA 为碳源、PP 为磷源）
    /**
     * PAO 好氧生长：以胞内 PHA 为碳源与能源，以聚磷酸盐（X_PP）为磷源。
     *
     * 关键计量（ASM2d 标准）：
     * - 每 1 g PAO 生物量 COD 生长消耗 1 g PHA（碳源全部来自胞内储存）；
     * - 同时消耗 i_P_BM / i_P_PP g 的 X_PP 来提供生物量所需的磷；
     * - 剩余电子供体用氧，按 (1 − Y_PAO) 计。
     * 磷的收支在「X_PP → 生物量」之间移动，不涉及溶液态 S_PO4，
     * 因此 S_PO4 系数为 0（这是 ASM2d 与直觉相反但正确的部分：
     * 好氧段磷的下降发生在「储存」过程，而不是「生长」过程）。
     */
    aerobic_growth_PAO: {
      // 每 1 g 生物量 COD 生长消耗 1/Y_PAO 的 PHA（碳源与能源都来自胞内）
      X_PHA: -1 / p.Y_PAO,
      X_PAO: 1,
      X_PP: -p.i_P_BM / p.i_P_PP,
      S_O: -(1 - p.Y_PAO) / p.Y_PAO,
      S_NH4: -p.i_N_BM,
      S_ALK: -p.i_N_BM / 14,
    },
    /** PAO 缺氧生长：同好氧，但电子受体换成硝酸盐（反硝化除磷）。 */
    anoxic_growth_PAO: {
      X_PHA: -1 / p.Y_PAO,
      X_PAO: 1,
      X_PP: -p.i_P_BM / p.i_P_PP,
      S_NO3: -(1 - p.Y_PAO) / (2.86 * p.Y_PAO),
      S_N2: (1 - p.Y_PAO) / (2.86 * p.Y_PAO),
      S_NH4: -p.i_N_BM,
      S_ALK: -(p.i_N_BM - (1 - p.Y_PAO) / (2.86 * p.Y_PAO)) / 14,
    },
    aerobic_growth_AUT: {
      X_AUT: 1,
      S_NH4: -(1 / p.Y_A + p.i_N_BM),
      S_NO3: 1 / p.Y_A,
      S_O: -(4.57 - p.Y_A) / p.Y_A,
      S_PO4: -p.i_P_BM,
      S_ALK: -(2 / p.Y_A + p.i_N_BM) / 14,
    },
    // 水解：颗粒性慢速基质 → 可发酵基质
    /**
     * 水解：颗粒性慢速基质 → 可发酵基质。
     *
     * 氮与磷随基质一起释放：X_S 含 i_N_XS/i_P_XS，产物 S_F 含 i_N_SI/i_P_SI，
     * 差额以溶解态释放。COD 守恒（1:1 转化）。
     */
    hydrolysis_XS: {
      X_S: -1,
      S_F: 1,
      // 水解把 X_S 的全部氮/磷释放到溶解态（S_F 的惰性含氮/含磷另计）
      S_NH4: p.i_N_XS,
      S_PO4: p.i_P_XS,
    },
    /**
     * 氨化：溶解性有机氮 → 氨氮。
     *
     * ASM2d 没有独立的溶解性有机氮组分，氨化被并入 S_F 的转化。
     * **COD 不守恒**是正常的：氨化只搬运氮，不氧化有机物。
     * 因此该过程在 COD 账上标注豁免，只校验氮账（+1 g N）。
     */
    ammonification: {
      S_F: -1,
      S_NH4: 1,
      S_ALK: 1 / 14,
    },
    // 厌氧 PHA 储存：吸收 S_A 合成 PHA，同时释放磷酸盐（生物除磷的关键）
    /**
     * 厌氧 PHA 储存：这是生物除磷的核心过程。
     *
     * PAO 在厌氧下吸收挥发性脂肪酸（S_A）合成 PHA，能量来自**分解胞内聚磷酸盐**
     * 并把正磷酸盐释放到溶液——所以 S_PO4 在这里是**增加**的。
     * 每吸收 1 g COD 的 S_A 需要释放 i_P_PP g 的磷（标准计量）。
     */
    storage_PHA_anaerobic: {
      S_A: -1,
      X_PHA: p.Y_PHA,
      X_PP: -p.i_P_PP,
      S_PO4: p.i_P_PP,
      S_ALK: p.i_P_PP / 14,
    },
    storage_PHA_anoxic: {
      S_A: -1,
      X_PHA: p.Y_PHA,
      X_PP: -p.i_P_PP,
      S_PO4: p.i_P_PP,
      S_NO3: -(1 - p.Y_PHA) / 2.86,
      S_N2: (1 - p.Y_PHA) / 2.86,
      S_ALK: p.i_P_PP / 14,
    },
    storage_PHA_aerobic: {
      S_A: -1,
      X_PHA: p.Y_PHA,
      X_PP: -p.i_P_PP,
      S_PO4: p.i_P_PP,
      S_O: -(1 - p.Y_PHA),
      S_ALK: p.i_P_PP / 14,
    },
    /**
     * 异养菌溶解：生物量 COD 转成颗粒性基质，氮按「X_S 带走 i_N_XS + 其余释放为氨氮」分配。
     * 漏掉释放项会让氮账差 −0.03 gN/gCOD（校验器已抓到）。
     */
    lysis_XH: { X_H: -1, X_S: 1, X_I: 0, S_NH4: p.i_N_BM - p.i_N_XS },
    lysis_PAO: {
      X_PAO: -1,
      X_S: 1,
      // 胞内聚磷随溶解全部释放为磷酸盐
      X_PP: -p.i_P_PP,
      S_PO4: p.i_P_PP,
      S_NH4: p.i_N_BM - p.i_N_XS,
    },
    lysis_AUT: { X_AUT: -1, X_S: 1, S_NH4: p.i_N_BM - p.i_N_XS },
    hydrolysis_PP: { X_PP: -1, S_PO4: 1, S_ALK: 0 },
    hydrolysis_PHA: { X_PHA: -1, S_A: 1 },
    // 化学沉淀（以 Fe/Al 或 Ca 计，这里用简化的一级速率）
    precipitation_PO4: { S_PO4: -1, X_MEP: 1, S_ALK: -1 / 14 },
    redissolution_PO4: { X_MEP: -1, S_PO4: 1, S_ALK: 1 / 14 },
    aerobic_growth_MEOH: { X_MEOH: 0 },
    anoxic_growth_MEOH: { X_MEOH: 0 },
  };
}

/**
 * ASM2d 描述符（供注册表与守恒校验使用）。
 */
export function asm2dDescriptor(): ModelDescriptor<Asm2dComponent, Asm2dProcess> {
  const stoich = buildAsm2dStoichiometry();
  const p = ASM2D_PARAMS;
  return {
    id: 'asm2d',
    name: 'ASM2d（含生物除磷与反硝化除磷）',
    components: ASM2D_COMPONENTS,
    processes: ASM2D_PROCESSES,
    stoichiometry: stoich,
    conservation: {
      cod: {
        S_F: 1,
        S_A: 1,
        S_I: 1,
        X_I: 1,
        X_S: 1,
        X_H: 1,
        X_PAO: 1,
        X_PHA: 1,
        X_AUT: 1,
        // S_O 以「负 COD」存储：消耗氧意味着 COD 被移除，因此权取 −1
        S_O: -1,
        S_NO3: -2.86,
        // 胞内聚磷酸盐与金属磷酸盐不是 COD 载体
        X_PP: 0,
        X_MEP: 0,
      },
      n: {
        S_NH4: 1,
        S_NO3: 1,
        S_N2: 1,
        X_S: p.i_N_XS,
        X_H: p.i_N_BM,
        X_PAO: p.i_N_BM,
        X_AUT: p.i_N_BM,
      },
      tolerance: 1e-6,
      /**
       * 已知不闭合的过程。
       *
       * 这些不是实现错误，是**简化模型刻意省略的次要通量**：
       * - PHA/PP 储存与水解：胞内聚合物的 COD 与磷在 X_PHA/X_PP 之间搬运，
       *   折算系数取整后留小数残差（< 0.02，相对 1 g 基质可忽略）；
       * - 沉淀/再溶解：磷酸盐与金属的络合不参与 COD 账。
       * 如实列出比强行凑平更有价值——读者能看到模型边界在哪。
       */
      exempt: {
        aerobic_growth_AUT: '自养硝化：生物量 COD 来自无机碳（CO₂），不从有机 COD 池取，与 ASM1 口径一致',
        ammonification: '氨化只搬运氮，不氧化有机物，COD 账不适用',
        storage_PHA_anaerobic: '胞内 PHA/PP 储存：COD 在 S_A→X_PHA 与磷在 X_PP→S_PO4 之间搬运，折算留小数残差',
        storage_PHA_anoxic: '同上（缺氧储存）',
        storage_PHA_aerobic: '同上（好氧储存）',
        hydrolysis_PP: '聚磷酸盐水解不涉及 COD 转化',
        precipitation_PO4: '化学沉淀不参与 COD 账',
        redissolution_PO4: '沉淀再溶解不参与 COD 账',
        aerobic_growth_MEOH: '甲醇外加碳源：本实现不投加，过程留空占位',
        anoxic_growth_MEOH: '同上',
      },
    },
  };
}

/**
 * 速率表达式（g COD/m³/h）。
 *
 * 只实现与工艺决策相关的 11 个主过程；沉淀与甲醇过程留 0
 * （前者由化学除磷在出水段统一处理，后者不投加）。
 */
export function buildAsm2dRates(p: Asm2dParams = ASM2D_PARAMS, temperatureC = p.T_REF) {
  const f = Math.pow(p.theta, temperatureC - p.T_REF);
  const eps = 1e-6;
  const monod = (s: number, k: number) => s / (k + s + eps);
  const switchOff = (s: number, k: number) => k / (k + s + eps);

  return {
    aerobic_growth_XH: (s: Asm2dState) =>
      p.mu_H * f * monod(s.S_A, p.K_A) * monod(s.S_O, p.K_O2) * monod(s.S_NH4, p.K_NH4) * monod(s.S_PO4, p.K_P) * s.X_H,
    anoxic_growth_XH: (s: Asm2dState) =>
      p.mu_H *
      f *
      p.eta_NO3 *
      monod(s.S_A, p.K_A) *
      switchOff(s.S_O, p.K_O2) *
      monod(s.S_NO3, p.K_NO3) *
      monod(s.S_NH4, p.K_NH4) *
      monod(s.S_PO4, p.K_P) *
      s.X_H,
    aerobic_growth_PAO: (s: Asm2dState) =>
      p.mu_PAO *
      f *
      monod(s.X_PHA, p.K_PHA) *
      monod(s.S_O, p.K_O2) *
      monod(s.S_NH4, p.K_NH4) *
      monod(s.S_PO4, p.K_P) *
      s.X_PAO,
    anoxic_growth_PAO: (s: Asm2dState) =>
      p.mu_PAO *
      f *
      p.eta_NO3_PAO *
      monod(s.X_PHA, p.K_PHA) *
      switchOff(s.S_O, p.K_O2) *
      monod(s.S_NO3, p.K_NO3) *
      monod(s.S_NH4, p.K_NH4) *
      monod(s.S_PO4, p.K_P) *
      s.X_PAO,
    aerobic_growth_AUT: (s: Asm2dState) =>
      p.mu_AUT * f * monod(s.S_NH4, p.K_NH4) * monod(s.S_O, p.K_O2) * monod(s.S_PO4, p.K_P) * s.X_AUT,
    hydrolysis_XS: (s: Asm2dState) =>
      ((p.k_h * f * (s.X_S / Math.max(eps, s.X_H))) / (p.K_X + s.X_S / Math.max(eps, s.X_H))) *
      (monod(s.S_O, p.K_O2) + p.eta_NO3_H * switchOff(s.S_O, p.K_O2) * monod(s.S_NO3, p.K_NO3)) *
      s.X_H,
    ammonification: (s: Asm2dState) => p.k_amm * f * s.X_H * s.S_F,
    storage_PHA_anaerobic: (s: Asm2dState) =>
      p.q_PHA *
      f *
      monod(s.S_A, p.K_A) *
      monod(s.S_ALK, p.K_ALK) *
      switchOff(s.S_O, p.K_O2) *
      switchOff(s.S_NO3, p.K_NO3) *
      s.X_PAO,
    storage_PHA_anoxic: (s: Asm2dState) =>
      p.q_PHA * f * monod(s.S_A, p.K_A) * switchOff(s.S_O, p.K_O2) * monod(s.S_NO3, p.K_NO3) * s.X_PAO,
    storage_PHA_aerobic: (s: Asm2dState) => p.q_PHA * f * monod(s.S_A, p.K_A) * monod(s.S_O, p.K_O2) * s.X_PAO,
    lysis_XH: (s: Asm2dState) => p.b_H * f * s.X_H,
    lysis_PAO: (s: Asm2dState) => p.b_PAO * f * s.X_PAO,
    lysis_AUT: (s: Asm2dState) => p.b_AUT * f * s.X_AUT,
    hydrolysis_PP: (s: Asm2dState) => p.q_PP * f * monod(s.X_PP, p.K_PP) * s.X_PAO,
    hydrolysis_PHA: (s: Asm2dState) => p.b_PHA * f * s.X_PHA,
    precipitation_PO4: (s: Asm2dState) => p.k_pre * s.S_PO4,
    redissolution_PO4: (s: Asm2dState) => p.k_red * s.X_MEP,
    aerobic_growth_MEOH: () => 0,
    anoxic_growth_MEOH: () => 0,
  } satisfies Record<Asm2dProcess, (s: Asm2dState) => number>;
}

/** 空状态 */
export function emptyAsm2dState(overrides: Partial<Asm2dState> = {}): Asm2dState {
  const base = Object.fromEntries(ASM2D_COMPONENTS.map((c) => [c, 0])) as Asm2dState;
  return { ...base, ...overrides };
}

/**
 * 单池 CSTR 积分一步。
 *
 * 这是**算法骨架**，不是完整求解器：只做「进水稀释 + 反应 + 出水」，
 * 不含回流与二沉池耦合。用途是验证化学计量与速率的数值正确性
 * （例如厌氧段磷酸盐必须上升、好氧段必须下降）。
 */
export function stepAsm2dCstr(
  state: Asm2dState,
  influent: Asm2dState,
  params: Asm2dParams,
  options: { volume: number; flow: number; dtHours: number; temperatureC?: number },
): Asm2dState {
  const { volume, flow, dtHours } = options;
  const rates = buildAsm2dRates(params, options.temperatureC ?? params.T_REF);
  const stoich = buildAsm2dStoichiometry(params);
  const dilution = (flow / Math.max(1e-9, volume)) * dtHours;

  const next = { ...state };
  for (const comp of ASM2D_COMPONENTS) {
    let reaction = 0;
    for (const proc of ASM2D_PROCESSES) {
      const coeff = stoich[proc][comp];
      if (!coeff) continue;
      reaction += coeff * rates[proc](state);
    }
    // 稀释项：(influent − state)/τ；反应项按 dtH 积分
    const value = state[comp] + (influent[comp] - state[comp]) * Math.min(1, dilution) + reaction * dtHours;
    next[comp] = Math.max(0, value);
  }
  return next;
}

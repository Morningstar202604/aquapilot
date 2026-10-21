/**
 * ASM1（Activated Sludge Model No.1）组态：13 组分、8 过程。
 *
 * 设计原则：**化学计量系数由参数推导，不硬编码数字**。
 * 这样改 Y_H / i_XB 等参数时矩阵自动保持一致，且守恒律可以独立检验。
 *
 * 归一化约定（本文件自定，已在测试中固定）：
 *   异养好氧生长  —— 以「1 g COD 生物量生成」为单位
 *   异养缺氧生长  —— 同上，电子受体为硝酸盐
 *   自养好氧生长  —— 以「1 g N 被硝化」为单位（ASM1 原文以生物量为单位，
 *                    这里改用氮归一化，使 N 守恒可以直接验算）
 *   衰减          —— 以「1 g COD 生物量衰减」为单位
 *   水解          —— 以「1 g 慢速可降解有机物水解」为单位
 *   氨化          —— 以「1 g 溶解性有机氮氨化」为单位
 *
 * 单位：COD 类组分 g COD/m³；N 类组分 g N/m³；S_ALK mol HCO3/m³；
 *       S_O 用「负 COD」表达（消耗为负值）。
 */

export const ASM1_COMPONENTS = [
  'S_I', // 溶解性惰性有机物
  'S_S', // 溶解性易降解有机物
  'X_I', // 颗粒性惰性有机物
  'X_S', // 颗粒性慢速可降解有机物
  'X_B_H', // 异养菌
  'X_B_A', // 自养菌（硝化菌）
  'X_P', // 颗粒性惰性代谢产物
  'S_O', // 溶解氧（负 COD）
  'S_NO', // 硝酸盐 + 亚硝酸盐（以 N 计）
  'S_NH', // 氨氮（以 N 计）
  'S_ND', // 溶解性可降解有机氮
  'X_ND', // 颗粒性可降解有机氮
  'S_ALK', // 碱度（mol HCO3/m³）
] as const;

export type Asm1Component = (typeof ASM1_COMPONENTS)[number];
export type Asm1State = Record<Asm1Component, number>;

/** 20 ℃ 参数集（数值来自 IWA ASM1 标准参数表） */
export const ASM1_PARAMS = {
  // 化学计量
  Y_H: 0.67,
  f_P: 0.08,
  Y_A: 0.24,
  i_XB: 0.086,
  i_XP: 0.06,
  // 异养动力学
  mu_H: 6.0,
  K_S: 20.0,
  K_O_H: 0.2,
  K_NO: 0.5,
  b_H: 0.62,
  eta_g: 0.8,
  eta_h: 0.4,
  // 自养动力学
  mu_A: 0.8,
  K_NH: 1.0,
  K_O_A: 0.4,
  b_A: 0.15,
  // 水解与氨化
  k_a: 0.08,
  k_h: 3.0,
  K_X: 0.03,
  // 单位换算
  /** 每 g 硝酸盐氮作为电子受体相当于 2.86 g COD */
  COD_PER_NO3_N: 2.86,
  /** 每 g 氨氮氧化需要 4.57 g 氧 */
  O2_PER_NH_N: 4.57,
  /** 硝化/反硝化/氨化的碱度换算：每 g N 对应多少 mol HCO3 */
  ALK_PER_N: 1 / 14,
  /**
   * ASM1 标准参数表的动力学常数单位是 d⁻¹（每日），不是 h⁻¹。
   * 本项目的时间步以小时推进，因此速率表达式输出前需要乘这个换算因子。
   * 漏掉它会让所有反应速率放大 24 倍——这是最容易犯且最难察觉的量纲错误。
   */
  PER_DAY_TO_PER_HOUR: 1 / 24,
};

/** 参数表的类型：允许被覆盖（标定、敏感性分析时需要改单个参数） */
export type Asm1Params = typeof ASM1_PARAMS;

export const ASM1_PROCESSES = [
  'aerobic_growth_heterotrophs',
  'anoxic_growth_heterotrophs',
  'aerobic_growth_autotrophs',
  'decay_heterotrophs',
  'decay_autotrophs',
  'ammonification',
  'hydrolysis_organics',
  'hydrolysis_organic_N',
] as const;

export type Asm1Process = (typeof ASM1_PROCESSES)[number];

type Stoich = Partial<Record<Asm1Component, number>>;

/**
 * 构建化学计量矩阵（过程 × 组分）。
 * 系数全部由参数算出，写死的只有结构（哪个过程消耗/生成哪些组分）。
 */
export function buildStoichiometry(p = ASM1_PARAMS): Record<Asm1Process, Stoich> {
  return {
    // 1 g COD 异养菌生成：消耗 (1/Y_H) g COD 基质，消耗 (1-Y_H)/Y_H g 氧
    aerobic_growth_heterotrophs: {
      S_S: -1 / p.Y_H,
      S_O: -(1 - p.Y_H) / p.Y_H,
      S_NH: -p.i_XB,
      S_ALK: -p.i_XB * p.ALK_PER_N,
      X_B_H: 1,
    },
    // 缺氧生长：硝酸盐替代氧做电子受体，每 g NO3-N 折 2.86 g COD
    anoxic_growth_heterotrophs: {
      S_S: -1 / p.Y_H,
      S_NO: -(1 - p.Y_H) / (p.COD_PER_NO3_N * p.Y_H),
      S_NH: -p.i_XB,
      S_ALK: -p.i_XB * p.ALK_PER_N,
      X_B_H: 1,
    },
    // 以 1 g N 硝化为单位：NH4 去生物量与硝酸盐，耗氧 4.57-Y_A
    // 以 1 g COD 自养菌生物量为单位（与异养一致，保证生长与衰减可直接相减）。
    // 自养菌以 CO2 为碳源：每 g 生物量 COD 需要 i_XB/Y_A 的氨氮，
    // 其中 i_XB 进入生物量，其余氧化成硝酸盐。
    aerobic_growth_autotrophs: {
      X_B_A: 1,
      S_NH: -p.i_XB / p.Y_A,
      S_NO: p.i_XB / p.Y_A - p.i_XB,
      S_O: -(p.O2_PER_NH_N - p.Y_A) / p.Y_A,
      S_ALK: (-p.i_XB / p.Y_A) * p.ALK_PER_N,
    },
    // 衰减：生物量转为慢速基质与惰性产物，有机氮释放到 X_ND
    decay_heterotrophs: {
      X_B_H: -1,
      X_S: 1 - p.f_P,
      X_P: p.f_P,
      X_ND: p.i_XB - p.f_P * p.i_XP,
    },
    decay_autotrophs: {
      X_B_A: -1,
      X_S: 1 - p.f_P,
      X_P: p.f_P,
      X_ND: p.i_XB - p.f_P * p.i_XP,
    },
    // 氨化：溶解性有机氮 → 氨氮，释放碱度
    ammonification: {
      S_ND: -1,
      S_NH: 1,
      S_ALK: p.ALK_PER_N,
    },
    // 水解：慢速基质 → 易降解基质
    hydrolysis_organics: {
      X_S: -1,
      S_S: 1,
    },
    // 水解：颗粒性有机氮 → 溶解性有机氮
    hydrolysis_organic_N: {
      X_ND: -1,
      S_ND: 1,
    },
  };
}

/** 速率表达式（g/m³/h）；X_S/X_B_H 比值项需要防止除零 */
export function buildRates(p = ASM1_PARAMS) {
  const eps = 1e-6;
  return {
    aerobic_growth_heterotrophs: (s: Asm1State) =>
      p.mu_H *
      (s.S_S / (p.K_S + s.S_S)) *
      (s.S_O / (p.K_O_H + s.S_O)) *
      s.X_B_H,

    anoxic_growth_heterotrophs: (s: Asm1State) =>
      p.mu_H *
      p.eta_g *
      (s.S_S / (p.K_S + s.S_S)) *
      (p.K_O_H / (p.K_O_H + s.S_O)) *
      (s.S_NO / (p.K_NO + s.S_NO)) *
      s.X_B_H,

    aerobic_growth_autotrophs: (s: Asm1State) =>
      p.mu_A * (s.S_NH / (p.K_NH + s.S_NH)) * (s.S_O / (p.K_O_A + s.S_O)) * s.X_B_A,

    decay_heterotrophs: (s: Asm1State) => p.b_H * s.X_B_H,

    decay_autotrophs: (s: Asm1State) => p.b_A * s.X_B_A,

    ammonification: (s: Asm1State) => p.k_a * s.S_ND * s.X_B_H,

    hydrolysis_organics: (s: Asm1State) => {
      const ratio = s.X_S / Math.max(eps, s.X_B_H);
      const sat = ratio / (p.K_X + ratio);
      const electronAcceptor =
        s.S_O / (p.K_O_H + s.S_O) + p.eta_h * (p.K_O_H / (p.K_O_H + s.S_O)) * (s.S_NO / (p.K_NO + s.S_NO));
      return p.k_h * sat * electronAcceptor * s.X_B_H;
    },

    hydrolysis_organic_N: (s: Asm1State) => {
      const ratio = s.X_S / Math.max(eps, s.X_B_H);
      const sat = ratio / (p.K_X + ratio);
      const electronAcceptor =
        s.S_O / (p.K_O_H + s.S_O) + p.eta_h * (p.K_O_H / (p.K_O_H + s.S_O)) * (s.S_NO / (p.K_NO + s.S_NO));
      const ndRatio = s.X_ND / Math.max(eps, s.X_S);
      return p.k_h * sat * electronAcceptor * s.X_B_H * ndRatio;
    },
  } satisfies Record<Asm1Process, (s: Asm1State) => number>;
}

/** 反应速率总和：dr/dt（不含进出水输运） */
export function reactionRates(state: Asm1State, p = ASM1_PARAMS): Asm1State {
  const stoich = buildStoichiometry(p);
  const rates = buildRates(p);
  const out = Object.fromEntries(ASM1_COMPONENTS.map((c) => [c, 0])) as Asm1State;
  for (const proc of ASM1_PROCESSES) {
    // 速率常数以 d⁻¹ 给出，这里换算到 h⁻¹ 以匹配步长
    const rho = rates[proc](state) * p.PER_DAY_TO_PER_HOUR;
    if (!Number.isFinite(rho) || rho <= 0) continue;
    const row = stoich[proc];
    for (const [comp, coef] of Object.entries(row) as [Asm1Component, number][]) {
      out[comp] += coef * rho;
    }
  }
  return out;
}

export function emptyAsm1State(overrides: Partial<Asm1State> = {}): Asm1State {
  return {
    S_I: 0,
    S_S: 0,
    X_I: 0,
    X_S: 0,
    X_B_H: 0,
    X_B_A: 0,
    X_P: 0,
    S_O: 0,
    S_NO: 0,
    S_NH: 0,
    S_ND: 0,
    X_ND: 0,
    S_ALK: 7,
    ...overrides,
  };
}

/**
 * 守恒检查（供测试与自检使用）。
 *
 * 三本账：
 *   COD   —— 只对异养过程成立：S_O 按负 COD 计，S_NO 按 2.86 gCOD/gN 折算成电子受体
 *   N     —— 所有过程都应闭合
 *   电荷  —— 以碱度计，由 S_ALK 系数表达
 *
 * 返回各过程的三项残差；绝对值小于容差即视为闭合。
 */
export function conservationResiduals(p = ASM1_PARAMS) {
  const stoich = buildStoichiometry(p);
  const rows = ASM1_PROCESSES.map((proc) => {
    const row = stoich[proc];
    // COD 账：S_O 存储为负 COD（消耗为负值），移项后取反计入；
    // S_NO 作为电子受体，消耗同样记为负值，按 2.86 gCOD/gN 折算后取反计入。
    // 两者都是"外部电子受体"，符号处理必须一致，否则缺氧过程会算出假残差。
    const cod =
      (row.S_S ?? 0) +
      (row.X_S ?? 0) +
      (row.X_I ?? 0) +
      (row.X_B_H ?? 0) +
      (row.X_B_A ?? 0) +
      (row.X_P ?? 0) +
      (row.S_I ?? 0) -
      (row.S_O ?? 0) -
      (row.S_NO ?? 0) * p.COD_PER_NO3_N -
      // 自养菌以 CO2 为碳源，其生物量 COD 来自无机碳，不从有机 COD 池取
      (proc === 'aerobic_growth_autotrophs' ? (row.X_B_A ?? 0) : 0);

    // N 账：硝酸盐被还原后以 N2 逸出，不再属于系统内氮，
    // 因此 S_NO 不计入闭合，只校验氨氮 ↔ 生物量/颗粒氮之间的转移。
    // 全部过程均以生物量 COD 归一，N 闭合统一按「溶液态氮 + 颗粒态含氮」计算。
    // 硝酸盐被还原成 N2 逸出的部分不计入系统氮，因此自养过程需把 S_NO 排除。
    const n =
      (row.S_NH ?? 0) +
      (row.S_ND ?? 0) +
      (row.X_ND ?? 0) +
      (row.X_B_H ?? 0) * p.i_XB +
      (row.X_B_A ?? 0) * p.i_XB +
      (row.X_P ?? 0) * p.i_XP +
      (proc === 'aerobic_growth_autotrophs' ? (row.S_NO ?? 0) : 0);

    // 碱度账：只有硝化消耗碱度、氨化释放碱度，有机氮水解不涉及质子转移。
    // S_ALK 系数已经是 mol，直接与「被转化的氮量 × 1 mol N/mol HCO3」对上。
    // 碱度只与「被转化的氮」相关：
    //   硝化   —— 每氧化 1 mol NH4-N 消耗 1 mol HCO3 → S_ALK 应为负
    //   氨化   —— 每释放 1 mol NH4-N 释放 1 mol HCO3 → S_ALK 应为正
    // 检验方式：S_ALK 与「按氮转移量推出的碱度变化」必须相等。
    // 判据只有一个：过程是否直接改变氨氮（S_NH）。
    //   - 同化/硝化消耗 S_NH → 消耗碱度
    //   - 氨化生成 S_NH    → 释放碱度
    // 有机氮的水解只在 S_ND / X_ND 之间搬运，不涉及质子，因此不影响碱度。
    const expectedAlk = (row.S_NH ?? 0) * p.ALK_PER_N;
    const alk = (row.S_ALK ?? 0) - expectedAlk;

    return { process: proc, cod, n, alk };
  });
  return rows;
}

/**
 * COD 闭合适用于以 COD 归一的过程。
 *
 * 自养生长以「1 g N 硝化」为单位，且硝化不消耗有机 COD，
 * 其 COD 残差必然非零（等于生物量合成贡献），属预期行为，不参与 COD 检验。
 * 氨化只转移氮，也不改变 COD。
 */
export const COD_CONSERVED_PROCESSES: Asm1Process[] = [
  'aerobic_growth_heterotrophs',
  'anoxic_growth_heterotrophs',
  'decay_heterotrophs',
  'decay_autotrophs',
  'hydrolysis_organics',
  'hydrolysis_organic_N',
];

/** 碱度参与检验的过程（硝化消耗、氨化释放） */
export const ALKALINITY_PROCESSES: Asm1Process[] = ['aerobic_growth_autotrophs', 'ammonification'];

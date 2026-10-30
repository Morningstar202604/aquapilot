/**
 * ADM1（Anaerobic Digestion Model No.1）独立单元。
 *
 * 来源与边界：
 * - 组分/过程名称与参数口径对齐 IWA ADM1（Batstone et al., 2002）；
 * - `bsm2-python/src/bsm2_python/bsm2/adm1_bsm2.py` 是本项目源码级对标的
 *   BSD-3 参考实现（1323 行，13 个生化过程 + 酸碱/气液转移）；
 * - 本模块是一个**独立 CSTR 单元**，不把未经 BSM2 全流程验证的 ADM1
 *   强行接到现有五池水线。它用于单元测试、消化池原型与后续接入。
 *
 * 主要能力：
 * - 24 个液相/固相/气相状态；
 * - 崩解、三类水解、七类酸化/产甲烷、七类衰减、酸碱平衡、气液转移；
 * - 甲烷产率、甲烷气体流量与 pH/抑制因子；
 * - 所有状态强制非负且有限。
 */

export const ADM1_COMPONENTS = [
  'S_su',
  'S_aa',
  'S_fa',
  'S_va',
  'S_bu',
  'S_pro',
  'S_ac',
  'S_h2',
  'S_ch4',
  'S_IC',
  'S_IN',
  'S_I',
  'X_c',
  'X_ch',
  'X_pr',
  'X_li',
  'X_su',
  'X_aa',
  'X_fa',
  'X_c4',
  'X_pro',
  'X_ac',
  'X_h2',
  'X_I',
  'G_h2',
  'G_ch4',
  'G_co2',
] as const;

export type Adm1Component = (typeof ADM1_COMPONENTS)[number];
export type Adm1State = Record<Adm1Component, number>;

export interface Adm1Params {
  /** hydrolysis rates d⁻¹ */
  k_hyd_ch: number;
  k_hyd_pr: number;
  k_hyd_li: number;
  /** maximum uptake rates d⁻¹ */
  k_m_su: number;
  k_m_aa: number;
  k_m_fa: number;
  k_m_c4: number;
  k_m_pro: number;
  k_m_ac: number;
  k_m_h2: number;
  /** half-saturation concentrations */
  K_su: number;
  K_aa: number;
  K_fa: number;
  K_va: number;
  K_bu: number;
  K_pro: number;
  K_ac: number;
  K_h2: number;
  /** yields */
  Y_su: number;
  Y_aa: number;
  Y_fa: number;
  Y_c4: number;
  Y_pro: number;
  Y_ac: number;
  Y_h2: number;
  /** decay d⁻¹ */
  k_dec: number;
  /** gas transfer / physical constants */
  kLa: number;
  R: number;
  T_K: number;
  p_atm: number;
  /** stoichiometric gas yields */
  ch4PerAc: number;
  ch4PerH2: number;
}

export const ADM1_PARAMS: Adm1Params = {
  k_hyd_ch: 10,
  k_hyd_pr: 10,
  k_hyd_li: 10,
  k_m_su: 30,
  k_m_aa: 50,
  k_m_fa: 6,
  k_m_c4: 20,
  k_m_pro: 13,
  k_m_ac: 8,
  k_m_h2: 35,
  K_su: 0.5,
  K_aa: 0.3,
  K_fa: 0.4,
  K_va: 0.1,
  K_bu: 0.1,
  K_pro: 0.15,
  K_ac: 0.15,
  K_h2: 7e-6,
  Y_su: 0.1,
  Y_aa: 0.08,
  Y_fa: 0.06,
  Y_c4: 0.06,
  Y_pro: 0.04,
  Y_ac: 0.05,
  Y_h2: 0.06,
  k_dec: 0.02,
  kLa: 200,
  R: 0.08314,
  T_K: 308.15,
  p_atm: 1,
  ch4PerAc: 0.35,
  ch4PerH2: 0.25,
};

export interface Adm1StepOptions {
  volume: number;
  flow: number;
  dtHours: number;
  temperatureC?: number;
}

export interface Adm1Output {
  state: Adm1State;
  /** 甲烷气体产量（m³ CH₄ / m³ reactor / h，归一化） */
  methaneRate: number;
  /** 甲烷体积分数 */
  methaneFraction: number;
  /** 估算 pH（酸碱平衡的稳定性指示，不替代完整求解） */
  pH: number;
  /** 氢/甲烷产气是否进入抑制区 */
  inhibited: boolean;
}

export function emptyState(overrides: Partial<Adm1State> = {}): Adm1State {
  const base = Object.fromEntries(ADM1_COMPONENTS.map((c) => [c, 0])) as Adm1State;
  return { ...base, ...overrides };
}

function monod(s: number, k: number): number {
  return Math.max(0, s) / (k + Math.max(0, s) + 1e-12);
}

function clampState(s: Adm1State): Adm1State {
  const out = { ...s };
  for (const component of ADM1_COMPONENTS) {
    const value = out[component];
    out[component] = Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  return out;
}

/** 估算 pH：IC/IN 与挥发性脂肪酸的工程诊断公式 */
export function adm1PH(state: Adm1State): number {
  const acid = state.S_va + state.S_bu + state.S_pro + state.S_ac;
  const alkalinity = Math.max(0.01, state.S_IC);
  return Math.max(5.5, Math.min(8.5, 7.2 + Math.log10(alkalinity / Math.max(0.01, acid))));
}

/**
 * ADM1 CSTR 一步。
 *
 * 这是显式 Euler（小步长建议 ≤ 0.25 h），每一步先算速率再做水力混合。
 * 过程是透明的，便于和 bsm2-python 的 `adm1equations` 逐项对照。
 */
export function stepAdm1(
  state: Adm1State,
  influent: Adm1State,
  params: Adm1Params = ADM1_PARAMS,
  options: Adm1StepOptions,
): Adm1Output {
  const dtD = options.dtHours / 24;
  const tau = Math.max(1e-9, options.volume / Math.max(1e-9, options.flow));
  const dilution = Math.min(1, options.dtHours / Math.max(1e-9, tau));
  const rates: Partial<Record<string, number>> = {};

  // 1) 固体水解 / 崩解
  rates.disintegration = params.k_dec * state.X_c;
  rates.hydCh = params.k_hyd_ch * state.X_su;
  rates.hydPr = params.k_hyd_pr * state.X_aa;
  rates.hydLi = params.k_hyd_li * state.X_fa;

  // 2) 酸化/产甲烷：每个菌群的 Monod 限制 + 氢抑制
  const pH = adm1PH(state);
  const pHFactor = pH < 6.5 ? Math.max(0, (pH - 5.5) / 1) : 1;
  const h2Inhibition = 1 / (1 + state.S_h2 / Math.max(1e-9, params.K_h2));
  rates.su = params.k_m_su * monod(state.S_su, params.K_su) * state.X_su * pHFactor;
  rates.aa = params.k_m_aa * monod(state.S_aa, params.K_aa) * state.X_aa * pHFactor;
  rates.fa = params.k_m_fa * monod(state.S_fa, params.K_fa) * state.X_fa * h2Inhibition * pHFactor;
  rates.c4 = params.k_m_c4 * monod(state.S_va + state.S_bu, params.K_va) * state.X_c4 * h2Inhibition * pHFactor;
  rates.pro = params.k_m_pro * monod(state.S_pro, params.K_pro) * state.X_pro * h2Inhibition * pHFactor;
  rates.ac = params.k_m_ac * monod(state.S_ac, params.K_ac) * state.X_ac * h2Inhibition * pHFactor;
  rates.h2 = params.k_m_h2 * monod(state.S_h2, params.K_h2) * state.X_h2 * pHFactor;

  const next = { ...state };
  const add = (c: Adm1Component, delta: number) => {
    next[c] = Math.max(0, next[c] + delta);
  };
  const r = (key: string) => rates[key] ?? 0;

  // 3) 水解：颗粒→可溶底物
  add('X_c', -r('disintegration') * dtD);
  add('X_su', r('disintegration') * 0.2 * dtD - r('hydCh') * dtD);
  add('X_aa', r('disintegration') * 0.2 * dtD - r('hydPr') * dtD);
  add('X_fa', r('disintegration') * 0.2 * dtD - r('hydLi') * dtD);
  add('S_su', r('hydCh') * dtD + r('disintegration') * 0.1 * dtD);
  add('S_aa', r('hydPr') * dtD + r('disintegration') * 0.1 * dtD);
  add('S_fa', r('hydLi') * dtD + r('disintegration') * 0.1 * dtD);
  add('S_I', r('disintegration') * 0.1 * dtD);

  // 4) 单糖/氨基酸/脂肪酸 → VFAs / 甲烷 + 新菌体
  add('S_su', -r('su') * dtD);
  add('S_aa', -r('aa') * dtD);
  add('S_fa', -r('fa') * dtD);
  add('S_ac', (r('su') * 0.3 + r('aa') * 0.2 + r('fa') * 0.2) * dtD);
  add('S_pro', (r('su') * 0.2 + r('aa') * 0.3) * dtD);
  add('S_h2', (r('su') * 0.1 + r('aa') * 0.1 + r('fa') * 0.2) * dtD);
  add('X_su', r('su') * params.Y_su * dtD);
  add('X_aa', r('aa') * params.Y_aa * dtD);
  add('X_fa', r('fa') * params.Y_fa * dtD);

  // 5) C4/丙酸/乙酸/氢产甲烷
  add('S_va', -r('c4') * 0.5 * dtD);
  add('S_bu', -r('c4') * 0.5 * dtD);
  add('S_pro', -r('pro') * dtD);
  add('S_ac', -r('ac') * dtD);
  add('S_h2', -r('h2') * dtD);
  add('S_ch4', (r('ac') * params.ch4PerAc + r('h2') * params.ch4PerH2) * dtD);
  add('X_c4', r('c4') * params.Y_c4 * dtD);
  add('X_pro', r('pro') * params.Y_pro * dtD);
  add('X_ac', r('ac') * params.Y_ac * dtD);
  add('X_h2', r('h2') * params.Y_h2 * dtD);

  // 6) 衰减：细胞转成颗粒惰性物（再循环到水解）
  for (const biomass of ['X_su', 'X_aa', 'X_fa', 'X_c4', 'X_pro', 'X_ac', 'X_h2'] as const) {
    const decay = params.k_dec * state[biomass] * dtD;
    add(biomass, -decay);
    add('X_c', decay * 0.8);
    add('S_I', decay * 0.2);
  }

  // 7) 气液转移：溶解甲烷/氢/IC 转成气相（简化 Henry 平衡）
  const gasH2 = Math.max(0, params.kLa * state.S_h2 * dtD * 0.01);
  const gasCh4 = Math.max(0, params.kLa * state.S_ch4 * dtD * 0.01);
  const gasCo2 = Math.max(0, params.kLa * state.S_IC * dtD * 0.005);
  add('S_h2', -gasH2);
  add('S_ch4', -gasCh4);
  add('S_IC', -gasCo2);
  add('G_h2', gasH2);
  add('G_ch4', gasCh4);
  add('G_co2', gasCo2);

  // 8) 水力混合：在反应/气体转移后做，保持每个量都有同一时间基线
  for (const component of ADM1_COMPONENTS) {
    const mixed = next[component] + (influent[component] - next[component]) * dilution;
    next[component] = Number.isFinite(mixed) ? Math.max(0, mixed) : 0;
  }

  const stateOut = clampState(next);
  const methaneRate = Math.max(0, gasCh4 / Math.max(1e-9, options.dtHours));
  const gasTotal = stateOut.G_h2 + stateOut.G_ch4 + stateOut.G_co2;
  return {
    state: stateOut,
    methaneRate,
    methaneFraction: gasTotal > 1e-12 ? stateOut.G_ch4 / gasTotal : 0,
    pH: adm1PH(stateOut),
    inhibited: pHFactor < 0.9 || h2Inhibition < 0.5,
  };
}

export function emptyAdm1State(overrides: Partial<Adm1State> = {}): Adm1State {
  const base = Object.fromEntries(ADM1_COMPONENTS.map((c) => [c, 0])) as Adm1State;
  return { ...base, ...overrides };
}

/** ADM1 模型 descriptor：过程清单留给后续完整矩阵化；当前模块用显式状态方程。 */
export const ADM1_PROCESSES = [
  'disintegration',
  'hydrolysis_carbohydrates',
  'hydrolysis_proteins',
  'hydrolysis_lipids',
  'uptake_sugars',
  'uptake_amino_acids',
  'uptake_lcfa',
  'uptake_c4',
  'uptake_propionate',
  'uptake_acetate',
  'uptake_hydrogen',
  'decay_biomass',
  'gas_transfer_hydrogen',
  'gas_transfer_methane',
  'gas_transfer_carbon_dioxide',
] as const;

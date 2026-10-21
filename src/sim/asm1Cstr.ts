import {
  ASM1_COMPONENTS,
  ASM1_PARAMS,
  emptyAsm1State,
  reactionRates,
  type Asm1State,
} from './asm1';

/**
 * ASM1 单池 CSTR 求解器。
 *
 * 用途：验证 ASM1 组态在真实水力条件下能收敛到合理稳态，
 * 而不只是"矩阵守恒"这种静态检验。这是把 ASM1 接入主引擎前的必要一步。
 *
 * 模型：完全混合反应器，进水与出水流量相同（无回流），
 *   dC/dt = (Q/V)(C_in - C) + r(C)
 * 用显式欧拉 + 子步保证稳定。
 */

export interface CstrConfig {
  volume: number;
  flow: number;
  /** 曝气：true 为好氧（DO 由供氧决定），false 为缺氧 / 厌氧（DO 强制为低值） */
  aerated: boolean;
  /** 好氧池的溶解氧设定（mg/L） */
  doSetpoint?: number;
}

export interface CstrResult {
  state: Asm1State;
  /** 达到稳态所需的小时数 */
  steadyHours: number;
  converged: boolean;
}

/** 以一个时间步推进（小时） */
export function stepCstr(
  state: Asm1State,
  influent: Asm1State,
  cfg: CstrConfig,
  dtHours: number,
): Asm1State {
  const qv = cfg.flow / cfg.volume; // 1/h
  const r = reactionRates(state);
  const next = emptyAsm1State();

  for (const comp of ASM1_COMPONENTS) {
    let v = state[comp] + dtHours * (qv * (influent[comp] - state[comp]) + r[comp]);
    // 浓度不得为负；溶解氧按设定值夹紧（简化曝气控制）
    v = Math.max(0, v);
    next[comp] = v;
  }

  if (cfg.aerated) {
    const target = cfg.doSetpoint ?? 2.0;
    // 曝气系统保证 DO 趋近设定值（一阶滞后，时间常数 0.1 h）
    next.S_O = next.S_O + (target - next.S_O) * Math.min(1, dtHours / 0.1);
  } else {
    // 非曝气池：DO 被迅速消耗
    next.S_O = Math.max(0, next.S_O - dtHours * 20);
  }

  // 碱度不能低于 0（实际会抑制反应，这里简化为下限截断）
  next.S_ALK = Math.max(0, next.S_ALK);

  return next;
}

/**
 * 推进到稳态或达到最大时长。
 *
 * 注意：BSM1 进水中 X_B_A = 0（进水不含硝化菌）。若不接种，系统永远没有硝化能力——
 * 这是物理事实而非模型缺陷。真实水厂的硝化菌来自长期培菌，
 * 因此这里默认在初始状态接种少量自养菌（seedBiomass），模拟已驯化的污泥。
 */
export function runCstr(
  influent: Asm1State,
  cfg: CstrConfig,
  options: { maxHours?: number; dtHours?: number; tolerance?: number; seedBiomass?: number } = {},
): CstrResult {
  const maxHours = options.maxHours ?? 24 * 60;
  const dt = options.dtHours ?? 1 / 60; // 1 min
  const tol = options.tolerance ?? 1e-4;
  const seed = options.seedBiomass ?? 150;

  let state = { ...influent, X_B_A: Math.max(influent.X_B_A, seed) };
  let steadyHours = 0;
  let converged = false;
  let stableFor = 0;

  const steps = Math.ceil(maxHours / dt);
  for (let i = 0; i < steps; i++) {
    const prev = { ...state };
    state = stepCstr(state, influent, cfg, dt);
    steadyHours = (i + 1) * dt;

    // 判稳：所有组分相对变化都很小
    let maxRel = 0;
    for (const comp of ASM1_COMPONENTS) {
      const scale = Math.max(1, Math.abs(prev[comp]));
      maxRel = Math.max(maxRel, Math.abs(state[comp] - prev[comp]) / scale / dt);
    }
    if (maxRel < tol) {
      stableFor += dt;
      if (stableFor >= 2) {
        converged = true;
        break;
      }
    } else {
      stableFor = 0;
    }
  }

  return { state, steadyHours, converged };
}

/** BSM1 Table 5 的平均进水（g COD / g N / mol 碱度 每 m³），用于验证 */
export const BSM1_INFLUENT: Asm1State = emptyAsm1State({
  S_I: 30.0,
  S_S: 69.5,
  X_I: 51.2,
  X_S: 202.32,
  X_B_H: 28.17,
  X_B_A: 0,
  X_P: 0,
  S_O: 0,
  S_NO: 0,
  S_NH: 31.56,
  S_ND: 6.95,
  X_ND: 10.59,
  S_ALK: 7.0,
});

/** 把 ASM1 组分折算成常规出水指标，便于与限值比较 */
export function toConventional(s: Asm1State): {
  cod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
} {
  // COD ≈ 惰性溶解性 + 可降解溶解性（生物量按 1.42 gCOD/gVSS 折算已在组分单位内）
  const cod = s.S_I + s.S_S + s.X_I + s.X_S + s.X_B_H + s.X_B_A + s.X_P;
  const ss = (s.X_I + s.X_S + s.X_B_H + s.X_B_A + s.X_P) / 1.42;
  const nh = s.S_NH;
  const tn = s.S_NH + s.S_NO + s.S_ND + s.X_ND + (s.X_B_H + s.X_B_A) * ASM1_PARAMS.i_XB + s.X_P * ASM1_PARAMS.i_XP;
  return { cod, ss, nh, tn, tp: 0 };
}

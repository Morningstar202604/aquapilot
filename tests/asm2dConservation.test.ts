import { describe, expect, it } from 'vitest';
import {
  ASM2D_COMPONENTS,
  ASM2D_PARAMS,
  ASM2D_PROCESSES,
  asm2dDescriptor,
  buildAsm2dRates,
  buildAsm2dStoichiometry,
  emptyAsm2dState,
  type Asm2dComponent,
  type Asm2dState,
} from '../src/sim/asm2d';
import { checkModelConservation } from '../src/sim/modelRegistry';

/**
 * WP2 守恒自检：
 *  a) 逐过程 COD/N/P 计量残差为 0（豁免必须写明物理理由，不为方便而豁免）；
 *  b) 闭合系统一步反应的总 COD/N/P 变化为 0（容差 1e-9），任何「造 COD/造氮」立即暴露；
 *  c) 单过程探针：逐过程计算反应向量在 COD/N/P 三个度量下的残差并打印审计。
 *
 * 说明：骨架 `stepAsm2dCstr` 是带工程化时间尺度的算法骨架，无进出流时长时间积分会因
 * 基质耗尽/衰减放大而失稳（见文档 §7），因此批次守恒在**计量向量层面**校验，不依赖该
 * 粗步长 CSTR 的长时间数值积分；真实全厂质量审计由网络级三本账承担。
 */

const p = ASM2D_PARAMS;

/** COD 当量权重（与描述符 conservation.cod 一致，S_O 以负 COD 存储）。 */
const COD_W: Partial<Record<Asm2dComponent, number>> = {
  S_F: 1,
  S_A: 1,
  S_I: 1,
  X_I: 1,
  X_S: 1,
  X_H: 1,
  X_PAO: 1,
  X_PHA: 1,
  X_AUT: 1,
  S_O: -1,
  S_NO3: -2.86,
  X_PP: 0,
  X_MEP: 0,
};

/** 氮当量权重：溶解态 1:1，S_F 携带溶解性有机氮分数，颗粒态按组分含氮分数。 */
const N_W: Partial<Record<Asm2dComponent, number>> = {
  S_NH4: 1,
  S_NO3: 1,
  S_N2: 1,
  S_F: p.i_N_SI,
  X_S: p.i_N_XS,
  X_H: p.i_N_BM,
  X_PAO: p.i_N_BM,
  X_AUT: p.i_N_BM,
};

/**
 * 磷当量权重：溶液态 1:1；X_PP 在本骨架按 COD 口径存储，P 当量为 i_P_PP；
 * 其余颗粒态按含磷分数。这样 P 账与 X_PP 的 COD 计量在同一单位下闭合。
 */
const P_W: Partial<Record<Asm2dComponent, number>> = {
  S_PO4: 1,
  X_PP: p.i_P_PP,
  X_MEP: 1,
  X_S: p.i_P_XS,
  X_H: p.i_P_BM,
  X_PAO: p.i_P_BM,
  X_AUT: p.i_P_BM,
};

function weightedSum(state: Asm2dState, weights: Partial<Record<Asm2dComponent, number>>): number {
  let sum = 0;
  for (const comp of ASM2D_COMPONENTS) {
    const w = weights[comp];
    if (w !== undefined) sum += state[comp] * w;
  }
  return sum;
}

/** 单个过程在给定状态下的计量向量 × 速率，返回 COD/N/P 残差（g 当量/m³）。 */
function processResidual(proc: (typeof ASM2D_PROCESSES)[number], state: Asm2dState) {
  const rates = buildAsm2dRates(p, p.T_REF);
  const stoich = buildAsm2dStoichiometry(p);
  const rate = rates[proc](state);
  const coeff = stoich[proc];
  const delta: Partial<Record<Asm2dComponent, number>> = {};
  for (const [comp, k] of Object.entries(coeff) as [Asm2dComponent, number][]) {
    delta[comp] = k * rate;
  }
  const deltaState = emptyAsm2dState(delta);
  return {
    rate,
    cod: weightedSum(deltaState, COD_W),
    n: weightedSum(deltaState, N_W),
    p: weightedSum(deltaState, P_W),
  };
}

/** X_PP 以 COD 口径参与计量，P 当量按 i_P_PP 统一换算后，不再需要 P 单位豁免。 */
const P_UNIT_BOUNDARY = new Set<string>();

/** 一个底物/生物量/氧/氮磷都不缺的状态，保证各过程速率 > 0。 */
function richState(): Asm2dState {
  return emptyAsm2dState({
    S_F: 30,
    S_A: 30,
    S_I: 25,
    S_NH4: 30,
    S_NO3: 10,
    S_PO4: 5,
    S_O: 2,
    S_ALK: 8,
    X_I: 20,
    X_S: 80,
    X_H: 2000,
    X_PAO: 300,
    X_AUT: 80,
    X_PP: 300,
    X_PHA: 50,
    X_MEP: 0,
  });
}

const descriptor = asm2dDescriptor();

describe('ASM2d 逐过程计量守恒', () => {
  const rows = checkModelConservation(descriptor);

  it('描述符覆盖全部 19 过程，且每条豁免都写明物理理由', () => {
    expect(rows).toHaveLength(ASM2D_PROCESSES.length);
    for (const row of rows) {
      const exempt = descriptor.conservation.exempt?.[row.process];
      if (exempt !== undefined) expect(exempt.length).toBeGreaterThan(5);
    }
  });

  it('非豁免过程 COD/N 残差为 0（容差 1e-9）；P 残差仅允许单位混合边界过程', () => {
    const state = richState();
    for (const proc of ASM2D_PROCESSES) {
      const exempt = descriptor.conservation.exempt?.[proc];
      const { cod, n, p: pres } = processResidual(proc, state);
      expect(Number.isFinite(cod) && Number.isFinite(n) && Number.isFinite(pres)).toBe(true);
      if (exempt === undefined) {
        expect(Math.abs(cod), `${proc} COD 残差`).toBeLessThan(1e-9);
        expect(Math.abs(n), `${proc} N 残差`).toBeLessThan(1e-9);
        if (!P_UNIT_BOUNDARY.has(proc)) {
          expect(Math.abs(pres), `${proc} P 残差`).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('校验器 ok 标记与豁免一致：豁免外过程必须闭合', () => {
    for (const row of rows) {
      const exempt = descriptor.conservation.exempt?.[row.process];
      if (exempt === undefined) expect(row.ok, row.process).toBe(true);
    }
  });
});

describe('ASM2d 闭合系统反应向量守恒', () => {
  it('全部过程一步反应向量叠加后，COD/N 总变化为 0（容差 1e-9，豁免边界除外）', () => {
    const state = richState();
    const rates = buildAsm2dRates(p, p.T_REF);
    const stoich = buildAsm2dStoichiometry(p);
    const delta = emptyAsm2dState();
    for (const proc of ASM2D_PROCESSES) {
      if (descriptor.conservation.exempt?.[proc] !== undefined) continue;
      const rate = rates[proc](state);
      if (rate <= 0) continue;
      for (const [comp, k] of Object.entries(stoich[proc]) as [Asm2dComponent, number][]) {
        delta[comp] += k * rate;
      }
    }
    const cod = weightedSum(delta, COD_W);
    const n = weightedSum(delta, N_W);
    expect(Math.abs(cod)).toBeLessThan(1e-9);
    expect(Math.abs(n)).toBeLessThan(1e-9);
  });

  it('闭合批次：只投 X_S、不投 NH，水解+氨化释放的 NH4 ≈ X_S 含氮量（系数不被放大）', () => {
    const rates = buildAsm2dRates(p, p.T_REF);
    const stoich = buildAsm2dStoichiometry(p);
    // 只给慢速可降解颗粒与少量异养菌，溶液态氨氮为 0。
    const state = emptyAsm2dState({ X_S: 100, X_H: 2000 });
    const nBefore = weightedSum(state, N_W);

    // 一步水解：X_S → S_F，并按差额释放氨氮。
    const hydRate = rates.hydrolysis_XS(state);
    for (const [comp, k] of Object.entries(stoich.hydrolysis_XS) as [Asm2dComponent, number][]) {
      state[comp] += k * hydRate;
    }
    // 紧接一步氨化：S_F 携带的结合氮按 i_N_SI 释放为氨氮。
    const ammRate = rates.ammonification(state);
    for (const [comp, k] of Object.entries(stoich.ammonification) as [Asm2dComponent, number][]) {
      state[comp] += k * ammRate;
    }

    const nAfter = weightedSum(state, N_W);
    expect(Math.abs(nAfter - nBefore)).toBeLessThan(1e-9);
    // 释放的氨氮不得超过 X_S 总含氮量；若系数被放大到 1 gN/gCOD，这里会远超 i_N_XS 上限。
    const nhReleased = state.S_NH4;
    expect(nhReleased).toBeLessThanOrEqual(100 * p.i_N_XS + 1e-6);
    // 氨化计量系数是结合氮分数，不是 1 gN/gCOD。
    expect(stoich.ammonification.S_NH4).toBeCloseTo(p.i_N_SI, 12);
  });
});

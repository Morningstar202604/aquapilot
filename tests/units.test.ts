import { describe, expect, it } from 'vitest';
import {
  ALK_PER_N,
  COD_PER_NO3_N,
  COD_PER_VSS,
  O2_PER_NH_N,
  VSS_PER_COD,
  codToDrySolids,
  drySolidsToCod,
  particulateToTss,
} from '../src/sim/units';

/**
 * 单位换算契约。
 *
 * 对标 QSDsan 的 `utils/cod.py`：COD 换算是贯穿全模型的契约，
 * 生物量、悬浮物、排泥、质量平衡都依赖同一个系数。
 * 此前 1.42 硬编码在 5 处，任何一处改动都会让口径分叉而不报错。
 */

describe('系数值', () => {
  it('1.42 g COD/g VSS 与倒数关系自洽', () => {
    expect(COD_PER_VSS).toBe(1.42);
    expect(VSS_PER_COD * COD_PER_VSS).toBeCloseTo(1, 12);
  });

  it('ASM1 标准常数', () => {
    expect(COD_PER_NO3_N).toBe(2.86);
    expect(O2_PER_NH_N).toBe(4.57);
    expect(ALK_PER_N).toBeCloseTo(1 / 14, 12);
  });
});

describe('换算函数', () => {
  it('颗粒 COD → TSS', () => {
    expect(particulateToTss(1420)).toBeCloseTo(1000, 6);
  });

  it('干固体与 COD 互为逆运算', () => {
    for (const kg of [0, 1, 100, 12345]) {
      expect(codToDrySolids(drySolidsToCod(kg))).toBeCloseTo(kg, 9);
    }
  });

  it('零值不产生 NaN', () => {
    expect(particulateToTss(0)).toBe(0);
    expect(drySolidsToCod(0)).toBe(0);
    expect(codToDrySolids(0)).toBe(0);
  });
});

describe('与模型内部口径一致', () => {
  it('ASM1 颗粒组分折算的 SS 与 toConventional 一致', async () => {
    const { toConventional } = await import('../src/sim/asm1Cstr');
    const state = {
      S_I: 30,
      S_S: 1,
      X_I: 1149,
      X_S: 80,
      X_B_H: 2553,
      X_B_A: 152,
      X_P: 449,
      S_O: 2,
      S_NO: 10,
      S_NH: 1,
      S_ND: 0.5,
      X_ND: 0.1,
      S_ALK: 4,
    };
    const conv = toConventional(state);
    const particulate = state.X_I + state.X_S + state.X_B_H + state.X_B_A + state.X_P;
    expect(conv.ss).toBeCloseTo(particulateToTss(particulate), 6);
  });
});

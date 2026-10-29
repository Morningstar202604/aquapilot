/**
 * 水质单位换算。
 *
 * 为什么单独成模块（对标 QSDsan 的 `utils/cod.py`）：
 * QSDsan 把 COD 换算做成独立工具模块，因为它是一个**贯穿全模型的契约**——
 * 生物量、悬浮物、排泥量、质量平衡审计全都依赖同一个系数。
 *
 * 此前本项目把 `1.42` 硬编码在 5 处（asm1Mapping / analysis / tankStates /
 * calibration），这是重复造轮子的典型信号：任何一处改动都会让口径分叉，
 * 而分叉不会报错，只会让质量平衡悄悄偏掉。
 *
 * 数值依据：
 * - 1.42 g COD / g VSS：ASM1 生物量的理论氧当量（C5H7O2N + O2 完全氧化）
 * - 1.42 也用于颗粒态 COD ↔ TSS 的近似换算，是 ASM 系列的通用约定
 *
 * 注意：QSDsan 走的是「元素组成 → 电子平衡 → COD」的严格路径，
 * 需要每个组分的分子式。本项目没有组分元素组成数据库，因此用理论系数。
 * 这是**精度上的已知差距**，不是疏漏——记录在 docs/COMPETITIVE-ANALYSIS.md。
 */

/** g COD / g VSS（ASM1 生物量氧当量，理论值） */
export const COD_PER_VSS = 1.42;

/** g VSS / g COD */
export const VSS_PER_COD = 1 / COD_PER_VSS;

/** 每 g 硝酸盐氮作为电子受体的 COD 当量（反硝化） */
export const COD_PER_NO3_N = 2.86;

/** 每 g 氨氮氧化的理论需氧量 */
export const O2_PER_NH_N = 4.57;

/** 每 g N 对应的碱度（mol HCO3⁻） */
export const ALK_PER_N = 1 / 14;

/** 颗粒态浓度（g COD/m³）→ 悬浮固体（mg/L） */
export function particulateToTss(particulateCod: number): number {
  return particulateCod / COD_PER_VSS;
}

/** 干固体（kg）→ COD 当量（kg） */
export function drySolidsToCod(kg: number): number {
  return kg * COD_PER_VSS;
}

/** COD 当量（kg）→ 干固体（kg） */
export function codToDrySolids(kg: number): number {
  return kg * VSS_PER_COD;
}

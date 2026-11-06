/**
 * 排放标准档案。
 *
 * 为什么需要这个模块：AquaPilot 的水线是 IWA BSM1 基准厂，BSM1 的技术报告
 * 以 SS ≤ 15 mg/L 为背景设定（其参考出水 TSS 为 11.73 mg/L）。而中国
 * GB 18918-2002 一级 A 要求 SS ≤ 10 —— 于是「仿真忠实复现了 BSM1」与
 * 「按一级 A 判超标」会同时成立。这不是模型错误，是**标准口径不同**。
 *
 * 早先版本把 LIMITS 硬编码成一级 A，界面上就出现「ASM1 偏差仅 5%」与
 * 「SS 长期超标」并列的观感，用户无法判断到底哪个结论可信。把标准做成
 * 显式档案后，同一个仿真结果可以按不同标准判读，差异也就能被解释。
 *
 * 设计取舍：
 * - 只收「有公开文本依据」的标准，不自行发明阈值；
 * - BSM1 档案标注为「基准参考」，不冒充法定标准；
 * - 默认仍是一级 A（中国项目最常见的验收口径），不因为好看而换默认值。
 */

export interface DischargeLimits {
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
}

export interface DischargeStandard {
  id: string;
  /** 界面显示名 */
  label: string;
  /** 标准出处 */
  source: string;
  limits: DischargeLimits;
  /** 这个口径下最容易失守的指标（用于提示读数） */
  note: string;
}

/**
 * GB 18918-2002《城镇污水处理厂污染物排放标准》一级 A / 一级 B。
 * 单位 mg/L。BOD₅ / COD / SS / NH₃-N / TN / TP 六项基本控制指标。
 */
export const GB18918_1A: DischargeStandard = {
  id: 'gb18918-1a',
  label: 'GB 18918-2002 一级 A',
  source: 'GB 18918-2002 表 1',
  limits: { cod: 50, bod: 10, ss: 10, nh: 5, tn: 15, tp: 0.5 },
  note: 'SS ≤ 10 严于 BSM1 基准厂的参考出水（TSS ≈ 11.7），基准厂在该口径下 SS 天然吃紧',
};

export const GB18918_1B: DischargeStandard = {
  id: 'gb18918-1b',
  label: 'GB 18918-2002 一级 B',
  source: 'GB 18918-2002 表 1',
  limits: { cod: 60, bod: 20, ss: 20, nh: 8, tn: 20, tp: 1 },
  note: 'SS ≤ 20 与 BSM1 基准厂的出水水平相容',
};

/**
 * BSM1 评估口径。
 *
 * IWA BSM1 技术报告的出水评估以 SS ≤ 15、COD ≤ 100、NH ≤ 4、TN ≤ 18 为参照
 * （报告 Table 6 的稳态值本身即 TSS 11.73）。这不是法定标准，是一套
 * 国际基准的评估口径，列出来是为了让「模型是否忠实」与「是否达标」两件事
 * 可以分开判断。
 */
export const BSM1_REFERENCE: DischargeStandard = {
  id: 'bsm1-reference',
  label: 'BSM1 benchmark reference',
  source: 'IWA BSM1 Technical Report',
  limits: { cod: 100, bod: 30, ss: 15, nh: 4, tn: 18, tp: 2 },
  note: '基准评估口径，非法定标准；用于判断模型复现是否忠实',
};

export const DISCHARGE_STANDARDS: DischargeStandard[] = [GB18918_1A, GB18918_1B, BSM1_REFERENCE];

export function standardById(id: string): DischargeStandard | undefined {
  return DISCHARGE_STANDARDS.find((s) => s.id === id || s.id === id.toLowerCase());
}

/** 默认口径：一级 A */
export const DEFAULT_STANDARD = GB18918_1A;

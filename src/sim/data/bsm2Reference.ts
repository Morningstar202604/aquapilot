/**
 * IWA BSM2 官方进水参考数据的解析层。
 *
 * 这一层的唯一职责：把上游 22 列 ASM1 组分向量（`bsm2ConstInfluent.ts`）
 * 翻译成本项目引擎使用的 7 项常规进水指标。翻译规则必须可核对，
 * 因此每个换算都在这里写明依据，并有测试逐项断言。
 *
 * 为什么值得单独一层：
 * 早期版本在 `bsm2ConstantSeries()` 里手写了「近似值」（COD 300 / NH 31.6 /
 * SS 171），注释声称是「ASM1 组分折算」，但官方文件实际是
 * COD 592.5 / NH 23.86 / TSS 380.3。手写值既不是官方值也不是任何
 * 有据可查的折算结果，属于凭印象填数。解析真实文件后，
 * 「BSM2 基准」这个名字才站得住。
 */

/** 22 列 BSM2 进水向量的语义顺序（与上游 helpers_bsm2.py 一致）。 */
export const BSM2_INFLUENT_COLUMNS = [
  'time',
  'SI',
  'SS',
  'XI',
  'XS',
  'XBH',
  'XBA',
  'XP',
  'SO',
  'SNO',
  'SNH',
  'SND',
  'XND',
  'SALK',
  'TSS',
  'Q',
  'TEMP',
  'SD1',
  'SD2',
  'SD3',
  'XD4',
  'XD5',
] as const;

export type Bsm2InfluentColumn = (typeof BSM2_INFLUENT_COLUMNS)[number];

/** 一行的全部 22 个组分（按列名索引，避免下标魔法数散落在调用处）。 */
export type Bsm2InfluentRow = Record<Bsm2InfluentColumn, number>;

/** 常规水质指标——引擎实际消费的形状。 */
export interface Bsm2Conventional {
  /** 进水流量, m³/h（上游是 m³/d，已除以 24） */
  flow: number;
  /** 总 COD, g COD/m³ = SI + SS + XI + XS + XBH + XBA + XP */
  cod: number;
  /** 氨氮, g N/m³（直接取 SNH） */
  nh: number;
  /** 总磷, g P/m³（ASM1 不含磷，见 phosphorusNote） */
  tp: number;
  /** 总悬浮固体, g/m³（直接取 TSS） */
  ss: number;
  /** 水温, °C（直接取 TEMP） */
  temperature: number;
  /** 碱度, g/m³ as CaCO₃ = SALK[mol/m³] × 50 g/mol */
  alkalinity: number;
  /** 哪些字段来自官方数据、哪些是补的，供 UI 与文档如实展示 */
  provenance: { official: string[]; derived: string[]; substituted: string[] };
}

/**
 * 解析一行 22 列 CSV。
 *
 * 严格模式：列数不对直接抛错。这是**基准数据**，不是用户上传的现场数据——
 * 现场数据要容错（零星坏行不能否决整个文件），基准数据必须精确，
 * 静默容忍只会让「基准」失去意义。
 */
export function parseBsm2InfluentRow(line: string): Bsm2InfluentRow {
  const cells = line.split(',');
  if (cells.length !== BSM2_INFLUENT_COLUMNS.length) {
    throw new Error(`BSM2 进水向量应为 ${BSM2_INFLUENT_COLUMNS.length} 列，实际 ${cells.length} 列`);
  }
  const row = {} as Bsm2InfluentRow;
  BSM2_INFLUENT_COLUMNS.forEach((name, i) => {
    const value = Number(cells[i].trim());
    if (!Number.isFinite(value)) {
      throw new Error(`BSM2 进水向量第 ${i + 1} 列（${name}）不是有限数值：${cells[i]}`);
    }
    row[name] = value;
  });
  return row;
}

/** 解析多行，按时间升序返回（上游文件本身已是有序的，这里只做稳定断言）。 */
export function parseBsm2InfluentCsv(csv: string): Bsm2InfluentRow[] {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map(parseBsm2InfluentRow)
    .sort((a, b) => a.time - b.time);
}

/**
 * 22 列 ASM1 组分 → 7 项常规指标。
 *
 * 换算依据：
 * - 总 COD 是各含碳组分的加和（BSM2 技术报告的进水表就是这个口径）
 * - 流量按 m³/d → m³/h 除以 24，与本项目其余模块的流量单位一致
 * - 碱度 mol/m³ → g/m³ as CaCO₃ 用 50 g/mol（CaCO₃ 当量）
 * - **ASM1 没有磷的状态变量**，因此 tp 必须由调用方显式给出替代值，
 *   本函数不擅自编一个数字——这属于「模型边界」，不是「缺个省事」
 */
export function toConventional(row: Bsm2InfluentRow, tpSubstitute: number): Bsm2Conventional {
  const cod = row.SI + row.SS + row.XI + row.XS + row.XBH + row.XBA + row.XP;
  return {
    flow: row.Q / 24,
    cod,
    nh: row.SNH,
    tp: tpSubstitute,
    ss: row.TSS,
    temperature: row.TEMP,
    alkalinity: row.SALK * 50,
    provenance: {
      official: ['flow', 'cod', 'nh', 'ss', 'temperature', 'alkalinity'],
      derived: ['cod', 'flow', 'alkalinity'],
      substituted: ['tp'],
    },
  };
}

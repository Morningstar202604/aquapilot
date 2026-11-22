/**
 * WP2 泥线（sludge line）：剩余污泥 → 浓缩 → 厌氧消化（ADM1 CSTR）→ 脱水 → 泥饼外运。
 *
 * 单位口径（与契约 §2 一致）：流量 m³/h；浓度 mg/L（= g/m³）；质量 kg；能量 kW；时间 h/d。
 *
 * 模型边界（详见 docs/PLANT-BOUNDARY.md 第 4、6 节）：
 * - 浓缩池按重力浓缩的固定分流/浓缩倍数近似，不带分层沉降；
 * - 消化池是单段 CSTR，35 ℃ 中温，SRT 20–25 d；不含温度/水力分层、不含两相；
 * - 沼液（脱水滤液 + 浓缩上清液）回流到水厂首端，携带 NH4-N / COD / TP 负荷；
 * - 泥线默认关闭；关闭时不产生沼气、不回流滤液，ASM1 基准路径不受影响。
 */

import { ADM1_PARAMS, emptyAdm1State, stepAdm1, type Adm1State } from './adm1';

/** 泥线工艺参数（工程量级兜底，非现场标定） */
export const SLUDGE_LINE_DEFAULTS = {
  /** 浓缩上清液分流比例（回流到首端） */
  supernatantFraction: 0.45,
  /** 浓缩倍数：底流 SS / 进料 SS */
  thickeningFactor: 2.5,
  /** 上清液残留 SS 占进料 SS 比例 */
  supernatantSsFraction: 0.15,
  /** 消化池 SRT d（区间 20–25） */
  digesterSrtDays: 22,
  /** 消化池温度 ℃（中温） */
  digesterTempC: 35,
  /** VS 占干固体比例 */
  vssFraction: 0.75,
  /** VS 降解率 */
  vsDestruction: 0.55,
  /** 产甲烷率 m³ CH₄ / kg VS 降解（STP 量级） */
  ch4M3PerVsKg: 0.35,
  /** 沼气中 CH₄ 体积分数 */
  ch4Fraction: 0.65,
  /** CH₄ 密度 kg/m³（STP） */
  ch4DensityKgM3: 0.717,
  /** 泥饼含固率（干固体占湿饼质量） */
  cakeSolidsFraction: 0.2,
  /** 脱水滤液 N 残留比例（其余进泥饼） */
  filtrateNFraction: 0.6,
  /** 滤液溶解 COD 占进料 COD 比例 */
  filtrateCodFraction: 0.1,
  /** 滤液 TP 占进料 TP 比例 */
  filtrateTpFraction: 0.5,
  /** 消化池搅拌功率 kW/m³ */
  mixingKwPerM3: 0.05,
  /** 水比热 kJ/kg·℃ */
  waterCpKjPerKgC: 4.18,
  /** 污泥含氮量 gN/g 干固体（生物量口径） */
  nitrogenPerDrySolids: 0.07,
} as const;

export interface SludgeFiltrate {
  /** 回流流量 m³/h（浓缩上清 + 脱水滤液） */
  flowM3h: number;
  /** NH4-N 浓度 g/m³（mg/L） */
  nh4NKgM3: number;
  /** COD 浓度 g/m³ */
  codKgM3: number;
  /** TP 浓度 g/m³ */
  tpKgM3: number;
}

export interface DigesterGas {
  methaneM3d: number;
  co2M3d: number;
  h2M3d: number;
  totalM3d: number;
  ch4Fraction: number;
  methaneKgD: number;
  vssDestroyedKgD: number;
  heatingKw: number;
  mixingKw: number;
}

export interface SludgeLineState {
  enabled: boolean;
  thickener: {
    feedFlowM3h: number;
    feedSsKgM3: number;
    underflowFlowM3h: number;
    underflowSsKgM3: number;
    supernatantFlowM3h: number;
  };
  digester: {
    volumeM3: number;
    temperatureC: number;
    srtDays: number;
    adm1: Adm1State;
    gas: DigesterGas;
  };
  dewatering: {
    cakeDrySolidsKgD: number;
    cakeWetKgD: number;
    filtrate: SludgeFiltrate;
  };
  /** 累计量（自预热结束起） */
  cumulative: {
    rawSludgeKgD: number;
    cakeKgD: number;
    methaneM3: number;
    filtrateNh4Kg: number;
    filtrateCodKg: number;
    filtrateTpKg: number;
  };
  errors: { code: string; message: string }[];
}

/** 进泥负荷（由水线 WAS 与混合液浓度折算） */
export interface SludgeFeed {
  /** 剩余污泥流量 m³/h */
  wasFlowM3h: number;
  /** 混合液 SS g/m³（mg/L） */
  feedSsKgM3: number;
  /** 进料 COD g/m³ */
  feedCodKgM3: number;
  /** 进料总氮 g/m³ */
  feedNKgM3: number;
  /** 进料总磷 g/m³ */
  feedPKgM3: number;
  /** 环境/进泥温度 ℃ */
  ambientTempC: number;
}

const clampNonFinite = (v: number, fallback = 0): number => (Number.isFinite(v) ? Math.max(0, v) : fallback);

/** 初始化泥线状态；enabled=false 时全部置零，不参与任何账本。 */
export function createSludgeLine(enabled: boolean): SludgeLineState {
  const zeroGas: DigesterGas = {
    methaneM3d: 0,
    co2M3d: 0,
    h2M3d: 0,
    totalM3d: 0,
    ch4Fraction: 0,
    methaneKgD: 0,
    vssDestroyedKgD: 0,
    heatingKw: 0,
    mixingKw: 0,
  };
  return {
    enabled,
    thickener: {
      feedFlowM3h: 0,
      feedSsKgM3: 0,
      underflowFlowM3h: 0,
      underflowSsKgM3: 0,
      supernatantFlowM3h: 0,
    },
    digester: {
      volumeM3: 0,
      temperatureC: SLUDGE_LINE_DEFAULTS.digesterTempC,
      srtDays: SLUDGE_LINE_DEFAULTS.digesterSrtDays,
      adm1: emptyAdm1State(),
      gas: zeroGas,
    },
    dewatering: { cakeDrySolidsKgD: 0, cakeWetKgD: 0, filtrate: { flowM3h: 0, nh4NKgM3: 0, codKgM3: 0, tpKgM3: 0 } },
    cumulative: { rawSludgeKgD: 0, cakeKgD: 0, methaneM3: 0, filtrateNh4Kg: 0, filtrateCodKg: 0, filtrateTpKg: 0 },
    errors: [],
  };
}

/** 把污泥固体组成映射成 ADM1 进料向量（g COD/m³ 口径）。 */
function sludgeToAdm1In(feed: SludgeFeed): Adm1State {
  const solids = clampNonFinite(feed.feedSsKgM3);
  return emptyAdm1State({
    X_c: solids * 0.85,
    X_pr: solids * 0.85 * 0.3,
    X_ch: solids * 0.85 * 0.3,
    X_li: solids * 0.85 * 0.2,
    S_IN: clampNonFinite(feed.feedNKgM3),
    S_IC: 10,
    S_I: solids * 0.1,
    S_ac: 0.2,
    S_su: 0.3,
    S_aa: 0.2,
  });
}

/**
 * 推进泥线一个时间步。
 *
 * 返回本步回流到首端的滤液负荷（流量 + 浓度）；关闭时返回零负荷。
 */
export function stepSludgeLine(line: SludgeLineState, feed: SludgeFeed, dtH: number): SludgeFiltrate {
  line.errors = [];
  if (!line.enabled) return { flowM3h: 0, nh4NKgM3: 0, codKgM3: 0, tpKgM3: 0 };

  const d = SLUDGE_LINE_DEFAULTS;
  const wasFlow = clampNonFinite(feed.wasFlowM3h);
  const feedSs = clampNonFinite(feed.feedSsKgM3);
  const feedCod = clampNonFinite(feed.feedCodKgM3);
  const feedN = clampNonFinite(feed.feedNKgM3);
  const feedP = clampNonFinite(feed.feedPKgM3);
  const ambient = Number.isFinite(feed.ambientTempC) ? feed.ambientTempC : 20;

  if (wasFlow <= 1e-6) {
    // 无排泥：泥线保持现状，回流零负荷
    return { flowM3h: 0, nh4NKgM3: 0, codKgM3: 0, tpKgM3: 0 };
  }

  // ── 浓缩池 ──
  const supernatantFlow = wasFlow * d.supernatantFraction;
  const underflowFlow = wasFlow - supernatantFlow;
  const underflowSs = Math.min(feedSs * d.thickeningFactor, feedSs * 3);
  line.thickener = {
    feedFlowM3h: wasFlow,
    feedSsKgM3: feedSs,
    underflowFlowM3h: underflowFlow,
    underflowSsKgM3: underflowSs,
    supernatantFlowM3h: supernatantFlow,
  };

  // ── 消化池：体积按 SRT 由进料流量反推；ADM1 CSTR 步进 ──
  const digesterVolume = Math.max(1, (underflowFlow * d.digesterSrtDays * 24) / 24);
  const adm1In = sludgeToAdm1In(feed);
  const adm1Result = stepAdm1(line.digester.adm1, adm1In, ADM1_PARAMS, {
    volume: digesterVolume,
    flow: underflowFlow,
    dtHours: dtH,
    temperatureC: d.digesterTempC,
  });
  line.digester.adm1 = adm1Result.state;
  line.digester.volumeM3 = digesterVolume;
  line.digester.srtDays = d.digesterSrtDays;

  // ── 产气：按 VS 降解量折算（独立于 ADM1 气相尺度，保证可审计） ──
  const vssInKgH = (feedSs * d.vssFraction * underflowFlow) / 1000;
  const vssDestroyedKgH = vssInKgH * d.vsDestruction;
  const vssDestroyedKgD = vssDestroyedKgH * 24;
  const methaneM3d = vssDestroyedKgD * d.ch4M3PerVsKg;
  const co2M3d = methaneM3d * ((1 - d.ch4Fraction) / d.ch4Fraction);
  const totalM3d = methaneM3d + co2M3d;
  const methaneKgD = methaneM3d * d.ch4DensityKgM3;

  const feedMassKgH = underflowFlow * 1000;
  const heatingKw = (feedMassKgH * d.waterCpKjPerKgC * Math.max(0, d.digesterTempC - ambient)) / 3600;
  const mixingKw = digesterVolume * d.mixingKwPerM3;

  line.digester.gas = {
    methaneM3d,
    co2M3d,
    h2M3d: 0,
    totalM3d,
    ch4Fraction: totalM3d > 1e-9 ? d.ch4Fraction : 0,
    methaneKgD,
    vssDestroyedKgD,
    heatingKw,
    mixingKw,
  };

  // ── 脱水（按本步流量/浓度算质量，避免日流量与小时流量混乘） ──
  const solidsInKgH = (feedSs * underflowFlow) / 1000;
  const dryCakeKgH = Math.max(0, solidsInKgH - vssDestroyedKgH);
  const cakeWetKgH = dryCakeKgH / d.cakeSolidsFraction;
  // 氮分配：进泥结合氮 = 干固体 × 含氮率；VS 降解部分有机氮矿化为铵进入液相滤液，
  // 其余结合氮随泥饼外运。滤液铵氮 = 进料可溶性氮 + 矿化释放氮。
  const sludgeBoundN = solidsInKgH * d.nitrogenPerDrySolids;
  const mineralizedN = sludgeBoundN * d.vsDestruction;
  const feedNKgH = (feedN * underflowFlow) / 1000;
  const filtrateNKgH = Math.max(0, feedNKgH + mineralizedN);
  const filtrateCodKgH = ((feedCod * underflowFlow) / 1000) * d.filtrateCodFraction;
  const filtratePKgH = ((feedP * underflowFlow) / 1000) * d.filtrateTpFraction;
  const filtrateFlow = Math.max(0, underflowFlow + supernatantFlow - cakeWetKgH / 1000);

  line.dewatering = {
    cakeDrySolidsKgD: dryCakeKgH * 24,
    cakeWetKgD: cakeWetKgH * 24,
    filtrate: {
      flowM3h: filtrateFlow,
      nh4NKgM3: (filtrateNKgH * 1000) / Math.max(1e-3, filtrateFlow),
      codKgM3: (filtrateCodKgH * 1000) / Math.max(1e-3, filtrateFlow),
      tpKgM3: (filtratePKgH * 1000) / Math.max(1e-3, filtrateFlow),
    },
  };

  // ── 累计 ──
  line.cumulative.rawSludgeKgD += solidsInKgH * dtH;
  line.cumulative.cakeKgD += cakeWetKgH * dtH;
  line.cumulative.methaneM3 += methaneM3d * (dtH / 24);
  line.cumulative.filtrateNh4Kg += filtrateNKgH * dtH;
  line.cumulative.filtrateCodKg += filtrateCodKgH * dtH;
  line.cumulative.filtrateTpKg += filtratePKgH * dtH;

  return line.dewatering.filtrate;
}

/** 深拷贝泥线状态（预测克隆用）。 */
export function cloneSludgeLine(line: SludgeLineState): SludgeLineState {
  return {
    ...line,
    thickener: { ...line.thickener },
    digester: {
      ...line.digester,
      adm1: { ...line.digester.adm1 },
      gas: { ...line.digester.gas },
    },
    dewatering: { ...line.dewatering, filtrate: { ...line.dewatering.filtrate } },
    cumulative: { ...line.cumulative },
    errors: line.errors.map((e) => ({ ...e })),
  };
}

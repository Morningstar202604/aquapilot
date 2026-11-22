/**
 * WP2 全厂边界（plant boundary）：COD / N / P 三本账 + 泥线闭环状态。
 *
 * 单位口径（契约 §2）：浓度 mg/L（= g/m³）；质量 kg；流量 m³/h；时间 min/h。
 *
 * 账本行式（每步积分，自预热结束起累计）：
 *   进水 raw influent｜出水 effluent｜排泥 wasted cake｜沼气甲烷 COD 当量｜
 *   氧化 oxidized COD｜库存变化 inventory change｜沼液回流 recycle filtrate。
 *
 * 残差 = 进水 + 回流 − 出水 − 排泥 − 沼气COD − 氧化 − 库存变化；
 * 残差超阈值记 `PLANT_BALANCE_UNCLOSED` 诊断（不阻断仿真）。
 *
 * 泥线默认关闭：`enabled=false` 时账本仍按水线自身口径累计，不接 ADM1 回流。
 */

import { cloneSludgeLine, createSludgeLine, type SludgeFiltrate, type SludgeLineState } from './sludgeLine';
import { COD_PER_VSS } from './units';

export const PLANT_ERRORS = {
  PLANT_BALANCE_UNCLOSED: 'PLANT_BALANCE_UNCLOSED',
  ASM2D_STATE_INVALID: 'ASM2D_STATE_INVALID',
} as const;

/** 残差阈值：|残差|/进水 > 5% 判为未闭合（诊断，不阻断） */
export const BALANCE_TOLERANCE_PCT = 0.05;
/** 1 kg CH₄ 的 COD 当量 kg O₂（CH₄ + 2O₂ → CO₂ + 2H₂O：64/16 = 4） */
export const COD_PER_CH4_KG = 4.0;
/** 生物量含氮/含磷比例（g/g 干固体，ASM 口径；WAS 含磷取 0.032，接近剩余污泥实测区间） */
const N_PER_BIOMASS = 0.07;
const P_PER_BIOMASS = 0.032;

export interface BalanceRow {
  /** 进水累计 kg（不含回流） */
  inflowKg: number;
  /** 出水累计 kg */
  effluentKg: number;
  /** 排泥（泥饼）累计 kg */
  wastedKg: number;
  /** 沼气折 COD 累计 kg（仅 COD 账有意义） */
  methaneCodKg: number;
  /** 氧化去除 COD 累计 kg（仅 COD 账；CO₂ 去向） */
  oxidizedKg: number;
  /** 反硝化 N₂ 累计 kg（仅 N 账；N₂ 去向） */
  denitrifiedKg: number;
  /** 库存变化累计 kg（期末 − 期初） */
  inventoryChangeKg: number;
  /** 沼液/上清回流累计 kg（计入进水侧） */
  recycleKg: number;
  /** 残差 kg */
  residualKg: number;
  /** 残差占进水比例 */
  residualPct: number;
  /** 残差是否在阈值内闭合 */
  closed: boolean;
}

export interface PlantBoundaryState {
  enabled: boolean;
  sludgeLine: SludgeLineState;
  balance: { cod: BalanceRow; n: BalanceRow; p: BalanceRow };
  errors: { code: string; message: string }[];
  inventory: {
    biomassKg: number;
    codKg: number;
    nKg: number;
    pKg: number;
    previousCodKg: number;
    previousNKg: number;
    previousPKg: number;
    seeded: boolean;
  };
}

function emptyRow(): BalanceRow {
  return {
    inflowKg: 0,
    effluentKg: 0,
    wastedKg: 0,
    methaneCodKg: 0,
    oxidizedKg: 0,
    denitrifiedKg: 0,
    inventoryChangeKg: 0,
    recycleKg: 0,
    residualKg: 0,
    residualPct: 0,
    closed: true,
  };
}

export function createPlantBoundary(enabled: boolean): PlantBoundaryState {
  return {
    enabled,
    sludgeLine: createSludgeLine(enabled),
    balance: { cod: emptyRow(), n: emptyRow(), p: emptyRow() },
    errors: [],
    inventory: {
      biomassKg: 0,
      codKg: 0,
      nKg: 0,
      pKg: 0,
      previousCodKg: 0,
      previousNKg: 0,
      previousPKg: 0,
      seeded: false,
    },
  };
}

/** 记录一条诊断/错误（不抛异常；快照与路由可见）。按错误码去重，消息取最新值。 */
export function recordPlantError(state: PlantBoundaryState, code: string, message: string): void {
  const existing = state.errors.find((e) => e.code === code);
  if (existing) {
    existing.message = message;
  } else {
    state.errors.push({ code, message });
  }
}

export interface BalanceInput {
  influent: { flow: number; cod: number; nh: number; tn: number; tp: number };
  effluent: { flow: number; cod: number; nh: number; tn: number; tp: number };
  dtH: number;
  /** 当前系统生物量 kg */
  biomassKg: number;
  /** 池内库存（溶解态 + 生物量折算，kg）；缺省时退回仅生物量口径 */
  inventory?: { codKg: number; nKg: number; pKg: number; ppPKg?: number };
  /** 本步氧化 COD kg/h（引擎 O₂ 估算，作参考口径） */
  oxidizedCodKgH: number;
  /** 本步反硝化 N kg/h（引擎缺氧段 NO₃ 移除估算，作参考口径） */
  denitrifiedNKgH?: number;
  /** 本步排泥干固体 kg（由引擎 Takács/WAS 给出） */
  wastedDryKg: number;
}

/** 浓度 g/m³ × 流量 m³/h × 时长 h → kg */
function loadKg(concentration: number, flowM3h: number, dtH: number): number {
  return (Math.max(0, concentration) * Math.max(0, flowM3h) * dtH) / 1000;
}

function finalizeRow(row: BalanceRow): BalanceRow {
  const supply = row.inflowKg + row.recycleKg;
  const residual =
    supply -
    row.effluentKg -
    row.wastedKg -
    row.methaneCodKg -
    row.oxidizedKg -
    row.denitrifiedKg -
    row.inventoryChangeKg;
  row.residualKg = residual;
  row.residualPct = supply > 1e-9 ? Math.abs(residual) / supply : 0;
  row.closed = row.residualPct <= BALANCE_TOLERANCE_PCT;
  return row;
}

/**
 * 每步更新三本账。
 *
 * 各项去向均按引擎独立通量计量，不做边界余额倒推：
 * - 氧化 COD（→CO₂）：曝气 OUR/供氧路径折算的 COD 当量（估算口径，见文档）；
 * - 反硝化 N（→N₂）：反硝化过程 NO₃ 还原通量 × 计量系数；
 * - 沼气 CH₄：ADM1 产气 × 4.0 kgCOD/kgCH₄；
 * - 排泥：Takács/WAS 干固体；库存变化：组分浓度 × 池容的期末−期初；
 * - 残差 = 供给 − 各项去向 − 库存变化，允许为非零小数（≤5% 判闭合）。
 */
export function updatePlantBalance(state: PlantBoundaryState, input: BalanceInput): void {
  const { influent, effluent, dtH, biomassKg, wastedDryKg } = input;
  const sludge = state.sludgeLine;

  // 库存：asm2d 传入组分级 N/P（含颗粒态结合氮/磷）时直接采用；缺省退回生物量折算口径。
  const invCod = input.inventory?.codKg ?? biomassKg * COD_PER_VSS;
  const invN = input.inventory?.nKg ?? biomassKg * N_PER_BIOMASS;
  const invP = input.inventory?.pKg ?? biomassKg * P_PER_BIOMASS;
  const inv = state.inventory;

  // 库存变化按期末−期初的代数差累计（允许为负：库存净消耗时记负项），种子首步不记增量
  const invCodDelta = inv.seeded ? invCod - inv.previousCodKg : 0;
  const invNDelta = inv.seeded ? invN - inv.previousNKg : 0;
  const invPDelta = inv.seeded ? invP - inv.previousPKg : 0;
  inv.biomassKg = biomassKg;
  inv.codKg = invCod;
  inv.nKg = invN;
  inv.pKg = invP;

  // 沼液回流负荷（关闭时为零）
  const filtrate: SludgeFiltrate = sludge.dewatering.filtrate;
  const recycleCodKg = loadKg(filtrate.codKgM3, filtrate.flowM3h, dtH);
  const recycleNKg = loadKg(filtrate.nh4NKgM3, filtrate.flowM3h, dtH);
  const recyclePKg = loadKg(filtrate.tpKgM3, filtrate.flowM3h, dtH);

  // 排泥带走的 COD/N/P（干固体口径）
  const wastedCodKg = wastedDryKg * COD_PER_VSS;
  const wastedNKg = wastedDryKg * N_PER_BIOMASS;
  const wastedPKg = wastedDryKg * P_PER_BIOMASS;

  const codIn = loadKg(influent.cod, influent.flow, dtH);
  const codEff = loadKg(effluent.cod, effluent.flow, dtH);
  const nIn = loadKg(influent.tn, influent.flow, dtH);
  const nEff = loadKg(effluent.tn, effluent.flow, dtH);
  const pIn = loadKg(influent.tp, influent.flow, dtH);
  const pEff = loadKg(effluent.tp, effluent.flow, dtH);

  // 独立通量（kg/步）：氧化 COD 由 OUR 折算；反硝化 N 由 NO₃ 还原通量积分
  const oxidizedCodKg = Math.max(0, input.oxidizedCodKgH ?? 0) * dtH;
  const denitrifiedNKg = Math.max(0, input.denitrifiedNKgH ?? 0) * dtH;

  const cod = state.balance.cod;
  cod.inflowKg += codIn;
  cod.effluentKg += codEff;
  cod.wastedKg += wastedCodKg;
  cod.recycleKg += recycleCodKg;
  cod.inventoryChangeKg += invCodDelta;
  cod.oxidizedKg += oxidizedCodKg;
  // 沼气 COD 当量（仅 COD 账）
  const methaneKgD = sludge.digester.gas.methaneKgD;
  cod.methaneCodKg += methaneKgD * COD_PER_CH4_KG * (dtH / 24);

  const n = state.balance.n;
  n.inflowKg += nIn;
  n.effluentKg += nEff;
  n.wastedKg += wastedNKg;
  n.recycleKg += recycleNKg;
  n.inventoryChangeKg += invNDelta;
  n.denitrifiedKg += denitrifiedNKg;

  const p = state.balance.p;
  p.inflowKg += pIn;
  p.effluentKg += pEff;
  p.wastedKg += wastedPKg;
  p.recycleKg += recyclePKg;
  p.inventoryChangeKg += invPDelta;

  finalizeRow(cod);
  finalizeRow(n);
  finalizeRow(p);

  inv.previousCodKg = invCod;
  inv.previousNKg = invN;
  inv.previousPKg = invP;
  inv.seeded = true;

  if (!cod.closed || !n.closed || !p.closed) {
    recordPlantError(
      state,
      PLANT_ERRORS.PLANT_BALANCE_UNCLOSED,
      `质量平衡残差超阈值：COD ${(cod.residualPct * 100).toFixed(1)}%，N ${(n.residualPct * 100).toFixed(1)}%，P ${(p.residualPct * 100).toFixed(1)}%`,
    );
  }
}

/** 深拷贝全厂边界状态（预测克隆用）。 */
export function clonePlantBoundary(state: PlantBoundaryState): PlantBoundaryState {
  return {
    ...state,
    sludgeLine: cloneSludgeLine(state.sludgeLine),
    balance: {
      cod: { ...state.balance.cod },
      n: { ...state.balance.n },
      p: { ...state.balance.p },
    },
    inventory: { ...state.inventory },
    errors: state.errors.map((e) => ({ ...e })),
  };
}

// ── 快照投影（契约 §3：投影函数独立导出，不写进视图层匿名表达式） ──

export interface PlantBoundarySnapshot {
  enabled: boolean;
  balance: { cod: BalanceRow; n: BalanceRow; p: BalanceRow };
  sludgeLine: {
    enabled: boolean;
    thickener: { feedFlowM3h: number; underflowFlowM3h: number; supernatantFlowM3h: number; underflowSsKgM3: number };
    digester: {
      volumeM3: number;
      temperatureC: number;
      srtDays: number;
      gas: DigesterGasSnapshot;
    };
    dewatering: { cakeDrySolidsKgD: number; cakeWetKgD: number; filtrate: SludgeFiltrate };
    cumulative: SludgeLineState['cumulative'];
  };
  errors: { code: string; message: string }[];
}

export interface DigesterGasSnapshot {
  methaneM3d: number;
  co2M3d: number;
  totalM3d: number;
  ch4Fraction: number;
  methaneKgD: number;
  vssDestroyedKgD: number;
  heatingKw: number;
  mixingKw: number;
}

const round3 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

function roundRow(row: BalanceRow): BalanceRow {
  return {
    inflowKg: round3(row.inflowKg),
    effluentKg: round3(row.effluentKg),
    wastedKg: round3(row.wastedKg),
    methaneCodKg: round3(row.methaneCodKg),
    oxidizedKg: round3(row.oxidizedKg),
    denitrifiedKg: round3(row.denitrifiedKg),
    inventoryChangeKg: round3(row.inventoryChangeKg),
    recycleKg: round3(row.recycleKg),
    residualKg: round3(row.residualKg),
    residualPct: round3(row.residualPct),
    closed: row.closed,
  };
}

export function plantView(state: PlantBoundaryState | undefined): PlantBoundarySnapshot | undefined {
  if (!state) return undefined;
  const sludge = state.sludgeLine;
  return {
    enabled: state.enabled,
    balance: { cod: roundRow(state.balance.cod), n: roundRow(state.balance.n), p: roundRow(state.balance.p) },
    sludgeLine: {
      enabled: sludge.enabled,
      thickener: {
        feedFlowM3h: round3(sludge.thickener.feedFlowM3h),
        underflowFlowM3h: round3(sludge.thickener.underflowFlowM3h),
        supernatantFlowM3h: round3(sludge.thickener.supernatantFlowM3h),
        underflowSsKgM3: round3(sludge.thickener.underflowSsKgM3),
      },
      digester: {
        volumeM3: round3(sludge.digester.volumeM3),
        temperatureC: round3(sludge.digester.temperatureC),
        srtDays: round3(sludge.digester.srtDays),
        gas: {
          methaneM3d: round3(sludge.digester.gas.methaneM3d),
          co2M3d: round3(sludge.digester.gas.co2M3d),
          totalM3d: round3(sludge.digester.gas.totalM3d),
          ch4Fraction: round3(sludge.digester.gas.ch4Fraction),
          methaneKgD: round3(sludge.digester.gas.methaneKgD),
          vssDestroyedKgD: round3(sludge.digester.gas.vssDestroyedKgD),
          heatingKw: round3(sludge.digester.gas.heatingKw),
          mixingKw: round3(sludge.digester.gas.mixingKw),
        },
      },
      dewatering: {
        cakeDrySolidsKgD: round3(sludge.dewatering.cakeDrySolidsKgD),
        cakeWetKgD: round3(sludge.dewatering.cakeWetKgD),
        filtrate: {
          flowM3h: round3(sludge.dewatering.filtrate.flowM3h),
          nh4NKgM3: round3(sludge.dewatering.filtrate.nh4NKgM3),
          codKgM3: round3(sludge.dewatering.filtrate.codKgM3),
          tpKgM3: round3(sludge.dewatering.filtrate.tpKgM3),
        },
      },
      cumulative: { ...sludge.cumulative },
    },
    errors: state.errors.map((e) => ({ ...e })),
  };
}

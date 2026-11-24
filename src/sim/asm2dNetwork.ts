/**
 * WP2 网络级 ASM2d 求解器：逐池 19 组分 CSTR 积分。
 *
 * 与单池 `stepAsm2dCstr` 的区别：
 * - 入流按拓扑边流量加权混合（上游出流 / 内回流 / RAS / 厂外来水），不是全池同浓度；
 * - 反应项用 ASM2d 速率骨架（`buildAsm2dRates` + 化学计量矩阵），速率常数按 d⁻¹ 给出，
 *   积分前换算到 h⁻¹；必要时按 ≤1 min 子步做显式欧拉，先跑稳定性探针再定子步数；
 * - 二沉池颗粒态回流由 Takács 底流浓度浓缩后回到首池；MLSS / 生物量存量全部从
 *   ASM2d 组分汇总，不再用经验 biomassKg 反向覆盖组分。
 *
 * 本模块不做结果投影：反应器持有的 `asm2d` 状态就是被积分的状态向量，聚合量
 * （COD/NH/NO3/TP/DO/碱度）只是它的导出视图。
 */

import {
  ASM2D_COMPONENTS,
  ASM2D_PARAMS,
  ASM2D_PROCESSES,
  buildAsm2dRates,
  buildAsm2dStoichiometry,
  emptyAsm2dState,
  fromAsm2d,
  influentToAsm2d,
  toAsm2d,
  type Asm2dComponent,
  type Asm2dState,
} from './asm2d';
import { COD_PER_VSS } from './units';
import { stepAeration } from './aeration';
import type { CompiledEdge, CompiledNetwork, ReactorKind } from './network';
import type { ReactorState } from './networkTypes';

/** ASM2d 工程边界：越界钳制到上限，负值/非有限归 0（诊断由引擎侧记录）。 */
const BOUNDS: Record<string, number> = {
  S_I: 500,
  S_F: 500,
  S_A: 300,
  S_NH4: 120,
  S_N2: 200,
  S_NO3: 120,
  S_PO4: 30,
  S_O: 10,
  S_ALK: 200,
  X_I: 20000,
  X_S: 20000,
  X_H: 15000,
  X_PAO: 15000,
  X_AUT: 15000,
  X_PP: 5000,
  X_PHA: 5000,
  X_TSS: 20000,
  X_MEP: 5000,
  X_MEOH: 1000,
};

/** 颗粒态组分（参与 RAS 浓缩缩放与固体汇总）。 */
const PARTICULATE: Asm2dComponent[] = ['X_I', 'X_S', 'X_H', 'X_PAO', 'X_AUT', 'X_PP', 'X_PHA', 'X_MEP'];

/** 生物除磷关闭时被抑制的 PAO 过程。 */
const PAO_PROCESSES = new Set([
  'aerobic_growth_PAO',
  'anoxic_growth_PAO',
  'storage_PHA_anaerobic',
  'storage_PHA_anoxic',
  'storage_PHA_aerobic',
  'lysis_PAO',
  'hydrolysis_PP',
]);

/** 按温度分档缓存速率闭包，避免每池每步重建。 */
const RATE_CACHE = new Map<number, ReturnType<typeof buildAsm2dRates>>();
function ratesAt(temperatureC: number) {
  const key = Math.round(temperatureC * 10) / 10;
  const cached = RATE_CACHE.get(key);
  if (cached) return cached;
  const built = buildAsm2dRates(ASM2D_PARAMS, key);
  RATE_CACHE.set(key, built);
  return built;
}

export interface Asm2dNetworkFluxes {
  /** 需氧 kg O₂/h（异养 + 硝化合计，用于风机需求） */
  o2DemandKgH: number;
  /** 异养/PAO 生长 + 内源耗氧 kg O₂/h（计入 COD 氧化） */
  o2HeteroKgH: number;
  /** 自养硝化耗氧 kg O₂/h（单独一行，不计入 COD 氧化） */
  o2NitroKgH: number;
  /** 实际曝气传递到水中的氧 kg O₂/h */
  o2TransferredKgH: number;
  /** 硝化氧化的 NH₄-N kg N/h */
  nhOxidizedKgH: number;
  /** 反硝化还原的 NO₃-N kg N/h（N₂ 去向） */
  denitrifiedNKgH: number;
  /** 内源呼吸衰减耗氧折算的 COD kg COD/h（b_H/b_PAO/b_AUT 溶解，扣 f_p 残余） */
  endogenousOxKgH: number;
  /** 系统内活体生物量 COD 存量 kg（X_H+X_PAO+X_AUT） */
  biomassCodKg: number;
  /** 本步触发越界钳制的反应器数（诊断用） */
  clampedCount: number;
  /** 组分钳制丢失的 COD/N/P 当量 kg/h（数值守恒项，不是工艺去除） */
  clampCodKgH: number;
  clampNKgH: number;
  clampPKgH: number;
}

export interface StepAsm2dNetworkArgs {
  reactors: ReactorState[];
  byId: Map<string, ReactorState>;
  net: CompiledNetwork;
  edgeFlow: Map<string, number>;
  influent: { flow: number; cod: number; nh: number; tn: number; tp: number; ss: number; alkalinity: number };
  /** Takács 底流浓度 g/m³，用于 RAS 颗粒态浓缩缩放 */
  xRas: number;
  /** 混合液生物量固体浓度 g/m³（首次初始化组分时播种生物量用） */
  xBiomass: number;
  temperatureC: number;
  dtH: number;
  bioP: boolean;
  carbonDose: number;
  aerationCapacity: number;
  doSetpoint: number;
  /** 毒性抑制因子 0–1 */
  suppression: number;
}

function clampComponent(c: Asm2dComponent, v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  const bound = BOUNDS[c] ?? 20000;
  return Math.min(bound, v);
}

/** 按边流量加权混合入流 ASM2d 状态。 */
function mixInflow(
  incoming: CompiledEdge[],
  edgeFlow: Map<string, number>,
  byId: Map<string, ReactorState>,
  last: ReactorState | undefined,
  xRas: number,
  influent: StepAsm2dNetworkArgs['influent'],
): { qIn: number; asmIn: Asm2dState } {
  let qIn = 0;
  let asmIn = emptyAsm2dState();

  // RAS 浓缩倍数：底流浓度（固体 g/m³）× 1.42 折成 COD，再除以末端池颗粒态 COD，
  // 限制在 1–6，避免浓缩倍数被量纲错配放大。
  const feedParticulate = last?.asm2d ? PARTICULATE.reduce((s, c) => s + last.asm2d![c], 0) : 0;
  const rasRatio = feedParticulate > 1 ? Math.max(2.15, Math.min(6, (xRas * COD_PER_VSS) / feedParticulate)) : 2.15;
  for (const edge of incoming) {
    const flow = edgeFlow.get(edge.id) ?? 0;
    if (flow <= 0) continue;
    let src: Asm2dState;
    if (edge.recycleKind === 'ras' && last?.asm2d) {
      const base = last.asm2d;
      src = { ...base };
      for (const c of PARTICULATE) src[c] = base[c] * rasRatio;
      // 二沉池底流按缺氧/无溶解氧处理：RAS 携带的好氧末段硝酸盐在二沉池内反硝化，
      // 不回流到厌氧池抑制 PAO 的 PHA 储存；固体生物量照常回流量级。
      src.S_NO3 = 0;
      src.S_O = 0;
    } else if (edge.recycleKind === 'internal' && last?.asm2d) {
      src = last.asm2d;
    } else if (byId.has(edge.from) && byId.get(edge.from)!.asm2d) {
      src = byId.get(edge.from)!.asm2d!;
    } else {
      src = influentToAsm2d({
        cod: influent.cod,
        nh: influent.nh,
        // 城市原水硝酸盐近 0：tn−nh 的余量是溶解性有机氮（骨架未单列组分），
        // 不应记成 NO₃ 进厌氧池抑制 PAO 储存。
        no3: 0,
        tp: influent.tp,
        ss: influent.ss,
        alkalinity: influent.alkalinity,
      });
    }

    if (qIn === 0) {
      asmIn = { ...src };
    } else {
      for (const c of ASM2D_COMPONENTS) {
        asmIn[c] = (asmIn[c] * qIn + src[c] * flow) / (qIn + flow);
      }
    }
    qIn += flow;
  }
  return { qIn, asmIn };
}

/**
 * 过程不再按池型硬门控。
 *
 * 旧实现把好氧生长只放在 aerobic、反硝化只放在 anoxic，结果内回流把 DO
 * 带回缺氧池时，池内没有好氧生长去消耗它，DO 一路累积到 3–8 mg/L，
 * 反硝化的氧抑制项被打开，TN 反而降不下去。ASM2d 本身用 Monod/开关函数
 * 表达电子受体竞争；池型只决定初始条件，不应替化学做门控。
 *
 * 因此所有过程在所有池型都参与速率计算，由 S_O / S_NO3 / S_A 的实际浓度
 * 决定通量。唯一保留的是衰减过程集合，用于内源呼吸通量统计。
 */
const LYSIS_PROCS = new Set(['lysis_XH', 'lysis_PAO', 'lysis_AUT']);
/** 衰减生物量中非生物降解残余分数（f_p），其余按内源呼吸计入氧化。 */
const ENDOGENOUS_F_P = 0.2;

/**
 * 计算反应速率向量（d⁻¹ 口径：参数表常数是 d⁻¹，网络积分时按 dt/d 换算；
 * 单池 `stepAsm2dCstr` 保留其自身的工程化尺度，不受这里影响），
 * 并按过程汇总需氧/硝化/反硝化/内源衰减通量（g/m³/d）。
 */
function reactionVector(
  s: Asm2dState,
  rates: ReturnType<typeof buildAsm2dRates>,
  stoich: ReturnType<typeof buildAsm2dStoichiometry>,
  bioP: boolean,
  suppression: number,
  kind: ReactorKind,
): {
  vector: Partial<Record<Asm2dComponent, number>>;
  /** 异养/PAO 生长 + 好氧吸磷耗氧 gO₂/m³/d（计入 COD 氧化） */
  o2Hetero: number;
  /** 自养硝化耗氧 gO₂/m³/d（单独一行，不计入 COD 氧化） */
  o2Nitro: number;
  nhUptake: number;
  no3Reduction: number;
  endogenousCod: number;
} {
  const vector: Partial<Record<Asm2dComponent, number>> = {};
  let o2Hetero = 0;
  let o2Nitro = 0;
  let nhUptake = 0;
  let no3Reduction = 0;
  let endogenousCod = 0;
  // 异养生长 uptake 的 S_A（用于按 S_A/S_F 比例分担到 S_F）
  let xhSaUptake = 0;

  // 骨架异养生长 monod 只看 S_A；网络级把 S_F 也计入可利用基质，供速率估算用。
  const substrateProxy: Asm2dState = { ...s, S_A: s.S_A + s.S_F };
  const xhProcs = new Set(['aerobic_growth_XH', 'anoxic_growth_XH']);

  for (const proc of ASM2D_PROCESSES) {
    // 池型不再硬门控；速率函数中的 Monod/开关项决定该过程是否发生。
    if (!bioP && PAO_PROCESSES.has(proc)) continue;
    const rateDay = rates[proc](xhProcs.has(proc) ? substrateProxy : s);
    if (!Number.isFinite(rateDay) || rateDay <= 0) continue;
    // 毒性抑制：自养/PAO 比异养更敏感（与 ASM1 口径一致）
    const toxic =
      proc === 'aerobic_growth_AUT' || proc.startsWith('aerobic_growth_PAO')
        ? Math.max(0, suppression) ** 2
        : Math.sqrt(Math.max(0, suppression));
    const rate = rateDay * toxic;
    const coeff = stoich[proc];
    for (const [comp, k] of Object.entries(coeff) as [Asm2dComponent, number][]) {
      vector[comp] = (vector[comp] ?? 0) + k * rate;
    }
    if (xhProcs.has(proc) && (coeff.S_A ?? 0) < 0) xhSaUptake += -(coeff.S_A ?? 0) * rate;
    if (coeff.S_O !== undefined && coeff.S_O < 0) {
      const o2Proc = -coeff.S_O * rate;
      if (proc === 'aerobic_growth_AUT') o2Nitro += o2Proc;
      else o2Hetero += o2Proc;
    }
    if (proc === 'aerobic_growth_AUT' && coeff.S_NH4 !== undefined) nhUptake += -coeff.S_NH4 * rate;
    if (coeff.S_NO3 !== undefined && coeff.S_NO3 < 0) no3Reduction += -coeff.S_NO3 * rate;
    if (LYSIS_PROCS.has(proc)) {
      // 溶解流失的活体生物量 COD：扣除不可降解残余 f_p，其余按内源呼吸耗氧入账
      const lysisComp = proc === 'lysis_XH' ? 'X_H' : proc === 'lysis_PAO' ? 'X_PAO' : 'X_AUT';
      endogenousCod += Math.max(0, -(coeff[lysisComp] ?? 0)) * rate;
    }
  }

  // 网络级补充过程：溶解性发酵（S_F → S_A）。
  // 骨架 19 过程未单列发酵，而 A²/O 缺氧反硝化与 PAO 厌氧储存都依赖 S_A(VFA)；
  // 没有发酵时 S_F 在池内累积、S_A 被耗尽，异养菌与 PAO 都会饿死。该过程只在
  // 厌氧/缺氧条件下进行，COD 1:1 守恒，速率取参数表预留的 q_fe（d⁻¹）。
  if (s.S_O < ASM2D_PARAMS.K_O2) {
    const ferm =
      ASM2D_PARAMS.q_fe *
      (s.S_F / (ASM2D_PARAMS.K_F + s.S_F + 1e-6)) *
      (ASM2D_PARAMS.K_O2 / (ASM2D_PARAMS.K_O2 + s.S_O + 1e-6));
    vector.S_F = (vector.S_F ?? 0) - ferm;
    vector.S_A = (vector.S_A ?? 0) + ferm;
    // S_F 携带 i_N_SI 有机氮；发酵成 S_A 时氮释放为氨氮，不能把 N 留在 S_F 里消失。
    vector.S_NH4 = (vector.S_NH4 ?? 0) + ferm * ASM2D_PARAMS.i_N_SI;
  }

  // 好氧吸磷（网络级补充过程）：骨架 19 过程未单列独立的聚磷酸盐储存步骤，
  // PAO 好氧段以胞内 PHA 为能源/碳源，吸收溶液态正磷合成 X_PP；与厌氧段
  // S_A→X_PHA 释磷储存构成「厌氧释磷 / 好氧吸磷」循环。仅好氧、生物除磷开启时发生。
  if (kind === 'aerobic' && bioP && s.X_PAO > 1e-6) {
    const phaLim =
      0.1 + 0.9 * (Math.max(0, s.X_PHA - 0.01) / (ASM2D_PARAMS.K_PHA + Math.max(0, s.X_PHA - 0.01) + 1e-6));
    const po4Lim = s.S_PO4 / (ASM2D_PARAMS.K_P + s.S_PO4 + 1e-6);
    const uptake = ASM2D_PARAMS.q_PP * s.X_PAO * phaLim * po4Lim;
    if (uptake > 1e-6) {
      vector.X_PP = (vector.X_PP ?? 0) + uptake;
      vector.X_PHA = (vector.X_PHA ?? 0) - uptake / ASM2D_PARAMS.Y_PAO;
      vector.S_PO4 = (vector.S_PO4 ?? 0) - uptake * ASM2D_PARAMS.i_P_PP;
      // 吸磷消耗的是胞内 PHA 的 COD；按 1 g COD ≡ 1 g O₂ 计入 COD 氧化账。
      const o2Demand = uptake / ASM2D_PARAMS.Y_PAO;
      vector.S_O = (vector.S_O ?? 0) - o2Demand;
      o2Hetero += o2Demand;
    }
  }

  // 骨架把异养生长基质简化为 S_A；网络级补充：S_F 按现有浓度比例分担一部分 uptake。
  if (xhSaUptake > 1e-6) {
    const substrateTotal = s.S_A + s.S_F;
    const sfFraction = substrateTotal > 1e-6 ? s.S_F / substrateTotal : 0.5;
    const shift = xhSaUptake * sfFraction;
    vector.S_A = (vector.S_A ?? 0) + shift;
    vector.S_F = (vector.S_F ?? 0) - shift;
    // S_A 不带有机氮，把 S_A 记成 S_F 时相当于生成 S_F 的有机氮，必须释放同量氨氮，
    // 否则每步都会凭空消耗 shift × i_N_SI 的氮（曾导致 N 残差 60%）。
    vector.S_NH4 = (vector.S_NH4 ?? 0) + shift * ASM2D_PARAMS.i_N_SI;
  }
  return { vector, o2Hetero, o2Nitro, nhUptake, no3Reduction, endogenousCod };
}

export function stepAsm2dNetwork(args: StepAsm2dNetworkArgs): Asm2dNetworkFluxes {
  const {
    reactors,
    byId,
    net,
    edgeFlow,
    influent,
    xRas,
    xBiomass,
    temperatureC,
    dtH,
    bioP: requestedBioP,
    carbonDose,
    aerationCapacity,
    doSetpoint,
    suppression,
  } = args;

  // 没有厌氧选择器的拓扑（厌氧旁路）不能维持 PAO 的厌氧释磷/好氧吸磷循环；
  // 此时强制关闭生物除磷，避免在缺氧池继续合成 X_PHA 造成假阳性。
  const bioP = requestedBioP && net.order.some((id) => byId.get(id)?.kind === 'anaerobic');
  const rates = ratesAt(temperatureC);
  const stoich = buildAsm2dStoichiometry(ASM2D_PARAMS);

  let o2DemandKgH = 0;
  let o2HeteroKgH = 0;
  let o2NitroKgH = 0;
  let o2TransferredKgH = 0;
  let nhOxidizedKgH = 0;
  let denitrifiedNKgH = 0;
  let clampCodKgH = 0;
  let clampNKgH = 0;
  let clampPKgH = 0;
  let endogenousOxKgH = 0;
  let biomassCodKg = 0;
  let clampedCount = 0;

  // 子步：显式欧拉在高浓度一级反应下需要小步长；1 min 为上限，按步长等分。
  const subHours = Math.min(1 / 120, dtH);
  const nSub = Math.max(1, Math.min(120, Math.ceil(dtH / subHours)));
  const subDt = dtH / nSub;

  for (const id of net.order) {
    const reactor = byId.get(id);
    if (!reactor) continue;
    if (!reactor.asm2d) {
      // 首次初始化：颗粒/溶解组分由聚合量映射；活体生物量直接按 xBiomass（设计 MLSS）
      // 播种，不被反应器初始 COD  cap 住——否则各生长速率正比于生物量、从零起步长不出来。
      const seeded = toAsm2d({
        cod: reactor.cod,
        nh: reactor.nh,
        no3: reactor.no3,
        tp: reactor.tp,
        doLevel: reactor.doLevel,
        alkalinity: reactor.alkalinity,
        mlss: xBiomass,
      });
      const biomassCod = xBiomass * COD_PER_VSS;
      seeded.X_H = biomassCod * 0.7;
      seeded.X_AUT = biomassCod * 0.15;
      if (bioP) {
        seeded.X_PAO = Math.max(350, biomassCod * 0.15);
        seeded.X_PP = Math.max(80, biomassCod * 0.15 * 0.25);
        seeded.X_PHA = Math.max(30, biomassCod * 0.15 * 0.15);
      } else {
        seeded.X_PAO = 0;
        seeded.X_PP = 0;
        seeded.X_PHA = 0;
      }
      reactor.asm2d = seeded;
    }

    const incoming = net.incomingByReactor[id] ?? [];
    const last = reactors[reactors.length - 1];
    const { qIn, asmIn } = mixInflow(incoming, edgeFlow, byId, last, xRas, influent);
    if (reactor.kind === 'anoxic' && carbonDose > 0) {
      asmIn.S_A += carbonDose;
    }

    const qOverV = qIn / Math.max(1e-9, reactor.volume);
    const subDtDays = subDt / 24;
    const state: Asm2dState = { ...reactor.asm2d };
    let reactorClamped = false;
    // 本步反应质量（kg），子步累加后再折成 kg/h 通量
    let o2HeteroMassKg = 0;
    let o2NitroMassKg = 0;
    let nhMassKg = 0;
    let no3MassKg = 0;
    let endoMassKg = 0;
    let clampCodMassKg = 0;
    let clampNMassKg = 0;
    let clampPMassKg = 0;

    for (let sub = 0; sub < nSub; sub++) {
      // 好氧池在子步内按设定 DO 维持溶解氧（风机跟踪设定值）；否则首个子步耗尽
      // 残留 O₂ 后，后续子步好氧生长/硝化 monod(O₂) 全为 0，反应只在第一子步发生。
      if (reactor.kind === 'aerobic' && aerationCapacity > 0.02) {
        state.S_O = doSetpoint;
      }
      const { vector, o2Hetero, o2Nitro, nhUptake, no3Reduction, endogenousCod } = reactionVector(
        state,
        rates,
        stoich,
        bioP,
        suppression,
        reactor.kind,
      );
      for (const comp of ASM2D_COMPONENTS) {
        const advect = qOverV * subDt * (asmIn[comp] - state[comp]);
        const react = (vector[comp] ?? 0) * subDtDays;
        const rawNext = state[comp] + advect + react;
        let next = clampComponent(comp, rawNext);
        // 胞内储存池数值下限：显式积分在 1–3 min 子步内可能穿越零；仅保留极小的
        // 代谢池（0.05 gCOD/m³ PHA、0.1 gP/m³ PP），对质量平衡影响 <0.1%。
        if (bioP && comp === 'X_PHA') next = Math.max(0.05, next);
        if (bioP && comp === 'X_PP') next = Math.max(0.1, next);
        // 显式欧拉 + 非负钳制会把越过 0 的物料直接丢掉；把这份数值损失单独计量，
        // 否则质量平衡会出现“凭空消失”的 COD/N/P 残差。
        const loss = state[comp] + advect + react - next;
        if (loss < -1e-12) {
          const lost = -loss;
          if (
            comp === 'S_NH4' ||
            comp === 'S_NO3' ||
            comp === 'S_N2' ||
            comp === 'S_F' ||
            comp === 'X_S' ||
            comp === 'X_I' ||
            comp === 'X_H' ||
            comp === 'X_PAO' ||
            comp === 'X_AUT'
          ) {
            clampNMassKg +=
              (lost *
                (comp === 'S_NH4' || comp === 'S_NO3' || comp === 'S_N2'
                  ? 1
                  : comp === 'S_F'
                    ? ASM2D_PARAMS.i_N_SI
                    : comp === 'X_S' || comp === 'X_I'
                      ? ASM2D_PARAMS.i_N_XS
                      : ASM2D_PARAMS.i_N_BM) *
                reactor.volume *
                subDtDays) /
              1000;
          }
          if (
            comp === 'S_PO4' ||
            comp === 'X_PP' ||
            comp === 'X_S' ||
            comp === 'X_H' ||
            comp === 'X_PAO' ||
            comp === 'X_AUT' ||
            comp === 'X_MEP'
          ) {
            clampPMassKg +=
              (lost *
                (comp === 'S_PO4' || comp === 'X_MEP'
                  ? 1
                  : comp === 'X_PP'
                    ? ASM2D_PARAMS.i_P_PP
                    : comp === 'X_S'
                      ? ASM2D_PARAMS.i_P_XS
                      : ASM2D_PARAMS.i_P_BM) *
                reactor.volume *
                subDtDays) /
              1000;
          }
          if (
            comp === 'S_I' ||
            comp === 'S_F' ||
            comp === 'S_A' ||
            comp === 'X_I' ||
            comp === 'X_S' ||
            comp === 'X_H' ||
            comp === 'X_PAO' ||
            comp === 'X_AUT' ||
            comp === 'X_PHA'
          ) {
            clampCodMassKg += (lost * reactor.volume * subDtDays) / 1000;
          }
        }
        if (next !== state[comp]) reactorClamped = true;
        state[comp] = next;
      }
      o2HeteroMassKg += (o2Hetero * reactor.volume * subDtDays) / 1000;
      o2NitroMassKg += (o2Nitro * reactor.volume * subDtDays) / 1000;
      nhMassKg += (nhUptake * reactor.volume * subDtDays) / 1000;
      no3MassKg += (no3Reduction * reactor.volume * subDtDays) / 1000;
      endoMassKg += (endogenousCod * (1 - ENDOGENOUS_F_P) * reactor.volume * subDtDays) / 1000;
    }

    const stepHours = Math.max(1e-9, dtH);
    clampCodKgH += clampCodMassKg / stepHours;
    clampNKgH += clampNMassKg / stepHours;
    clampPKgH += clampPMassKg / stepHours;
    o2DemandKgH += (o2HeteroMassKg + o2NitroMassKg) / stepHours;
    o2HeteroKgH += o2HeteroMassKg / stepHours;
    o2NitroKgH += o2NitroMassKg / stepHours;
    nhOxidizedKgH += nhMassKg / stepHours;
    denitrifiedNKgH += no3MassKg / stepHours;
    endogenousOxKgH += endoMassKg / stepHours;

    // 本步平均需氧率（g O₂/m³/h）：用整步子步累计质量折算，不能取末子步瞬时值——
    // 末子步基质已耗尽，瞬时需氧≈0 会让前馈失效、KLa 维持高位、DO 顶到上限。
    const totalO2MassKg = o2HeteroMassKg + o2NitroMassKg;
    const ourH = (totalO2MassKg * 1000) / Math.max(1e-9, reactor.volume) / stepHours;
    if (reactor.kind === 'aerobic' && aerationCapacity > 0.02) {
      const aeration = stepAeration({
        volume: reactor.volume,
        temperatureC,
        doLevel: state.S_O,
        o2Demand: Math.max(0, ourH),
        doSetpoint,
        capacity: aerationCapacity,
        previousKla: reactor.kla ?? 0,
        previousIntegral: reactor.doIntegral ?? 0,
        dtH,
      });
      state.S_O = aeration.doLevel;
      reactor.kla = aeration.kla;
      reactor.doIntegral = aeration.integral;
      o2TransferredKgH += aeration.o2TransferredKgH;
    } else {
      reactor.kla = 0;
      reactor.doIntegral = 0;
      state.S_O = Math.max(0.02, state.S_O - dtH * 0.5);
    }

    reactor.asm2d = state;
    if (reactorClamped) clampedCount += 1;

    // 聚合量导出视图（不反向覆盖组分）
    const agg = fromAsm2d(state);
    reactor.cod = Math.max(2, agg.cod);
    reactor.nh = Math.max(0.01, agg.nh);
    reactor.no3 = Math.max(0.01, agg.no3);
    reactor.tp = Math.max(0.005, agg.tp);
    reactor.doLevel = agg.doLevel;
    reactor.alkalinity = agg.alkalinity;
    reactor.o2Demand = Math.max(0, ourH);

    biomassCodKg += ((state.X_H + state.X_PAO + state.X_AUT) * reactor.volume) / 1000;
  }

  return {
    o2DemandKgH,
    o2HeteroKgH,
    o2NitroKgH,
    o2TransferredKgH,
    nhOxidizedKgH,
    denitrifiedNKgH,
    clampCodKgH,
    clampNKgH,
    clampPKgH,
    endogenousOxKgH,
    biomassCodKg,
    clampedCount,
  };
}

/** 二沉池进料固体（g VSS/m³）：活体生物量 + 惰性/慢降解颗粒，PP/PHA 胞内聚合物不计入进料固体。 */
export function asm2dFeedSolids(s: Asm2dState): number {
  const cod = s.X_I + s.X_S + s.X_H + s.X_PAO + s.X_AUT;
  return cod / COD_PER_VSS;
}

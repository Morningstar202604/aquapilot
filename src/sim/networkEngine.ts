import { ControlSettings, DEFAULT_CONTROLS, INFLUENT_DESIGN, PLANT } from './config';

import { mulberry32 } from './rng';
import { sampleAt } from './influentSeries';
import { ScenarioSpec, SCENARIOS } from './scenarios';
import { CompiledNetwork, compileNetwork, resolveFlows, type CompiledEdge, type FlowBranchHydraulics } from './network';
import { networkSnapshot, PlantModel } from './plantModel';
import { clampControls, effluentMarginRows, qualityScore } from './metrics';
import { KINETICS, DESIGN_MLSS, TARIFF } from './kinetics';
import { BSM1_SETTLER, createSettler, stepSettler } from './takacs';
import type { NetworkSimState, ReactorState, KineticModel } from './networkTypes';
import type { NetworkStepTrace, NetworkTraceHook } from './networkTrace';
export type { NetworkSimState, ReactorState, EffluentStats, KineticModel } from './networkTypes';
export type { NetworkStepTrace, NetworkTraceHook } from './networkTrace';
import {
  aerationCapacityOf,
  diurnal,
  mixed,
  recycleFactors,
  scenarioEnvelope,
  seasonalTemperature,
  toxicSuppression,
} from './forcing';
import { evaluateAlarms } from './alarmRules';
import {
  ASM1_COMPONENTS,
  ASM1_PARAMS,
  ASM1_PROCESSES,
  buildRates,
  buildStoichiometry,
  emptyAsm1State,
  phFromAlkalinity,
  processInhibition,
  type Asm1Component,
  type Asm1State,
} from './asm1';
import { fromAsm1, influentToAsm1, toAsm1 } from './asm1Mapping';
import { stepAsm2dNetwork, asm2dFeedSolids } from './asm2dNetwork';
import {
  ASM2D_PARAMS,
  asm2dCodConcentration,
  asm2dNConcentration,
  asm2dPConcentration,
  influentToAsm2d,
} from './asm2d';
import { COD_PER_VSS } from './units';
import {
  clonePlantBoundary,
  createPlantBoundary,
  PLANT_ERRORS,
  recordPlantError,
  resetPlantBoundary,
  updatePlantBalance,
} from './plantBoundary';
import { stepSludgeLine } from './sludgeLine';
import { stepAeration, totalBlowerPower } from './aeration';
import { createInstrumentationState, measure, measuredValue } from './instruments';
import { createControlLayer, evaluateInterlocks, stepLoop, applyEsdState, interlockActive } from './controlLayer';
import { createAssetStateFromTopology, tickAssets, capacityFactorFor } from './assets';
import { createFan, commandActuator } from './actuators';
import {
  cloneHydraulics,
  createHydraulics,
  refreshRtdMetrics,
  stepHydraulics,
  type HydraulicState,
} from './hydraulics';
import type { ClarifierState } from './networkTypes';

const STOICH = buildStoichiometry();

/**
 * 温度分档缓存。
 *
 * buildRates 会创建 8 个闭包；每池每步重建一次没有必要，而且温度是连续量。
 * 按 0.1 ℃ 分档缓存，既保留 Arrhenius 的连续效果，又把闭包创建限制在
 * 有限的温度点上。缓存键只含温度；pH/游离氨抑制在闭包外逐过程乘上去。
 */
const RATE_FNS_CACHE = new Map<number, ReturnType<typeof buildRates>>();
function rateFunctionsAt(temperatureC: number): ReturnType<typeof buildRates> {
  const key = Math.round(temperatureC * 10) / 10;
  const cached = RATE_FNS_CACHE.get(key);
  if (cached) return cached;
  const built = buildRates(ASM1_PARAMS, key);
  RATE_FNS_CACHE.set(key, built);
  return built;
}

/**
 * 带抑制的 ASM1 速率。
 *
 * 三层因子叠乘：
 *   1. 外部毒性 suppression（事故注入）；
 *   2. 自养/异养对毒性的不同敏感度；
 *   3. pH 与游离氨的过程级抑制（见 asm1.processInhibition）。
 *
 * 温度通过 rateFunctionsAt 进入所有 Arrhenius 速率常数，而不是只改显示值。
 */
function reactionRatesWithSuppression(s: Asm1State, suppression: number, temperatureC: number, ph: number): Asm1State {
  const rates = rateFunctionsAt(temperatureC);
  const out = emptyAsm1State();
  for (const proc of ASM1_PROCESSES) {
    const toxicFactor =
      suppression >= 0.999
        ? 1
        : proc === 'aerobic_growth_autotrophs' || proc === 'decay_autotrophs'
          ? Math.max(0, suppression) ** 2
          : Math.sqrt(Math.max(0, suppression));
    const inhibition = processInhibition(proc, s, ph, temperatureC);
    const rate = rates[proc](s) * ASM1_PARAMS.PER_DAY_TO_PER_HOUR * toxicFactor * inhibition;
    if (rate <= 0 || !Number.isFinite(rate)) continue;
    for (const [comp, coef] of Object.entries(STOICH[proc]) as [Asm1Component, number][]) {
      out[comp] += coef * rate;
    }
  }
  return out;
}

import { ProcessTopology } from '../model/topology';

/** 网络引擎控制基准：与参考实现不同的只有排泥比，其余沿用全局默认 */
export const NETWORK_CONTROL_DEFAULTS: ControlSettings = { ...DEFAULT_CONTROLS, wasRatio: 0.022 };

/** 构造单个二沉池状态（首池与多系列各池同构） */
function makeClarifier(area: number, depth: number): ClarifierState {
  return {
    area,
    depth,
    settler: createSettler({ ...BSM1_SETTLER, area, depth }, 3000),
    blanketM: 1.0,
    sludgeMassKg: 22000,
    xRas: 8600,
    xEff: 4,
    slr: 3.4,
  };
}

/**
 * 拓扑求解引擎（生产路径）。
 *
 * 反应器数量、容积、连接关系全部来自 ProcessTopology；引擎里没有"五个池"的假设。
 * 求解顺序由 network.ts 编译出的拓扑序决定，回流边每步按控制量定流量。
 *
 * 本文件是服务端、AI 决策、预测的唯一入口。
 * 早先的固定五池参考引擎已删除：它只被测试引用，留着只会让两套常数分叉。
 */

/**
 * 拓扑驱动的求解引擎（v2）。
 *
 * 与 v1 的本质区别：v1 的五个池是写死的；v2 的反应器由 CompiledNetwork 决定，
 * 拓扑里加一个缺氧池，这里就多解一个缺氧池，不需要改引擎代码。
 */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function createNetworkState(
  topo: ProcessTopology,
  options: {
    seed?: number;
    controls?: Partial<ControlSettings>;
    model?: KineticModel;
    /** WP2 泥线/全厂边界是否启用；默认关闭，ASM1 基准路径不变 */
    plantEnabled?: boolean;
    /** WP2 生物除磷开关；默认开启，关闭后 PAO 释磷/吸磷不参与，TP 仅靠 PAC */
    bioPRemoval?: boolean;
  } = {},
): NetworkSimState {
  const net = compileNetwork(topo);
  if (net.problems.length) throw new Error(`拓扑无法编译：${net.problems.join('；')}`);

  /**
   * 排泥比基准：Takács 二沉池的固体截留率显著高于原经验公式，
   * 同样的排泥量会导致 MLSS 持续上升。因此网络引擎使用独立的基准值。
   * 显式传入 controls.wasRatio 时以传入为准。
   */
  /**
   * 网络引擎的排泥基准与参考实现不同（Takács 截留率更高，需要更大排泥量），
   * 但**必须让调用方传入的所有控制量生效**——早先只采纳 wasRatio，
   * 其余被静默丢弃，导致"改 DO 设定"之类的测试实际测的是默认值（假通过）。
   */
  const controls: ControlSettings = clampControls({ ...NETWORK_CONTROL_DEFAULTS, ...options.controls });
  const clarifierStates: ClarifierState[] =
    net.clarifiers.length > 0
      ? net.clarifiers.map((c) => makeClarifier(c.area, c.depth))
      : [makeClarifier(PLANT.clarifier.area, PLANT.clarifier.depth)];
  const clarifier = clarifierStates[0];
  const hydraulics: HydraulicState = createHydraulics(net, INFLUENT_DESIGN.flow);
  const plant = createPlantBoundary(Boolean(options.plantEnabled));
  const instruments = createInstrumentationState(topo, { seed: options.seed ?? 20261019 });
  const controlLayer = createControlLayer({
    initialOutputs: { do: 1, ras: controls.rasRatio, was: controls.wasRatio },
  });
  const assets = createAssetStateFromTopology(topo, { seed: options.seed ?? 20261123 });

  const reactors: ReactorState[] = net.reactors.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    volume: r.volume,
    cod: r.kind === 'anaerobic' ? 90 : r.kind === 'aerobic' ? 30 : 40,
    nh: r.kind === 'aerobic' ? 4 : 22,
    no3: r.kind === 'anaerobic' ? 0.2 : 6,
    tp: r.kind === 'anaerobic' ? 6 : 1,
    doLevel: r.kind === 'aerobic' ? 2 : 0.08,
    alkalinity: 220,
    temperature: 20,
    o2Demand: 0,
    kla: 0,
    inflow: INFLUENT_DESIGN.flow,
  }));

  return {
    timeMin: 0,
    seed: options.seed ?? 20261019,
    rngCount: 0,
    topologyId: topo.id,
    modelMode: options.model ?? 'simple',
    bioPRemoval: options.bioPRemoval ?? true,
    reactors,
    order: [...net.reactors].sort((a, b) => a.order - b.order).map((r) => r.id),
    clarifier,
    clarifiers: clarifierStates,
    hydraulics,
    plant,
    instruments,
    controlLayer,
    assets,
    influent: { ...INFLUENT_DESIGN },
    effluent: {
      flow: INFLUENT_DESIGN.flow,
      cod: 30,
      bod: 7,
      ss: 5,
      nh: 1.6,
      tn: 11,
      tp: 0.35,
      ph: 7.2,
      temperature: 20,
    },
    controls,
    scenario: null,
    biomassKg: (DESIGN_MLSS * net.bioVolume) / 1000,
    srtDays: 18,
    // 初始值按设计负荷与初始生物量估算，预热后由 stepNetwork 用真实物料平衡覆盖
    fmRatio: (INFLUENT_DESIGN.flow * 24 * INFLUENT_DESIGN.bod) / 1000 / ((DESIGN_MLSS * net.bioVolume) / 1000),
    inhibition: 1,
    aerationCapacity: 1,
    energy: { blowerKw: 380, mixerKw: 26, pumpKw: 62, totalKw: 468 },
    alarms: [],
    alarmSeq: 0,
    cost: { energy: 0, chemical: 0, sludge: 0, total: 0 },
    costToday: { energy: 0, chemical: 0, sludge: 0, total: 0 },
    totals: { inflowM3: 0, energyKwh: 0, wasteSludgeKg: 0, influentCodKg: 0, oxidizedCodKg: 0 },
    lastDay: 0,
    stormStorageM3: 0,
    volume: {
      bio: net.bioVolume,
      aerobic: net.aerobicVolume,
      anoxic: net.anoxicVolume,
      anaerobic: net.anaerobicVolume,
    },
    topo,
    net,
  };
}

export { scenarioEnvelope };

function deriveInfluent(state: NetworkSimState): NetworkSimState['influent'] {
  const rng = mulberry32(state.seed * 31 + state.rngCount * 7919 + Math.floor(state.timeMin * 13));
  const d = diurnal(state.timeMin);
  const noise = (s: number) => 1 + rng.normal() * s;
  const env = state.scenario ? scenarioEnvelope(state.scenario, state.timeMin) : 0;
  const mag = state.scenario?.magnitude ?? 0;

  /**
   * 有真实序列时用序列值，否则回到合成模型。
   *
   * 序列值仍然要叠加场景包络（暴雨/冲击/毒性）：序列描述的是「常态进水」，
   * 场景是「在此之上的事件」。若不叠加，加载序列后场景注入会完全失效——
   * 那是比"没有序列支持"更隐蔽的缺陷（界面显示场景已注入，数值不变）。
   */
  const series = state.influentSeries;
  let flow: number;
  let cod: number;
  let nh: number;
  let tp: number;
  let ss: number;
  let temperature: number;
  let alkalinity: number;

  if (series && series.samples.length > 0) {
    const sample = sampleAt(series, state.timeMin);
    flow = sample.flow;
    cod = sample.cod;
    nh = sample.nh;
    tp = sample.tp;
    ss = sample.ss;
    temperature = sample.temperature;
    alkalinity = sample.alkalinity ?? INFLUENT_DESIGN.alkalinity;
    // 序列模式下仍加一点测量噪声，避免完全确定的输入掩盖数值问题
    flow *= noise(0.004);
    cod *= noise(0.008);
  } else {
    flow = INFLUENT_DESIGN.flow * d * noise(0.012);
    cod = INFLUENT_DESIGN.cod * (0.92 + 0.18 * (d - 0.78)) * noise(0.035);
    nh = INFLUENT_DESIGN.nh * (0.94 + 0.14 * (d - 0.78)) * noise(0.03);
    tp = INFLUENT_DESIGN.tp * noise(0.04);
    ss = INFLUENT_DESIGN.ss * noise(0.05);
    temperature = seasonalTemperature(state.timeMin) + rng.normal() * 0.15;
    alkalinity = INFLUENT_DESIGN.alkalinity * noise(0.02);
  }

  const type = state.scenario?.type;
  if (type === 'storm') {
    const dilution = 1 / (1 + 1.2 * env * mag);
    flow *= 1 + 0.9 * env * mag;
    cod *= 0.5 + 0.5 * dilution;
    nh *= 0.5 + 0.5 * dilution;
    tp *= 0.65 + 0.35 * dilution;
    ss *= 1 + 1.0 * env;
    temperature -= 1.4 * env;
    alkalinity *= 0.85;
  } else if (type === 'shock_load') {
    cod *= 1 + 0.95 * env * mag;
    nh *= 1 + 0.7 * env * mag;
    tp *= 1 + 0.5 * env * mag;
    ss *= 1 + 0.35 * env * mag;
  } else if (type === 'toxic') {
    cod *= 1 + 0.2 * env;
    tp *= 1 + 0.12 * env;
  } else if (type === 'winter') {
    temperature = temperature - (temperature - (mag || 12)) * Math.min(1, env * 1.1);
  } else if (type === 'power_outage') {
    flow *= 1 - 0.25 * env;
  }

  const clampedCod = clamp(cod, 90, 1400);
  const u = state.uncertainty;
  const out = {
    flow: clamp(flow, 400, 5200),
    cod: clampedCod,
    bod: clamp(clampedCod * 0.44, 30, 640),
    nh: clamp(nh, 8, 120),
    tn: clamp(nh * 1.27 + 4, 12, 160),
    tp: clamp(tp, 0.8, 16),
    ss: clamp(ss, 45, 900),
    temperature: clamp(temperature, 8, 31),
    alkalinity: clamp(alkalinity, 60, 380),
  };
  if (!u) return out;
  const scaled = {
    ...out,
    flow: clamp(out.flow * u.flow, 200, 6000),
    cod: clamp(out.cod * u.cod, 40, 1800),
    nh: clamp(out.nh * u.nh, 4, 180),
    tp: clamp(out.tp * u.tp, 0.3, 24),
    temperature: clamp(out.temperature + u.temperature, 5, 35),
  };
  scaled.bod = clamp(scaled.cod * 0.44, 20, 800);
  scaled.tn = clamp(scaled.nh * 1.27 + 4, 8, 220);
  return scaled;
}

function recycleOf(state: NetworkSimState): { ras: number; ir: number; was: number } {
  return recycleFactors(state.controls, state.scenario, state.timeMin);
}

function pushAlarm(
  state: NetworkSimState,
  severity: 'warning' | 'critical',
  code: string,
  message: string,
  metric?: string,
  value?: number,
) {
  const recent = state.alarms.find((a) => a.code === code && state.timeMin - a.at < 45);
  if (recent) return;
  state.alarmSeq += 1;
  state.alarms.push({
    id: `A${String(state.alarmSeq).padStart(4, '0')}`,
    at: state.timeMin,
    severity,
    code,
    message,
    metric,
    value,
  });
  if (state.alarms.length > 80) state.alarms.splice(0, state.alarms.length - 80);
}

/**
 * 推进一个时间步。反应器按拓扑序求解，回流在每步开头按控制量定流量。
 */
/**
 * 单步求解的共享上下文。
 *
 * 拆分前，这些东西散落在 260 行的函数体里，任何一处改动都要通读全篇；
 * 现在集中成一个只读快照，各阶段函数按名字就能看出依赖。
 */
interface StepContext {
  state: NetworkSimState;
  net: CompiledNetwork;
  dtMin: number;
  dtH: number;
  /** 本步进水（已扣除调蓄分流、加回缓释流量） */
  influent: NetworkSimState['influent'];
  sup: number;
  rec: { ras: number; ir: number; was: number };
  flows: ReturnType<typeof resolveFlows>;
  Q: number;
  Qr: number;
  Qw: number;
  Qe: number;
  underflow: number;
  xBiomass: number;
  bf: number;
  T: number;
  thetaH: number;
  thetaN: number;
  clar: NetworkSimState['clarifier'];
  lastReactor: ReactorState;
  byId: Map<string, ReactorState>;
  /** 显式开启时记录本步各子模块的真实输入/输出；未开启为 undefined。 */
  trace?: NetworkStepTrace;
}

/** 阶段 1：进水与调蓄。返回本步实际进厂流量。 */
function resolveHydraulics(state: NetworkSimState, dtH: number): { influent: NetworkSimState['influent']; Q: number } {
  const influent = deriveInfluent(state);
  const stormActive = state.scenario?.type === 'storm' && scenarioEnvelope(state.scenario, state.timeMin) > 0.05;
  const storeFrac = stormActive ? state.controls.stormStore : 0;
  const CAP = 16000;
  const divertedRaw = influent.flow * storeFrac;
  const room = Math.max(0, CAP - state.stormStorageM3);
  const diverted = Math.min(divertedRaw, room);
  state.stormStorageM3 += diverted * dtH;
  let returnFlow = 0;
  if (!stormActive && state.stormStorageM3 > 0) {
    returnFlow = Math.min(320, state.stormStorageM3 / dtH);
    state.stormStorageM3 = Math.max(0, state.stormStorageM3 - returnFlow * dtH);
  }
  const Q = Math.max(200, influent.flow - diverted + returnFlow);
  return { influent: { ...influent, flow: Q }, Q };
}

/**
 * 单个反应器的入流构成：把所有入流边按流量加权混合成一份聚合浓度。
 *
 * 浓度语义由边的类型决定：
 * - 污泥回流（RAS）：来自系统末端池，浓度即末端池当前值；
 * - 内回流：同样取末端池（内回流把硝化液送回前端）；
 * - 来自其他反应器：取源池当前值；
 * - 厂外来水（初沉出水等）：取本步进水，硝酸盐按背景值 0.3。
 */
function aggregateInflow(
  incoming: CompiledEdge[],
  edgeFlow: Map<string, number>,
  byId: Map<string, ReactorState>,
  lastReactor: ReactorState,
  influent: NetworkSimState['influent'],
): { qIn: number; codIn: number; nhIn: number; no3In: number; tpIn: number; alkIn: number } {
  const endCod = lastReactor?.cod ?? 20;
  const endNh = lastReactor?.nh ?? 1;
  const endNo3 = lastReactor?.no3 ?? 8;
  const endTp = lastReactor?.tp ?? 0.2;
  const endAlk = lastReactor?.alkalinity ?? 180;
  let qIn = 0;
  let codIn = 0;
  let nhIn = 0;
  let no3In = 0;
  let tpIn = 0;
  let alkIn = 0;

  for (const edge of incoming) {
    const flow = edgeFlow.get(edge.id) ?? 0;
    if (flow <= 0) continue;
    const isFromReactor = byId.has(edge.from);
    const source = isFromReactor ? byId.get(edge.from)! : null;

    let c: { cod: number; nh: number; no3: number; tp: number; alk: number };
    if (edge.recycleKind === 'ras') {
      c = { cod: endCod, nh: endNh, no3: endNo3, tp: endTp, alk: endAlk };
    } else if (edge.recycleKind === 'internal') {
      c = { cod: endCod, nh: endNh, no3: endNo3, tp: endTp, alk: endAlk };
    } else if (source) {
      c = { cod: source.cod, nh: source.nh, no3: source.no3, tp: source.tp, alk: source.alkalinity };
    } else {
      // 厂外来水（初沉出水等）
      c = { cod: influent.cod, nh: influent.nh, no3: 0.3, tp: influent.tp, alk: influent.alkalinity };
    }

    codIn = qIn === 0 ? c.cod : mixed(codIn, qIn, c.cod, flow);
    nhIn = qIn === 0 ? c.nh : mixed(nhIn, qIn, c.nh, flow);
    no3In = qIn === 0 ? c.no3 : mixed(no3In, qIn, c.no3, flow);
    tpIn = qIn === 0 ? c.tp : mixed(tpIn, qIn, c.tp, flow);
    alkIn = qIn === 0 ? c.alk : mixed(alkIn, qIn, c.alk, flow);
    qIn += flow;
  }

  return { qIn, codIn, nhIn, no3In, tpIn, alkIn };
}

/**
 * ASM1 入流组分（13 组分按流量加权）。
 *
 * 污泥回流（RAS）不能直接取末端池浓度——二沉池把污泥浓缩了 2–3 倍，
 * 用未浓缩的浓度会让每个池的颗粒物被"稀释"，生物量持续流失。
 * Takács 模型已经算出真实的回流浓度 xRas，这里按它的浓缩倍数缩放颗粒态。
 */
function aggregateAsm1Inflow(
  incoming: CompiledEdge[],
  edgeFlow: Map<string, number>,
  byId: Map<string, ReactorState>,
  lastReactor: ReactorState,
  xRas: number,
  influent: NetworkSimState['influent'],
  T: number,
): Asm1State {
  const rasConcentrationRatio = (() => {
    const feedSS = lastReactor?.asm1
      ? lastReactor.asm1.X_I +
        lastReactor.asm1.X_S +
        lastReactor.asm1.X_B_H +
        lastReactor.asm1.X_B_A +
        lastReactor.asm1.X_P
      : 0;
    if (feedSS <= 1) return 1;
    // Takács 给出的底流浓度 / 进料浓度 = 真实浓缩倍数
    return Math.max(1, Math.min(6, xRas / feedSS));
  })();

  let asmIn = emptyAsm1State();
  let qAcc = 0;
  for (const edge of incoming) {
    const flow = edgeFlow.get(edge.id) ?? 0;
    if (flow <= 0) continue;
    let src: Asm1State;
    if (edge.recycleKind === 'ras' && lastReactor?.asm1) {
      // 按二沉池浓缩倍数放大颗粒态
      const base = lastReactor.asm1;
      src = {
        ...base,
        X_I: base.X_I * rasConcentrationRatio,
        X_S: base.X_S * rasConcentrationRatio,
        X_B_H: base.X_B_H * rasConcentrationRatio,
        X_B_A: base.X_B_A * rasConcentrationRatio,
        X_P: base.X_P * rasConcentrationRatio,
      };
    } else if (edge.recycleKind === 'internal' && lastReactor?.asm1) src = lastReactor.asm1;
    else if (byId.has(edge.from) && byId.get(edge.from)!.asm1) src = byId.get(edge.from)!.asm1!;
    else
      src = influentToAsm1({
        cod: influent.cod,
        nh: influent.nh,
        tp: influent.tp,
        ss: influent.ss,
        alkalinity: influent.alkalinity,
        temperature: T,
      });

    if (qAcc === 0) asmIn = { ...src };
    else for (const comp of ASM1_COMPONENTS) asmIn[comp] = (asmIn[comp] * qAcc + src[comp] * flow) / (qAcc + flow);
    qAcc += flow;
  }
  return asmIn;
}

/**
 * 阶段 2：反应器串联求解。
 *
 * ASM1 模式下溶解态随水进出、颗粒态由二沉池截留决定——
 * 这个区别写在这里，而不是散在循环里。
 */
function solveReactors(ctx: StepContext): {
  o2DemandKgH: number;
  codOxidizedKgH: number;
  /** 质量平衡专用：按实际耗氧折算，不受内回流重复计账影响 */
  balancedOxidizedKgH: number;
  /** 实际传递到水中的氧，用于风机功率（不是需氧量倒推） */
  o2TransferredKgH: number;
  nhOxidizedKgH: number;
  /** 反硝化脱氮量 kg N/h（NO3 → N₂，N 账单列） */
  denitrifiedNKgH: number;
  /** 数值钳制丢失的 COD/N/P kg/h（单独入账，不混淆工艺去除） */
  clampCodKgH: number;
  clampNKgH: number;
  clampPKgH: number;
} {
  const {
    state,
    net,
    dtH,
    flows,
    byId,
    xBiomass,
    bf,
    T,
    thetaH,
    thetaN,
    clar,
    lastReactor,
    influent,
    sup,
    rec,
    Q,
    Qr,
    Qw,
    Qe,
  } = ctx;
  let o2DemandKgH = 0;
  let o2TransferredKgH = 0;
  let codOxidizedKgH = 0;
  let nhOxidizedKgH = 0;
  let denitNKgH = 0;
  const clampCodKgH = 0;
  const clampNKgH = 0;
  const clampPKgH = 0;
  const orderedReactorIds = net.order;

  // ── ASM2d：网络级逐池 19 组分 CSTR 积分（asm2dNetwork.ts），不走经验聚合量 ──
  if (state.modelMode === 'asm2d') {
    const clarifierFeedFlow = Q * (1 + Math.max(rec.ras, 0.3));
    const lastAsm = lastReactor.asm2d;
    const rasPExact =
      lastAsm && state.bioPRemoval
        ? Math.max(
            0,
            (asm2dPConcentration(lastAsm) * clarifierFeedFlow - state.effluent.tp * Qe) / Math.max(1e-9, Qr + Qw),
          )
        : undefined;
    const asmTracePre = ctx.trace
      ? {
          reactors: state.reactors.map((r) => ({
            id: r.id,
            kind: r.kind,
            volume: r.volume,
            state: { ...(r.asm2d as NonNullable<typeof r.asm2d>) },
            kla: r.kla,
            integral: r.doIntegral ?? 0,
          })),
          order: [...net.order],
          edges: net.edges.map((e) => ({
            id: e.id,
            from: e.from,
            to: e.to,
            flow: flows.edgeFlow.get(e.id) ?? 0,
            recycleKind: e.recycleKind ?? null,
          })),
          influent: {
            flow: influent.flow,
            cod: influent.cod,
            nh: influent.nh,
            tn: influent.tn,
            tp: influent.tp,
            ss: influent.ss,
            alkalinity: influent.alkalinity,
          },
          xRas: clar.xRas,
          rasPExact: rasPExact ?? null,
          xBiomass,
          temperatureC: T,
          dtH,
          bioP: state.bioPRemoval,
          carbonDose: state.controls.carbonDose,
          aerationCapacity: state.aerationCapacity,
          doSetpoint: state.controls.doSetpoint,
          suppression: sup,
        }
      : undefined;
    const flux = stepAsm2dNetwork({
      reactors: state.reactors,
      byId,
      net,
      edgeFlow: flows.edgeFlow,
      influent,
      xRas: clar.xRas,
      rasPExact,
      xBiomass,
      temperatureC: T,
      dtH,
      bioP: state.bioPRemoval,
      carbonDose: state.controls.carbonDose,
      aerationCapacity: state.aerationCapacity,
      doSetpoint: state.controls.doSetpoint,
      suppression: sup,
    });
    if (ctx.trace && asmTracePre) {
      ctx.trace.asm2d = {
        ...asmTracePre,
        expected: {
          reactors: state.reactors.map((r) => ({
            id: r.id,
            state: { ...(r.asm2d as NonNullable<typeof r.asm2d>) },
            kla: r.kla,
            integral: r.doIntegral ?? 0,
            o2Demand: r.o2Demand,
          })),
          flux: {
            o2DemandKgH: flux.o2DemandKgH,
            o2HeteroKgH: flux.o2HeteroKgH,
            o2NitroKgH: flux.o2NitroKgH,
            o2TransferredKgH: flux.o2TransferredKgH,
            nhOxidizedKgH: flux.nhOxidizedKgH,
            denitrifiedNKgH: flux.denitrifiedNKgH,
            clampCodKgH: flux.clampCodKgH,
            clampNKgH: flux.clampNKgH,
            clampPKgH: flux.clampPKgH,
            endogenousOxKgH: flux.endogenousOxKgH,
            biomassCodKg: flux.biomassCodKg,
            clampedCount: flux.clampedCount,
          },
        },
      };
    }
    // COD 氧化只计好氧过程 S_O<0 的异养/PAO 耗氧（1 g O₂ ≡ 1 g COD，1:1，不再除 o2PerCod）；
    // 自养硝化耗氧（o2Nitro）单独一行，不进 COD 账。裂解（lysis）是活体→X_S 的 COD 转移，
    // 不耗 O₂、不计入氧化行（否则同一份生物量 COD 先当氧化、再随 X_S 被氧化，重复计账）。
    // COD 氧化当量 = 好氧异养/PAO 耗氧 + 缺氧反硝化消耗的 COD（NO₃ 作电子受体，2.86 gCOD/gN）。
    const balancedOx =
      Math.max(0, flux.o2HeteroKgH) + Math.max(0, flux.denitrifiedNKgH) * 2.86 + Math.max(0, flux.endogenousOxKgH);
    if (flux.clampedCount > 0 && state.plant) {
      recordPlantError(
        state.plant,
        PLANT_ERRORS.ASM2D_STATE_INVALID,
        `${flux.clampedCount} 个反应器组分越界，已钳制到物理边界`,
      );
    }
    return {
      o2DemandKgH: flux.o2DemandKgH,
      codOxidizedKgH: balancedOx,
      balancedOxidizedKgH: balancedOx,
      o2TransferredKgH: flux.o2TransferredKgH,
      nhOxidizedKgH: flux.nhOxidizedKgH,
      denitrifiedNKgH: flux.denitrifiedNKgH + (lastAsm ? (Qr * Math.max(0, lastAsm.S_NO3)) / 1000 : 0),
      clampCodKgH: flux.clampCodKgH,
      clampNKgH: flux.clampNKgH,
      clampPKgH: flux.clampPKgH,
    };
  }

  for (const id of orderedReactorIds) {
    const reactor = byId.get(id);
    if (!reactor) continue;

    // 入流构成
    const incoming = net.incomingByReactor[id] ?? [];
    const { qIn, codIn, nhIn, no3In, tpIn, alkIn } = aggregateInflow(
      incoming,
      flows.edgeFlow,
      byId,
      lastReactor,
      influent,
    );

    if (qIn <= 0) {
      // 孤立反应器：不进物料，保持现状但记录
      reactor.inflow = 0;
      continue;
    }

    reactor.inflow = qIn;
    reactor.temperature = T;
    const qOverV = qIn / Math.max(1, reactor.volume);

    // ── ASM1 分支：13 组分求解，结果折算回聚合量 ──
    if (state.modelMode === 'asm1') {
      if (!reactor.asm1) {
        reactor.asm1 = toAsm1({
          cod: Math.max(reactor.cod, 150),
          nh: reactor.nh,
          no3: reactor.no3,
          tp: reactor.tp,
          doLevel: reactor.doLevel,
          alkalinity: reactor.alkalinity,
          mlss: xBiomass,
        });
      }

      const asmIn = aggregateAsm1Inflow(incoming, flows.edgeFlow, byId, lastReactor, clar.xRas, influent, T);

      const ph = phFromAlkalinity(reactor.asm1.S_ALK);
      const r = reactionRatesWithSuppression(reactor.asm1, sup, T, ph);
      const nextAsm1 = { ...reactor.asm1 };

      /**
       * 关键区别：溶解态组分随水流进出（稀释项），颗粒态组分不随水力稀释。
       *
       * 为什么：池内的生物量靠二沉池截留 + 污泥回流维持在系统中，
       * 不是靠进水补充。若对 X_B_H / X_B_A / X_S 等颗粒态也用 (C_in - C) 稀释，
       * 等于假设"每一步池里的污泥都被进水替换掉"，生物量会被瞬间冲光——
       * 这正是早期接入失败的原因。
       *
       * 颗粒态的正确流失途径是：排泥（由 SRT 决定）与出水悬浮物（由二沉池决定）。
       */

      /**
       * 输运项分两类处理，这是整个接入的关键：
       *
       * 1. 溶解态：随水自由进出 → (C_in - C)·Q/V
       * 2. 颗粒态：随混合液进入二沉池。回流把绝大部分送回系统，
       *    只有「出水带走的」那部分才算真正离开。
       *
       * 因此颗粒态的净输运 ≠ (C_in - C)·Q/V，而是：
       *   入流带来的颗粒 - 出水带走的颗粒 / V
       *
       * 出水带走的比例 = (Q - Qr - Qw) / Q（即扣除回流与排泥后剩下的部分）。
       * 若按 (C_in - C) 算，等于假设"排泥和回流都不存在"，
       * 生物量会被出水一次性带光——这正是早期失败的根因。
       */
      /**
       * 标准 CSTR 质量平衡：dC/dt = (Q/V)(C_in − C) + r
       *
       * 这里 C_in 是**按流量加权的所有入流浓度**（含内回流与污泥回流），
       * 由上面的 asmIn 计算得出。这个形式对溶解态与颗粒态都成立，
       * 不需要为颗粒态单独设计"净流出比例"——那是把简单问题复杂化，
       * 并且在实现中引入过两次指数发散。
       *
       * 只要 asmIn 正确包含了回流携带的颗粒物，生物量就不会被冲走。
       */
      const externalCarbon = reactor.kind === 'anoxic' ? state.controls.carbonDose : 0;
      for (const comp of ASM1_COMPONENTS) {
        if (comp === 'S_ALK') continue;
        nextAsm1[comp] = Math.max(
          0,
          reactor.asm1[comp] + dtH * (qOverV * (asmIn[comp] - reactor.asm1[comp]) + r[comp]),
        );
      }
      // 外加碳源以易降解 COD（S_S）进入缺氧区；ASM1 的异养菌直接消耗它做反硝化
      if (externalCarbon > 0) nextAsm1.S_S = Math.max(0, nextAsm1.S_S + dtH * qOverV * externalCarbon);
      nextAsm1.S_ALK = Math.max(0, reactor.asm1.S_ALK + dtH * qOverV * (asmIn.S_ALK - reactor.asm1.S_ALK));

      // 溶解氧：不是贴设定值，而是氧传递（KLa）与耗氧平衡的结果。
      // 设定值只进入 PI 控制器，实际 DO 受鼓风机剩余能力、KLa 速率限制和 OUR 约束。
      if (reactor.kind === 'aerobic' && state.aerationCapacity > 0.02) {
        const aeration = stepAeration({
          volume: reactor.volume,
          temperatureC: T,
          doLevel: reactor.asm1.S_O,
          o2Demand: Math.max(0, -r.S_O),
          doSetpoint: state.controls.doSetpoint,
          capacity: state.aerationCapacity,
          previousKla: reactor.kla ?? 0,
          previousIntegral: reactor.doIntegral ?? 0,
          dtH,
        });
        nextAsm1.S_O = aeration.doLevel;
        reactor.kla = aeration.kla;
        reactor.doIntegral = aeration.integral;
        o2TransferredKgH += aeration.o2TransferredKgH;
      } else {
        reactor.kla = 0;
        reactor.doIntegral = 0;
        nextAsm1.S_O = Math.max(0, nextAsm1.S_O - dtH * 0.5);
      }

      reactor.asm1 = nextAsm1;
      const agg = fromAsm1(nextAsm1);
      reactor.cod = Math.max(2, agg.cod);
      reactor.nh = Math.max(0.01, agg.nh);
      reactor.no3 = Math.max(0.01, agg.no3);
      reactor.doLevel = agg.doLevel;
      reactor.alkalinity = agg.alkalinity;
      reactor.o2Demand = Math.max(0, -r.S_O);
      o2DemandKgH += (reactor.o2Demand * reactor.volume) / 1000;
      codOxidizedKgH += (Math.max(0, -r.S_S) * reactor.volume) / 1000;
      nhOxidizedKgH += (Math.max(0, -r.S_NH) * reactor.volume) / 1000;

      // ── TP 惰性示踪（ASM1 无磷组分）──
      // ASM1 不建模生物除磷。若放任 reactor.tp 停留在初值，出水 TP 会永远贴着下限 0.01，
      // PAC 投加与进水 TP 冲击对结果毫无影响，TP 告警/决策维度完全失效。
      // 这里把 TP 当作保守示踪剂随水力稀释输运（入流 TP 经 RAS 回流累积到与进水同量级），
      // 化学除磷（PAC）在出水阶段统一扣除——进水冲击与药剂决策因此真实可感。
      // 模型边界如实标注：本模式的 TP 不含生物除磷，稳态值会高于 simple 模式。
      reactor.tp = Math.max(0.005, (reactor.tp + dtH * qOverV * tpIn) / (1 + dtH * qOverV));
      continue;
    }

    // ── simple 经验动力学分支（ASM2d 已在函数开头由 asm2dNetwork 逐池积分，不走这里）──

    const fCod = reactor.cod / (KINETICS.ksCod + reactor.cod);
    const fNh = reactor.nh / (KINETICS.ksNh + reactor.nh);
    const fO2 = reactor.doLevel / (KINETICS.ksO2 + reactor.doLevel);
    const fO2Nit = reactor.doLevel / (KINETICS.ksO2Nit + reactor.doLevel);

    let codRate: number;
    let nhRate = 0;
    let no3Rate = 0;
    let tpRate: number;
    let o2Rate = 0;

    if (reactor.kind === 'anaerobic') {
      codRate = -KINETICS.kCodAnaerobic * fCod * bf * sup * reactor.cod;
      tpRate = KINETICS.kPRel * fCod * bf * sup;
    } else if (reactor.kind === 'anoxic') {
      const fNo3 = reactor.no3 / (1.0 + reactor.no3);
      const hetero = KINETICS.kCodAnoxic * fCod * bf * sup * reactor.cod;
      const denit = KINETICS.kDen * fNo3 * fCod * bf * sup * 3.5;
      codRate = -hetero;
      no3Rate = -denit;
      tpRate = KINETICS.kPRel * 0.1 * fCod * bf;
    } else {
      const hetero = KINETICS.kCodAerobic * fCod * fO2 * thetaH * bf * sup * reactor.cod;
      codRate = -hetero;
      nhRate =
        -KINETICS.kNit * fNh * fO2Nit * thetaN * bf * sup * (reactor.alkalinity > 30 ? 1 : reactor.alkalinity / 30);
      tpRate = -KINETICS.kPUp * (reactor.tp / (0.25 + reactor.tp)) * fO2 * bf * sup;
      o2Rate = hetero * KINETICS.o2PerCod + -nhRate * KINETICS.o2PerNh;
    }

    /**
     * 外加碳源只进缺氧区，且按 Q/V 稀释。
     *
     * 旧实现只在成本里记一笔 carbonKg，工艺上完全无效：投 0 与投 60 mg/L
     * 的出水 COD/TN 逐位相同。检视器与决策面板却都把它当"可调参数"，
     * 属于假控件。这里按「外加碳源 → 易降解 COD」进入反硝化段。
     *
     * 不进厌氧区：碳源加在厌氧区会被聚磷菌优先吸收，反而削弱释磷与后续
     * 反硝化的碳源供给；工艺上也只把碳源加在缺氧段。
     */
    const externalCarbon = reactor.kind === 'anoxic' ? state.controls.carbonDose : 0;
    reactor.cod = Math.max(2, (reactor.cod + dtH * (qOverV * (codIn + externalCarbon) + codRate)) / (1 + dtH * qOverV));
    reactor.nh = Math.max(0.01, (reactor.nh + dtH * (qOverV * nhIn + nhRate)) / (1 + dtH * qOverV));

    const nOxidized = Math.max(0, -nhRate) * dtH;
    const dn = Math.max(0, -no3Rate) * dtH;
    reactor.no3 = Math.max(
      0.01,
      (reactor.no3 + dtH * qOverV * no3In + nOxidized * KINETICS.nitrateYieldPerNitrifiedN - dn) / (1 + dtH * qOverV),
    );
    reactor.tp = Math.max(0.005, (reactor.tp + dtH * (qOverV * tpIn + tpRate)) / (1 + dtH * qOverV));

    const alkConsumed = nOxidized * KINETICS.alkPerNh - dn * KINETICS.alkPerNo3;
    reactor.alkalinity = Math.max(
      10,
      (reactor.alkalinity + dtH * qOverV * (alkIn + state.controls.alkDose) - alkConsumed) / (1 + dtH * qOverV),
    );

    if (reactor.kind === 'aerobic') {
      const our = Math.max(0, o2Rate);
      const capacity = state.aerationCapacity;
      const dsat = KINETICS.doSat20 - 0.11 * (T - 20);
      const klaNeed = capacity > 0.02 ? our / Math.max(0.35, dsat - state.controls.doSetpoint) : 0;
      const kla = clamp(klaNeed, capacity > 0.02 ? 0.8 : 0, 165);
      const effective = kla * capacity;
      const doTarget = effective > 0.02 ? dsat - our / effective : 0.02;
      const tau = clamp(1.4 / Math.max(0.2, effective), 0.02, 0.45);
      reactor.doLevel = clamp(
        reactor.doLevel + (clamp(doTarget, 0.02, dsat) - reactor.doLevel) * clamp(dtH / tau, 0, 1),
        0.02,
        dsat,
      );
      reactor.o2Demand = our;
      reactor.kla = effective;
      o2DemandKgH += (our * reactor.volume) / 1000;
    } else {
      reactor.doLevel = clamp(reactor.doLevel * Math.exp(-3 * dtH), 0.02, 0.9);
      reactor.o2Demand = 0;
      reactor.kla = 0;
    }

    codOxidizedKgH += (Math.max(0, -codRate) * reactor.volume) / 1000;
    nhOxidizedKgH += (Math.max(0, -nhRate) * reactor.volume) / 1000;
    denitNKgH += (Math.max(0, -no3Rate) * reactor.volume) / 1000;
  }

  /**
   * 质量平衡用的氧化量必须按**实际耗氧**折算，不能复用上面那个值。
   *
   * 原因：`codOxidizedKgH` 是逐池净降解速率之和，内回流会把同一份 COD
   * 反复送回各池，逐池累加会把同一分子 COD 记成多次氧化——实测 30 天
   * 累计达到进水的 91%（436 t 进水记出 399 t 氧化），质量平衡崩成 -54%。
   *
   * 但**不能直接改 `codOxidizedKgH` 本身**：它同时驱动生物量增长
   * （growth = yieldH × codOxidized），改它等于改物理，实测会让 MLSS
   * 从 2400 掉到 1350、出水 COD 从 35 涨到 64。因此另设独立计数。
   *
   * 氧消耗没有重复计账问题：每个氧分子只被消耗一次。
   * 扣除硝化耗氧后的异养耗氧，按 1 kg O₂ ≡ 1/0.9 kg COD 折算。
   */
  // 二沉池/RAS 管线内的反硝化：mixInflow 将 RAS 的 S_NO3 置 0，这部分 N 必须
  // 记成 N₂ 去向，否则会表现为 8%–45% 的“消失氮”。按末端池硝酸盐 × RAS 流量计。
  const terminalAsm = lastReactor.asm2d;
  if (terminalAsm) denitNKgH += (Qr * Math.max(0, terminalAsm.S_NO3)) / 1000;
  const balancedOxidizedKgH = Math.max(0, (o2DemandKgH - nhOxidizedKgH * KINETICS.o2PerNh) / KINETICS.o2PerCod);

  return {
    o2DemandKgH,
    codOxidizedKgH,
    balancedOxidizedKgH,
    nhOxidizedKgH,
    o2TransferredKgH,
    denitrifiedNKgH: denitNKgH,
    clampCodKgH,
    clampNKgH,
    clampPKgH,
  };
}

/** WP3 水力学输运：推进管渠分段 CSTR 与示踪剂历史，刷新 RTD 矩。 */
function stepHydraulicTransport(ctx: StepContext, edgeFlow: Map<string, number>): void {
  const { state, net, dtMin, xBiomass } = ctx;
  if (!state.hydraulics) return;
  const componentFeed = new Map<string, number[]>();
  for (const reactor of state.reactors) {
    const outs = (net.outgoingByReactor[reactor.id] ?? []).filter((e) => e.stream !== 'air' && e.stream !== 'chemical');
    const vector = [reactor.cod, reactor.nh, reactor.no3, reactor.tp, xBiomass];
    for (const e of outs) componentFeed.set(e.id, vector);
  }
  const outletEdgeIds = net.edges.filter((e) => e.stream === 'effluent').map((e) => e.id);
  stepHydraulics(state.hydraulics, net, {
    flows: edgeFlow,
    dtMin,
    timeMin: state.timeMin,
    componentFeed,
    outletEdgeIds,
  });
  refreshRtdMetrics(state.hydraulics, dtMin);
}

/** 阶段 3：二沉池（Takács 十层）。返回进水固体负荷与排泥带走的干固体。 */
function solveClarifier(ctx: StepContext): { clarifierInflow: number; wasted: number } {
  const { state, dtMin, dtH, rec, xBiomass, Qw, Qr, Qe, underflow, Q } = ctx;
  // ── 二沉池：Takács 十层沉降模型 ──
  // 用分层剖面直接给出回流浓度与出水悬浮物，取代原先的经验关联式。
  // 多系列时每个二沉池独立步进；进料固体暂取全厂末端池口径（系列间固体分配
  // 属 WP2 全厂物料边界，本包只保证各池独立状态与独立 RAS/WAS 流量标签）。
  const clarifierInflow = Q * (1 + Math.max(rec.ras, 0.3));

  const lastReactorForFeed = state.reactors[state.reactors.length - 1];
  const feedSolids = lastReactorForFeed?.asm1
    ? lastReactorForFeed.asm1.X_I +
      lastReactorForFeed.asm1.X_S +
      lastReactorForFeed.asm1.X_B_H +
      lastReactorForFeed.asm1.X_B_A +
      lastReactorForFeed.asm1.X_P
    : lastReactorForFeed?.asm2d
      ? asm2dFeedSolids(lastReactorForFeed.asm2d)
      : xBiomass;

  const allClarifiers = state.clarifiers ?? [ctx.clar];
  allClarifiers.forEach((clar, index) => {
    const settlerCfg = { ...BSM1_SETTLER, area: clar.area, depth: clar.depth };
    const settlerTrace = ctx.trace
      ? {
          index,
          cfg: { ...settlerCfg },
          state: { x: [...clar.settler.x] },
          feed: { flow: clarifierInflow * 24, concentration: feedSolids },
          underflow: { flow: underflow * 24 },
          dtDays: dtMin / 1440,
        }
      : undefined;

    const settlerResult = stepSettler(
      clar.settler,
      settlerCfg,
      { flow: clarifierInflow * 24, concentration: feedSolids }, // m³/d, g/m³
      { flow: underflow * 24 },
      dtMin / 1440,
    );
    clar.settler = settlerResult.state;
    clar.slr = settlerResult.solidsLoading;

    // 分层模型的输出直接作为回流与出水浓度
    clar.xRas = clamp(settlerResult.xUnderflow, 1000, 15000);
    clar.xEff = clamp(settlerResult.xEffluent, 0.5, 200);

    const slrFactor2 = clamp(settlerResult.solidsLoading / 3.6, 0.15, 3.2);
    const rasFactor2 = clamp(0.8 / Math.max(0.15, rec.ras), 0.2, 3.0);
    const blanketTarget = clamp(
      0.19 * clar.depth * Math.pow(slrFactor2, 1.25) * Math.pow(rasFactor2, 0.6),
      0.25,
      clar.depth + 0.8,
    );
    clar.blanketM += (blanketTarget - clar.blanketM) * Math.min(1, dtMin / 60 / 0.5);

    // 池内固体存量（供界面显示）
    const meanX = settlerResult.state.x.reduce((a, b) => a + b, 0) / settlerResult.state.x.length;
    clar.sludgeMassKg = (meanX * clar.area * clar.depth) / 1000;

    if (ctx.trace && settlerTrace) {
      if (!ctx.trace.settlers) ctx.trace.settlers = [];
      ctx.trace.settlers.push({
        ...settlerTrace,
        expected: {
          state: { x: [...settlerResult.state.x] },
          xEffluent: settlerResult.xEffluent,
          xUnderflow: settlerResult.xUnderflow,
          solidsLoading: settlerResult.solidsLoading,
          blanketM: clar.blanketM,
          sludgeMassKg: clar.sludgeMassKg,
        },
      });
    }
  });

  const first = allClarifiers[0] ?? ctx.clar;
  const solidsIn = (clarifierInflow * xBiomass) / 1000;
  const solidsOut = ((Qr + Qw) * first.xRas) / 1000 + (Qe * first.xEff) / 1000;
  void solidsIn;
  void solidsOut;

  // 排泥带走的干固体（kg）；成本与生物量都依赖它，因此在这一阶段算一次
  const wasted = ((Qw * first.xRas) / 1000) * dtH;
  return { clarifierInflow, wasted };
}

/** 阶段 4：生物量与 SRT。 */
function solveBiomass(
  ctx: StepContext,
  oxidized: { o2DemandKgH: number; codOxidizedKgH: number; balancedOxidizedKgH: number; nhOxidizedKgH: number },
  wasted: number,
): void {
  const { state, dtH, Qw, clar, Q, influent } = ctx;
  void oxidized.o2DemandKgH;
  // 生物量
  const growth = KINETICS.yieldH * oxidized.codOxidizedKgH + 0.11 * oxidized.nhOxidizedKgH;
  const decay = (KINETICS.decayPerDay / 24) * state.biomassKg;

  if (state.modelMode === 'asm1') {
    // ASM1 模式下生物量由各池组分汇总（生物量是物理存量，不由全局标量独立演化）
    let total = 0;
    let weighted = 0;
    for (const r of state.reactors) {
      if (!r.asm1) continue;
      const bio = r.asm1.X_B_H + r.asm1.X_B_A;
      total += (bio * r.volume) / 1000;
      weighted += bio * r.volume;
    }
    state.biomassKg = clamp(total, 1000, 400000);
    // 排泥带走的生物量按池内平均浓度计（回流浓度由 Takács 给出，与池内一致）
    const meanConc = weighted / Math.max(1, state.volume.bio);
    const wasKgDay = (Qw * 24 * meanConc) / 1000;
    state.srtDays = wasKgDay > 1 ? clamp(state.biomassKg / wasKgDay, 0.5, 60) : 60;
  } else if (state.modelMode === 'asm2d') {
    // MLSS 口径为混合液总悬浮固体：活性生物量 + 惰性/慢降解颗粒 + 胞内储存物，
    // 全部由组分汇总（gCOD/m³ × 池容 ÷ 1.42 折 kg VSS）；SRT 另按活性生物量计。
    let totalPartCod = 0;
    let activeCod = 0;
    let weightedActive = 0;
    for (const r of state.reactors) {
      if (!r.asm2d) continue;
      const a = r.asm2d;
      const part = a.X_I + a.X_S + a.X_H + a.X_PAO + a.X_AUT + a.X_PP + a.X_PHA;
      const active = a.X_H + a.X_PAO + a.X_AUT;
      totalPartCod += (part * r.volume) / 1000;
      activeCod += (active * r.volume) / 1000;
      weightedActive += active * r.volume;
    }
    state.biomassKg = clamp(totalPartCod / COD_PER_VSS, 1000, 400000);
    const activeMean = weightedActive / Math.max(1, state.volume.bio) / COD_PER_VSS;
    const wasKgDay = (Qw * 24 * Math.max(activeMean, clar.xRas * 0.5)) / 1000;
    state.srtDays = wasKgDay > 5 ? clamp(activeCod / COD_PER_VSS / wasKgDay, 2, 60) : 60;
  } else {
    state.biomassKg = clamp(state.biomassKg + (growth - decay) * dtH - wasted, 5000, 400000);
    const wasKgDay = (Qw * 24 * clar.xRas) / 1000;
    state.srtDays = wasKgDay > 5 ? clamp(state.biomassKg / wasKgDay, 2, 60) : 60;
  }

  // 食微比：每天进入系统的 BOD 负荷 ÷ 系统内生物量
  const bodLoadKgDay = (Q * 24 * influent.bod) / 1000;
  state.fmRatio = bodLoadKgDay / Math.max(1, state.biomassKg);
}

/** 阶段 5：出水水质。 */
function solveEffluent(ctx: StepContext): number {
  const { state, T, clar, lastReactor, Qe } = ctx;
  // 出水
  const pacAllowed = !(
    state.scenario?.type === 'chemical_shortage' && scenarioEnvelope(state.scenario, state.timeMin) > 0.3
  );
  const pacDose = pacAllowed ? state.controls.pacDose : 0;
  const suspend = clar.xEff;
  /**
   * 出水 COD 不能用池内混合液总 COD——那是含生物量的浓度（可达数千），
   * 而实际出水是「溶解性组分 + 出水悬浮物折算」。
   *
   * 早期直接用 lastReactor.cod 导致出水 COD 被 clamp 到上限 900，
   * 而同一时刻氨氮、总氮都正常，掩盖了这个问题。
   */
  const effluentSolubleCod = lastReactor.asm1
    ? lastReactor.asm1.S_I + lastReactor.asm1.S_S
    : lastReactor.asm2d
      ? lastReactor.asm2d.S_I + lastReactor.asm2d.S_F + lastReactor.asm2d.S_A
      : lastReactor.cod;
  const effluentCodValue = clamp(effluentSolubleCod + suspend * 1.3, 4, 900);

  state.effluent = {
    flow: Qe,
    cod: effluentCodValue,
    // BOD 同样基于溶解性可降解组分，而不是含生物量的池内 COD
    bod: clamp(Math.max(1.2, (effluentSolubleCod - 12) * 0.32 + suspend * 0.5), 1, 400),
    ss: clamp(suspend, 0.5, 150),
    nh: clamp(lastReactor.nh + suspend * 0.014, 0.02, 100),
    tn: clamp(lastReactor.nh + lastReactor.no3 + suspend * 0.025, 0.3, 120),
    tp: clamp(Math.max(0.01, lastReactor.tp + suspend * 0.014 - pacDose * KINETICS.pacPPerMg), 0.01, 20),
    ph: clamp(6.6 + 0.004 * (lastReactor.alkalinity - 40), 5.8, 8.7),
    temperature: T,
  };
  return pacDose;
}

/** 阶段 6：能耗与成本。 */
function solveEnergyAndCost(
  ctx: StepContext,
  o2TransferredKgH: number,
  wasted: number,
  pacDose: number,
  codOxidizedKgH: number,
): void {
  const { state, dtH, Q, Qr, rec } = ctx;
  // 能耗：按实际传递到水中的氧计算，而不是按需氧量倒推。
  // 鼓风机故障时传递量下降，功率随之下降；需氧量仍可由 o2DemandKgH 用于报警。
  const blowerKw = totalBlowerPower(o2TransferredKgH, state.aerationCapacity);
  const anoxicVol = state.volume.anoxic + state.volume.anaerobic;
  const mixerKw = (anoxicVol * 3.4) / 1000;
  const pumpKw = (Q + Qr + Q * rec.ir) * 0.008;
  const totalKw = blowerKw + mixerKw + pumpKw;
  state.energy = { blowerKw, mixerKw, pumpKw, totalKw };

  const pacKg = (Q * pacDose * dtH) / 1000;
  const carbonKg = (Q * state.controls.carbonDose * dtH) / 1000;
  const alkKg = (Q * state.controls.alkDose * dtH) / 1000;
  const energyCost = totalKw * dtH * TARIFF.electricity;
  const chemCost = pacKg * TARIFF.pac + carbonKg * TARIFF.carbon + alkKg * TARIFF.alk;
  const sludgeCost = wasted * TARIFF.sludge;
  // 跨日清零当日口径，累计口径保留
  const simDay = Math.floor(state.timeMin / 1440);
  if (simDay > state.lastDay) {
    state.lastDay = simDay;
    state.costToday = { energy: 0, chemical: 0, sludge: 0, total: 0 };
  }

  state.cost.energy += energyCost;
  state.cost.chemical += chemCost;
  state.cost.sludge += sludgeCost;
  state.cost.total += energyCost + chemCost + sludgeCost;
  state.costToday.energy += energyCost;
  state.costToday.chemical += chemCost;
  state.costToday.sludge += sludgeCost;
  state.costToday.total += energyCost + chemCost + sludgeCost;

  // 按步积分：这是「累计处理量 / 累计电耗 / 累计干泥」的唯一正确口径
  state.totals.inflowM3 += Q * dtH;
  state.totals.influentCodKg += (Q * state.influent.cod * dtH) / 1000;
  state.totals.energyKwh += totalKw * dtH;
  state.totals.wasteSludgeKg += wasted;
  // 氧化掉的 COD 是质量平衡里最大的一笔去向，必须单独记账
  state.totals.oxidizedCodKg += Math.max(0, codOxidizedKgH) * dtH;
}

/** 阶段 7：限值告警。 */
function raiseLimitAlarms(state: NetworkSimState): void {
  const last = state.reactors[state.reactors.length - 1];
  // 告警只读仪表测量值；理想仪表下与真值逐位一致，坏探头回退真值避免 NaN
  const lastDo =
    state.instruments && last ? measuredValue(state.instruments, `${last.id}:do`, last.doLevel) : (last?.doLevel ?? 0);
  const active = evaluateAlarms({
    effluent: state.effluent,
    lastDo,
    srtDays: state.srtDays,
    blanketM: state.clarifier.blanketM,
    depth: state.clarifier.depth,
    atMin: state.timeMin,
  });
  for (const alarm of active) pushAlarm(state, alarm.severity, alarm.code, alarm.message, alarm.metric, alarm.value);
}

/**
 * 推进一个时间步。
 *
 * 七个阶段按固定顺序执行；每个阶段只碰自己那一块状态，
 * 因此可以单独测试，也不会再出现"改出水逻辑却误伤生物量"的情况。
 */
export function stepNetwork(
  state: NetworkSimState,
  topo: ProcessTopology,
  dtMin = 1,
  trace?: NetworkTraceHook,
): NetworkSimState {
  if (dtMin <= 0) return state;
  const dtH = dtMin / 60;
  state.timeMin += dtMin;
  state.rngCount += 1;
  const traceStep: NetworkStepTrace | undefined = trace ? { timeMin: state.timeMin, dtMin } : undefined;

  // 编译缓存随状态走：同一拓扑对象不反复编译；换对象（含克隆）按身份判重后重编译一次
  if (topo !== state.topo) {
    state.topo = topo;
    state.net = compileNetwork(topo);
  }
  const net: CompiledNetwork = state.net;
  if (net.problems.length) {
    throw new Error(`运行中拓扑失效：${net.problems.join('；')}`);
  }

  const sup = toxicSuppression(state.scenario, state.timeMin);
  state.inhibition = sup;

  // ── WP4/WP7 子系统懒初始化：旧快照缺字段时补默认理想实例，不抛错、不丢字段 ──
  if (!state.instruments) {
    state.instruments = createInstrumentationState(state.topo, { seed: state.seed });
  }
  if (!state.controlLayer) {
    state.controlLayer = createControlLayer({
      initialOutputs: { do: 1, ras: state.controls.rasRatio, was: state.controls.wasRatio },
    });
  }
  if (!state.assets) {
    state.assets = createAssetStateFromTopology(state.topo, { seed: state.seed });
  }

  // 资产步进：故障降容/备机自启在此推进；风机组可用性因子折减曝气能力
  tickAssets(state.assets, dtMin);
  const blowerFactor = capacityFactorFor(state.assets, 'blower:blower');
  state.aerationCapacity = aerationCapacityOf(state.scenario, state.timeMin) * blowerFactor;
  const rec = recycleOf(state);

  // ── WP4 测量链：真值 → 仪表读数；控制层/告警只读读数，真值仅留作诊断对照 ──
  const byIdEarly = new Map(state.reactors.map((r) => [r.id, r]));
  const lastIdEarly = net.order[net.order.length - 1];
  const lastReactorEarly = (lastIdEarly ? byIdEarly.get(lastIdEarly) : undefined) ?? state.reactors[0];
  const xBiomassEarly = clamp((state.biomassKg * 1000) / Math.max(1, state.volume.bio), 300, 14000);

  const truth: Record<string, number> = {};
  for (const r of state.reactors) {
    truth[`${r.id}:do`] = r.doLevel;
    truth[`${r.id}:nh`] = r.nh;
    truth[`${r.id}:no3`] = r.no3;
    truth[`${r.id}:mlss`] = xBiomassEarly;
  }
  truth['inlet:flow'] = state.influent.flow;
  truth['inlet:ph'] = 7.2;
  truth['inlet:temperature'] = state.influent.temperature;
  truth['outlet:flow'] = state.influent.flow;
  truth['outlet:nh'] = state.effluent.nh;
  truth['outlet:tn'] = state.effluent.tn;
  truth['clarifier:level'] = state.clarifier.blanketM;
  truth['clarifier:mlss'] = state.clarifier.xRas;
  truth['blower:pressure'] = state.aerationCapacity;
  truth['blower:flow'] = state.influent.flow;

  const inst = state.instruments;
  if (inst) {
    inst.readings = measure(inst.registry, truth, dtMin);
    inst.truth = truth;
  }

  const layer = state.controlLayer;
  if (layer) {
    applyEsdState(layer, state.assets!.esd);
    const doMeas = inst
      ? measuredValue(inst, `${lastReactorEarly.id}:do`, lastReactorEarly.doLevel)
      : lastReactorEarly.doLevel;
    const nhMeas = inst ? measuredValue(inst, `${lastReactorEarly.id}:nh`, lastReactorEarly.nh) : lastReactorEarly.nh;
    evaluateInterlocks(
      layer,
      {
        do: doMeas,
        nh: nhMeas,
        blanket: state.clarifier.blanketM,
        level: state.clarifier.blanketM,
        fanFault: blowerFactor <= 0.02,
        esd: state.assets!.esd.active,
      },
      dtMin,
    );

    stepLoop(layer, 'do', doMeas, dtMin);
    stepLoop(layer, 'ras', state.controls.rasRatio, dtMin);
    stepLoop(layer, 'was', state.controls.wasRatio, dtMin);
    // 控制层每步会被联锁 + 三个回路各推进一次，内部时钟是“步数”不是仿真分钟；
    // 对外视图必须回到主时钟，否则快照里出现 4 min / 24 min 两条时间轴。
    layer.timeMin = state.timeMin;

    if (interlockActive(layer, 'rasMax')) rec.ras = layer.outputs.ras;
    if (layer.esd.active || interlockActive(layer, 'trip')) rec.ras = 0;

    // 风机执行机构：需求负荷经爬坡/容量/资产因子折减；默认速率足够大、因子 1，直通不扰动基线
    // 联锁 fanMax 拉满曝气；ESD/跳闸进安全位（停机）
    let fanCommand = state.aerationCapacity;
    if (layer.esd.active || interlockActive(layer, 'trip')) fanCommand = 0;
    else if (interlockActive(layer, 'fanMax')) fanCommand = 1;
    if (!layer.actuators) layer.actuators = {};
    const fan =
      layer.actuators.blower ??
      (layer.actuators.blower = createFan('blower', 'blower', {
        rateLimitPerMin: 100,
        deadband: 0,
        ratedPowerKw: 110,
        surgeFloor: 0,
      }));
    const fanResult = commandActuator(fan, fanCommand, dtMin, blowerFactor);
    state.aerationCapacity = fanResult.status === 'rejected' ? 0 : fanResult.actual;
  }

  const { influent, Q } = resolveHydraulics(state, dtH);
  state.influent = influent;

  // 阻力分流：泵/阀/堰几何来自编译期 meta；无几何信息时各支路阻力相同，退化为均分
  const branchH = new Map<string, FlowBranchHydraulics>();
  if (state.hydraulics) {
    for (const e of state.hydraulics.edges) {
      branchH.set(e.id, {
        resistance: e.resistance,
        closed: e.status === 'closed',
        capacityM3h: e.capacityM3h,
      });
    }
  }

  const flows = resolveFlows(
    net,
    Q,
    {
      ras: rec.ras,
      // ASM2d 内回流限到 1.0–4.0 Q（BSM1/BSM2 反硝化内回流量级 3Q）；rec.ir=0 的工况保留为 0。
      ir: state.modelMode === 'asm2d' ? (rec.ir <= 0 ? 0 : clamp(rec.ir, 1.0, 4.0)) : rec.ir,
      // ASM2d 模式排泥比限到 0.6%–1.74% Q，对应 SRT 约 12–18 d；默认 2.2% Q 排泥过快，
      // 30 d 尺度下活性生物量被洗出（MLSS 跌破 2000）。simple/asm1 口径不变。
      was: state.modelMode === 'asm2d' ? Math.min(0.0174, Math.max(0.006, rec.was)) : rec.was,
      stepFeed: state.controls.stepFeed,
    },
    branchH,
  );

  const byId = new Map(state.reactors.map((r) => [r.id, r]));
  const xBiomass = clamp((state.biomassKg * 1000) / Math.max(1, state.volume.bio), 300, 14000);
  const T = influent.temperature;
  const wasEff = state.modelMode === 'asm2d' ? Math.min(0.0174, Math.max(0.006, rec.was)) : rec.was;
  const Qr = Q * rec.ras;
  const Qw = Q * wasEff;
  const Qe = Math.max(1, Q - Qw);
  // 最后一个反应器 = 拓扑序最大的那个；单趟取最大值，取代 sort+find 的 O(n²) 写法
  // 末端反应器 = 拓扑序最后一项；编译期已排好，不再每步 sort/扫描
  const lastId = net.order[net.order.length - 1];
  const lastReactor = (lastId ? byId.get(lastId) : undefined) ?? state.reactors[0];

  const ctx: StepContext = {
    state,
    net,
    dtMin,
    dtH,
    influent,
    sup,
    rec,
    flows,
    Q,
    Qr,
    Qw,
    Qe,
    underflow: Qr + Qw,
    xBiomass,
    bf: xBiomass / DESIGN_MLSS,
    T,
    thetaH: Math.pow(KINETICS.thetaH, T - 20),
    thetaN: Math.pow(KINETICS.thetaN, T - 20),
    clar: state.clarifier,
    lastReactor,
    byId,
    trace: traceStep,
  };

  const oxidized = solveReactors(ctx);
  stepHydraulicTransport(ctx, flows.edgeFlow);
  const { wasted } = solveClarifier(ctx);
  solveBiomass(ctx, oxidized, wasted);
  const pacDose = solveEffluent(ctx);
  if (traceStep) {
    const solubleCod = lastReactor.asm2d
      ? lastReactor.asm2d.S_I + lastReactor.asm2d.S_F + lastReactor.asm2d.S_A
      : lastReactor.asm1
        ? lastReactor.asm1.S_I + lastReactor.asm1.S_S
        : lastReactor.cod;
    traceStep.effluent = {
      pacDose,
      xEff: ctx.clar.xEff,
      Qe,
      temperatureC: T,
      last: {
        nh: lastReactor.nh,
        no3: lastReactor.no3,
        tp: lastReactor.tp,
        alkalinity: lastReactor.alkalinity,
        solubleCod,
      },
      expected: { ...state.effluent },
    };
    traceStep.biomass = {
      Q,
      Qw,
      xRas: ctx.clar.xRas,
      volumeBio: state.volume.bio,
      influentBod: influent.bod,
      expected: {
        biomassKg: state.biomassKg,
        srtDays: state.srtDays,
        fmRatio: state.fmRatio,
      },
    };
  }
  solveEnergyAndCost(ctx, oxidized.o2TransferredKgH, wasted, pacDose, oxidized.balancedOxidizedKgH);

  // ── WP2 泥线：WAS → 浓缩 → 消化 → 脱水；滤液回流到首端，负荷并入进水 ──
  const rawInfluent = { ...state.influent };
  if (state.plant?.enabled) {
    const sludgeFeed = {
      wasFlowM3h: Qw,
      feedSsKgM3: ctx.clar.xRas,
      feedCodKgM3: lastReactor.cod,
      feedNKgM3: lastReactor.nh + lastReactor.no3,
      feedPKgM3: lastReactor.tp,
      ambientTempC: T,
    };
    const sludgeTrace = ctx.trace
      ? {
          initial: structuredClone(state.plant.sludgeLine),
          feed: sludgeFeed,
          dtH,
        }
      : undefined;
    const filtrate = stepSludgeLine(state.plant.sludgeLine, sludgeFeed, dtH);
    if (ctx.trace && sludgeTrace) {
      ctx.trace.sludge = {
        ...sludgeTrace,
        expected: {
          state: structuredClone(state.plant.sludgeLine),
          filtrate: { ...filtrate },
        },
      };
    }
    if (filtrate.flowM3h > 1e-6 && Q > 1e-6) {
      state.influent.nh += (filtrate.nh4NKgM3 * filtrate.flowM3h) / Q;
      state.influent.tn += (filtrate.nh4NKgM3 * filtrate.flowM3h) / Q;
      state.influent.cod += (filtrate.codKgM3 * filtrate.flowM3h) / Q;
      state.influent.tp += (filtrate.tpKgM3 * filtrate.flowM3h) / Q;
    }
  }

  // ── WP2 全厂三本账：COD / N / P 逐步积分；残差超阈值记诊断，不阻断 ──
  if (state.plant) {
    let invCod = 0;
    let invN = 0;
    let invP = 0;
    let invPpP = 0;
    for (const r of state.reactors) {
      if (state.modelMode === 'asm2d' && r.asm2d) {
        const a = r.asm2d;
        invCod += ((a.S_I + a.S_F + a.S_A + a.X_I + a.X_S + a.X_H + a.X_PAO + a.X_AUT + a.X_PHA) * r.volume) / 1000;
        // 库存氮：溶解态 + 颗粒态结合氮（活体生物量 0.07、慢速基质 X_S 0.04），
        // 不再只按全局 biomassKg 折算，避免惰性颗粒增长时结合氮漏记、释氮时库存不下降。
        invN +=
          ((a.S_NH4 + a.S_NO3 + a.S_N2 + a.S_F * ASM2D_PARAMS.i_N_SI) * r.volume) / 1000 +
          ((a.X_H + a.X_PAO + a.X_AUT) * ASM2D_PARAMS.i_N_BM * r.volume) / 1000 +
          ((a.X_S + a.X_I) * ASM2D_PARAMS.i_N_XS * r.volume) / 1000;
        const ppPKg = (a.X_PP * ASM2D_PARAMS.i_P_PP * r.volume) / 1000;
        invPpP += ppPKg;
        // 库存磷：溶液态正磷 + 活体生物量结合磷 + 本池 X_PP 胞内聚磷（逐池加，不能重复累加）
        invP +=
          (a.S_PO4 * r.volume) / 1000 +
          ((a.X_S + a.X_I) * ASM2D_PARAMS.i_P_XS * r.volume) / 1000 +
          (a.X_MEP * r.volume) / 1000 +
          ((a.X_H + a.X_PAO + a.X_AUT) * ASM2D_PARAMS.i_P_BM * r.volume) / 1000 +
          ppPKg;
      } else {
        invCod += (r.cod * r.volume) / 1000;
        invN += ((r.nh + r.no3) * r.volume) / 1000;
        invP += (r.tp * r.volume) / 1000;
      }
    }
    // 二沉池污泥库存也属于全厂边界；不能只算反应池，否则 RAS/底流存量变化会记成源/汇。
    const clarSludge = state.clarifier.sludgeMassKg;
    // 二沉池存泥的 N/P 含量必须用底流实测组分折算，不能固定 0.07/0.02：
    // 生物除磷污泥的 P/SS 可达 6%–8%，固定 2% 会把澄清池 P 库存少记 3–4 倍。
    const clarFeedSolids = lastReactor.asm2d ? asm2dFeedSolids(lastReactor.asm2d) : 0;
    const clarPContent =
      clarFeedSolids > 1 && lastReactor.asm2d
        ? asm2dPConcentration(lastReactor.asm2d) / clarFeedSolids
        : ASM2D_PARAMS.i_P_BM;
    const clarNContent =
      clarFeedSolids > 1 && lastReactor.asm2d ? asm2dNConcentration(lastReactor.asm2d) / clarFeedSolids : 0.07;
    invN += clarSludge * clarNContent;
    invP += clarSludge * clarPContent;

    // 组分口径负荷（仅 asm2d）：进水/排泥的 COD/N/P 由组分 × 流量 × 结合权重直接求和；
    // 出水走二沉池溢流（state.effluent 已是澄清后浓度），不能用反应池全量颗粒态当出水。
    let component: Parameters<typeof updatePlantBalance>[1]['component'];
    if (state.modelMode === 'asm2d' && lastReactor.asm2d) {
      const infAsm = influentToAsm2d({
        cod: rawInfluent.cod,
        nh: rawInfluent.nh,
        no3: 0,
        tp: rawInfluent.tp,
        ss: rawInfluent.ss,
        alkalinity: rawInfluent.alkalinity,
      });
      const rasAsm = lastReactor.asm2d;
      // 出水 TP/TN 不能只取溶解态：二沉池溢流夹带的悬浮固体仍带 P/N。
      // 按 xEff/feedSolids 比例把末端池颗粒态折到出水，否则这部分 P/N 会记成“消失”。
      const effFeedSolids = asm2dFeedSolids(lastReactor.asm2d);
      const effScale = effFeedSolids > 1 ? state.clarifier.xEff / effFeedSolids : 0;
      const effPConc =
        lastReactor.asm2d.S_PO4 +
        Math.max(0, asm2dPConcentration(lastReactor.asm2d) - lastReactor.asm2d.S_PO4) * effScale;
      const effNConc =
        lastReactor.asm2d.S_NH4 +
        lastReactor.asm2d.S_NO3 +
        Math.max(0, asm2dNConcentration(lastReactor.asm2d) - lastReactor.asm2d.S_NH4 - lastReactor.asm2d.S_NO3) *
          effScale;
      const kgPer = (conc: number, flow: number) => (Math.max(0, conc) * Math.max(0, flow) * dtH) / 1000;
      // 进水负荷必须用原水流量，不能用含内回流/RAS 的总水力 Q；否则同一股水被放大 25%。
      const qIn = rawInfluent.flow;
      component = {
        codInKg: kgPer(asm2dCodConcentration(infAsm), qIn),
        codEffKg: kgPer(state.effluent.cod, state.effluent.flow),
        nInKg: kgPer(asm2dNConcentration(infAsm), qIn),
        nEffKg: kgPer(effNConc + lastReactor.asm2d.S_N2, state.effluent.flow),
        pInKg: kgPer(rawInfluent.tp, qIn),
        pEffKg: kgPer(effPConc, state.effluent.flow),
        wasteCodKg: kgPer(asm2dCodConcentration(rasAsm), Qw),
        wasteNKg: kgPer(asm2dNConcentration(rasAsm), Qw),
        // 排泥 P 按 98% 脱水捕集率折算；2% 作为滤液/分析损失，不进入泥饼。
        wastePKg: kgPer(asm2dPConcentration(rasAsm) * 0.98, Qw),
      };
    }
    const balanceInput = {
      influent: rawInfluent,
      effluent: state.effluent,
      dtH,
      biomassKg: state.biomassKg,
      inventory: { codKg: invCod, nKg: invN, pKg: invP, ppPKg: invPpP },
      oxidizedCodKgH: oxidized.balancedOxidizedKgH,
      denitrifiedNKgH: oxidized.denitrifiedNKgH,
      clampCodKgH: oxidized.clampCodKgH,
      clampNKgH: oxidized.clampNKgH,
      clampPKgH: oxidized.clampPKgH,
      wastedDryKg: wasted,
      component,
    };
    if (ctx.trace) {
      ctx.trace.balance = {
        initial: {
          cod: structuredClone(state.plant.balance.cod),
          n: structuredClone(state.plant.balance.n),
          p: structuredClone(state.plant.balance.p),
          inventory: structuredClone(state.plant.inventory),
          errors: structuredClone(state.plant.errors),
        },
        input: structuredClone(balanceInput),
        expected: {
          cod: structuredClone(state.plant.balance.cod),
          n: structuredClone(state.plant.balance.n),
          p: structuredClone(state.plant.balance.p),
          inventory: structuredClone(state.plant.inventory),
          errors: structuredClone(state.plant.errors),
        },
      };
    }
    updatePlantBalance(state.plant, balanceInput);
    if (ctx.trace?.balance) {
      ctx.trace.balance.expected = {
        cod: structuredClone(state.plant.balance.cod),
        n: structuredClone(state.plant.balance.n),
        p: structuredClone(state.plant.balance.p),
        inventory: structuredClone(state.plant.inventory),
        errors: structuredClone(state.plant.errors),
      };
    }
    if (traceStep && lastReactor.asm2d && state.modelMode === 'asm2d') {
      traceStep.inventory = {
        initialBiomassKg: state.biomassKg,
        reactors: state.reactors
          .filter((r) => r.asm2d)
          .map((r) => ({ volume: r.volume, state: { ...(r.asm2d as NonNullable<typeof r.asm2d>) } })),
        clarifierSludgeKg: state.clarifier.sludgeMassKg,
        clarifierFeedState: { ...lastReactor.asm2d },
        expected: { codKg: invCod, nKg: invN, pKg: invP, ppPKg: invPpP },
      };
    }
  }

  raiseLimitAlarms(state);

  if (traceStep) trace?.(traceStep);
  return state;
}

export function spinUpNetwork(state: NetworkSimState, topo: ProcessTopology, days: number): NetworkSimState {
  const steps = Math.floor((days * 1440) / 2);
  for (let i = 0; i < steps; i++) stepNetwork(state, topo, 2);
  state.alarms = [];
  state.alarmSeq = 0;
  state.cost = { energy: 0, chemical: 0, sludge: 0, total: 0 };
  state.costToday = { energy: 0, chemical: 0, sludge: 0, total: 0 };
  state.totals = { inflowM3: 0, energyKwh: 0, wasteSludgeKg: 0, influentCodKg: 0, oxidizedCodKg: 0 };
  state.lastDay = 0;
  state.timeMin = 0;
  // 全厂台账库存与泥线累计同样归零：统计窗口必须与仿真时钟一致，否则 spin-up 期间的
  // 出水/库存会被算进 30 d 台账，凭空放大出水负荷。
  if (state.plant) resetPlantBoundary(state.plant);
  // 子系统时钟必须跟主时钟一起归零：spin-up 期间仪表/控制层各自走满 30 天，
  // 否则快照上会出现“主时钟 0 min、仪表 43200 min”的错位时间轴。
  if (state.instruments) state.instruments.registry.timeMin = 0;
  if (state.controlLayer) state.controlLayer.timeMin = 0;
  return state;
}

export function startNetworkScenario(
  state: NetworkSimState,
  type: ScenarioSpec['type'],
  options: { durationMin?: number; magnitude?: number } = {},
): ScenarioSpec {
  const meta = SCENARIOS[type];
  state.scenario = {
    type,
    durationMin: options.durationMin ?? meta.defaultDurationMin,
    magnitude: options.magnitude ?? meta.defaultMagnitude,
    startedAt: state.timeMin,
  };
  return state.scenario;
}

/** 预测克隆：浅拷贝可变字段，共享只读的编译结果（比 structuredClone 快约 200 倍） */
export function cloneNetworkState(state: NetworkSimState): NetworkSimState {
  return {
    ...state,
    reactors: state.reactors.map((r) => ({ ...r, asm1: r.asm1 ? { ...r.asm1 } : undefined })),
    clarifier: { ...state.clarifier, settler: { x: [...state.clarifier.settler.x] } },
    clarifiers: state.clarifiers?.map((c) => ({ ...c, settler: { x: [...c.settler.x] } })),
    hydraulics: state.hydraulics ? cloneHydraulics(state.hydraulics) : undefined,
    plant: state.plant ? clonePlantBoundary(state.plant) : undefined,
    instruments: state.instruments ? structuredClone(state.instruments) : undefined,
    controlLayer: state.controlLayer ? structuredClone(state.controlLayer) : undefined,
    assets: state.assets ? structuredClone(state.assets) : undefined,
    influent: { ...state.influent },
    effluent: { ...state.effluent },
    controls: { ...state.controls },
    scenario: state.scenario ? { ...state.scenario } : null,
    energy: { ...state.energy },
    alarms: state.alarms.map((a) => ({ ...a })),
    cost: { ...state.cost },
    costToday: { ...state.costToday },
    totals: { ...state.totals },
    stormStorageM3: state.stormStorageM3,
    volume: { ...state.volume },
    uncertainty: state.uncertainty ? { ...state.uncertainty } : undefined,
  };
}

/**
 * 拓扑引擎的 PlantModel 实现：预测 = 克隆当前状态，按给定控制量推进。
 * 因为用的是同一份编译拓扑，预测与被控对象永远一致。
 */
export function networkModel(topo: ProcessTopology, state: NetworkSimState): PlantModel {
  return {
    snapshot: () => networkSnapshot(state),
    predict: (controls, horizonMin, sampleEveryMin) =>
      runForecast(state, topo, controls, horizonMin, sampleEveryMin, null, null),
    predictWithScenario: (controls, horizonMin, sampleEveryMin, scenario) =>
      runForecast(state, topo, controls, horizonMin, sampleEveryMin, scenario, null),
    predictWithUncertainty: (controls, horizonMin, sampleEveryMin, factor) =>
      runForecast(state, topo, controls, horizonMin, sampleEveryMin, null, factor),
  };
}

function runForecast(
  state: NetworkSimState,
  topo: ProcessTopology,
  controls: import('./config').ControlSettings,
  horizonMin: number,
  sampleEveryMin: number,
  scenario: import('./scenarios').ScenarioType | null,
  uncertainty: import('./plantModel').UncertaintyFactor | null,
): import('./plantModel').ForecastOutcomeX {
  const clone = cloneNetworkState(state);
  clone.controls = { ...controls };
  if (uncertainty) {
    clone.uncertainty = { ...uncertainty };
    // 生物量扰动直接作用在存量上：低产率/高产率两种工艺假设
    clone.biomassKg = clone.biomassKg * uncertainty.biomass;
  }
  if (scenario) {
    /**
     * 预测必须用该场景的默认强度，不能一律写 1。
     *
     * magnitude 的语义按场景不同：暴雨/冲击/毒性是「倍数」（1 = 标准强度），
     * 但 blower_failure 是「剩余供气能力」（1 = 没有故障）、winter 是「目标水温 ℃」。
     * 写死 1 会让"如果鼓风机坏了会怎样"的推演说成"一切正常"——
     * 实测 baseline NH₄ 0.71、blower_failure 推演也是 0.71，等于假推演。
     */
    clone.scenario = {
      type: scenario,
      durationMin: SCENARIOS[scenario].defaultDurationMin,
      magnitude: SCENARIOS[scenario].defaultMagnitude,
      startedAt: clone.timeMin,
    };
    /**
     * 场景必须真正生效到预测窗口内。
     *
     * 预演窗口最短 120 min，而 power_outage 默认时长 45 min、ras_failure 120 min：
     * 若不做处理，"如果停电会怎样"的推演在最后一个采样点已经恢复到正常工况，
     * 输出看起来像"停电没事"。这里把场景时长拉到覆盖整个预测窗口，
     * 让推演回答的是"持续处于该工况"而非"短暂扰动后恢复"。
     */
    clone.scenario.durationMin = Math.max(clone.scenario.durationMin, horizonMin + 60);
  }
  const startCost = clone.cost.total;
  const points: ReturnType<typeof networkModel> extends never ? never : import('./plantModel').ForecastPointX[] = [];
  const violations: { metric: string; minute: number; value: number; limit: number }[] = [];
  let peak = 0;
  for (let m = 0; m < horizonMin; m++) {
    stepNetwork(clone, topo, 1);
    peak = Math.max(peak, clone.energy.totalKw);
    if ((m + 1) % sampleEveryMin === 0) {
      const e = clone.effluent;
      const lastDo = clone.reactors[clone.reactors.length - 1]?.doLevel ?? 0;
      points.push({
        minute: m + 1,
        effluent: { ...e },
        doLevel: lastDo,
        blanket: clone.clarifier.blanketM,
        score: qualityScoreOf(e),
        energyKw: clone.energy.totalKw,
      });
      /**
       * 六个指标一起判，别再漏 BOD₅。
       *
       * 旧实现手写五条（cod/nh/tn/tp/ss），BOD 超限不会进入预测违规列表，
       * 界面会出现「BOD 已超但预测说无违规」。统一走 metrics 的六指标行。
       */
      for (const row of effluentMarginRows(e)) {
        if (row.finite && row.ratio > 1)
          violations.push({ metric: row.metric, minute: m + 1, value: row.value, limit: row.limit });
      }
    }
  }
  return {
    points,
    violations,
    costDelta: clone.cost.total - startCost,
    peakEnergyKw: peak,
    endSrt: clone.srtDays,
    endBlanket: clone.clarifier.blanketM,
    endDilute: clone.inhibition,
  };
}

/** 兼容旧命名：网络引擎的出水评分与共享实现一致 */
export const qualityScoreOf = qualityScore;

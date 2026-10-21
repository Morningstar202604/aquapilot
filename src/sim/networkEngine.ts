import { ControlSettings, DEFAULT_CONTROLS, INFLUENT_DESIGN, LIMITS, PLANT } from './config';
import { mulberry32 } from './rng';
import { ScenarioSpec, SCENARIOS } from './scenarios';
import { CompiledNetwork, compileNetwork, resolveFlows } from './network';
import { networkSnapshot, PlantModel } from './plantModel';
import { clampControls, qualityScore } from './metrics';
import { KINETICS, DESIGN_MLSS } from './kinetics';
import { BSM1_SETTLER, SettlerState, createSettler, stepSettler } from './takacs';
import {
  ASM1_COMPONENTS,
  ASM1_PARAMS,
  ASM1_PROCESSES,
  buildRates,
  buildStoichiometry,
  emptyAsm1State,
  reactionRates,
  type Asm1Component,
  type Asm1State,
} from './asm1';
import { fromAsm1, influentToAsm1, toAsm1 } from './asm1Mapping';

const STOICH = buildStoichiometry();
const RATE_FNS = buildRates();

/** 带抑制的 ASM1 速率：自养菌对毒性更敏感（平方），异养菌更耐受（开方） */
function reactionRatesWithSuppression(s: Asm1State, suppression: number): Asm1State {
  if (suppression >= 0.999) return reactionRates(s);
  const autoF = Math.max(0, suppression) ** 2;
  const heteroF = Math.sqrt(Math.max(0, suppression));
  const out = emptyAsm1State();
  for (const proc of ASM1_PROCESSES) {
    const factor = proc === 'aerobic_growth_autotrophs' || proc === 'decay_autotrophs' ? autoF : heteroF;
    const rate = RATE_FNS[proc](s) * ASM1_PARAMS.PER_DAY_TO_PER_HOUR * factor;
    if (rate <= 0 || !Number.isFinite(rate)) continue;
    for (const [comp, coef] of Object.entries(STOICH[proc]) as [Asm1Component, number][]) {
      out[comp] += coef * rate;
    }
  }
  return out;
}

import { ProcessTopology } from '../model/topology';

/**
 * 拓扑求解引擎（生产路径）。
 *
 * 反应器数量、容积、连接关系全部来自 ProcessTopology；引擎里没有"五个池"的假设。
 * 求解顺序由 network.ts 编译出的拓扑序决定，回流边每步按控制量定流量。
 *
 * 与 engine.ts（固定五池参考实现）的关系：
 * - 动力学常数一致，便于对照
 * - 本文件是服务端、AI 决策、预测的唯一入口
 */

/**
 * 拓扑驱动的求解引擎（v2）。
 *
 * 与 v1 的本质区别：v1 的五个池是写死的；v2 的反应器由 CompiledNetwork 决定，
 * 拓扑里加一个缺氧池，这里就多解一个缺氧池，不需要改引擎代码。
 */

export interface ReactorState {
  id: string;
  name: string;
  kind: 'anaerobic' | 'anoxic' | 'aerobic';
  volume: number;
  /** ASM1 13 组分状态；仅在 modelMode === 'asm1' 时存在 */
  asm1?: import('./asm1').Asm1State;
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  doLevel: number;
  alkalinity: number;
  temperature: number;
  o2Demand: number;
  kla: number;
  inflow: number;
}

export interface EffluentStats {
  flow: number;
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
  ph: number;
  temperature: number;
}

export type KineticModel = 'simple' | 'asm1';

export interface NetworkSimState {
  timeMin: number;
  seed: number;
  rngCount: number;
  topologyId: string;
  modelMode: KineticModel;
  reactors: ReactorState[];
  order: string[];
  clarifier: {
    area: number;
    depth: number;
    /** Takács 十层剖面 */
    settler: SettlerState;
    blanketM: number;
    sludgeMassKg: number;
    xRas: number;
    xEff: number;
    slr: number;
  };
  influent: {
    flow: number;
    cod: number;
    bod: number;
    nh: number;
    tn: number;
    tp: number;
    ss: number;
    temperature: number;
    alkalinity: number;
  };
  effluent: EffluentStats;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  biomassKg: number;
  srtDays: number;
  /** 食微比 F/M = kg BOD₅/d ÷ kg MLSS */
  fmRatio: number;
  inhibition: number;
  aerationCapacity: number;
  energy: { blowerKw: number; mixerKw: number; pumpKw: number; totalKw: number };
  alarms: { id: string; at: number; severity: 'warning' | 'critical'; code: string; message: string; metric?: string; value?: number }[];
  alarmSeq: number;
  /** 累计（自预热结束起） */
  cost: { energy: number; chemical: number; sludge: number; total: number };
  /** 当个仿真日（跨日清零） */
  costToday: { energy: number; chemical: number; sludge: number; total: number };
  lastDay: number;
  stormStorageM3: number;
  volume: { bio: number; aerobic: number; anoxic: number; anaerobic: number };
  edgeFlows: Record<string, number>;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));



export function createNetworkState(
  topo: ProcessTopology,
  options: { seed?: number; controls?: Partial<ControlSettings>; model?: KineticModel } = {},
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
  const networkDefaults: ControlSettings = { ...DEFAULT_CONTROLS, wasRatio: 0.022 };
  const controls: ControlSettings = clampControls({ ...networkDefaults, ...options.controls });
  const clarifier = topo.units.find((u) => u.kind === 'clarifier');
  const area = clarifier?.area ?? PLANT.clarifier.area;
  const depth = clarifier?.depth ?? PLANT.clarifier.depth;

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
    reactors,
    order: [...net.reactors].sort((a, b) => a.order - b.order).map((r) => r.id),
    clarifier: {
      area,
      depth,
      settler: createSettler({ ...BSM1_SETTLER, area, depth }, 3000),
      blanketM: 1.0,
      sludgeMassKg: 22000,
      xRas: 8600,
      xEff: 4,
      slr: 3.4,
    },
    influent: { ...INFLUENT_DESIGN },
    effluent: { flow: INFLUENT_DESIGN.flow, cod: 30, bod: 7, ss: 5, nh: 1.6, tn: 11, tp: 0.35, ph: 7.2, temperature: 20 },
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
    lastDay: 0,
    stormStorageM3: 0,
    volume: {
      bio: net.bioVolume,
      aerobic: net.aerobicVolume,
      anoxic: net.anoxicVolume,
      anaerobic: net.anaerobicVolume,
    },
    edgeFlows: {},
  };
}

function diurnal(timeMin: number): number {
  const h = (timeMin / 60) % 24;
  return 0.78 + 0.3 * Math.exp(-(((h - 10) / 3.6) ** 2)) + 0.26 * Math.exp(-(((h - 20) / 3.2) ** 2));
}

export function scenarioEnvelope(spec: ScenarioSpec | null, timeMin: number): number {
  if (!spec) return 0;
  const elapsed = timeMin - spec.startedAt;
  if (elapsed < 0 || elapsed > spec.durationMin) return 0;
  const rampIn = spec.type === 'storm' ? 20 : spec.type === 'power_outage' ? 1 : 8;
  const rampOut = spec.type === 'storm' ? 80 : spec.type === 'power_outage' ? 2 : 30;
  if (elapsed < rampIn) return elapsed / rampIn;
  if (spec.durationMin - elapsed < rampOut) return Math.max(0, (spec.durationMin - elapsed) / rampOut);
  return 1;
}

function seasonalTemp(timeMin: number): number {
  return 19.5 + 3.6 * Math.sin((2 * Math.PI * (timeMin / 1440 - 60)) / 365);
}

function deriveInfluent(state: NetworkSimState): NetworkSimState['influent'] {
  const rng = mulberry32(state.seed * 31 + state.rngCount * 7919 + Math.floor(state.timeMin * 13));
  const d = diurnal(state.timeMin);
  const noise = (s: number) => 1 + rng.normal() * s;
  const env = state.scenario ? scenarioEnvelope(state.scenario, state.timeMin) : 0;
  const mag = state.scenario?.magnitude ?? 0;

  let flow = INFLUENT_DESIGN.flow * d * noise(0.012);
  let cod = INFLUENT_DESIGN.cod * (0.92 + 0.18 * (d - 0.78)) * noise(0.035);
  let nh = INFLUENT_DESIGN.nh * (0.94 + 0.14 * (d - 0.78)) * noise(0.03);
  let tp = INFLUENT_DESIGN.tp * noise(0.04);
  let ss = INFLUENT_DESIGN.ss * noise(0.05);
  let temperature = seasonalTemp(state.timeMin) + rng.normal() * 0.15;
  let alkalinity = INFLUENT_DESIGN.alkalinity * noise(0.02);

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
  return {
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
}

function toxicSuppression(state: NetworkSimState): number {
  if (!state.scenario || state.scenario.type !== 'toxic') return 1;
  const env = scenarioEnvelope(state.scenario, state.timeMin);
  return 1 - env * clamp(0.45 + 0.3 * state.scenario.magnitude, 0, 0.85);
}

function aerationCapacityOf(state: NetworkSimState): number {
  if (!state.scenario) return 1;
  const env = scenarioEnvelope(state.scenario, state.timeMin);
  if (state.scenario.type === 'blower_failure') return 1 - env * (1 - (state.scenario.magnitude || 0.5));
  if (state.scenario.type === 'power_outage') return 1 - env;
  return 1;
}

function recycleOf(state: NetworkSimState): { ras: number; ir: number; was: number } {
  let { rasRatio: ras, internalRecirc: ir, wasRatio: was } = state.controls;
  if (state.scenario) {
    const env = scenarioEnvelope(state.scenario, state.timeMin);
    if (state.scenario.type === 'ras_failure') ras *= 1 - env;
    if (state.scenario.type === 'power_outage') {
      ir = 0;
      ras *= 1 - env;
      was *= 1 - env;
    }
  }
  return { ras, ir, was };
}

function mixed(a: number, qa: number, b: number, qb: number): number {
  const q = qa + qb;
  return q > 0 ? (a * qa + b * qb) / q : a;
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
  state.alarms.push({ id: `A${String(state.alarmSeq).padStart(4, '0')}`, at: state.timeMin, severity, code, message, metric, value });
  if (state.alarms.length > 80) state.alarms.splice(0, state.alarms.length - 80);
}

/**
 * 推进一个时间步。反应器按拓扑序求解，回流在每步开头按控制量定流量。
 */
export function stepNetwork(state: NetworkSimState, topo: ProcessTopology, dtMin = 1): NetworkSimState {
  if (dtMin <= 0) return state;
  const dtH = dtMin / 60;
  state.timeMin += dtMin;
  state.rngCount += 1;

  const net: CompiledNetwork = compileNetwork(topo);
  if (net.problems.length) {
    throw new Error(`运行中拓扑失效：${net.problems.join('；')}`);
  }

  const influent = deriveInfluent(state);
  const sup = toxicSuppression(state);
  state.inhibition = sup;
  state.aerationCapacity = aerationCapacityOf(state);
  const rec = recycleOf(state);

  // 调蓄分流
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
  state.influent = { ...influent, flow: Q };

  const flows = resolveFlows(net, Q, rec);
  state.edgeFlows = Object.fromEntries(flows.edgeFlow);

  const byId = new Map(state.reactors.map((r) => [r.id, r]));
  const xBiomass = clamp((state.biomassKg * 1000) / Math.max(1, state.volume.bio), 300, 14000);
  const bf = xBiomass / DESIGN_MLSS;
  const T = influent.temperature;
  const thetaH = Math.pow(KINETICS.thetaH, T - 20);
  const thetaN = Math.pow(KINETICS.thetaN, T - 20);

  const clar = state.clarifier;
  const Qr = Q * rec.ras;
  const Qw = Q * rec.was;
  const Qe = Math.max(1, Q - Qw);
  const underflow = Qr + Qw;

  // 回流污泥来自二沉池底部，其水质近似最末端反应器
  const lastReactor = [...state.reactors].sort((a, b) => net.reactors.find((r) => r.id === b.id)!.order - net.reactors.find((r) => r.id === a.id)!.order)[0];
  const rasCod = lastReactor?.cod ?? 20;
  const rasNh = lastReactor?.nh ?? 1;
  const rasNo3 = lastReactor?.no3 ?? 8;
  const rasTp = lastReactor?.tp ?? 0.2;
  const rasAlk = lastReactor?.alkalinity ?? 180;

  let o2DemandKgH = 0;
  let codOxidizedKgH = 0;
  let nhOxidizedKgH = 0;

  const orderedReactorIds = net.reactors.slice().sort((a, b) => a.order - b.order).map((r) => r.id);

  for (const id of orderedReactorIds) {
    const reactor = byId.get(id);
    if (!reactor) continue;

    // 入流构成
    const incoming = net.edges.filter((e) => e.to === id);
    let qIn = 0;
    let codIn = 0;
    let nhIn = 0;
    let no3In = 0;
    let tpIn = 0;
    let alkIn = 0;

    for (const edge of incoming) {
      const flow = flows.edgeFlow.get(edge.id) ?? 0;
      if (flow <= 0) continue;
      const isFromReactor = byId.has(edge.from);
      const source = isFromReactor ? byId.get(edge.from)! : null;

      let c: { cod: number; nh: number; no3: number; tp: number; alk: number };
      if (edge.recycleKind === 'ras') {
        c = { cod: rasCod, nh: rasNh, no3: rasNo3, tp: rasTp, alk: rasAlk };
      } else if (edge.recycleKind === 'internal') {
        c = {
          cod: lastReactor?.cod ?? 20,
          nh: lastReactor?.nh ?? 1,
          no3: lastReactor?.no3 ?? 8,
          tp: lastReactor?.tp ?? 0.2,
          alk: lastReactor?.alkalinity ?? 180,
        };
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

      // 入流组分：按流量加权
      let asmIn = emptyAsm1State();
      let qAcc = 0;
      for (const edge of incoming) {
        const flow = flows.edgeFlow.get(edge.id) ?? 0;
        if (flow <= 0) continue;
        let src: Asm1State;
        if (edge.recycleKind === 'ras' && lastReactor?.asm1) src = lastReactor.asm1;
        else if (edge.recycleKind === 'internal' && lastReactor?.asm1) src = lastReactor.asm1;
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
        else
          for (const comp of ASM1_COMPONENTS)
            asmIn[comp] = (asmIn[comp] * qAcc + src[comp] * flow) / (qAcc + flow);
        qAcc += flow;
      }

      const r = reactionRatesWithSuppression(reactor.asm1, sup);
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
      const SOLUBLE = new Set(['S_I', 'S_S', 'S_O', 'S_NO', 'S_NH', 'S_ND', 'S_ALK']);

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
       * 颗粒态的真正流失途径只有一个：随出水悬浮物离开。
       *
       * 流失比例 = 出水 SS / 池内 SS（浓度比），
       * 即 (Qe·xEff) / (V·X)——这才是"每步被出水带走的池内固体份额"。
       *
       * 之前用 Q/qIn（约 26%）是把"随水流出反应器"误当成"离开系统"，
       * 而实际上那些固体随回流又回来了。这一步之差导致生物量在几小时内归零。
       */
      const reactorSS = reactor.asm1.X_I + reactor.asm1.X_S + reactor.asm1.X_B_H + reactor.asm1.X_B_A + reactor.asm1.X_P;
      const outFraction =
        reactorSS > 1
          ? Math.min(1, (Qe * clar.xEff) / Math.max(1, reactorSS * qIn * (1 / qOverV) / 24) / 24)
          : 0;

      for (const comp of ASM1_COMPONENTS) {
        if (comp === 'S_ALK') continue;
        if (SOLUBLE.has(comp)) {
          nextAsm1[comp] = Math.max(
            0,
            reactor.asm1[comp] + dtH * (qOverV * (asmIn[comp] - reactor.asm1[comp]) + r[comp]),
          );
        } else {
          // 颗粒态：入流带入 + 反应生成 - 仅出水带走的部分
          const transportLoss = qOverV * reactor.asm1[comp] * outFraction;
          nextAsm1[comp] = Math.max(0, reactor.asm1[comp] + dtH * (r[comp] - transportLoss));
        }
      }
      nextAsm1.S_ALK = Math.max(0, reactor.asm1.S_ALK + dtH * qOverV * (asmIn.S_ALK - reactor.asm1.S_ALK));

      // 溶解氧：好氧池维持在设定值（供氧能力已由 aerationCapacity 表达）
      if (reactor.kind === 'aerobic' && state.aerationCapacity > 0.02) {
        nextAsm1.S_O = Math.min(KINETICS.doSat20 * 0.85, state.controls.doSetpoint * state.aerationCapacity);
      } else {
        nextAsm1.S_O = Math.max(0, nextAsm1.S_O - dtH * 3);
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
      continue;
    }

    const fCod = reactor.cod / (KINETICS.ksCod + reactor.cod);
    const fNh = reactor.nh / (KINETICS.ksNh + reactor.nh);
    const fO2 = reactor.doLevel / (KINETICS.ksO2 + reactor.doLevel);
    const fO2Nit = reactor.doLevel / (KINETICS.ksO2Nit + reactor.doLevel);

    let codRate = 0;
    let nhRate = 0;
    let no3Rate = 0;
    let tpRate = 0;
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
      nhRate = -KINETICS.kNit * fNh * fO2Nit * thetaN * bf * sup * (reactor.alkalinity > 30 ? 1 : reactor.alkalinity / 30);
      tpRate = -KINETICS.kPUp * (reactor.tp / (0.25 + reactor.tp)) * fO2 * bf * sup;
      o2Rate = hetero * KINETICS.o2PerCod + -nhRate * KINETICS.o2PerNh;
    }

    reactor.cod = Math.max(2, (reactor.cod + dtH * (qOverV * codIn + codRate)) / (1 + dtH * qOverV));
    reactor.nh = Math.max(0.01, (reactor.nh + dtH * (qOverV * nhIn + nhRate)) / (1 + dtH * qOverV));

    const nOxidized = Math.max(0, -nhRate) * dtH;
    const dn = Math.max(0, -no3Rate) * dtH;
    reactor.no3 = Math.max(0.01, (reactor.no3 + dtH * qOverV * no3In + nOxidized * 0.88 - dn) / (1 + dtH * qOverV));
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
      reactor.doLevel = clamp(reactor.doLevel + (clamp(doTarget, 0.02, dsat) - reactor.doLevel) * clamp(dtH / tau, 0, 1), 0.02, dsat);
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
  }

  // ── 二沉池：Takács 十层沉降模型 ──
  // 用分层剖面直接给出回流浓度与出水悬浮物，取代原先的经验关联式。
  // 这是 ASM1 能接入的前提：生物量的截留必须由物理沉降决定，而不是外部指定的系数。
  const clarifierInflow = Q * (1 + Math.max(rec.ras, 0.3));
  const settlerCfg = {
    ...BSM1_SETTLER,
    area: clar.area,
    depth: clar.depth,
  };

  const settlerResult = stepSettler(
    clar.settler,
    settlerCfg,
    { flow: clarifierInflow * 24, concentration: xBiomass }, // m³/d, g/m³
    { flow: underflow * 24 },
    dtMin / 1440,
  );
  clar.settler = settlerResult.state;
  clar.slr = settlerResult.solidsLoading;

  // 分层模型的输出直接作为回流与出水浓度
  clar.xRas = clamp(settlerResult.xUnderflow, 1000, 15000);
  clar.xEff = clamp(settlerResult.xEffluent, 0.5, 200);
  /**
   * 泥层高度：由固体负荷（SLR）与回流强度按工程关联式计算，不用分层剖面数层数。
   *
   * 原因：十层模型在小时间步下容易把浓缩区抹平，数层数得到的泥层与存量脱钩。
   * 而出水 SS 与回流浓度这两个真正进入工艺计算的量，已由分层剖面正确给出。
   * 泥层仅用于界面显示与跑泥判断，用关联式更稳定。
   *
   * 关联式形式参考固体通量理论：泥层随 SLR 上升、随回流比下降。
   */
  const slrFactor2 = clamp(settlerResult.solidsLoading / 3.6, 0.15, 3.2);
  const rasFactor2 = clamp(0.8 / Math.max(0.15, rec.ras), 0.2, 3.0);
  const blanketTarget = clamp(0.19 * clar.depth * Math.pow(slrFactor2, 1.25) * Math.pow(rasFactor2, 0.6), 0.25, clar.depth + 0.8);
  clar.blanketM += (blanketTarget - clar.blanketM) * Math.min(1, dtMin / 60 / 0.5);

  // 池内固体存量（供界面显示）
  const meanX = settlerResult.state.x.reduce((a, b) => a + b, 0) / settlerResult.state.x.length;
  clar.sludgeMassKg = (meanX * clar.area * clar.depth) / 1000;

  const rasDeficit = clamp(1 - rec.ras / Math.max(0.05, state.controls.rasRatio), 0, 1);
  void rasDeficit;

  const solidsIn = (clarifierInflow * xBiomass) / 1000;
  const solidsOut = ((Qr + Qw) * clar.xRas) / 1000 + (Qe * clar.xEff) / 1000;
  void solidsIn;
  void solidsOut;

  // 生物量
  const growth = KINETICS.yieldH * codOxidizedKgH + 0.11 * nhOxidizedKgH;
  const decay = (KINETICS.decayPerDay / 24) * state.biomassKg;
  const wasted = ((Qw * clar.xRas) / 1000) * dtH;

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
  } else {
    state.biomassKg = clamp(state.biomassKg + (growth - decay) * dtH - wasted, 5000, 400000);
    const wasKgDay = (Qw * 24 * clar.xRas) / 1000;
    state.srtDays = wasKgDay > 5 ? clamp(state.biomassKg / wasKgDay, 2, 60) : 60;
  }

  // 食微比：每天进入系统的 BOD 负荷 ÷ 系统内生物量
  const bodLoadKgDay = (Q * 24 * influent.bod) / 1000;
  state.fmRatio = bodLoadKgDay / Math.max(1, state.biomassKg);

  // 出水
  const pacAllowed = !(state.scenario?.type === 'chemical_shortage' && scenarioEnvelope(state.scenario, state.timeMin) > 0.3);
  const pacDose = pacAllowed ? state.controls.pacDose : 0;
  const suspend = clar.xEff;
  state.effluent = {
    flow: Qe,
    cod: clamp(lastReactor.cod + suspend * 1.3, 4, 900),
    bod: clamp(Math.max(1.2, (lastReactor.cod - 12) * 0.32 + suspend * 0.5), 1, 400),
    ss: clamp(suspend, 0.5, 150),
    nh: clamp(lastReactor.nh + suspend * 0.014, 0.02, 100),
    tn: clamp(lastReactor.nh + lastReactor.no3 + suspend * 0.025, 0.3, 120),
    tp: clamp(Math.max(0.01, lastReactor.tp + suspend * 0.014 - pacDose * KINETICS.pacPPerMg), 0.01, 20),
    ph: clamp(6.6 + 0.004 * (lastReactor.alkalinity - 40), 5.8, 8.7),
    temperature: T,
  };

  // 能耗
  const anoxicVol = state.volume.anoxic + state.volume.anaerobic;
  const blowerKw = clamp(o2DemandKgH / KINETICS.saeKgO2PerKwh / 0.7, 5, 900) * (state.aerationCapacity > 0.02 ? 1 : 0);
  const mixerKw = (anoxicVol * 3.4) / 1000;
  const pumpKw = (Q + Qr + Q * rec.ir) * 0.008;
  const totalKw = blowerKw + mixerKw + pumpKw;
  state.energy = { blowerKw, mixerKw, pumpKw, totalKw };

  const pacKg = (Q * pacDose * dtH) / 1000;
  const carbonKg = (Q * state.controls.carbonDose * dtH) / 1000;
  const alkKg = (Q * state.controls.alkDose * dtH) / 1000;
  const energyCost = totalKw * dtH * 0.68;
  const chemCost = pacKg * 2.2 + carbonKg * 3.6 + alkKg * 1.4;
  const sludgeCost = wasted * 0.36;
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

  const e = state.effluent;
  if (e.nh > LIMITS.nh) pushAlarm(state, 'critical', 'EFF_NH', `出水氨氮 ${e.nh.toFixed(2)} mg/L 超一级A`, 'nh', e.nh);
  if (e.cod > LIMITS.cod) pushAlarm(state, 'critical', 'EFF_COD', `出水 COD ${e.cod.toFixed(1)} mg/L 超一级A`, 'cod', e.cod);
  if (e.tp > LIMITS.tp) pushAlarm(state, 'warning', 'EFF_TP', `出水总磷 ${e.tp.toFixed(3)} mg/L 超一级A`, 'tp', e.tp);
  if (e.ss > LIMITS.ss) pushAlarm(state, 'warning', 'EFF_SS', `出水悬浮物 ${e.ss.toFixed(1)} mg/L 超一级A`, 'ss', e.ss);
  if (clar.blanketM > clar.depth - 0.4) pushAlarm(state, 'critical', 'SLUDGE_BLANKET', `二沉池泥位 ${clar.blanketM.toFixed(2)} m 接近跑泥`, 'blanket', clar.blanketM);

  return state;
}

export function spinUpNetwork(state: NetworkSimState, topo: ProcessTopology, days: number): NetworkSimState {
  const steps = Math.floor((days * 1440) / 2);
  for (let i = 0; i < steps; i++) stepNetwork(state, topo, 2);
  state.alarms = [];
  state.alarmSeq = 0;
  state.cost = { energy: 0, chemical: 0, sludge: 0, total: 0 };
  state.costToday = { energy: 0, chemical: 0, sludge: 0, total: 0 };
  state.lastDay = 0;
  state.timeMin = 0;
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


/**
 * 拓扑引擎的 PlantModel 实现：预测 = 克隆当前状态，按给定控制量推进。
 * 因为用的是同一份编译拓扑，预测与被控对象永远一致。
 */
export function networkModel(topo: ProcessTopology, state: NetworkSimState): PlantModel {
  return {
    snapshot: () => networkSnapshot(state),
    predict: (controls, horizonMin, sampleEveryMin) => runForecast(state, topo, controls, horizonMin, sampleEveryMin, null),
    predictWithScenario: (controls, horizonMin, sampleEveryMin, scenario) =>
      runForecast(state, topo, controls, horizonMin, sampleEveryMin, scenario),
  };
}

function runForecast(
  state: NetworkSimState,
  topo: ProcessTopology,
  controls: import('./config').ControlSettings,
  horizonMin: number,
  sampleEveryMin: number,
  scenario: import('./scenarios').ScenarioType | null,
): import('./plantModel').ForecastOutcomeX {
      const clone = structuredClone(state) as NetworkSimState;
      clone.controls = { ...controls };
      if (scenario) {
        clone.scenario = { type: scenario, durationMin: 360, magnitude: 1, startedAt: clone.timeMin };
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
          const checks: [string, number, number][] = [
            ['cod', e.cod, LIMITS.cod],
            ['nh', e.nh, LIMITS.nh],
            ['tn', e.tn, LIMITS.tn],
            ['tp', e.tp, LIMITS.tp],
            ['ss', e.ss, LIMITS.ss],
          ];
          for (const [metric, value, limit] of checks) {
            if (value > limit) violations.push({ metric, minute: m + 1, value, limit });
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

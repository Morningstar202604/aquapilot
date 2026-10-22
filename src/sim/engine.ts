/**
 * 固定五池引擎（参考实现）。
 *
 * 角色：这是最初的实现，池结构写死为 A²/O 五池，用于标定、对照与回归测试。
 * **生产路径已切换到 networkEngine（拓扑求解）**，服务端与 AI 都不再引用本文件。
 *
 * 保留它的理由：
 * 1. tests/engine.test.ts 用它做经典工况的基准对照
 * 2. scripts/calibrate.ts、scripts/bsm1-gap.ts 用它做标定与差距分析
 * 3. 拓扑引擎的动力学常数是逐项从它迁移过来的，保留原版便于回溯
 *
 * 改动本文件不会影响线上行为；改动力学请同步 networkEngine。
 */

import { BIO_VOLUME, ControlSettings, DEFAULT_CONTROLS, INFLUENT_DESIGN, LIMITS, PLANT, TankConfig } from './config';
import { mulberry32 } from './rng';
import { ScenarioSpec, SCENARIOS } from './scenarios';
import type {
  Alarm,
  ClarifierState,
  CostState,
  EffluentState,
  EnergyState,
  InfluentState,
  TankState,
} from './plantTypes';
import { clamp, clampControls, qualityScore, estimateMargin } from './metrics';
import { KINETICS, DESIGN_MLSS, TARIFF } from './kinetics';

export type { Alarm, ClarifierState, CostState, EffluentState, EnergyState, InfluentState, TankState };
export { clampControls, qualityScore, estimateMargin };

export interface SimState {
  timeMin: number;
  seed: number;
  rngCount: number;
  influent: InfluentState;
  tanks: TankState[];
  clarifier: ClarifierState;
  effluent: EffluentState;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  energy: EnergyState;
  biomassKg: number;
  srtDays: number;
  fmRatio: number;
  inhibition: number;
  aerationCapacity: number;
  chemicalsUsed: { pacKg: number; carbonKg: number; alkKg: number };
  wasteSludgeKg: number;
  stormStorageM3: number;
  stormBypassM3: number;
  cost: CostState;
  alarms: Alarm[];
  alarmSeq: number;
  totalInflowM3: number;
  totalOutflowM3: number;
  energyTotalKwh: number;
  accountingStartMin: number;
  lastDay: number;
}

export interface EngineOptions {
  seed?: number;
  initialTimeMin?: number;
  controls?: Partial<ControlSettings>;
}

function makeTank(config: TankConfig): TankState {
  return {
    ...config,
    cod: config.kind === 'anaerobic' ? 90 : 30,
    nh: config.kind === 'aerobic' ? 4 : 22,
    no3: config.kind === 'anaerobic' ? 0.2 : config.kind === 'anoxic' ? 4 : 6,
    tp: config.kind === 'anaerobic' ? 6 : 1,
    do: config.kind === 'aerobic' ? 2 : 0.08,
    mlss: DESIGN_MLSS,
    alkalinity: 220,
    temperature: 20,
    codRemoved: 0,
    nhRemoved: 0,
    o2Demand: 0,
    klaUsed: 0,
  };
}

export function createInitialState(options: EngineOptions = {}): SimState {
  const controls = clampControls({ ...DEFAULT_CONTROLS, ...options.controls });
  const volume = BIO_VOLUME;
  return {
    timeMin: options.initialTimeMin ?? 0,
    seed: options.seed ?? 20261019,
    rngCount: 0,
    influent: { ...INFLUENT_DESIGN },
    tanks: PLANT.tanks.map(makeTank),
    clarifier: {
      blanketM: 1.0,
      sludgeMassKg: 22000,
      xRas: 8600,
      xEff: 4,
      slr: 3.4,
      underflowM3h: 1600,
      area: PLANT.clarifier.area,
      depth: PLANT.clarifier.depth,
    },
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
    energy: { blowerKw: 380, mixerKw: 26, pumpKw: 62, totalKw: 468, specificKwhM3: 0.234 },
    biomassKg: (DESIGN_MLSS * volume) / 1000,
    srtDays: 18,
    fmRatio: 0.12,
    inhibition: 1,
    aerationCapacity: 1,
    chemicalsUsed: { pacKg: 0, carbonKg: 0, alkKg: 0 },
    wasteSludgeKg: 0,
    stormStorageM3: 0,
    stormBypassM3: 0,
    cost: { energyToday: 0, chemicalToday: 0, sludgeToday: 0, totalToday: 0, total: 0 },
    alarms: [],
    alarmSeq: 0,
    totalInflowM3: 0,
    totalOutflowM3: 0,
    energyTotalKwh: 0,
    accountingStartMin: 0,
    lastDay: 0,
  };
}

export function cloneState(state: SimState): SimState {
  return structuredClone(state);
}

function diurnal(timeMin: number): number {
  const h = (timeMin / 60) % 24;
  return 0.78 + 0.3 * Math.exp(-(((h - 10) / 3.6) ** 2)) + 0.26 * Math.exp(-(((h - 20) / 3.2) ** 2));
}

export function seasonalTemperature(timeMin: number): number {
  const day = timeMin / 1440;
  return 19.5 + 3.6 * Math.sin((2 * Math.PI * (day - 60)) / 365);
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

function deriveInfluent(state: SimState): InfluentState {
  const base = INFLUENT_DESIGN;
  const rng = mulberry32(state.seed * 31 + state.rngCount * 7919 + Math.floor(state.timeMin * 13));
  const d = diurnal(state.timeMin);
  const noise = (scale: number) => 1 + rng.normal() * scale;
  const env = state.scenario ? scenarioEnvelope(state.scenario, state.timeMin) : 0;
  const mag = state.scenario?.magnitude ?? 0;

  let flow = base.flow * d * noise(0.012);
  let cod = base.cod * (0.92 + 0.18 * (d - 0.78)) * noise(0.035);
  let nh = base.nh * (0.94 + 0.14 * (d - 0.78)) * noise(0.03);
  let tp = base.tp * noise(0.04);
  let ss = base.ss * noise(0.05);
  let temperature = seasonalTemperature(state.timeMin) + rng.normal() * 0.15;
  const ph = base.ph + rng.normal() * 0.05;
  let alkalinity = base.alkalinity * noise(0.02);

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

  return {
    flow: clamp(flow, 400, 5200),
    cod: clamp(cod, 90, 1400),
    bod: clamp(cod * 0.44, 30, 640),
    ss: clamp(ss, 45, 900),
    nh: clamp(nh, 8, 120),
    tn: clamp(nh * 1.27 + 4, 12, 160),
    tp: clamp(tp, 0.8, 16),
    ph: clamp(ph, 5.6, 8.6),
    temperature: clamp(temperature, 8, 31),
    alkalinity: clamp(alkalinity, 60, 380),
  };
}

function toxicSuppression(state: SimState): number {
  if (!state.scenario || state.scenario.type !== 'toxic') return 1;
  const env = scenarioEnvelope(state.scenario, state.timeMin);
  return 1 - env * clamp(0.45 + 0.3 * state.scenario.magnitude, 0, 0.85);
}

function aerationCapacity(state: SimState): number {
  if (!state.scenario) return 1;
  const env = scenarioEnvelope(state.scenario, state.timeMin);
  if (state.scenario.type === 'blower_failure') return 1 - env * (1 - (state.scenario.magnitude || 0.5));
  if (state.scenario.type === 'power_outage') return 1 - env;
  return 1;
}

function recycle(state: SimState): { ir: number; ras: number; was: number } {
  let { internalRecirc: ir, rasRatio: ras, wasRatio: was } = state.controls;
  if (state.scenario) {
    const env = scenarioEnvelope(state.scenario, state.timeMin);
    if (state.scenario.type === 'ras_failure') ras *= 1 - env;
    if (state.scenario.type === 'power_outage') {
      ir = 0;
      ras *= 1 - env;
      was *= 1 - env;
    }
  }
  return { ir, ras, was };
}

function mixed(cA: number, qA: number, cB: number, qB: number): number {
  const q = qA + qB;
  return q > 0 ? (cA * qA + cB * qB) / q : cA;
}

function pushAlarm(
  state: SimState,
  severity: Alarm['severity'],
  code: string,
  message: string,
  metric?: string,
  value?: number,
): void {
  const recent = state.alarms.find((a) => a.code === code && state.timeMin - a.at < 45);
  if (recent) return;
  state.alarmSeq += 1;
  state.alarms.push({
    id: `A${state.alarmSeq.toString().padStart(4, '0')}`,
    at: state.timeMin,
    severity,
    code,
    message,
    metric,
    value,
  });
  if (state.alarms.length > 80) state.alarms.splice(0, state.alarms.length - 80);
}

export function activeScenario(state: SimState): ScenarioSpec | null {
  if (!state.scenario) return null;
  const end = state.scenario.startedAt + state.scenario.durationMin;
  return state.timeMin >= state.scenario.startedAt && state.timeMin <= end ? state.scenario : null;
}

export function step(state: SimState, dtMin = 1): SimState {
  if (dtMin <= 0) return state;
  const dtH = dtMin / 60;
  state.timeMin += dtMin;
  state.rngCount += 1;

  const influent = deriveInfluent(state);
  state.influent = influent;
  state.controls = clampControls(state.controls);

  const sup = toxicSuppression(state);
  state.inhibition = sup;
  state.aerationCapacity = aerationCapacity(state);
  const rec = recycle(state);

  const stormActive = state.scenario?.type === 'storm' && scenarioEnvelope(state.scenario, state.timeMin) > 0.05;
  const storeFrac = stormActive ? state.controls.stormStore : 0;
  const STORM_CAPACITY = 16000;
  const divertedRaw = influent.flow * storeFrac;
  const room = Math.max(0, STORM_CAPACITY - state.stormStorageM3);
  const diverted = Math.min(divertedRaw, room);
  const spill = divertedRaw - diverted;
  state.stormStorageM3 += (diverted - 0) * dtH;
  state.stormBypassM3 += spill * dtH;

  let returnFlow = 0;
  if (!stormActive && state.stormStorageM3 > 0) {
    returnFlow = Math.min(320, state.stormStorageM3 / dtH);
    state.stormStorageM3 = Math.max(0, state.stormStorageM3 - returnFlow * dtH);
  }

  const Q = Math.max(200, influent.flow - diverted + returnFlow);
  state.influent = { ...influent, flow: Q };
  const Qr = Q * rec.ras;
  const Qw = Q * rec.was;
  const Qir = Q * rec.ir;
  const Qe = Math.max(1, Q - Qw);
  const Qana = Q + Qr;
  const Qanx = Qana + Qir;
  const T = influent.temperature;

  const thetaH = Math.pow(KINETICS.thetaH, T - 20);
  const thetaN = Math.pow(KINETICS.thetaN, T - 20);
  const xBiomass = clamp((state.biomassKg * 1000) / BIO_VOLUME, 500, 12000);
  const bf = xBiomass / DESIGN_MLSS;

  const ras = state.tanks[state.tanks.length - 1];
  const rasCod = ras.cod;
  const rasNh = ras.nh;
  const rasNo3 = ras.no3;
  const rasTp = ras.tp;
  const rasAlk = ras.alkalinity;

  let o2DemandKgH = 0;
  let codOxidizedKgH = 0;
  let nhOxidizedKgH = 0;

  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks[i];
    const prev = i > 0 ? state.tanks[i - 1] : null;

    let qIn: number;
    let codIn: number;
    let nhIn: number;
    let no3In: number;
    let tpIn: number;
    let alkIn: number;

    if (i === 0) {
      qIn = Qana;
      codIn = mixed(influent.cod, Q, rasCod, Qr);
      nhIn = mixed(influent.nh, Q, rasNh, Qr);
      no3In = mixed(0.3, Q, rasNo3, Qr);
      tpIn = mixed(influent.tp, Q, rasTp, Qr);
      alkIn = mixed(influent.alkalinity, Q, rasAlk, Qr);
    } else if (tank.kind === 'anoxic') {
      qIn = Qanx;
      codIn = mixed(prev!.cod, Qana, rasCod, Qir);
      nhIn = mixed(prev!.nh, Qana, rasNh, Qir);
      no3In = mixed(prev!.no3, Qana, rasNo3, Qir);
      tpIn = mixed(prev!.tp, Qana, rasTp, Qir);
      alkIn = mixed(prev!.alkalinity, Qana, rasAlk, Qir);
    } else if (i === state.tanks.length - 1) {
      qIn = Qana;
      codIn = prev!.cod;
      nhIn = prev!.nh;
      no3In = prev!.no3;
      tpIn = prev!.tp;
      alkIn = prev!.alkalinity;
    } else {
      qIn = Qanx;
      codIn = prev!.cod;
      nhIn = prev!.nh;
      no3In = prev!.no3;
      tpIn = prev!.tp;
      alkIn = prev!.alkalinity;
    }

    const qOverV = qIn / tank.volume;
    const fCod = tank.cod / (KINETICS.ksCod + tank.cod);
    const fNh = tank.nh / (KINETICS.ksNh + tank.nh);
    const fO2 = tank.do / (KINETICS.ksO2 + tank.do);
    const fO2Nit = tank.do / (KINETICS.ksO2Nit + tank.do);

    let codRate = 0;
    let nhRate = 0;
    let no3Rate = 0;
    let tpRate = 0;
    let o2Rate = 0;

    if (tank.kind === 'anaerobic') {
      codRate = -KINETICS.kCodAnaerobic * fCod * bf * sup * tank.cod;
      tpRate = KINETICS.kPRel * fCod * bf * sup;
    } else if (tank.kind === 'anoxic') {
      const fNo3 = tank.no3 / (1.0 + tank.no3);
      const hetero = KINETICS.kCodAnoxic * fCod * bf * sup * tank.cod;
      const denit = KINETICS.kDen * fNo3 * fCod * bf * sup * 4.5;
      codRate = -hetero;
      no3Rate = -denit;
      tpRate = 0.1 * KINETICS.kPRel * fCod * bf;
    } else {
      const hetero = KINETICS.kCodAerobic * fCod * fO2 * thetaH * bf * sup * tank.cod;
      codRate = -hetero;
      nhRate = -KINETICS.kNit * fNh * fO2Nit * thetaN * bf * sup * (tank.alkalinity > 30 ? 1 : tank.alkalinity / 30);
      tpRate = -KINETICS.kPUp * (tank.tp / (0.25 + tank.tp)) * fO2 * bf * sup;
      o2Rate = hetero * KINETICS.o2PerCod + -nhRate * KINETICS.o2PerNh;
    }

    const no3Before = tank.no3;

    tank.cod = Math.max(2, (tank.cod + dtH * (qOverV * codIn + codRate)) / (1 + dtH * qOverV));
    tank.nh = Math.max(0.01, (tank.nh + dtH * (qOverV * nhIn + nhRate)) / (1 + dtH * qOverV));

    const nOxidized = Math.max(0, -nhRate) * dtH;
    const dn = Math.max(0, -no3Rate) * dtH;
    const no3Produced = nOxidized * 0.88;
    tank.no3 = Math.max(0.01, (tank.no3 + dtH * qOverV * no3In + no3Produced - dn) / (1 + dtH * qOverV));

    tank.tp = Math.max(0.005, (tank.tp + dtH * (qOverV * tpIn + tpRate)) / (1 + dtH * qOverV));

    const alkAdd = state.controls.alkDose;
    const alkConsumed = nOxidized * KINETICS.alkPerNh - Math.min(dn, no3Before) * KINETICS.alkPerNo3;
    tank.alkalinity = Math.max(
      10,
      (tank.alkalinity + dtH * qOverV * (alkIn + alkAdd) - alkConsumed) / (1 + dtH * qOverV),
    );
    if (tank.kind === 'aerobic') {
      const our = Math.max(0, o2Rate);
      const capacity = state.aerationCapacity;
      const dsat = KINETICS.doSat20 - 0.11 * (T - 20);
      const klaNeed = capacity > 0.02 ? our / Math.max(0.35, dsat - state.controls.doSetpoint) : 0;
      const kla = clamp(klaNeed, capacity > 0.02 ? 0.8 : 0, 165);
      const effectiveKla = Math.max(0, kla * capacity);
      const doTarget = effectiveKla > 0.02 ? dsat - our / effectiveKla : 0.02;
      const tau = clamp(1.4 / Math.max(0.2, effectiveKla), 0.02, 0.45);
      const alpha = clamp(dtH / tau, 0, 1);
      tank.do = clamp(tank.do + (clamp(doTarget, 0.02, dsat) - tank.do) * alpha, 0.02, dsat);
      tank.o2Demand = our;
      tank.klaUsed = effectiveKla;
      o2DemandKgH += (our * tank.volume) / 1000;
    } else {
      tank.do = Math.max(0.02, tank.do * Math.exp(-3.0 * dtH));
      tank.o2Demand = 0;
    }

    tank.codRemoved = Math.max(0, -codRate) * dtH;
    tank.nhRemoved = Math.max(0, -nhRate) * dtH;
    tank.mlss = Math.round(xBiomass);
    tank.temperature = T;
    codOxidizedKgH += (Math.max(0, -codRate) * tank.volume) / 1000;
    nhOxidizedKgH += (Math.max(0, -nhRate) * tank.volume) / 1000;
  }

  const final = state.tanks[state.tanks.length - 1];
  const clar = state.clarifier;
  const underflow = Qr + Qw;
  const clarifierArea = clar.area > 0 ? clar.area : PLANT.clarifier.area;
  const clarifierDepth = clar.depth > 0 ? clar.depth : PLANT.clarifier.depth;
  // 进二沉池的固体通量只取决于"进水 + 回流带来的混合液"，与回流泵是否在转无关。
  // 回流中断时混合液照样涌入，所以这里必须用设计回流比估算入流，而不是用当前 Qr。
  const clarifierInflow = Q * (1 + Math.max(rec.ras, 0.3));
  const slr = (clarifierInflow * xBiomass) / 1000 / clarifierArea;
  clar.slr = slr;
  clar.underflowM3h = underflow;
  const rasDeficit = clamp(1 - rec.ras / Math.max(0.05, state.controls.rasRatio), 0, 1);

  // ── 二沉池：按固体通量（SLR）与底流浓缩能力建模 ──────────────────
  // 回流污泥浓度：底流在有限停留时间内的浓缩结果，上限受固体通量与回流比约束。
  const rasTarget = clamp(
    3600 + 4200 * clamp(slr / 4.0, 0.25, 2.2) + 2400 * clamp(rec.ras / 0.8, 0.1, 1.6),
    2400,
    13000,
  );
  clar.xRas += (rasTarget - clar.xRas) * Math.min(1, dtH * 1.6);

  // 固体收支：用于判断池内库存趋势（界面展示与跑泥判断）
  const solidsIn = ((Q + Qr) * xBiomass) / 1000;
  const solidsRas = (Qr * clar.xRas) / 1000;
  const solidsWaste = (Qw * clar.xRas) / 1000;
  const solidsEff = (Qe * clar.xEff) / 1000;
  const netSolids = solidsIn - solidsRas - solidsWaste - solidsEff;
  const inventoryCap = clarifierArea * clarifierDepth * 0.36 * 12;
  clar.sludgeMassKg = clamp(clar.sludgeMassKg + netSolids * dtH, 2000, inventoryCap);

  // 泥层高度由固体负荷决定：SLR 越高、回流越弱，泥层越厚。
  // 面积翻倍 → SLR 减半 → 泥层变薄（扩容的正确物理效果）。
  const slrFactor = clamp(slr / 3.6, 0.15, 3.0);
  // 回流中断 = 底流带不走固体，泥层必然抬升；这一项必须独立于 SLR
  const blanketTarget = clamp(
    0.175 * clarifierDepth * Math.pow(slrFactor, 1.15) * (1 + 1.9 * rasDeficit),
    0.3,
    clarifierDepth + 0.9,
  );
  clar.blanketM += (blanketTarget - clar.blanketM) * Math.min(1, dtH * 0.55);

  const overflow = Math.max(0, clar.blanketM - (clarifierDepth - 1.1));
  const xEffTarget = clamp(
    1.6 + overflow * 34 + Math.max(0, slr - 5.5) * 2.6 + Math.max(0, 0.35 - rec.ras) * 30,
    1.2,
    80,
  );
  clar.xEff += (xEffTarget - clar.xEff) * Math.min(1, dtH * 0.85);

  const growth = KINETICS.yieldH * codOxidizedKgH + 0.11 * nhOxidizedKgH;
  const decay = (KINETICS.decayPerDay / 24) * state.biomassKg;
  const anoxiaStress = state.tanks.filter((t) => t.kind === 'aerobic' && t.do < 0.8).length;
  const stressDecay = anoxiaStress > 0 ? anoxiaStress * 0.004 * state.biomassKg : 0;
  const biomassOut = ((Qw * clar.xRas + Qe * clar.xEff) / 1000) * dtH;
  state.biomassKg = clamp(state.biomassKg + (growth - decay - stressDecay) * dtH - biomassOut, 8000, 300000);

  const pacActive = !(
    state.scenario?.type === 'chemical_shortage' && scenarioEnvelope(state.scenario, state.timeMin) > 0.3
  );
  const pacDose = pacActive ? state.controls.pacDose : 0;
  const netO2KgH = o2DemandKgH;

  const xSusp = clar.xEff;
  const effCod = final.cod + xSusp * 1.3;
  const effBod = Math.max(1.2, (final.cod - 12) * 0.32 + xSusp * 0.5);
  const effNh = final.nh + xSusp * 0.014;
  const effTn = final.nh + final.no3 + xSusp * 0.025;
  const pacRemoval = pacDose * KINETICS.pacPPerMg;
  const effTp = Math.max(0.01, final.tp + xSusp * 0.014 - pacRemoval);
  const effPh = clamp(6.6 + 0.004 * (final.alkalinity - 40), 5.8, 8.7);

  state.effluent = {
    flow: Qe,
    cod: clamp(effCod, 4, 900),
    bod: clamp(effBod, 1, 400),
    ss: clamp(xSusp, 0.5, 150),
    nh: clamp(effNh, 0.02, 100),
    tn: clamp(effTn, 0.3, 120),
    tp: clamp(effTp, 0.01, 20),
    ph: effPh,
    temperature: T,
  };

  const anoxicVol = state.tanks.filter((t) => t.kind !== 'aerobic').reduce((s, t) => s + t.volume, 0);
  const blowerKw = clamp(netO2KgH / KINETICS.saeKgO2PerKwh / 0.7, 5, 900) * (state.aerationCapacity > 0.02 ? 1 : 0);
  const mixerKw = (anoxicVol * 3.4) / 1000;
  const pumpKw = (Q + Qr + Qir) * 0.008;
  const totalKw = blowerKw + mixerKw + pumpKw;
  state.energy = { blowerKw, mixerKw, pumpKw, totalKw, specificKwhM3: totalKw / Math.max(1, Q) };
  state.energyTotalKwh += totalKw * dtH;

  const pacKg = (Q * pacDose * dtH) / 1000;
  const carbonKg = (Q * state.controls.carbonDose * dtH) / 1000;
  const alkKg = (Q * state.controls.alkDose * dtH) / 1000;
  state.chemicalsUsed.pacKg += pacKg;
  state.chemicalsUsed.carbonKg += carbonKg;
  state.chemicalsUsed.alkKg += alkKg;
  const wasteKg = (Qw * clar.xRas * dtH) / 1000;
  state.wasteSludgeKg += wasteKg;

  const wasKgPerDay = (Qw * 24 * clar.xRas) / 1000;
  state.srtDays = wasKgPerDay > 5 ? clamp(state.biomassKg / wasKgPerDay, 2, 40) : 40;
  state.fmRatio = (Q * 24 * influent.bod) / 1000 / Math.max(1, state.biomassKg);

  const day = Math.floor(state.timeMin / 1440);
  if (day > state.lastDay) {
    state.lastDay = day;
    state.cost.energyToday = 0;
    state.cost.chemicalToday = 0;
    state.cost.sludgeToday = 0;
    state.cost.totalToday = 0;
    state.wasteSludgeKg = 0;
  }
  const energyCost = totalKw * dtH * TARIFF.electricity;
  const chemCost = pacKg * TARIFF.pac + carbonKg * TARIFF.carbon + alkKg * TARIFF.alk;
  const sludgeCost = wasteKg * TARIFF.sludge;
  state.cost.energyToday += energyCost;
  state.cost.chemicalToday += chemCost;
  state.cost.sludgeToday += sludgeCost;
  state.cost.totalToday = state.cost.energyToday + state.cost.chemicalToday + state.cost.sludgeToday;
  state.cost.total += energyCost + chemCost + sludgeCost;
  state.totalInflowM3 += Q * dtH;
  state.totalOutflowM3 += Qe * dtH;

  const e = state.effluent;
  if (e.nh > LIMITS.nh)
    pushAlarm(state, 'critical', 'EFF_NH', `出水氨氮 ${e.nh.toFixed(2)} mg/L 超一级A（${LIMITS.nh}）`, 'nh', e.nh);
  if (e.tp > LIMITS.tp)
    pushAlarm(state, 'warning', 'EFF_TP', `出水总磷 ${e.tp.toFixed(2)} mg/L 超一级A（${LIMITS.tp}）`, 'tp', e.tp);
  if (e.cod > LIMITS.cod)
    pushAlarm(state, 'critical', 'EFF_COD', `出水 COD ${e.cod.toFixed(1)} mg/L 超一级A（${LIMITS.cod}）`, 'cod', e.cod);
  if (e.ss > LIMITS.ss)
    pushAlarm(state, 'warning', 'EFF_SS', `出水悬浮物 ${e.ss.toFixed(1)} mg/L 超一级A（${LIMITS.ss}）`, 'ss', e.ss);
  if (final.do < 1.0)
    pushAlarm(state, 'warning', 'DO_LOW', `好氧区溶解氧 ${final.do.toFixed(2)} mg/L，低于工艺下限`, 'do', final.do);
  if (clar.blanketM > clarifierDepth - 0.4) {
    pushAlarm(
      state,
      'critical',
      'SLUDGE_BLANKET',
      `二沉池污泥界面 ${clar.blanketM.toFixed(2)} m，存在跑泥风险`,
      'blanket',
      clar.blanketM,
    );
  }
  if (state.srtDays < 8)
    pushAlarm(
      state,
      'warning',
      'SRT_LOW',
      `污泥龄 ${state.srtDays.toFixed(1)} d，硝化菌群可能流失`,
      'srt',
      state.srtDays,
    );

  return state;
}

export function spinUp(state: SimState, days: number): SimState {
  const steps = Math.max(0, Math.floor((days * 1440) / 2));
  for (let i = 0; i < steps; i++) step(state, 2);
  state.alarms = [];
  state.alarmSeq = 0;
  state.cost = { energyToday: 0, chemicalToday: 0, sludgeToday: 0, totalToday: 0, total: 0 };
  state.totalInflowM3 = 0;
  state.totalOutflowM3 = 0;
  state.energyTotalKwh = 0;
  state.accountingStartMin = state.timeMin;
  state.lastDay = Math.floor(state.timeMin / 1440);
  state.chemicalsUsed = { pacKg: 0, carbonKg: 0, alkKg: 0 };
  state.wasteSludgeKg = 0;
  state.stormStorageM3 = 0;
  state.stormBypassM3 = 0;
  return state;
}

export function startScenario(
  state: SimState,
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

export function clearScenario(state: SimState): void {
  state.scenario = null;
}

export interface ForecastPoint {
  minute: number;
  effluent: EffluentState;
  doLevel: number;
  blanket: number;
  mlss: number;
  energyKw: number;
  score: number;
}

export function forecast(
  state: SimState,
  controls: ControlSettings,
  horizonMin: number,
  sampleEveryMin = 15,
): {
  points: ForecastPoint[];
  violations: { metric: string; minute: number; value: number; limit: number }[];
  costDelta: number;
  peakEnergyKw: number;
  end: SimState;
} {
  const sim = cloneState(state);
  sim.controls = clampControls({ ...controls, aiEnabled: true });
  const points: ForecastPoint[] = [];
  const violations: { metric: string; minute: number; value: number; limit: number }[] = [];
  const startCost = sim.cost.total;
  let peakEnergy = 0;
  for (let m = 0; m < horizonMin; m++) {
    step(sim, 1);
    peakEnergy = Math.max(peakEnergy, sim.energy.totalKw);
    if ((m + 1) % sampleEveryMin === 0) {
      const e = sim.effluent;
      points.push({
        minute: m + 1,
        effluent: { ...e },
        doLevel: sim.tanks[sim.tanks.length - 1].do,
        blanket: sim.clarifier.blanketM,
        mlss: sim.tanks[0].mlss,
        energyKw: sim.energy.totalKw,
        score: qualityScore(e),
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
    costDelta: sim.cost.total - startCost,
    peakEnergyKw: peakEnergy,
    end: sim,
  };
}

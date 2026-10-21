import {
  CONTROL_BOUNDS,
  ControlSettings,
  DEFAULT_CONTROLS,
  INFLUENT_DESIGN,
  LIMITS,
} from '../sim/config';
import {
  Connection,
  ProcessTopology,
  UnitSpec,
  PLANT_TOPOLOGY,
  deriveTrain,
  hydraulicRetention,
  totalTrainVolume,
} from '../model/topology';
import { SCENARIOS, ScenarioSpec } from '../sim/scenarios';

/**
 * 由拓扑驱动的仿真引擎（v2，进行中）。
 *
 * 与 v1 的关键差别：池不是写死的 5 个，而是从 topo.train 生成；
 * 每个单元的容积、进出流股来自拓扑；控制变量的作用点由单元声明。
 * 这样"在界面上改图"与"引擎实际行为"才可能一致。
 */

export interface StreamState {
  flow: number;
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  ss: number;
  do: number;
  alkalinity: number;
  temperature: number;
  mlss: number;
}

export interface UnitState {
  id: string;
  kind: UnitSpec['kind'];
  name: string;
  volume: number;
  /** 单元内液相状态；无液相单元（风机/加药）为 null */
  liquor: StreamState | null;
  /** 单元专属状态：二沉池泥位、调蓄池存量等 */
  extras: Record<string, number>;
}

export interface LinkState {
  id: string;
  stream: Connection['stream'];
  flow: number;
  from: string;
  to: string;
}

export interface TopoSimState {
  timeMin: number;
  seed: number;
  rngCount: number;
  topologyId: string;
  units: UnitState[];
  links: LinkState[];
  influent: StreamState;
  effluent: StreamState;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  biomassKg: number;
  srtDays: number;
  inhibition: number;
  aerationCapacity: number;
  energy: { blowerKw: number; mixerKw: number; pumpKw: number; totalKw: number };
  alarms: { id: string; at: number; severity: 'warning' | 'critical'; code: string; message: string; unitId?: string }[];
  alarmSeq: number;
  cost: { energy: number; chemical: number; sludge: number; total: number };
  stormStorageM3: number;
  accountingStartMin: number;
}

const K = {
  kCodAerobic: 1.4,
  kCodAnoxic: 0.9,
  kCodAnaerobic: 0.6,
  kNit: 14.0,
  kDen: 4.6,
  kPRel: 5.0,
  kPUp: 3.0,
  ksCod: 22,
  ksNh: 1.0,
  ksO2: 0.5,
  ksO2Nit: 0.9,
  yieldH: 0.48,
  decayPerDay: 0.025,
  thetaH: 1.045,
  thetaN: 1.08,
  o2PerCod: 0.9,
  o2PerNh: 4.57,
  alkPerNh: 7.14,
  alkPerNo3: 3.57,
  pacPPerMg: 0.06,
  saeKgO2PerKwh: 3.4,
  doSat20: 9.1,
  biomassSeed: 3400,
};

function extrasOf(u: UnitSpec): Record<string, number> {
  if (u.kind === 'clarifier') return { blanketM: 1.0, xRas: 8600, xEff: 4, slr: 3.4, sludgeMassKg: 22000, underflowM3h: 1600 };
  if (u.kind === 'storage') return { storedM3: 0 };
  return {};
}

function blankStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    flow: 0,
    cod: 0,
    nh: 0,
    no3: 0,
    tp: 0,
    ss: 0,
    do: 0,
    alkalinity: 0,
    temperature: 20,
    mlss: 0,
    ...overrides,
  };
}

export function createTopoSimState(topo: ProcessTopology = PLANT_TOPOLOGY, options: { seed?: number; controls?: Partial<ControlSettings> } = {}): TopoSimState {
  const controls: ControlSettings = { ...DEFAULT_CONTROLS, ...options.controls };
  const volume = totalTrainVolume(topo);

  const units: UnitState[] = topo.units.map((u) => ({
    id: u.id,
    kind: u.kind,
    name: u.name,
    volume: u.volume ?? 0,
    liquor:
      u.kind === 'anaerobic' || u.kind === 'anoxic' || u.kind === 'aerobic' || u.kind === 'clarifier' || u.kind === 'disinfection'
        ? blankStream({
            cod: u.kind === 'anaerobic' ? 90 : u.kind === 'aerobic' ? 30 : 40,
            nh: u.kind === 'aerobic' ? 4 : 22,
            no3: u.kind === 'anaerobic' ? 0.2 : 6,
            tp: u.kind === 'anaerobic' ? 6 : 1,
            do: u.kind === 'aerobic' ? 2 : 0.08,
            alkalinity: 220,
            mlss: K.biomassSeed,
            temperature: 20,
          })
        : null,
    extras: extrasOf(u),
  }));

  const links: LinkState[] = topo.connections.map((c) => ({
    id: c.id,
    stream: c.stream,
    flow: 0,
    from: c.from.unit,
    to: c.to.unit,
  }));

  return {
    timeMin: 0,
    seed: options.seed ?? 20261019,
    rngCount: 0,
    topologyId: topo.id,
    units,
    links,
    influent: blankStream({ ...INFLUENT_DESIGN, flow: INFLUENT_DESIGN.flow }),
    effluent: blankStream({ flow: INFLUENT_DESIGN.flow, cod: 30, bod: 7, ss: 5, nh: 1.6, tn: 11, tp: 0.35, ph: 7.2, temperature: 20 } as Partial<StreamState>),
    controls,
    scenario: null,
    biomassKg: (K.biomassSeed * volume) / 1000,
    srtDays: 18,
    inhibition: 1,
    aerationCapacity: 1,
    energy: { blowerKw: 380, mixerKw: 26, pumpKw: 62, totalKw: 468 },
    alarms: [],
    alarmSeq: 0,
    cost: { energy: 0, chemical: 0, sludge: 0, total: 0 },
    stormStorageM3: 0,
    accountingStartMin: 0,
  };
}



/** 校验拓扑是否可跑：引擎启动前必须通过，避免"图能画但跑不了" */
export interface RunReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  derived: { trainUnits: number; bioVolume: number; hrtHours: number; aerobicVolume: number };
}

export function checkRunReadiness(topo: ProcessTopology, flowM3h = INFLUENT_DESIGN.flow): RunReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const train = deriveTrain(topo);

  if (train.length === 0) blockers.push('主处理序列为空：没有任何单元参与生物反应');

  const hasClarifier = topo.units.some((u) => u.kind === 'clarifier');
  if (!hasClarifier) blockers.push('缺少二沉池：无法完成泥水分离，出水悬浮物将失去物理依据');

  const hasInlet = topo.units.some((u) => u.kind === 'inlet');
  const hasOutlet = topo.units.some((u) => u.kind === 'outlet');
  if (!hasInlet) blockers.push('缺少进水单元');
  if (!hasOutlet) blockers.push('缺少排放单元');

  const aerobic = train.filter((t) => t.spec.kind === 'aerobic');
  if (aerobic.length === 0) blockers.push('主序列中没有好氧池：无法完成硝化');

  const bioVolume = totalTrainVolume(topo);
  const hrt = bioVolume / Math.max(1, flowM3h);
  if (hrt < 4) warnings.push(`生物池停留时间仅 ${hrt.toFixed(1)} h（低于常见下限 6 h），硝化可能不完全`);
  if (hrt > 24) warnings.push(`生物池停留时间 ${hrt.toFixed(1)} h 偏长，池容投资可能过剩`);

  const aerobicVolume = aerobic.reduce((s, t) => s + (t.spec.volume ?? 0), 0);
  if (aerobic.length > 0 && aerobicVolume === 0) blockers.push('好氧池未设置容积：无法计算氧传递');

  // 新增但未接线的工艺单元必须阻断：图上画了却不在物流里，是最危险的假象
  const trainIds = new Set(train.map((t) => t.spec.id));
  for (const t of train) {
    const hasIn = topo.connections.some((c) => c.to.unit === t.spec.id);
    const hasOut = topo.connections.some((c) => c.from.unit === t.spec.id);
    if (!hasIn) blockers.push(`${t.spec.name} 没有入口物流：已加入主序列但未接入水路，无法参与反应`);
    if (!hasOut) blockers.push(`${t.spec.name} 没有出口物流：反应后的水无处可去`);
  }
  void trainIds;

  const hasRas = topo.connections.some((c) => c.stream === 'return_activated_sludge');
  if (!hasRas) warnings.push('没有污泥回流：生物量会随出水流失，系统无法维持');

  const hasIr = topo.connections.some((c) => c.stream === 'internal_recycle');
  if (!hasIr) warnings.push('没有内回流：总氮去除能力将显著受限');

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    derived: { trainUnits: train.length, bioVolume, hrtHours: hrt, aerobicVolume },
  };
}

/** 拓扑里所有可干预控制项（面板据此生成控件，而不是硬编码） */
export function availableInterventions(topo: ProcessTopology): { key: string; unitId: string; unitName: string }[] {
  const out: { key: string; unitId: string; unitName: string }[] = [];
  for (const unit of topo.units) {
    for (const key of unit.interventions ?? []) {
      if (out.some((o) => o.key === key)) continue;
      out.push({ key, unitId: unit.id, unitName: unit.name });
    }
  }
  return out;
}

export function retentionBreakdown(topo: ProcessTopology, flowM3h = INFLUENT_DESIGN.flow) {
  return hydraulicRetention(topo, flowM3h);
}

export function limitsOf() {
  return LIMITS;
}

export function controlBoundsOf() {
  return CONTROL_BOUNDS;
}

export { SCENARIOS };
export type { Connection };

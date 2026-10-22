import { CONTROL_BOUNDS, ControlSettings, INFLUENT_DESIGN, LIMITS } from '../sim/config';
import {
  Connection,
  ProcessTopology,
  UnitSpec,
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
  alarms: {
    id: string;
    at: number;
    severity: 'warning' | 'critical';
    code: string;
    message: string;
    unitId?: string;
  }[];
  alarmSeq: number;
  cost: { energy: number; chemical: number; sludge: number; total: number };
  stormStorageM3: number;
  accountingStartMin: number;
}

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

  /**
   * 好氧池必须有鼓风机供气。
   *
   * 之前不检查这一项：删掉鼓风机后校验仍然通过，而引擎的曝气能力
   * 与鼓风机单元完全无关（它只看 aerationCapacity），
   * 于是"图上没有风机但满负荷曝气"——属于校验与求解脱节。
   */
  if (aerobic.length > 0) {
    const hasBlower = topo.units.some((u) => u.kind === 'blower');
    if (!hasBlower) blockers.push('好氧池存在但没有鼓风机：无法供氧');
    const blowerConnected = topo.connections.some((c) => {
      const from = topo.units.find((u) => u.id === c.from.unit);
      const to = topo.units.find((u) => u.id === c.to.unit);
      return from?.kind === 'blower' && to?.kind === 'aerobic';
    });
    if (hasBlower && !blowerConnected) blockers.push('鼓风机没有连接到任何好氧池');
  }

  /**
   * 只允许一个二沉池。
   *
   * 引擎的 compileNetwork 与 networkEngine 都只取第一个 clarifier，
   * 第二个会被静默忽略——这比报错更危险，用户以为它生效了。
   */
  const clarifiers = topo.units.filter((u) => u.kind === 'clarifier');
  if (clarifiers.length > 1) {
    blockers.push(
      `当前只支持一个二沉池（检测到 ${clarifiers.length} 个）：${clarifiers.map((c) => c.name).join('、')}`,
    );
  }

  const bioVolume = totalTrainVolume(topo);
  const hrt = bioVolume / Math.max(1, flowM3h);
  if (hrt < 4) warnings.push(`生物池停留时间仅 ${hrt.toFixed(1)} h（低于常见下限 6 h），硝化可能不完全`);
  if (hrt > 24) warnings.push(`生物池停留时间 ${hrt.toFixed(1)} h 偏长，池容投资可能过剩`);

  const aerobicVolume = aerobic.reduce((s, t) => s + (t.spec.volume ?? 0), 0);
  // 逐个检查：任一好氧池容积为 0 都应阻断，而不是只看总和
  for (const t of aerobic) {
    if (!t.spec.volume || t.spec.volume <= 0) {
      blockers.push(`${t.spec.name} 未设置容积：无法计算氧传递`);
    }
  }

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

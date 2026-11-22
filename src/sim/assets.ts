/**
 * WP7 资产与运维：设备注册表、状态机、故障码、健康度、N+1 备机、ESD、可用性因子。
 *
 * 设计边界（与引擎的关系）：
 * - 本模块只交付领域模型与纯函数接线点；不反向依赖 networkEngine / networkTypes。
 *   后续 WP4 集成方在引擎步内调用 `tickAssets`，并用 `capacityFactorFor`
 *   把泵/风机能力乘到求解上。
 * - 所有状态为纯 JSON 可序列化对象（数组/对象/数值/字符串/布尔/null），
 *   不存放函数、Map、闭包，可进快照与审计。
 * - 默认数量、功率、故障率、维护周期均为工程假设；现场台账标定口径见
 *   docs/ASSET-MANAGEMENT.md。
 */

import type { ProcessTopology, UnitKind, UnitSpec } from '../model/topology';
import { mulberry32 } from './rng';
import { maintenanceDefaults, tickMaintenance, type MaintenanceEvent, type WorkOrder } from './maintenance';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 设备类别。类别决定维护计划默认值与故障概率口径。 */
export type AssetCategory = 'pump' | 'blower' | 'mixer' | 'scraper' | 'thickener' | 'dewatering' | 'dosing_pump';

/**
 * 设备状态机。
 * - `running`：主机运行；
 * - `standby`：备机待命（N+1 冗余组中的备用位）；
 * - `fault`：故障停机，锁存，需显式 reset；
 * - `maintenance`：检修中，不可用；
 * - `esd_tripped`：ESD 安全位，锁存，需显式复位。
 */
export type AssetStatus = 'running' | 'standby' | 'fault' | 'maintenance' | 'esd_tripped';

/** 故障严重度：降容运行 / 停机 / 锁存停机。 */
export type FaultSeverity = 'derate' | 'stop' | 'latch';

export interface FaultCodeDef {
  code: string;
  label: string;
  severity: FaultSeverity;
  /** 每运行小时基础出现概率（工程假设，待现场台账标定） */
  probabilityPerHour: number;
  /** 触发后健康度惩罚（0–100） */
  healthPenalty: number;
  /** 降容故障下的能力折算系数；停机/锁存为 0 */
  derateFactor: number;
}

export interface AssetEvent {
  atMin: number;
  from: AssetStatus;
  to: AssetStatus;
  code: string;
  detail?: string;
}

export interface AssetRecord {
  id: string;
  category: AssetCategory;
  unitId: string;
  unitName: string;
  name: string;
  /** 冗余组标识（同单元同类设备同组），备机切换与可用性按组计算 */
  groupId: string;
  isStandby: boolean;
  repairable: boolean;
  /** 额定输送能力（m³/h；风机为风量 m³(air)/h）；无输送能力时为 0，取功率口径 */
  ratedFlowM3h: number;
  ratedPowerKw: number;
  status: AssetStatus;
  faultCode: string | null;
  faultSeverity: FaultSeverity | null;
  /** 故障锁存：复位前不得自恢复 */
  faultLatched: boolean;
  /** ESD 锁存：复位前不得自恢复 */
  esdLatched: boolean;
  /** 累计运行时数（min） */
  runtimeMin: number;
  startCount: number;
  /** 健康度 / 状态指数 0–100，维护后恢复 100 */
  health: number;
  /** 当前能力折算系数（故障降容、健康度共同决定），0–1 */
  derateFactor: number;
  /** 备机自启延时到期时刻（min）；null 表示无待启动备机 */
  standbyAvailableAtMin: number | null;
  activeWorkOrderId: string | null;
  lastMaintenanceMin: number;
  events: AssetEvent[];
}

export interface EsdState {
  active: boolean;
  scope: 'plant' | 'unit';
  unitId: string | null;
  triggeredAtMin: number | null;
  resetAtMin: number | null;
}

export interface AssetPlantState {
  topologyId: string;
  timeMin: number;
  seed: number;
  assets: AssetRecord[];
  workOrders: WorkOrder[];
  esd: EsdState;
  seq: number;
  defaults: { standbyStartDelayMin: number; enableProbabilisticFaults: boolean };
}

/** 注入/控制事件。写操作不开放 HTTP 端点；事件由仿真步或测试显式传入。 */
export type AssetInEvent =
  | { type: 'injectFault'; assetId: string; code: string }
  | { type: 'esdTrigger'; unitId?: string }
  | { type: 'esdReset' }
  | { type: 'faultReset'; assetId: string }
  | MaintenanceEvent;

// ---------------------------------------------------------------------------
// 故障码表
// ---------------------------------------------------------------------------

export const FAULT_CODES: Record<string, FaultCodeDef> = {
  BEARING_OVERHEAT: {
    code: 'BEARING_OVERHEAT',
    label: '轴承过热',
    severity: 'derate',
    probabilityPerHour: 0.0002,
    healthPenalty: 8,
    derateFactor: 0.6,
  },
  SEAL_LEAK: {
    code: 'SEAL_LEAK',
    label: '密封泄漏',
    severity: 'stop',
    probabilityPerHour: 0.00008,
    healthPenalty: 15,
    derateFactor: 0,
  },
  MOTOR_OVERLOAD: {
    code: 'MOTOR_OVERLOAD',
    label: '电机过载',
    severity: 'stop',
    probabilityPerHour: 0.0001,
    healthPenalty: 12,
    derateFactor: 0,
  },
  VIBRATION_HIGH: {
    code: 'VIBRATION_HIGH',
    label: '振动高',
    severity: 'latch',
    probabilityPerHour: 0.00006,
    healthPenalty: 20,
    derateFactor: 0,
  },
  CONTROL_FAULT: {
    code: 'CONTROL_FAULT',
    label: '控制回路故障',
    severity: 'latch',
    probabilityPerHour: 0.00005,
    healthPenalty: 10,
    derateFactor: 0,
  },
};

/** 状态机显式转换白名单；ESD 位只能由 resetEsd 退出。 */
const TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  running: ['fault', 'maintenance', 'esd_tripped', 'standby'],
  standby: ['running', 'maintenance', 'esd_tripped'],
  fault: ['maintenance', 'running', 'esd_tripped'],
  maintenance: ['running', 'esd_tripped'],
  esd_tripped: [],
};

// ---------------------------------------------------------------------------
// 拓扑派生
// ---------------------------------------------------------------------------

interface CategorySpec {
  category: AssetCategory;
  label: string;
  defaultCount: number;
  dutyCount: number;
  ratedFlowM3h: number;
  ratedPowerKw: number;
  repairable: boolean;
}

/**
 * 单元类别 → 设备类别映射。
 *
 * 拓扑里泵/风机/搅拌器等目前只是图标；这里按单元种类派生单台设备。
 * 数量优先解析单元 meta（`×N`、`N 用 M 备`），解析不到走类别默认值。
 */
const KIND_SPECS: Partial<Record<UnitKind, CategorySpec[]>> = {
  screening: [
    {
      category: 'pump',
      label: '提升泵',
      defaultCount: 4,
      dutyCount: 3,
      ratedFlowM3h: 500,
      ratedPowerKw: 22,
      repairable: true,
    },
  ],
  anaerobic: [
    {
      category: 'mixer',
      label: '潜水搅拌器',
      defaultCount: 4,
      dutyCount: 4,
      ratedFlowM3h: 0,
      ratedPowerKw: 4,
      repairable: true,
    },
  ],
  anoxic: [
    {
      category: 'mixer',
      label: '潜水搅拌器',
      defaultCount: 2,
      dutyCount: 2,
      ratedFlowM3h: 0,
      ratedPowerKw: 5.5,
      repairable: true,
    },
  ],
  blower: [
    {
      category: 'blower',
      label: '离心风机',
      defaultCount: 3,
      dutyCount: 2,
      ratedFlowM3h: 6000,
      ratedPowerKw: 110,
      repairable: true,
    },
  ],
  chemical: [
    {
      category: 'dosing_pump',
      label: '加药泵',
      defaultCount: 3,
      dutyCount: 3,
      ratedFlowM3h: 2,
      ratedPowerKw: 1.5,
      repairable: true,
    },
  ],
  clarifier: [
    {
      category: 'scraper',
      label: '刮泥机',
      defaultCount: 2,
      dutyCount: 2,
      ratedFlowM3h: 0,
      ratedPowerKw: 1.1,
      repairable: true,
    },
  ],
  thickener: [
    {
      category: 'thickener',
      label: '浓缩机',
      defaultCount: 1,
      dutyCount: 1,
      ratedFlowM3h: 0,
      ratedPowerKw: 3,
      repairable: true,
    },
  ],
  dewatering: [
    {
      category: 'dewatering',
      label: '离心脱水机',
      defaultCount: 2,
      dutyCount: 2,
      ratedFlowM3h: 30,
      ratedPowerKw: 37,
      repairable: true,
    },
  ],
};

function metaText(unit: UnitSpec): string {
  return Object.entries(unit.meta ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(' ');
}

/** 解析 meta 中的 `×N` 台数；解析不到返回 fallback。 */
function parseCount(unit: UnitSpec, fallback: number): number {
  const m = metaText(unit).match(/×\s*(\d+)/);
  const n = m ? Number.parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 解析 meta 中的 `N 用 M 备`；返回 [主机数, 备机数]，解析不到返回 fallback。 */
function parseDutyStandby(unit: UnitSpec, fallbackDuty: number, count: number): [number, number] {
  const m = metaText(unit).match(/(\d+)\s*用\s*(\d+)\s*备/);
  if (!m) return [fallbackDuty, Math.max(0, count - fallbackDuty)];
  const duty = Number.parseInt(m[1], 10);
  const standby = Number.parseInt(m[2], 10);
  if (duty + standby !== count) {
    // meta 口径与台数不一致时以台数为准，主机占前 count-standby 台
    return [Math.max(1, count - standby), standby];
  }
  return [duty, standby];
}

/** 从拓扑派生设备注册表（初始记录，未挂故障/工单）。 */
export function assetRegistryFromTopology(topo: ProcessTopology): AssetRecord[] {
  const assets: AssetRecord[] = [];

  for (const unit of topo.units) {
    const specs = KIND_SPECS[unit.kind];
    if (!specs) continue;
    for (const spec of specs) {
      const count = parseCount(unit, spec.defaultCount);
      const [dutyCount] = parseDutyStandby(unit, spec.dutyCount, count);
      for (let i = 1; i <= count; i += 1) {
        const isStandby = i > dutyCount;
        assets.push({
          id: `${spec.category}-${unit.id}-${i}`,
          category: spec.category,
          unitId: unit.id,
          unitName: unit.name,
          name: `${spec.label} ${i}`,
          groupId: `${unit.id}:${spec.category}`,
          isStandby,
          repairable: spec.repairable,
          ratedFlowM3h: spec.ratedFlowM3h,
          ratedPowerKw: spec.ratedPowerKw,
          status: isStandby ? 'standby' : 'running',
          faultCode: null,
          faultSeverity: null,
          faultLatched: false,
          esdLatched: false,
          runtimeMin: 0,
          startCount: isStandby ? 0 : 1,
          health: 100,
          derateFactor: 1,
          standbyAvailableAtMin: null,
          activeWorkOrderId: null,
          lastMaintenanceMin: 0,
          events: [],
        });
      }
    }
  }
  return assets;
}

/** 创建资产子系统状态。旧快照缺该字段时由集成方按 null 处理，这里不抛错。 */
export function createAssetStateFromTopology(
  topo: ProcessTopology,
  opts: { seed?: number; timeMin?: number; standbyStartDelayMin?: number } = {},
): AssetPlantState {
  return {
    topologyId: topo.id,
    timeMin: opts.timeMin ?? 0,
    seed: opts.seed ?? 20261123,
    assets: assetRegistryFromTopology(topo),
    workOrders: [],
    esd: { active: false, scope: 'plant', unitId: null, triggeredAtMin: null, resetAtMin: null },
    seq: 0,
    defaults: { standbyStartDelayMin: opts.standbyStartDelayMin ?? 5, enableProbabilisticFaults: true },
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function pushEvent(asset: AssetRecord, atMin: number, to: AssetStatus, code: string, detail: string): void {
  asset.events.push({ atMin, from: asset.status, to, code, detail });
}

function assetById(state: AssetPlantState, assetId: string): AssetRecord | undefined {
  return state.assets.find((a) => a.id === assetId);
}

/** 设备额定能力：有输送能力取流量口径，否则取功率口径（搅拌/刮泥类）。 */
function ratedCapacity(asset: AssetRecord): number {
  return asset.ratedFlowM3h > 0 ? asset.ratedFlowM3h : asset.ratedPowerKw;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// 故障注入与复位
// ---------------------------------------------------------------------------

/** 注入故障。返回是否成功；未知设备/未知故障码/ESD 位上拒绝注入。 */
export function injectFault(state: AssetPlantState, assetId: string, code: string): boolean {
  const asset = assetById(state, assetId);
  const def = FAULT_CODES[code];
  if (!asset || !def) return false;
  if (asset.status === 'esd_tripped') return false;
  if (asset.status !== 'running' && asset.status !== 'standby') return false;

  const from = asset.status;
  if (!canTransition(from, 'fault')) return false;

  const derate = def.severity === 'derate';
  const to: AssetStatus = derate ? from : 'fault';
  if (!derate && !canTransition(from, 'fault')) return false;

  if (!derate) asset.status = 'fault';
  asset.faultCode = def.code;
  asset.faultSeverity = def.severity;
  asset.faultLatched = true;
  asset.health = Math.max(0, asset.health - def.healthPenalty);
  asset.derateFactor = def.derateFactor;
  asset.standbyAvailableAtMin = null;
  pushEvent(asset, state.timeMin, to, def.code, `${def.label}（${def.severity}）`);

  if (!derate) {
    scheduleBackup(state, asset);
  }
  return true;
}

/** 故障锁存复位：清除故障码与锁存，设备回到角色位。复位是显式动作，不会自动发生。 */
export function resetAssetFault(state: AssetPlantState, assetId: string): boolean {
  const asset = assetById(state, assetId);
  if (!asset) return false;
  if (!asset.faultLatched) return false;

  asset.faultCode = null;
  asset.faultSeverity = null;
  asset.faultLatched = false;
  asset.derateFactor = 1;
  const to = asset.isStandby ? 'standby' : 'running';
  pushEvent(asset, state.timeMin, to, 'FAULT_RESET', '故障复位，设备恢复角色位');
  asset.status = to;
  asset.startCount += 1;
  return true;
}

// ---------------------------------------------------------------------------
// N+1 备机
// ---------------------------------------------------------------------------

/**
 * 主机停机后在同组寻找可用备机，登记启动延时。延时到期由时间推进逻辑
 * 自启；备机不可用（故障/检修/ESD/健康为 0）则不登记，整组按剩余可用能力折算。
 */
function scheduleBackup(state: AssetPlantState, failed: AssetRecord): void {
  const standby = state.assets.find(
    (a) =>
      a.groupId === failed.groupId &&
      a.isStandby &&
      a.status === 'standby' &&
      a.health > 0 &&
      !a.esdLatched &&
      !a.faultLatched,
  );
  if (standby) {
    standby.standbyAvailableAtMin = state.timeMin + state.defaults.standbyStartDelayMin;
  }
}

/** 延时到期的备机自启；仍健康则转 running，能力按备机额定能力折算。 */
function promoteStandby(state: AssetPlantState): void {
  for (const asset of state.assets) {
    if (asset.standbyAvailableAtMin === null) continue;
    if (state.timeMin < asset.standbyAvailableAtMin) continue;
    asset.standbyAvailableAtMin = null;
    const canStart = asset.status === 'standby' && asset.health > 0 && !asset.esdLatched && !asset.faultLatched;
    if (!canStart) continue;
    asset.status = 'running';
    asset.startCount += 1;
    pushEvent(
      asset,
      state.timeMin,
      'running',
      'BACKUP_AUTOSTART',
      `备机延时 ${state.defaults.standbyStartDelayMin} min 后自启`,
    );
  }
}

// ---------------------------------------------------------------------------
// ESD
// ---------------------------------------------------------------------------

/** 触发 ESD：全厂或单元级。匹配设备进入安全位并锁存；复位只能走 resetEsd。 */
export function triggerEsd(state: AssetPlantState, scope: { unitId?: string } = {}): void {
  const unitId = scope.unitId;
  const matches = (a: AssetRecord) => unitId === undefined || a.unitId === unitId;
  for (const asset of state.assets) {
    if (!matches(asset)) continue;
    if (asset.status === 'esd_tripped') continue;
    pushEvent(asset, state.timeMin, 'esd_tripped', 'ESD_TRIP', unitId ? `单元 ${unitId} ESD 动作` : '全厂 ESD 动作');
    asset.status = 'esd_tripped';
    asset.esdLatched = true;
    asset.standbyAvailableAtMin = null;
  }
  state.esd = {
    active: true,
    scope: unitId === undefined ? 'plant' : 'unit',
    unitId: unitId ?? null,
    triggeredAtMin: state.timeMin,
    resetAtMin: null,
  };
}

/** 显式 ESD 复位：解除锁存，设备回到角色位；动作记入审计事件。 */
export function resetEsd(state: AssetPlantState): void {
  if (!state.esd.active) return;
  for (const asset of state.assets) {
    if (!asset.esdLatched) continue;
    asset.esdLatched = false;
    const to = asset.isStandby ? 'standby' : 'running';
    pushEvent(asset, state.timeMin, to, 'ESD_RESET', 'ESD 复位，设备恢复角色位');
    asset.status = to;
  }
  state.esd.active = false;
  state.esd.resetAtMin = state.timeMin;
}

// ---------------------------------------------------------------------------
// 健康度与时间推进
// ---------------------------------------------------------------------------

function decayHealth(asset: AssetRecord, dtMin: number): void {
  const def = maintenanceDefaults(asset.category);
  // 健康度按额定寿命线性退化；运行中才磨损，停机/待命不计磨损。
  const wearPerMin = 100 / def.designLifeH / 60;
  asset.health = Math.max(0, asset.health - wearPerMin * dtMin);
}

/** 概率性故障滚动：每运行小时按故障码概率独立判定，随机源走 state.seed，同 seed 可复现。 */
function rollProbabilisticFaults(state: AssetPlantState): void {
  if (!state.defaults.enableProbabilisticFaults) return;
  for (const asset of state.assets) {
    if (asset.status !== 'running') continue;
    const hourBucket = Math.floor(state.timeMin / 60);
    const rng = mulberry32(state.seed ^ hashString(asset.id) ^ (hourBucket * 7919));
    for (const def of Object.values(FAULT_CODES)) {
      const pMin = def.probabilityPerHour / 60;
      if (rng.next() < pMin) {
        injectFault(state, asset.id, def.code);
        break;
      }
    }
  }
}

/**
 * 资产子系统时间推进。
 *
 * @param state 资产状态（原地更新）
 * @param dtMin 步长（min）
 * @param events 本步注入/控制事件（故障注入、ESD、复位、工单）
 */
export function tickAssets(state: AssetPlantState, dtMin: number, events: AssetInEvent[] = []): AssetPlantState {
  if (dtMin <= 0) return state;

  for (const ev of events) {
    if (ev.type === 'injectFault') injectFault(state, ev.assetId, ev.code);
    else if (ev.type === 'esdTrigger') triggerEsd(state, { unitId: ev.unitId });
    else if (ev.type === 'esdReset') resetEsd(state);
    else if (ev.type === 'faultReset') resetAssetFault(state, ev.assetId);
  }

  state.timeMin += dtMin;

  // 运行时数累计与健康退化
  for (const asset of state.assets) {
    if (asset.status === 'running') {
      asset.runtimeMin += dtMin;
      decayHealth(asset, dtMin);
    }
  }

  promoteStandby(state);
  rollProbabilisticFaults(state);
  tickMaintenance(state, dtMin, events.filter((e) => e.type.startsWith('workOrder')) as MaintenanceEvent[]);
  return state;
}

// ---------------------------------------------------------------------------
// 可用性因子
// ---------------------------------------------------------------------------

/** 单台设备当前能力折算（0–1）：健康度 × 故障降容。 */
export function assetCapacityFactor(asset: AssetRecord): number {
  if (asset.status !== 'running') return 0;
  return clamp01((asset.health / 100) * asset.derateFactor);
}

/**
 * 组/单元可用性因子（0–1）：当前可用能力 ÷ 主机额定能力。
 *
 * - key 传 groupId 或 unitId；匹配不到组返回 1（子系统未启用/无该组，不拖累引擎）。
 * - 备机自启后按其额定能力计入可用能力；主机全停且无可用备机时因子为 0，
 *   对应错误码 ASSET_UNAVAILABLE 的语义由路由/引擎层解释。
 */
export function capacityFactorFor(state: AssetPlantState | null | undefined, key: string): number {
  if (!state || state.assets.length === 0) return 1;
  const group = state.assets.filter((a) => a.groupId === key || a.unitId === key);
  if (group.length === 0) return 1;

  const dutyRated = group.filter((a) => !a.isStandby).reduce((sum, a) => sum + ratedCapacity(a), 0);
  const rated = dutyRated > 0 ? dutyRated : group.reduce((sum, a) => sum + ratedCapacity(a), 0);
  if (rated <= 0) return 1;

  const available = group.reduce((sum, a) => sum + ratedCapacity(a) * assetCapacityFactor(a), 0);
  return clamp01(available / rated);
}

// ---------------------------------------------------------------------------
// 只读视图（路由 / 面板复用）
// ---------------------------------------------------------------------------

export interface AssetGroupView {
  groupId: string;
  unitId: string;
  category: AssetCategory;
  factor: number;
  dutyCount: number;
  standbyCount: number;
  runningCount: number;
  unavailableCount: number;
}

export function groupAvailability(state: AssetPlantState): AssetGroupView[] {
  const byGroup = new Map<string, AssetRecord[]>();
  for (const asset of state.assets) {
    const list = byGroup.get(asset.groupId) ?? [];
    list.push(asset);
    byGroup.set(asset.groupId, list);
  }
  return [...byGroup.entries()].map(([groupId, list]) => ({
    groupId,
    unitId: list[0].unitId,
    category: list[0].category,
    factor: capacityFactorFor(state, groupId),
    dutyCount: list.filter((a) => !a.isStandby).length,
    standbyCount: list.filter((a) => a.isStandby).length,
    runningCount: list.filter((a) => a.status === 'running').length,
    unavailableCount: list.filter(
      (a) => a.status === 'fault' || a.status === 'maintenance' || a.status === 'esd_tripped',
    ).length,
  }));
}

/**
 * WP7 预防性维护与检修工单。
 *
 * 边界（与现场台账的关系）：
 * - 本模块只给可配置的默认计划周期与工单生命周期；真实检修周期、备件清单、
 *   停机时长来自现场 CMMS / 设备台账，代码内默认值是工程假设，见
 *   docs/ASSET-MANAGEMENT.md「默认参数来源」一节。
 * - 工单是纯 JSON 可序列化对象，进快照与审计；不持有函数、Map 或定时器。
 *
 * 与 assets.ts 的分工：assets.ts 负责设备状态机、故障码、备机与 ESD；
 * 本模块负责「什么时候该修、修的过程怎么记、修完怎么恢复」。
 */

import type { AssetCategory, AssetPlantState, AssetRecord } from './assets';

/** 工单状态：open 待派工 → in_progress 检修中 → completed 完工；overdue 是逾期标记而非独立流转态。 */
export type WorkOrderStatus = 'open' | 'in_progress' | 'completed' | 'overdue';

export type WorkOrderKind = 'preventive' | 'corrective' | 'emergency';

export interface WorkOrder {
  id: string;
  assetId: string;
  kind: WorkOrderKind;
  status: WorkOrderStatus;
  reason: string;
  createdAtMin: number;
  startedAtMin: number | null;
  completedAtMin: number | null;
  /** 计划检修时长（min）；超过即判逾期 */
  plannedDurationMin: number;
  /** 实际停机时长（min），从开工到完工累计 */
  downtimeMin: number;
  /** 计划依据：距上次维护的运行时数 / 日历天数 */
  dueRuntimeH: number;
  dueCalendarD: number;
  /** 本次检修登记的备件（模拟台账字段；库存管理未做） */
  parts: string[];
  overdue: boolean;
}

/**
 * 分类别维护计划默认值（工程假设，非现场标定）。
 *
 * - `runtimeH`：距上次维护累计运行多少小时触发预防性工单；
 * - `calendarD`：距上次维护多少日历天触发（双触发，先到为准）；
 * - `plannedDurationMin`：计划检修时长，逾期判定基准；
 * - `designLifeH`：额定设计寿命（运行小时），健康度退化速率按此折算。
 */
export const MAINTENANCE_DEFAULTS: Record<
  AssetCategory,
  { runtimeH: number; calendarD: number; plannedDurationMin: number; designLifeH: number; parts: string[] }
> = {
  pump: { runtimeH: 4000, calendarD: 180, plannedDurationMin: 240, designLifeH: 20000, parts: ['机械密封', '轴承'] },
  blower: {
    runtimeH: 6000,
    calendarD: 365,
    plannedDurationMin: 360,
    designLifeH: 30000,
    parts: ['轴承', '皮带', '空气滤芯'],
  },
  mixer: { runtimeH: 8000, calendarD: 365, plannedDurationMin: 180, designLifeH: 40000, parts: ['机械密封', '叶轮'] },
  scraper: { runtimeH: 8000, calendarD: 365, plannedDurationMin: 240, designLifeH: 40000, parts: ['传动链条', '刮板'] },
  thickener: {
    runtimeH: 6000,
    calendarD: 365,
    plannedDurationMin: 240,
    designLifeH: 30000,
    parts: ['传动装置', '耙架'],
  },
  dewatering: {
    runtimeH: 3000,
    calendarD: 180,
    plannedDurationMin: 300,
    designLifeH: 15000,
    parts: ['转鼓', '螺旋输送器'],
  },
  dosing_pump: {
    runtimeH: 2000,
    calendarD: 180,
    plannedDurationMin: 120,
    designLifeH: 12000,
    parts: ['隔膜', '单向阀'],
  },
};

export function maintenanceDefaults(category: AssetCategory): (typeof MAINTENANCE_DEFAULTS)[AssetCategory] {
  return MAINTENANCE_DEFAULTS[category] ?? MAINTENANCE_DEFAULTS.pump;
}

function assetById(state: AssetPlantState, assetId: string): AssetRecord | undefined {
  return state.assets.find((a) => a.id === assetId);
}

function orderById(state: AssetPlantState, orderId: string): WorkOrder | undefined {
  return state.workOrders.find((w) => w.id === orderId);
}

/** 该设备是否已有未闭环工单（open / in_progress / overdue），避免重复派工。 */
export function hasOpenWorkOrder(state: AssetPlantState, assetId: string): boolean {
  return state.workOrders.some((w) => w.assetId === assetId && w.status !== 'completed');
}

/**
 * 创建工单。返回新建工单；设备已有未闭环工单时返回 null（不重复派工）。
 * 检修类工单由调用方（故障处理 / 手动派工）触发；预防性工单由到期评估自动创建。
 */
export function createWorkOrder(
  state: AssetPlantState,
  assetId: string,
  kind: WorkOrderKind,
  reason: string,
  atMin: number,
): WorkOrder | null {
  const asset = assetById(state, assetId);
  if (!asset) return null;
  if (hasOpenWorkOrder(state, assetId)) return null;

  const def = maintenanceDefaults(asset.category);
  state.seq += 1;
  const order: WorkOrder = {
    id: `wo-${state.seq}`,
    assetId,
    kind,
    status: 'open',
    reason,
    createdAtMin: atMin,
    startedAtMin: null,
    completedAtMin: null,
    plannedDurationMin: def.plannedDurationMin,
    downtimeMin: 0,
    dueRuntimeH: def.runtimeH,
    dueCalendarD: def.calendarD,
    parts: [...def.parts],
    overdue: false,
  };
  state.workOrders.push(order);
  asset.activeWorkOrderId = order.id;
  return order;
}

/**
 * 开工：设备进入 maintenance，检修期间不可用；同组备机由 assets.ts 的
 * 备机逻辑顶替。开工后再调用完工才恢复。
 */
export function startWorkOrder(state: AssetPlantState, orderId: string, atMin: number): WorkOrder | null {
  const order = orderById(state, orderId);
  if (!order || order.status === 'completed') return null;
  const asset = assetById(state, order.assetId);
  if (!asset) return null;

  order.status = 'in_progress';
  order.startedAtMin = atMin;
  order.overdue = false;
  const from = asset.status;
  asset.status = 'maintenance';
  asset.faultCode = null;
  asset.faultSeverity = null;
  asset.faultLatched = false;
  asset.derateFactor = 1;
  pushAssetEvent(asset, atMin, from, 'maintenance', 'WO_START', `工单 ${order.id} 开工，设备退出运行`);
  return order;
}

/**
 * 完工：登记停机时长，健康度恢复到新设备水平，设备回到其角色位
 * （备机回 standby，主机回 running）。维护是健康度唯一的恢复途径。
 */
export function completeWorkOrder(state: AssetPlantState, orderId: string, atMin: number): WorkOrder | null {
  const order = orderById(state, orderId);
  if (!order || order.status === 'completed' || order.startedAtMin === null) return null;
  const asset = assetById(state, order.assetId);
  if (!asset) return null;

  order.completedAtMin = atMin;
  order.downtimeMin = Math.max(0, atMin - order.startedAtMin);
  order.status = 'completed';
  order.overdue = false;

  const from = asset.status;
  asset.health = 100;
  asset.lastMaintenanceMin = atMin;
  asset.activeWorkOrderId = null;
  asset.derateFactor = 1;
  asset.status = asset.isStandby ? 'standby' : 'running';
  pushAssetEvent(
    asset,
    atMin,
    from,
    asset.status,
    'WO_DONE',
    `工单 ${order.id} 完工，停机 ${Math.round(order.downtimeMin)} min，健康度恢复`,
  );
  return order;
}

/** 预防性到期评估：运行时数或日历天数任一越限，自动生成待派工工单。 */
export function evaluateMaintenanceDue(state: AssetPlantState, atMin: number): void {
  for (const asset of state.assets) {
    if (asset.status === 'esd_tripped' || asset.status === 'maintenance') continue;
    if (hasOpenWorkOrder(state, asset.id)) continue;

    const def = maintenanceDefaults(asset.category);
    const runtimeH = (asset.runtimeMin - asset.lastMaintenanceMin) / 60;
    const calendarD = (atMin - asset.lastMaintenanceMin) / 1440;
    const dueByRuntime = runtimeH >= def.runtimeH;
    const dueByCalendar = calendarD >= def.calendarD;
    if (!dueByRuntime && !dueByCalendar) continue;

    const reason = dueByRuntime
      ? `运行 ${runtimeH.toFixed(0)} h 达到保养周期 ${def.runtimeH} h`
      : `投运 ${calendarD.toFixed(0)} d 达到日历保养周期 ${def.calendarD} d`;
    createWorkOrder(state, asset.id, 'preventive', reason, atMin);
  }
}

/** 逾期判定：待派工超过计划时长未开工、或检修中超过计划时长未完工。 */
function markOverdue(state: AssetPlantState, atMin: number): void {
  for (const order of state.workOrders) {
    if (order.status === 'completed') continue;
    const ref = order.startedAtMin ?? order.createdAtMin;
    order.overdue = atMin - ref > order.plannedDurationMin;
    if (order.overdue && order.status === 'open') order.status = 'overdue';
  }
}

/**
 * 维护子系统时间推进。事件由调用方从 tickAssets 透传；到期评估与逾期判定
 * 每步执行一次。
 */
export function tickMaintenance(state: AssetPlantState, _dtMin: number, events: MaintenanceEvent[]): void {
  const atMin = state.timeMin;
  for (const ev of events) {
    if (ev.type === 'workOrderCreate') {
      createWorkOrder(state, ev.assetId, ev.kind ?? 'corrective', ev.reason ?? '手动派工', atMin);
    } else if (ev.type === 'workOrderStart') {
      startWorkOrder(state, ev.workOrderId, atMin);
    } else if (ev.type === 'workOrderComplete') {
      completeWorkOrder(state, ev.workOrderId, atMin);
    }
  }
  evaluateMaintenanceDue(state, atMin);
  markOverdue(state, atMin);
}

/** 维护子系统接收的事件（与 assets.ts 的事件并集由 tickAssets 分发）。 */
export type MaintenanceEvent =
  | { type: 'workOrderCreate'; assetId: string; kind?: WorkOrderKind; reason?: string }
  | { type: 'workOrderStart'; workOrderId: string }
  | { type: 'workOrderComplete'; workOrderId: string };

function pushAssetEvent(
  asset: AssetRecord,
  atMin: number,
  from: AssetRecord['status'],
  to: AssetRecord['status'],
  code: string,
  detail: string,
): void {
  asset.events.push({ atMin, from, to, code, detail });
}

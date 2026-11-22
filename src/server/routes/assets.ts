/**
 * WP7 资产只读路由（纯函数，便于契约测试）。
 *
 * 契约（docs/INDUSTRIAL-INTERFACES.md 第 4 节）：
 * - 模块导出纯函数 `assetsRoute(pathname, url, input)`，返回 `{status, body} | null`；
 *   返回 null 表示本模块不处理该路径，交回调用方 404。
 * - 接线（在 apiRoutes.ts 里调用本函数）由集成方统一做，本文件不改 apiRoutes.ts。
 * - 只读：不提供写端点；故障注入 / 复位 / 工单开工完工走仿真事件入口。
 */

import { capacityFactorFor, groupAvailability, type AssetPlantState, type AssetRecord } from '../../sim/assets';
import type { WorkOrder } from '../../sim/maintenance';

export interface RouteReply {
  status: number;
  body: unknown;
}

/** 路由入参：资产子系统状态；null 表示该子系统未启用（旧快照兼容）。 */
export interface AssetsRouteInput {
  state: AssetPlantState | null;
}

const ASSETS_PREFIX = '/api/assets';

interface AssetView {
  id: string;
  name: string;
  category: AssetRecord['category'];
  unitId: string;
  unitName: string;
  groupId: string;
  isStandby: boolean;
  repairable: boolean;
  ratedFlowM3h: number;
  ratedPowerKw: number;
  status: AssetRecord['status'];
  faultCode: string | null;
  faultSeverity: AssetRecord['faultSeverity'];
  health: number;
  derateFactor: number;
  runtimeMin: number;
  startCount: number;
  availability: number;
  activeWorkOrderId: string | null;
  standbyAvailableAtMin: number | null;
}

function assetView(state: AssetPlantState, asset: AssetRecord): AssetView {
  return {
    id: asset.id,
    name: asset.name,
    category: asset.category,
    unitId: asset.unitId,
    unitName: asset.unitName,
    groupId: asset.groupId,
    isStandby: asset.isStandby,
    repairable: asset.repairable,
    ratedFlowM3h: asset.ratedFlowM3h,
    ratedPowerKw: asset.ratedPowerKw,
    status: asset.status,
    faultCode: asset.faultCode,
    faultSeverity: asset.faultSeverity,
    health: Math.round(asset.health),
    derateFactor: Number(asset.derateFactor.toFixed(2)),
    runtimeMin: Math.round(asset.runtimeMin),
    startCount: asset.startCount,
    availability: Number(capacityFactorFor(state, asset.groupId).toFixed(3)),
    activeWorkOrderId: asset.activeWorkOrderId,
    standbyAvailableAtMin: asset.standbyAvailableAtMin,
  };
}

function workOrderView(order: WorkOrder) {
  return { ...order };
}

function emptyPlantBody() {
  return {
    summary: {
      total: 0,
      running: 0,
      standby: 0,
      fault: 0,
      maintenance: 0,
      esdTripped: 0,
      avgHealth: 100,
      plantAvailability: 1,
    },
    esd: { active: false, scope: 'plant' as const, unitId: null, triggeredAtMin: null, resetAtMin: null },
    groups: [],
    assets: [],
    workOrders: [],
  };
}

function plantBody(state: AssetPlantState) {
  const assets = state.assets.map((a) => assetView(state, a));
  const countBy = (status: AssetRecord['status']) => state.assets.filter((a) => a.status === status).length;
  const avgHealth =
    state.assets.length === 0 ? 100 : state.assets.reduce((sum, a) => sum + a.health, 0) / state.assets.length;
  const groups = groupAvailability(state);
  const plantAvailability = groups.length === 0 ? 1 : groups.reduce((sum, g) => sum + g.factor, 0) / groups.length;

  return {
    summary: {
      total: state.assets.length,
      running: countBy('running'),
      standby: countBy('standby'),
      fault: countBy('fault'),
      maintenance: countBy('maintenance'),
      esdTripped: countBy('esd_tripped'),
      avgHealth: Math.round(avgHealth),
      plantAvailability: Number(plantAvailability.toFixed(3)),
    },
    esd: state.esd,
    groups,
    assets,
    workOrders: state.workOrders.map(workOrderView),
  };
}

/**
 * 资产路由入口。
 *
 * - `GET /api/assets`：注册表 + 状态 + 组可用率 + 工单；
 * - `GET /api/assets/:id`：单台设备详情；未知 id 返回 404 `ASSET_NOT_FOUND`。
 */
export function assetsRoute(pathname: string, _url: URL, input: AssetsRouteInput): RouteReply | null {
  if (pathname !== ASSETS_PREFIX && !pathname.startsWith(`${ASSETS_PREFIX}/`)) return null;

  const { state } = input;
  if (!state) return { status: 200, body: emptyPlantBody() };

  const segments = pathname.slice(ASSETS_PREFIX.length).split('/').filter(Boolean);

  if (segments.length === 0) {
    return { status: 200, body: plantBody(state) };
  }

  if (segments.length === 1) {
    const assetId = decodeURIComponent(segments[0]);
    const asset = state.assets.find((a) => a.id === assetId);
    if (!asset) {
      return {
        status: 404,
        body: { error: `未找到设备 ${assetId}`, code: 'ASSET_NOT_FOUND' },
      };
    }
    const orders = state.workOrders.filter((w) => w.assetId === asset.id).map(workOrderView);
    return {
      status: 200,
      body: {
        asset: assetView(state, asset),
        group: groupAvailability(state).find((g) => g.groupId === asset.groupId) ?? null,
        workOrders: orders,
      },
    };
  }

  return { status: 404, body: { error: '未找到资产子路径', code: 'ASSET_NOT_FOUND' } };
}

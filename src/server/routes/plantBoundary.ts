/**
 * WP2 全厂边界只读路由（契约 §4）。
 *
 * 纯函数：只吃显式入参，不读模块全局、不开定时器；接线（在 apiRoutes.ts 里调用）
 * 由集成方统一完成。返回 null 表示本模块不处理该 pathname，交回调用方 404。
 *
 * 路径：
 *   GET /api/plant/balance  COD / N / P 三本账、沼气、泥线状态、残差与诊断
 */

import type { NetworkSimState } from '../../sim/networkEngine';
import { plantView, PLANT_ERRORS, type PlantBoundarySnapshot } from '../../sim/plantBoundary';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface PlantRouteInput {
  state: NetworkSimState;
}

function emptyRow() {
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

function emptyView(): PlantBoundarySnapshot {
  return {
    enabled: false,
    balance: { cod: emptyRow(), n: emptyRow(), p: emptyRow() },
    sludgeLine: {
      enabled: false,
      thickener: { feedFlowM3h: 0, underflowFlowM3h: 0, supernatantFlowM3h: 0, underflowSsKgM3: 0 },
      digester: {
        volumeM3: 0,
        temperatureC: 0,
        srtDays: 0,
        gas: {
          methaneM3d: 0,
          co2M3d: 0,
          totalM3d: 0,
          ch4Fraction: 0,
          methaneKgD: 0,
          vssDestroyedKgD: 0,
          heatingKw: 0,
          mixingKw: 0,
        },
      },
      dewatering: {
        cakeDrySolidsKgD: 0,
        cakeWetKgD: 0,
        filtrate: { flowM3h: 0, nh4NKgM3: 0, codKgM3: 0, tpKgM3: 0 },
      },
      cumulative: {
        rawSludgeKgD: 0,
        cakeKgD: 0,
        methaneM3: 0,
        filtrateNh4Kg: 0,
        filtrateCodKg: 0,
        filtrateTpKg: 0,
      },
    },
    errors: [],
  };
}

export function plantBoundaryRoute(pathname: string, _url: URL, input: PlantRouteInput): RouteReply | null {
  if (pathname !== '/api/plant/balance') return null;

  const view = plantView(input.state.plant) ?? emptyView();
  const unclosed = view.errors.some((e) => e.code === PLANT_ERRORS.PLANT_BALANCE_UNCLOSED);
  return {
    status: 200,
    body: {
      status: 'ok',
      ...view,
      balanceClosed: view.balance.cod.closed && view.balance.n.closed && view.balance.p.closed,
      unclosedDiagnostic: unclosed,
    },
  };
}

/**
 * WP3 水力学只读路由（契约 §4）。
 *
 * 纯函数：只吃显式入参，不读模块全局、不开定时器；接线（在 apiRoutes.ts 里调用）
 * 由集成方统一完成。返回 null 表示本模块不处理该 pathname，交回调用方 404。
 *
 * 路径：
 *   GET /api/hydraulics            全量水力学视图（边流量/容积/停留时间/状态/示踪剂）
 *   GET /api/hydraulics?edge=<id> 单条边诊断
 *   GET /api/hydraulics/tracer     示踪剂 RTD 矩与质量守恒账
 */

import type { NetworkSimState } from '../../sim/networkEngine';
import { HYDRAULICS_ERRORS, hydraulicView, tracerMassBalance, type HydraulicSnapshot } from '../../sim/hydraulics';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface HydraulicsRouteInput {
  state: NetworkSimState;
}

function emptyView(): HydraulicSnapshot {
  return {
    edgeCount: 0,
    edges: [],
    trains: [],
    tracer: {
      active: false,
      meanResidenceMin: 0,
      varianceMin2: 0,
      peakMin: 0,
      peakC: 0,
      injectedMassKg: 0,
      retainedMassKg: 0,
    },
    errors: [],
  };
}

export function hydraulicsRoute(pathname: string, url: URL, input: HydraulicsRouteInput): RouteReply | null {
  if (pathname === '/api/hydraulics') {
    const view = hydraulicView(input.state.hydraulics) ?? emptyView();
    const edgeId = url.searchParams.get('edge');
    if (edgeId !== null) {
      if (!edgeId.trim()) {
        return {
          status: 400,
          body: { error: 'edge 参数不能为空', code: HYDRAULICS_ERRORS.INVALID_GEOMETRY },
        };
      }
      const found = view.edges.find((e) => e.id === edgeId);
      if (!found) {
        return {
          status: 404,
          body: { error: `未知水力边 ${edgeId}`, code: HYDRAULICS_ERRORS.INVALID_GEOMETRY },
        };
      }
      return { status: 200, body: { status: 'ok', ...view, edges: [found] } };
    }
    return { status: 200, body: { status: 'ok', ...view } };
  }

  if (pathname === '/api/hydraulics/tracer') {
    const h = input.state.hydraulics;
    if (!h) return { status: 200, body: { active: false, rtd: null, balance: null } };
    const balance = tracerMassBalance(h);
    return {
      status: 200,
      body: {
        active: h.tracer.active,
        rtd: {
          meanResidenceMin: h.tracer.meanResidenceMin,
          varianceMin2: h.tracer.varianceMin2,
          peakMin: h.tracer.peakMin,
          peakC: h.tracer.peakC,
          injectedMassKg: h.tracer.injectedMassKg,
          historyLength: h.tracer.history.length,
        },
        balance,
      },
    };
  }

  return null;
}

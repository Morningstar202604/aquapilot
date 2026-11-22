/**
 * WP4 仪表与控制层只读路由（契约 §4）。
 *
 * 纯函数：只吃显式入参，不读模块全局、不开定时器；接线（在 apiRoutes.ts 里调用）
 * 由集成方统一完成。返回 null 表示本模块不处理该 pathname，交回调用方 404。
 *
 * 路径：
 *   GET /api/instruments              测点清单：measured / truth / 质量码 / 故障模式
 *   GET /api/instruments?sensor=<id>  单个测点诊断
 *   GET /api/control/interlocks      回路输出、联锁状态、ESD、被拒指令审计
 *   GET /api/control/interlocks?condition=<id>  单条联锁诊断
 */

import type { NetworkSimState } from '../../sim/networkEngine';
import { instrumentationView } from '../../sim/instruments';
import { controlLayerView } from '../../sim/controlLayer';
import { groupAvailability } from '../../sim/assets';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface InstrumentsRouteInput {
  state: NetworkSimState;
}

const INSTRUMENTATION_EMPTY = { timeMin: 0, count: 0, readings: [] as never[] };

export function instrumentsRoute(pathname: string, url: URL, input: InstrumentsRouteInput): RouteReply | null {
  if (pathname === '/api/instruments') {
    const view = input.state.instruments ? instrumentationView(input.state.instruments) : INSTRUMENTATION_EMPTY;
    const sensorId = url.searchParams.get('sensor');
    if (sensorId !== null) {
      if (!sensorId.trim()) {
        return { status: 400, body: { error: 'sensor 参数不能为空', code: 'SENSOR_FAULT_ACTIVE' } };
      }
      const found = view.readings.find((r) => r.sensorId === sensorId);
      if (!found) {
        return { status: 404, body: { error: `未知测点 ${sensorId}`, code: 'SENSOR_FAULT_ACTIVE' } };
      }
      return { status: 200, body: { status: 'ok', ...view, readings: [found] } };
    }
    return { status: 200, body: { status: 'ok', ...view } };
  }

  if (pathname === '/api/control/interlocks') {
    const layer = input.state.controlLayer;
    if (!layer) {
      return {
        status: 200,
        body: {
          status: 'ok',
          active: false,
          outputs: {},
          loops: {},
          interlocks: [],
          esd: null,
          audit: [],
          inflowStopped: false,
        },
      };
    }
    const view = controlLayerView(layer);
    const conditionId = url.searchParams.get('condition');
    const interlocks = Array.isArray(view.interlocks) ? (view.interlocks as object[]) : [];
    if (conditionId !== null) {
      if (!conditionId.trim()) {
        return { status: 400, body: { error: 'condition 参数不能为空', code: 'INTERLOCK_TRIPPED' } };
      }
      const found = interlocks.find((i) => (i as { conditionId: string }).conditionId === conditionId);
      if (!found) {
        return { status: 404, body: { error: `未知联锁 ${conditionId}`, code: 'INTERLOCK_TRIPPED' } };
      }
      return { status: 200, body: { status: 'ok', ...view, interlocks: [found] } };
    }
    const groups = input.state.assets ? groupAvailability(input.state.assets) : [];
    return { status: 200, body: { status: 'ok', ...view, assetGroups: groups } };
  }

  return null;
}

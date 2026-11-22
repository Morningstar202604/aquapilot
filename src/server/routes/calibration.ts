/**
 * WP5 标定不确定性只读路由（纯函数）。
 *
 * 契约（docs/INDUSTRIAL-INTERFACES.md 第 4、5 节）：
 * - 导出 `calibrationRoute(pathname, url, input)`，返回 null 表示本模块不处理；
 * - 纯函数只吃显式入参（不确定性结果、预测区间、数据来源），不读模块全局；
 * - 接线（在 apiRoutes.ts 里调用）由集成方统一做，本文件不改 apiRoutes.ts；
 * - 查询参数做边界校验：非法 param / from>to / 非有限时间窗返回 400。
 *
 * 端点：`/api/calibration/uncertainty?param=&from=&to=`
 * - 无标定结果（数据不足）→ 409 CALIBRATION_INSUFFICIENT_DATA；
 * - 参数不可辨识 → 409 CALIBRATION_NOT_IDENTIFIABLE；
 * - 正常返回区间、相关矩阵、P10/P50/P90 与 dataSource。
 */

import { CALIBRATABLE_PARAMS } from '../../sim/calibration';
import type { PredictionUncertainty, UncertaintyResult } from '../../sim/uncertainty';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface CalibrationRouteInput {
  /** 标定不确定性结果；null 表示尚未完成可用于区间分析的标定 */
  uncertainty: UncertaintyResult | null;
  /** 蒙特卡洛预测区间；可为 null（未跑预测不确定性） */
  predictions: PredictionUncertainty | null;
  /** 数据来源标识：synthetic = 合成数据验证，field = 现场观测 */
  dataSource: 'synthetic' | 'field';
}

const UNCERTAINTY_PATH = '/api/calibration/uncertainty';

function errorReply(status: number, code: string, error: string): RouteReply {
  return { status, body: { error, code } };
}

function parseWindow(url: URL): { from: number; to: number } | RouteReply {
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  const from = rawFrom === null ? 0 : Number(rawFrom);
  const to = rawTo === null ? Number.POSITIVE_INFINITY : Number(rawTo);
  if (!Number.isFinite(from)) {
    return errorReply(400, 'BAD_REQUEST', 'from 必须是有限数值');
  }
  if (rawTo !== null && !Number.isFinite(to)) {
    return errorReply(400, 'BAD_REQUEST', 'to 必须是有限数值');
  }
  if (to < from) {
    return errorReply(400, 'BAD_REQUEST', 'to 必须大于等于 from');
  }
  return { from, to };
}

function handleUncertainty(url: URL, input: CalibrationRouteInput): RouteReply {
  const window = parseWindow(url);
  if ('status' in window) return window;

  const rawParam = url.searchParams.get('param');
  if (rawParam !== null && !(CALIBRATABLE_PARAMS as readonly string[]).includes(rawParam)) {
    return errorReply(400, 'BAD_REQUEST', `未知标定参数 ${rawParam}`);
  }

  if (!input.uncertainty) {
    return errorReply(409, 'CALIBRATION_INSUFFICIENT_DATA', '尚无足够观测数据完成标定；当前结果不能给出参数置信区间');
  }

  const uncertainty = input.uncertainty;
  if (uncertainty.code === 'CALIBRATION_NOT_IDENTIFIABLE') {
    return {
      status: 409,
      body: {
        error: uncertainty.reasons.join('；'),
        code: 'CALIBRATION_NOT_IDENTIFIABLE',
        reasons: uncertainty.reasons,
      },
    };
  }

  const intervals =
    rawParam === null ? uncertainty.intervals : uncertainty.intervals.filter((i) => i.param === rawParam);

  return {
    status: 200,
    body: {
      dataSource: input.dataSource,
      coverage: uncertainty.coverage,
      confidence: uncertainty.confidence,
      bootstrapSamples: uncertainty.bootstrapSamples,
      seed: uncertainty.seed,
      intervals,
      correlation: uncertainty.correlation,
      predictions: input.predictions,
      window,
    },
  };
}

/** 纯函数路由入口；不匹配返回 null，交回调用方 404 */
export function calibrationRoute(pathname: string, url: URL, input: CalibrationRouteInput): RouteReply | null {
  if (pathname === UNCERTAINTY_PATH) return handleUncertainty(url, input);
  return null;
}

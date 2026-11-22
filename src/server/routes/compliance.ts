/**
 * WP6 合规只读路由（纯函数）。
 *
 * 契约（docs/INDUSTRIAL-INTERFACES.md 第 4 节）：
 * - 导出 `complianceRoute(pathname, url, input)`，返回 null 表示本模块不处理；
 * - 纯函数只吃显式入参（分钟读数、限值、采样配置），不读模块全局、不开定时器；
 * - 接线（在 apiRoutes.ts 里调用）由集成方统一做，本文件不改 apiRoutes.ts；
 * - 查询参数做边界校验：非法数字 / to<from / 超窗宽 / 非法 format 一律 400。
 *
 * 端点：
 * - `/api/compliance/report?from=&to=&format=json|csv`
 * - `/api/compliance/samples?from=&to=`
 */

import { stringify } from 'csv-stringify/sync';
import { DEFAULT_STANDARD, type DischargeLimits } from '../../sim/standards';
import {
  DEFAULT_SAMPLING_CONFIG,
  METRIC_KEYS,
  samplesFromReadings,
  type MetricKey,
  type MinuteReading,
  type ParallelPair,
  type Sample,
  type SamplingConfig,
} from '../../sim/sampling';
import {
  COMPLIANCE_MAX_WINDOW_MIN,
  ComplianceError,
  buildComplianceReport,
  type ComplianceReport,
} from '../../sim/compliance';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface ComplianceRouteInput {
  /** 分钟读数，由集成方从 TrendPoint / 快照行映射进来 */
  readings: MinuteReading[];
  limits?: DischargeLimits;
  standardId?: string;
  /** 覆盖默认采样配置（检出限、滞后、RPD、留样时限等现场许可证参数） */
  config?: Partial<SamplingConfig>;
  parallelPairs?: Partial<Record<MetricKey, ParallelPair>>;
  p95WindowDays?: number;
  monthWindowDays?: number;
}

const REPORT_PATH = '/api/compliance/report';
const SAMPLES_PATH = '/api/compliance/samples';

function errorReply(status: number, code: string, error: string): RouteReply {
  return { status, body: { error, code } };
}

function parseWindow(url: URL): { fromMin: number; toMin: number } | RouteReply {
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  const from = rawFrom === null ? 0 : Number(rawFrom);
  const to = rawTo === null ? from + COMPLIANCE_MAX_WINDOW_MIN : Number(rawTo);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return errorReply(400, 'PERMIT_WINDOW_INVALID', 'from/to 必须是有限数值');
  }
  if (to < from) {
    return errorReply(400, 'PERMIT_WINDOW_INVALID', 'to 必须大于等于 from');
  }
  if (to - from > COMPLIANCE_MAX_WINDOW_MIN) {
    return errorReply(400, 'PERMIT_WINDOW_INVALID', `单次最多查询 ${COMPLIANCE_MAX_WINDOW_MIN} 仿真分钟`);
  }
  return { fromMin: from, toMin: to };
}

function resolveConfig(input: ComplianceRouteInput): SamplingConfig {
  return { ...DEFAULT_SAMPLING_CONFIG, ...input.config };
}

function evaluateReport(input: ComplianceRouteInput, fromMin: number, toMin: number): ComplianceReport {
  const config = resolveConfig(input);
  const samples = samplesFromReadings(input.readings, config, input.parallelPairs);
  return buildComplianceReport(samples, {
    limits: input.limits ?? DEFAULT_STANDARD.limits,
    standardId: input.standardId ?? DEFAULT_STANDARD.id,
    fromMin,
    toMin,
    p95WindowDays: input.p95WindowDays,
    monthWindowDays: input.monthWindowDays,
    dataSource: config.dataSource,
    compositeWindowMin: config.compositeWindowMin,
  });
}

function sampleView(sample: Sample): Record<string, unknown> {
  return {
    id: sample.id,
    type: sample.type,
    sampledAtMin: sample.sampledAtMin,
    resultAvailableAtMin: sample.resultAvailableAtMin,
    flowM3h: sample.flowM3h,
    source: sample.source,
    results: sample.results,
  };
}

const CSV_HEADERS = [
  'metric',
  'label',
  'limit_mg_l',
  'sample_value_mg_l',
  'sample_type',
  'sampled_at_min',
  'result_available_at_min',
  'qa_status',
  'below_dl',
  'censored',
  'verdict',
  'statistical_basis',
  'sample_id',
  'data_source',
];

/**
 * 报表 CSV：一行 = 一份样品 × 一个指标。
 * 字段覆盖任务要求：指标、限值、样品值、样品类型、样品时间、结果可用时间、
 * QA 状态、是否删失、判定、统计口径、数据来源标识。转义交给 csv-stringify。
 */
export function buildComplianceCsv(report: ComplianceReport): string {
  const rows: unknown[][] = [];
  for (const sample of report.samples) {
    for (const metric of METRIC_KEYS) {
      const r = sample.results[metric];
      const limit = report.metrics[metric].limit;
      const accepted = r.validity === 'accepted' && r.value !== null;
      const verdict = !accepted ? 'unevaluated' : (r.value as number) > limit ? 'exceed' : 'pass';
      rows.push([
        metric,
        report.metrics[metric].label,
        limit,
        r.value === null ? '' : r.value,
        sample.type,
        sample.sampledAtMin,
        sample.resultAvailableAtMin,
        r.validity,
        r.belowDL ? 'yes' : 'no',
        r.censored ? 'yes' : 'no',
        verdict,
        sample.type === 'composite' ? 'daily-composite-24h' : 'grab-instant',
        sample.id,
        sample.source,
      ]);
    }
  }
  return stringify(rows, {
    header: true,
    columns: CSV_HEADERS,
    eof: true,
    record_delimiter: 'windows',
    escape_formulas: true,
    quoted_match: [/[",\r\n]/],
  });
}

function handleReport(url: URL, input: ComplianceRouteInput): RouteReply {
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') {
    return errorReply(400, 'PERMIT_WINDOW_INVALID', 'format 必须是 json 或 csv');
  }

  const window = parseWindow(url);
  if ('status' in window) return window;

  let report: ComplianceReport;
  try {
    report = evaluateReport(input, window.fromMin, window.toMin);
  } catch (err) {
    if (err instanceof ComplianceError) {
      const status = err.code === 'PERMIT_WINDOW_INVALID' ? 400 : 422;
      return errorReply(status, err.code, err.message);
    }
    throw err;
  }

  if (format === 'csv') {
    return {
      status: 200,
      body: { format: 'csv', filename: 'compliance-report.csv', csv: buildComplianceCsv(report) },
    };
  }
  return { status: 200, body: report };
}

function handleSamples(url: URL, input: ComplianceRouteInput): RouteReply {
  const window = parseWindow(url);
  if ('status' in window) return window;

  const config = resolveConfig(input);
  const samples = samplesFromReadings(input.readings, config, input.parallelPairs).filter(
    (s) => s.sampledAtMin >= window.fromMin && s.sampledAtMin <= window.toMin,
  );
  return { status: 200, body: { window, count: samples.length, samples: samples.map(sampleView) } };
}

/** 纯函数路由入口；不匹配返回 null，交回调用方 404 */
export function complianceRoute(pathname: string, url: URL, input: ComplianceRouteInput): RouteReply | null {
  if (pathname === REPORT_PATH) return handleReport(url, input);
  if (pathname === SAMPLES_PATH) return handleSamples(url, input);
  return null;
}

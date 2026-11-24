/**
 * `/api/v1/experiments` 版本化 REST 路由。
 *
 * 与旧只读 API 的边界：
 * - 旧端点继续走 `apiRoutes.ts` 的只读门，不改行为；
 * - 本模块只在 `/api/v1/experiments` 与 `/api/openapi.json` 前缀内接管，
 *   写操作显式要求 operator，读操作 viewer；
 * - 错误统一 RFC 9457，不沿用旧 `{error}` 结构。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorize, type Role } from '../auth';
import { BodyTooLargeError, InvalidJsonError, UnsupportedMediaTypeError, readJsonBody } from '../httpBody';
import { sendDownload } from '../httpJson';
import { sendProblem } from '../problem';
import { logger } from '../observability';
import {
  ExperimentQueueFullError,
  ExperimentIdempotencyConflictError,
  ExperimentConflictError,
  type ExperimentService,
} from '../experimentService';
import { ExperimentSpecError, parseExperimentSpec } from '../experimentSchema';
import type { ExperimentRecord } from '../experimentStore';
import { openApiDocument } from '../openapi';

export interface ExperimentApiDeps {
  service: ExperimentService;
  appVersion: string;
}

export interface ExperimentApi {
  matches(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): void;
}

function toDetail(record: ExperimentRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
    finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : null,
    progress: record.progress,
    simMinute: record.simMinute,
    queuePosition: record.queuePosition,
    topologyHash: record.topologyHash,
    spec: record.spec,
    summary: record.summary,
    validation: record.validation,
    provenance: record.provenance,
    error: record.error,
    links: {
      self: `/api/v1/experiments/${record.id}`,
      samples: `/api/v1/experiments/${record.id}/samples.csv`,
      report: `/api/v1/experiments/${record.id}/report.md`,
      cancel: `/api/v1/experiments/${record.id}/cancel`,
    },
  };
}

function toListRow(row: {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: number;
  summary: unknown;
  error: string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    progress: row.progress,
    summary: row.summary,
    error: row.error,
  };
}

function encodeCursor(row: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(row), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null): { createdAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) || typeof parsed.id !== 'string') {
      throw new Error('bad cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error('bad cursor');
  }
}

function csvCell(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(6).replace(/\.?0+$/, '') || '0';
  const text = String(v ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function samplesCsv(record: ExperimentRecord): string {
  const header = [
    'minute',
    'flow_m3h',
    'cod_mgL',
    'bod_mgL',
    'ss_mgL',
    'nh_mgL',
    'tn_mgL',
    'tp_mgL',
    'ph',
    'temperature_c',
    'do_mgL',
    'mlss_mgL',
    'srt_d',
    'energy_kw',
    'score',
    'blanket_m',
  ];
  const lines = [header.join(',')];
  for (const s of record.samples ?? []) {
    lines.push(
      [
        s.minute,
        s.effluent.flow,
        s.effluent.cod,
        s.effluent.bod,
        s.effluent.ss,
        s.effluent.nh,
        s.effluent.tn,
        s.effluent.tp,
        s.effluent.ph,
        s.effluent.temperature,
        s.doLevel,
        s.mlss,
        s.srtDays,
        s.energyKw,
        s.score,
        s.blanketM,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function reportMarkdown(record: ExperimentRecord): string {
  const s = record.summary;
  const v = record.validation;
  if (!s || !v) return '# AquaPilot experiment\n\nNo result.\n';
  const rows = s.compliance
    .map(
      (c) =>
        `| ${c.label} | ${c.limit} | ${c.max.toFixed(3)} | ${c.p95.toFixed(3)} | ${c.exceedSamples} | ${c.compliant ? 'PASS' : 'FAIL'} |`,
    )
    .join('\n');
  const checks = v.checks.map((c) => `- **${c.status.toUpperCase()}** \`${c.id}\` ${c.label} — ${c.detail}`).join('\n');
  return `# AquaPilot 实验报告：${s.name}

> 本报告由 AquaPilot 在离线仿真后自动生成。相同拓扑、spec 与种子可复现本结果。

## 运行标识

- 实验 ID：\`${record.id}\`
- 模型：\`${s.model}\`；策略：\`${s.policy}\`；校验级别：\`${v.level}\`
- 种子：\`${s.seed}\`
- 仿真时长：${s.durationMin} min（暖机 ${s.warmupDays} d；采样 ${s.sampleEveryMin} min）
- 拓扑哈希：\`${record.topologyHash}\`
- 模型/数值校验：${v.certified ? '**CERTIFIED**' : '**NOT CERTIFIED**'}（scope: ${v.scope}）
- 本次运行合规：${v.operatingCompliant ? '**PASS**' : '**FAIL**'}

## 出水统计（mg/L，pH/温度除外）

| 指标 | 限值 | 最大 | P95 | 超标采样 | 判定 |
|---|---:|---:|---:|---:|---|
${rows}

能耗 ${s.energyKwh.toFixed(0)} kWh；进水 ${s.inflowM3.toFixed(0)} m³；吨水能耗 ${s.specificEnergyKwhM3.toFixed(4)} kWh/m³；平均 MLSS ${s.meanMlss.toFixed(0)} mg/L；末段 SRT ${s.finalSrtDays.toFixed(1)} d。

## 多维校验

${checks}

## 复现

\`\`\`bash
curl -X POST /api/v1/experiments \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(record.spec).replace(/'/g, "'\\''")}'
\`\`\`
`;
}

function authorise(req: IncomingMessage, res: ServerResponse, needed: Role, pathname: string): boolean {
  const decision = authorize(req, null, needed);
  if (decision.allowed) return true;
  const status = decision.role ? 403 : 401;
  sendProblem(
    res,
    status,
    status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
    status === 403 ? '权限不足' : '未认证',
    decision.reason ?? 'access denied',
    pathname,
  );
  return false;
}

function methodNotAllowed(res: ServerResponse, pathname: string, allow: string): void {
  sendProblem(res, 405, 'METHOD_NOT_ALLOWED', '方法不允许', `该资源只接受 ${allow}`, pathname, { Allow: allow });
}

export function createExperimentApi(deps: ExperimentApiDeps): ExperimentApi {
  const { service, appVersion } = deps;
  const openapi = openApiDocument(appVersion);

  async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/api/openapi.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, pathname, 'GET, HEAD');
        return;
      }
      const body = JSON.stringify(openapi);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: `"${createHash('sha256').update(body).digest('base64url')}"`,
        'Cache-Control': 'public, max-age=300',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (pathname === '/api/v1/experiments') {
      if (req.method === 'POST') {
        if (!authorise(req, res, 'operator', pathname)) return;
        let raw: unknown;
        try {
          raw = await readJsonBody(req, 64 * 1024);
        } catch (error) {
          if (error instanceof UnsupportedMediaTypeError) {
            sendProblem(
              res,
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              '请求体类型不支持',
              'Content-Type 必须是 application/json',
              pathname,
            );
          } else if (error instanceof BodyTooLargeError) {
            sendProblem(res, 413, 'BODY_TOO_LARGE', '请求体过大', `上限 ${error.limit} 字节`, pathname);
          } else if (error instanceof InvalidJsonError) {
            sendProblem(res, 400, 'INVALID_JSON', 'JSON 无法解析', error.message, pathname);
          } else {
            throw error;
          }
          return;
        }
        let spec;
        try {
          spec = parseExperimentSpec(raw);
        } catch (error) {
          if (error instanceof ExperimentSpecError) {
            sendProblem(
              res,
              422,
              'EXPERIMENT_SPEC_INVALID',
              '实验参数不合法',
              error.message,
              pathname,
              {},
              error.issues,
            );
            return;
          }
          throw error;
        }

        const rawKey = req.headers['idempotency-key'];
        if (Array.isArray(rawKey)) {
          sendProblem(res, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 不合法', '不能重复发送', pathname);
          return;
        }
        const idempotencyKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null;
        if (idempotencyKey && (idempotencyKey.length > 128 || hasControlChars(idempotencyKey))) {
          sendProblem(
            res,
            400,
            'IDEMPOTENCY_KEY_INVALID',
            'Idempotency-Key 不合法',
            '长度需 ≤128 且不能含控制字符',
            pathname,
          );
          return;
        }

        try {
          const created = service.create(spec, idempotencyKey);
          const detail = toDetail(created.record);
          res.writeHead(created.replayed ? 200 : 202, {
            'Content-Type': 'application/json; charset=utf-8',
            Location: `/api/v1/experiments/${created.record.id}`,
            ...(created.replayed ? {} : { 'Retry-After': '30' }),
          });
          res.end(JSON.stringify(detail));
        } catch (error) {
          if (error instanceof ExperimentQueueFullError) {
            sendProblem(
              res,
              429,
              'EXPERIMENT_QUEUE_FULL',
              '实验队列已满',
              `最多 ${error.limit} 个排队/运行任务，请稍后重试`,
              pathname,
              { 'Retry-After': '30' },
            );
            return;
          }
          if (error instanceof ExperimentIdempotencyConflictError) {
            sendProblem(
              res,
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '幂等键冲突',
              '同一 Idempotency-Key 已用于不同请求体',
              pathname,
            );
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!authorise(req, res, 'viewer', pathname)) return;
        const url = new URL(req.url ?? '/', 'http://localhost');
        const statusRaw = url.searchParams.get('status') ?? 'all';
        if (!['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(statusRaw)) {
          sendProblem(
            res,
            400,
            'QUERY_INVALID',
            'status 不合法',
            '允许 all/queued/running/succeeded/failed/cancelled',
            pathname,
          );
          return;
        }
        const limitRaw = Number(url.searchParams.get('limit') ?? 20);
        if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
          sendProblem(res, 400, 'QUERY_INVALID', 'limit 不合法', 'limit 必须是 1–100 的整数', pathname);
          return;
        }
        let cursor;
        try {
          cursor = decodeCursor(url.searchParams.get('cursor'));
        } catch {
          sendProblem(res, 400, 'QUERY_INVALID', 'cursor 不合法', 'cursor 必须来自上一页响应', pathname);
          return;
        }
        const rows = service.list(
          statusRaw as 'all' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
          limitRaw + 1,
          cursor,
        );
        const items = rows.slice(0, limitRaw).map(toListRow);
        const last = items[items.length - 1];
        const body = JSON.stringify({
          items,
          nextCursor:
            rows.length > limitRaw && last
              ? encodeCursor({ createdAt: Date.parse(last.createdAt), id: last.id })
              : null,
        });
        const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          ETag: etag,
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      methodNotAllowed(res, pathname, 'GET, HEAD, POST');
      return;
    }

    const prefix = '/api/v1/experiments/';
    if (!pathname.startsWith(prefix)) {
      sendProblem(res, 404, 'NOT_FOUND', '未找到', '未知 API 路径', pathname);
      return;
    }
    const rest = pathname.slice(prefix.length);
    const parts = rest.split('/');
    const id = parts[0];
    if (!/^exp_[0-9a-f-]{36}$/i.test(id)) {
      sendProblem(res, 404, 'NOT_FOUND', '未找到', '实验 ID 格式不合法', pathname);
      return;
    }

    if (parts.length === 1) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, pathname, 'GET, HEAD');
        return;
      }
      if (!authorise(req, res, 'viewer', pathname)) return;
      const record = service.get(id);
      if (!record) {
        sendProblem(res, 404, 'EXPERIMENT_NOT_FOUND', '实验不存在', `id=${id}`, pathname);
        return;
      }
      const body = JSON.stringify(toDetail(record));
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: etag,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (parts.length === 2 && parts[1] === 'cancel') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, pathname, 'POST');
        return;
      }
      if (!authorise(req, res, 'operator', pathname)) return;
      try {
        const record = service.cancel(id);
        if (!record) {
          sendProblem(res, 404, 'EXPERIMENT_NOT_FOUND', '实验不存在', `id=${id}`, pathname);
          return;
        }
        res.writeHead(202, {
          'Content-Type': 'application/json; charset=utf-8',
          Location: `/api/v1/experiments/${id}`,
        });
        res.end(JSON.stringify(toDetail(record)));
      } catch (error) {
        if (error instanceof ExperimentConflictError) {
          sendProblem(
            res,
            409,
            'EXPERIMENT_NOT_CANCELLABLE',
            '实验不能取消',
            `当前状态为 ${error.status}，仅 queued/running 可取消`,
            pathname,
          );
          return;
        }
        throw error;
      }
      return;
    }

    if (parts.length === 2 && (parts[1] === 'samples.csv' || parts[1] === 'report.md')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, pathname, 'GET, HEAD');
        return;
      }
      if (!authorise(req, res, 'viewer', pathname)) return;
      const record = service.get(id);
      if (!record) {
        sendProblem(res, 404, 'EXPERIMENT_NOT_FOUND', '实验不存在', `id=${id}`, pathname);
        return;
      }
      if (record.status !== 'succeeded') {
        sendProblem(res, 409, 'EXPERIMENT_NOT_READY', '结果尚未就绪', `当前状态 ${record.status}`, pathname);
        return;
      }
      if (parts[1] === 'samples.csv') {
        const csv = samplesCsv(record);
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
          res.end();
          return;
        }
        sendDownload(res, `${record.id}-samples.csv`, csv, 'text/csv; charset=utf-8');
        return;
      }
      const md = reportMarkdown(record);
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end();
        return;
      }
      sendDownload(res, `${record.id}-report.md`, md, 'text/markdown; charset=utf-8');
      return;
    }

    sendProblem(res, 404, 'NOT_FOUND', '未找到', '未知实验子资源', pathname);
  }

  return {
    matches(pathname: string) {
      return (
        pathname === '/api/openapi.json' ||
        pathname === '/api/v1/experiments' ||
        pathname.startsWith('/api/v1/experiments/')
      );
    },
    handle(req, res, pathname) {
      void dispatch(req, res, pathname).catch((error) => {
        logger.error('experiment api failed', { route: pathname, error: String(error) });
        if (!res.headersSent) {
          sendProblem(res, 500, 'INTERNAL_ERROR', '内部错误', '实验服务异常，请查看服务日志', pathname);
        } else {
          res.end();
        }
      });
    },
  };
}

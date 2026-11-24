/**
 * `/api/v1/studies`：仿真研究（批量变体 + 重复 + 目标排序 + Pareto）。
 *
 * 子实验仍由 `/api/v1/experiments/{id}` 持有；本路由只提供研究级视图，
 * 不把子实验结果复制一份，避免同一事实存在两个版本。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorize } from '../auth';
import { BodyTooLargeError, InvalidJsonError, UnsupportedMediaTypeError, readJsonBody } from '../httpBody';
import { sendDownload } from '../httpJson';
import { sendProblem } from '../problem';
import {
  StudyIdempotencyConflictError,
  StudyQueueFullError,
  type StudyService,
  type StudyDetail,
} from '../studyService';
import { StudySpecError, parseStudySpec } from '../studySchema';
import { studyMarkdown } from '../../sim/study';

export interface StudyApiDeps {
  service: StudyService;
}

export interface StudyApi {
  matches(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function detailBody(detail: StudyDetail) {
  const { record, plan, aggregate } = detail;
  return {
    id: record.id,
    name: record.name,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    error: record.error,
    spec: record.spec,
    aggregate,
    children: plan.children.map((child, index) => ({
      experimentId: record.childIds[index] ?? null,
      name: child.spec.name,
      variantIndex: child.variantIndex,
      replicate: child.replicate,
      links: record.childIds[index] ? { self: `/api/v1/experiments/${record.childIds[index]}` } : null,
    })),
    links: {
      self: `/api/v1/studies/${record.id}`,
      cancel: `/api/v1/studies/${record.id}/cancel`,
      report: `/api/v1/studies/${record.id}/report.md`,
    },
  };
}

function summaryBody(detail: StudyDetail) {
  const body = detailBody(detail);
  return {
    id: body.id,
    name: body.name,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    status: body.aggregate.status,
    progressPercent: body.aggregate.progressPercent,
    total: body.aggregate.total,
    succeeded: body.aggregate.succeeded,
    failed: body.aggregate.failed,
    best: body.aggregate.best,
    links: body.links,
  };
}

function authorise(
  req: IncomingMessage,
  res: ServerResponse,
  needed: 'viewer' | 'operator',
  pathname: string,
): boolean {
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

async function readBody(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<unknown | null> {
  try {
    return await readJsonBody(req, 64 * 1024);
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
    return null;
  }
}

function idempotency(req: IncomingMessage, res: ServerResponse, pathname: string): string | null | undefined {
  const raw = req.headers['idempotency-key'];
  if (Array.isArray(raw)) {
    sendProblem(res, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 不合法', '不能重复发送', pathname);
    return undefined;
  }
  const key = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (key && (key.length > 128 || hasControlChars(key))) {
    sendProblem(
      res,
      400,
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key 不合法',
      '长度需 ≤128 且不能含控制字符',
      pathname,
    );
    return undefined;
  }
  return key;
}

function sendJson(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

export function createStudyApi(deps: StudyApiDeps): StudyApi {
  const { service } = deps;

  async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/api/v1/studies') {
      if (req.method === 'POST') {
        if (!authorise(req, res, 'operator', pathname)) return;
        const raw = await readBody(req, res, pathname);
        if (raw === null) return;
        let spec;
        try {
          spec = parseStudySpec(raw);
        } catch (error) {
          if (error instanceof StudySpecError) {
            sendProblem(res, 422, 'STUDY_SPEC_INVALID', '研究参数不合法', error.message, pathname, {}, error.issues);
            return;
          }
          throw error;
        }
        const key = idempotency(req, res, pathname);
        if (key === undefined) return;
        try {
          const created = service.create(spec, key);
          const body = JSON.stringify(detailBody(created.detail));
          sendJson(res, created.replayed ? 200 : 202, body, {
            Location: `/api/v1/studies/${created.detail.record.id}`,
            ...(created.replayed ? {} : { 'Retry-After': '30' }),
          });
        } catch (error) {
          if (error instanceof StudyQueueFullError) {
            sendProblem(
              res,
              429,
              'STUDY_QUEUE_FULL',
              '研究队列容量不足',
              `需要 ${createdChildCount(spec)} 个子实验，但只有 ${error.limit} 个空闲/可容纳槽位；请稍后重试`,
              pathname,
              { 'Retry-After': '30' },
            );
            return;
          }
          if (error instanceof StudyIdempotencyConflictError) {
            sendProblem(
              res,
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '幂等键冲突',
              '同一 Idempotency-Key 已用于不同研究',
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
        const limitRaw = Number(url.searchParams.get('limit') ?? 20);
        if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
          sendProblem(res, 400, 'QUERY_INVALID', 'limit 不合法', 'limit 必须是 1–100 的整数', pathname);
          return;
        }
        const body = JSON.stringify({ items: service.list(limitRaw).map(summaryBody) });
        const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        sendJson(res, 200, body, { ETag: etag, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return;
        return;
      }

      methodNotAllowed(res, pathname, 'GET, HEAD, POST');
      return;
    }

    const prefix = '/api/v1/studies/';
    if (!pathname.startsWith(prefix)) {
      sendProblem(res, 404, 'NOT_FOUND', '未找到', '未知 API 路径', pathname);
      return;
    }
    const rest = pathname.slice(prefix.length);
    const parts = rest.split('/');
    const id = parts[0];
    if (!/^study_[0-9a-f-]{36}$/i.test(id)) {
      sendProblem(res, 404, 'NOT_FOUND', '未找到', '研究 ID 格式不合法', pathname);
      return;
    }

    if (parts.length === 1) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, pathname, 'GET, HEAD');
        return;
      }
      if (!authorise(req, res, 'viewer', pathname)) return;
      const detail = service.get(id);
      if (!detail) {
        sendProblem(res, 404, 'STUDY_NOT_FOUND', '研究不存在', `id=${id}`, pathname);
        return;
      }
      const body = JSON.stringify(detailBody(detail));
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      sendJson(res, 200, body, { ETag: etag, 'Cache-Control': 'no-store' });
      return;
    }

    if (parts.length === 2 && parts[1] === 'cancel') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, pathname, 'POST');
        return;
      }
      if (!authorise(req, res, 'operator', pathname)) return;
      const detail = service.cancel(id);
      if (!detail) {
        sendProblem(res, 404, 'STUDY_NOT_FOUND', '研究不存在', `id=${id}`, pathname);
        return;
      }
      sendJson(res, 202, JSON.stringify(detailBody(detail)), { Location: `/api/v1/studies/${id}` });
      return;
    }

    if (parts.length === 2 && parts[1] === 'report.md') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, pathname, 'GET, HEAD');
        return;
      }
      if (!authorise(req, res, 'viewer', pathname)) return;
      const detail = service.get(id);
      if (!detail) {
        sendProblem(res, 404, 'STUDY_NOT_FOUND', '研究不存在', `id=${id}`, pathname);
        return;
      }
      const md = studyMarkdown(detail.record.name, detail.record.spec, detail.aggregate, detail.record.childIds);
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end();
        return;
      }
      sendDownload(res, `${id}-study.md`, md, 'text/markdown; charset=utf-8');
      return;
    }

    sendProblem(res, 404, 'NOT_FOUND', '未找到', '未知研究子资源', pathname);
  }

  return {
    matches(pathname: string): boolean {
      return pathname === '/api/v1/studies' || pathname.startsWith('/api/v1/studies/');
    },
    handle(req, res, pathname) {
      return dispatch(req, res, pathname).catch((error) => {
        if (!res.headersSent) {
          sendProblem(
            res,
            500,
            'INTERNAL',
            '服务内部错误',
            error instanceof Error ? error.message : String(error),
            pathname,
          );
        } else {
          res.end();
        }
      });
    },
  };
}

function createdChildCount(spec: { variants: unknown[]; replicates: number }): number {
  return spec.variants.length * spec.replicates;
}

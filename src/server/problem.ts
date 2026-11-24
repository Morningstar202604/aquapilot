import type { ServerResponse } from 'node:http';
import type { SchemaIssue } from './experimentSchema';

/**
 * RFC 9457 Problem Details。
 *
 * 新版本化 API 的错误响应统一用 `application/problem+json`，而不是
 * 历史接口的 `{ error: string }`。两者并存是刻意的：旧客户端不破坏，
 * 新契约有可机器识别的 `type/code/status/detail/instance`。
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code?: string;
  errors?: SchemaIssue[];
}

export function sendProblem(
  res: ServerResponse,
  status: number,
  code: string,
  title: string,
  detail: string,
  instance?: string,
  extraHeaders: Record<string, string> = {},
  errors?: SchemaIssue[],
): void {
  const body: ProblemDetails = {
    type: `urn:aquapilot:problem:${code}`,
    title,
    status,
    detail,
    ...(instance ? { instance } : {}),
    code,
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
  res.writeHead(status, {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

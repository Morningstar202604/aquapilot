import type { ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * 统一的 JSON 响应出口。
 *
 * 入口文件里此前有 20 多处 `writeHead + res.end(JSON.stringify(...))`：
 * 状态码、Content-Type、HEAD 语义各写一遍，新增路由时很容易漏掉
 * `charset` 或误写成 `text/plain`。这里只保留一个出口，额外响应头
 * （Allow、MCP 协议头）通过第四参传入。
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': JSON_TYPE, ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** 文本/CSV/Markdown 等非 JSON 响应；仍由同一层负责 Content-Type */
export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': contentType, ...headers });
  res.end(body);
}

/** 附件下载：CSV / Markdown 导出的统一头，避免四处手写 Content-Disposition */
export function sendDownload(res: ServerResponse, filename: string, body: string, contentType: string): void {
  const safeName = filename.replace(/["\r\n]/g, '_');
  sendText(res, 200, body, contentType, {
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
  });
}

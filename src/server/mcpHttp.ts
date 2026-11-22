import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorize } from './auth';
import { handleMcpRequest, mcpInternalError, mcpToolByName, type McpFacade, type McpResult } from './mcp';
import { logger, metrics } from './observability';

/**
 * MCP Streamable HTTP 端点。
 *
 * 从 `index.ts` 拆出来的原因：鉴权、按工具分级、IP 滑窗和协议分发是一组
 * 完整的安全边界，混在 2,000 行的入口文件里时，任何路由改动都可能绕过它。
 * 这里只依赖 auth/mcp/observability 三个模块，不碰主仿真运行时。
 */
export function createMcpHttpHandler(facade: McpFacade) {
  /** 60 请求/分钟/IP；工具调用是重操作，足够宽裕 */
  const rate = new Map<string, { count: number; windowStart: number }>();

  return async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    } catch {
      body = null; // 让协议层回 -32700/-32600
    }

    // 分级鉴权：按请求的工具选择角色（未知工具按 viewer 处理，协议层回 -32602）
    const requestedTool =
      body && typeof body === 'object' ? (body as { params?: { name?: unknown } }).params?.name : undefined;
    const mcpTool = typeof requestedTool === 'string' ? mcpToolByName(requestedTool) : undefined;
    const requiredRole = mcpTool && !mcpTool.readOnly ? 'operator' : 'viewer';
    const decision = authorize(req, null, requiredRole);
    if (!decision.allowed) {
      metrics.authFailures += 1;
      logger.warn('mcp auth rejected', { reason: decision.reason, tool: requestedTool ?? null });
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized', requiredRole }));
      return;
    }

    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const bucket = rate.get(ip);
    if (!bucket || now - bucket.windowStart > 60_000) {
      rate.set(ip, { count: 1, windowStart: now });
    } else if (++bucket.count > 60) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'rate limited (60 req/min)' }));
      return;
    }
    if (rate.size > 1024) rate.clear(); // 防地址欺骗撑爆内存

    let out: McpResult;
    try {
      out = handleMcpRequest({
        httpMethod: req.method ?? 'POST',
        origin: req.headers.origin ?? null,
        host: req.headers.host ?? null,
        protocolVersionHeader: (req.headers['mcp-protocol-version'] as string | undefined) ?? null,
        body,
        facade,
      });
    } catch (err) {
      out = mcpInternalError(err);
      logger.error('mcp internal error', { error: String(err) });
    }
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', ...(out.headers ?? {}) });
    res.end(out.body === undefined ? undefined : JSON.stringify(out.body));
  };
}

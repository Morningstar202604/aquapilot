/**
 * WP8 工业接口：只读 HTTP 路由（纯函数）。
 *
 * 路由形状对齐 docs/INDUSTRIAL-INTERFACES.md 第 4 节：
 * - 只吃显式入参（适配层句柄、审计日志），不读模块全局、不开定时器；
 * - 返回 `{ status, body }`；不匹配的 pathname 返回 null，交回调用方 404；
 * - 接线（在 apiRoutes.ts 里调用本模块）由集成方完成，本文件不改 apiRoutes.ts。
 *
 * 端点：
 * - `GET /api/protocols/tags`    标签表（地址 / 类型 / 单位 / 量程 / 读写策略）
 * - `GET /api/protocols/status`  各通道连接状态；指定通道断开时 503 + PROTOCOL_DISCONNECTED
 * - `GET /api/protocols/audit`   最近写入审计（成功 / 拒绝 / 超时 / 未知标签 / 断开）
 */
import type { ProtocolAdapter } from '../protocols/adapter';
import type { ProtocolAuditLog } from '../protocols/audit';
import { PROTOCOL_ERRORS, TAG_DEFINITIONS, type ProtocolKind } from '../protocols/tags';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface ProtocolsRouteInput {
  adapters: Partial<Record<ProtocolKind, ProtocolAdapter>>;
  audit: ProtocolAuditLog;
}

const AUDIT_LIMIT_DEFAULT = 100;
const AUDIT_LIMIT_MAX = 500;

function errorBody(error: string, code: string) {
  return { error, code };
}

function parseLimit(url: URL): { limit: number } | { error: string } {
  const raw = url.searchParams.get('limit');
  if (raw === null) return { limit: AUDIT_LIMIT_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { error: 'limit 必须是不小于 1 的整数' };
  }
  return { limit: Math.min(n, AUDIT_LIMIT_MAX) };
}

export function protocolsRoute(pathname: string, url: URL, input: ProtocolsRouteInput): RouteReply | null {
  if (pathname === '/api/protocols/tags') {
    return {
      status: 200,
      body: {
        tags: TAG_DEFINITIONS.map((tag) => ({
          id: tag.id,
          label: tag.label,
          dataType: tag.dataType,
          unit: tag.unit,
          access: tag.access,
          scale: tag.scale,
          source: tag.source,
          address: tag.address,
          description: tag.description,
        })),
      },
    };
  }

  if (pathname === '/api/protocols/status') {
    const channel = url.searchParams.get('channel');
    const snapshots = (Object.entries(input.adapters) as [ProtocolKind, ProtocolAdapter][]).map(([, adapter]) =>
      adapter.status(),
    );

    if (channel !== null) {
      const adapter = input.adapters[channel as ProtocolKind];
      if (!adapter) {
        return { status: 404, body: errorBody(`未知通道：${channel}`, PROTOCOL_ERRORS.TAG_UNKNOWN) };
      }
      const snapshot = adapter.status();
      if (snapshot.state === 'disconnected') {
        return {
          status: 503,
          body: { ...errorBody('通道断开', PROTOCOL_ERRORS.DISCONNECTED), channel: snapshot },
        };
      }
      return { status: 200, body: { channel: snapshot } };
    }

    return { status: 200, body: { channels: snapshots } };
  }

  if (pathname === '/api/protocols/audit') {
    const parsed = parseLimit(url);
    if ('error' in parsed) {
      return { status: 400, body: { error: parsed.error } };
    }
    return { status: 200, body: { audit: input.audit.recent(parsed.limit), total: input.audit.size() } };
  }

  return null;
}

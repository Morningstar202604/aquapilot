/**
 * WP8 工业接口：写入审计。
 *
 * 每一次写尝试（成功 / 拒绝 / 超时 / 未知标签 / 通道断开）都落一条记录，
 * 形状对齐服务端既有审计口径（谁、何时、对象、结果、原因），可经
 * `/api/protocols/audit` 查询。审计只增不改：拒绝记录与成功记录同等保真，
 * 事故复盘时必须能回答"谁在什么时候往哪个点写了什么、被谁拒了"。
 *
 * 本日志是进程内环形缓冲；持久化入库由集成方在接线时接入既有 Store，
 * WP8 不直接写数据库（文件归属见 INDUSTRIAL-INTERFACES.md 第 7 节）。
 */
import type { Role } from '../auth';
import type { ProtocolKind, TagRawValue } from './tags';

export type ProtocolWriteResult = 'success' | 'denied' | 'timeout' | 'unknown_tag' | 'disconnected';

export interface ProtocolAuditEntry {
  /** 单调递增序号，便于前端排序与对账 */
  seq: number;
  /** ISO 时间戳（墙钟） */
  at: string;
  /** 仿真时刻（分钟）；取不到时为 -1 */
  atMin: number;
  /** 操作者标识（令牌角色对应的调用方名称；系统内部写为 'system'） */
  actor: string;
  /** 操作者角色 viewer/operator/admin；未鉴权调用为 'anonymous' */
  role: Role | 'anonymous';
  protocol: ProtocolKind;
  /** 内部标签 ID；未知标签时为请求原文 */
  tag: string;
  /** 协议侧地址（OPC UA 节点 ID / Modbus 寄存器号 / MQTT topic） */
  address: string;
  requestedValue: TagRawValue;
  result: ProtocolWriteResult;
  /** 人可读原因；成功时为空串 */
  reason: string;
  /** 错误码（PROTOCOL_*）；成功时为 undefined */
  code?: string;
}

export interface ProtocolAuditLog {
  record(entry: Omit<ProtocolAuditEntry, 'seq' | 'at'>): ProtocolAuditEntry;
  recent(limit: number): ProtocolAuditEntry[];
  size(): number;
  clear(): void;
}

/** 默认环形缓冲容量：足够回放一个班次的写尝试，不随运行时长无限增长 */
export const DEFAULT_AUDIT_CAPACITY = 500;

export function createProtocolAudit(capacity: number = DEFAULT_AUDIT_CAPACITY): ProtocolAuditLog {
  let entries: ProtocolAuditEntry[] = [];
  let seq = 0;

  return {
    record(entry) {
      const row: ProtocolAuditEntry = {
        seq: ++seq,
        at: new Date().toISOString(),
        ...entry,
      };
      entries.push(row);
      if (entries.length > capacity) entries = entries.slice(entries.length - capacity);
      return row;
    },
    recent(limit) {
      const n = Math.max(0, Math.min(limit, entries.length));
      return entries.slice(entries.length - n).reverse();
    },
    size() {
      return entries.length;
    },
    clear() {
      entries = [];
    },
  };
}

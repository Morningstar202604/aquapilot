/**
 * WP8 工业接口：协议适配层。
 *
 * 三种传输（OPC UA 语义层 / Modbus TCP / MQTT）共用同一套：
 * - 连接状态机：connecting → connected → degraded → disconnected；
 * - 指数退避重连：带抖动、带上限，时钟与随机源可注入（测试用假时钟断言序列）；
 * - 质量码：good / uncertain / bad + 原因，时标随样本落戳；
 * - 写边界：白名单 + 鉴权 + 量程校验，拒绝一律 PROTOCOL_WRITE_DENIED；
 * - 审计：成功 / 拒绝 / 超时 / 未知标签 / 断开全部留痕。
 *
 * 断开期间读返回**缓存值 + bad 质量码**，不允许把上一次好值冒充实时数据。
 * 本层不实现任何工业协议二进制栈；传输细节在 transports/ 下，且均可插拔替换。
 */
import { roleAtLeast, type Role } from '../auth';
import {
  PROTOCOL_ERRORS,
  WRITE_REQUIRED_ROLE,
  applyControlWrite,
  inRange,
  readInternalValue,
  tagByAddress,
  tagById,
  type ProtocolKind,
  type ProtocolStateView,
  type TagDef,
  type TagRawValue,
} from './tags';
import type { ProtocolAuditLog, ProtocolWriteResult } from './audit';

export type ChannelState = 'connecting' | 'connected' | 'degraded' | 'disconnected';
export type QualityCode = 'good' | 'uncertain' | 'bad';

export interface Quality {
  code: QualityCode;
  reason?: string;
}

export interface TagValue {
  tag: string;
  address: string;
  value: TagRawValue;
  quality: Quality;
  timestamp: string;
  unit: string;
}

export class ProtocolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** 传输层抽象：具体实现见 transports/；适配层只依赖这个接口 */
export interface ProtocolTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  write(address: string, value: TagRawValue): Promise<TransportAck>;
}

export interface TransportAck {
  ok: boolean;
  reason?: string;
}

export interface BackoffOptions {
  /** 首次重连等待（ms） */
  baseMs: number;
  /** 指数因子 */
  factor: number;
  /** 单次重连等待上限（ms） */
  maxMs: number;
  /** 抖动幅度 0–1：实际等待 = 基数 × (1 ± jitter/2) */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1000,
  factor: 2,
  maxMs: 30_000,
  jitter: 0.2,
};

export interface AdapterClock {
  now(): number;
  random(): number;
}

export interface AdapterTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface WriteActor {
  name: string;
  role: Role;
}

export interface AdapterOptions {
  protocol: ProtocolKind;
  transport: ProtocolTransport;
  /** 取内部仿真状态视图的回调（纯函数调用，不读模块全局） */
  source: () => ProtocolStateView;
  audit: ProtocolAuditLog;
  clock?: AdapterClock;
  backoff?: Partial<BackoffOptions>;
  timers?: AdapterTimers;
  /** 单次写传输超时（ms） */
  timeoutMs?: number;
  /** 同一标签两次写入的最小间隔（ms）；0 表示不做写频限制 */
  writeMinIntervalMs?: number;
}

export interface ChannelSnapshot {
  protocol: ProtocolKind;
  state: ChannelState;
  reconnectAttempts: number;
  lastError?: string;
  connectedAt?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class ProtocolAdapter {
  readonly protocol: ProtocolKind;
  private readonly transport: ProtocolTransport;
  private readonly source: () => ProtocolStateView;
  private readonly audit: ProtocolAuditLog;
  private readonly clock: AdapterClock;
  private readonly backoff: BackoffOptions;
  private readonly timers: AdapterTimers;
  private readonly timeoutMs: number;
  private readonly writeMinIntervalMs: number;
  private readonly lastWriteAt = new Map<string, number>();

  state: ChannelState = 'disconnected';
  private reconnectAttempts = 0;
  private lastError?: string;
  private connectedAt?: string;
  private retryTimer: unknown = null;
  private readonly cache = new Map<string, TagValue>();

  constructor(options: AdapterOptions) {
    this.protocol = options.protocol;
    this.transport = options.transport;
    this.source = options.source;
    this.audit = options.audit;
    this.clock = options.clock ?? { now: () => Date.now(), random: () => Math.random() };
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.timers = options.timers ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writeMinIntervalMs = options.writeMinIntervalMs ?? 0;
  }

  /** 第 attempt 次重连的等待时长（纯函数，便于假时钟断言） */
  nextBackoffMs(attempt: number): number {
    const capped = Math.min(this.backoff.maxMs, this.backoff.baseMs * this.backoff.factor ** attempt);
    const jitterSpan = this.backoff.jitter / 2;
    const factor = 1 - jitterSpan + jitterSpan * 2 * this.clock.random();
    return Math.round(capped * factor);
  }

  /** 打开链路；成功进入 connected，失败进入 disconnected 并安排一次重连 */
  async connect(): Promise<void> {
    this.state = 'connecting';
    try {
      await this.transport.open();
      this.state = 'connected';
      this.reconnectAttempts = 0;
      this.lastError = undefined;
      this.connectedAt = new Date(this.clock.now()).toISOString();
    } catch (err) {
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  /** 传输层上报链路中断：connected → degraded，并立即安排重连 */
  markTransportDown(reason: string): void {
    if (this.state === 'disconnected' || this.state === 'connecting') return;
    this.state = 'degraded';
    this.lastError = reason;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    const delay = this.nextBackoffMs(this.reconnectAttempts);
    this.retryTimer = this.timers.setTimeout(() => void this.reconnectAttempt(), delay);
  }

  /** 执行一次重连尝试；暴露出来以便测试用假时钟直接驱动 */
  async reconnectAttempt(): Promise<void> {
    this.clearRetryTimer();
    this.state = 'connecting';
    try {
      await this.transport.open();
      this.state = 'connected';
      this.reconnectAttempts = 0;
      this.lastError = undefined;
      this.connectedAt = new Date(this.clock.now()).toISOString();
    } catch (err) {
      this.reconnectAttempts += 1;
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async close(): Promise<void> {
    this.clearRetryTimer();
    this.state = 'disconnected';
    this.connectedAt = undefined;
    try {
      await this.transport.close();
    } catch {
      // 关闭失败不阻断状态收敛；lastError 留痕即可
    }
  }

  status(): ChannelSnapshot {
    return {
      protocol: this.protocol,
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  }

  /** 按内部标签 ID 读；未知标签抛 PROTOCOL_TAG_UNKNOWN */
  async read(tagId: string): Promise<TagValue> {
    const tag = tagById(tagId);
    if (!tag) throw new ProtocolError(PROTOCOL_ERRORS.TAG_UNKNOWN, `未知标签：${tagId}`);
    return this.readTag(tag);
  }

  /** 按协议地址读（OPC UA 节点 ID / Modbus 寄存器号 / MQTT topic） */
  async readByAddress(address: string): Promise<TagValue> {
    const tag = tagByAddress(this.protocol, address);
    if (!tag) throw new ProtocolError(PROTOCOL_ERRORS.TAG_UNKNOWN, `未知地址：${address}`);
    return this.readTag(tag);
  }

  private readTag(tag: TagDef): Promise<TagValue> {
    const timestamp = new Date(this.clock.now()).toISOString();

    // 断开：返回缓存坏值；没有缓存时给一条 null 坏值，绝不拿旧好值冒充实时
    if (this.state === 'disconnected') {
      const cached = this.cache.get(tag.id);
      const sample: TagValue = cached
        ? { ...cached, quality: { code: 'bad', reason: 'channel disconnected' }, timestamp }
        : {
            tag: tag.id,
            address: this.addressOf(tag),
            value: null,
            quality: { code: 'bad', reason: 'channel disconnected; no cached value' },
            timestamp,
            unit: tag.unit,
          };
      this.cache.set(tag.id, sample);
      return Promise.resolve(sample);
    }

    const state = this.source();
    const internal = readInternalValue(state, tag);

    let quality: Quality;
    if (this.state === 'degraded') {
      quality = { code: 'uncertain', reason: 'channel degraded; last internal sample retained' };
    } else if (internal === null) {
      quality = { code: 'bad', reason: 'internal value unavailable or non-finite' };
    } else if (typeof internal === 'number' && !inRange(tag, internal)) {
      quality = { code: 'uncertain', reason: 'value out of tag range' };
    } else {
      quality = { code: 'good' };
    }

    const sample: TagValue = {
      tag: tag.id,
      address: this.addressOf(tag),
      value: internal,
      quality,
      timestamp,
      unit: tag.unit,
    };
    this.cache.set(tag.id, sample);
    return Promise.resolve(sample);
  }

  private addressOf(tag: TagDef): string {
    switch (this.protocol) {
      case 'opcua':
        return tag.address.opcua;
      case 'modbus':
        return String(tag.address.modbusRegister);
      case 'mqtt':
        return tag.address.mqtt;
    }
  }

  /**
   * 写一条标签。业务失败不抛业务异常前先落审计；抛出的 ProtocolError
   * 携带 PROTOCOL_* 错误码，由路由层翻译成错误响应。
   */
  async write(tagId: string, value: TagRawValue, actor: WriteActor): Promise<TagValue> {
    const tag = tagById(tagId);
    const address = tag ? this.addressOf(tag) : tagId;

    if (!tag) {
      this.auditRecord('unknown_tag', tagId, address, value, '标签不在映射表', PROTOCOL_ERRORS.TAG_UNKNOWN, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.TAG_UNKNOWN, `未知标签：${tagId}`);
    }

    if (this.state === 'disconnected') {
      this.auditRecord(
        'disconnected',
        tag.id,
        address,
        value,
        '通道断开，写入被拒绝',
        PROTOCOL_ERRORS.DISCONNECTED,
        actor,
      );
      throw new ProtocolError(PROTOCOL_ERRORS.DISCONNECTED, '通道断开，写入被拒绝');
    }

    if (!roleAtLeast(actor.role, WRITE_REQUIRED_ROLE)) {
      const reason = `角色 ${actor.role} 权限不足（需要 ${WRITE_REQUIRED_ROLE}）`;
      this.auditRecord('denied', tag.id, address, value, reason, PROTOCOL_ERRORS.WRITE_DENIED, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.WRITE_DENIED, reason);
    }

    if (tag.access !== 'write') {
      const reason = `标签 ${tag.id} 为只读，写入被拒绝`;
      this.auditRecord('denied', tag.id, address, value, reason, PROTOCOL_ERRORS.WRITE_DENIED, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.WRITE_DENIED, reason);
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || !inRange(tag, value)) {
      const reason = `写入值 ${String(value)} 超出量程 [${tag.scale.unitMin}, ${tag.scale.unitMax}]`;
      this.auditRecord('denied', tag.id, address, value, reason, PROTOCOL_ERRORS.WRITE_DENIED, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.WRITE_DENIED, reason);
    }

    const now = this.clock.now();
    const lastWrite = this.lastWriteAt.get(tag.id);
    if (this.writeMinIntervalMs > 0 && lastWrite !== undefined && now - lastWrite < this.writeMinIntervalMs) {
      const reason = `写入过于频繁：距上次写入不足 ${this.writeMinIntervalMs} ms`;
      this.auditRecord('denied', tag.id, address, value, reason, PROTOCOL_ERRORS.WRITE_DENIED, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.WRITE_DENIED, reason);
    }

    let ack: TransportAck;
    try {
      ack = await this.writeWithTimeout(address, value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.auditRecord(
        'timeout',
        tag.id,
        address,
        value,
        `传输写入超时：${reason}`,
        PROTOCOL_ERRORS.DISCONNECTED,
        actor,
      );
      throw new ProtocolError(PROTOCOL_ERRORS.DISCONNECTED, `传输写入超时：${reason}`);
    }

    if (!ack.ok) {
      const reason = ack.reason ?? '传输层拒绝写入';
      this.auditRecord('denied', tag.id, address, value, reason, PROTOCOL_ERRORS.WRITE_DENIED, actor);
      throw new ProtocolError(PROTOCOL_ERRORS.WRITE_DENIED, reason);
    }

    applyControlWrite(this.source(), tag, value);
    this.lastWriteAt.set(tag.id, now);
    this.auditRecord('success', tag.id, address, value, '', undefined, actor);

    const state = this.source();
    const applied = readInternalValue(state, tag);
    return {
      tag: tag.id,
      address,
      value: applied,
      quality: { code: 'good' },
      timestamp: new Date(this.clock.now()).toISOString(),
      unit: tag.unit,
    };
  }

  private async writeWithTimeout(address: string, value: TagRawValue): Promise<TransportAck> {
    let timer: unknown;
    const timeout = new Promise<TransportAck>((_, reject) => {
      timer = this.timers.setTimeout(() => reject(new Error(`写入超过 ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    try {
      return await Promise.race([this.transport.write(address, value), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  private auditRecord(
    result: ProtocolWriteResult,
    tag: string,
    address: string,
    value: TagRawValue,
    reason: string,
    code: string | undefined,
    actor: WriteActor,
  ): void {
    let atMin: number;
    try {
      atMin = this.source().timeMin;
    } catch {
      atMin = -1;
    }
    this.audit.record({
      atMin,
      actor: actor.name,
      role: actor.role,
      protocol: this.protocol,
      tag,
      address,
      requestedValue: value,
      result,
      reason,
      code,
    });
  }
}

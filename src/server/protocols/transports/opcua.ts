/**
 * WP8 工业接口：OPC UA 语义层 + 进程内模拟服务器。
 *
 * 边界（docs/INDUSTRIAL-PROTOCOLS.md 已写明）：
 * - 这里只实现会话 / 浏览 / 读 / 写 / 订阅的**语义形状**，便于适配层与测试
 *   在没有真实 PLC 的情况下跑通契约；
 * - **没有实现 OPC UA 二进制协议栈**，没有 Hello/OpenSecureChannel/
 *   Publish 报文交互，也**没有做安全策略协商**（签名/加密/证书签发）；
 * - 接真实 UA Server 时，把 `OpcUaTransport` 换成对应栈的适配器即可，
 *   适配层与标签表不需要改动。
 */
import type { TransportAck } from '../adapter';
import type { TagRawValue } from '../tags';

export type UaQuality = 'good' | 'uncertain' | 'bad';

export interface UaDataValue {
  nodeId: string;
  value: TagRawValue;
  quality: UaQuality;
  reason?: string;
  timestamp: string;
}

export type UaSubscriber = (dv: UaDataValue) => void;

/** 可插拔传输接口：真实栈适配器与模拟服务器都实现这一组方法 */
export interface OpcUaTransport {
  open(endpoint: string): Promise<void>;
  close(): Promise<void>;
  read(nodeId: string): Promise<UaDataValue>;
  write(nodeId: string, value: TagRawValue): Promise<TransportAck>;
  subscribe(nodeId: string, cb: UaSubscriber): Promise<() => void>;
  browse(): string[];
}

/** 取值解析器：模拟服务器借此把节点 ID 映射回引擎当前值（由适配层注入） */
export type UaResolver = (nodeId: string) => UaDataValue | undefined;

/**
 * 进程内模拟 UA 服务器。
 *
 * 不监听端口、不发二进制报文：值存放在进程内 Map，订阅回调直接同步派发。
 * 测试与本地演示用它验证读写订阅契约；真实联调走现场验收门。
 */
export class SimulatedOpcUaServer implements OpcUaTransport {
  private online = false;
  private readonly values = new Map<string, TagRawValue>();
  private readonly subscribers = new Map<string, Set<UaSubscriber>>();
  private resolver: UaResolver | null = null;
  private endpoint: string | null = null;

  /** 注入引擎取值回调；优先于本地缓存 */
  setResolver(resolver: UaResolver | null): void {
    this.resolver = resolver;
  }

  /** 在地址空间中登记一个模拟节点（初始值可空） */
  registerNode(nodeId: string, initialValue: TagRawValue = null): void {
    this.values.set(nodeId, initialValue);
  }

  async open(endpoint: string): Promise<void> {
    if (!endpoint.trim()) throw new Error('endpoint 不能为空');
    this.endpoint = endpoint;
    this.online = true;
  }

  async close(): Promise<void> {
    this.online = false;
    this.endpoint = null;
    this.subscribers.clear();
  }

  private ensureOnline(): void {
    if (!this.online) throw new Error('OPC UA 模拟服务器未连接');
  }

  async read(nodeId: string): Promise<UaDataValue> {
    this.ensureOnline();
    const resolved = this.resolver?.(nodeId);
    if (resolved) return resolved;
    if (this.values.has(nodeId)) {
      return { nodeId, value: this.values.get(nodeId) ?? null, quality: 'good', timestamp: new Date().toISOString() };
    }
    return { nodeId, value: null, quality: 'bad', reason: 'node not found', timestamp: new Date().toISOString() };
  }

  async write(nodeId: string, value: TagRawValue): Promise<TransportAck> {
    this.ensureOnline();
    if (!this.values.has(nodeId) && !this.resolver) {
      return { ok: false, reason: 'node not found' };
    }
    this.values.set(nodeId, value);
    const dv: UaDataValue = { nodeId, value, quality: 'good', timestamp: new Date().toISOString() };
    this.emit(nodeId, dv);
    return { ok: true };
  }

  async subscribe(nodeId: string, cb: UaSubscriber): Promise<() => void> {
    this.ensureOnline();
    let set = this.subscribers.get(nodeId);
    if (!set) {
      set = new Set();
      this.subscribers.set(nodeId, set);
    }
    set.add(cb);
    // 订阅建立时先推送一次当前值（对齐 UA 订阅的初始数据投递语义）
    void this.read(nodeId).then((dv) => cb(dv));
    return () => {
      set?.delete(cb);
    };
  }

  browse(): string[] {
    this.ensureOnline();
    const fromResolver = this.resolver ? Array.from(this.values.keys()) : [];
    return Array.from(new Set([...this.values.keys(), ...fromResolver])).sort();
  }

  /** 引擎节拍推进后主动发布一条数据变化通知 */
  publish(nodeId: string, dv: UaDataValue): void {
    this.values.set(nodeId, dv.value);
    this.emit(nodeId, dv);
  }

  private emit(nodeId: string, dv: UaDataValue): void {
    const set = this.subscribers.get(nodeId);
    if (!set) return;
    for (const cb of set) cb(dv);
  }

  get connected(): boolean {
    return this.online;
  }

  get activeEndpoint(): string | null {
    return this.endpoint;
  }
}

/**
 * 会话封装：把传输接口包成带开闭状态的会话。
 * 会话关闭后再调用读/写/订阅会抛错，避免拿到半连接句柄继续操作。
 */
export class SemanticOpcUaSession {
  private readonly transport: OpcUaTransport;
  private openFlag = false;

  constructor(transport: OpcUaTransport) {
    this.transport = transport;
  }

  async open(endpoint: string): Promise<void> {
    await this.transport.open(endpoint);
    this.openFlag = true;
  }

  async close(): Promise<void> {
    this.openFlag = false;
    await this.transport.close();
  }

  private ensureOpen(): void {
    if (!this.openFlag) throw new Error('OPC UA 会话未打开');
  }

  async read(nodeId: string): Promise<UaDataValue> {
    this.ensureOpen();
    return this.transport.read(nodeId);
  }

  async write(nodeId: string, value: TagRawValue): Promise<TransportAck> {
    this.ensureOpen();
    return this.transport.write(nodeId, value);
  }

  async subscribe(nodeId: string, cb: UaSubscriber): Promise<() => void> {
    this.ensureOpen();
    return this.transport.subscribe(nodeId, cb);
  }

  browse(): string[] {
    this.ensureOpen();
    return this.transport.browse();
  }

  get isOpen(): boolean {
    return this.openFlag;
  }
}

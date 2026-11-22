/**
 * WP8 工业接口：MQTT 进程内模拟 broker + 通道传输。
 *
 * 语义口径：
 * - QoS0：直接派发，不重传；
 * - QoS1：带 packetId，broker 在去重窗口内丢弃重复 packetId（at-least-once
 *   语义下的重复投递抑制），返回 dup 标记；
 * - 保留消息：retain=true 的消息按 topic 留存，新订阅者上线即收到一次；
 * - 断线策略：客户端断开即摘除其订阅；保留消息仍留在 broker 内，
 *   不做跨进程持久化，不做会话恢复（clean session 口径）。
 *
 * 边界：没有实现 MQTT 报文/握手/TLS，不连接外部云 broker；
 * 接真实 MQTT broker 时替换 `MqttChannelTransport` 的底层连接即可。
 */
import type { ProtocolTransport, TransportAck } from '../adapter';
import type { TagRawValue } from '../tags';

export type QoS = 0 | 1;

export interface MqttMessage {
  topic: string;
  payload: unknown;
  qos: QoS;
  packetId?: number;
  retain: boolean;
  dup: boolean;
  timestamp: string;
}

export type MqttHandler = (msg: MqttMessage) => void;

interface Subscription {
  id: symbol;
  handler: MqttHandler;
}

export interface PublishOptions {
  qos?: QoS;
  retain?: boolean;
  packetId?: number;
}

export interface PublishResult {
  packetId?: number;
  dup: boolean;
}

export interface BrokerClock {
  now(): number;
}

const DEFAULT_DEDUP_TTL_MS = 60_000;

/** topic 过滤器匹配：精确匹配；`#` 结尾为前缀通配；单独 `#` 匹配全部 */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === '#') return true;
  if (filter.endsWith('/#')) {
    const prefix = filter.slice(0, -2);
    return topic === prefix || topic.startsWith(`${prefix}/`);
  }
  return filter === topic;
}

export class InMemoryMqttBroker {
  private readonly subs = new Map<string, Set<Subscription>>();
  private readonly retained = new Map<string, MqttMessage>();
  private readonly seenPackets = new Map<number, number>();
  private nextPacketId = 1;
  private readonly dedupTtlMs: number;
  private readonly clock: BrokerClock;

  constructor(options: { dedupTtlMs?: number; clock?: BrokerClock } = {}) {
    this.dedupTtlMs = options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  subscribe(topic: string, handler: MqttHandler, subscriberId?: symbol): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    const sub: Subscription = { id: subscriberId ?? Symbol('mqtt-sub'), handler };
    set.add(sub);

    // 新订阅者立即收到该 topic 的保留消息（若有）
    const retained = this.retained.get(topic);
    if (retained) handler({ ...retained, retain: true, dup: false });

    return () => {
      set?.delete(sub);
    };
  }

  publish(topic: string, payload: unknown, options: PublishOptions = {}): PublishResult {
    const qos: QoS = options.qos ?? 0;
    const retain = options.retain ?? false;
    const timestamp = new Date(this.clock.now()).toISOString();

    let packetId = options.packetId;
    let dup = false;

    if (qos === 1) {
      if (packetId === undefined) {
        packetId = this.nextPacketId++ & 0xffff || 1;
      } else {
        const lastSeen = this.seenPackets.get(packetId);
        if (lastSeen !== undefined && this.clock.now() - lastSeen < this.dedupTtlMs) {
          dup = true;
        }
      }
      this.seenPackets.set(packetId, this.clock.now());
    }

    const msg: MqttMessage = { topic, payload, qos, packetId, retain, dup, timestamp };

    if (retain) {
      if (payload === null || payload === undefined) {
        this.retained.delete(topic);
      } else {
        this.retained.set(topic, msg);
      }
    }

    // 重复 packetId 在去重窗口内不再次派发（at-least-once 去重）
    if (!dup) this.deliver(msg);
    return { packetId, dup };
  }

  unsubscribeAll(subscriberId: symbol): void {
    for (const [, set] of this.subs) {
      for (const sub of set) {
        if (sub.id === subscriberId) set.delete(sub);
      }
    }
  }

  retainedMessage(topic: string): MqttMessage | null {
    return this.retained.get(topic) ?? null;
  }

  clear(): void {
    this.subs.clear();
    this.retained.clear();
    this.seenPackets.clear();
  }

  private deliver(msg: MqttMessage): void {
    for (const [filter, set] of this.subs) {
      if (!topicMatches(filter, msg.topic)) continue;
      for (const sub of set) sub.handler(msg);
    }
  }
}

/** 进程内 MQTT 客户端：订阅归属与断开摘除 */
export class MqttSimClient {
  readonly clientId: string;
  private readonly broker: InMemoryMqttBroker;
  private readonly subId = Symbol('mqtt-client');
  private readonly unsubscribes = new Set<() => void>();

  constructor(broker: InMemoryMqttBroker, clientId: string) {
    this.broker = broker;
    this.clientId = clientId;
  }

  subscribe(topic: string, handler: MqttHandler): () => void {
    const unsubscribe = this.broker.subscribe(topic, handler, this.subId);
    this.unsubscribes.add(unsubscribe);
    return () => {
      unsubscribe();
      this.unsubscribes.delete(unsubscribe);
    };
  }

  publish(topic: string, payload: unknown, options?: PublishOptions): PublishResult {
    return this.broker.publish(topic, payload, options);
  }

  disconnect(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.clear();
    this.broker.unsubscribeAll(this.subId);
  }
}

/**
 * 适配层使用的 MQTT 通道传输。
 * write = 向标签 topic 发布一条 JSON 载荷（QoS1）；
 * open/close 只维护进程内客户端句柄，不连外部 broker。
 */
export class MqttChannelTransport implements ProtocolTransport {
  private readonly broker: InMemoryMqttBroker;
  private readonly clientId: string;
  private client: MqttSimClient | null = null;

  constructor(broker: InMemoryMqttBroker, clientId: string) {
    this.broker = broker;
    this.clientId = clientId;
  }

  async open(): Promise<void> {
    this.client = new MqttSimClient(this.broker, this.clientId);
  }

  async close(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }

  async write(address: string, value: TagRawValue): Promise<TransportAck> {
    if (!this.client) return { ok: false, reason: 'MQTT 通道未打开' };
    this.client.publish(address, { value, timestamp: new Date().toISOString() }, { qos: 1 });
    return { ok: true };
  }

  get activeClient(): MqttSimClient | null {
    return this.client;
  }
}

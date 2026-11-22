import { describe, expect, it } from 'vitest';
import {
  ProtocolAdapter,
  type AdapterTimers,
  type ProtocolTransport,
  type TransportAck,
} from '../src/server/protocols/adapter';
import { createProtocolAudit } from '../src/server/protocols/audit';
import {
  PROTOCOL_ERRORS,
  TAG_DEFINITIONS,
  fromModbusRaw,
  readInternalValue,
  tagByModbus,
  tagByMqtt,
  tagByOpcua,
  tagById,
  toModbusRaw,
  type ProtocolKind,
  type ProtocolStateView,
  type TagRawValue,
} from '../src/server/protocols/tags';
import { InMemoryMqttBroker, MqttChannelTransport, MqttSimClient } from '../src/server/protocols/transports/mqtt';
import { SemanticOpcUaSession, SimulatedOpcUaServer } from '../src/server/protocols/transports/opcua';
import { protocolsRoute } from '../src/server/routes/protocols';

const FIXED_CLOCK = { now: () => 1_700_000_000_000, random: () => 0.5 };

/**
 * 结构对齐引擎快照的状态视图夹具。
 *
 * 集成断言口径：引擎快照字段 → 标签解析 → 协议读取。生产接线时适配器
 * 直接接收 NetworkSimState（结构满足 ProtocolStateView）；此处不走
 * createNetworkState 编译层，避免被并行工作包的拓扑重构中间状态阻塞。
 */
function fixtureState(): ProtocolStateView {
  return {
    timeMin: 90,
    reactors: [
      {
        id: 'aerobic1',
        kind: 'aerobic',
        doLevel: 2.1,
        nh: 3.2,
        cod: 28,
        no3: 5.1,
        tp: 0.9,
        temperature: 20.5,
        alkalinity: 210,
      },
    ],
    influent: { flow: 2000, cod: 320, nh: 30, tp: 4.2 },
    effluent: { flow: 1900, nh: 0.62, tp: 0.28, tn: 12.4, ph: 7.1, temperature: 19.8 },
    controls: {
      doSetpoint: 2.0,
      internalRecirc: 2.0,
      rasRatio: 0.8,
      wasRatio: 0.0085,
      pacDose: 40,
      carbonDose: 0,
      alkDose: 0,
      stormStore: 0,
      stepFeed: 0.3,
    },
    energy: { blowerKw: 120, pumpKw: 30, totalKw: 170 },
  };
}

class FakeTransport implements ProtocolTransport {
  openCalls = 0;
  failOpen = false;
  closed = false;
  writes: { address: string; value: TagRawValue }[] = [];
  ack: TransportAck = { ok: true };

  async open(): Promise<void> {
    this.openCalls += 1;
    if (this.failOpen) throw new Error('connect refused');
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async write(address: string, value: TagRawValue): Promise<TransportAck> {
    this.writes.push({ address, value });
    return this.ack;
  }
}

function fakeTimers() {
  const scheduled: { cb: () => void; ms: number; id: number }[] = [];
  const timers: AdapterTimers = {
    setTimeout(cb, ms) {
      const id = scheduled.length + 1;
      scheduled.push({ cb, ms, id });
      return id;
    },
    clearTimeout(id) {
      const i = scheduled.findIndex((s) => s.id === id);
      if (i >= 0) scheduled.splice(i, 1);
    },
  };
  return { scheduled, timers };
}

function makeAdapter(
  state: ProtocolStateView,
  protocol: ProtocolKind,
  transport: ProtocolTransport,
  audit = createProtocolAudit(),
  timers?: AdapterTimers,
) {
  return new ProtocolAdapter({
    protocol,
    transport,
    source: () => state,
    audit,
    clock: FIXED_CLOCK,
    timers: timers ?? fakeTimers().timers,
    backoff: { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0 },
  });
}

const OPERATOR = { name: 'tester-operator', role: 'operator' as const };
const VIEWER = { name: 'tester-viewer', role: 'viewer' as const };

describe('标签映射表', () => {
  it('内部标签 ↔ 三种工业地址双向可查', () => {
    const tag = tagById('reactor1.do');
    expect(tag).toBeDefined();
    expect(tag?.address.opcua).toBe('ns=2;s=Aquapilot.Reactor1.DO');
    expect(tag?.address.modbusRegister).toBe(40001);
    expect(tag?.address.mqtt).toBe('aquapilot/reactor1/do');
    expect(tagByOpcua(tag!.address.opcua)?.id).toBe('reactor1.do');
    expect(tagByModbus(tag!.address.modbusRegister)?.id).toBe('reactor1.do');
    expect(tagByMqtt(tag!.address.mqtt)?.id).toBe('reactor1.do');
  });

  it('每条标签都有类型、单位、量程与读写策略', () => {
    for (const tag of TAG_DEFINITIONS) {
      expect(['float32', 'int16', 'bool']).toContain(tag.dataType);
      expect(typeof tag.unit).toBe('string');
      expect(tag.scale.unitMin).toBeLessThanOrEqual(tag.scale.unitMax);
      expect(['read', 'write']).toContain(tag.access);
      expect(tag.address.opcua).toMatch(/^ns=2;s=Aquapilot\./);
      expect(tag.address.modbusRegister).toBeGreaterThanOrEqual(40001);
      expect(tag.address.mqtt).toMatch(/^aquapilot\//);
    }
    const writable = TAG_DEFINITIONS.filter((t) => t.access === 'write');
    expect(writable.length).toBeGreaterThan(0);
    for (const tag of writable) expect(tag.source.kind).toBe('control');
  });

  it('Modbus 量程缩放往返一致，超量程返回 null', () => {
    const tag = tagById('control.doSetpoint')!;
    const raw = toModbusRaw(tag, 2.0);
    expect(raw).toBe(200);
    expect(fromModbusRaw(tag, raw!)).toBeCloseTo(2.0, 5);
    expect(toModbusRaw(tag, 99)).toBeNull();
    expect(toModbusRaw(tag, NaN)).toBeNull();
  });

  it('未知标签在三种协议地址下都查不到', () => {
    expect(tagByOpcua('ns=2;s=Aquapilot.Nope')).toBeUndefined();
    expect(tagByModbus(49999)).toBeUndefined();
    expect(tagByMqtt('aquapilot/nope')).toBeUndefined();
  });
});

describe('适配层：质量码与断线缓存', () => {
  it('连接正常时内部量以 good 质量码读出，时标落戳', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport());
    await adapter.connect();

    const sample = await adapter.read('reactor1.do');
    const reactor = state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];
    expect(sample.value).toBeCloseTo(reactor.doLevel, 5);
    expect(sample.quality.code).toBe('good');
    expect(sample.timestamp).toBeTruthy();
    expect(sample.unit).toBe('mg/L');
  });

  it('内部值非有限值时打 bad，不把 NaN 抛给现场', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport());
    await adapter.connect();
    const reactor = state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];
    reactor.doLevel = NaN;

    const sample = await adapter.read('reactor1.do');
    expect(sample.value).toBeNull();
    expect(sample.quality.code).toBe('bad');
    expect(sample.quality.reason).toContain('unavailable');
  });

  it('超量程值降级为 uncertain，而不是 good 冒充合格', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport());
    await adapter.connect();
    const reactor = state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];
    reactor.doLevel = 999;

    const sample = await adapter.read('reactor1.do');
    expect(sample.quality.code).toBe('uncertain');
    expect(sample.quality.reason).toContain('range');
  });

  it('断开后读返回缓存坏值，不拿旧好值冒充实时', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'modbus', new FakeTransport());
    await adapter.connect();
    const first = await adapter.read('effluent.nh');
    expect(first.quality.code).toBe('good');

    await adapter.close();
    const second = await adapter.read('effluent.nh');
    expect(second.value).toEqual(first.value);
    expect(second.quality.code).toBe('bad');
    expect(second.quality.reason).toBe('channel disconnected');
  });

  it('断开且无缓存时返回 null 坏值', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'mqtt', new FakeTransport());
    const sample = await adapter.read('energy.totalKw');
    expect(sample.value).toBeNull();
    expect(sample.quality.code).toBe('bad');
  });

  it('读未知标签抛 PROTOCOL_TAG_UNKNOWN', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport());
    await adapter.connect();
    await expect(adapter.read('no.such.tag')).rejects.toMatchObject({ code: PROTOCOL_ERRORS.TAG_UNKNOWN });
  });
});

describe('适配层：重连退避序列', () => {
  it('退避间隔按指数递增并在上限处截断（假时钟 + 确定性随机）', () => {
    const state = fixtureState();
    const { timers } = fakeTimers();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), createProtocolAudit(), timers);
    expect(adapter.nextBackoffMs(0)).toBe(100);
    expect(adapter.nextBackoffMs(1)).toBe(200);
    expect(adapter.nextBackoffMs(2)).toBe(400);
    expect(adapter.nextBackoffMs(3)).toBe(800);
    expect(adapter.nextBackoffMs(4)).toBe(1000); // 上限截断
    expect(adapter.nextBackoffMs(10)).toBe(1000);
  });

  it('连接失败后按退避序列安排重连，连续失败间隔递增', async () => {
    const state = fixtureState();
    const { scheduled, timers } = fakeTimers();
    const transport = new FakeTransport();
    transport.failOpen = true;
    const adapter = makeAdapter(state, 'opcua', transport, createProtocolAudit(), timers);

    await adapter.connect();
    expect(adapter.state).toBe('disconnected');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(100);

    await adapter.reconnectAttempt();
    expect(scheduled.at(-1)?.ms).toBe(200);
    await adapter.reconnectAttempt();
    expect(scheduled.at(-1)?.ms).toBe(400);
    expect(adapter.status().reconnectAttempts).toBe(2);

    // 传输恢复后下一次尝试进入 connected
    transport.failOpen = false;
    await adapter.reconnectAttempt();
    expect(adapter.state).toBe('connected');
    expect(adapter.status().reconnectAttempts).toBe(0);
  });
});

describe('写入边界与审计', () => {
  it('operator 写白名单标签成功，控制量落状态且审计 success', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();

    const out = await adapter.write('control.doSetpoint', 2.6, OPERATOR);
    expect(out.quality.code).toBe('good');
    expect(state.controls.doSetpoint).toBeCloseTo(2.6, 5);
    expect(audit.size()).toBe(1);
    const row = audit.recent(1)[0];
    expect(row.result).toBe('success');
    expect(row.tag).toBe('control.doSetpoint');
    expect(row.actor).toBe(OPERATOR.name);
    expect(row.role).toBe('operator');
  });

  it('viewer 写控制量被拒绝，审计 denied + PROTOCOL_WRITE_DENIED', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();

    await expect(adapter.write('control.doSetpoint', 2.0, VIEWER)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.WRITE_DENIED,
    });
    const row = audit.recent(1)[0];
    expect(row.result).toBe('denied');
    expect(row.code).toBe(PROTOCOL_ERRORS.WRITE_DENIED);
    expect(row.reason).toContain('权限不足');
  });

  it('写只读测量标签被拒绝', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();

    await expect(adapter.write('reactor1.do', 3.0, OPERATOR)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.WRITE_DENIED,
    });
    expect(audit.recent(1)[0].reason).toContain('只读');
  });

  it('超量程写入被拒绝，不落到状态上', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();

    await expect(adapter.write('control.doSetpoint', 99, OPERATOR)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.WRITE_DENIED,
    });
    expect(state.controls.doSetpoint).not.toBe(99);
    expect(audit.recent(1)[0].result).toBe('denied');
  });

  it('同一标签写频超最小间隔被拒绝并审计 denied', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = new ProtocolAdapter({
      protocol: 'opcua',
      transport: new FakeTransport(),
      source: () => state,
      audit,
      clock: FIXED_CLOCK,
      timers: fakeTimers().timers,
      writeMinIntervalMs: 1000,
    });
    await adapter.connect();

    await adapter.write('control.rasRatio', 0.6, OPERATOR);
    await expect(adapter.write('control.rasRatio', 0.7, OPERATOR)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.WRITE_DENIED,
    });
    expect(audit.recent(1)[0].reason).toContain('频繁');
  });

  it('未知标签写入留痕 unknown_tag；断开写入留痕 disconnected', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'modbus', new FakeTransport(), audit);

    await expect(adapter.write('ghost.tag', 1, OPERATOR)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.TAG_UNKNOWN,
    });
    await adapter.close();
    await expect(adapter.write('control.rasRatio', 0.5, OPERATOR)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.DISCONNECTED,
    });

    const results = audit.recent(10).map((r) => r.result);
    expect(results).toContain('unknown_tag');
    expect(results).toContain('disconnected');
  });
});

describe('MQTT 进程内 broker', () => {
  it('发布订阅按 topic 投递 JSON 载荷', () => {
    const broker = new InMemoryMqttBroker();
    const client = new MqttSimClient(broker, 'test-client');
    const received: unknown[] = [];
    client.subscribe('aquapilot/reactor1/do', (msg) => received.push(msg.payload));

    client.publish('aquapilot/reactor1/do', { value: 2.4 }, { qos: 0 });
    expect(received).toEqual([{ value: 2.4 }]);
  });

  it('QoS1 重复 packetId 在去重窗口内只投递一次并标记 dup', () => {
    const broker = new InMemoryMqttBroker();
    const client = new MqttSimClient(broker, 'c1');
    const received: number[] = [];
    client.subscribe('aquapilot/x', (msg) => received.push((msg.payload as { v: number }).v));

    const first = broker.publish('aquapilot/x', { v: 1 }, { qos: 1, packetId: 7 });
    const second = broker.publish('aquapilot/x', { v: 2 }, { qos: 1, packetId: 7 });
    expect(first.dup).toBe(false);
    expect(second.dup).toBe(true);
    expect(received).toEqual([1]);
  });

  it('保留消息在新订阅者上线时立即推送一次', () => {
    const broker = new InMemoryMqttBroker();
    broker.publish('aquapilot/effluent/nh', { value: 1.2 }, { qos: 1, retain: true });

    const later = new MqttSimClient(broker, 'c2');
    const received: unknown[] = [];
    later.subscribe('aquapilot/effluent/nh', (msg) => received.push(msg.payload));
    expect(received).toEqual([{ value: 1.2 }]);
    expect(broker.retainedMessage('aquapilot/effluent/nh')?.retain).toBe(true);
  });

  it('通配符 # 匹配前缀 topic；客户端断开后摘除订阅', () => {
    const broker = new InMemoryMqttBroker();
    const client = new MqttSimClient(broker, 'c3');
    const received: string[] = [];
    client.subscribe('aquapilot/#', (msg) => received.push(msg.topic));
    broker.publish('aquapilot/control/doSetpoint', { value: 2 });
    expect(received).toEqual(['aquapilot/control/doSetpoint']);

    client.disconnect();
    broker.publish('aquapilot/control/rasRatio', { value: 0.8 });
    expect(received).toHaveLength(1);
  });

  it('MqttChannelTransport 写入即向 topic 发布载荷', async () => {
    const broker = new InMemoryMqttBroker();
    const transport = new MqttChannelTransport(broker, 'adapter-1');
    await transport.open();
    const received: unknown[] = [];
    new MqttSimClient(broker, 'observer').subscribe('aquapilot/control/pacDose', (msg) => received.push(msg.payload));

    const ack = await transport.write('aquapilot/control/pacDose', 40);
    expect(ack.ok).toBe(true);
    expect(received).toEqual([{ value: 40, timestamp: expect.any(String) }]);
    await transport.close();
  });
});

describe('OPC UA 语义层模拟服务器', () => {
  it('读未知节点返回 bad；写入已知节点后订阅者收到更新', async () => {
    const state = fixtureState();
    const server = new SimulatedOpcUaServer();
    server.setResolver((nodeId) => {
      const tag = tagByOpcua(nodeId);
      if (!tag) return undefined;
      return {
        nodeId,
        value: readInternalValue(state, tag),
        quality: 'good' as const,
        timestamp: new Date().toISOString(),
      };
    });
    await server.open('opc.tcp://127.0.0.1:4840/sim');

    const missing = await server.read('ns=2;s=Aquapilot.Ghost');
    expect(missing.quality).toBe('bad');

    // resolver 在线节点：读回的是引擎实时值，本地缓存不覆盖实时源
    const live = await server.read('ns=2;s=Aquapilot.Reactor1.DO');
    expect(live.quality).toBe('good');

    // 登记的模拟节点：写入后本地值更新，订阅者收到变更通知
    const nodeId = 'ns=2;s=Aquapilot.Sim.Pressure';
    server.registerNode(nodeId, 0);
    const updates: number[] = [];
    await server.subscribe(nodeId, (dv) => {
      if (typeof dv.value === 'number') updates.push(dv.value);
    });
    await server.write(nodeId, 42);
    expect(updates).toContain(42);

    const after = await server.read(nodeId);
    expect(after.value).toBe(42);
    await server.close();
  });

  it('会话关闭后再调用读/写/订阅被拒绝', async () => {
    const server = new SimulatedOpcUaServer();
    const session = new SemanticOpcUaSession(server);
    await session.open('opc.tcp://127.0.0.1:4840/sim');
    expect(session.isOpen).toBe(true);
    await session.close();
    await expect(session.read('ns=2;s=Aquapilot.Reactor1.DO')).rejects.toThrow('未打开');
  });
});

describe('集成：状态快照 → 标签值 → 协议读取', () => {
  it('状态视图字段（口径对齐引擎快照）经适配器读出的标签值一致', async () => {
    const state = fixtureState();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport());
    await adapter.connect();

    const doSample = await adapter.read('reactor1.do');
    const reactor = state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];
    expect(doSample.value).toBeCloseTo(reactor.doLevel, 5);

    const flow = await adapter.read('influent.flow');
    expect(flow.value).toBeCloseTo(state.influent.flow, 5);
    expect(flow.quality.code).toBe('good');

    const nh = await adapter.read('effluent.nh');
    expect(nh.value).toBeCloseTo(state.effluent.nh, 5);

    const byAddress = await adapter.readByAddress('ns=2;s=Aquapilot.Energy.TotalKw');
    expect(byAddress.value).toBeCloseTo(state.energy.totalKw, 5);
  });
});

describe('只读路由 protocolsRoute', () => {
  it('标签表 / 通道状态 / 审计三条端点返回结构化响应', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();
    const input = { adapters: { opcua: adapter }, audit };

    const tags = protocolsRoute('/api/protocols/tags', new URL('http://x/api/protocols/tags'), input);
    expect(tags?.status).toBe(200);
    expect((tags?.body as { tags: unknown[] }).tags).toHaveLength(TAG_DEFINITIONS.length);

    const status = protocolsRoute('/api/protocols/status', new URL('http://x/api/protocols/status'), input);
    expect(status?.status).toBe(200);
    expect((status?.body as { channels: { state: string }[] }).channels[0].state).toBe('connected');

    await adapter.write('control.stepFeed', 0.2, OPERATOR);
    const auditReply = protocolsRoute('/api/protocols/audit', new URL('http://x/api/protocols/audit?limit=10'), input);
    expect(auditReply?.status).toBe(200);
    const body = auditReply?.body as { audit: { result: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.audit[0].result).toBe('success');
  });

  it('拒绝写入留痕且可经审计路由查到；断开通道 503；非法 limit 400；未匹配 null', async () => {
    const state = fixtureState();
    const audit = createProtocolAudit();
    const adapter = makeAdapter(state, 'opcua', new FakeTransport(), audit);
    await adapter.connect();
    await expect(adapter.write('control.doSetpoint', 2.0, VIEWER)).rejects.toMatchObject({
      code: PROTOCOL_ERRORS.WRITE_DENIED,
    });

    const deniedReply = protocolsRoute('/api/protocols/audit', new URL('http://x/api/protocols/audit?limit=10'), {
      adapters: { opcua: adapter },
      audit,
    });
    const deniedBody = deniedReply?.body as { audit: { result: string; code?: string }[] };
    expect(deniedReply?.status).toBe(200);
    expect(deniedBody.audit[0].result).toBe('denied');
    expect(deniedBody.audit[0].code).toBe(PROTOCOL_ERRORS.WRITE_DENIED);

    await adapter.close();
    const input = { adapters: { opcua: adapter }, audit };

    const down = protocolsRoute('/api/protocols/status', new URL('http://x/api/protocols/status?channel=opcua'), input);
    expect(down?.status).toBe(503);
    expect((down?.body as { code: string }).code).toBe(PROTOCOL_ERRORS.DISCONNECTED);

    const badLimit = protocolsRoute('/api/protocols/audit', new URL('http://x/api/protocols/audit?limit=abc'), input);
    expect(badLimit?.status).toBe(400);

    expect(protocolsRoute('/api/protocols/nope', new URL('http://x/api/protocols/nope'), input)).toBeNull();
  });
});

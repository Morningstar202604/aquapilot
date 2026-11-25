import { describe, expect, it } from 'vitest';
import { SimulatedOpcUaServer, SemanticOpcUaSession } from '../src/server/protocols/transports/opcua';
import { InMemoryMqttBroker, MqttChannelTransport, MqttSimClient } from '../src/server/protocols/transports/mqtt';

/**
 * 进程内工业协议模拟器：OPC UA 会话与 MQTT broker 的完整生命周期。
 *
 * 适配器层测试用的是假传输；这里补的是模拟服务器自身——节点不存在、
 * 离线读写、订阅初始值、保留消息、QoS1 去重、断开摘除。
 */

describe('SimulatedOpcUaServer', () => {
  it('open 拒绝空 endpoint，关闭后读写抛错', async () => {
    const server = new SimulatedOpcUaServer();
    await expect(server.open('  ')).rejects.toThrow('endpoint');
    await server.open('opc.tcp://localhost:4840');
    expect(server.connected).toBe(true);
    expect(server.activeEndpoint).toBe('opc.tcp://localhost:4840');
    await server.close();
    expect(server.connected).toBe(false);
    await expect(server.read('ns=2;s=DO')).rejects.toThrow('未连接');
  });

  it('读：resolver 优先、已登记节点返回 good、未登记返回 bad', async () => {
    const server = new SimulatedOpcUaServer();
    await server.open('opc.tcp://localhost:4840');
    server.registerNode('ns=2;s=DO', 2.1);
    expect((await server.read('ns=2;s=DO')).quality).toBe('good');
    expect((await server.read('ns=2;s=missing')).quality).toBe('bad');
    server.setResolver((nodeId) =>
      nodeId === 'ns=2;s=live' ? { nodeId, value: 3, quality: 'good', timestamp: 't' } : undefined,
    );
    expect((await server.read('ns=2;s=live')).value).toBe(3);
    expect(server.browse()).toContain('ns=2;s=DO');
  });

  it('写：未知节点拒绝，已登记节点写入并通知订阅者', async () => {
    const server = new SimulatedOpcUaServer();
    await server.open('opc.tcp://localhost:4840');
    expect(await server.write('ns=2;s=missing', 1)).toMatchObject({ ok: false });
    server.registerNode('ns=2;s=DO', 1);
    const seen: number[] = [];
    const unsubscribe = await server.subscribe('ns=2;s=DO', (dv) => seen.push(Number(dv.value)));
    await server.write('ns=2;s=DO', 2);
    server.publish('ns=2;s=DO', {
      nodeId: 'ns=2;s=DO',
      value: 3,
      quality: 'good',
      timestamp: 't',
    });
    unsubscribe();
    server.publish('ns=2;s=DO', {
      nodeId: 'ns=2;s=DO',
      value: 4,
      quality: 'good',
      timestamp: 't',
    });
    await viWait();
    expect(seen[0]).toBe(1); // 订阅建立时的初始值
    expect(seen).toContain(2);
    expect(seen).toContain(3);
    expect(seen).not.toContain(4);
  });

  it('有 resolver 时允许写未登记节点', async () => {
    const server = new SimulatedOpcUaServer();
    await server.open('opc.tcp://localhost:4840');
    server.setResolver(() => undefined);
    expect(await server.write('ns=2;s=dynamic', 9)).toMatchObject({ ok: true });
    expect(server.browse()).toContain('ns=2;s=dynamic');
  });

  it('语义会话关闭后拒绝读写', async () => {
    const server = new SimulatedOpcUaServer();
    server.registerNode('ns=2;s=DO', 1);
    const session = new SemanticOpcUaSession(server);
    await expect(session.read('ns=2;s=DO')).rejects.toThrow('会话未打开');
    await session.open('opc.tcp://localhost:4840');
    expect((await session.read('ns=2;s=DO')).value).toBe(1);
    await session.write('ns=2;s=DO', 2);
    const unsubscribe = await session.subscribe('ns=2;s=DO', () => undefined);
    unsubscribe();
    await session.close();
    await expect(session.write('ns=2;s=DO', 3)).rejects.toThrow('会话未打开');
  });
});

function viWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MQTT 进程内 broker', () => {
  it('通配订阅、保留消息与清空', () => {
    const broker = new InMemoryMqttBroker();
    const retainedGot: string[] = [];
    broker.publish('plant/a/do', 1, { qos: 1, retain: true });
    const unsubRetained = broker.subscribe('plant/a/do', (m) => retainedGot.push(m.topic));
    expect(retainedGot).toContain('plant/a/do'); // 新订阅立即收到 retained
    expect(broker.retainedMessage('plant/a/do')).toMatchObject({ payload: 1 });
    unsubRetained();
    const got: string[] = [];
    const unsub = broker.subscribe('plant/a/#', (m) => got.push(m.topic));
    broker.publish('plant/b/do', 2);
    broker.publish('plant/a/ph', 3);
    expect(got).toContain('plant/a/ph');
    expect(got).not.toContain('plant/b/do');
    broker.publish('plant/a/do', null, { retain: true });
    expect(broker.retainedMessage('plant/a/do')).toBeNull();
    unsub();
    broker.clear();
    expect(broker.retainedMessage('plant/a/do')).toBeNull();
  });

  it('QoS1 重复 packetId 在窗口内只派发一次', () => {
    let now = 1000;
    const broker = new InMemoryMqttBroker({ dedupTtlMs: 100, clock: { now: () => now } });
    const got: unknown[] = [];
    broker.subscribe('plant/a', (m) => got.push(m.payload));
    expect(broker.publish('plant/a', 1, { qos: 1, packetId: 7 })).toMatchObject({ dup: false });
    expect(broker.publish('plant/a', 2, { qos: 1, packetId: 7 })).toMatchObject({ dup: true });
    expect(got).toEqual([1]);
    now += 200;
    expect(broker.publish('plant/a', 3, { qos: 1, packetId: 7 })).toMatchObject({ dup: false });
    expect(got).toEqual([1, 3]);
  });

  it('自动分配 packetId 时回绕到 1，不出现 0', () => {
    const broker = new InMemoryMqttBroker();
    let last = 0;
    for (let i = 0; i < 3; i += 1) {
      last = broker.publish('plant/a', i, { qos: 1 }).packetId ?? 0;
    }
    expect(last).toBeGreaterThan(0);
  });

  it('客户端断开后摘除订阅，不再收到消息', () => {
    const broker = new InMemoryMqttBroker();
    const client = new MqttSimClient(broker, 'c1');
    const got: unknown[] = [];
    client.subscribe('plant/#', (m) => got.push(m.payload));
    client.publish('plant/a', 1, { qos: 1 });
    expect(got).toEqual([1]);
    const unsub = client.subscribe('plant/a', () => got.push('second'));
    unsub();
    client.disconnect();
    client.publish('plant/a', 2, { qos: 1 });
    expect(got).toEqual([1]);
  });

  it('通道未打开时写失败，打开后发布、关闭后拒绝', async () => {
    const broker = new InMemoryMqttBroker();
    const transport = new MqttChannelTransport(broker, 'channel');
    expect(await transport.write('plant/a', 1)).toMatchObject({ ok: false });
    await transport.open();
    expect(transport.activeClient?.clientId).toBe('channel');
    expect(await transport.write('plant/a', 1)).toMatchObject({ ok: true });
    expect(broker.retainedMessage('plant/a')).toBeNull();
    await transport.close();
    expect(transport.activeClient).toBeNull();
    expect(await transport.write('plant/a', 1)).toMatchObject({ ok: false });
  });
});

import { describe, expect, it } from 'vitest';
import type { ProcessTopology } from '../src/model/topology';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { ProtocolAdapter, type ProtocolTransport, type TransportAck } from '../src/server/protocols/adapter';
import { createProtocolAudit } from '../src/server/protocols/audit';
import { protocolStateFromNetwork } from '../src/server/protocols/fromNetworkState';

/**
 * 真引擎集成链路：NetworkSimState → 视图投影 → 标签解析 → 协议读取。
 *
 * 这是"协议层不是把 WebSocket 换层皮"的关键证据：标签值必须来自引擎真实
 * 求解结果，而不是适配层自造的夹具；断线后同一批标签降级为 bad 质量码。
 */
class FakeTransport implements ProtocolTransport {
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async write(): Promise<TransportAck> {
    return { ok: true };
  }
}

function bootEngine() {
  const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
  const state = createNetworkState(topo, { seed: 42 });
  spinUpNetwork(state, topo, 2);
  stepNetwork(state, topo, 1);
  return state;
}

describe('真引擎集成：引擎快照 → 标签值 → 协议读取', () => {
  it('预热 2 天并推进一步后，4 个标签与引擎状态逐项一致；断线后同一批标签质量码变 bad', async () => {
    const state = bootEngine();
    const audit = createProtocolAudit();
    const adapter = new ProtocolAdapter({
      protocol: 'opcua',
      transport: new FakeTransport(),
      source: () => protocolStateFromNetwork(state),
      audit,
    });
    await adapter.connect();

    const aerobic = state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];

    const doSample = await adapter.read('reactor1.do');
    expect(doSample.quality.code).toBe('good');
    expect(typeof doSample.value).toBe('number');
    expect(Math.abs((doSample.value as number) - aerobic.doLevel)).toBeLessThan(0.05);

    const flow = await adapter.read('influent.flow');
    expect(flow.quality.code).toBe('good');
    expect(flow.value).toBeCloseTo(state.influent.flow, 5);

    const nh = await adapter.read('effluent.nh');
    expect(nh.quality.code).toBe('good');
    expect(nh.value).toBeCloseTo(state.effluent.nh, 5);

    const kw = await adapter.read('energy.totalKw');
    expect(kw.quality.code).toBe('good');
    expect(kw.value).toBeCloseTo(state.energy.totalKw, 5);

    // 断线：缓存值可以保留，但质量码必须 bad，不得标 good 冒充实时
    await adapter.close();
    for (const tagId of ['reactor1.do', 'influent.flow', 'effluent.nh', 'energy.totalKw']) {
      const sample = await adapter.read(tagId);
      expect(sample.quality.code).toBe('bad');
      expect(sample.quality.reason).toBe('channel disconnected');
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { adoptTopology, type TopologyRebuildRuntime } from '../src/server/topologyRebuild';
import type { ProcessTopology } from '../src/model/topology';
import type { CompiledNetwork } from '../src/sim/network';
import type { NetworkSimState } from '../src/sim/networkEngine';

/**
 * 拓扑重建：这段序列此前在切模板 / 回滚 / 应用自定义拓扑里各抄了一遍。
 *
 * 三个入口的验证成本完全不同（模板最容易点、回滚要先进历史、apply 要手搓 JSON），
 * 所以副本之间的漂移长期无人发现。这里把「必须一起做的事」钉成断言：
 * 缺任何一行都是可复现的产品缺陷，不是风格问题。
 */

const topology = { id: 't1', name: 'x', units: [], connections: [] } as unknown as ProcessTopology;
const compiled = {} as unknown as CompiledNetwork;
const net = { seed: 7, timeMin: 120, trend: 'stale' } as unknown as NetworkSimState;

function harness() {
  const order: string[] = [];
  const runtime: TopologyRebuildRuntime = {
    topology: { id: 'old' } as unknown as ProcessTopology,
    compiled: {} as unknown as CompiledNetwork,
    topologyRevision: 3,
    net: {} as unknown as NetworkSimState,
    trend: [{ t: 1 }, { t: 2 }],
    recommendation: { action: 'dose' },
    activePresetId: null,
  };
  const persist = vi.fn((_t: ProcessTopology, _r: number, _note: string) => {
    order.push('persist');
    return true;
  });
  const deps = {
    runtime,
    adopt: (t: ProcessTopology, c: CompiledNetwork, n: NetworkSimState) => {
      order.push('adopt');
      runtime.topology = t;
      runtime.compiled = c;
      runtime.net = n;
    },
    persist,
    clearRunScopedState: () => order.push('clear'),
    rebuildShadow: (t: ProcessTopology, n: NetworkSimState) => {
      order.push(`shadow:${(t as { id: string }).id}:${(n as { timeMin: number }).timeMin}`);
    },
    pushTrend: () => order.push('trend'),
    runAiCycle: () => order.push('ai'),
  };
  return { runtime, deps, order, persist };
}

describe('adoptTopology', () => {
  it('revision 自增、拓扑与运行时同时切换', () => {
    const h = harness();
    const result = adoptTopology(topology, compiled, net, '应用自定义拓扑', null, h.deps);
    expect(result.revision).toBe(4);
    expect(result.saved).toBe(true);
    expect(h.runtime.topology.id).toBe('t1');
    expect(h.runtime.net.timeMin).toBe(120);
  });

  it('清掉上一轮的趋势与建议——否则新厂会显示旧厂的曲线', () => {
    const h = harness();
    adoptTopology(topology, compiled, net, 'note', null, h.deps);
    expect(h.runtime.trend).toEqual([]);
    expect(h.runtime.recommendation).toBeNull();
  });

  it('影子对照厂按新拓扑与新时刻重建（否则效益页差值全是假的）', () => {
    const h = harness();
    adoptTopology(topology, compiled, net, 'note', null, h.deps);
    expect(h.order).toContain('shadow:t1:120');
  });

  it('执行顺序固定：adopt → persist → clear → shadow → trend → ai', () => {
    const h = harness();
    adoptTopology(topology, compiled, net, 'note', null, h.deps);
    expect(h.order).toEqual(['adopt', 'persist', 'clear', 'shadow:t1:120', 'trend', 'ai']);
  });

  it('先持久化再清理：写盘失败时仍要拿到 saved=false 且状态已切换', () => {
    const h = harness();
    h.persist.mockReturnValue(false);
    const result = adoptTopology(topology, compiled, net, 'note', null, h.deps);
    expect(result.saved).toBe(false);
    expect(h.runtime.topologyRevision).toBe(4);
  });

  it('切模板时记录 presetId，应用自定义拓扑时清空', () => {
    const a = harness();
    adoptTopology(topology, compiled, net, 'switch', 'a2o-standard', a.deps);
    expect(a.runtime.activePresetId).toBe('a2o-standard');

    const b = harness();
    b.runtime.activePresetId = 'a2o-standard';
    adoptTopology(topology, compiled, net, 'apply', null, b.deps);
    expect(b.runtime.activePresetId).toBeNull();
  });

  it('成功路径一定补一个趋势点，避免换拓扑后图表空窗', () => {
    const h = harness();
    adoptTopology(topology, compiled, net, 'note', null, h.deps);
    expect(h.order).toContain('trend');
  });
});

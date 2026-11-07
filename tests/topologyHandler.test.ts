import { describe, expect, it, vi } from 'vitest';
import { handleTopologyMessage, type TopologyHandlerDeps } from '../src/server/topologyHandler';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol';

/**
 * 拓扑消息处理器。
 *
 * 这段逻辑此前埋在 index.ts 的 800 行 switch 里，只能通过起服务 + 发 WS 验证。
 * 抽出来后可以逐分支锁住「拒绝路径必须说明原因」与「成功路径必须广播」——
 * 前者是用户能看到的唯一线索（否则点一下没反应），后者漏了界面就停在旧拓扑。
 */

type TopologyMsg = Extract<ClientMessage, { type: 'topology' }>;

function harness(overrides: Partial<TopologyHandlerDeps> = {}) {
  const sent: ServerMessage[] = [];
  const broadcasted: ServerMessage[] = [];
  let snapshotCount = 0;
  const socket = { send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage) };
  let throttled = false;
  const deps: TopologyHandlerDeps = {
    runtime: {
      topology: PLANT_TOPOLOGY,
      compiled: {} as never,
      net: {} as never,
      topologyRevision: 3,
    },
    topologyMessage: () => ({
      type: 'topology',
      data: PLANT_TOPOLOGY,
      dirty: false,
      readiness: {
        ready: true,
        blockers: [],
        warnings: [],
        derived: { trainUnits: 0, bioVolume: 0, hrtHours: 0, aerobicVolume: 0 },
      },
    }),
    history: () => [{ revision: 1, savedAt: 'x', label: 'init', name: '测试厂', units: 17, connections: 23 }],
    versionAt: (rev) => (rev === 2 ? PLANT_TOPOLOGY : null),
    throttled: () => throttled,
    send: (_ws, message) => sent.push(message),
    broadcast: (message) => broadcasted.push(message),
    broadcastSnapshot: () => {
      snapshotCount += 1;
    },
    adopt: vi.fn(() => ({ saved: true, revision: 4 })),
    onInvalid: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    socket,
    sent,
    broadcasted,
    snapshotCount: () => snapshotCount,
    setThrottled: (v: boolean) => {
      throttled = v;
    },
  };
}

describe('topology · get / history', () => {
  it('get 回传当前拓扑与 readiness', () => {
    const h = harness();
    expect(handleTopologyMessage(h.socket, { type: 'topology', action: 'get' } as TopologyMsg, h.deps)).toBe(true);
    expect(h.sent[0].type).toBe('topology');
  });

  it('history 回传版本列表并带回 requestId', () => {
    const h = harness();
    handleTopologyMessage(h.socket, { type: 'topology', action: 'history', requestId: 'r1' } as TopologyMsg, h.deps);
    const msg = h.sent[0] as Extract<ServerMessage, { type: 'topologyHistory' }>;
    expect(msg.type).toBe('topologyHistory');
    expect(msg.requestId).toBe('r1');
    expect(msg.versions).toHaveLength(1);
  });
});

describe('topology · revert', () => {
  it('限流时给出明确提示且不改状态', () => {
    const h = harness();
    h.setThrottled(true);
    handleTopologyMessage(h.socket, { type: 'topology', action: 'revert', revision: 2 } as TopologyMsg, h.deps);
    const msg = h.sent[0] as Extract<ServerMessage, { type: 'notice' }>;
    expect(msg.text).toContain('过于频繁');
    expect(h.deps.adopt).not.toHaveBeenCalled();
  });

  it('revision 非数字被拒', () => {
    const h = harness();
    handleTopologyMessage(
      h.socket,
      { type: 'topology', action: 'revert', revision: 'x' } as unknown as TopologyMsg,
      h.deps,
    );
    expect((h.sent[0] as Extract<ServerMessage, { type: 'notice' }>).text).toContain('不合法');
  });

  it('找不到该版本时说明是第几版', () => {
    const h = harness();
    handleTopologyMessage(h.socket, { type: 'topology', action: 'revert', revision: 99 } as TopologyMsg, h.deps);
    expect((h.sent[0] as Extract<ServerMessage, { type: 'notice' }>).text).toContain('99');
  });

  it('成功回滚：创建新 revision（不复用旧号）并广播', () => {
    const h = harness();
    handleTopologyMessage(h.socket, { type: 'topology', action: 'revert', revision: 2 } as TopologyMsg, h.deps);
    expect(h.deps.adopt).toHaveBeenCalledWith(PLANT_TOPOLOGY, expect.anything(), expect.anything(), '回滚到 v2', null);
    const texts = h.broadcasted.map((m) => (m as { text?: string }).text ?? '');
    expect(texts.some((t) => t.includes('第 4 版'))).toBe(true);
    expect(h.snapshotCount()).toBe(1);
    expect(h.sent.some((m) => m.type === 'topologyHistory')).toBe(true);
  });

  it('写盘失败时提示会回退，不假装已保存', () => {
    const h = harness({ adopt: vi.fn(() => ({ saved: false, revision: 4 })) });
    handleTopologyMessage(h.socket, { type: 'topology', action: 'revert', revision: 2 } as TopologyMsg, h.deps);
    const texts = h.broadcasted.map((m) => (m as { text?: string }).text ?? '');
    expect(texts.some((t) => t.includes('写盘失败'))).toBe(true);
  });
});

describe('topology · apply', () => {
  it('非法结构被拒且计入指标', () => {
    const h = harness();
    handleTopologyMessage(
      h.socket,
      { type: 'topology', action: 'apply', topology: { units: [null] } } as unknown as TopologyMsg,
      h.deps,
    );
    expect(h.deps.onInvalid).toHaveBeenCalled();
    expect(h.deps.adopt).not.toHaveBeenCalled();
    expect((h.sent[0] as Extract<ServerMessage, { type: 'notice' }>).text).toContain('不合法');
  });

  it('合法拓扑被采纳并广播新拓扑与快照', () => {
    const h = harness();
    handleTopologyMessage(
      h.socket,
      { type: 'topology', action: 'apply', topology: JSON.parse(JSON.stringify(PLANT_TOPOLOGY)) } as TopologyMsg,
      h.deps,
    );
    expect(h.deps.adopt).toHaveBeenCalled();
    expect(h.broadcasted.some((m) => m.type === 'topology')).toBe(true);
    expect(h.snapshotCount()).toBe(1);
  });

  it('未知 action 交回调用方，不静默吞掉', () => {
    const h = harness();
    const handled = handleTopologyMessage(
      h.socket,
      { type: 'topology', action: 'nope' } as unknown as TopologyMsg,
      h.deps,
    );
    expect(handled).toBe(false);
  });
});

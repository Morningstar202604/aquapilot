import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { ProcessTopology } from '../model/topology';
import { sanitizeTopologyInput } from '../model/topologyInput';
import { applyTopology, checkRunReadiness } from './topologyRuntime';
import type { CompiledNetwork } from '../sim/network';
import type { NetworkSimState } from '../sim/networkEngine';

/**
 * 拓扑消息处理器（get / history / revert / apply）。
 *
 * 从 server/index.ts 的 800 行 switch 里抽出。这段代码此前有一个反复出现的
 * 缺陷模式：三条入口（切模板 / 回滚 / 应用自定义）各自做完 applyTopology 后
 * 都手抄一遍「重建 + 清状态 + 广播」，漏一行就是一类真实 bug。
 * 重建序列已收进 topologyRebuild.ts；这里只保留各自的**前置校验与文案**，
 * 它们本来就是不同的（回滚要查历史版本、apply 要过 sanitize）。
 *
 * 处理器不碰全局 runtime：所有状态读写通过注入的 `deps` 完成，
 * 因此可以脱离 WebSocket 服务单测。
 */

export interface TopologyHandlerRuntime {
  topology: ProcessTopology;
  compiled: CompiledNetwork;
  net: NetworkSimState;
  topologyRevision: number;
}

export interface TopologyHandlerDeps {
  runtime: TopologyHandlerRuntime;
  /** 当前生效拓扑的消息体（含 readiness） */
  topologyMessage: () => Extract<ServerMessage, { type: 'topology' }>;
  /** 历史版本列表 */
  history: () => Extract<ServerMessage, { type: 'topologyHistory' }>['versions'];
  /** 取某一版拓扑；不存在返回 null */
  versionAt: (revision: number) => ProcessTopology | null;
  /** 限流：拓扑操作共用一套冷却，超频时调用 notice 并返回 true */
  throttled: (ws: TopologySocket) => boolean;
  /** 单发 */
  send: (ws: TopologySocket, message: ServerMessage) => void;
  /** 广播 */
  broadcast: (message: ServerMessage) => void;
  broadcastSnapshot: () => void;
  /** 应用一个已校验的拓扑并完成重建，返回是否写盘成功与新 revision */
  adopt: (
    topology: ProcessTopology,
    compiled: CompiledNetwork,
    net: NetworkSimState,
    note: string,
    presetId: string | null,
  ) => { saved: boolean; revision: number };
  /** 拒绝非法输入时的指标 */
  onInvalid: () => void;
}

/** 处理器只需要这三种能力，不必知道完整的 WebSocket 类型 */
export interface TopologySocket {
  send: (payload: string) => void;
}

type TopologyMessage = Extract<ClientMessage, { type: 'topology' }>;

/**
 * 处理一条 `topology` 消息。
 *
 * 返回值表示「这条消息是否被处理」——`get`/`history` 总是处理，
 * 未知 action 返回 false，由调用方的 default 分支兜底。
 */
export function handleTopologyMessage(ws: TopologySocket, msg: TopologyMessage, deps: TopologyHandlerDeps): boolean {
  const { runtime } = deps;

  if (msg.action === 'get') {
    deps.send(ws, { ...deps.topologyMessage() });
    return true;
  }

  if (msg.action === 'history') {
    const requestId = (msg as { requestId?: unknown }).requestId;
    deps.send(ws, {
      type: 'topologyHistory',
      requestId: typeof requestId === 'string' ? requestId : undefined,
      versions: deps.history(),
    });
    return true;
  }

  if (msg.action === 'revert') {
    if (deps.throttled(ws)) {
      deps.send(ws, { type: 'notice', level: 'error', text: '拓扑变更过于频繁，请稍后再试' });
      return true;
    }
    const revision = (msg as { revision?: unknown }).revision;
    if (typeof revision !== 'number' || !Number.isFinite(revision)) {
      deps.send(ws, { type: 'notice', level: 'error', text: '回滚目标版本不合法' });
      return true;
    }
    /**
     * 回滚 = 以旧内容创建一个新 revision。
     *
     * 不把 revision 指针拨回去：客户端的增量判断、审计链、持久化都按
     * 单调递增的 revision 工作，倒退会让"最新"变成歧义。
     */
    const target = deps.versionAt(revision);
    if (!target) {
      deps.send(ws, { type: 'notice', level: 'error', text: `找不到第 ${revision} 版拓扑` });
      return true;
    }
    const result = applySafely(runtime, target);
    if (!result.ok) {
      deps.send(ws, {
        type: 'notice',
        level: 'error',
        text: `第 ${revision} 版当前不可运行：${result.blockers[0] ?? '未知原因'}`,
      });
      return true;
    }
    const { saved, revision: now } = deps.adopt(
      result.topology,
      result.compiled,
      result.net,
      `回滚到 v${revision}`,
      null,
    );
    deps.broadcast({
      type: 'notice',
      level: 'info',
      text: saved
        ? `已回滚到第 ${revision} 版；当前为第 ${now} 版，厂已重建并完成预热。`
        : `已回滚到第 ${revision} 版（⚠ 写盘失败，重启后会回退到旧拓扑）；当前为第 ${now} 版。`,
    });
    deps.broadcast({ ...deps.topologyMessage() });
    deps.send(ws, { type: 'topologyHistory', versions: deps.history() });
    deps.broadcastSnapshot();
    return true;
  }

  if (msg.action === 'apply') {
    if (deps.throttled(ws)) {
      deps.send(ws, { type: 'notice', level: 'error', text: '拓扑变更过于频繁，请稍后再试' });
      return true;
    }
    const incoming = (msg as { topology?: unknown }).topology;
    /**
     * 信任边界：先把任意 JSON 收成合法拓扑，再交给引擎。
     *
     * 只检查 `Array.isArray(units)` 就 `as ProcessTopology` 会让 units 里的
     * null、NaN 容积、超长主序列原样进入 compileNetwork，轻则应用失败，
     * 重则每个 tick 抛错把仿真停掉。sanitize 也负责 id 白名单
     * （见 isSafeId：原型链关键字在这里被拒）。
     */
    const sanitized = sanitizeTopologyInput(incoming);
    if (!sanitized.ok) {
      deps.onInvalid();
      deps.send(ws, { type: 'notice', level: 'error', text: `拓扑结构不合法：${sanitized.error}` });
      return true;
    }
    const result = applySafely(runtime, sanitized.topology);
    if (!result.ok) {
      deps.send(ws, { type: 'notice', level: 'error', text: `拓扑无法应用：${result.blockers[0] ?? '未知原因'}` });
      deps.send(ws, { ...deps.topologyMessage() });
      return true;
    }
    const { saved, revision } = deps.adopt(result.topology, result.compiled, result.net, '应用自定义拓扑', null);
    deps.broadcast({
      type: 'notice',
      level: 'info',
      text: saved
        ? `工艺拓扑已应用（第 ${revision} 版），厂已按新拓扑重建并完成预热。`
        : `工艺拓扑已应用（第 ${revision} 版），但 ⚠ 写盘失败：重启后会回退到旧拓扑，请检查磁盘空间。`,
    });
    deps.broadcast({ ...deps.topologyMessage() });
    deps.broadcastSnapshot();
    return true;
  }

  return false;
}

interface ApplyOk {
  ok: true;
  topology: ProcessTopology;
  compiled: CompiledNetwork;
  net: NetworkSimState;
}
interface ApplyFail {
  ok: false;
  blockers: string[];
}

/**
 * applyTopology 的薄包装：把「抛异常」与「返回 blockers」统一成一种结果。
 *
 * 抛异常来自编译期（拓扑结构本身能过 sanitize 但编译不过），
 * blockers 来自运行就绪检查（例如缺曝气单元）。对调用方是同一件事：
 * 这次切换没有生效。
 */
function applySafely(runtime: TopologyHandlerRuntime, candidate: ProcessTopology): ApplyOk | ApplyFail {
  const rt = {
    topology: runtime.topology,
    compiled: runtime.compiled,
    appliedAt: Date.now(),
    revision: runtime.topologyRevision,
    net: runtime.net,
  };
  try {
    const result = applyTopology(rt, candidate);
    if (!result.ok) return { ok: false, blockers: result.blockers };
    return { ok: true, topology: candidate, compiled: rt.compiled, net: rt.net };
  } catch (err) {
    return { ok: false, blockers: [err instanceof Error ? err.message : String(err)] };
  }
}

/** 供调用方构造 readiness 消息，避免重复实现 */
export function readinessOf(topology: ProcessTopology) {
  return checkRunReadiness(topology);
}

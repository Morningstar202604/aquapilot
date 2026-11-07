import type { ProcessTopology } from '../model/topology';
import type { NetworkSimState } from '../sim/networkEngine';
import type { CompiledNetwork } from '../sim/network';

/**
 * 拓扑切换后的运行时重建。
 *
 * 抽这段的原因是**它原本被复制了三遍**：切模板、回滚版本、应用自定义拓扑
 * 各自抄了一份 8 行的重建序列。三份必须逐字一致——少一行就是一个真实缺陷：
 *
 * - 漏 `trend = []`：新厂沿用旧厂的曲线，看上去像"换拓扑后停住了"；
 * - 漏 `shadow` 重建：影子对照还在跑旧厂，效益页的差值全是假的；
 * - 漏 `clearRunScopedState()`：人工优先期 / 告警去重 / 预测缓存把上一轮带进新厂；
 * - 漏 `pushTrend`：换拓扑后第一段时间里趋势图是空的，直到下一次采样。
 *
 * 三份副本里任何一份将来漏改都极难发现（三个入口的验证成本完全不同），
 * 所以合成一个函数，由调用方只决定「文案」和「模板 id」。
 */

export interface TopologyRebuildRuntime {
  topology: ProcessTopology;
  compiled: CompiledNetwork;
  topologyRevision: number;
  net: NetworkSimState;
  trend: unknown[];
  recommendation: unknown;
  activePresetId: string | null;
}

export interface TopologyRebuildDeps {
  runtime: TopologyRebuildRuntime;
  /** 采用候选拓扑：调用方保证 applyTopology 已通过 readiness */
  adopt: (topology: ProcessTopology, compiled: CompiledNetwork, net: NetworkSimState) => void;
  /** 持久化，返回是否写盘成功（失败要在提示里明说，否则用户以为已保存） */
  persist: (topology: ProcessTopology, revision: number, note: string) => boolean;
  /** 时钟归零类状态清理（人工优先期、告警去重、预测缓存…） */
  clearRunScopedState: () => void;
  /** 重建影子对照厂 */
  rebuildShadow: (topology: ProcessTopology, net: NetworkSimState) => void;
  /** 追加一个趋势点，避免新厂趋势图空窗 */
  pushTrend: () => void;
  /** 重跑一次 AI 决策周期（新厂需要立刻给出建议） */
  runAiCycle: () => void;
}

export interface TopologyRebuildResult {
  revision: number;
  saved: boolean;
}

/**
 * 应用一个已通过校验的拓扑，并把所有把「跟着顶层运行的派生状态」重置到新厂。
 *
 * 调用方负责：参数校验、readiness、applyTopology 本身，以及广播文案。
 */
export function adoptTopology(
  topology: ProcessTopology,
  compiled: CompiledNetwork,
  net: NetworkSimState,
  note: string,
  presetId: string | null,
  deps: TopologyRebuildDeps,
): TopologyRebuildResult {
  const { runtime } = deps;
  deps.adopt(topology, compiled, net);
  runtime.topologyRevision += 1;
  const saved = deps.persist(topology, runtime.topologyRevision, note);
  deps.clearRunScopedState();
  runtime.activePresetId = presetId;
  runtime.recommendation = null;
  runtime.trend = [];
  deps.rebuildShadow(topology, net);
  deps.pushTrend();
  deps.runAiCycle();
  return { revision: runtime.topologyRevision, saved };
}

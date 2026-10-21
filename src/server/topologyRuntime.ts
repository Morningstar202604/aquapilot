import { PLANT_TOPOLOGY, ProcessTopology, validateTopology, totalTrainVolume } from '../model/topology';
import { checkRunReadiness } from '../sim/topologyEngine';
import { compileNetwork, CompiledNetwork } from '../sim/network';
import { NetworkSimState, createNetworkState, qualityScoreOf, spinUpNetwork, stepNetwork } from '../sim/networkEngine';

/**
 * 拓扑运行时：把一份可执行的工艺拓扑装进服务端。
 *
 * 拓扑不是"界面配置"，它是运行契约。apply 时会先校验可运行性，
 * 不通过就拒绝——这样"图能画但跑不了"在服务端就被挡住。
 */

export interface TopologyRuntime {
  topology: ProcessTopology;
  compiled: CompiledNetwork;
  appliedAt: number;
  revision: number;
  /** 拓扑求解状态（反应器数量随拓扑变化） */
  net: NetworkSimState;
}

export interface ApplyResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  derived: { trainUnits: number; bioVolume: number; hrtHours: number; aerobicVolume: number };
}

export function createRuntime(topo: ProcessTopology, seed = 20261019): TopologyRuntime {
  const readiness = checkRunReadiness(topo);
  if (!readiness.ready) {
    throw new Error(`拓扑不可运行：${readiness.blockers.join('；')}`);
  }
  const compiled = compileNetwork(topo);
  if (compiled.problems.length) {
    throw new Error(`拓扑无法编译：${compiled.problems.join('；')}`);
  }

  const net = createNetworkState(topo, { seed });
  spinUpNetwork(net, topo, 30);

  return { topology: topo, compiled, appliedAt: Date.now(), revision: 1, net };
}

export function applyTopology(runtime: TopologyRuntime, topo: ProcessTopology): ApplyResult {
  const readiness = checkRunReadiness(topo);
  const issues = validateTopology(topo);
  const blockers = [...readiness.blockers, ...issues.filter((i) => i.severity === 'error').map((i) => i.message)];

  if (blockers.length > 0) {
    return { ok: false, blockers, warnings: readiness.warnings, derived: readiness.derived };
  }

  const next = createRuntime(topo, runtime.net.seed);
  runtime.topology = topo;
  runtime.compiled = next.compiled;
  runtime.net = next.net;
  runtime.appliedAt = Date.now();
  runtime.revision += 1;

  return { ok: true, blockers: [], warnings: readiness.warnings, derived: readiness.derived };
}

/** 推进拓扑求解 */
export function stepRuntime(runtime: TopologyRuntime, dtMin: number): void {
  stepNetwork(runtime.net, runtime.topology, dtMin);
}

export function runtimeQuality(runtime: TopologyRuntime): number {
  return qualityScoreOf(runtime.net.effluent);
}

export function topologySummary(topo: ProcessTopology) {
  return {
    units: topo.units.length,
    connections: topo.connections.length,
    trainLength: topo.train.length,
    bioVolume: totalTrainVolume(topo),
    hasInternalRecycle: topo.connections.some((c) => c.stream === 'internal_recycle'),
    hasRas: topo.connections.some((c) => c.stream === 'return_activated_sludge'),
    hasStorage: topo.units.some((u) => u.kind === 'storage'),
  };
}

export { PLANT_TOPOLOGY, checkRunReadiness };
export type { ProcessTopology };

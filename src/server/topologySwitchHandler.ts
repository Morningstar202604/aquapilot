import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { PRESETS, buildPreset, presetById } from '../model/presets';
import type { CompiledNetwork } from '../sim/network';
import type { NetworkSimState, KineticModel } from '../sim/networkEngine';
import type { ProcessTopology } from '../model/topology';
import type { ApplyResult } from './topologyRuntime';

type PresetMessage = Extract<ClientMessage, { type: 'preset' }>;
type ModelMessage = Extract<ClientMessage, { type: 'model' }>;

export interface PresetSwitchDeps {
  /** 应用候选拓扑到服务端运行时，返回阻塞原因或派生指标。 */
  apply: (candidate: ProcessTopology) => ApplyResult;
  compiled: () => CompiledNetwork;
  net: () => NetworkSimState;
  /** 与拓扑变更同价：重建并预热 30 天，共用同一个 topology 限流桶。 */
  rateLimited: () => boolean;
  send: (payload: ServerMessage) => void;
  adopt: (
    topology: ProcessTopology,
    compiled: CompiledNetwork,
    net: NetworkSimState,
    note: string,
    presetId: string | null,
  ) => { saved: boolean };
  topologyMessage: () => ServerMessage;
  broadcast: (payload: ServerMessage) => void;
  broadcastSnapshot: () => void;
}

/**
 * 工艺模板切换：先校验可运行性，再重建运行时并落盘。
 * 400 ms 级的预热代价决定它必须和拓扑编辑共用限流。
 */
export function handlePresetMessage(msg: PresetMessage, deps: PresetSwitchDeps): void {
  if (deps.rateLimited()) {
    deps.send({ type: 'notice', level: 'error', text: '工艺切换过于频繁，请稍后再试' });
    return;
  }
  const known = PRESETS.map((p) => p.id);
  if (typeof msg.id !== 'string' || !known.includes(msg.id)) {
    deps.send({ type: 'notice', level: 'error', text: '未知的工艺模板' });
    return;
  }
  const preset = presetById(msg.id);
  if (!preset) return;
  const candidate = buildPreset(preset);
  const result = deps.apply(candidate);
  if (!result.ok) {
    deps.send({
      type: 'notice',
      level: 'error',
      text: `模板无法应用：${result.blockers[0] ?? '未知原因'}`,
    });
    return;
  }
  const { saved } = deps.adopt(candidate, deps.compiled(), deps.net(), `切换模板：${preset.name}`, preset.id);
  deps.broadcast({
    type: 'notice',
    level: 'info',
    text: saved ? `已切换到模板：${preset.name}` : `已切换到模板：${preset.name}（⚠ 写盘失败，重启后会回退到旧拓扑）`,
  });
  deps.broadcast(deps.topologyMessage());
  deps.broadcastSnapshot();
}

export interface ModelSwitchDeps {
  currentModel: () => KineticModel;
  /** 切换后仿真时间回到 0：模型变了，旧轨迹不再可比。 */
  resetModel: (model: KineticModel) => void;
  rateLimited: () => boolean;
  send: (payload: ServerMessage) => void;
  broadcast: (payload: ServerMessage) => void;
  broadcastSnapshot: () => void;
  paused: () => boolean;
  speed: () => number;
}

/**
 * 求解模型切换：简化模型（快速）↔ ASM1（13 组分）。
 * 与模板/拓扑同价，都重建并预热 30 天，共用 topology 限流桶。
 */
export function handleModelMessage(msg: ModelMessage, deps: ModelSwitchDeps): void {
  if (deps.rateLimited()) {
    deps.send({ type: 'notice', level: 'error', text: '模型切换过于频繁，请稍后再试' });
    return;
  }
  if (deps.currentModel() === msg.model) {
    deps.send({ type: 'notice', level: 'info', text: '当前已在运行该模型' });
    return;
  }
  const label = msg.model === 'asm1' ? 'ASM1（13 组分）' : '简化模型';
  deps.resetModel(msg.model);
  deps.broadcast({ type: 'notice', level: 'info', text: `求解模型已切换为「${label}」，仿真已重置并预热 30 天` });
  deps.broadcast({ type: 'simState', paused: deps.paused(), speed: deps.speed() });
  deps.broadcastSnapshot();
}

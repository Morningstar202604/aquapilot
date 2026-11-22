/**
 * WP8 工业接口：引擎状态 → 协议层视图的最小映射。
 *
 * 适配层只依赖 `ProtocolStateView`（tags.ts），不直接绑定 `NetworkSimState`
 * 的完整形状。本文件把引擎状态逐字段投影成视图：
 * - 只拷贝标签解析用到的数值字段，不泄漏引擎内部结构；
 * - 控制量只取数值项，布尔开关（如 `aiEnabled`）不进协议视图；
 * - 纯函数、不做标定/换算，量程与质量判定仍由 tags.ts / adapter.ts 收口。
 *
 * 引擎内部字段随 WP2/WP3/WP4 演进时，只需调整本投影，适配层与传输层不动。
 */
import type { NetworkSimState } from '../../sim/networkTypes';
import type { ProtocolStateView } from './tags';

export function protocolStateFromNetwork(state: NetworkSimState): ProtocolStateView {
  const { controls } = state;
  return {
    timeMin: state.timeMin,
    reactors: state.reactors.map((r) => ({
      id: r.id,
      kind: r.kind,
      doLevel: r.doLevel,
      nh: r.nh,
      cod: r.cod,
      no3: r.no3,
      tp: r.tp,
      temperature: r.temperature,
      alkalinity: r.alkalinity,
    })),
    influent: {
      flow: state.influent.flow,
      cod: state.influent.cod,
      nh: state.influent.nh,
      tp: state.influent.tp,
    },
    effluent: {
      flow: state.effluent.flow,
      nh: state.effluent.nh,
      tp: state.effluent.tp,
      tn: state.effluent.tn,
      ph: state.effluent.ph,
      temperature: state.effluent.temperature,
    },
    controls: {
      doSetpoint: controls.doSetpoint,
      internalRecirc: controls.internalRecirc,
      rasRatio: controls.rasRatio,
      wasRatio: controls.wasRatio,
      pacDose: controls.pacDose,
      carbonDose: controls.carbonDose,
      alkDose: controls.alkDose,
      stormStore: controls.stormStore,
      stepFeed: controls.stepFeed,
    },
    energy: {
      blowerKw: state.energy.blowerKw,
      pumpKw: state.energy.pumpKw,
      totalKw: state.energy.totalKw,
    },
  };
}

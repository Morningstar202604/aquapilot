import type { NetworkSimState, ReactorState } from '../sim/networkEngine';
import type { TankState } from '../sim/plantTypes';

/**
 * 快照里的分池反应器状态。
 *
 * 为什么单独一层：`buildSnapshot` 与 `buildPatch` 各自把反应器映射成 TankState，
 * 两处逻辑必须逐字段一致（否则全量帧与增量帧的同一字段会给出不同值）。
 *
 * MLSS 是最容易出问题的一个字段：
 * - 简化模型只有一个全局 `biomassKg`，严格说是「全厂均值」，不能伪装成分池实测；
 * - ASM1 模式每个池有独立颗粒组分，可以给出真实的分池浓度。
 * 因此同时输出 `mlssSource`，让界面能如实标注口径。
 */

/** 1.42 g COD / g VSS（ASM1 生物量与悬浮固体的换算系数） */
const COD_PER_VSS = 1.42;

export interface TankStateWithSource extends TankState {
  /** plant-average = 简化模型的全厂均值；reactor = 该池真实颗粒浓度 */
  mlssSource: 'plant-average' | 'reactor';
}

function plantAverageMlss(state: NetworkSimState): number {
  return Math.round((state.biomassKg * 1000) / Math.max(1, state.volume.bio));
}

function reactorMlss(reactor: ReactorState): number | null {
  if (!reactor.asm1) return null;
  const a = reactor.asm1;
  return Math.round((a.X_I + a.X_S + a.X_B_H + a.X_B_A + a.X_P) / COD_PER_VSS);
}

export function buildTankStates(state: NetworkSimState): TankStateWithSource[] {
  if (state.reactors.length === 0) return [];
  const average = plantAverageMlss(state);
  return state.reactors.map((r) => {
    const own = reactorMlss(r);
    return {
      id: r.id,
      name: r.name,
      short: r.name,
      kind: r.kind,
      volume: r.volume,
      cod: r.cod,
      nh: r.nh,
      no3: r.no3,
      tp: r.tp,
      do: r.doLevel,
      mlss: own ?? average,
      mlssSource: own === null ? 'plant-average' : 'reactor',
      alkalinity: r.alkalinity,
      temperature: r.temperature,
      codRemoved: 0,
      nhRemoved: 0,
      o2Demand: r.o2Demand,
      klaUsed: r.kla,
    };
  });
}

/**
 * 增量帧里的精简版：只带每帧会变的字段。
 *
 * 同样走这里派生 MLSS，保证与全量帧同源。
 */
export function buildTankPatch(state: NetworkSimState) {
  if (state.reactors.length === 0) return [];
  const average = plantAverageMlss(state);
  return state.reactors.map((r) => ({
    id: r.id,
    do: r.doLevel,
    mlss: reactorMlss(r) ?? average,
    mlssSource: reactorMlss(r) === null ? ('plant-average' as const) : ('reactor' as const),
    cod: r.cod,
    nh: r.nh,
    no3: r.no3,
    tp: r.tp,
    alkalinity: r.alkalinity,
  }));
}

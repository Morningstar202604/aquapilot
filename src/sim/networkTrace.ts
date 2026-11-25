/**
 * 生产引擎的可审计 trace。
 *
 * 这里记录的是 `stepNetwork` 每个阶段**真实喂给子模块的输入**与**该模块回写的输出**，
 * 不是另起一套玩具场景。Rust 侧按同样的输入逐步复算，才能证明“整厂同输入 parity”，
 * 而不是只拿几个模块函数单独对齐。
 *
 * 设计约束：
 * - trace 只在显式传入 hook 时生成，正常仿真零开销；
 * - 只在模块边界克隆数据，不复制控制层/仪表/资产的内部状态；
 * - 字段名保持与生产类型一致，避免 golden 生成器再做一次映射。
 */

import type { Asm2dState } from './asm2d';
import type { BalanceInput, BalanceRow, PlantBoundaryState } from './plantBoundary';
import type { SludgeFeed, SludgeLineState } from './sludgeLine';
import type { SettlerConfig, SettlerState } from './takacs';
import type { EffluentStats } from './networkTypes';

export interface Asm2dTraceReactor {
  id: string;
  kind: 'anaerobic' | 'anoxic' | 'aerobic';
  volume: number;
  /** 进入网络求解前的 19 组分状态 */
  state: Asm2dState;
  kla: number;
  integral: number;
}

export interface Asm2dTraceEdge {
  id: string;
  from: string | null;
  to: string;
  flow: number;
  recycleKind: 'ras' | 'internal' | 'was' | null;
}

export interface Asm2dTraceFlux {
  o2DemandKgH: number;
  o2HeteroKgH: number;
  o2NitroKgH: number;
  o2TransferredKgH: number;
  nhOxidizedKgH: number;
  denitrifiedNKgH: number;
  clampCodKgH: number;
  clampNKgH: number;
  clampPKgH: number;
  endogenousOxKgH: number;
  biomassCodKg: number;
  clampedCount: number;
}

export interface Asm2dNetworkTrace {
  reactors: Asm2dTraceReactor[];
  order: string[];
  edges: Asm2dTraceEdge[];
  influent: {
    flow: number;
    cod: number;
    nh: number;
    tn: number;
    tp: number;
    ss: number;
    alkalinity: number;
  };
  xRas: number;
  rasPExact: number | null;
  xBiomass: number;
  temperatureC: number;
  dtH: number;
  bioP: boolean;
  carbonDose: number;
  aerationCapacity: number;
  doSetpoint: number;
  suppression: number;
  expected: {
    reactors: {
      id: string;
      state: Asm2dState;
      kla: number;
      integral: number;
      o2Demand: number;
    }[];
    flux: Asm2dTraceFlux;
  };
}

export interface SettlerTrace {
  index: number;
  cfg: SettlerConfig;
  state: SettlerState;
  feed: { flow: number; concentration: number };
  underflow: { flow: number };
  dtDays: number;
  expected: {
    state: SettlerState;
    xEffluent: number;
    xUnderflow: number;
    solidsLoading: number;
    blanketM: number;
    sludgeMassKg: number;
  };
}

export interface SludgeTrace {
  initial: SludgeLineState;
  feed: SludgeFeed;
  dtH: number;
  expected: {
    state: SludgeLineState;
    filtrate: { flowM3h: number; nh4NKgM3: number; codKgM3: number; tpKgM3: number };
  };
}

export interface BalanceTrace {
  initial: {
    cod: BalanceRow;
    n: BalanceRow;
    p: BalanceRow;
    inventory: PlantBoundaryState['inventory'];
    errors: { code: string; message: string }[];
  };
  input: BalanceInput;
  expected: {
    cod: BalanceRow;
    n: BalanceRow;
    p: BalanceRow;
    inventory: PlantBoundaryState['inventory'];
    errors: { code: string; message: string }[];
  };
}

export interface InventoryTrace {
  codKg: number;
  nKg: number;
  pKg: number;
  ppPKg: number;
}

export interface EffluentTrace {
  pacDose: number;
  xEff: number;
  Qe: number;
  temperatureC: number;
  last: {
    nh: number;
    no3: number;
    tp: number;
    alkalinity: number;
    solubleCod: number;
  };
  expected: EffluentStats;
}

export interface BiomassTrace {
  Q: number;
  Qw: number;
  xRas: number;
  volumeBio: number;
  influentBod: number;
  expected: {
    biomassKg: number;
    srtDays: number;
    fmRatio: number;
  };
}

export interface PlantInventoryTrace {
  initialBiomassKg: number;
  reactors: {
    volume: number;
    state: Asm2dState;
  }[];
  clarifierSludgeKg: number;
  clarifierFeedState: Asm2dState | null;
  expected: InventoryTrace;
}

export interface NetworkStepTrace {
  /** 本步推进后的仿真分钟 */
  timeMin: number;
  dtMin: number;
  asm2d?: Asm2dNetworkTrace;
  settlers?: SettlerTrace[];
  sludge?: SludgeTrace;
  balance?: BalanceTrace;
  inventory?: PlantInventoryTrace;
  effluent?: EffluentTrace;
  biomass?: BiomassTrace;
}

/** `stepNetwork` 的可选 trace 出口；不传时不产生任何克隆开销。 */
export type NetworkTraceHook = (trace: NetworkStepTrace) => void;

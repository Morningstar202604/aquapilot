/**
 * 网络引擎的状态类型。
 *
 * 单独成文件是为了打断 networkEngine ↔ plantModel 的类型循环：
 * plantModel 需要 NetworkSimState/EffluentStats，networkEngine 需要
 * networkSnapshot 与 PlantModel。类型搬出来后，plantModel 不再 import 引擎。
 */

import type { ControlSettings } from './config';
import type { ScenarioSpec } from './scenarios';
import type { SettlerState } from './takacs';
import type { InfluentSeries } from './influentSeries';
import type { Asm1State } from './asm1';
import type { Asm2dState } from './asm2d';
import type { CompiledNetwork } from './network';
import type { HydraulicState } from './hydraulics';
import type { PlantBoundaryState } from './plantBoundary';
import type { InstrumentationState } from './instruments';
import type { ControlLayerState } from './controlLayer';
import type { AssetPlantState } from './assets';
import type { ProcessTopology } from '../model/topology';

/** 单个二沉池状态（与旧 `clarifier` 同构，多系列时按系列存放） */
export interface ClarifierState {
  area: number;
  depth: number;
  /** Takács 十层剖面 */
  settler: SettlerState;
  blanketM: number;
  sludgeMassKg: number;
  xRas: number;
  xEff: number;
  slr: number;
}

export interface ReactorState {
  id: string;
  name: string;
  kind: 'anaerobic' | 'anoxic' | 'aerobic';
  volume: number;
  /** ASM1 13 组分状态；仅在 modelMode === 'asm1' 时存在 */
  asm1?: Asm1State;
  /** ASM2d 19 组分状态；仅在 modelMode === 'asm2d' 时存在 */
  asm2d?: Asm2dState;
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  doLevel: number;
  alkalinity: number;
  temperature: number;
  o2Demand: number;
  kla: number;
  /** DO PI 控制器积分项；无曝气时为 0 */
  doIntegral?: number;
  inflow: number;
}

export interface EffluentStats {
  flow: number;
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
  ph: number;
  temperature: number;
}

export type KineticModel = 'simple' | 'asm1' | 'asm2d';

export interface NetworkSimState {
  timeMin: number;
  seed: number;
  rngCount: number;
  topologyId: string;
  modelMode: KineticModel;
  /** WP2 生物除磷（PAO 厌氧释磷/好氧吸磷）总开关；关闭后 TP 只能靠 PAC 化学去除 */
  bioPRemoval: boolean;
  reactors: ReactorState[];
  order: string[];
  /** 主二沉池（向后兼容：第一条系列/汇总口径） */
  clarifier: ClarifierState;
  /** 多系列二沉池；缺省时等价于单系列，内容与 `clarifier` 一致 */
  clarifiers?: ClarifierState[];
  /** WP3 水力学状态：管渠输运、泵/阀/堰、分流、示踪剂 */
  hydraulics?: HydraulicState;
  /** WP2 全厂边界：ASM2d 口径、泥线（浓缩/消化/脱水）、沼气、沼液回流、质量平衡 */
  plant?: PlantBoundaryState;
  /** WP4 仪表子系统：测量链读数、质量码、真值对照（旧快照缺省时由引擎补默认） */
  instruments?: InstrumentationState;
  /** WP4 控制层：PID 回路、联锁/ESD 状态、被拒指令审计 */
  controlLayer?: ControlLayerState;
  /** WP7 资产子系统：设备状态、故障码、备机、可用性因子、ESD */
  assets?: AssetPlantState;
  influent: {
    flow: number;
    cod: number;
    bod: number;
    nh: number;
    tn: number;
    tp: number;
    ss: number;
    temperature: number;
    alkalinity: number;
  };
  effluent: EffluentStats;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  biomassKg: number;
  srtDays: number;
  /** 食微比 F/M = kg BOD₅/d ÷ kg MLSS */
  fmRatio: number;
  inhibition: number;
  aerationCapacity: number;
  energy: { blowerKw: number; mixerKw: number; pumpKw: number; totalKw: number };
  alarms: {
    id: string;
    at: number;
    severity: 'warning' | 'critical';
    code: string;
    message: string;
    metric?: string;
    value?: number;
  }[];
  alarmSeq: number;
  /** 累计（自预热结束起） */
  cost: { energy: number; chemical: number; sludge: number; total: number };
  /** 当个仿真日（跨日清零） */
  costToday: { energy: number; chemical: number; sludge: number; total: number };
  /**
   * 累计物料量：必须按每步流量/功率积分，不能用「当前值 × 已运行时间」外推。
   * 进水流量、负荷与能耗都是时变量，外推在日内会系统性偏差。
   */
  /**
   * 可选的真实进水序列。
   *
   * 设置后，进水由该序列驱动，而不是「昼夜节律 + 噪声」的合成模型。
   * 这是与 bsm2-python 的 `dyninfluent` 对齐的能力：用历史剖面回答
   * 「拿上周真实进水跑一遍会怎样」。
   */
  influentSeries?: InfluentSeries | null;
  totals: {
    inflowM3: number;
    energyKwh: number;
    wasteSludgeKg: number;
    /**
     * 累计进水 COD 质量（kg）。
     *
     * 必须随水量一起积分，而不是用「当前瞬时进水浓度 × 累计水量」：
     * 后者在启动初期会给出极小分母（累计水量接近 0 而池内已有几十吨库存），
     * 质量平衡直接算出 -69712% 这种荒谬数字。积分值才是与库存可比的量。
     */
    influentCodKg: number;
    /**
     * 累计被氧化的 COD 质量（kg）。
     *
     * 好氧系统里进水 COD 的最大去向不是出水也不是排泥，而是被氧化成 CO₂。
     * 不记这一项，任何质量平衡审计都会报出 30%+ 的假差额——
     * 那不是模型漏了组分，是账本漏了最大的一笔支出。
     */
    oxidizedCodKg: number;
  };
  lastDay: number;
  /**
   * 不确定度因子（仅预测克隆使用）：让集合预测可以在同一状态上做参数扰动，
   * 生产状态保持 undefined，物理路径不变。
   */
  uncertainty?: { flow: number; cod: number; nh: number; tp: number; temperature: number; biomass: number };
  stormStorageM3: number;
  volume: { bio: number; aerobic: number; anoxic: number; anaerobic: number };
  /**
   * 编译缓存随状态走（而非模块全局）：
   * - 每个仿真实例持有自己的 topo 引用与编译结果，影子双跑/多实例互不干扰；
   * - stepNetwork 只按「对象身份」判断是否需要重编译，同一张图不反复编译；
   * - 彻底消除「同一拓扑对象被就地修改后命中过期编译」这一类隐患。
   */
  topo: ProcessTopology;
  net: CompiledNetwork;
}

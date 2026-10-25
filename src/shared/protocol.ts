import type {
  Alarm,
  EffluentState,
  EnergyState,
  InfluentState,
  TankState,
  ClarifierState,
  CostState,
} from '../sim/plantTypes';
import type { ControlSettings, Limits } from '../sim/config';
import type { ScenarioSpec } from '../sim/scenarios';
import type { Answer, Recommendation } from '../ai/agent';
import type { EnsembleForecast } from '../sim/ensemble';
import type { AlarmAttribution, PlantHealth } from '../sim/alarmAttribution';
import type { BenchmarkSummary } from '../server/benchmark';
import type { ProcessTopology } from '../model/topology';

export interface TrendPoint {
  t: number;
  influentCod: number;
  influentNh: number;
  influentFlow: number;
  effluentCod: number;
  effluentNh: number;
  effluentTn: number;
  effluentTp: number;
  effluentSs: number;
  do: number;
  mlss: number;
  energyKw: number;
  blanket: number;
}

export interface PlantSnapshot {
  timeMin: number;
  simulatedAt: string;
  speed: number;
  paused: boolean;
  /** 当前求解模型：'simple' 经验动力学 / 'asm1' 活性污泥模型（影响 TP 等组分口径） */
  modelMode: 'simple' | 'asm1';
  influent: InfluentState;
  effluent: EffluentState;
  tanks: TankState[];
  clarifier: ClarifierState;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  energy: EnergyState;
  cost: CostState;
  srtDays: number;
  fmRatio: number;
  score: number;
  margins: { metric: string; ratio: number; value: number; limit: number }[];
  alarms: Alarm[];
  activeAlarms: Alarm[];
  /** 每条活跃告警的归因（原因 / 动作 / 后果），按告警 code 索引 */
  alarmAttribution: Record<string, AlarmAttribution>;
  /** 全厂健康度：五个可核对维度的加权分 */
  health: PlantHealth;
  trends: TrendPoint[];
  forecast: {
    points: {
      minute: number;
      cod: number;
      nh: number;
      tn: number;
      tp: number;
      ss: number;
      doLevel: number;
      score: number;
    }[];
    violations: { metric: string; minute: number; value: number; limit: number }[];
  } | null;
  recommendation: Recommendation | null;
  /** 选中方案的集合预测（P10/P50/P90）；未评估时为 null */
  forecastBand: EnsembleForecast | null;
  /** 影子双跑：AI vs 固定策略（同一进水） */
  benchmark: BenchmarkSummary | null;
  limits: Limits;
  totals: {
    inflowM3: number;
    energyKwh: number;
    cost: number;
    wasteSludgeKg: number;
    elapsedMin: number;
    energyCost: number;
    chemicalCost: number;
    sludgeCost: number;
  };
  stormStorageM3: number;
  reactorCount: number;
}

export type ClientMessage =
  | { type: 'hello' }
  | { type: 'chat'; text: string }
  | { type: 'control'; patch: Partial<ControlSettings> }
  | { type: 'aiEnabled'; enabled: boolean }
  | { type: 'applyRecommendation' }
  | { type: 'scenario'; kind: 'start'; scenario: ScenarioSpec['type']; durationMin?: number; magnitude?: number }
  | { type: 'scenario'; kind: 'clear' }
  | { type: 'sim'; action: 'pause' | 'resume' | 'reset' }
  | { type: 'speed'; value: number }
  | { type: 'refreshDecision' }
  | { type: 'preset'; id: string }
  | { type: 'topology'; action: 'get' }
  | { type: 'topology'; action: 'apply'; topology: ProcessTopology };

/**
 * 增量快照：只包含每个 tick 都会变的字段。
 *
 * 为什么需要：完整快照含 720 个趋势点，实测约 240 KB/帧；
 * 1 Hz 广播时每客户端 14 MB/min，多客户端会打满带宽与发送队列。
 * 全量快照只在连接建立、拓扑变更、场景切换等低频事件时发送。
 */
export interface SnapshotPatch {
  timeMin: number;
  influentFlow: number;
  effluent: EffluentState;
  tanks: Pick<TankState, 'id' | 'do' | 'mlss' | 'cod' | 'nh' | 'no3' | 'tp' | 'alkalinity'>[];
  clarifier: { blanketM: number; xRas: number; xEff: number; slr: number };
  energy: EnergyState;
  cost: { totalToday: number; total: number };
  srtDays: number;
  score: number;
  margins: { metric: string; ratio: number; value: number; limit: number }[];
  /** 自上次补丁以来新增的趋势点（通常 0 或 1 个） */
  trendsAppend: TrendPoint[];
  activeAlarms: Alarm[];
  alarmAttribution: Record<string, AlarmAttribution>;
  health: PlantHealth;
  stormStorageM3: number;
  reactorCount: number;
}

export type ServerMessage =
  | { type: 'snapshot'; data: PlantSnapshot }
  | { type: 'snapshotPatch'; data: SnapshotPatch }
  | { type: 'chat'; question: string; answer: Answer }
  | { type: 'decision'; data: Recommendation }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'simState'; paused: boolean; speed: number }
  | {
      type: 'topology';
      data: ProcessTopology;
      dirty: boolean;
      readiness: {
        ready: boolean;
        blockers: string[];
        warnings: string[];
        derived: { trainUnits: number; bioVolume: number; hrtHours: number; aerobicVolume: number };
      };
    };

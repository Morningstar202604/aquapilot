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
import type { ProcessTopology } from '../model/topology';
import type { DiscoveredModel, LlmDraft, LlmProtocol, LlmPublicConfig, LlmTestResult } from './llm';
import type { AgentConfig, AgentSummary } from './agentConfig';

/**
 * AI vs 固定策略的双跑汇总。
 *
 * 定义放在 shared 而不是 server/benchmark：它是客户端与协议的一部分，
 * 若留在服务端，shared/protocol 会反过来 import server 模块，
 * 形成「协议层依赖运行时实现」的反向依赖（客户端打包也会把服务端代码拖进来）。
 */
export interface BenchmarkSide {
  /** 累计仿真分钟 */
  minutes: number;
  /** 出水六项全在限值内的分钟数 */
  compliantMinutes: number;
  /** 分钟加权平均出水评分 */
  scoreSum: number;
  /** 累计电耗 kWh */
  energyKwh: number;
  /** 累计运行成本（元） */
  cost: number;
  /** 累计处理水量 m³ */
  inflowM3: number;
  /** 吨水电耗 kWh/m³ */
  specificKwhM3: number;
}

export interface BenchmarkSummary {
  ai: BenchmarkSide;
  manual: BenchmarkSide;
  /** 合规率差（AI − 人工），百分点 */
  complianceDeltaPct: number;
  /** 吨水电耗差（AI − 人工），kWh/m³ */
  specificEnergyDelta: number;
  /** 运行成本差（AI − 人工），% */
  costDeltaPct: number;
  /** 平均出水评分差 */
  scoreDelta: number;
  /** 样本是否足够给出结论 */
  mature: boolean;
}

/** 拓扑版本摘要（列表用；完整拓扑只在回滚时按 revision 取） */
export interface TopologyVersionSummary {
  revision: number;
  savedAt: string;
  /** 版本说明：应用拓扑 / 切换模板 / 回滚到 vN */
  label: string;
  name: string;
  units: number;
  connections: number;
}

export interface WatchdogReport {
  at: string;
  severity: 'ok' | 'warn' | 'error';
  checks: { id: string; label: string; severity: 'ok' | 'warn' | 'error'; detail: string; action: string }[];
}

/**
 * 历史回放的采样点（SQLite snapshots 表的一行）。
 *
 * 定义放在 shared：客户端回放面板要用它。此前从 `server/store` import，
 * 浏览器包会顺着类型依赖把服务端模块拖进依赖图——类型虽被擦除，
 * 但架构上形成了客户端→服务端的反向依赖。
 */
export interface SnapshotRow {
  runId?: string;
  atMin: number;
  effluentCod: number;
  effluentNh: number;
  effluentTn: number;
  effluentTp: number;
  effluentSs: number;
  mlss: number;
  srtDays: number;
  energyKw: number;
  score: number;
}

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
  tanks: (TankState & { mlssSource?: 'plant-average' | 'reactor' })[];
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
  | { type: 'topology'; action: 'apply'; topology: ProcessTopology }
  /** 列出近 N 个版本（摘要，不含完整拓扑） */
  | { type: 'topology'; action: 'history' }
  /** 回滚到指定 revision：服务端以旧内容创建新 revision 并走完整校验 */
  | { type: 'topology'; action: 'revert'; revision: number }
  | { type: 'llmConfig'; action: 'get'; requestId?: string }
  | {
      type: 'llmConfig';
      action: 'discover';
      requestId: string;
      protocol: LlmProtocol;
      baseUrl: string;
      apiKey?: string;
    }
  | {
      type: 'llmConfig';
      action: 'test';
      requestId: string;
      protocol: LlmProtocol;
      baseUrl: string;
      apiKey?: string;
      model: string;
      maxOutput?: number;
    }
  | { type: 'llmConfig'; action: 'save'; requestId: string; draft: LlmDraft }
  | { type: 'llmConfig'; action: 'clear'; requestId: string }
  | { type: 'agentConfig'; action: 'get'; requestId?: string }
  | { type: 'agentConfig'; action: 'save'; requestId: string; config: AgentConfig }
  | { type: 'agentConfig'; action: 'patch'; requestId: string; patch: Partial<AgentConfig> }
  | { type: 'agentConfig'; action: 'reset'; requestId: string }
  | {
      type: 'agentConfig';
      action: 'importSkill';
      requestId: string;
      skill: { name?: string; description?: string; triggers?: string[]; content?: string; url?: string };
    }
  | { type: 'agentConfig'; action: 'previewPrompt'; requestId: string; question?: string; config?: AgentConfig }
  | { type: 'watchdog'; action: 'get'; requestId?: string };

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
  tanks: (Pick<TankState, 'id' | 'do' | 'mlss' | 'cod' | 'nh' | 'no3' | 'tp' | 'alkalinity'> & {
    mlssSource?: 'plant-average' | 'reactor';
  })[];
  clarifier: {
    blanketM: number;
    xRas: number;
    xEff: number;
    slr: number;
    /** 十层剖面；缺失时客户端保留上一帧 */
    profile?: number[];
  };
  energy: EnergyState;
  cost: { totalToday: number; total: number };
  srtDays: number;
  fmRatio: number;
  /**
   * 当前控制量。
   *
   * 必须随增量下发：AI 自动执行后控制量会被服务端改写，
   * 不合并它，界面滑块会一直停在用户上次拖到的位置（真实缺陷）。
   */
  controls: ControlSettings;
  /** 累计量：累计处理水量 / 电耗 / 污泥，「累计与推算」区块依赖它 */
  totals: PlantSnapshot['totals'];
  score: number;
  margins: { metric: string; ratio: number; value: number; limit: number }[];
  /** 自上次补丁以来新增的趋势点（通常 0 或 1 个） */
  trendsAppend: TrendPoint[];
  /**
   * 最近告警（最多 20 条）。
   *
   * 全量快照里也有，但全量快照只在连接/换拓扑时发；
   * 不随增量下发的话，运行中新触发的告警永远不会出现在「历史记录」里。
   */
  alarms: Alarm[];
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
    }
  | { type: 'topologyHistory'; requestId?: string; versions: TopologyVersionSummary[] }
  | { type: 'llmConfig'; action: 'config'; requestId?: string; config: LlmPublicConfig | null }
  | { type: 'llmConfig'; action: 'discovered'; requestId: string; models: DiscoveredModel[] }
  | { type: 'llmConfig'; action: 'tested'; requestId: string; result: LlmTestResult }
  | { type: 'llmConfig'; action: 'saved'; requestId: string; ok: boolean; config?: LlmPublicConfig; error?: string }
  | { type: 'llmConfig'; action: 'error'; requestId?: string; error: string }
  | {
      type: 'agentConfig';
      action: 'state';
      requestId?: string;
      config: AgentConfig;
      summary: AgentSummary;
      warnings: string[];
      coreProtected: string[];
      promptPreview?: string;
    }
  | {
      type: 'agentConfig';
      action: 'saved';
      requestId: string;
      ok: boolean;
      config?: AgentConfig;
      summary?: AgentSummary;
      warnings: string[];
      error?: string;
    }
  | { type: 'agentConfig'; action: 'error'; requestId?: string; error: string }
  | { type: 'watchdog'; report: WatchdogReport };

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
import type { AnalysisSnapshot } from '../sim/analysis';
import type { CalibrationProgress, IdentifiabilityRow } from '../sim/calibration';

/** 数据质量报告（结构镜像 sim/dataQuality 的 QualityReport，避免循环依赖） */
export interface QualityReportPayload {
  score: number;
  usable: boolean;
  issues: {
    severity: 'error' | 'warning' | 'info';
    code: string;
    metric?: string;
    index?: number;
    message: string;
    action: string;
  }[];
  perMetric: Record<string, { min: number; max: number; mean: number; missing: number }>;
}

/**
 * 标定结果摘要（去掉 trace 的完整参数对象，只保留可展示的部分）。
 *
 * 全量 `CalibrationResult` 含 11 个参数对象与几十条 trace，序列化后
 * 约 30 KB；前端只需要「改了多少、改善多少」。
 */
export interface CalibrationResultSummary {
  objectiveBefore: number;
  objectiveAfter: number;
  improvementPct: number;
  fitted: string[];
  fixed: string[];
  converged: boolean;
  /** 参数变化：标定前 → 标定后 */
  changes: { param: string; before: number; after: number; changePct: number }[];
}

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
  effluentBod: number;
  effluentNh: number;
  effluentTn: number;
  effluentTp: number;
  effluentSs: number;
  do: number;
  mlss: number;
  /** 污泥龄（d）：运营评分卡要评生物稳定性，趋势缓冲必须带上 */
  srtDays: number;
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
  /**
   * 运营评分卡（四维：达标 / 能效 / 生物稳定 / 危机处置）。
   *
   * 分数由服务端从趋势缓冲复算，不由 AI 自评——参考项目实测 AI 自评
   * 会高估 20 分。standard 字段写明判读口径，避免同一分数在不同标准下
   * 被误读。
   */
  scorecard?: import('../sim/scorecard').Scorecard;
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
      /** 按用户选择的思考档位测试，保证测试结果与保存后的行为一致 */
      reasoningEffort?: 'auto' | 'low' | 'off';
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
  | { type: 'watchdog'; action: 'get'; requestId?: string }
  /**
   * 运行分析：灵敏度 / Pareto 前沿 / 质量平衡。
   *
   * 按需触发而不是每帧推送：一次分析要做 ~25 次 4 小时预测（实测 300+ ms），
   * 只在用户打开「分析」面板时算一次。
   */
  | { type: 'analysis'; action: 'run'; requestId: string; horizonMin?: number }
  /**
   * 参数校准（CPU 密集，2–3 分钟，必须走后台任务）。
   *
   * 三种动作：
   * - `identify` 只跑可辨识性分析（约 40 s），告诉用户哪些参数能被数据约束；
   * - `start`    启动完整标定（可辨识性 + 坐标下降），进度通过 `calibration` 推送；
   * - `cancel`   请求中止（下一个参数点结束后生效）。
   */
  | { type: 'calibration'; action: 'identify'; requestId: string }
  | { type: 'calibration'; action: 'start'; requestId: string; maxIterations?: number }
  | { type: 'calibration'; action: 'cancel'; requestId: string }
  /**
   * 进水序列：加载/清除真实历史剖面。
   *
   * `load` 携带 CSV 文本（限制 2 MB，约 10 年逐小时数据）；
   * 服务端解析 + 质量校验 + 报告，不自动应用——
   * 用户看到质量报告后点 `apply` 才真正切换。
   */
  | { type: 'influent'; action: 'load'; requestId: string; name: string; csv: string }
  | { type: 'influent'; action: 'apply'; requestId: string }
  | { type: 'influent'; action: 'clear'; requestId: string }
  | { type: 'influent'; action: 'get'; requestId: string };

/**
 * 增量快照：只包含每个 tick 都会变的字段。
 *
 * 为什么需要：完整快照含 720 个趋势点，实测约 240 KB/帧；
 * 1 Hz 广播时每客户端 14 MB/min，多客户端会打满带宽与发送队列。
 * 全量快照只在连接建立、拓扑变更、场景切换等低频事件时发送。
 */
export interface SnapshotPatch {
  timeMin: number;
  /** 进水流量（兼容字段，等价于 influent.flow） */
  influentFlow: number;
  /**
   * 进水水质。
   *
   * 只发流量的话，暴雨/冲击负荷场景里进水的 COD、NH₄、TP、SS、水温
   * 在界面上会永远停在连接那一刻——这些量每 tick 都在变，必须随增量下发。
   */
  influent: InfluentState;
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
  /**
   * 当前场景（含开始时刻与时长）。
   *
   * 必须随增量下发：场景是"窗口内有效"的状态，只在全量快照里带的话，
   * 场景结束时客户端仍会显示「进行中 · 剩 N 分钟」，永远不会自行消失。
   * 同理，新注入的场景也要靠它出现在侧栏摘要里。
   */
  scenario: ScenarioSpec | null;
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
  /**
   * 选中方案的集合预测（P10–P90）。
   *
   * 必须随增量下发：它每 15 仿真分钟（AI 决策周期）才换一次，但只在全量
   * 快照里带的话，客户端连上后趋势图上的预测扇区就永久冻结在连接那一刻。
   */
  forecastBand: EnsembleForecast | null;
  /**
   * 影子双跑摘要。
   *
   * 同样只在全量快照里会有「AI vs 固定策略」永远显示最早的几分钟样本——
   * 收益面板的对照必须随运行推进更新。
   */
  benchmark: BenchmarkSummary | null;
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
  | { type: 'watchdog'; report: WatchdogReport }
  | { type: 'analysis'; requestId: string; data: AnalysisSnapshot }
  | { type: 'analysis'; action: 'error'; requestId: string; error: string }
  | { type: 'calibration'; action: 'progress'; requestId: string; progress: CalibrationProgress }
  | { type: 'calibration'; action: 'identifiability'; requestId: string; rows: IdentifiabilityRow[] }
  | { type: 'calibration'; action: 'done'; requestId: string; result: CalibrationResultSummary }
  | { type: 'calibration'; action: 'cancelled'; requestId: string }
  | { type: 'calibration'; action: 'error'; requestId: string; error: string }
  | {
      type: 'influent';
      action: 'report';
      requestId: string;
      /** 已解析但尚未应用的序列摘要 */
      summary: null | {
        name: string;
        points: number;
        days: number;
        flowMean: number;
        flowPeak: number;
        codMean: number;
        codPeak: number;
        temperatureRange: [number, number];
      };
      quality: QualityReportPayload;
      applied: boolean;
    }
  | { type: 'influent'; action: 'error'; requestId: string; error: string };

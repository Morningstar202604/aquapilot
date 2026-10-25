import { createServer, IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { answer, decide, Recommendation } from '../ai/agent';
import { askLlm, type GroundingContext } from '../ai/llm';
import { CONTROL_BOUNDS, LIMITS, PLANT } from '../sim/config';
import { SCENARIOS, ScenarioType } from '../sim/scenarios';
import { NetworkSimState, networkModel, qualityScoreOf, stepNetwork } from '../sim/networkEngine';
import type { ForecastOutcomeX } from '../sim/plantModel';
import { CompiledNetwork } from '../sim/network';
import { estimateMargin } from '../sim/metrics';
import { attributeAlarm, plantHealth, trendSlopes, type AlarmAttribution } from '../sim/alarmAttribution';
import type { ClientMessage, PlantSnapshot, ServerMessage, SnapshotPatch, TrendPoint } from '../shared/protocol';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../model/topology';
import { PRESETS, buildPreset, presetById } from '../model/presets';
import { applyTopology, checkRunReadiness, createRuntime } from './topologyRuntime';
import { Store } from './store';
import { authRequired, authorize } from './auth';
import { isApiPath, isPublicApiPath, isReadMethod, pathnameOf, shouldFallbackToIndex } from './httpRoutes';
import { logger, metrics, metricsJson, recordHttp, recordTick, renderPrometheus } from './observability';
import { buildOperationsReport, decisionsCsv, snapshotsCsv } from './export';
import { takeNewPoints } from './trendCursor';
import { createShadowPlant, stepShadow, summarizeBenchmark, type ShadowPlant } from './benchmark';
import {
  VALID_SCENARIOS,
  sanitizeBoolean,
  sanitizeChatText,
  sanitizeControlPatch,
  sanitizeMessage,
  sanitizeRange,
  sanitizeSpeed,
} from './validation';

const PORT = Number(process.env.PORT ?? 5173);
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
const SIM_MINUTES_PER_TICK = Number(process.env.SIM_MINUTES_PER_TICK ?? 2);
const AI_CYCLE_TICKS = 30;
/** 人工调整后的 AI 静默期（仿真分钟） */
const MANUAL_OVERRIDE_MIN = 30;
const TREND_EVERY_TICKS = 10;

interface ClientState {
  /** 上次触发重算决策的时间，用于防止同步阻塞被滥用 */
  lastControlAt: number;
  lastTopologyAt: number;
  /**
   * 已推送的最后一个趋势点时刻（仿真分钟）。
   *
   * 不能用「已收到的点数量」当游标：趋势是 720 点的环形缓冲，
   * 一旦写满，`slice(count)` 永远为空，客户端从此收不到新点。
   * 用时间戳做游标，缓冲滚动后仍然只发新增点。
   */
  lastTrendT: number;
}

interface Runtime {
  topology: ProcessTopology;
  compiled: CompiledNetwork;
  topologyRevision: number;
  net: NetworkSimState;
  paused: boolean;
  speed: number;
  recommendation: Recommendation | null;
  trend: TrendPoint[];
  tick: number;
  aiTick: number;
  clients: Set<WebSocket>;
  clientState: Map<WebSocket, ClientState>;
  /** 人工调整后的优先期截止（仿真分钟）；期内 AI 只建议不覆盖 */
  manualOverrideUntil: number;
  /** 快照附带的 4h 预测缓存：键 = timeMin|controls，预测只随两者变化，避免 tick 间重复重算 */
  forecastCache: { key: string | null; value: ForecastOutcomeX | null };
  /** 当前生效的工艺模板 id；自定义拓扑或无模板时为 null */
  activePresetId: string | null;
  /** 影子双跑厂（固定策略） */
  shadow: ShadowPlant;
}

const store = new Store();

/**
 * 本次运行的标识。
 *
 * 仿真时钟每次启动都从 0 开始，若不区分 run，
 * 多次运行的快照会在 at_min 上重叠，回放曲线呈现假锯齿。
 */
const RUN_ID = `run-${Date.now().toString(36)}`;

const boot = createRuntime(PLANT_TOPOLOGY, 20261019);

const runtime: Runtime = {
  topology: PLANT_TOPOLOGY,
  compiled: boot.compiled,
  topologyRevision: 1,
  net: boot.net,
  paused: false,
  speed: 1,
  recommendation: null,
  trend: [],
  tick: 0,
  aiTick: 0,
  clients: new Set(),
  clientState: new Map(),
  manualOverrideUntil: 0,
  forecastCache: { key: null, value: null },
  activePresetId: 'a2o-standard',
  shadow: createShadowPlant(PLANT_TOPOLOGY, 20261019, 0),
};

function pushTrend(state: NetworkSimState, trend: TrendPoint[]): void {
  const last = state.reactors[state.reactors.length - 1];
  const mlss = (state.biomassKg * 1000) / Math.max(1, state.volume.bio);
  trend.push({
    t: state.timeMin,
    influentCod: state.influent.cod,
    influentNh: state.influent.nh,
    influentFlow: state.influent.flow,
    effluentCod: state.effluent.cod,
    effluentNh: state.effluent.nh,
    effluentTn: state.effluent.tn,
    effluentTp: state.effluent.tp,
    effluentSs: state.effluent.ss,
    do: last?.doLevel ?? 0,
    mlss: Math.round(mlss),
    energyKw: state.energy.totalKw,
    blanket: state.clarifier.blanketM,
  });
  if (trend.length > 720) trend.splice(0, trend.length - 720);
}

/**
 * 快照附带的 4h 预测：同一仿真时刻 + 同一控制量下只算一次。
 *
 * buildSnapshot 在每次控制变更、客户端接入、AI 周期结束都会触发；
 * 而预测只随 (timeMin, controls) 变化，tick 之间频繁重算同一结果是纯浪费。
 * 缓存命中即复用，控制量或时刻变化自动失效。
 * 缓存挂在 runtime 上而非模块级，避免任何跨运行实例共享可变状态。
 */
function forecastForSnapshot(): ForecastOutcomeX | null {
  const s = runtime.net;
  if (!runtime.recommendation) return null;
  const key = `${s.timeMin}|${JSON.stringify(s.controls)}`;
  if (runtime.forecastCache.key === key && runtime.forecastCache.value) return runtime.forecastCache.value;
  const model = networkModel(runtime.topology, s);
  runtime.forecastCache.value = model.predict(s.controls, 240, 30);
  runtime.forecastCache.key = key;
  return runtime.forecastCache.value;
}

function buildSnapshot(): PlantSnapshot {
  const s = runtime.net;
  const fc = forecastForSnapshot();

  // 把拓扑反应器映射成前端沿用的 tank 结构，保持界面契约不变
  const tanks = s.reactors.map((r) => ({
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
    mlss: Math.round((s.biomassKg * 1000) / Math.max(1, s.volume.bio)),
    alkalinity: r.alkalinity,
    temperature: r.temperature,
    codRemoved: 0,
    nhRemoved: 0,
    o2Demand: r.o2Demand,
    klaUsed: r.kla,
  }));

  const effluent = {
    ...s.effluent,
  };

  return {
    timeMin: s.timeMin,
    simulatedAt: new Date().toISOString(),
    speed: runtime.speed,
    paused: runtime.paused,
    modelMode: s.modelMode,
    influent: { ...s.influent, bod: s.influent.cod * 0.44, ph: 7.2 },
    effluent,
    tanks,
    clarifier: {
      blanketM: s.clarifier.blanketM,
      sludgeMassKg: s.clarifier.sludgeMassKg,
      xRas: s.clarifier.xRas,
      xEff: s.clarifier.xEff,
      slr: s.clarifier.slr,
      underflowM3h: s.influent.flow * s.controls.rasRatio,
      area: s.clarifier.area,
      depth: s.clarifier.depth,
    },
    controls: s.controls,
    scenario: s.scenario,
    energy: { ...s.energy, specificKwhM3: s.energy.totalKw / Math.max(1, s.influent.flow) },
    cost: {
      energyToday: s.costToday.energy,
      chemicalToday: s.costToday.chemical,
      sludgeToday: s.costToday.sludge,
      totalToday: s.costToday.total,
      total: s.cost.total,
    },
    srtDays: s.srtDays,
    fmRatio: s.fmRatio,
    score: qualityScoreOf(effluent),
    margins: estimateMargin(effluent),
    alarms: s.alarms
      .slice(-20)
      .reverse()
      .map((a) => ({ ...a })),
    activeAlarms: currentAlarms(s),
    alarmAttribution: buildAttribution(s),
    health: plantHealth({
      margins: estimateMargin(effluent),
      lastDo: s.reactors[s.reactors.length - 1]?.doLevel ?? 0,
      doSetpoint: s.controls.doSetpoint,
      srtDays: s.srtDays,
      blanketM: s.clarifier.blanketM,
      depth: s.clarifier.depth,
      activeAlarms: currentAlarms(s).length,
    }),
    trends: runtime.trend,
    forecast: fc
      ? {
          points: fc.points.map((pt) => ({
            minute: pt.minute,
            cod: pt.effluent.cod,
            nh: pt.effluent.nh,
            tn: pt.effluent.tn,
            tp: pt.effluent.tp,
            ss: pt.effluent.ss,
            doLevel: pt.doLevel,
            score: pt.score,
          })),
          violations: fc.violations.slice(0, 12),
        }
      : null,
    recommendation: runtime.recommendation,
    forecastBand: runtime.recommendation?.ensemble ?? null,
    benchmark: summarizeBenchmark(runtime.shadow.benchmark),
    limits: LIMITS,
    totals: {
      inflowM3: s.totals.inflowM3,
      energyKwh: s.totals.energyKwh,
      cost: s.cost.total,
      wasteSludgeKg: s.totals.wasteSludgeKg,
      elapsedMin: s.timeMin,
      energyCost: s.cost.energy,
      chemicalCost: s.cost.chemical,
      sludgeCost: s.cost.sludge,
    },
    stormStorageM3: s.stormStorageM3,
    reactorCount: s.reactors.length,
  };
}

function currentAlarms(s: NetworkSimState) {
  const out: NetworkSimState['alarms'] = [];
  const last = s.reactors[s.reactors.length - 1];
  const push = (code: string, severity: 'warning' | 'critical', message: string, metric: string, value: number) => {
    out.push({ id: `LIVE-${code}`, at: s.timeMin, severity, code, message, metric, value });
  };
  if (s.effluent.nh > LIMITS.nh)
    push('EFF_NH', 'critical', `出水氨氮 ${s.effluent.nh.toFixed(2)} mg/L 超限`, 'nh', s.effluent.nh);
  if (s.effluent.cod > LIMITS.cod)
    push('EFF_COD', 'critical', `出水 COD ${s.effluent.cod.toFixed(1)} mg/L 超限`, 'cod', s.effluent.cod);
  if (s.effluent.bod > LIMITS.bod)
    push('EFF_BOD', 'warning', `出水 BOD₅ ${s.effluent.bod.toFixed(1)} mg/L 超限`, 'bod', s.effluent.bod);
  if (s.effluent.tn > LIMITS.tn)
    push('EFF_TN', 'warning', `出水总氮 ${s.effluent.tn.toFixed(1)} mg/L 超限`, 'tn', s.effluent.tn);
  if (s.effluent.tp > LIMITS.tp)
    push('EFF_TP', 'warning', `出水总磷 ${s.effluent.tp.toFixed(3)} mg/L 超限`, 'tp', s.effluent.tp);
  if (s.effluent.ss > LIMITS.ss)
    push('EFF_SS', 'warning', `出水悬浮物 ${s.effluent.ss.toFixed(1)} mg/L 超限`, 'ss', s.effluent.ss);
  if (last && last.doLevel < 1)
    push('DO_LOW', 'warning', `好氧区溶解氧 ${last.doLevel.toFixed(2)} mg/L 低于下限`, 'do', last.doLevel);
  if (s.clarifier.blanketM > s.clarifier.depth - 0.4)
    push(
      'SLUDGE_BLANKET',
      'critical',
      `二沉池泥位 ${s.clarifier.blanketM.toFixed(2)} m 接近跑泥`,
      'blanket',
      s.clarifier.blanketM,
    );
  if (s.srtDays < 8) push('SRT_LOW', 'warning', `污泥龄 ${s.srtDays.toFixed(1)} d 偏低`, 'srt', s.srtDays);
  return out;
}

function topologyMessage(): {
  type: 'topology';
  data: ProcessTopology;
  dirty: boolean;
  readiness: ReturnType<typeof checkRunReadiness>;
} {
  return {
    type: 'topology',
    data: runtime.topology,
    dirty: false,
    readiness: checkRunReadiness(runtime.topology),
  };
}

/**
 * 构造增量快照。
 *
 * 只包含每个 tick 必然变化的字段；趋势只给新增点（通常 0 或 1 个）。
 * 与完整快照相比，稳态帧大小从约 240 KB 降到约 2 KB。
 */
function buildPatch(client: ClientState): SnapshotPatch | null {
  const s = runtime.net;
  // 缓冲可能已滚动：按时间戳取新增点，而不是按数量切片
  const trendsAppend = takeNewPoints(runtime.trend, client);

  return {
    timeMin: s.timeMin,
    influentFlow: s.influent.flow,
    effluent: { ...s.effluent },
    tanks: s.reactors.map((r) => ({
      id: r.id,
      do: r.doLevel,
      mlss: Math.round((s.biomassKg * 1000) / Math.max(1, s.volume.bio)),
      cod: r.cod,
      nh: r.nh,
      no3: r.no3,
      tp: r.tp,
      alkalinity: r.alkalinity,
    })),
    clarifier: {
      blanketM: s.clarifier.blanketM,
      xRas: s.clarifier.xRas,
      xEff: s.clarifier.xEff,
      slr: s.clarifier.slr,
    },
    energy: { ...s.energy, specificKwhM3: s.energy.totalKw / Math.max(1, s.influent.flow) },
    // 当日口径必须用 costToday：用累计值会让「今日运行成本」随仿真天数线性上涨
    cost: { totalToday: s.costToday.total, total: s.cost.total },
    srtDays: s.srtDays,
    score: qualityScoreOf(s.effluent),
    margins: estimateMargin(s.effluent),
    trendsAppend,
    activeAlarms: currentAlarms(s),
    alarmAttribution: buildAttribution(s),
    health: plantHealth({
      margins: estimateMargin(s.effluent),
      lastDo: s.reactors[s.reactors.length - 1]?.doLevel ?? 0,
      doSetpoint: s.controls.doSetpoint,
      srtDays: s.srtDays,
      blanketM: s.clarifier.blanketM,
      depth: s.clarifier.depth,
      activeAlarms: currentAlarms(s).length,
    }),
    stormStorageM3: s.stormStorageM3,
    reactorCount: s.reactors.length,
  };
}

/**
 * 把当前活跃告警逐条归因。
 *
 * 只在服务端算一次：前端拿到的是"原因 + 动作 + 后果"，不需要重复实现工艺规则；
 * 归因函数本身是纯函数，测试可以脱离服务端跑。
 */
function buildAttribution(s: NetworkSimState): Record<string, AlarmAttribution> {
  const slopes = trendSlopes(runtime.trend, s.effluent.bod);
  const last = s.reactors[s.reactors.length - 1];
  const out: Record<string, AlarmAttribution> = {};
  for (const alarm of currentAlarms(s)) {
    const attribution = attributeAlarm({
      code: alarm.code,
      effluent: s.effluent,
      srtDays: s.srtDays,
      lastDo: last?.doLevel ?? 0,
      doSetpoint: s.controls.doSetpoint,
      blanketM: s.clarifier.blanketM,
      depth: s.clarifier.depth,
      temperature: s.influent.temperature,
      inhibition: s.inhibition,
      slopes,
    });
    if (attribution) out[alarm.code] = attribution;
  }
  return out;
}

function broadcastPatch(): void {
  for (const ws of runtime.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const client = runtime.clientState.get(ws) ?? { lastControlAt: 0, lastTopologyAt: 0, lastTrendT: 0 };
    const patch = buildPatch(client);
    runtime.clientState.set(ws, client);
    if (patch) ws.send(JSON.stringify({ type: 'snapshotPatch', data: patch } satisfies ServerMessage));
  }
}

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const ws of runtime.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastSnapshot(): void {
  broadcast({ type: 'snapshot', data: buildSnapshot() });
}

function runAiCycle(force = false): Recommendation {
  const model = networkModel(runtime.topology, runtime.net);
  let rec: Recommendation;
  try {
    rec = decide({ model, horizonMin: 240 });
    metrics.aiCycles += 1;
  } catch (err) {
    metrics.aiCycleErrors += 1;
    logger.error('ai cycle failed', { error: String(err) });
    throw err;
  }
  runtime.recommendation = rec;

  // 人工优先期内不自动执行，只记录建议
  const inManualWindow = runtime.net.timeMin < runtime.manualOverrideUntil;
  if (inManualWindow && !force) {
    broadcast({ type: 'decision', data: rec });
    return rec;
  }

  if (runtime.net.controls.aiEnabled && (rec.action !== 'hold' || force)) {
    runtime.net.controls = rec.chosens.controls;
    runtime.net.controls.aiEnabled = true;
    broadcast({
      type: 'notice',
      level: rec.severity === 'critical' ? 'warn' : 'info',
      text: `AI 已执行：${rec.summary}`,
    });
  }
  broadcast({ type: 'decision', data: rec });

  store.recordDecision({
    runId: RUN_ID,
    atMin: runtime.net.timeMin,
    action: rec.action,
    severity: rec.severity,
    summary: rec.summary,
    tweaks: JSON.stringify(rec.tweaks),
    predictedScore: rec.predictedScore,
    separation: rec.separation,
  });

  return rec;
}

function advance(): void {
  const s = runtime.net;
  const dt = SIM_MINUTES_PER_TICK * runtime.speed;
  const steps = Math.max(1, Math.round(dt));
  for (let i = 0; i < steps; i++) {
    stepNetwork(s, runtime.topology, 1);
    runtime.tick += 1;
    if (runtime.tick % TREND_EVERY_TICKS === 0) pushTrend(s, runtime.trend);
    try {
      stepShadow(runtime.shadow, s, 1, runtime.topology);
    } catch (err) {
      // 影子链只用于对比展示，任何异常都不能影响主仿真
      logger.warn('shadow benchmark step failed', { error: String(err) });
    }
  }
  if (s.scenario && s.timeMin > s.scenario.startedAt + s.scenario.durationMin + 30) {
    s.scenario = null;
    broadcast({ type: 'notice', level: 'info', text: '场景窗口结束，恢复正常工况监视。' });
  }
  // 每 10 个 tick 抽一个快照点（约每 20 仿真分钟），用于回放
  if (runtime.tick % 10 === 0) {
    const e = s.effluent;
    store.recordSnapshot({
      runId: RUN_ID,
      atMin: s.timeMin,
      effluentCod: e.cod,
      effluentNh: e.nh,
      effluentTn: e.tn,
      effluentTp: e.tp,
      effluentSs: e.ss,
      mlss: (s.biomassKg * 1000) / Math.max(1, s.volume.bio),
      srtDays: s.srtDays,
      energyKw: s.energy.totalKw,
      score: qualityScoreOf(e),
    });
  }

  runtime.aiTick += 1;
  if (runtime.aiTick % AI_CYCLE_TICKS === 0) {
    runAiCycle();
  }
  broadcastPatch();
}

/**
 * 简易速率限制。
 *
 * 为什么需要：control 会同步跑一次完整决策（实测 ~135ms），
 * topology apply 会同步重建并预热（实测 ~415ms）。
 * 这些都在事件循环上，任何客户端连续发送就能把服务打停。
 */
const RATE_LIMIT = {
  controlMs: 500,
  topologyMs: 5000,
};

function rateLimited(ws: WebSocket, kind: 'control' | 'topology'): boolean {
  const state = runtime.clientState.get(ws) ?? { lastControlAt: 0, lastTopologyAt: 0, lastTrendT: 0 };
  const now = Date.now();
  if (kind === 'control') {
    if (now - state.lastControlAt < RATE_LIMIT.controlMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastControlAt = now;
  } else {
    if (now - state.lastTopologyAt < RATE_LIMIT.topologyMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastTopologyAt = now;
  }
  runtime.clientState.set(ws, state);
  return false;
}

/**
 * 把当前状态压成 LLM 可引用的最小事实集。
 *
 * 只放已经有数值的量，不放控制器写权限、不放日志、不放环境变量。
 */
function buildLlmGrounding(question: string): GroundingContext {
  const s = runtime.net;
  const margins = estimateMargin(s.effluent);
  const rec = runtime.recommendation;
  const day = Math.floor(s.timeMin / 1440) + 1;
  const h = Math.floor((s.timeMin % 1440) / 60);
  const m = Math.floor(s.timeMin % 60);
  const facts: GroundingContext['facts'] = [
    { label: '进水流量', value: s.influent.flow.toFixed(0), unit: 'm³/h' },
    { label: '进水 COD', value: s.influent.cod.toFixed(0), unit: 'mg/L' },
    { label: '进水氨氮', value: s.influent.nh.toFixed(1), unit: 'mg/L' },
    { label: '出水 COD', value: s.effluent.cod.toFixed(1), unit: 'mg/L（限值 50）' },
    { label: '出水氨氮', value: s.effluent.nh.toFixed(2), unit: 'mg/L（限值 5）' },
    { label: '出水总氮', value: s.effluent.tn.toFixed(2), unit: 'mg/L（限值 15）' },
    { label: '出水总磷', value: s.effluent.tp.toFixed(3), unit: 'mg/L（限值 0.5）' },
    { label: '出水 SS', value: s.effluent.ss.toFixed(1), unit: 'mg/L（限值 10）' },
    { label: '最紧指标', value: margins[0]?.metric ?? '—', unit: `占限值 ${(margins[0]?.ratio ?? 0) * 100}%` },
    { label: '溶解氧设定', value: s.controls.doSetpoint.toFixed(1), unit: 'mg/L' },
    { label: '内回流比', value: s.controls.internalRecirc.toFixed(1), unit: '×Q' },
    { label: '污泥回流比', value: s.controls.rasRatio.toFixed(2), unit: '×Q' },
    { label: '污泥龄', value: s.srtDays.toFixed(1), unit: 'd' },
    { label: 'MLSS', value: ((s.biomassKg * 1000) / Math.max(1, s.volume.bio)).toFixed(0), unit: 'mg/L' },
    { label: '二沉池泥位', value: s.clarifier.blanketM.toFixed(2), unit: 'm' },
    { label: '吨水电耗', value: (s.energy.totalKw / Math.max(1, s.influent.flow)).toFixed(3), unit: 'kWh/m³' },
    { label: '活动场景', value: s.scenario ? s.scenario.type : '无' },
    { label: '活动告警数', value: s.alarms.filter((a) => s.timeMin - a.at < 60).length },
  ];
  void question;
  return {
    plant: `${PLANT.name} · ${PLANT.code}`,
    simClock: `第 ${day} 天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    facts,
    recommendation: rec ? rec.summary : null,
    risks: rec ? rec.risks : [],
  };
}

async function enhanceWithLlm(ws: WebSocket, question: string, ruleAnswer: ReturnType<typeof answer>): Promise<void> {
  const started = Date.now();
  const grounding = buildLlmGrounding(question);
  const result = await askLlm(question, grounding);
  metrics.llmCalls += 1;
  if (!result.ok) {
    metrics.llmFallbacks += 1;
    logger.debug('llm fallback', { reason: result.reason, ms: Date.now() - started });
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'chat',
      question,
      answer: {
        ...ruleAnswer,
        title: `${ruleAnswer.title} · 模型补充`,
        body: result.text,
        bullets: [],
        source: 'llm',
      },
    } satisfies ServerMessage),
  );
}

/**
 * 处理一条客户端消息。所有网络输入在这里完成校验，异常不得冒泡到进程。
 */
function handleClientMessage(ws: WebSocket, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    metrics.invalidMessages += 1;
    logger.warn('ws message rejected', { reason: 'malformed-json', bytes: raw.length });
    ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '消息格式错误' } satisfies ServerMessage));
    return;
  }

  // 形状校验：JSON.parse 的结果是任意值，null/数组/缺 type 都必须挡在这里
  const shaped = sanitizeMessage(parsed);
  if (!shaped) {
    metrics.invalidMessages += 1;
    logger.warn('ws message rejected', { reason: 'bad-shape' });
    ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '消息结构不合法' } satisfies ServerMessage));
    return;
  }
  const msg = shaped as unknown as ClientMessage;

  switch (msg.type) {
    case 'hello': {
      ws.send(JSON.stringify({ type: 'snapshot', data: buildSnapshot() } satisfies ServerMessage));
      ws.send(
        JSON.stringify({
          type: 'simState',
          paused: runtime.paused,
          speed: runtime.speed,
        } satisfies ServerMessage),
      );
      if (runtime.recommendation) {
        ws.send(JSON.stringify({ type: 'decision', data: runtime.recommendation } satisfies ServerMessage));
      }
      ws.send(JSON.stringify({ ...topologyMessage() } satisfies ServerMessage));
      break;
    }
    case 'chat': {
      const text = sanitizeChatText((msg as { text?: unknown }).text);
      if (text === null) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: '问题为空或过长（上限 2000 字）',
          } satisfies ServerMessage),
        );
        break;
      }
      const ruleAnswer = answer(text, networkModel(runtime.topology, runtime.net), runtime.recommendation);
      ws.send(JSON.stringify({ type: 'chat', question: text, answer: ruleAnswer } satisfies ServerMessage));

      /**
       * LLM 增强（可选，异步）。
       *
       * 先发规则答案保证「任何配置下都有回答」，再尝试 LLM 追问一条补充。
       * 失败只记指标，不打扰用户——用户已经看到可用答案。
       */
      void enhanceWithLlm(ws, text, ruleAnswer);
      break;
    }
    case 'control': {
      if (rateLimited(ws, 'control')) {
        ws.send(
          JSON.stringify({ type: 'notice', level: 'error', text: '操作过于频繁，请稍后再试' } satisfies ServerMessage),
        );
        break;
      }
      const result = sanitizeControlPatch((msg as { patch?: unknown }).patch);
      if (!result.ok) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: `控制参数非法：${result.error}`,
          } satisfies ServerMessage),
        );
        break;
      }
      runtime.net.controls = {
        ...runtime.net.controls,
        ...result.value,
        aiEnabled: runtime.net.controls.aiEnabled,
      };

      // 人工调整后进入优先期：期内 AI 只出建议、不覆盖设定值。
      // 否则用户拖完滑块，下一帧就被 AI 改回去——控制实际不可用。
      runtime.manualOverrideUntil = runtime.net.timeMin + MANUAL_OVERRIDE_MIN;

      // 重新评估决策（用于展示），但不强制应用
      runAiCycle(false);
      ws.send(
        JSON.stringify({
          type: 'notice',
          level: 'info',
          text: `已应用手动设定。接下来 ${MANUAL_OVERRIDE_MIN} 分钟仿真时间内 AI 只给出建议，不会覆盖你的调整。`,
        } satisfies ServerMessage),
      );
      broadcastSnapshot();
      break;
    }
    case 'aiEnabled': {
      const enabled = sanitizeBoolean((msg as { enabled?: unknown }).enabled);
      if (enabled === null) {
        ws.send(
          JSON.stringify({ type: 'notice', level: 'error', text: 'aiEnabled 必须是布尔值' } satisfies ServerMessage),
        );
        break;
      }
      runtime.net.controls.aiEnabled = enabled;
      ws.send(
        JSON.stringify({
          type: 'notice',
          level: 'info',
          text: enabled ? 'AI 自动值守已启用，将自动执行控制调节。' : 'AI 已切换为建议模式，控制调节需人工确认。',
        } satisfies ServerMessage),
      );
      broadcastSnapshot();
      break;
    }
    case 'applyRecommendation': {
      if (!runtime.recommendation) return;
      runtime.net.controls = { ...runtime.recommendation.chosens.controls, aiEnabled: runtime.net.controls.aiEnabled };
      broadcast({ type: 'notice', level: 'info', text: '已采纳 AI 建议，控制参数已更新。' });
      broadcastSnapshot();
      break;
    }
    case 'scenario': {
      if (msg.kind === 'clear') {
        runtime.net.scenario = null;
        runtime.net.controls = { ...runtime.net.controls, stormStore: 0 };
        broadcast({ type: 'notice', level: 'info', text: '已清除场景，回到常态工况。' });
      } else {
        const scenarioType = (msg as { scenario?: unknown }).scenario;
        if (typeof scenarioType !== 'string' || !VALID_SCENARIOS.has(scenarioType)) {
          ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '未知的场景类型' } satisfies ServerMessage));
          break;
        }
        const meta = SCENARIOS[scenarioType as ScenarioType];
        runtime.net.scenario = {
          type: scenarioType as ScenarioType,
          durationMin: sanitizeRange(
            (msg as { durationMin?: unknown }).durationMin,
            10,
            10080,
            meta.defaultDurationMin,
          ),
          magnitude: sanitizeRange((msg as { magnitude?: unknown }).magnitude, 0, 30, meta.defaultMagnitude),
          startedAt: runtime.net.timeMin,
        };
        broadcast({ type: 'notice', level: 'warn', text: `已注入场景：${meta.label}` });
        runAiCycle(true);
      }
      broadcastSnapshot();
      break;
    }
    case 'sim': {
      if (msg.action === 'pause') runtime.paused = true;
      if (msg.action === 'resume') runtime.paused = false;
      if (msg.action === 'reset') {
        runtime.net = createRuntime(runtime.topology, 20261019).net;
        runtime.shadow = createShadowPlant(runtime.topology, 20261019, 0);
        runtime.trend = [];
        runtime.recommendation = null;
        runtime.tick = 0;
        runtime.aiTick = 0;
        runtime.paused = false;
        broadcast({ type: 'notice', level: 'info', text: '仿真已重置到初始稳态。' });
      }
      broadcast({ type: 'simState', paused: runtime.paused, speed: runtime.speed });
      broadcastSnapshot();
      break;
    }
    case 'speed': {
      const speed = sanitizeSpeed((msg as { value?: unknown }).value);
      if (speed === null) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: '速度必须是 0.25–8 之间的数值',
          } satisfies ServerMessage),
        );
        break;
      }
      runtime.speed = speed;
      broadcast({ type: 'simState', paused: runtime.paused, speed: runtime.speed });
      break;
    }
    case 'refreshDecision': {
      runAiCycle(true);
      broadcastSnapshot();
      break;
    }
    case 'preset': {
      const known = PRESETS.map((p) => p.id);
      if (typeof msg.id !== 'string' || !known.includes(msg.id)) {
        ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '未知的工艺模板' } satisfies ServerMessage));
        break;
      }
      const preset = presetById(msg.id);
      if (!preset) break;
      const candidate = buildPreset(preset);
      const rt = {
        topology: runtime.topology,
        compiled: runtime.compiled,
        appliedAt: Date.now(),
        revision: runtime.topologyRevision,
        net: runtime.net,
      };
      const result = applyTopology(rt, candidate);
      if (!result.ok) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: `模板无法应用：${result.blockers[0] ?? '未知原因'}`,
          } satisfies ServerMessage),
        );
        break;
      }
      runtime.net = rt.net;
      runtime.compiled = rt.compiled;
      runtime.topology = candidate;
      runtime.topologyRevision += 1;
      runtime.activePresetId = preset.id;
      runtime.recommendation = null;
      runtime.trend = [];
      runtime.shadow = createShadowPlant(runtime.topology, runtime.net.seed, runtime.net.timeMin);
      pushTrend(runtime.net, runtime.trend);
      runAiCycle(true);
      broadcast({ type: 'notice', level: 'info', text: `已切换到模板：${preset.name}` });
      broadcast({ ...topologyMessage() } satisfies ServerMessage);
      broadcastSnapshot();
      break;
    }
    case 'topology': {
      if (msg.action === 'get') {
        ws.send(JSON.stringify({ ...topologyMessage() } satisfies ServerMessage));
        break;
      }
      if (msg.action === 'apply') {
        if (rateLimited(ws, 'topology')) {
          ws.send(
            JSON.stringify({
              type: 'notice',
              level: 'error',
              text: '拓扑变更过于频繁，请稍后再试',
            } satisfies ServerMessage),
          );
          break;
        }
        const incoming = (msg as { topology?: unknown }).topology;
        if (!incoming || typeof incoming !== 'object' || !Array.isArray((incoming as { units?: unknown }).units)) {
          ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '拓扑结构不合法' } satisfies ServerMessage));
          break;
        }
        const rt = {
          topology: runtime.topology,
          compiled: runtime.compiled,
          appliedAt: Date.now(),
          revision: runtime.topologyRevision,
          net: runtime.net,
        };
        let result: ReturnType<typeof applyTopology>;
        try {
          result = applyTopology(rt, incoming as ProcessTopology);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ws.send(
            JSON.stringify({ type: 'notice', level: 'error', text: `拓扑应用失败：${reason}` } satisfies ServerMessage),
          );
          break;
        }
        if (!result.ok) {
          ws.send(
            JSON.stringify({
              type: 'notice',
              level: 'error',
              text: `拓扑无法应用：${result.blockers[0] ?? '未知原因'}`,
            } satisfies ServerMessage),
          );
          ws.send(JSON.stringify({ ...topologyMessage() } satisfies ServerMessage));
          break;
        }
        // applyTopology 内部会重建 net，必须把新状态接回来，否则只是改了拓扑对象
        runtime.net = rt.net;
        runtime.compiled = rt.compiled;
        runtime.topology = incoming as ProcessTopology;
        runtime.topologyRevision += 1;
        runtime.activePresetId = null;
        runtime.recommendation = null;
        runtime.trend = [];
        runtime.shadow = createShadowPlant(runtime.topology, runtime.net.seed, runtime.net.timeMin);
        pushTrend(runtime.net, runtime.trend);
        runAiCycle(true);
        broadcast({
          type: 'notice',
          level: 'info',
          text: `工艺拓扑已应用（第 ${runtime.topologyRevision} 版），厂已按新拓扑重建并完成预热。`,
        });
        broadcast({ ...topologyMessage() } satisfies ServerMessage);
        broadcastSnapshot();
      }
      break;
    }
    default:
      break;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveStatic(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const clientDir = resolve(process.cwd(), 'dist/client');

  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    // 畸形百分号编码（如 /%E0%A4%A）会让 decodeURIComponent 抛 URIError
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  // 拒绝空字节与路径穿越片段
  if (urlPath.includes('\u0000')) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  let filePath = normalize(join(clientDir, urlPath === '/' ? 'index.html' : urlPath));

  // 前缀校验必须带分隔符，否则 dist/clientX 会通过 startsWith('dist/client')
  const withSep = clientDir.endsWith(sep) ? clientDir : clientDir + sep;
  if (filePath !== clientDir && !filePath.startsWith(withSep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    // 只有前端路由才回落首页；缺资源必须 404，否则浏览器把 HTML 当 JS 执行
    if (!shouldFallbackToIndex(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    filePath = join(clientDir, 'index.html');
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('客户端尚未构建，请先运行 npm run build');
  }
}

async function main(): Promise<void> {
  // 在开始服务前完成持久化初始化（Node 20 上会自动降级为不持久化）
  await store.open();

  const server = createServer((req, res) => {
    const startedHr = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedHr) / 1e9;
      recordHttp(req.method ?? 'GET', req.url ?? '/', res.statusCode, seconds);
    });

    /**
     * 访问控制只作用于 API 与 WebSocket，不拦静态资源。
     *
     * 为什么：浏览器导航请求无法携带 Authorization 头。
     * 早期实现把 `/` 也拦了，导致启用 token 后首页直接 401，
     * 前端完全无法加载——认证功能"启用即故障"。
     * 正确做法：页面可加载，页面内的 API/WS 调用再要求令牌。
     */
    // 基线安全响应头（OWASP A02）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:",
    );

    const pathname = pathnameOf(req.url);
    const isApi = isApiPath(pathname);
    // 健康检查与"是否需要认证"必须免鉴权，否则前端无法得知该不该弹登录框（死锁）
    const isPublic = isPublicApiPath(pathname);
    if (isApi && !isPublic) {
      const decision = authorize(req);
      if (!decision.allowed) {
        metrics.authFailures += 1;
        logger.warn('auth rejected', {
          scope: 'http',
          route: req.url?.split('?')[0],
          reason: decision.reason,
          ip: req.socket.remoteAddress,
        });
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: decision.reason, authRequired: true }));
        return;
      }
    }
    // 所有 API 都是只读的（写操作走 WebSocket），非 GET/HEAD 一律 405 并给出 Allow
    if (isApi && !isReadMethod(req.method)) {
      res.writeHead(405, {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'GET, HEAD',
      });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    if (pathname === '/api/auth-required') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ required: authRequired() }));
      return;
    }
    if (pathname === '/api/health') {
      /**
       * 健康检查分两级：
       * - 默认 /api/health：存活探针，只要进程能响应就是 200（用于 restart 判断）
       * - ?deep=1：就绪探针，额外检查仿真是否在推进、持久化是否可用
       *
       * 早期实现无条件返回 {ok:true}，tick 已经因异常停摆也照样"健康"，
       * 这对自动重启策略来说是假信号。
       */
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const deep = url.searchParams.get('deep') === '1';
      const body: Record<string, unknown> = {
        ok: true,
        authRequired: authRequired(),
        uptimeSeconds: Math.round(process.uptime()),
      };
      if (deep) {
        const stalled = runtime.paused && metrics.tickErrors > 0;
        const body2 = {
          ...body,
          ok: !stalled,
          paused: runtime.paused,
          tickErrors: metrics.tickErrors,
          lastTickMs: Number(metrics.lastTickMs.toFixed(1)),
          persistence: store.enabled ? 'enabled' : 'disabled',
          simulationMinutes: Math.round(runtime.net.timeMin),
        };
        res.writeHead(stalled ? 503 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body2));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }
    if (pathname === '/api/metrics') {
      // Prometheus 抓取默认走文本；?format=json 便于人读与前端展示
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(metricsJson()));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderPrometheus());
      return;
    }
    if (pathname === '/api/limits') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ limits: LIMITS, bounds: CONTROL_BOUNDS, plant: PLANT }));
      return;
    }
    if (pathname === '/api/topology') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          topology: runtime.topology,
          revision: runtime.topologyRevision,
          readiness: checkRunReadiness(runtime.topology),
          issues: validateTopology(runtime.topology),
          solved: {
            reactors: runtime.net.reactors.map((r) => ({ id: r.id, name: r.name, kind: r.kind, volume: r.volume })),
            bioVolume: runtime.net.volume.bio,
            aerobicVolume: runtime.net.volume.aerobic,
            anoxicVolume: runtime.net.volume.anoxic,
            anaerobicVolume: runtime.net.volume.anaerobic,
          },
        }),
      );
      return;
    }
    if (pathname === '/api/history/decisions') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ enabled: store.enabled, decisions: store.recentDecisions(100) }));
      return;
    }
    if (pathname === '/api/history/snapshots') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const from = Number(url.searchParams.get('from') ?? 0);
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          enabled: store.enabled,
          runId: store.latestRunId(),
          runs: store.listRuns(),
          snapshots: Number.isFinite(from) && Number.isFinite(to) ? store.snapshotsBetween(from, to) : [],
        }),
      );
      return;
    }
    if (pathname === '/api/history/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ enabled: store.enabled, counts: store.count() }));
      return;
    }
    if (pathname === '/api/presets') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          presets: PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })),
          activeId: runtime.activePresetId,
        }),
      );
      return;
    }
    if (pathname === '/api/export/snapshots.csv') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const from = Number(url.searchParams.get('from') ?? 0);
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
      const rows = Number.isFinite(from) && Number.isFinite(to) ? store.snapshotsBetween(from, to) : [];
      const body = snapshotsCsv(rows);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aquapilot-snapshots.csv"',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (pathname === '/api/export/decisions.csv') {
      const body = decisionsCsv(store.recentDecisions(1000));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aquapilot-decisions.csv"',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (pathname === '/api/export/report.md') {
      const body = buildOperationsReport(buildSnapshot());
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aquapilot-report.md"',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (pathname === '/api/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildSnapshot()));
      return;
    }
    // 未匹配的 /api/* 必须 404，不能掉进静态分支返回 index.html：
    // 客户端把 HTML 当 JSON 解析只会得到一句看不懂的语法错误
    if (isApi) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    serveStatic(req, res).catch((err) => {
      console.error('static handler error', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('internal error');
      } else {
        res.end();
      }
    });
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // 限制单帧大小，避免恶意大包打满内存（ws 的 DoS 公告与此相关）
    maxPayload: 1024 * 512,
    // Origin 白名单：仅允许同源与本地开发来源，缓解跨站 WebSocket 劫持
    verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
      // 访问控制优先：令牌不对直接拒绝，不再看 Origin
      const subprotocol = info.req.headers['sec-websocket-protocol'];
      const protoToken =
        typeof subprotocol === 'string'
          ? subprotocol
              .split(',')
              .map((x) => x.trim())
              .find((x) => x.startsWith('token.'))
              ?.slice(6)
          : null;
      const verdict = authorize(info.req, protoToken);
      if (!verdict.allowed) {
        metrics.authFailures += 1;
        logger.warn('auth rejected', { scope: 'ws', reason: verdict.reason, ip: info.req.socket.remoteAddress });
        return false;
      }

      const origin = info.origin;
      if (!origin) return true; // 非浏览器客户端（curl / 测试）
      if (authRequired()) return true; // 已通过令牌校验，允许跨主机使用
      try {
        const host = new URL(origin).hostname;
        const allowed = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (!allowed) logger.warn('ws origin rejected', { origin });
        return allowed;
      } catch {
        logger.warn('ws origin unparsable', { origin });
        return false;
      }
    },
  });

  wss.on('connection', (ws) => {
    metrics.wsActive += 1;
    metrics.wsAccepted += 1;
    logger.info('ws connected', { clients: runtime.clients.size + 1 });
    runtime.clients.add(ws);
    ws.on('message', (data) => {
      // 单条消息的处理绝不能冒泡到进程级
      try {
        handleClientMessage(ws, data.toString());
      } catch (err) {
        console.error('ws message handler error', err);
        try {
          ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '请求处理失败' }));
        } catch {
          /* 客户端可能已断开 */
        }
      }
    });
    ws.on('close', () => {
      metrics.wsDisconnections += 1;
      metrics.wsActive = Math.max(0, metrics.wsActive - 1);
      runtime.clients.delete(ws);
      runtime.clientState.delete(ws);
    });
    // error 之后一定会有 close；这里只记日志，否则同一连接会被计两次断开
    ws.on('error', (err) => {
      logger.warn('ws error', { error: String(err) });
    });
    // heartbeat：清理半开连接，避免 clients 集合泄漏
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);
    ws.on('close', () => clearInterval(ping));
  });

  setInterval(() => {
    if (runtime.paused) return;
    const t0 = process.hrtime.bigint();
    try {
      advance();
      recordTick(Number(process.hrtime.bigint() - t0) / 1e6);
    } catch (err) {
      // 仿真步进失败不应终止服务：暂停并广播，等待人工介入
      metrics.tickErrors += 1;
      metrics.simTicks += 1;
      logger.error('simulation tick failed', { error: String(err) });
      runtime.paused = true;
      broadcast({ type: 'notice', level: 'error', text: '仿真步进异常，已暂停。请检查参数或重置。' });
    }
  }, TICK_MS);

  pushTrend(runtime.net, runtime.trend);
  runAiCycle();
  runtime.net.controls.aiEnabled = true;

  server.listen(PORT, () => {
    logger.info('aquapilot listening', {
      url: `http://127.0.0.1:${PORT}`,
      ws: `ws://127.0.0.1:${PORT}/ws`,
      speed: runtime.speed,
      simMinutesPerTick: SIM_MINUTES_PER_TICK,
      persistence: store.enabled,
      authRequired: authRequired(),
      runId: RUN_ID,
    });
  });
}

process.on('SIGINT', () => {
  store.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.close();
  process.exit(0);
});

main().catch((err) => {
  logger.error('server failed to start', { error: String(err) });
  process.exit(1);
});

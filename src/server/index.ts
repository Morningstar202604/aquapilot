import { createServer, IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { answer, decide, Recommendation } from '../ai/agent';
import { askLlm, readLlmConfig, type GroundingContext } from '../ai/llm';
import { CONTROL_BOUNDS, LIMITS, PLANT } from '../sim/config';
import { SCENARIOS, ScenarioType } from '../sim/scenarios';
import { NetworkSimState, networkModel, qualityScoreOf, stepNetwork } from '../sim/networkEngine';
import { BSM1_SETTLER } from '../sim/takacs';
import { evaluateAlarms } from '../sim/alarmRules';
import { buildTankStates, buildTankPatch } from './tankStates';
import { aiCycleDue } from './aiCadence';
import { formatClockLong } from '../shared/time';
import type { ForecastOutcomeX } from '../sim/plantModel';
import { CompiledNetwork } from '../sim/network';
import { estimateMargin } from '../sim/metrics';
import { attributeAlarm, plantHealth, trendSlopes, type AlarmAttribution } from '../sim/alarmAttribution';
import type { ClientMessage, PlantSnapshot, ServerMessage, SnapshotPatch, TrendPoint } from '../shared/protocol';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../model/topology';
import { sanitizeTopologyInput } from '../model/topologyInput';
import { TopologyStore } from './topologyStore';
import { PRESETS, buildPreset, presetById } from '../model/presets';
import { applyTopology, checkRunReadiness, createRuntime } from './topologyRuntime';
import { Store } from './store';
import { authRequired, authorize } from './auth';
import { isApiPath, isPublicApiPath, isReadMethod, pathnameOf, shouldFallbackToIndex } from './httpRoutes';
import { logger, metrics, metricsJson, recordHttp, recordTick, renderPrometheus } from './observability';
import { buildOperationsReport, decisionsCsv, snapshotsCsv } from './export';
import { takeNewPoints, syncCursorToBuffer } from './trendCursor';
import { createShadowPlant, stepShadow, summarizeBenchmark, type ShadowPlant } from './benchmark';
import { llmConfigStore, sanitizeDraft } from './llmConfig';
import { assertSafeBaseUrl, discoverModels, testConnection } from '../ai/providers';
import { agentConfigStore } from './agentConfig';
import { HookRuntime } from './hooks';
import { parseAgentCommand } from './agentConfigCommands';
import { composeSystemPrompt } from '../ai/promptComposer';
import { buildReport, type CheckInput } from './watchdog';
import {
  CORE_PROTECTED,
  CONTROL_KEYS,
  checkAllowedControls,
  clampControlMoves,
  normalizeAgentConfig,
  type AgentConfig,
} from '../shared/agentConfig';
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
/** 人工调整后的 AI 静默期（仿真分钟） */
const MANUAL_OVERRIDE_MIN = 30;
const TREND_EVERY_TICKS = 10;

interface ClientState {
  /** 心跳存活标记：上一轮 ping 之后是否收到过 pong */
  alive: boolean;
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
  /** 上次模型发现/连接测试的时间，防止界面连续点击打爆第三方端点 */
  lastLlmAt: number;
  /** 上次手动重新推演的时间：推演是 ~200 ms 同步阻塞，必须限频 */
  lastDecisionAt: number;
  /** 上次 LLM 增强对话的时间：单条消息最多发起 4 次长超时出站请求 */
  lastChatAt: number;
  /** 已发送过全量快照：hello 每连接只允许一次 */
  helloSent: boolean;
  /** 上次触发全量快照广播的时间：小消息放大成 N×240 KB 的放大器 */
  lastSnapshotAt: number;
  /** 该连接在途的 LLM 请求数：限制并发避免一条连接打满出站配额 */
  llmInFlight: number;
}

/**
 * 每个 WS 连接一份的运行态。
 *
 * 之前 5 处各写一遍对象字面量，新增字段时漏掉一处就会变成 undefined，
 * 比较运算 `now - undefined` 恒为 NaN 而静默放行——限流形同虚设。
 */
function freshClientState(): ClientState {
  return {
    alive: true,
    lastControlAt: 0,
    lastTopologyAt: 0,
    lastTrendT: 0,
    lastLlmAt: 0,
    lastDecisionAt: 0,
    lastChatAt: 0,
    helloSent: false,
    lastSnapshotAt: 0,
    llmInFlight: 0,
  };
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
  /** 上次决策的仿真时刻（分钟）：决策节拍按仿真时间而不是 tick 次数 */
  lastDecisionAtMin: number;
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
let RUN_ID = `run-${Date.now().toString(36)}`;

/** 重置仿真时轮换运行标识：否则同一 run 下 at_min 从 0 重来，回放出现锯齿 */
function rotateRunId(): void {
  RUN_ID = `run-${Date.now().toString(36)}`;
}

/**
 * 启动时恢复上次保存的拓扑。
 *
 * 编排成果是「文档」：服务重启就回到标准厂会让用户拖过的布局、折点与增删的
 * 池子全部静默丢失。恢复失败（文件损坏/不可运行）时退回标准厂并在启动日志
 * 与自检里给出原因，绝不让服务起不来。
 */
const topologyStore = new TopologyStore();
const savedTopology = topologyStore.load();

const boot = (() => {
  if (savedTopology.restored) {
    try {
      const rt = createRuntime(savedTopology.topology, 20261019);
      return { runtime: rt, topology: savedTopology.topology, restored: true };
    } catch (err) {
      logger.warn('stored topology cannot run, falling back to standard plant', { error: String(err) });
    }
  }
  return { runtime: createRuntime(PLANT_TOPOLOGY, 20261019), topology: PLANT_TOPOLOGY, restored: false };
})();
const restoredFromDisk = boot.restored;
// 启动基线入历史：让"回滚到服务启动时的样子"始终可用
topologyStore.seedBaseline(boot.topology, 1, restoredFromDisk ? '启动恢复' : '标准厂基线');

const runtime: Runtime = {
  topology: boot.topology,
  compiled: boot.runtime.compiled,
  topologyRevision: restoredFromDisk ? 2 : 1,
  net: boot.runtime.net,
  paused: false,
  speed: 1,
  recommendation: null,
  trend: [],
  tick: 0,
  lastDecisionAtMin: 0,
  clients: new Set(),
  clientState: new Map(),
  manualOverrideUntil: 0,
  forecastCache: { key: null, value: null },
  activePresetId: restoredFromDisk ? null : 'a2o-standard',
  shadow: createShadowPlant(boot.topology, 20261019, 0),
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

  // 分池状态与增量帧同源（server/tankStates）；MLSS 口径如实标注
  const tanks = buildTankStates(s);

  const effluent = {
    ...s.effluent,
  };

  // 全量快照同样是「每客户端一次」：派生量先算一遍，别在对象字面量里重复调用
  const activeAlarms = currentAlarms(s);
  const margins = estimateMargin(effluent);
  const health = plantHealth({
    margins,
    lastDo: s.reactors[s.reactors.length - 1]?.doLevel ?? 0,
    doSetpoint: s.controls.doSetpoint,
    srtDays: s.srtDays,
    blanketM: s.clarifier.blanketM,
    depth: s.clarifier.depth,
    activeAlarms: activeAlarms.length,
  });
  const attribution = buildAttribution(s, activeAlarms);

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
      // 十层剖面：只读诊断量，给「泥在哪一层」一个可看的答案
      profile: s.clarifier.settler.x.map((v) => Number(v.toFixed(1))),
      feedLayer: BSM1_SETTLER.feedLayer,
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
    margins,
    alarms: s.alarms
      .slice(-20)
      .reverse()
      .map((a) => ({ ...a })),
    activeAlarms,
    alarmAttribution: attribution,
    health,
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
  const last = s.reactors[s.reactors.length - 1];
  return evaluateAlarms({
    effluent: s.effluent,
    lastDo: last?.doLevel ?? 0,
    srtDays: s.srtDays,
    blanketM: s.clarifier.blanketM,
    depth: s.clarifier.depth,
    atMin: s.timeMin,
  });
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
  /**
   * 每帧都会发出去的派生量只算一次。
   *
   * 旧实现里 currentAlarms 在同一个函数内被调用两次、estimateMargin 三次：
   * 每个客户端每秒多算几遍相同的规则表与排序。它们都是纯函数，
   * 一次算完再复用即可（多客户端时省的是 N 倍）。
   */
  const activeAlarms = currentAlarms(s);
  const margins = estimateMargin(s.effluent);
  const health = plantHealth({
    margins,
    lastDo: s.reactors[s.reactors.length - 1]?.doLevel ?? 0,
    doSetpoint: s.controls.doSetpoint,
    srtDays: s.srtDays,
    blanketM: s.clarifier.blanketM,
    depth: s.clarifier.depth,
    activeAlarms: activeAlarms.length,
  });
  const attribution = buildAttribution(s, activeAlarms);

  return {
    timeMin: s.timeMin,
    influentFlow: s.influent.flow,
    effluent: { ...s.effluent },
    tanks: buildTankPatch(s),
    clarifier: {
      blanketM: s.clarifier.blanketM,
      xRas: s.clarifier.xRas,
      xEff: s.clarifier.xEff,
      slr: s.clarifier.slr,
      profile: s.clarifier.settler.x.map((v) => Number(v.toFixed(1))),
    },
    energy: { ...s.energy, specificKwhM3: s.energy.totalKw / Math.max(1, s.influent.flow) },
    // 当日口径必须用 costToday：用累计值会让「今日运行成本」随仿真天数线性上涨
    cost: { totalToday: s.costToday.total, total: s.cost.total },
    srtDays: s.srtDays,
    fmRatio: s.fmRatio,
    // AI 会自动改写控制量：必须随增量下发，否则界面滑块停在用户上次拖的位置
    controls: s.controls,
    scenario: s.scenario,
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
    score: qualityScoreOf(s.effluent),
    margins,
    trendsAppend,
    alarms: s.alarms
      .slice(-20)
      .reverse()
      .map((a) => ({ ...a })),
    activeAlarms,
    alarmAttribution: attribution,
    health,
    stormStorageM3: s.stormStorageM3,
    reactorCount: s.reactors.length,
    /**
     * 预测扇区与双跑摘要也要随增量下发。
     *
     * 只在全量快照里带的话，客户端连接后趋势图的预测区与收益面板的
     * 「AI vs 固定策略」会永久冻结在连接那一刻——界面上看不出来，
     * 但那是假数据。两者都很小（几 KB），随帧发不会抵消增量收益。
     */
    forecastBand: runtime.recommendation?.ensemble ?? null,
    benchmark: summarizeBenchmark(runtime.shadow.benchmark),
  };
}

/**
 * 把当前活跃告警逐条归因。
 *
 * 只在服务端算一次：前端拿到的是"原因 + 动作 + 后果"，不需要重复实现工艺规则；
 * 归因函数本身是纯函数，测试可以脱离服务端跑。
 */
function buildAttribution(
  s: NetworkSimState,
  alarms: ReturnType<typeof currentAlarms> = currentAlarms(s),
): Record<string, AlarmAttribution> {
  const slopes = trendSlopes(runtime.trend, s.effluent.bod);
  const last = s.reactors[s.reactors.length - 1];
  const out: Record<string, AlarmAttribution> = {};
  for (const alarm of alarms) {
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

/**
 * 背压保护：发送队列堆积说明对端不读数据。
 *
 * 入站有 maxPayload 限制，出站此前完全没有：一个连上就暂停读取的客户端
 * 会让每帧增量在服务端内存里无限排队。超过阈值直接断开，
 * 客户端重连后自然会重新对齐（趋势游标按时间戳，重连安全）。
 */
function sendGuarded(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    logger.warn('ws send buffer overflow, terminating slow client', { buffered: ws.bufferedAmount });
    metrics.rateLimited += 1;
    ws.terminate();
    return;
  }
  ws.send(payload);
}

function broadcastPatch(): void {
  for (const ws of runtime.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const client = runtime.clientState.get(ws) ?? freshClientState();
    const patch = buildPatch(client);
    runtime.clientState.set(ws, client);
    if (patch) sendGuarded(ws, JSON.stringify({ type: 'snapshotPatch', data: patch } satisfies ServerMessage));
  }
}

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const ws of runtime.clients) sendGuarded(ws, payload);
}

/**
 * 广播全量快照。
 *
 * 全量快照已经带上整段趋势，必须同时把每个客户端的增量游标对齐到缓冲末尾：
 * - 不对齐 → 下一帧把同一段趋势再发一遍；
 * - 重置/换拓扑后缓冲从 t=0 重来 → 游标停在旧高点，趋势永久静止（真实缺陷）。
 */
function broadcastSnapshot(): void {
  broadcast({ type: 'snapshot', data: buildSnapshot() });
  for (const ws of runtime.clients) {
    const client = runtime.clientState.get(ws) ?? freshClientState();
    syncCursorToBuffer(runtime.trend, client);
    runtime.clientState.set(ws, client);
  }
}

/** 单发给一个连接的全量快照（hello / 重连），同样需要对齐趋势游标 */
function sendSnapshotTo(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: 'snapshot', data: buildSnapshot() } satisfies ServerMessage));
  const client = runtime.clientState.get(ws) ?? freshClientState();
  syncCursorToBuffer(runtime.trend, client);
  runtime.clientState.set(ws, client);
}

/**
 * 钩子运行时接线。
 *
 * notice 走广播、skill 只登记命中（其内容在下一轮对话的 system prompt 里出现）、
 * webhook 用内置 fetch 出站（SSRF 已在 hooks.ts 里校验）。
 */
const hooksRuntime = new HookRuntime({
  notice: (text, level) => broadcast({ type: 'notice', level, text: `[钩子] ${text}` }),
  skill: (skillId) =>
    broadcast({ type: 'notice', level: 'info', text: `[钩子] 已命中技能 ${skillId}，下一轮回答会引用其步骤` }),
  logLine: (text, level, hook) => logger[level](text, { hook: hook.name, event: hook.event }),
  webhook: async (url, body, hook) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      /**
       * 不跟随重定向。
       *
       * 钩子目标是用户可写的信任边界输入：校验只看得到第一跳，
       * 若默认 follow，一个公网地址 302 到 `http://169.254.169.254/…`
       * 就能把请求打进云元数据。`manual` 下 3xx 直接按失败处理。
       */
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Aquapilot-Hook': hook.id },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        hookFailures += 1;
        logger.warn('hook webhook redirect rejected', { hook: hook.name, status: res.status });
        return false;
      }
      if (!res.ok) {
        hookFailures += 1;
        logger.warn('hook webhook non-2xx', { hook: hook.name, status: res.status });
      }
      return res.ok;
    } catch (err) {
      hookFailures += 1;
      logger.warn('hook webhook failed', { hook: hook.name, error: String(err) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
});

/** 告警钩子：只为本 tick 新出现的告警触发一次 */
function fireAlarmHooks(seen: Set<string>): void {
  const cfg = agentConfigStore.get();
  const s = runtime.net;
  const recent = s.alarms.slice(-10);
  for (const alarm of currentAlarms(s)) {
    if (seen.has(alarm.code)) continue;
    seen.add(alarm.code);
    /**
     * 落库：Store 早已有 alarms 表与 recordAlarm，但从未被调用，
     * `/api/history/stats` 的告警计数永远是 0，事故复盘也查不到告警时间线。
     * 以当前仿真时刻为准写一条，重复 code 在 currentAlarms 层面已去重。
     */
    const persisted = recent.find((a) => a.code === alarm.code && a.at === s.timeMin);
    store.recordAlarm({
      runId: RUN_ID,
      id: persisted?.id ?? `LIVE-${alarm.code}-${Math.round(s.timeMin)}`,
      atMin: s.timeMin,
      severity: alarm.severity,
      code: alarm.code,
      message: alarm.message,
    });
    void hooksRuntime.fire(cfg, {
      event: 'alarm',
      detail: `${alarm.code} ${alarm.message}`,
      key: alarm.code,
    });
  }
}

const seenAlarmCodes = new Set<string>();

/**
 * 运行自检：每 10 秒跑一次确定性检查，变化时广播给所有客户端。
 *
 * 「派 AI 全程盯着日志」在这里落成了一个可复核的机制：
 * 检查项是代码里的纯函数，报告带结论与下一步动作，界面直接展示。
 */
let lastWatchdogAt = 0;
let lastWatchdogSnapshot = '';
let lastSimMinutes = 0;
let hookFailures = 0;

function watchdogInput(): CheckInput {
  const status = agentConfigStore.status();
  const llmRuntime = llmConfigStore.getRuntime();
  const simMinutes = runtime.net.timeMin;
  return {
    tickErrors: metrics.tickErrors,
    tickDelta: simMinutes - lastSimMinutes,
    lastTickMs: metrics.lastTickMs,
    simulationMinutes: simMinutes,
    paused: runtime.paused,
    wsActive: metrics.wsActive,
    llmCalls: metrics.llmCalls,
    llmFallbacks: metrics.llmFallbacks,
    persistence: store.enabled ? 'enabled' : 'disabled',
    persistenceErrors: metrics.persistenceErrors,
    agentWarnings: status.warnings.length,
    agentPermission: status.config.permission,
    hookFailures,
    llmConfigured: llmRuntime !== null || readLlmConfig() !== null,
    configPath: status.path,
  };
}

function runWatchdog(): void {
  const now = Date.now();
  if (now - lastWatchdogAt < 10_000) return;
  lastWatchdogAt = now;
  const report = buildReport(watchdogInput());
  lastSimMinutes = runtime.net.timeMin;
  const snapshot = report.checks.map((c) => `${c.id}:${c.severity}`).join(',');
  // 只在结论变化时广播：10 秒一次的相同结论会把面板刷成噪音
  if (snapshot !== lastWatchdogSnapshot) {
    lastWatchdogSnapshot = snapshot;
    logger.info('watchdog report', { severity: report.severity, checks: report.checks.length });
    broadcast({ type: 'watchdog', report });
  }
}

function runAiCycle(force = false): Recommendation {
  /**
   * 记录本次决策时刻：强制决策（换拓扑、手动刷新）同样要把节拍基准前移，
   * 否则下一次自然决策会在几秒后又跑一遍。
   */
  runtime.lastDecisionAtMin = runtime.net.timeMin;
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
  // 约束生效：AI 的第 4 道护栏。allowedControls 之外的控制量保持原值，
  // 单步幅度按配置限幅，人工确认模式下不自动执行。
  const agentCfg = agentConfigStore.get();
  const constrained: Recommendation = { ...rec, chosens: { ...rec.chosens, controls: { ...rec.chosens.controls } } };
  for (const key of CONTROL_KEYS) {
    if (!agentCfg.constraints.allowedControls.includes(key)) {
      constrained.chosens.controls[key] = runtime.net.controls[key] as never;
    }
  }
  constrained.chosens.controls = clampControlMoves(
    runtime.net.controls,
    constrained.chosens.controls,
    agentCfg.constraints.maxStepPct,
  );
  constrained.chosens.controls.aiEnabled = runtime.net.controls.aiEnabled;
  runtime.recommendation = constrained;
  rec = constrained;
  void hooksRuntime.fire(agentCfg, {
    event: 'decision',
    detail: `${rec.action} ${rec.summary}`,
    key: rec.action,
  });

  // 人工优先期内不自动执行，只记录建议
  const inManualWindow = runtime.net.timeMin < runtime.manualOverrideUntil;
  if (inManualWindow && !force) {
    broadcast({ type: 'decision', data: rec });
    return rec;
  }

  const needsApproval = agentCfg.constraints.requireHumanApproval;
  if (runtime.net.controls.aiEnabled && !needsApproval && (rec.action !== 'hold' || force)) {
    runtime.net.controls = rec.chosens.controls;
    runtime.net.controls.aiEnabled = true;
    broadcast({
      type: 'notice',
      level: rec.severity === 'critical' ? 'warn' : 'info',
      text: `AI 已执行：${rec.summary}`,
    });
  } else if (needsApproval && rec.action !== 'hold') {
    broadcast({ type: 'notice', level: 'info', text: `AI 建议（待人工确认）：${rec.summary}` });
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
  // 告警钩子：新出现的告警才触发，消失后从集合里移除，允许下次重新触发
  const activeCodes = new Set(currentAlarms(s).map((a) => a.code));
  for (const code of seenAlarmCodes) if (!activeCodes.has(code)) seenAlarmCodes.delete(code);
  fireAlarmHooks(seenAlarmCodes);
  // 每 10 个仿真分钟抽一个快照点（tick 按 1 分钟推进），用于回放与导出
  if (runtime.tick % 10 === 0) {
    store.recordSnapshot({
      runId: RUN_ID,
      atMin: s.timeMin,
      effluentCod: s.effluent.cod,
      effluentNh: s.effluent.nh,
      effluentTn: s.effluent.tn,
      effluentTp: s.effluent.tp,
      effluentSs: s.effluent.ss,
      mlss: (s.biomassKg * 1000) / Math.max(1, s.volume.bio),
      srtDays: s.srtDays,
      energyKw: s.energy.totalKw,
      score: qualityScoreOf(s.effluent),
    });
  }

  /**
   * 决策节拍按仿真时间，不按 tick 次数。
   *
   * 旧实现 `aiTick % 30`：1× 时 60 仿真分钟一次，4× 时 240 分钟一次——
   * 倍速越高决策越迟钝，与界面承诺的「每 15 分钟仿真时间」不符。
   */
  if (aiCycleDue(runtime.lastDecisionAtMin, s.timeMin)) {
    runAiCycle();
  }
  runWatchdog();
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
  /** 一次推演 ≈200 ms 同步阻塞：2 s 一次足够操作员连点，又不会把 tick 挤掉 */
  decisionMs: 2000,
  /** 聊天会触发最多 4 次长超时出站请求（含推理模型 60 s） */
  chatMs: 1500,
  /** 全量快照约 240 KB：同一连接 1 s 内只允许触发一次广播 */
  snapshotMs: 1000,
};

/** 单连接同时允许的在途 LLM 请求数 */
const MAX_LLM_IN_FLIGHT = 2;

/** 同时在线连接上限：限流状态按连接维护，必须限制连接数才能封住放大效应 */
const MAX_WS_CLIENTS = 50;

/** 慢客户端阈值：发送队列超过该字节数说明对端不读，继续排队只会吃满内存 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

function rateLimited(ws: WebSocket, kind: 'control' | 'topology' | 'decision' | 'chat' | 'snapshot'): boolean {
  const state = runtime.clientState.get(ws) ?? freshClientState();
  const now = Date.now();
  if (kind === 'control') {
    if (now - state.lastControlAt < RATE_LIMIT.controlMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastControlAt = now;
  } else if (kind === 'decision') {
    if (now - state.lastDecisionAt < RATE_LIMIT.decisionMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastDecisionAt = now;
  } else if (kind === 'chat') {
    if (now - state.lastChatAt < RATE_LIMIT.chatMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastChatAt = now;
  } else if (kind === 'snapshot') {
    if (now - state.lastSnapshotAt < RATE_LIMIT.snapshotMs) {
      metrics.rateLimited += 1;
      return true;
    }
    state.lastSnapshotAt = now;
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
    simClock: formatClockLong(s.timeMin),
    facts,
    recommendation: rec ? rec.summary : null,
    risks: rec ? rec.risks : [],
  };
}

async function enhanceWithLlm(ws: WebSocket, question: string, ruleAnswer: ReturnType<typeof answer>): Promise<void> {
  const started = Date.now();
  const grounding = buildLlmGrounding(question);
  const agentCfg = agentConfigStore.get();
  // 角色、提示词、约束、技能在这里真正拼进 system prompt；
  // 运行数据仍由 grounding 单独提供，两者职责不混。
  const composed = composeSystemPrompt({ config: agentCfg, question });
  /**
   * 请求预算必须按「回答长度」算，而不是用模型的 maxOutput。
   *
   * 曾用 maxOutput=131072 直接当 max_tokens：推理模型会把整段预算烧在
   * reasoning 上，一次回答跑满 12 秒超时——表现就是「模型补充」永远不出现。
   * 中文约 1.5–2 字/token，留 2 倍余量再加推理开销即可。
   */
  const runtime = llmConfigStore.getRuntime();
  const reasoningModel = llmConfigStore.getPublic()?.capabilities.reasoning ?? false;
  const thinkingOn = !runtime || runtime.reasoningEffort === 'auto' || runtime.reasoningEffort === 'low';
  const outputBudget =
    reasoningModel && thinkingOn
      ? 4096
      : Math.min(4096, Math.max(512, Math.round(agentCfg.constraints.maxAnswerChars * 3 + 600)));
  /**
   * 推理模型实测：u2-flash 在 840/2048 token 预算下会把预算全部烧在
   * reasoning 上、content 仍为空（耗时 17s/39s），4096 才稳定输出正文（约 48s）。
   * 因此推理链路必须给足预算与超时，否则「配好了却永远没有补充」。
   */
  const llmTimeoutMs = reasoningModel && thinkingOn ? 60000 : 25000;
  // 界面保存的配置优先；没有才落回环境变量，保持既有部署方式可用
  const saved = llmConfigStore.getRuntime();
  const result = await askLlm(
    question,
    grounding,
    saved
      ? {
          baseUrl: saved.baseUrl,
          apiKey: saved.apiKey,
          model: saved.model,
          timeoutMs: llmTimeoutMs,
          protocol: saved.protocol,
          maxOutput: outputBudget,
          reasoningEffort: saved.reasoningEffort,
        }
      : readLlmConfig(),
    composed.prompt,
  );
  metrics.llmCalls += 1;
  if (!result.ok) {
    metrics.llmFallbacks += 1;
    logger.debug('llm fallback', { reason: result.reason, ms: Date.now() - started });
    /**
     * 数字白名单没通过时做一次「零数字」重试。
     *
     * 推理模型很容易写出「4 小时内」「87%」这类派生数字，被 fail-closed 拦下后
     * 用户看到的就是「没有模型补充」，却不知道原因。第二次明确要求不写任何
     * 未提供数字，绝大多数情况能拿到可用文本。
     */
    if (result.reason === 'ungrounded-numbers') {
      const strict = `${composed.prompt}

【最后一次机会】只允许使用数据中已出现的数字；不要写时长、百分比、温度、倍数等任何新增数值。宁可不写数字，也不要推算。`;
      const retry = await askLlm(
        question,
        grounding,
        saved
          ? {
              baseUrl: saved.baseUrl,
              apiKey: saved.apiKey,
              model: saved.model,
              timeoutMs: llmTimeoutMs,
              protocol: saved.protocol,
              maxOutput: outputBudget,
              reasoningEffort: saved.reasoningEffort,
            }
          : readLlmConfig(),
        strict,
      );
      metrics.llmCalls += 1;
      if (!retry.ok) {
        metrics.llmFallbacks += 1;
        // 失败必须可见：否则「配置好了却没补充」无法自查
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'warn',
            text: `模型补充未生成（${reasonText(result.reason)}），已保留规则答案。可在「自检」页查看链路状态。`,
          } satisfies ServerMessage),
        );
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
            body: retry.text,
            bullets: [],
            source: 'llm',
            persona: agentCfg.persona.name,
            matchedSkills: composed.matchedSkills,
          },
        } satisfies ServerMessage),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        type: 'notice',
        level: 'warn',
        text: `模型补充未生成（${reasonText(result.reason)}），已保留规则答案。`,
      } satisfies ServerMessage),
    );
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
        persona: agentCfg.persona.name,
        matchedSkills: composed.matchedSkills,
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
      /**
       * hello 每连接只允许一次。
       *
       * 全量快照含 720 个趋势点（约 240 KB），而 hello 消息只有几十字节：
       * 不设限的话单连接循环发 hello 就能把 CPU 与带宽打满。
       */
      const helloState = runtime.clientState.get(ws) ?? freshClientState();
      if (helloState.helloSent) {
        metrics.invalidMessages += 1;
        break;
      }
      helloState.helloSent = true;
      runtime.clientState.set(ws, helloState);
      sendSnapshotTo(ws);
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
      /**
       * 聊天限流：每条消息最多触发 4 次长超时出站 LLM 请求
       * （两套请求预算 × 数字校验失败后的整轮重试，推理模型单次 60 s）。
       * 不限流时一条连接即可堆满内存与第三方配额。
       */
      if (rateLimited(ws, 'chat')) {
        ws.send(
          JSON.stringify({ type: 'notice', level: 'warn', text: '提问过于频繁，请稍后再试' } satisfies ServerMessage),
        );
        break;
      }
      const chatState = runtime.clientState.get(ws) ?? freshClientState();
      if (chatState.llmInFlight >= MAX_LLM_IN_FLIGHT) {
        metrics.rateLimited += 1;
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'warn',
            text: '上一条回答仍在生成，请等它完成',
          } satisfies ServerMessage),
        );
        break;
      }
      // 对话式配置：命令先于规则引擎处理，命中即回执并不再走问答
      const agentCfgForChat = agentConfigStore.get();
      const cmd = parseAgentCommand(text, agentCfgForChat);
      if (cmd.handled) {
        if (cmd.next) {
          const outcome = agentConfigStore.save(cmd.next, { writer: 'chat' });
          if (!outcome.ok) {
            ws.send(
              JSON.stringify({
                type: 'chat',
                question: text,
                answer: {
                  title: '配置未生效',
                  body: outcome.error ?? '保存失败',
                  bullets: [],
                  confidence: 0.9,
                  kind: 'editor',
                  source: 'rule',
                },
              } satisfies ServerMessage),
            );
            break;
          }
          void hooksRuntime.fire(agentConfigStore.get(), {
            event: 'config',
            detail: cmd.command ?? 'chat',
            key: cmd.command,
          });
          const warn = outcome.warnings.length > 0 ? `\n（${outcome.warnings.join('；')}）` : '';
          ws.send(
            JSON.stringify({
              type: 'chat',
              question: text,
              answer: {
                title: `配置已更新 · ${cmd.command ?? 'chat'}`,
                body: `${cmd.reply ?? '已完成'}${warn}`,
                bullets: [],
                confidence: 0.95,
                kind: 'editor',
                source: 'rule',
              },
            } satisfies ServerMessage),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: 'chat',
              question: text,
              answer: {
                title: cmd.error ? '命令未执行' : `配置查询 · ${cmd.command ?? 'list'}`,
                body: cmd.reply ?? '',
                bullets: [],
                confidence: 0.95,
                kind: 'editor',
                source: 'rule',
              },
            } satisfies ServerMessage),
          );
        }
        break;
      }

      const ruleAnswer = answer(text, networkModel(runtime.topology, runtime.net), runtime.recommendation);
      ws.send(JSON.stringify({ type: 'chat', question: text, answer: ruleAnswer } satisfies ServerMessage));

      /**
       * LLM 增强（可选，异步）。
       *
       * 先发规则答案保证「任何配置下都有回答」，再尝试 LLM 追问一条补充。
       * 失败只记指标，不打扰用户——用户已经看到可用答案。
       *
       * 在途计数必须成对增减：它保证单连接不会堆满长超时出站请求，
       * 漏掉 finally 会让一次超时永久占掉一个名额（最终把聊天卡死）。
       */
      const trackState = runtime.clientState.get(ws) ?? freshClientState();
      trackState.llmInFlight += 1;
      runtime.clientState.set(ws, trackState);
      void enhanceWithLlm(ws, text, ruleAnswer).finally(() => {
        const cur = runtime.clientState.get(ws);
        if (cur) cur.llmInFlight = Math.max(0, cur.llmInFlight - 1);
      });
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
      // 约束生效：allowedControls 之外的量，手动也不允许写。
      // 这是「约束工程」对人工通道同样生效的关键——否则界面能拖、服务端照收。
      const allowedCheck = checkAllowedControls(
        result.value as Record<string, unknown> as Partial<Record<string, unknown>>,
        agentConfigStore.get().constraints.allowedControls,
      );
      if (!allowedCheck.ok) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: `该控制量已被约束禁用：${allowedCheck.rejected.join('、')}。可在「Agent 设置 → 约束」里放开。`,
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
      if (!rateLimited(ws, 'snapshot')) broadcastSnapshot();
      break;
    }
    case 'applyRecommendation': {
      if (!runtime.recommendation) return;
      if (rateLimited(ws, 'snapshot')) break;
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
      if (msg.action !== 'pause' && msg.action !== 'resume' && msg.action !== 'reset') {
        metrics.invalidMessages += 1;
        ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '未知的仿真操作' } satisfies ServerMessage));
        break;
      }
      if (rateLimited(ws, 'snapshot')) break;
      if (msg.action === 'pause') runtime.paused = true;
      if (msg.action === 'resume') runtime.paused = false;
      if (msg.action === 'reset') {
        rotateRunId();
        runtime.net = createRuntime(runtime.topology, 20261019).net;
        runtime.shadow = createShadowPlant(runtime.topology, 20261019, 0);
        runtime.trend = [];
        runtime.recommendation = null;
        runtime.tick = 0;
        runtime.lastDecisionAtMin = 0;
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
      /**
       * 「重新推演」是一个昂贵的同步操作（≈200 ms，含 3 组扰动轨迹）。
       * 之前没有限流：连点或恶意脚本可以把主线程钉死、tick 全部积压。
       * 与拓扑变更共用一套客户端限流，间隔 2 s；被拦时给出明确提示。
       */
      if (rateLimited(ws, 'decision')) {
        ws.send(
          JSON.stringify({
            type: 'notice',
            level: 'warn',
            text: '推演过于频繁，请 2 秒后再试',
          } satisfies ServerMessage),
        );
        break;
      }
      runAiCycle(true);
      broadcastSnapshot();
      break;
    }
    case 'preset': {
      /**
       * 切换模板会重建运行时并预热 30 天（21600 次 stepNetwork，实测 400 ms 级）。
       * 与拓扑变更同等代价，必须共用同一限流；此前完全没限，连点即打停 tick。
       */
      if (rateLimited(ws, 'topology')) {
        ws.send(
          JSON.stringify({ type: 'notice', level: 'error', text: '工艺切换过于频繁，请稍后再试' } satisfies ServerMessage),
        );
        break;
      }
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
      topologyStore.save(runtime.topology, runtime.topologyRevision, `切换模板：${preset.name}`);
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
      if (msg.action === 'history') {
        const requestId = (msg as { requestId?: unknown }).requestId;
        ws.send(
          JSON.stringify({
            type: 'topologyHistory',
            requestId: typeof requestId === 'string' ? requestId : undefined,
            versions: topologyStore.history(),
          } satisfies ServerMessage),
        );
        break;
      }
      if (msg.action === 'revert') {
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
        const revision = (msg as { revision?: unknown }).revision;
        if (typeof revision !== 'number' || !Number.isFinite(revision)) {
          ws.send(
            JSON.stringify({ type: 'notice', level: 'error', text: '回滚目标版本不合法' } satisfies ServerMessage),
          );
          break;
        }
        /**
         * 回滚 = 以旧内容创建一个新 revision。
         *
         * 不把 revision 指针拨回去：客户端的增量判断、审计链、持久化都按
         * 单调递增的 revision 工作，倒退会让"最新"变成歧义。
         * 取出的历史条目在写入时已过 sanitize，这里再走与 apply 完全相同的
         * readiness + 编译 + 预热路径（fail-closed）。
         */
        const target = topologyStore.version(revision);
        if (!target) {
          ws.send(
            JSON.stringify({
              type: 'notice',
              level: 'error',
              text: `找不到第 ${revision} 版拓扑`,
            } satisfies ServerMessage),
          );
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
          result = applyTopology(rt, target);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ws.send(
            JSON.stringify({ type: 'notice', level: 'error', text: `回滚失败：${reason}` } satisfies ServerMessage),
          );
          break;
        }
        if (!result.ok) {
          ws.send(
            JSON.stringify({
              type: 'notice',
              level: 'error',
              text: `第 ${revision} 版当前不可运行：${result.blockers[0] ?? '未知原因'}`,
            } satisfies ServerMessage),
          );
          break;
        }
        runtime.net = rt.net;
        runtime.compiled = rt.compiled;
        runtime.topology = target;
        runtime.topologyRevision += 1;
        topologyStore.save(runtime.topology, runtime.topologyRevision, `回滚到 v${revision}`);
        runtime.activePresetId = null;
        runtime.recommendation = null;
        runtime.trend = [];
        runtime.shadow = createShadowPlant(runtime.topology, runtime.net.seed, runtime.net.timeMin);
        pushTrend(runtime.net, runtime.trend);
        runAiCycle(true);
        broadcast({
          type: 'notice',
          level: 'info',
          text: `已回滚到第 ${revision} 版；当前为第 ${runtime.topologyRevision} 版，厂已重建并完成预热。`,
        });
        broadcast({ ...topologyMessage() } satisfies ServerMessage);
        ws.send(JSON.stringify({ type: 'topologyHistory', versions: topologyStore.history() } satisfies ServerMessage));
        broadcastSnapshot();
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
        /**
         * 信任边界：先把任意 JSON 收成合法拓扑，再交给引擎。
         *
         * 此前只检查 `Array.isArray(units)` 就 `as ProcessTopology`：
         * units 里的 null、NaN 容积、超长主序列都会原样进入 compileNetwork，
         * 轻则应用失败，重则每个 tick 抛错把仿真停掉。
         */
        const sanitized = sanitizeTopologyInput(incoming);
        if (!sanitized.ok) {
          metrics.invalidMessages += 1;
          logger.warn('topology apply rejected', { reason: sanitized.error });
          ws.send(
            JSON.stringify({
              type: 'notice',
              level: 'error',
              text: `拓扑结构不合法：${sanitized.error}`,
            } satisfies ServerMessage),
          );
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
          result = applyTopology(rt, sanitized.topology);
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
        runtime.topology = sanitized.topology;
        runtime.topologyRevision += 1;
        topologyStore.save(runtime.topology, runtime.topologyRevision, '应用自定义拓扑');
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
    case 'llmConfig': {
      void handleLlmConfig(ws, msg as Extract<ClientMessage, { type: 'llmConfig' }>);
      break;
    }
    case 'agentConfig': {
      void handleAgentConfig(ws, msg as Extract<ClientMessage, { type: 'agentConfig' }>);
      break;
    }
    case 'watchdog': {
      const report = buildReport(watchdogInput());
      ws.send(JSON.stringify({ type: 'watchdog', report } satisfies ServerMessage));
      break;
    }
    default:
      break;
  }
}

/**
 * 自定义模型配置（界面驱动）。
 *
 * 全部走 WS 的 request/response，附带 requestId 以便前端丢弃过期响应。
 * 发现与测试是出站网络请求：带超时、限流，失败只回错误文本。
 */
const LLM_RATE_LIMIT_MS = 800;

async function handleLlmConfig(ws: WebSocket, msg: Extract<ClientMessage, { type: 'llmConfig' }>): Promise<void> {
  const requestId = 'requestId' in msg ? msg.requestId : undefined;
  const send = (payload: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  if (msg.action === 'get') {
    send({ type: 'llmConfig', action: 'config', requestId, config: llmConfigStore.getPublic() });
    return;
  }

  if (msg.action === 'clear') {
    llmConfigStore.clear();
    send({ type: 'llmConfig', action: 'saved', requestId: requestId ?? '', ok: true });
    return;
  }

  const state = runtime.clientState.get(ws) ?? freshClientState();
  const now = Date.now();
  if (now - state.lastLlmAt < LLM_RATE_LIMIT_MS) {
    send({ type: 'llmConfig', action: 'error', requestId, error: '操作过于频繁，请稍后再试' });
    return;
  }
  state.lastLlmAt = now;
  runtime.clientState.set(ws, state);

  if (msg.action === 'discover') {
    if (typeof msg.baseUrl !== 'string' || msg.baseUrl.length > 500) {
      send({ type: 'llmConfig', action: 'error', requestId: msg.requestId, error: 'Base URL 不合法' });
      return;
    }
    try {
      if (llmConfigStore.hasKeyForOtherOrigin(msg.baseUrl) && !(typeof msg.apiKey === 'string' && msg.apiKey.trim())) {
        send({
          type: 'llmConfig',
          action: 'error',
          requestId: msg.requestId,
          error: '目标地址与已保存配置不同源，请重新填写 API Key（已保存的密钥不会发往新地址）',
        });
        return;
      }
      const models = await discoverModels({
        protocol: msg.protocol,
        baseUrl: msg.baseUrl,
        apiKey: llmConfigStore.resolveKey(
          typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '',
          msg.baseUrl,
        ),
      });
      send({ type: 'llmConfig', action: 'discovered', requestId: msg.requestId, models });
    } catch (err) {
      send({ type: 'llmConfig', action: 'error', requestId: msg.requestId, error: errorText(err) });
    }
    return;
  }

  if (msg.action === 'test') {
    if (typeof msg.baseUrl !== 'string' || typeof msg.model !== 'string' || !msg.model.trim()) {
      send({ type: 'llmConfig', action: 'error', requestId: msg.requestId, error: '请先填写地址与模型' });
      return;
    }
    if (llmConfigStore.hasKeyForOtherOrigin(msg.baseUrl) && !(typeof msg.apiKey === 'string' && msg.apiKey.trim())) {
      send({
        type: 'llmConfig',
        action: 'error',
        requestId: msg.requestId,
        error: '目标地址与已保存配置不同源，请重新填写 API Key（已保存的密钥不会发往新地址）',
      });
      return;
    }
    const result = await testConnection({
      protocol: msg.protocol,
      baseUrl: msg.baseUrl,
      apiKey: llmConfigStore.resolveKey(
        typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '',
        msg.baseUrl,
      ),
      model: msg.model.trim(),
      maxOutput: typeof msg.maxOutput === 'number' ? msg.maxOutput : undefined,
    });
    send({ type: 'llmConfig', action: 'tested', requestId: msg.requestId, result });
    return;
  }

  if (msg.action === 'save') {
    const parsed = sanitizeDraft(msg.draft);
    if (!parsed.ok) {
      send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: false, error: parsed.error });
      return;
    }
    const saved = llmConfigStore.save(parsed.draft);
    if (!saved.ok) {
      send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: false, error: saved.error });
      return;
    }
    send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: true, config: saved.config });
    return;
  }

  send({ type: 'llmConfig', action: 'error', requestId, error: '未知的配置动作' });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return '请求失败';
}

/** LLM 降级原因 → 界面可读文案（不暴露内部实现细节） */
function reasonText(reason: string | null): string {
  switch (reason) {
    case 'not-configured':
      return '尚未配置模型';
    case 'timeout':
      return '模型响应超时，可换更快的模型或在模型设置里降低输出上限';
    case 'network-error':
      return '无法连接模型端点';
    case 'empty-response':
      return '模型没有返回内容';
    case 'ungrounded-numbers':
      return '回答包含未经数据支持的数字，已被事实校验拦下';
    default:
      return reason?.startsWith('http-') ? `模型端点返回 ${reason.slice(5)}` : '调用失败';
  }
}

/**
 * Agent 配置（界面驱动）。
 *
 * 与 llmConfig 同一套 request/response 模式；写入统一走 agentConfigStore.save，
 * 权限与核心保护在存储层实现，因此界面、对话命令、CLI 三条路径行为一致。
 */
function agentStateMessage(requestId?: string, previewQuestion?: string, previewConfig?: AgentConfig): ServerMessage {
  const status = agentConfigStore.status();
  const cfg = previewConfig ?? status.config;
  return {
    type: 'agentConfig',
    action: 'state',
    requestId,
    config: status.config,
    summary: status.summary,
    warnings: status.warnings,
    coreProtected: [...CORE_PROTECTED],
    promptPreview:
      previewQuestion === undefined
        ? undefined
        : composeSystemPrompt({ config: cfg, question: previewQuestion }).prompt,
  };
}

function broadcastAgentState(): void {
  broadcast(agentStateMessage());
}

async function handleAgentConfig(ws: WebSocket, msg: Extract<ClientMessage, { type: 'agentConfig' }>): Promise<void> {
  const requestId = 'requestId' in msg ? msg.requestId : undefined;
  const send = (payload: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };
  try {
    if (msg.action === 'get') {
      send(agentStateMessage(requestId));
      return;
    }
    if (msg.action === 'previewPrompt') {
      const question = typeof msg.question === 'string' ? msg.question.slice(0, 200) : '现在运行怎么样';
      let previewConfig: AgentConfig | undefined;
      if (msg.config) {
        try {
          previewConfig = normalizeAgentConfig(msg.config).config;
        } catch {
          previewConfig = undefined;
        }
      }
      send(agentStateMessage(msg.requestId, question, previewConfig));
      return;
    }
    if (msg.action === 'reset') {
      const outcome = agentConfigStore.reset({ writer: 'ui' });
      send({
        type: 'agentConfig',
        action: 'saved',
        requestId: msg.requestId,
        ok: outcome.ok,
        config: outcome.config,
        summary: outcome.summary,
        warnings: outcome.warnings,
        error: outcome.error,
      });
      if (outcome.ok) {
        broadcastAgentState();
        void hooksRuntime.fire(agentConfigStore.get(), { event: 'config', detail: 'reset', key: 'reset' });
      }
      return;
    }
    if (msg.action === 'importSkill') {
      const status = agentConfigStore.status();
      const cfg = JSON.parse(JSON.stringify(status.config)) as typeof status.config;
      if (cfg.skills.length >= 30) {
        send({ type: 'agentConfig', action: 'error', requestId, error: '技能最多 30 个' });
        return;
      }
      const incoming = msg.skill;
      const name = typeof incoming?.name === 'string' ? incoming.name.trim().slice(0, 80) : '';
      let content = typeof incoming?.content === 'string' ? incoming.content.trim().slice(0, 12000) : '';
      let fetchedSkillTitle = '';
      /**
       * URL 导入：这里做的是服务端抓取，不是浏览器跳转。
       * 只允许 http(s)，走 SSRF 守卫，10 秒超时，抓回来的正文当作技能内容；
       * 抓取失败不静默——直接把可读原因回给界面。
       */
      if (!content && typeof incoming?.url === 'string' && incoming.url.trim()) {
        try {
          const url = assertSafeBaseUrl(incoming.url.trim());
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          try {
            const res = await fetch(url.toString(), { signal: controller.signal });
            if (!res.ok) {
              send({ type: 'agentConfig', action: 'error', requestId, error: `导入失败：HTTP ${res.status}` });
              return;
            }
            const text = (await res.text()).trim();
            if (!text) {
              send({ type: 'agentConfig', action: 'error', requestId, error: '导入失败：目标返回空内容' });
              return;
            }
            fetchedSkillTitle = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
            content = text.slice(0, 12000);
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          send({ type: 'agentConfig', action: 'error', requestId, error: `导入失败：${errorText(err)}` });
          return;
        }
      }
      if (!name && !content) {
        send({ type: 'agentConfig', action: 'error', requestId, error: '导入技能需要名称与正文（或可抓取的 URL）' });
        return;
      }
      const finalName = (name || fetchedSkillTitle || '导入技能').slice(0, 80);
      const triggers = Array.isArray(incoming.triggers)
        ? incoming.triggers
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().slice(0, 24))
            .filter(Boolean)
            .slice(0, 12)
        : [];
      cfg.skills.push({
        id: `s-import-${Date.now().toString(36)}`,
        name: finalName,
        description: typeof incoming.description === 'string' ? incoming.description.slice(0, 200) : '',
        triggers: triggers.length > 0 ? triggers : [finalName],
        content,
        enabled: true,
        source: 'remote',
        url: typeof incoming.url === 'string' ? incoming.url.slice(0, 500) : undefined,
      });
      const outcome = agentConfigStore.save(cfg, { writer: 'ui' });
      send({
        type: 'agentConfig',
        action: 'saved',
        requestId: msg.requestId,
        ok: outcome.ok,
        config: outcome.config,
        summary: outcome.summary,
        warnings: outcome.warnings,
        error: outcome.error,
      });
      if (outcome.ok) broadcastAgentState();
      return;
    }
    if (msg.action === 'save' || msg.action === 'patch') {
      const payload = msg.action === 'save' ? msg.config : msg.patch;
      const outcome =
        msg.action === 'save'
          ? agentConfigStore.save(payload, { writer: 'ui' })
          : agentConfigStore.patch(payload, { writer: 'ui' });
      send({
        type: 'agentConfig',
        action: 'saved',
        requestId: msg.requestId,
        ok: outcome.ok,
        config: outcome.config,
        summary: outcome.summary,
        warnings: outcome.warnings,
        error: outcome.error,
      });
      if (outcome.ok) {
        broadcastAgentState();
        void hooksRuntime.fire(agentConfigStore.get(), { event: 'config', detail: msg.action, key: msg.action });
      }
      return;
    }
    send({ type: 'agentConfig', action: 'error', requestId, error: '未知的配置动作' });
  } catch (err) {
    send({ type: 'agentConfig', action: 'error', requestId, error: errorText(err) });
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

/**
 * 解析请求的查询串。
 *
 * 不能用 `new URL(req.url, `http://${req.headers.host}`)` 构造基址：
 * Host 头由客户端完全控制，含空格等非法字符时 `new URL` 抛 TypeError，
 * 而请求处理函数没有 try/catch，这个异常会冒泡到进程级并让服务退出。
 * 查询串只与 path 有关，基址写死即可。
 */
function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return new URLSearchParams();
  try {
    return new URLSearchParams(raw.slice(q + 1));
  } catch {
    return new URLSearchParams();
  }
}

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
    const raw = await readFile(filePath);
    /**
     * 静态资源的缓存与压缩。
     *
     * 之前每次导航都重新下载 900 kB 的 JS（无 Content-Encoding、无 Cache-Control），
     * 局域网与移动网络下首屏明显发白。规则：
     * - `assets/` 下是 Vite 的哈希文件名 → 内容寻址，可以 immutable 长缓存；
     * - `index.html` 必须 no-cache，否则升级后仍引用旧 chunk；
     * - 文本类按 Accept-Encoding 现场 gzip（构建产物只有几十 KB～1 MB，压缩是毫秒级）。
     * 不做压缩缓存：内容随版本变，多一层缓存只会变成新的失效源。
     */
    const ext = extname(filePath);
    const compressible = ['.js', '.css', '.html', '.json', '.svg'].includes(ext);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    // Vite 产物名形如 index-CSCN34Vd.js / index-Ce2X6dJr.css：带内容哈希才允许长缓存
    const hashedAsset = urlPath.startsWith('/assets/') && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(urlPath);
    const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`;
    // 条件请求：内容没变就 304，浏览器复用本地副本，省掉一次完整下载
    if (String(req.headers['if-none-match'] ?? '') === etag) {
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end();
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    let body: Buffer = raw;
    if (compressible && acceptsGzip && raw.length > 1024) {
      body = gzipSync(raw, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('客户端尚未构建，请先运行 npm run build');
  }
}

/**
 * 时间窗口参数的边界。
 *
 * 快照表没有保留策略时，`to` 缺省为 MAX_SAFE_INTEGER 会让一次请求
 * 把整张表读进内存并在主线程 JSON/CSV 拼接——长跑后这就是 OOM。
 * 这里强制单次窗口有上限，并要求两个端点都是有限数。
 */
const MAX_SNAPSHOT_WINDOW_MIN = 7 * 24 * 60;
const MAX_SNAPSHOT_POINTS = 20_000;

function boundedWindow(url: URLSearchParams): { ok: true; from: number; to: number } | { ok: false; error: string } {
  const from = Number(url.get('from') ?? 0);
  const rawTo = url.get('to');
  const to = rawTo === null ? from + MAX_SNAPSHOT_WINDOW_MIN : Number(rawTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: 'from/to 必须是有限数值' };
  if (to < from) return { ok: false, error: 'to 必须大于等于 from' };
  if (to - from > MAX_SNAPSHOT_WINDOW_MIN) {
    return { ok: false, error: `单次最多查询 ${MAX_SNAPSHOT_WINDOW_MIN} 仿真分钟` };
  }
  return { ok: true, from, to };
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
    res.on('error', (err) => {
      logger.warn('http response error', { route: (req.url ?? '/').split('?')[0], error: String(err) });
    });
    try {
      handleHttpRequest(req, res);
    } catch (err) {
      /**
       * 兜底：单个请求的任何未预期异常都不能杀掉进程。
       *
       * 请求路由是一串同步分支；此前 `new URL(..., host)` 与 `LIMIT ?`
       * 的非整数绑定都能把异常抛到事件循环顶层，
       * 表现为「一个畸形请求 = 服务下线」。
       */
      metrics.httpErrors += 1;
      logger.error('http handler failed', { route: (req.url ?? '/').split('?')[0], error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    }
  });

  function handleHttpRequest(req: IncomingMessage, res: import('node:http').ServerResponse): void {

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
      const url = queryOf(req);
      const deep = url.get('deep') === '1';
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
      const url = queryOf(req);
      if (url.get('format') === 'json') {
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
    if (pathname === '/api/topology/history') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ versions: topologyStore.history() }));
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
    if (pathname === '/api/history/alarms') {
      const url = queryOf(req);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(url.get('limit') ?? 100) || 100)));
      const runId = url.get('runId') ?? undefined;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ enabled: store.enabled, alarms: store.recentAlarms(limit, runId ?? undefined) }));
      return;
    }
    if (pathname === '/api/history/snapshots') {
      const url = queryOf(req);
      const window = boundedWindow(url);
      if (!window.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: window.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          enabled: store.enabled,
          runId: store.latestRunId(),
          runs: store.listRuns(),
          snapshots: store.snapshotsBetween(window.from, window.to, undefined, MAX_SNAPSHOT_POINTS),
          limit: MAX_SNAPSHOT_POINTS,
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
      const url = queryOf(req);
      const window = boundedWindow(url);
      if (!window.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: window.error }));
        return;
      }
      const rows = store.snapshotsBetween(window.from, window.to, undefined, MAX_SNAPSHOT_POINTS);
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
  }

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
    /**
     * 连接数上限：限流状态是按连接维护的，不设上限的话
     * 开 N 条连接就能把每个限流额度放大 N 倍。
     */
    if (runtime.clients.size >= MAX_WS_CLIENTS) {
      logger.warn('ws rejected', { reason: 'too-many-clients', clients: runtime.clients.size });
      ws.close(1013, 'too many connections');
      return;
    }
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
    /**
     * heartbeat：真正的半开检测。
     *
     * 只 ping 不校验 pong 的话，拔网线/客户端假死的连接永远不会被清理：
     * `clients`、`clientState` 与 30 s 定时器全部常驻。
     * 标准做法是每轮置 isAlive=false、收到 pong 置 true，超时 terminate。
     */
    const cs = runtime.clientState.get(ws) ?? freshClientState();
    cs.alive = true;
    runtime.clientState.set(ws, cs);
    ws.on('pong', () => {
      const cur = runtime.clientState.get(ws);
      if (cur) cur.alive = true;
    });
  });

  /**
   * 全局心跳扫描：每 30 s 检查所有连接是否在上一轮之后回过 pong。
   * 放在连接级定时器之外，避免每条连接各持一个 interval。
   */
  setInterval(() => {
    for (const ws of runtime.clients) {
      const st = runtime.clientState.get(ws);
      if (st && st.alive === false) {
        logger.warn('ws terminated', { reason: 'no-pong' });
        ws.terminate();
        continue;
      }
      if (st) st.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30000);

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

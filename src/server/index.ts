import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { answer, decide, Recommendation } from '../ai/agent';

import { readLlmConfig } from '../ai/llm';
import { CONTROL_BOUNDS, LIMITS, PLANT } from '../sim/config';
import { SCENARIOS, ScenarioType } from '../sim/scenarios';
import { NetworkSimState, networkModel, qualityScoreOf, stepNetwork } from '../sim/networkEngine';
import { aiCycleDue } from './aiCadence';
import type { ForecastOutcomeX } from '../sim/plantModel';
import { CompiledNetwork } from '../sim/network';
import type { ClientMessage, PlantSnapshot, ServerMessage, TrendPoint } from '../shared/protocol';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../model/topology';
import { sanitizeTopologyInput } from '../model/topologyInput';
import { TopologyStore } from './topologyStore';
import { PRESETS, buildPreset, presetById } from '../model/presets';
import { applyTopology, checkRunReadiness, createRuntime } from './topologyRuntime';
import { Store } from './store';
import { authRequired, authorize, requiredRoleFor, roleAtLeast, type Role as ClientRole } from './auth';
import { decodeWsTokenSubprotocol } from '../shared/wsToken';
import { isApiPath, isPublicApiPath, isReadMethod, pathnameOf } from './httpRoutes';
import { logger, metrics, metricsJson, recordHttp, recordTick, renderPrometheus } from './observability';
import { buildOperationsReport, decisionsCsv, snapshotsCsv } from './export';
import { syncCursorToBuffer } from './trendCursor';
import { createShadowPlant, stepShadow, summarizeBenchmark, type ShadowPlant } from './benchmark';
import { llmConfigStore, sanitizeDraft } from './llmConfig';
import { discoverModels, testConnection } from '../ai/providers';
import { agentConfigStore } from './agentConfig';
import { HookRuntime } from './hooks';
import { parseAgentCommand } from './agentConfigCommands';
import { buildReport, type CheckInput } from './watchdog';
import { runAnalysis } from '../sim/analysis';
import { CONTROL_KEYS, checkAllowedControls, clampControlMoves } from '../shared/agentConfig';
import { serveStatic, queryOf } from './staticFiles';
import { boundedWindow, MAX_SNAPSHOT_POINTS } from './queryBounds';
import { createSnapshotService } from './snapshotView';
import { createLlmChat, errorText } from './llmChat';
import { createAgentConfigHandler } from './agentConfigHandler';
import { parseClientMessage } from './messageSchema';
import { createCalibrationService } from './calibrationService';
import {
  applyEstimate,
  createEstimatorRuntime,
  measureFromState,
  stepEstimator,
  type EstimatorRuntime,
} from './estimatorRuntime';
import {
  MAX_BUFFERED_BYTES,
  MAX_LLM_IN_FLIGHT,
  MAX_WS_CLIENTS,
  createRateLimiter,
  freshClientState,
  type ClientState,
} from './rateLimit';
import {
  SCENARIO_MAGNITUDE_RANGE,
  VALID_SCENARIOS,
  sanitizeBoolean,
  sanitizeChatText,
  sanitizeControlPatch,
  sanitizeRange,
  sanitizeSpeed,
} from './validation';

/**
 * 环境变量必须校验后再用。
 *
 * `Number('abc')` 是 NaN：PORT=NaN 会让 listen 抛错，TICK_MS=NaN 会让
 * setInterval 退化成 1 ms 忙循环（直接把 CPU 打满）。给每个变量一个
 * 合理区间与默认值，非法输入降级而不是让进程异常。
 */
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < min || raw > max) return fallback;
  return raw;
}

const PORT = envNumber('PORT', 5173, 1, 65535);
const TICK_MS = envNumber('TICK_MS', 1000, 50, 60_000);
const SIM_MINUTES_PER_TICK = envNumber('SIM_MINUTES_PER_TICK', 2, 0.1, 60);
/** 人工调整后的 AI 静默期（仿真分钟） */
const MANUAL_OVERRIDE_MIN = 30;
const TREND_EVERY_TICKS = 10;

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
  /** 小数步长的累积余量（分钟）：低倍速下每帧不足 1 分钟时靠它补齐 */
  simCarryMin: number;
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
  /**
   * 累计记账起点的库存 COD（kg）。
   *
   * 与 totals 的零点是同一时刻：预热结束或 reset 时一并记录。
   * 审计比较的是库存变化量，不是绝对库存。
   */
  baselineStoredCodKg: number;
  /**
   * 在线状态估计（默认关闭）。
   *
   * 关闭时行为与之前完全一致（不影响既有确定性测试）；
   * 打开后用传感器测量校正模型状态，演示「模型会漂、测量能拉回」。
   */
  estimator: EstimatorRuntime;
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
  simCarryMin: 0,
  lastDecisionAtMin: 0,
  clients: new Set(),
  clientState: new Map(),
  manualOverrideUntil: 0,
  forecastCache: { key: null, value: null },
  activePresetId: restoredFromDisk ? null : 'a2o-standard',
  shadow: createShadowPlant(boot.topology, 20261019, 0),
  baselineStoredCodKg: 0,
  // 用真实初始状态播种（此时 boot.runtime.net 已就绪）
  estimator: createEstimatorRuntime(measureFromState(boot.runtime.net), {
    enabled: process.env.AQUAPILOT_ESTIMATOR === '1',
  }),
};
runtime.baselineStoredCodKg = particulateCodKg(runtime.net);

/**
 * 快照服务。
 *
 * 派生量（告警/裕度/健康度/归因）按帧缓存：旧实现对每个连接各算一遍，
 * N 个客户端就是 N 倍重复；现在一帧内所有连接共用一份。
 * 预测缓存也收在这里：同一 (timeMin, controls) 只算一次。
 */
const snapshots = createSnapshotService({
  source: () => ({
    topology: runtime.topology,
    net: runtime.net,
    trend: runtime.trend,
    speed: runtime.speed,
    paused: runtime.paused,
    recommendation: runtime.recommendation,
    forecastCache: runtime.forecastCache,
    shadow: runtime.shadow,
  }),
  forecastFor: (net, topology) => {
    if (!runtime.recommendation) return null;
    const key = `${net.timeMin}|${JSON.stringify(net.controls)}`;
    if (runtime.forecastCache.key === key && runtime.forecastCache.value) return runtime.forecastCache.value;
    const model = networkModel(topology, net);
    runtime.forecastCache.value = model.predict(net.controls, 240, 30);
    runtime.forecastCache.key = key;
    return runtime.forecastCache.value;
  },
  summarizeBenchmark,
});

const buildSnapshot = (): PlantSnapshot => snapshots.buildSnapshot();
const currentAlarms = (s: NetworkSimState) => snapshots.currentAlarms(s);

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
 * 构造增量快照。
 *
 * 只包含每个 tick 必然变化的字段；趋势只给新增点（通常 0 或 1 个）。
 * 与完整快照相比，稳态帧大小从约 240 KB 降到约 2 KB。
 */
/**
 * 背压保护：发送队列堆积说明对端不读数据。
 *
 * 入站有 maxPayload 限制，出站此前完全没有：一个连上就暂停读取的客户端
 * 会让每帧增量在服务端内存里无限排队。超过阈值直接断开，
 * 客户端重连后自然会重新对齐（趋势游标按时间戳，重连安全）。
 */
/** 限流器：状态存 runtime.clientState，拒绝时累计指标 */
const limiter = createRateLimiter({
  stateFor: (ws) => runtime.clientState.get(ws) ?? freshClientState(),
  saveState: (ws, state) => runtime.clientState.set(ws, state),
  onLimited: () => {
    metrics.rateLimited += 1;
  },
});

function rateLimited(ws: WebSocket, kind: 'control' | 'topology' | 'decision' | 'chat' | 'snapshot'): boolean {
  return limiter.limited(ws, kind);
}

function throttledNotice(ws: WebSocket, kind: string, text: string): void {
  limiter.notice(ws, kind, text, (payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
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
 * 系统内颗粒态 COD 存量（kg）。
 *
 * ASM1 用全部颗粒组分；简化模型只有全局生物量，按 VSS→COD 1.42 折算。
 * 这是质量平衡审计的「库存」项，缺了它会把存货误报成泄漏。
 */
function particulateCodKg(net: NetworkSimState): number {
  let total = 0;
  let hasAsm1 = false;
  for (const r of net.reactors) {
    if (!r.asm1) continue;
    hasAsm1 = true;
    const a = r.asm1;
    total += ((a.X_I + a.X_S + a.X_B_H + a.X_B_A + a.X_P) * r.volume) / 1000;
  }
  return hasAsm1 ? total : net.biomassKg * 1.42;
}

/** 参数校准（CPU 密集，后台分批执行） */
const calibration = createCalibrationService({
  send: (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  },
  isOpen: (ws) => ws.readyState === WebSocket.OPEN,
});

/** 对话增强（规则答案之后的模型补充） */
const enhanceWithLlm = createLlmChat({
  snapshot: () => ({ net: runtime.net, recommendation: runtime.recommendation }),
  isOpen: (ws) => ws.readyState === WebSocket.OPEN,
  send: (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  },
});

/** Agent 配置（界面驱动的 request/response）；hooks 运行时在下方定义，故延迟到首次调用 */
let handleAgentConfigRef: ReturnType<typeof createAgentConfigHandler> | null = null;
function handleAgentConfig(ws: WebSocket, msg: Extract<ClientMessage, { type: 'agentConfig' }>): Promise<void> {
  handleAgentConfigRef ??= createAgentConfigHandler({
    broadcast: (message) => broadcast(message),
    hooks: hooksRuntime,
  });
  return handleAgentConfigRef(ws, msg);
}

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
  /**
   * 一帧只构造一次共享补丁体，再按连接补趋势增量。
   *
   * 旧实现对每个连接各调一次 buildPatch：告警规则表、裕度排序、
   * 健康度加权、归因全部按连接数重复执行。内容本来完全相同，
   * 差异只有「该连接还没收到哪些趋势点」。
   */
  const live: WebSocket[] = [];
  const cursors: ClientState[] = [];
  for (const ws of runtime.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    live.push(ws);
    cursors.push(runtime.clientState.get(ws) ?? freshClientState());
  }
  if (live.length === 0) return;
  const patches = snapshots.buildPatches(cursors);
  for (let i = 0; i < live.length; i++) {
    runtime.clientState.set(live[i], cursors[i]);
    sendGuarded(live[i], JSON.stringify({ type: 'snapshotPatch', data: patches[i] } satisfies ServerMessage));
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
  /**
   * 倍速必须是真的倍速。
   *
   * 旧实现 `Math.round(SIM_MINUTES_PER_TICK * speed)` 把 dt 取整成步数：
   * 0.25× 时 2×0.25=0.5 → round = 1，实际速度与 1× 完全相同，
   * 界面上的 0.25×/0.5× 档位是假的。改为按小数步长推进，
   * 步数向下取整、余量累积到下一帧，长期平均速度才准确。
   */
  runtime.simCarryMin += SIM_MINUTES_PER_TICK * runtime.speed;
  const steps = Math.floor(runtime.simCarryMin);
  runtime.simCarryMin -= steps;
  for (let i = 0; i < steps; i++) {
    stepNetwork(s, runtime.topology, 1);
    runtime.tick += 1;
    /**
     * 在线状态估计（默认关闭）。
     *
     * 位置必须在 stepNetwork 之后：先让模型自己推进（预测步），
     * 再用这一拍的测量校正。反过来的话校正会被下一步推进抵消。
     */
    if (runtime.estimator.estimator) {
      const truth = measureFromState(s);
      const { estimated } = stepEstimator(runtime.estimator, truth, s.seed);
      if (estimated && runtime.estimator.config.applyCorrection) {
        applyEstimate(s, estimated, truth);
      }
    }
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
  /**
   * 结构校验交给 valibot schema（messageSchema.ts）。
   *
   * 手写版只查 `type` 是字符串，实测有三处真缺口：scenario.kind 任意值
   * 都按 start 处理、sim.action 非法值静默成功、llmConfig.protocol 未知值
   * 落入 Google 分支。schema 逐分支校验，非法输入在入口就被拒。
   */
  const gate = parseClientMessage(parsed);
  if (!gate.ok) {
    metrics.invalidMessages += 1;
    logger.warn('ws message rejected', { reason: 'schema', detail: gate.error });
    ws.send(
      JSON.stringify({ type: 'notice', level: 'error', text: `消息结构不合法：${gate.error}` } satisfies ServerMessage),
    );
    return;
  }
  const msg = gate.message as unknown as ClientMessage;

  /**
   * 角色校验：viewer 只能读，operator 可操作，admin 可配置。
   *
   * 单令牌时代所有人都是 admin；现在同一个服务可以给值班大屏发 viewer 令牌，
   * 只读观察不会误触控制。认证未启用时角色恒为 admin，行为不变。
   */
  const senderRole: ClientRole = runtime.clientState.get(ws)?.role ?? 'admin';
  const neededRole = requiredRoleFor(msg.type);
  if (!roleAtLeast(senderRole, neededRole)) {
    metrics.invalidMessages += 1;
    logger.warn('ws message forbidden', { type: msg.type, role: senderRole, needed: neededRole });
    ws.send(
      JSON.stringify({
        type: 'notice',
        level: 'error',
        text: `当前令牌为「${senderRole}」，无权限执行该操作（需要 ${neededRole}）`,
      } satisfies ServerMessage),
    );
    return;
  }

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
        throttledNotice(ws, 'chat', '提问过于频繁，请稍后再试');
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
        throttledNotice(ws, 'control', '操作过于频繁，请稍后再试');
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
          magnitude: sanitizeRange(
            (msg as { magnitude?: unknown }).magnitude,
            SCENARIO_MAGNITUDE_RANGE[scenarioType]?.min ?? 0,
            SCENARIO_MAGNITUDE_RANGE[scenarioType]?.max ?? 30,
            meta.defaultMagnitude,
          ),
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
        runtime.baselineStoredCodKg = particulateCodKg(runtime.net);
        runtime.trend = [];
        runtime.recommendation = null;
        runtime.tick = 0;
        runtime.simCarryMin = 0;
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
        throttledNotice(ws, 'decision', '推演过于频繁，请 2 秒后再试');
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
          JSON.stringify({
            type: 'notice',
            level: 'error',
            text: '工艺切换过于频繁，请稍后再试',
          } satisfies ServerMessage),
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
    case 'calibration': {
      // 标定是 admin 级操作：它会改模型参数，不是只读分析
      if (msg.action === 'cancel') {
        calibration.cancel(ws);
        break;
      }
      if (msg.action === 'identify') {
        void calibration.identify(ws, msg.requestId);
        break;
      }
      void calibration.run(ws, msg.requestId, msg.maxIterations);
      break;
    }
    case 'analysis': {
      /**
       * 运行分析是重操作（~25 次 4h 预测，实测 300+ ms 同步阻塞），
       * 因此按需触发、限流，并与「重新推演」共用同一套冷却。
       */
      if (rateLimited(ws, 'decision')) {
        throttledNotice(ws, 'decision', '分析请求过于频繁，请 2 秒后再试');
        break;
      }
      try {
        const horizon = sanitizeRange(msg.horizonMin, 60, 480, 240);
        const data = runAnalysis(
          networkModel(runtime.topology, runtime.net),
          {
            totals: runtime.net.totals,
            effluent: runtime.net.effluent,
            storedParticulateCodKg: particulateCodKg(runtime.net),
            baselineStoredCodKg: runtime.baselineStoredCodKg,
            influentCodAvg: runtime.net.influent.cod,
            // 两种引擎的取样口径都不构成严格守恒方程，统一按近似判定
            approximate: true,
          },
          horizon,
        );
        ws.send(JSON.stringify({ type: 'analysis', requestId: msg.requestId, data } satisfies ServerMessage));
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'analysis',
            action: 'error',
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : '分析失败',
          } satisfies ServerMessage),
        );
      }
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
        apiKey: llmConfigStore.resolveKey(typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '', msg.baseUrl),
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
      apiKey: llmConfigStore.resolveKey(typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '', msg.baseUrl),
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
      // 所有 GET API 都是只读：viewer 即可（写操作走 WS 且要求更高角色）
      const decision = authorize(req, null, 'viewer');
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

  /**
   * 握手阶段的角色缓存。
   *
   * ws v8 不会把 IncomingMessage 挂在 socket 上（`ws._req` 不存在），
   * 因此角色必须在 verifyClient 里算好并按请求对象暂存，connection 时取回。
   * 用 WeakMap 而不是给 req 挂字段：后者会随连接对象一起被长期持有。
   */
  const handshakeRoles = new WeakMap<IncomingMessage, ClientRole>();
  const pendingRoles = new WeakMap<WebSocket, ClientRole>();

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // 限制单帧大小，避免恶意大包打满内存（ws 的 DoS 公告与此相关）
    maxPayload: 1024 * 512,
    // Origin 白名单：仅允许同源与本地开发来源，缓解跨站 WebSocket 劫持
    verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
      // 访问控制优先：令牌不对直接拒绝，不再看 Origin
      /**
       * 令牌子协议按 base64url 解码。
       *
       * 直接用明文令牌作为子协议名会在令牌含 `=`/`/`/`+` 时让浏览器
       * 在构造 WebSocket 时抛 SyntaxError（Base64 令牌几乎必然含这些字符）。
       */
      const subprotocol = info.req.headers['sec-websocket-protocol'];
      const protoToken = decodeWsTokenSubprotocol(
        typeof subprotocol === 'string' ? subprotocol : Array.isArray(subprotocol) ? subprotocol : undefined,
      );
      const verdict = authorize(info.req, protoToken, 'viewer');
      if (verdict.allowed) handshakeRoles.set(info.req, verdict.role ?? 'admin');
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

  wss.on('connection', (ws, req) => {
    const role = handshakeRoles.get(req) ?? 'admin';
    pendingRoles.set(ws, role);
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
    /**
     * 连接级角色：握手时用同一套令牌确定，之后每条消息按需校验。
     *
     * 为什么不在握手时直接要求 admin：观察员需要能看实时数据。
     * 真正的边界在「这条消息要不要写」，由 requiredRoleFor 决定。
     */
    const handshakeState = runtime.clientState.get(ws) ?? freshClientState();
    handshakeState.role = pendingRoles.get(ws) ?? 'admin';
    runtime.clientState.set(ws, handshakeState);
    logger.info('ws connected', { clients: runtime.clients.size + 1, role: handshakeState.role });
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

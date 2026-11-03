import { useEffect, useRef, useState } from 'react';
import { encodeWsTokenSubprotocol } from '../../shared/wsToken';
import type { ClientMessage, PlantSnapshot, ServerMessage } from '../../shared/protocol';
import type { Answer, Recommendation } from '../../ai/agent';
import type { ControlSettings } from '../../sim/config';
import type { ScenarioType } from '../../sim/scenarios';
import type { ProcessTopology } from '../../model/topology';
import type { DiscoveredModel, LlmDraft, LlmProtocol, LlmPublicConfig, LlmTestResult } from '../../shared/llm';
import type { AgentConfig, AgentSummary } from '../../shared/agentConfig';
import type { TopologyVersionSummary, WatchdogReport } from '../../shared/protocol';
import type { AnalysisSnapshot } from '../../sim/analysis';
import type { CalibrationResultSummary } from '../../shared/protocol';
import type { CalibrationProgress, IdentifiabilityRow } from '../../sim/calibration';

/** 进水序列 UI 状态 */
export interface InfluentUiState {
  loading: boolean;
  applying: boolean;
  report: Extract<ServerMessage, { type: 'influent'; action: 'report' }> | null;
  error: string | null;
}

/** 校准 UI 状态 */
export interface CalibrationUiState {
  running: boolean;
  phase: CalibrationProgress['phase'] | null;
  progress: CalibrationProgress | null;
  identifiability: IdentifiabilityRow[] | null;
  result: CalibrationResultSummary | null;
  error: string | null;
}
import { nextSendPlan, reconnectDelayMs } from './wsPolicy';
import { mergeSnapshot } from './snapshotMerge';
import { NOTICE_TTL_MS, pruneNotices, pushNotice, type Notice } from './notices';

export interface AgentConfigApi {
  config: AgentConfig | null;
  summary: AgentSummary | null;
  warnings: string[];
  coreProtected: string[];
  saving: boolean;
  lastError: string | null;
  promptPreview: string | null;
  save: (config: AgentConfig) => void;
  reset: () => void;
  reload: () => void;
  requestPreview: (question?: string, config?: AgentConfig) => void;
  importSkill: (skill: {
    name?: string;
    description?: string;
    triggers?: string[];
    content?: string;
    url?: string;
  }) => void;
}

export interface LlmConfigApi {
  /** 保存的配置（含掩码，无明文 key） */
  config: LlmPublicConfig | null;
  models: DiscoveredModel[];
  discovering: boolean;
  testing: boolean;
  busy: boolean;
  lastError: string | null;
  lastDiscoverAt: number | null;
  testResult: LlmTestResult | null;
  discover: (input: { protocol: LlmProtocol; baseUrl: string; apiKey?: string }) => void;
  test: (input: { protocol: LlmProtocol; baseUrl: string; apiKey?: string; model: string; maxOutput?: number }) => void;
  save: (draft: LlmDraft) => void;
  clear: () => void;
  reload: () => void;
}

export interface ChatEntry {
  id: number;
  role: 'user' | 'ai' | 'system';
  text: string;
  answer?: Answer;
  at: number;
}

export interface LinkState {
  connected: boolean;
  error: string | null;
  /** 最近一次收到服务端数据的时间戳（ms）；用于界面提示「数据最后更新时间」 */
  lastUpdateAt: number | null;
}

/**
 * 快照形状校验。
 *
 * 服务端与客户端是独立部署单元，协议漂移是现实风险：
 * 一个缺失的数值字段会让下游 .toFixed() 抛错，整页崩溃。
 * ErrorBoundary 只能兜底，不能防止；这里在入口处拒收不完整数据。
 */
function isUsableSnapshot(v: unknown): v is PlantSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!num(s.timeMin)) return false;
  if (!Array.isArray(s.tanks) || s.tanks.length === 0) return false;
  if (!Array.isArray(s.trends)) return false;
  const e = s.effluent as Record<string, unknown> | undefined;
  if (!e || !num(e.cod) || !num(e.nh) || !num(e.ss)) return false;
  const c = s.clarifier as Record<string, unknown> | undefined;
  if (!c || !num(c.blanketM)) return false;
  const en = s.energy as Record<string, unknown> | undefined;
  if (!en || !num(en.totalKw)) return false;
  return true;
}

const TOKEN_KEY = 'aquapilot_token';

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function useSimulation() {
  const [snapshot, setSnapshot] = useState<PlantSnapshot | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [link, setLink] = useState<LinkState>({ connected: false, error: null, lastUpdateAt: null });
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [topology, setTopology] = useState<ProcessTopology | null>(null);
  const [topologyRevision, setTopologyRevision] = useState(1);
  const [topologyVersions, setTopologyVersions] = useState<TopologyVersionSummary[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const chatId = useRef(0);
  const noticeId = useRef(0);
  const retry = useRef(0);
  /** 背压合并缓冲：发送快于带宽时保留「最后一条」意图，不丢用户操作 */
  const pendingSendRef = useRef<ClientMessage | null>(null);

  // 自定义模型配置：请求带 requestId，只认最后一次请求的响应，过期响应直接丢弃
  const [llmConfig, setLlmConfig] = useState<LlmPublicConfig | null>(null);
  const [llmModels, setLlmModels] = useState<DiscoveredModel[]>([]);
  const [llmDiscovering, setLlmDiscovering] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmLastDiscoverAt, setLlmLastDiscoverAt] = useState<number | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<LlmTestResult | null>(null);
  const llmRequestId = useRef(0);
  const llmPending = useRef<Record<string, 'discover' | 'test' | 'save' | 'clear'>>({});
  /** 每类操作最近一次发出的 requestId：迟到响应按它过滤，防止旧结果覆盖新结果 */
  const llmLatest = useRef<{ discover: string | null; test: string | null; save: string | null }>({
    discover: null,
    test: null,
    save: null,
  });

  // Agent 配置（角色/提示词/技能/钩子/约束/权限）
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
  const [agentCore, setAgentCore] = useState<string[]>([]);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentPromptPreview, setAgentPromptPreview] = useState<string | null>(null);
  const agentRequestId = useRef(0);
  /** 最近一次写类 agentConfig 请求的 requestId：过期的 saved/error 不改界面状态 */
  const agentLatest = useRef<string | null>(null);
  const [watchdog, setWatchdog] = useState<WatchdogReport | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisSnapshot | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const analysisId = useRef(0);
  const [calibration, setCalibration] = useState<CalibrationUiState>({
    running: false,
    phase: null,
    progress: null,
    identifiability: null,
    result: null,
    error: null,
  });
  const calibrationId = useRef(0);
  const [influent, setInfluent] = useState<InfluentUiState>({
    loading: false,
    applying: false,
    report: null,
    error: null,
  });
  const influentId = useRef(0);

  useEffect(() => {
    let closed = false;

    /** 把断线/背压期间积压的最后一条意图发出去（连接可用时才动作） */
    const flushPending = () => {
      const live = socketRef.current;
      if (!pendingSendRef.current || !live || live.readyState !== WebSocket.OPEN) return;
      const msg = pendingSendRef.current;
      pendingSendRef.current = null;
      live.send(JSON.stringify(msg));
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      /**
       * 浏览器无法为 WebSocket 握手设置 Authorization 头，
       * 因此令牌通过子协议传递（服务端 verifyClient 支持 `token.<value>`）。
       */
      const token = readToken();
      const url = `${proto}://${window.location.host}/ws`;
      /**
       * 建连必须包 try/catch：`new WebSocket` 对非法子协议名、非法 URL
       * 会抛 SyntaxError，而抛出点不在任何事件回调里。
       * 之前令牌含 `=`/`/` 时整个重连链就此中断（onclose 都不会触发）。
       */
      let ws: WebSocket;
      try {
        ws = token ? new WebSocket(url, [encodeWsTokenSubprotocol(token)]) : new WebSocket(url);
      } catch (err) {
        setLink({ connected: false, error: `无法建立连接：${String(err)}`, lastUpdateAt: null });
        retry.current += 1;
        setTimeout(connect, reconnectDelayMs(retry.current));
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        setLink({ connected: true, error: null, lastUpdateAt: null });
        retry.current = 0;
        ws.send(JSON.stringify({ type: 'hello' } satisfies ClientMessage));
        /**
         * 连接建立后主动拉一次配置。
         *
         * 否则顶栏「设置」菜单和状态点在用户打开面板前永远是「未配置」，
         * 明明已经配好模型/角色也显示空——这是实测发现的误导。
         */
        ws.send(JSON.stringify({ type: 'llmConfig', action: 'get' } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: 'agentConfig', action: 'get' } satisfies ClientMessage));
        /**
         * 冲刷断线期间积压的意图。
         *
         * 之前只靠 `bufferedamountlow`：该事件仅在缓冲「从高降到低」时触发，
         * 而新建连接的 bufferedAmount 本来就是 0，永远不会触发——
         * 用户在断线那 1–2 秒里拖的滑块/发的场景，重连后被静默丢弃。
         */
        flushPending();
      };
      // 发送缓冲降到低水位时冲刷背压积压的最后一条意图
      ws.addEventListener('bufferedamountlow', flushPending);
      ws.onmessage = (event) => {
        setLink((prev) => ({ ...prev, lastUpdateAt: Date.now() }));
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch (err) {
          // 服务端发来非 JSON（或连接被中途截断）时忽略该帧，不让异常冒泡；
          // 但必须留痕——否则协议漂移表现为「界面没反应」而无从排查
          console.warn('[aqua] 收到无法解析的 WS 帧，已忽略', { error: String(err) });
          return;
        }
        switch (msg.type) {
          case 'snapshot':
            // 拒收不完整快照：宁可保留上一帧可用数据，也不进入崩溃态
            if (isUsableSnapshot(msg.data)) setSnapshot(msg.data);
            else console.warn('discarded malformed snapshot from server');
            break;
          case 'snapshotPatch':
            // 增量合并：只覆盖变化字段，趋势追加新点（规则见 snapshotMerge，有单测）
            setSnapshot((prev) => (prev ? mergeSnapshot(prev, msg.data) : prev));
            break;
          case 'decision':
            setRecommendation(msg.data);
            setDecisionRefreshing(false);
            break;
          case 'chat':
            chatId.current += 1;
            setChatPending((p) => Math.max(0, p - 1));
            setChat((prev) => [
              ...prev,
              {
                id: chatId.current,
                role: 'ai',
                text: msg.answer.title,
                answer: msg.answer,
                at: Date.now(),
              },
            ]);
            break;
          case 'notice':
            noticeId.current += 1;
            setNotices((prev) =>
              pushNotice(prev, { id: noticeId.current, level: msg.level, text: msg.text, at: Date.now() }),
            );
            break;
          case 'simState':
            setPaused(msg.paused);
            setSpeed(msg.speed);
            break;
          case 'topology':
            setTopology(msg.data);
            setTopologyRevision((r) => r + 1);
            break;
          case 'topologyHistory':
            setTopologyVersions(msg.versions);
            break;
          case 'llmConfig':
            if (msg.action === 'config') {
              setLlmConfig(msg.config);
              setLlmError(null);
              break;
            }
            if (msg.action === 'discovered') {
              // 过期响应直接丢弃：用户改了端点再拉取后，旧端点的迟到响应
              // 不得覆盖新结果，也不得把 discovering 提前置 false
              if (llmLatest.current.discover !== msg.requestId) {
                console.warn('[aqua] 丢弃过期的模型发现响应', { requestId: msg.requestId });
                delete llmPending.current[msg.requestId];
                break;
              }
              setLlmModels(msg.models);
              setLlmDiscovering(false);
              setLlmLastDiscoverAt(Date.now());
              setLlmError(null);
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'tested') {
              if (llmLatest.current.test !== msg.requestId) {
                console.warn('[aqua] 丢弃过期的连接测试响应', { requestId: msg.requestId });
                delete llmPending.current[msg.requestId];
                break;
              }
              setLlmTesting(false);
              setLlmTestResult(msg.result);
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'saved') {
              if (llmLatest.current.save !== msg.requestId) {
                console.warn('[aqua] 丢弃过期的配置保存响应', { requestId: msg.requestId });
                delete llmPending.current[msg.requestId];
                break;
              }
              setLlmSaving(false);
              if (msg.ok) {
                if (msg.config) setLlmConfig(msg.config);
                else setLlmConfig(null);
                setLlmError(null);
                setLlmTestResult(null);
              } else {
                setLlmError(msg.error ?? '保存失败');
              }
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'error') {
              // 带 requestId 的错误只在它仍是最新请求时改界面状态：
              // 迟到错误不得把新一轮操作的 busy 状态提前清掉
              const staleError =
                msg.requestId != null &&
                msg.requestId !== llmLatest.current.discover &&
                msg.requestId !== llmLatest.current.test &&
                msg.requestId !== llmLatest.current.save;
              if (staleError) {
                console.warn('[aqua] 丢弃过期的模型配置错误回执', { requestId: msg.requestId });
                if (msg.requestId) delete llmPending.current[msg.requestId];
                break;
              }
              setLlmDiscovering(false);
              setLlmTesting(false);
              setLlmSaving(false);
              setLlmError(msg.error);
              if (msg.requestId) delete llmPending.current[msg.requestId];
            }
            break;
          case 'agentConfig':
            if (msg.action === 'state') {
              setAgentConfig(msg.config);
              setAgentSummary(msg.summary);
              setAgentWarnings(msg.warnings);
              setAgentCore(msg.coreProtected);
              if (msg.promptPreview !== undefined) setAgentPromptPreview(msg.promptPreview);
              break;
            }
            if (msg.action === 'saved') {
              if (agentLatest.current !== null && agentLatest.current !== msg.requestId) {
                console.warn('[aqua] 丢弃过期的角色配置保存响应', { requestId: msg.requestId });
                break;
              }
              setAgentSaving(false);
              setAgentWarnings(msg.warnings ?? []);
              if (msg.ok) {
                if (msg.config) setAgentConfig(msg.config);
                if (msg.summary) setAgentSummary(msg.summary);
                setAgentError(null);
              } else {
                setAgentError(msg.error ?? '保存失败');
              }
              break;
            }
            if (msg.action === 'error') {
              if (agentLatest.current !== null && agentLatest.current !== msg.requestId) {
                console.warn('[aqua] 丢弃过期的角色配置错误回执', { requestId: msg.requestId });
                break;
              }
              setAgentSaving(false);
              setAgentError(msg.error);
            }
            break;
          case 'watchdog':
            setWatchdog(msg.report);
            break;
          case 'influent': {
            setInfluent((prev) => {
              if ('action' in msg && msg.action === 'report') {
                return { ...prev, loading: false, applying: false, report: msg, error: null };
              }
              if ('action' in msg && msg.action === 'error') {
                return { ...prev, loading: false, applying: false, error: msg.error };
              }
              return prev;
            });
            break;
          }
          case 'calibration': {
            setCalibration((prev) => {
              if ('action' in msg && msg.action === 'progress') {
                return { ...prev, running: true, phase: msg.progress.phase, progress: msg.progress };
              }
              if ('action' in msg && msg.action === 'identifiability') {
                return { ...prev, running: false, identifiability: msg.rows };
              }
              if ('action' in msg && msg.action === 'done') {
                return { ...prev, running: false, phase: null, progress: null, result: msg.result, error: null };
              }
              if ('action' in msg && msg.action === 'cancelled') {
                return { ...prev, running: false, phase: null, progress: null };
              }
              if ('action' in msg && msg.action === 'error') {
                return { ...prev, running: false, phase: null, progress: null, error: msg.error };
              }
              return prev;
            });
            break;
          }
          case 'analysis': {
            setAnalysisLoading(false);
            if ('action' in msg && msg.action === 'error') {
              setAnalysisError(msg.error);
            } else if ('data' in msg) {
              setAnalysis(msg.data);
              setAnalysisError(null);
            }
            break;
          }
          default:
            break;
        }
      };
      ws.onclose = () => {
        setLink((prev) => ({ ...prev, connected: false, error: '与仿真服务的连接已断开' }));
        /**
         * 断线必须复位所有 in-flight 状态。
         *
         * 这些 flag 只在收到响应时清零；连接一断，请求永远不会回来，
         * 界面就会永久卡在「正在拉取模型…」「保存中…」，且无法再次触发。
         */
        llmPending.current = {};
        llmLatest.current = { discover: null, test: null, save: null };
        agentLatest.current = null;
        setLlmDiscovering(false);
        setLlmTesting(false);
        setLlmSaving(false);
        setAgentSaving(false);
        setAnalysisLoading(false);
        setCalibration((prev) => ({ ...prev, running: false, phase: null, progress: null }));
        if (closed) return;
        retry.current += 1;
        // 抖动退避：多客户端同时断线时避免重连请求同步撞击服务端
        setTimeout(connect, reconnectDelayMs(retry.current));
      };
      ws.onerror = (event) => {
        // 保留细节：开发者工具里能看到 onerror 触发时的异常对象，
        // 否则「连接仿真服务失败」这行文案是唯一线索
        console.warn('[aqua] WebSocket 连接错误', event);
        setLink((prev) => ({ ...prev, connected: false, error: '连接仿真服务失败' }));
      };
    };
    connect();
    return () => {
      closed = true;
      socketRef.current?.close();
    };
  }, []);

  /**
   * 提示条过期清理。
   *
   * 只在有提示时挂定时器：没有提示的连接不产生任何定时开销；
   * 每 2 秒扫一遍，超出存活期的直接移除（规则见 hooks/notices）。
   */
  useEffect(() => {
    if (notices.length === 0) return;
    const timer = setInterval(() => {
      setNotices((prev) => {
        const next = pruneNotices(prev, Date.now(), NOTICE_TTL_MS);
        return next.length === prev.length ? prev : next;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [notices.length]);

  const send = (msg: ClientMessage) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // 未连接：暂存为待发，重连成功后由 bufferedamountlow 或下一次发送冲刷
      pendingSendRef.current = msg;
      return;
    }
    const plan = nextSendPlan(pendingSendRef.current, msg, ws.bufferedAmount ?? 0);
    pendingSendRef.current = plan.pending;
    for (const m of plan.toSend) ws.send(JSON.stringify(m));
    // 缓冲降到低水位以下时冲刷积压（部分浏览器 API；不支持则等下一次发送自然带出）
    try {
      (ws as unknown as { bufferedAmountLowThreshold?: number }).bufferedAmountLowThreshold = 32 * 1024;
    } catch {
      /* 某些环境不支持该属性，忽略 */
    }
  };

  /** 正在等待 AI 回答的提问数：>0 时对话面板显示「正在回答」指示 */
  const [chatPending, setChatPending] = useState(0);
  /** 「重新推演」已发出、尚未收到 decision 帧：按钮显示进行中并防重复点击 */
  const [decisionRefreshing, setDecisionRefreshing] = useState(false);

  const ask = (text: string) => {
    if (!text.trim()) return;
    chatId.current += 1;
    setChat((prev) => [...prev, { id: chatId.current, role: 'user', text, at: Date.now() }]);
    setChatPending((p) => p + 1);
    // 兜底：AI 回答可能要走 notice 通道（模型未配置/超时），无法与提问配对；
    // 推理模型最坏 60s+，120s 后无条件撤销指示，避免永久转圈
    setTimeout(() => setChatPending((p) => Math.max(0, p - 1)), 120_000);
    send({ type: 'chat', text });
  };

  const setControls = (patch: Partial<ControlSettings>) => send({ type: 'control', patch });
  const setAiEnabled = (enabled: boolean) => send({ type: 'aiEnabled', enabled });
  const applyRecommendation = () => send({ type: 'applyRecommendation' });
  const startScenario = (scenario: ScenarioType, options: { durationMin?: number; magnitude?: number } = {}) =>
    send({ type: 'scenario', kind: 'start', scenario, ...options });
  const clearScenario = () => send({ type: 'scenario', kind: 'clear' });
  const pause = () => send({ type: 'sim', action: paused ? 'resume' : 'pause' });
  const reset = () => send({ type: 'sim', action: 'reset' });
  const changeSpeed = (value: number) => send({ type: 'speed', value });
  const refreshDecision = () => {
    setDecisionRefreshing(true);
    // 决策帧通常数秒内回来；断线或积压时 30s 后解除，防止按钮永久禁用
    setTimeout(() => setDecisionRefreshing(false), 30_000);
    send({ type: 'refreshDecision' });
  };
  const applyPreset = (id: string) => send({ type: 'preset', id });
  const requestTopology = () => send({ type: 'topology', action: 'get' });
  const applyTopology = (topo: ProcessTopology) => send({ type: 'topology', action: 'apply', topology: topo });
  const requestTopologyHistory = () => send({ type: 'topology', action: 'history' });
  const revertTopology = (revision: number) => send({ type: 'topology', action: 'revert', revision });

  const nextLlmRequestId = () => {
    llmRequestId.current += 1;
    return `llm-${llmRequestId.current}`;
  };
  const llmReload = () => send({ type: 'llmConfig', action: 'get' });
  const llmDiscover = (input: { protocol: LlmProtocol; baseUrl: string; apiKey?: string }) => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'discover';
    llmLatest.current.discover = requestId;
    setLlmDiscovering(true);
    setLlmError(null);
    send({ type: 'llmConfig', action: 'discover', requestId, ...input });
  };
  const llmTest = (input: {
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey?: string;
    model: string;
    maxOutput?: number;
  }) => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'test';
    llmLatest.current.test = requestId;
    setLlmTesting(true);
    setLlmTestResult(null);
    send({ type: 'llmConfig', action: 'test', requestId, ...input });
  };
  const llmSave = (draft: LlmDraft) => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'save';
    llmLatest.current.save = requestId;
    setLlmSaving(true);
    setLlmError(null);
    send({ type: 'llmConfig', action: 'save', requestId, draft });
  };
  const llmClear = () => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'clear';
    setLlmModels([]);
    send({ type: 'llmConfig', action: 'clear', requestId });
  };

  const llm: LlmConfigApi = {
    config: llmConfig,
    models: llmModels,
    discovering: llmDiscovering,
    testing: llmTesting,
    busy: llmDiscovering || llmTesting || llmSaving,
    lastError: llmError,
    lastDiscoverAt: llmLastDiscoverAt,
    testResult: llmTestResult,
    discover: llmDiscover,
    test: llmTest,
    save: llmSave,
    clear: llmClear,
    reload: llmReload,
  };

  const nextAgentId = () => {
    agentRequestId.current += 1;
    return `agent-${agentRequestId.current}`;
  };
  const agentApi: AgentConfigApi = {
    config: agentConfig,
    summary: agentSummary,
    warnings: agentWarnings,
    coreProtected: agentCore,
    saving: agentSaving,
    lastError: agentError,
    promptPreview: agentPromptPreview,
    save: (config) => {
      agentLatest.current = nextAgentId();
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'save', requestId: agentLatest.current, config });
    },
    reset: () => {
      agentLatest.current = nextAgentId();
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'reset', requestId: agentLatest.current });
    },
    reload: () => send({ type: 'agentConfig', action: 'get' }),
    requestPreview: (question, config) => {
      setAgentPromptPreview(null);
      // 预览按草稿算，而不是按已保存的配置：用户改完还没保存也能看到效果
      send({ type: 'agentConfig', action: 'previewPrompt', requestId: nextAgentId(), question, config });
    },
    importSkill: (skill) => {
      agentLatest.current = nextAgentId();
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'importSkill', requestId: agentLatest.current, skill });
    },
  };

  return {
    snapshot,
    recommendation,
    chat,
    chatPending,
    decisionRefreshing,
    notices,
    link,
    paused,
    speed,
    ask,
    send,
    setControls,
    setAiEnabled,
    applyRecommendation,
    startScenario,
    clearScenario,
    pause,
    reset,
    changeSpeed,
    refreshDecision,
    applyPreset,
    topology,
    topologyRevision,
    topologyVersions,
    requestTopology,
    requestTopologyHistory,
    applyTopology,
    revertTopology,
    llm,
    agent: agentApi,
    watchdog,
    watchdogReload: () => send({ type: 'watchdog', action: 'get' }),
    analysis,
    analysisLoading,
    analysisError,
    calibration,
    influent,
    loadInfluent: (name: string, csv: string) => {
      influentId.current += 1;
      setInfluent((prev) => ({ ...prev, loading: true, error: null }));
      send({ type: 'influent', action: 'load', requestId: `inf-${influentId.current}`, name, csv });
    },
    applyInfluent: () => {
      setInfluent((prev) => ({ ...prev, applying: true, error: null }));
      send({ type: 'influent', action: 'apply', requestId: `inf-${influentId.current}` });
    },
    clearInfluent: () => {
      send({ type: 'influent', action: 'clear', requestId: `inf-${influentId.current}` });
    },
    identifyCalibration: () => {
      calibrationId.current += 1;
      setCalibration((prev) => ({ ...prev, running: true, phase: 'identifiability', error: null, progress: null }));
      send({ type: 'calibration', action: 'identify', requestId: `cal-${calibrationId.current}` });
    },
    startCalibration: (maxIterations?: number) => {
      calibrationId.current += 1;
      setCalibration((prev) => ({ ...prev, running: true, phase: 'identifiability', error: null, result: null }));
      send({
        type: 'calibration',
        action: 'start',
        requestId: `cal-${calibrationId.current}`,
        maxIterations,
      });
    },
    cancelCalibration: () => {
      send({ type: 'calibration', action: 'cancel', requestId: `cal-${calibrationId.current}` });
    },
    runAnalysis: (horizonMin?: number) => {
      analysisId.current += 1;
      setAnalysisLoading(true);
      setAnalysisError(null);
      send({ type: 'analysis', action: 'run', requestId: `analysis-${analysisId.current}`, horizonMin });
    },
  };
}

export type SimulationApi = ReturnType<typeof useSimulation>;

import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, PlantSnapshot, ServerMessage } from '../../shared/protocol';
import type { Answer, Recommendation } from '../../ai/agent';
import type { ControlSettings } from '../../sim/config';
import type { ScenarioType } from '../../sim/scenarios';
import type { ProcessTopology } from '../../model/topology';
import type { DiscoveredModel, LlmDraft, LlmProtocol, LlmPublicConfig, LlmTestResult } from '../../shared/llm';
import type { AgentConfig, AgentSummary } from '../../shared/agentConfig';
import type { WatchdogReport } from '../../shared/protocol';
import { nextSendPlan, reconnectDelayMs } from './wsPolicy';
import { mergeSnapshot } from './snapshotMerge';

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
  const [notices, setNotices] = useState<{ id: number; level: string; text: string }[]>([]);
  const [link, setLink] = useState<LinkState>({ connected: false, error: null, lastUpdateAt: null });
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [topology, setTopology] = useState<ProcessTopology | null>(null);
  const [topologyRevision, setTopologyRevision] = useState(1);
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
  const llmSaveResolve = useRef<((ok: boolean) => void) | null>(null);

  // Agent 配置（角色/提示词/技能/钩子/约束/权限）
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
  const [agentCore, setAgentCore] = useState<string[]>([]);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentPromptPreview, setAgentPromptPreview] = useState<string | null>(null);
  const agentRequestId = useRef(0);
  const [watchdog, setWatchdog] = useState<WatchdogReport | null>(null);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      /**
       * 浏览器无法为 WebSocket 握手设置 Authorization 头，
       * 因此令牌通过子协议传递（服务端 verifyClient 支持 `token.<value>`）。
       */
      const token = readToken();
      const ws = token
        ? new WebSocket(`${proto}://${window.location.host}/ws`, [`token.${token}`])
        : new WebSocket(`${proto}://${window.location.host}/ws`);
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
      };
      // 发送缓冲降到低水位时冲刷背压积压的最后一条意图
      ws.addEventListener('bufferedamountlow', () => {
        const live = socketRef.current;
        if (!pendingSendRef.current || !live || live.readyState !== WebSocket.OPEN) return;
        const msg = pendingSendRef.current;
        pendingSendRef.current = null;
        live.send(JSON.stringify(msg));
      });
      ws.onmessage = (event) => {
        setLink((prev) => ({ ...prev, lastUpdateAt: Date.now() }));
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          // 服务端发来非 JSON（或连接被中途截断）时忽略该帧，不要让异常冒泡
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
            break;
          case 'chat':
            chatId.current += 1;
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
            setNotices((prev) => [{ id: noticeId.current, level: msg.level, text: msg.text }, ...prev.slice(0, 4)]);
            break;
          case 'simState':
            setPaused(msg.paused);
            setSpeed(msg.speed);
            break;
          case 'topology':
            setTopology(msg.data);
            setTopologyRevision((r) => r + 1);
            break;
          case 'llmConfig':
            if (msg.action === 'config') {
              setLlmConfig(msg.config);
              setLlmError(null);
              break;
            }
            if (msg.action === 'discovered') {
              setLlmModels(msg.models);
              setLlmDiscovering(false);
              setLlmLastDiscoverAt(Date.now());
              setLlmError(null);
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'tested') {
              setLlmTesting(false);
              setLlmTestResult(msg.result);
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'saved') {
              setLlmSaving(false);
              if (msg.ok) {
                if (msg.config) setLlmConfig(msg.config);
                else setLlmConfig(null);
                setLlmError(null);
                setLlmTestResult(null);
              } else {
                setLlmError(msg.error ?? '保存失败');
              }
              llmSaveResolve.current?.(msg.ok);
              llmSaveResolve.current = null;
              delete llmPending.current[msg.requestId];
              break;
            }
            if (msg.action === 'error') {
              setLlmDiscovering(false);
              setLlmTesting(false);
              setLlmSaving(false);
              setLlmError(msg.error);
              if (msg.requestId) delete llmPending.current[msg.requestId];
              llmSaveResolve.current?.(false);
              llmSaveResolve.current = null;
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
              setAgentSaving(false);
              setAgentError(msg.error);
            }
            break;
          case 'watchdog':
            setWatchdog(msg.report);
            break;
          default:
            break;
        }
      };
      ws.onclose = () => {
        setLink((prev) => ({ ...prev, connected: false, error: '与仿真服务的连接已断开' }));
        if (closed) return;
        retry.current += 1;
        // 抖动退避：多客户端同时断线时避免重连请求同步撞击服务端
        setTimeout(connect, reconnectDelayMs(retry.current));
      };
      ws.onerror = () => {
        setLink((prev) => ({ ...prev, connected: false, error: '连接仿真服务失败' }));
      };
    };
    connect();
    return () => {
      closed = true;
      socketRef.current?.close();
    };
  }, []);

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

  const ask = (text: string) => {
    if (!text.trim()) return;
    chatId.current += 1;
    setChat((prev) => [...prev, { id: chatId.current, role: 'user', text, at: Date.now() }]);
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
  const refreshDecision = () => send({ type: 'refreshDecision' });
  const applyPreset = (id: string) => send({ type: 'preset', id });
  const requestTopology = () => send({ type: 'topology', action: 'get' });
  const applyTopology = (topo: ProcessTopology) => send({ type: 'topology', action: 'apply', topology: topo });

  const nextLlmRequestId = () => {
    llmRequestId.current += 1;
    return `llm-${llmRequestId.current}`;
  };
  const llmReload = () => send({ type: 'llmConfig', action: 'get' });
  const llmDiscover = (input: { protocol: LlmProtocol; baseUrl: string; apiKey?: string }) => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'discover';
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
    setLlmTesting(true);
    setLlmTestResult(null);
    send({ type: 'llmConfig', action: 'test', requestId, ...input });
  };
  const llmSave = (draft: LlmDraft) => {
    const requestId = nextLlmRequestId();
    llmPending.current[requestId] = 'save';
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
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'save', requestId: nextAgentId(), config });
    },
    reset: () => {
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'reset', requestId: nextAgentId() });
    },
    reload: () => send({ type: 'agentConfig', action: 'get' }),
    requestPreview: (question, config) => {
      setAgentPromptPreview(null);
      // 预览按草稿算，而不是按已保存的配置：用户改完还没保存也能看到效果
      send({ type: 'agentConfig', action: 'previewPrompt', requestId: nextAgentId(), question, config });
    },
    importSkill: (skill) => {
      setAgentSaving(true);
      setAgentError(null);
      send({ type: 'agentConfig', action: 'importSkill', requestId: nextAgentId(), skill });
    },
  };

  return {
    snapshot,
    recommendation,
    chat,
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
    requestTopology,
    applyTopology,
    llm,
    agent: agentApi,
    watchdog,
    watchdogReload: () => send({ type: 'watchdog', action: 'get' }),
  };
}

export type SimulationApi = ReturnType<typeof useSimulation>;

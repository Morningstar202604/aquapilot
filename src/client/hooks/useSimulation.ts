import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, PlantSnapshot, ServerMessage } from '../../shared/protocol';
import type { Answer, Recommendation } from '../../ai/agent';
import type { ControlSettings } from '../../sim/config';
import type { ScenarioType } from '../../sim/scenarios';
import type { ProcessTopology } from '../../model/topology';
import { nextSendPlan, reconnectDelayMs } from './wsPolicy';

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
            // 增量合并：只覆盖变化字段，趋势追加新点
            setSnapshot((prev) => {
              if (!prev) return prev;
              const p = msg.data;
              if (!p || typeof p.timeMin !== 'number' || !p.effluent || !Array.isArray(p.tanks)) {
                console.warn('discarded malformed snapshot patch');
                return prev;
              }
              return {
                ...prev,
                timeMin: p.timeMin,
                influent: { ...prev.influent, flow: p.influentFlow },
                effluent: p.effluent,
                tanks: prev.tanks.map((t) => {
                  const patch = p.tanks.find((x) => x.id === t.id);
                  return patch ? { ...t, ...patch } : t;
                }),
                clarifier: { ...prev.clarifier, ...p.clarifier },
                energy: p.energy,
                cost: { ...prev.cost, ...p.cost },
                srtDays: p.srtDays,
                score: p.score,
                margins: p.margins,
                trends: p.trendsAppend.length > 0 ? [...prev.trends, ...p.trendsAppend].slice(-720) : prev.trends,
                activeAlarms: p.activeAlarms,
                alarmAttribution: p.alarmAttribution ?? prev.alarmAttribution,
                health: p.health ?? prev.health,
                stormStorageM3: p.stormStorageM3,
                reactorCount: p.reactorCount,
              };
            });
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
  };
}

export type SimulationApi = ReturnType<typeof useSimulation>;

import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, PlantSnapshot, ServerMessage } from '../../shared/protocol';
import type { Answer, Recommendation } from '../../ai/agent';
import type { ControlSettings } from '../../sim/config';
import type { ScenarioType } from '../../sim/scenarios';
import type { ProcessTopology } from '../../model/topology';

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
}

export function useSimulation() {
  const [snapshot, setSnapshot] = useState<PlantSnapshot | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [notices, setNotices] = useState<{ id: number; level: string; text: string }[]>([]);
  const [link, setLink] = useState<LinkState>({ connected: false, error: null });
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [topology, setTopology] = useState<ProcessTopology | null>(null);
  const [topologyRevision, setTopologyRevision] = useState(1);
  const socketRef = useRef<WebSocket | null>(null);
  const chatId = useRef(0);
  const noticeId = useRef(0);
  const retry = useRef(0);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => {
        setLink({ connected: true, error: null });
        retry.current = 0;
        ws.send(JSON.stringify({ type: 'hello' } satisfies ClientMessage));
      };
      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          // 服务端发来非 JSON（或连接被中途截断）时忽略该帧，不要让异常冒泡
          return;
        }
        switch (msg.type) {
          case 'snapshot':
            setSnapshot(msg.data);
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
            setNotices((prev) => [
              { id: noticeId.current, level: msg.level, text: msg.text },
              ...prev.slice(0, 4),
            ]);
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
        setLink({ connected: false, error: '与仿真服务的连接已断开' });
        if (closed) return;
        retry.current += 1;
        setTimeout(connect, Math.min(8000, 600 * retry.current));
      };
      ws.onerror = () => {
        setLink({ connected: false, error: '连接仿真服务失败' });
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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
    topology,
    topologyRevision,
    requestTopology,
    applyTopology,
  };
}

export type SimulationApi = ReturnType<typeof useSimulation>;

import { createServer, IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { answer, decide, Recommendation } from '../ai/agent';
import { CONTROL_BOUNDS, DEFAULT_CONTROLS, LIMITS, PLANT } from '../sim/config';
import { SCENARIOS, ScenarioType } from '../sim/scenarios';
import { NetworkSimState, networkModel, qualityScoreOf, stepNetwork } from '../sim/networkEngine';
import { CompiledNetwork } from '../sim/network';
import { estimateMargin } from '../sim/metrics';
import type { ClientMessage, PlantSnapshot, ServerMessage, TrendPoint } from '../shared/protocol';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../model/topology';
import { applyTopology, checkRunReadiness, createRuntime } from './topologyRuntime';
import { compileNetwork } from '../sim/network';

const PORT = Number(process.env.PORT ?? 5173);
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
const SIM_MINUTES_PER_TICK = Number(process.env.SIM_MINUTES_PER_TICK ?? 2);
const AI_CYCLE_TICKS = 30;
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
  aiTick: number;
  clients: Set<WebSocket>;
}

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

function buildSnapshot(): PlantSnapshot {
  const s = runtime.net;
  const model = networkModel(runtime.topology, s);
  const fc = runtime.recommendation ? model.predict(s.controls, 240, 30) : null;

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
    alarms: s.alarms.slice(-20).reverse().map((a) => ({ ...a })),
    activeAlarms: currentAlarms(s),
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
    limits: LIMITS,
    totals: {
      inflowM3: s.influent.flow * (s.timeMin / 60),
      energyKwh: s.energy.totalKw * (s.timeMin / 60),
      cost: s.cost.total,
      wasteSludgeKg: s.cost.sludge / 0.36,
      elapsedMin: s.timeMin,
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
  if (s.effluent.nh > LIMITS.nh) push('EFF_NH', 'critical', `出水氨氮 ${s.effluent.nh.toFixed(2)} mg/L 超限`, 'nh', s.effluent.nh);
  if (s.effluent.cod > LIMITS.cod) push('EFF_COD', 'critical', `出水 COD ${s.effluent.cod.toFixed(1)} mg/L 超限`, 'cod', s.effluent.cod);
  if (s.effluent.tp > LIMITS.tp) push('EFF_TP', 'warning', `出水总磷 ${s.effluent.tp.toFixed(3)} mg/L 超限`, 'tp', s.effluent.tp);
  if (s.effluent.ss > LIMITS.ss) push('EFF_SS', 'warning', `出水悬浮物 ${s.effluent.ss.toFixed(1)} mg/L 超限`, 'ss', s.effluent.ss);
  if (last && last.doLevel < 1) push('DO_LOW', 'warning', `好氧区溶解氧 ${last.doLevel.toFixed(2)} mg/L 低于下限`, 'do', last.doLevel);
  if (s.clarifier.blanketM > s.clarifier.depth - 0.4)
    push('SLUDGE_BLANKET', 'critical', `二沉池泥位 ${s.clarifier.blanketM.toFixed(2)} m 接近跑泥`, 'blanket', s.clarifier.blanketM);
  if (s.srtDays < 8) push('SRT_LOW', 'warning', `污泥龄 ${s.srtDays.toFixed(1)} d 偏低`, 'srt', s.srtDays);
  return out;
}

function topologyMessage(): { type: 'topology'; data: ProcessTopology; dirty: boolean; readiness: ReturnType<typeof checkRunReadiness> } {
  return {
    type: 'topology',
    data: runtime.topology,
    dirty: false,
    readiness: checkRunReadiness(runtime.topology),
  };
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
  const rec = decide({ model, horizonMin: 240 });
  runtime.recommendation = rec;
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
  }
  if (s.scenario && s.timeMin > s.scenario.startedAt + s.scenario.durationMin + 30) {
    s.scenario = null;
    broadcast({ type: 'notice', level: 'info', text: '场景窗口结束，恢复正常工况监视。' });
  }
  runtime.aiTick += 1;
  if (runtime.aiTick % AI_CYCLE_TICKS === 0) {
    runAiCycle();
  }
  broadcastSnapshot();
}

function handleClientMessage(ws: WebSocket, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'notice', level: 'error', text: '消息格式错误' } satisfies ServerMessage));
    return;
  }

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
      const contextual = answer(msg.text, networkModel(runtime.topology, runtime.net), runtime.recommendation);
      ws.send(JSON.stringify({ type: 'chat', question: msg.text, answer: contextual } satisfies ServerMessage));
      break;
    }
    case 'control': {
      const patch = { ...msg.patch };
      if (patch.aiEnabled !== undefined) delete patch.aiEnabled;
      runtime.net.controls = { ...runtime.net.controls, ...patch, aiEnabled: runtime.net.controls.aiEnabled };
      runAiCycle(true);
      broadcastSnapshot();
      break;
    }
    case 'aiEnabled': {
      runtime.net.controls.aiEnabled = msg.enabled;
      ws.send(
        JSON.stringify({
          type: 'notice',
          level: 'info',
          text: msg.enabled ? 'AI 自动值守已启用，将自动执行控制调节。' : 'AI 已切换为建议模式，控制调节需人工确认。',
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
        const meta = SCENARIOS[msg.scenario as ScenarioType];
        if (!meta) return;
        runtime.net.scenario = {
          type: msg.scenario,
          durationMin: msg.durationMin ?? meta.defaultDurationMin,
          magnitude: msg.magnitude ?? meta.defaultMagnitude,
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
      runtime.speed = Math.min(8, Math.max(0.25, msg.value));
      broadcast({ type: 'simState', paused: runtime.paused, speed: runtime.speed });
      break;
    }
    case 'refreshDecision': {
      runAiCycle(true);
      broadcastSnapshot();
      break;
    }
    case 'topology': {
      if (msg.action === 'get') {
        ws.send(JSON.stringify({ ...topologyMessage() } satisfies ServerMessage));
        break;
      }
      if (msg.action === 'apply') {
        const incoming = msg.topology;
        const rt = {
          topology: runtime.topology,
          compiled: runtime.compiled,
          appliedAt: Date.now(),
          revision: runtime.topologyRevision,
          net: runtime.net,
        };
        const result = applyTopology(rt, incoming);
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
        runtime.topology = incoming;
        runtime.topologyRevision += 1;
        runtime.recommendation = null;
        runtime.trend = [];
        pushTrend(runtime.net, runtime.trend);
        runAiCycle(true);
        broadcast({ type: 'notice', level: 'info', text: `工艺拓扑已应用（第 ${runtime.topologyRevision} 版），厂已按新拓扑重建并完成预热。` });
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
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = normalize(join(clientDir, urlPath === '/' ? 'index.html' : urlPath));

  if (!filePath.startsWith(clientDir)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath)) {
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
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/limits')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ limits: LIMITS, bounds: CONTROL_BOUNDS, plant: PLANT }));
      return;
    }
    if (req.url?.startsWith('/api/topology')) {
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
    if (req.url?.startsWith('/api/snapshot')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildSnapshot()));
      return;
    }
    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    runtime.clients.add(ws);
    ws.on('message', (data) => handleClientMessage(ws, data.toString()));
    ws.on('close', () => runtime.clients.delete(ws));
    ws.on('error', () => runtime.clients.delete(ws));
  });

  setInterval(() => {
    if (!runtime.paused) advance();
  }, TICK_MS);

  pushTrend(runtime.net, runtime.trend);
  runAiCycle();
  runtime.net.controls.aiEnabled = true;

  server.listen(PORT, () => {
    console.log(`HYDRA 仿真台已启动：http://127.0.0.1:${PORT}`);
    console.log(`WebSocket: ws://127.0.0.1:${PORT}/ws | 速度 ${runtime.speed}x | 每 tick ${SIM_MINUTES_PER_TICK} 仿真分钟`);
  });
}

main().catch((err) => {
  console.error('server failed', err);
  process.exit(1);
});

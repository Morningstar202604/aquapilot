/**
 * MCP（Model Context Protocol）Streamable HTTP 端点——无 SSE 的保守实现。
 *
 * 背景（2026-03 调研，见 docs/AGENT-HARNESS.md）：MCP 已是 agent↔工具层的事实
 * 标准，LangGraph / OpenAI Agents SDK / CrewAI / Vercel AI SDK / Mastra 全部
 * 能直接消费一个 Streamable HTTP URL。实现本端点后，AquaPilot 仿真器即可被
 * 任意主流 agent 框架当作工具调用，无需任何适配代码。
 *
 * 协议要点（https://modelcontextprotocol.io/specification/2025-06-18）：
 * - 单一端点 POST /mcp；GET 无 SSE 时回 405 即合规；notification 回 202。
 * - initialize 响应声明 protocolVersion 与 capabilities；无状态实现可不发
 *   Mcp-Session-Id。
 * - 客户端后续请求必须带 `MCP-Protocol-Version`；缺失时假定 2025-03-26，
 *   无效值必须回 400。
 * - 安全 MUST：校验 Origin（防 DNS rebinding）、校验全部工具输入、限流由
 *   外层 HTTP 路由统一施加。
 * - 工具执行错误用 result.isError=true + 文本 content 返回（供模型自纠错）；
 *   未知工具 / 参数非法用 JSON-RPC -32602。
 *
 * 工具粒度仿照官方 sqlite server 的读写分离六工具模式：
 * 内省（list_scenarios / plant_state）/ 写（set_control / start_scenario /
 * clear_scenario / reset_sim / apply_recommendation）/ 纯计算
 * （simulate_headless，不触碰运行态，agent 可任意试算）/ 报表（get_report）。
 */
import type { ProcessTopology } from '../model/topology';
import {
  createNetworkState,
  spinUpNetwork,
  stepNetwork,
  startNetworkScenario,
  qualityScoreOf,
} from '../sim/networkEngine';
import { SCENARIOS, type ScenarioType } from '../sim/scenarios';
import { CONTROL_BOUNDS } from '../sim/config';

/** MCP protocol version this server speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Versions the server accepts on subsequent requests (newest first). */
const ACCEPTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
/** Version assumed when the client omits the header (per spec). */
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export interface McpFacade {
  /** package.json version, surfaced in serverInfo. */
  serverVersion: string;
  getTopology(): ProcessTopology;
  /** 活动厂快照摘要（与 WS 广播同源，由 index.ts 注入 buildSnapshot）。 */
  getState(): Record<string, unknown>;
  setControl(patch: Record<string, unknown>): { ok: boolean; error?: string; clamped?: string[] };
  startScenario(kind: string, durationMin?: number, magnitude?: number): { ok: boolean; error?: string };
  clearScenario(): { ok: boolean };
  resetSim(): { ok: boolean };
  applyRecommendation(): { ok: boolean; error?: string };
  getMetrics(): string;
  getReport(): string;
}

export interface McpRequestInput {
  httpMethod: string;
  origin: string | null;
  /** 请求的 Host 头：用于判断 Origin 是否同源（防 DNS rebinding，规范 MUST） */
  host: string | null;
  protocolVersionHeader: string | null;
  body: unknown;
  facade: McpFacade;
}

export interface McpResult {
  status: number;
  headers?: Record<string, string>;
  /** undefined body ⇒ 204/202 无响应体 */
  body?: unknown;
}

/* ------------------------------------------------------------------ */
/* 工具注册表                                                          */
/* ------------------------------------------------------------------ */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** readOnlyHint：只读工具可被 agent 无顾虑地高频调用（MCP annotations） */
  readOnly: boolean;
  run(args: Record<string, unknown>, facade: McpFacade): { content: string; structured?: unknown; isError?: true };
}

const CONTROL_KEYS = [
  'doSetpoint',
  'internalRecirc',
  'rasRatio',
  'wasRatio',
  'pacDose',
  'carbonDose',
  'alkDose',
  'stormStore',
  'stepFeed',
] as const;

function controlSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const k of CONTROL_KEYS) {
    const b = CONTROL_BOUNDS[k];
    props[k] = { type: 'number', minimum: b.min, maximum: b.max, description: `${k} (${b.min}–${b.max})` };
  }
  return { type: 'object', properties: props, additionalProperties: false };
}

const scenarioNames = Object.keys(SCENARIOS);

const TOOLS: ToolDef[] = [
  {
    name: 'plant_state',
    description:
      '读取污水厂当前运行状态：进出水水质、各反应器 DO/MLSS、控制量、累计水量/电耗/成本、活动告警与健康度。只读。',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      const state = facade.getState();
      return { content: JSON.stringify(state, null, 2), structured: state };
    },
  },
  {
    name: 'set_control',
    description:
      '设置曝气 DO 设定点、内回流比、污泥回流比、排泥比、加药量等控制量。数值会被夹紧到安全边界；设置后进入 30 分钟人工优先期（AI 只建议不覆盖）。',
    readOnly: false,
    inputSchema: controlSchema(),
    run(args, facade) {
      const patch: Record<string, number> = {};
      for (const k of CONTROL_KEYS) {
        const v = args[k];
        if (v !== undefined) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            return { content: `参数 ${k} 必须是有限数字`, isError: true };
          }
          patch[k] = v;
        }
      }
      if (Object.keys(patch).length === 0) {
        return { content: '至少提供一个控制量字段', isError: true };
      }
      const r = facade.setControl(patch);
      if (!r.ok) return { content: r.error ?? '设置失败', isError: true };
      return { content: JSON.stringify({ ok: true, applied: patch, clamped: r.clamped ?? [] }) };
    },
  },
  {
    name: 'list_scenarios',
    description: '列出全部可注入的扰动场景（暴雨、冲击负荷、毒性、鼓风机故障等）及其默认时长与幅度。只读。',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run() {
      return { content: JSON.stringify(SCENARIOS, null, 2), structured: SCENARIOS };
    },
  },
  {
    name: 'start_scenario',
    description: '向正在运行的厂注入一个扰动场景（如暴雨冲击），可指定持续时长与幅度。',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', enum: scenarioNames, description: '场景类型' },
        durationMin: { type: 'number', minimum: 10, maximum: 2880, description: '持续分钟（仿真时间）' },
        magnitude: { type: 'number', minimum: 0, maximum: 3, description: '幅度倍率' },
      },
      required: ['scenario'],
      additionalProperties: false,
    },
    run(args, facade) {
      const kind = String(args.scenario);
      if (!(kind in SCENARIOS)) {
        return { content: `未知场景 ${kind}，可用：${scenarioNames.join(', ')}`, isError: true };
      }
      const r = facade.startScenario(
        kind,
        typeof args.durationMin === 'number' ? args.durationMin : undefined,
        typeof args.magnitude === 'number' ? args.magnitude : undefined,
      );
      if (!r.ok) return { content: r.error ?? '启动失败', isError: true };
      return { content: JSON.stringify({ ok: true, scenario: kind }) };
    },
  },
  {
    name: 'clear_scenario',
    description: '结束当前活动场景，恢复常规进水。',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      const r = facade.clearScenario();
      return { content: JSON.stringify(r) };
    },
  },
  {
    name: 'reset_sim',
    description:
      '重置仿真到初始稳态（时钟归零、累计量清零）。破坏性操作：会丢弃当前运行的全部累计数据。',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      const r = facade.resetSim();
      return { content: JSON.stringify(r) };
    },
  },
  {
    name: 'apply_recommendation',
    description: '采纳 AI 决策引擎当前给出的控制建议并立即执行。',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      const r = facade.applyRecommendation();
      if (!r.ok) return { content: r.error ?? '当前没有可执行的建议', isError: true };
      return { content: JSON.stringify(r) };
    },
  },
  {
    name: 'simulate_headless',
    description:
      '离线推演：在不影响正在运行的厂的情况下，对当前工艺拓扑跑一段虚拟仿真并返回出水水质/达标/能耗汇总。用于 What-if 试算与方案比选，可叠加扰动场景与自定义控制量。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        durationMin: { type: 'number', minimum: 30, maximum: 1440, description: '推演时长（仿真分钟，预热另计）' },
        scenario: { type: 'string', enum: scenarioNames, description: '可选：叠加的扰动场景' },
        controls: controlSchema(),
      },
      required: ['durationMin'],
      additionalProperties: false,
    },
    run(args, facade) {
      const durationMin = args.durationMin;
      if (typeof durationMin !== 'number' || !Number.isFinite(durationMin) || durationMin < 30 || durationMin > 1440) {
        return { content: 'durationMin 必须在 30–1440 之间', isError: true };
      }
      let controls: Record<string, unknown> | undefined;
      if (args.controls !== undefined) {
        if (!args.controls || typeof args.controls !== 'object' || Array.isArray(args.controls)) {
          return { content: 'controls 必须是对象', isError: true };
        }
        controls = args.controls as Record<string, unknown>;
        for (const [k, v] of Object.entries(controls)) {
          if (!(CONTROL_KEYS as readonly string[]).includes(k)) {
            return { content: `未知控制量 ${k}`, isError: true };
          }
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            return { content: `控制量 ${k} 必须是有限数字`, isError: true };
          }
        }
      }
      let scenario: ScenarioType | undefined;
      if (args.scenario !== undefined) {
        const k = String(args.scenario);
        if (!(k in SCENARIOS)) return { content: `未知场景 ${k}`, isError: true };
        scenario = k as ScenarioType;
      }
      try {
        const topo = facade.getTopology();
        let state = spinUpNetwork(createNetworkState(topo, { seed: 20261019 }), topo, 5);
        if (scenario) {
          startNetworkScenario(state, scenario);
        }
        if (controls) {
          for (const [k, v] of Object.entries(controls)) {
            const bound = CONTROL_BOUNDS[k as keyof typeof CONTROL_BOUNDS];
            if (bound) {
              const key = k as keyof typeof CONTROL_BOUNDS;
              (state.controls[key] as number) = Math.min(bound.max, Math.max(bound.min, v as number));
            }
          }
        }
        const start = state.timeMin;
        const samples: { minute: number; cod: number; nh: number; tn: number; tp: number; ss: number; score: number }[] =
          [];
        while (state.timeMin - start < durationMin) {
          state = stepNetwork(state, topo, 1);
          if ((state.timeMin - start) % 30 === 0) {
            samples.push({
              minute: state.timeMin - start,
              cod: state.effluent.cod,
              nh: state.effluent.nh,
              tn: state.effluent.tn,
              tp: state.effluent.tp,
              ss: state.effluent.ss,
              score: qualityScoreOf(state.effluent),
            });
          }
        }
        const exceed = (v: number, lim: number) => Number((v / lim).toFixed(3));
        const summary = {
          durationMin,
          scenario: scenario ?? null,
          samples,
          worstRatios: {
            cod: exceed(Math.max(...samples.map((s) => s.cod)), 50),
            nh: exceed(Math.max(...samples.map((s) => s.nh)), 5),
            tn: exceed(Math.max(...samples.map((s) => s.tn)), 15),
            tp: exceed(Math.max(...samples.map((s) => s.tp)), 0.5),
            ss: exceed(Math.max(...samples.map((s) => s.ss)), 10),
          },
          compliant: samples.every((s) => s.cod <= 50 && s.nh <= 5 && s.tn <= 15 && s.tp <= 0.5 && s.ss <= 10),
          finalScore: samples[samples.length - 1]?.score ?? null,
        };
        return { content: JSON.stringify(summary, null, 2), structured: summary };
      } catch (err) {
        return { content: `推演失败：${String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'get_report',
    description: '生成 Markdown 运营报告（运行摘要、达标状况、能水耗与 AI vs 人工基准对比）。',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      return { content: facade.getReport() };
    },
  },
  {
    name: 'get_metrics',
    description: '获取 Prometheus 格式的服务器指标（HTTP/SLO/仿真 tick/持久化）。',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, facade) {
      return { content: facade.getMetrics() };
    },
  },
];

/* ------------------------------------------------------------------ */
/* JSON-RPC 处理                                                       */
/* ------------------------------------------------------------------ */

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

/**
 * 处理一条 MCP HTTP 请求。返回应答状态码与响应体。
 * 本函数是纯逻辑（无 express/路由耦合），测试直接驱动它。
 */
export function handleMcpRequest(input: McpRequestInput): McpResult {
  const { httpMethod, origin, host, protocolVersionHeader, facade } = input;

  // MCP 安全 MUST：校验 Origin（防 DNS rebinding）。
  // 非浏览器客户端（SDK/curl）通常不发 Origin —— 放行；
  // 浏览器请求的 Origin 必须与 Host 同源，或来自本机回环调试页。
  if (origin && !isAllowedOrigin(origin, host)) {
    return { status: 403, body: { error: 'cross-origin MCP request rejected' } };
  }

  if (httpMethod === 'GET') {
    // 本实现不提供 SSE 流：规范允许 GET /mcp 回 405
    return { status: 405, headers: { Allow: 'POST' } };
  }
  if (httpMethod === 'DELETE') {
    // 无状态实现：会话终止请求按规范可回 405
    return { status: 405, headers: { Allow: 'POST' } };
  }
  if (httpMethod !== 'POST') {
    return { status: 405, headers: { Allow: 'POST' } };
  }

  // 协议版本协商：缺失假定 2025-03-26，无效必须 400
  let protocolVersion = protocolVersionHeader ?? DEFAULT_PROTOCOL_VERSION;
  if (!ACCEPTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: ERR_INVALID_REQUEST, message: `Unsupported MCP-Protocol-Version: ${protocolVersion}` },
      },
    };
  }
  protocolVersion = MCP_PROTOCOL_VERSION;

  const rpc = input.body as { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return { status: 400, body: rpcError(null, ERR_PARSE, '请求不是合法的 JSON-RPC 2.0 消息') };
  }
  const isNotification = !('id' in rpc);
  const id = rpc.id;

  switch (rpc.method) {
    case 'initialize': {
      const result = {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aquapilot', version: facade.serverVersion },
      };
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      // notification：无响应体，202 Accepted
      return { status: 202 };
    case 'tools/list': {
      const tools = TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly },
      }));
      return { status: 200, body: rpcResult(id, { tools }) };
    }
    case 'tools/call': {
      const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === 'string' ? params.name : null;
      if (!params || !name) {
        return { status: 200, body: rpcError(id, ERR_INVALID_PARAMS, '缺少工具名 name') };
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return { status: 200, body: rpcError(id, ERR_INVALID_PARAMS, `未知工具: ${name}`) };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (args && typeof args !== 'object') {
        return { status: 200, body: rpcError(id, ERR_INVALID_PARAMS, 'arguments 必须是对象') };
      }
      try {
        const out = tool.run(args, facade);
        const result: Record<string, unknown> = { content: [{ type: 'text', text: out.content }] };
        if (out.isError) result.isError = true;
        if (out.structured !== undefined) result.structuredContent = out.structured;
        return { status: 200, body: rpcResult(id, result) };
      } catch (err) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: `工具执行异常：${String(err)}` }],
            isError: true,
          }),
        };
      }
    }
    default:
      if (isNotification) return { status: 202 };
      return {
        status: 200,
        body: rpcError(id, ERR_INVALID_REQUEST, `不支持的方法: ${rpc.method}`),
      };
  }
}

/** 按名查工具（供 HTTP 层做分级鉴权；未知返回 undefined）。 */
export function mcpToolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 解析并执行一批工具调用错误时的统一内部错误兜底（供路由层 catch 使用）。 */
export function mcpInternalError(err: unknown): McpResult {
  return { status: 200, body: rpcError(null, ERR_INTERNAL, `内部错误: ${String(err)}`) };
}

function isAllowedOrigin(origin: string, host: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
    return true;
  }
  if (!host) return false;
  // Origin 的 host:port 与请求 Host 头一致即同源
  return parsed.host === host;
}

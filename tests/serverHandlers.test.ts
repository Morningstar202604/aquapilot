import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createMcpHttpHandler } from '../src/server/mcpHttp';
import { mcpInternalError } from '../src/server/mcp';
import { handleChatMessage, type ChatHandlerDeps } from '../src/server/chatHandler';
import { createLlmConfigHandler } from '../src/server/llmConfigHandler';
import { freshClientState, type ClientState } from '../src/server/rateLimit';
import type { McpFacade } from '../src/server/mcp';
import type { Answer } from '../src/shared/aiTypes';

/**
 * 三个从 index.ts 拆出的信任边界：MCP HTTP 壳、聊天分支、模型配置。
 *
 * 这三个模块此前只有「被入口间接带到」的覆盖率，鉴权失败、限流、
 * 空输入、跨源密钥保护等分支从未真正执行。这里用假 req/res/ws 直接驱动，
 * 不启动仿真服务。
 */

vi.mock('../src/ai/providers', () => ({
  discoverModels: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../src/server/agentConfigCommands', () => ({
  parseAgentCommand: vi.fn(),
}));

vi.mock('../src/server/agentConfig', () => ({
  agentConfigStore: {
    get: vi.fn(),
    save: vi.fn(),
  },
}));

vi.mock('../src/server/llmConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/llmConfig')>();
  return {
    ...actual,
    llmConfigStore: {
      getPublic: vi.fn(),
      clear: vi.fn(),
      hasKeyForOtherOrigin: vi.fn(),
      resolveKey: vi.fn((key: string) => key),
      save: vi.fn(),
    },
  };
});

import { discoverModels, testConnection } from '../src/ai/providers';
import { parseAgentCommand } from '../src/server/agentConfigCommands';
import { agentConfigStore } from '../src/server/agentConfig';
import { llmConfigStore } from '../src/server/llmConfig';

const discoverMock = vi.mocked(discoverModels);
const testMock = vi.mocked(testConnection);
const parseMock = vi.mocked(parseAgentCommand);
const cfgGetMock = vi.mocked(agentConfigStore.get);
const cfgSaveMock = vi.mocked(agentConfigStore.save);
const llmStore = vi.mocked(llmConfigStore);

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeResponse(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: '', ended: false };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(body?: string) {
      out.body = body ?? '';
      out.ended = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function fakeRequest(
  body: unknown,
  opts: { method?: string; authorization?: string; ip?: string; raw?: string } = {},
): IncomingMessage {
  const payload = opts.raw ?? JSON.stringify(body);
  const req = Readable.from([Buffer.from(payload, 'utf8')]) as unknown as IncomingMessage & {
    method?: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  req.method = opts.method ?? 'POST';
  req.headers = {
    host: 'localhost:5173',
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  };
  req.socket = { remoteAddress: opts.ip ?? '127.0.0.1' } as never;
  return req;
}

const facade: McpFacade = {
  serverVersion: '0.0.0-test',
  getTopology: () => ({}) as never,
  getState: () => ({ ok: true }),
  setControl: () => ({ ok: true }),
  startScenario: () => ({ ok: true }),
  clearScenario: () => ({ ok: true }),
  resetSim: () => ({ ok: true }),
  applyRecommendation: () => ({ ok: true }),
  getMetrics: () => '',
  getReport: () => '',
  getScorecard: () => ({}),
};

describe('MCP HTTP 壳', () => {
  it('合法 JSON-RPC 请求返回 200', async () => {
    const handle = createMcpHttpHandler(facade);
    const { res, out } = fakeResponse();
    await handle(fakeRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }), res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toHaveProperty('result');
  });

  it('空体与坏 JSON 交给协议层回 400', async () => {
    const handle = createMcpHttpHandler(facade);
    const empty = fakeResponse();
    await handle(fakeRequest(null, { raw: '' }), empty.res);
    expect(empty.out.status).toBe(400);
    const broken = fakeResponse();
    await handle(fakeRequest(null, { raw: '{oops' }), broken.res);
    expect(broken.out.status).toBe(400);
  });

  it('鉴权开启时无令牌被拒，401 且记一次失败', async () => {
    process.env.AQUAPILOT_TOKEN = 'secret-token';
    try {
      const handle = createMcpHttpHandler(facade);
      const { res, out } = fakeResponse();
      await handle(fakeRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }), res);
      expect(out.status).toBe(401);
      expect(JSON.parse(out.body).requiredRole).toBe('viewer');
    } finally {
      delete process.env.AQUAPILOT_TOKEN;
    }
  });

  it('写工具需要 operator，viewer 令牌被拒', async () => {
    process.env.AQUAPILOT_VIEWER_TOKEN = 'viewer-token';
    try {
      const handle = createMcpHttpHandler(facade);
      const { res, out } = fakeResponse();
      await handle(
        fakeRequest(
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'set_control', arguments: {} } },
          { authorization: 'Bearer viewer-token' },
        ),
        res,
      );
      expect(out.status).toBe(401);
      expect(JSON.parse(out.body).requiredRole).toBe('operator');
    } finally {
      delete process.env.AQUAPILOT_VIEWER_TOKEN;
    }
  });

  it('同一 IP 超过 60 次/分钟返回 429', async () => {
    const handle = createMcpHttpHandler(facade);
    for (let i = 0; i < 60; i += 1) {
      const { res } = fakeResponse();
      await handle(fakeRequest({ jsonrpc: '2.0', id: i, method: 'ping' }, { ip: '10.0.0.9' }), res);
    }
    const blocked = fakeResponse();
    await handle(fakeRequest({ jsonrpc: '2.0', id: 99, method: 'ping' }, { ip: '10.0.0.9' }), blocked.res);
    expect(blocked.out.status).toBe(429);
    expect(JSON.parse(blocked.out.body).error).toContain('rate limited');
  });

  it('工具内部异常被协议层兜成 isError，不把进程打挂', async () => {
    const broken: McpFacade = {
      ...facade,
      getState: () => {
        throw new Error('boom');
      },
    };
    const handle = createMcpHttpHandler(broken);
    const { res, out } = fakeResponse();
    await handle(
      fakeRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plant_state', arguments: {} } }),
      res,
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).result.isError).toBe(true);
  });

  it('HTTP 壳兜底构造 -32603', () => {
    const out = mcpInternalError(new Error('boom'));
    expect(out.status).toBe(200);
    expect((out.body as { error: { code: number } }).error.code).toBe(-32603);
  });
});

function makeChatDeps(overrides: Partial<ChatHandlerDeps> = {}): { deps: ChatHandlerDeps; sent: unknown[] } {
  const sent: unknown[] = [];
  let state = freshClientState();
  const answer: Answer = {
    title: '规则答案',
    body: 'ok',
    bullets: [],
    confidence: 0.9,
    kind: 'status',
    source: 'rule',
  };
  const deps: ChatHandlerDeps = {
    send: (payload) => sent.push(payload),
    role: 'admin',
    rateLimited: () => false,
    throttledNotice: vi.fn(),
    state: () => state,
    saveState: (next) => {
      state = next;
    },
    hooks: { fire: vi.fn(async () => undefined) } as never,
    ruleAnswer: vi.fn(() => answer),
    enhance: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, sent };
}

const chatMsg = (text: unknown) => ({ type: 'chat', text }) as never;

describe('聊天分支', () => {
  beforeEach(() => {
    parseMock.mockReturnValue({ handled: false, reply: '' } as never);
    cfgGetMock.mockReturnValue({} as never);
  });

  it('空输入直接回错误提示', () => {
    const { deps, sent } = makeChatDeps();
    handleChatMessage(chatMsg(''), deps);
    expect(sent[0]).toMatchObject({ type: 'notice', level: 'error' });
    expect(deps.ruleAnswer).not.toHaveBeenCalled();
  });

  it('超过 2000 字被 sanitize 拒绝', () => {
    const { deps, sent } = makeChatDeps();
    handleChatMessage(chatMsg('x'.repeat(2001)), deps);
    expect(sent[0]).toMatchObject({ type: 'notice', level: 'error' });
  });

  it('连接级限流优先于一切回答', () => {
    const { deps, sent } = makeChatDeps({ rateLimited: () => true });
    handleChatMessage(chatMsg('正常问题'), deps);
    expect(deps.throttledNotice).toHaveBeenCalledWith('chat', expect.stringContaining('频繁'));
    expect(sent).toHaveLength(0);
  });

  it('在途 LLM 达到上限时提示等待', () => {
    const state = freshClientState();
    state.llmInFlight = 4;
    const { deps, sent } = makeChatDeps({ state: () => state });
    handleChatMessage(chatMsg('正常问题'), deps);
    expect(sent[0]).toMatchObject({ type: 'notice', level: 'warn' });
  });

  it('普通问题先发规则答案，再异步增强并归还在途计数', async () => {
    let state = freshClientState();
    const enhanced: string[] = [];
    const { deps, sent } = makeChatDeps({
      state: () => state,
      saveState: (next) => {
        state = next;
      },
      enhance: async (text) => {
        enhanced.push(text);
      },
    });
    handleChatMessage(chatMsg('出水氨氮偏高怎么办'), deps);
    expect(sent[0]).toMatchObject({ type: 'chat' });
    expect(enhanced).toEqual(['出水氨氮偏高怎么办']);
    await vi.waitFor(() => expect(state.llmInFlight).toBe(0));
  });

  it('配置命令查询无需写权限', () => {
    parseMock.mockReturnValueOnce({ handled: true, command: 'list', reply: '当前配置' });
    const { deps, sent } = makeChatDeps({ role: 'viewer' });
    handleChatMessage(chatMsg('配置'), deps);
    expect(sent[0]).toMatchObject({ type: 'chat', answer: { title: expect.stringContaining('配置查询') } });
    expect(cfgSaveMock).not.toHaveBeenCalled();
  });

  it('viewer 修改配置被拒绝，不落库', () => {
    parseMock.mockReturnValueOnce({ handled: true, next: { model: 'asm1' } as never, command: 'model', reply: '' });
    const { deps, sent } = makeChatDeps({ role: 'viewer' });
    handleChatMessage(chatMsg('切模型'), deps);
    expect(sent[0]).toMatchObject({ type: 'chat', answer: { title: '配置未生效' } });
    expect(cfgSaveMock).not.toHaveBeenCalled();
  });

  it('admin 修改配置成功并带 warning', () => {
    cfgGetMock.mockReturnValue({} as never);
    parseMock.mockReturnValueOnce({ handled: true, next: { model: 'asm2d' } as never, command: 'model', reply: '' });
    cfgSaveMock.mockReturnValueOnce({ ok: true, warnings: ['需重启'] } as never);
    const { deps, sent } = makeChatDeps();
    handleChatMessage(chatMsg('切到 asm2d'), deps);
    expect(cfgSaveMock).toHaveBeenCalled();
    expect((sent[0] as { answer: { body: string } }).answer.body).toContain('需重启');
  });

  it('保存失败回显错误且不触发 hooks', () => {
    cfgGetMock.mockReturnValue({} as never);
    parseMock.mockReturnValueOnce({ handled: true, next: { model: 'bad' } as never, command: 'model', reply: '' });
    cfgSaveMock.mockReturnValueOnce({ ok: false, error: '不支持' } as never);
    const { deps, sent } = makeChatDeps();
    handleChatMessage(chatMsg('切模型'), deps);
    expect((sent[0] as { answer: { body: string } }).answer.body).toBe('不支持');
    expect(deps.hooks.fire).not.toHaveBeenCalled();
  });

  it('命令执行失败显示“命令未执行”', () => {
    parseMock.mockReturnValueOnce({ handled: true, error: '参数缺失', reply: '用法：...' });
    const { deps, sent } = makeChatDeps();
    handleChatMessage(chatMsg('配置'), deps);
    expect(sent[0]).toMatchObject({ type: 'chat', answer: { title: '命令未执行' } });
  });
});

function fakeWs(): { ws: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  return { ws, sent };
}

const llmMsg = (action: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'llmConfig', action, requestId: 'r1', ...extra }) as never;

describe('模型配置 WS 处理器', () => {
  it('get 返回脱敏配置', async () => {
    llmStore.getPublic.mockReturnValueOnce({ baseUrl: 'https://api.example.com', hasKey: true } as never);
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('get'));
    expect(sent[0]).toMatchObject({ action: 'config', config: { hasKey: true } });
  });

  it('clear 清空并回执', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('clear'));
    expect(llmStore.clear).toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ action: 'saved', ok: true });
  });

  it('800ms 内连续操作被拒', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('discover', { baseUrl: 'https://api.example.com' }));
    await handle(ws, llmMsg('discover', { baseUrl: 'https://api.example.com' }));
    expect(sent[1]).toMatchObject({ action: 'error', error: expect.stringContaining('频繁') });
  });

  it('discover 校验 URL 长度与跨源密钥', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('discover', { baseUrl: 'x'.repeat(501) }));
    expect(sent[0]).toMatchObject({ action: 'error', error: 'Base URL 不合法' });
    state.clear();
    llmStore.hasKeyForOtherOrigin.mockReturnValueOnce(true);
    await handle(ws, llmMsg('discover', { baseUrl: 'https://evil.example.com' }));
    expect(sent[1]).toMatchObject({ action: 'error', error: expect.stringContaining('不同源') });
  });

  it('discover 成功返回模型列表，失败回错误文本', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    discoverMock.mockResolvedValueOnce(['m1', 'm2'] as never);
    await handle(ws, llmMsg('discover', { baseUrl: 'https://api.example.com', apiKey: 'k' }));
    expect(sent[0]).toMatchObject({ action: 'discovered', models: ['m1', 'm2'] });
    state.clear();
    discoverMock.mockRejectedValueOnce(new Error('unreachable'));
    await handle(ws, llmMsg('discover', { baseUrl: 'https://api.example.com', apiKey: 'k' }));
    expect(sent[1]).toMatchObject({ action: 'error', error: 'unreachable' });
  });

  it('test 缺地址或模型被拒', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('test', { baseUrl: 'https://api.example.com', model: '  ' }));
    expect(sent[0]).toMatchObject({ action: 'error', error: '请先填写地址与模型' });
  });

  it('test 跨源且未带新密钥被拒', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    llmStore.hasKeyForOtherOrigin.mockReturnValueOnce(true);
    await handle(ws, llmMsg('test', { baseUrl: 'https://evil.example.com', model: 'm' }));
    expect(sent[0]).toMatchObject({ action: 'error', error: expect.stringContaining('不同源') });
  });

  it('test 成功回 tested，带模型参数', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    testMock.mockResolvedValueOnce({ ok: true, latencyMs: 12 } as never);
    await handle(
      ws,
      llmMsg('test', { baseUrl: 'https://api.example.com', model: 'm1', maxOutput: 4096, reasoningEffort: 'low' }),
    );
    expect(sent[0]).toMatchObject({ action: 'tested', result: { ok: true } });
    expect(testMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm1', maxOutput: 4096, reasoningEffort: 'low' }),
    );
  });

  it('save 校验失败回 ok:false', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('save', { draft: { protocol: 'bad' } }));
    expect(sent[0]).toMatchObject({ action: 'saved', ok: false });
  });

  it('save 成功与落库失败两条路径', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    llmStore.save.mockReturnValueOnce({ ok: true, config: { model: 'm1' } } as never);
    await handle(
      ws,
      llmMsg('save', {
        draft: { protocol: 'openai', baseUrl: 'https://api.example.com', model: 'm1', apiKey: 'k' },
      }),
    );
    expect(sent[0]).toMatchObject({ action: 'saved', ok: true });
    state.clear();
    llmStore.save.mockReturnValueOnce({ ok: false, error: 'disk full' } as never);
    await handle(
      ws,
      llmMsg('save', {
        draft: { protocol: 'openai', baseUrl: 'https://api.example.com', model: 'm2', apiKey: 'k' },
      }),
    );
    expect(sent[1]).toMatchObject({ action: 'saved', ok: false, error: 'disk full' });
  });

  it('未知动作回错误', async () => {
    const state = new Map<WebSocket, ClientState>();
    const handle = createLlmConfigHandler({ clientState: () => state });
    const { ws, sent } = fakeWs();
    await handle(ws, llmMsg('nope'));
    expect(sent[0]).toMatchObject({ action: 'error', error: '未知的配置动作' });
  });
});

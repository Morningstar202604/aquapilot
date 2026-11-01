import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let PORT = 0;
const TOKEN = 'viewer-e2e-token';
const OPERATOR_TOKEN = 'operator-e2e-token';
const ADMIN_TOKEN = 'admin-e2e-token';
const tmpRoot = join(process.cwd(), '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const dataDir = mkdtempSync(join(tmpRoot, 'ws-auth-'));
let server: ChildProcess | undefined;

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error('failed to reserve test port');
  return port;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('test server did not become healthy');
}

const queues = new WeakMap<
  WebSocket,
  { messages: Record<string, unknown>[]; waiters: ((message: Record<string, unknown>) => void)[] }
>();

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const queue = queues.get(socket);
  if (!queue) return Promise.reject(new Error('socket queue is not registered'));
  const message = queue.messages.shift();
  if (message) return Promise.resolve(message);
  return new Promise((resolve) => queue.waiters.push(resolve));
}

async function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const message = await nextMessage(socket);
    if (message.type === type) return message;
  }
}

function connect(token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, [`token.${token}`]);
    const queue = {
      messages: [] as Record<string, unknown>[],
      waiters: [] as ((message: Record<string, unknown>) => void)[],
    };
    queues.set(socket, queue);
    socket.on('message', (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      const waiter = queue.waiters.shift();
      if (waiter) waiter(message);
      else queue.messages.push(message);
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('真实 WebSocket 配置权限', () => {
  beforeAll(async () => {
    PORT = await reservePort();
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        AQUAPILOT_VIEWER_TOKEN: TOKEN,
        AQUAPILOT_OPERATOR_TOKEN: OPERATOR_TOKEN,
        AQUAPILOT_TOKEN: ADMIN_TOKEN,
        AQUAPILOT_PERSIST: '0',
        AQUAPILOT_TOPOLOGY: join(dataDir, 'topology.json'),
        AQUAPILOT_TOPOLOGY_HISTORY: join(dataDir, 'topology-history.json'),
        AQUAPILOT_AGENT_CONFIG: join(dataDir, 'agent-config.json'),
        AQUAPILOT_LLM_CONFIG: join(dataDir, 'llm-config.json'),
      },
      stdio: 'ignore',
    });
    await waitForHealth();
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('viewer 可以问答但不能通过聊天修改 Agent 权限或 webhook', async () => {
    const socket = await connect();
    try {
      socket.send(JSON.stringify({ type: 'chat', text: '权限 完全放开' }));
      const denied = await nextType(socket, 'chat');
      expect(denied.type).toBe('chat');
      expect(JSON.stringify(denied)).toContain('无权修改 Agent 配置');

      await new Promise((resolve) => setTimeout(resolve, 1_600));
      socket.send(JSON.stringify({ type: 'chat', text: '列出配置' }));
      const readOnly = await nextType(socket, 'chat');
      expect(readOnly.type).toBe('chat');
      expect(JSON.stringify(readOnly)).toContain('配置查询');

      expect(existsSync(join(dataDir, 'agent-config.json'))).toBe(false);
    } finally {
      socket.close();
    }
  }, 20_000);

  it('operator 也不能通过聊天修改 Agent 配置', async () => {
    const socket = await connect(OPERATOR_TOKEN);
    try {
      socket.send(JSON.stringify({ type: 'chat', text: '权限 完全放开' }));
      const denied = await nextType(socket, 'chat');
      expect(JSON.stringify(denied)).toContain('无权修改 Agent 配置');
    } finally {
      socket.close();
    }
  }, 20_000);

  it('admin 可以通过聊天修改 Agent 配置', async () => {
    const socket = await connect(ADMIN_TOKEN);
    try {
      socket.send(JSON.stringify({ type: 'chat', text: '权限 完全放开' }));
      const saved = await nextType(socket, 'chat');
      expect(JSON.stringify(saved)).toContain('配置已更新');
    } finally {
      socket.close();
    }
  }, 20_000);

  it('viewer 不能用 webhook 命令写入配置', async () => {
    const socket = await connect();
    try {
      socket.send(JSON.stringify({ type: 'chat', text: '添加钩子 外发|告警||Webhook|https://example.com/hook' }));
      const denied = await nextMessage(socket);
      expect(denied.type).toBe('chat');
      expect(JSON.stringify(denied)).toContain('无权修改 Agent 配置');
      if (existsSync(join(dataDir, 'agent-config.json'))) {
        const saved = readFileSync(join(dataDir, 'agent-config.json'), 'utf8');
        expect(saved).not.toContain('example.com/hook');
      }
    } finally {
      socket.close();
    }
  }, 20_000);
});

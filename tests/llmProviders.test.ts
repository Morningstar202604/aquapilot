import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  assertPublicFetchUrl,
  assertSafeBaseUrl,
  resolvePublicFetchAddress,
  chatComplete,
  describeHttpFailure,
  discoverModels,
  fetchPublicUrl,
  normalizeBaseUrl,
  parseChatReply,
  parseModelList,
  testConnection,
} from '../src/ai/providers';
import { inferCapabilities, isChatModel, maskApiKey } from '../src/shared/llm';

/**
 * 自定义模型端点的协议适配层。
 *
 * 锁定的都是真实会踩的边界：
 * - 三个协议的模型列表/对话响应形状各不相同；
 * - 推理模型（u2-flash 一类）小预算下 content 为空但 HTTP 200，不能误判成链路失败；
 * - baseUrl 是用户输入，必须挡住云元数据与非法协议。
 */

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function dripRequest(): typeof import('node:http').request {
  return ((
    options: unknown,
    callback: (response: EventEmitter & { statusCode?: number; headers: Record<string, string> }) => void,
  ) => {
    void options;
    const request = new EventEmitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
      setTimeout: () => void;
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    request.write = () => undefined;
    request.setTimeout = () => undefined;
    request.destroy = (error) => {
      if (timer) clearInterval(timer);
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: (error?: Error) => void;
      };
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      response.destroy = (error) => {
        if (timer) clearInterval(timer);
        if (error) queueMicrotask(() => response.emit('error', error));
      };
      callback(response);
      timer = setInterval(() => response.emit('data', Buffer.from('x')), 5);
    };
    return request as unknown as ReturnType<typeof import('node:http').request>;
  }) as typeof import('node:http').request;
}

function fakeRequest(responseBody: string, statusCode = 200): typeof import('node:http').request {
  return ((
    options: unknown,
    callback: (response: EventEmitter & { statusCode?: number; headers: Record<string, string> }) => void,
  ) => {
    void options;
    const request = new EventEmitter() as EventEmitter & {
      write: (body: string | Uint8Array) => void;
      end: () => void;
      destroy: (error?: Error) => void;
      setTimeout: (ms: number, cb?: () => void) => void;
    };
    request.write = () => undefined;
    request.setTimeout = (_ms, cb) => cb?.();
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: (error?: Error) => void;
      };
      response.statusCode = statusCode;
      response.headers = { 'content-type': 'text/plain' };
      response.destroy = (error) => {
        if (error) queueMicrotask(() => response.emit('error', error));
      };
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(responseBody));
        response.emit('end');
      });
    };
    return request as unknown as ReturnType<typeof import('node:http').request>;
  }) as typeof import('node:http').request;
}

describe('SSRF 守卫', () => {
  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
  });

  it('拒绝非 http(s)、内嵌凭据与云元数据地址', () => {
    expect(() => assertSafeBaseUrl('file:///etc/passwd')).toThrow(ProviderError);
    const embeddedCredentials = ['https', '://', 'user', ':', 'pass', '@api.example.com'].join('');
    expect(() => assertSafeBaseUrl(embeddedCredentials)).toThrow(/内嵌账号密码/);
    expect(() => assertSafeBaseUrl('http://169.254.169.254/latest/meta-data')).toThrow(/元数据|链路本地/);
    expect(() => assertSafeBaseUrl('http://metadata.google.internal/computeMetadata')).toThrow(/元数据/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/合法的 URL/);
  });

  it('IPv4-mapped IPv6、主机名尾点、AWS IMDS IPv6 都不能绕过', () => {
    expect(() => assertSafeBaseUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toThrow(/元数据|链路本地/);
    expect(() => assertSafeBaseUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/')).toThrow(/元数据|链路本地/);
    expect(() => assertSafeBaseUrl('http://metadata.google.internal./computeMetadata')).toThrow(/元数据/);
    expect(() => assertSafeBaseUrl('http://metadata.goog./')).toThrow(/元数据/);
    expect(() => assertSafeBaseUrl('http://[fd00:ec2::254]/')).toThrow(/元数据|链路本地/);
    expect(() => assertSafeBaseUrl('http://[fe80::1]/')).toThrow(/元数据|链路本地/);
  });

  it('重定向被拒绝，不跟随到内网/元数据', async () => {
    mockFetch(() => new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    await expect(
      discoverModels({ protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }),
    ).rejects.toThrow(/重定向/);
  });

  it('响应体超过上限时拒绝读取', async () => {
    mockFetch(() => new Response('x'.repeat(1_000_001), { status: 200 }));
    await expect(discoverModels({ protocol: 'openai', baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(
      /响应体过大/,
    );
  });

  it('响应体读取也受超时约束（端点头返回后挂住 body）', async () => {
    vi.useFakeTimers();
    try {
      mockFetch(
        (_url, init) =>
          // 头已返回（HTTP 200），但 body 永远不结束：读取必须被同一个 signal 打断
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const pending = testConnection({
        protocol: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        model: 'm',
      });
      // 推进到测试超时点：若 signal 未覆盖读体，这个 Promise 永远不会 settle
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).resolves.toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it('拒绝整个 169.254.0.0/16 链路本地网段作为模型端点', () => {
    for (const host of ['169.254.0.1', '169.254.169.253', '169.254.170.2', '169.254.255.254']) {
      expect(() => assertSafeBaseUrl(`http://${host}/v1`)).toThrow(/元数据|链路本地/);
    }
  });

  it('允许本地与私网端点（自建 Ollama/vLLM）', () => {
    expect(assertSafeBaseUrl('http://127.0.0.1:11434/v1').hostname).toBe('127.0.0.1');
    expect(assertSafeBaseUrl('http://192.168.1.9:8000/v1').hostname).toBe('192.168.1.9');
  });
});

describe('真实本机模型端点', () => {
  it('localhost 和 127.0.0.1 均可访问仅监听 IPv4 的模型服务', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-chat' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      for (const host of ['127.0.0.1', 'localhost']) {
        const result = await discoverModels({ protocol: 'openai', baseUrl: `http://${host}:${address.port}/v1` });
        expect(result[0].id).toBe('local-chat');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('::1 可访问 IPv6 loopback 模型服务', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-chat' }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      const result = await discoverModels({ protocol: 'openai', baseUrl: `http://[::1]:${address.port}/v1` });
      expect(result[0].id).toBe('local-chat');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('模型列表解析', () => {
  it('OpenAI 形状：过滤非对话模型并保留上下文元数据', () => {
    const models = parseModelList('openai', {
      data: [
        { id: 'u2-flash', owned_by: 'unisound', context_window: 1048576, max_output: 131072 },
        { id: 'text-embedding-3-large' },
        { id: 'u2-flash' },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(1048576);
    expect(models[0].maxOutput).toBe(131072);
  });

  it('Anthropic 形状：display_name 作为展示名', () => {
    const models = parseModelList('anthropic', {
      data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01' }],
    });
    expect(models[0]).toMatchObject({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' });
  });

  it('Google 形状：去掉 models/ 前缀并读 inputTokenLimit', () => {
    const models = parseModelList('google', {
      models: [
        { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', inputTokenLimit: 1000000, outputTokenLimit: 64000 },
        { name: 'models/text-embedding-004' },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'gemini-3-pro', contextWindow: 1000000, maxOutput: 64000 });
  });

  it('空列表或非对象条目不会炸', () => {
    expect(parseModelList('openai', { data: [null, 3, 'x'] })).toEqual([]);
    expect(parseModelList('openai', {})).toEqual([]);
  });
});

describe('对话响应解析', () => {
  it('OpenAI：content 为空但带 tool_calls 视为有回复', () => {
    const out = parseChatReply('openai', {
      choices: [{ message: { content: '', tool_calls: [{ id: 'c1' }] }, finish_reason: 'tool_calls' }],
    });
    expect(out.reply).toContain('工具调用');
    expect(out.emptyBecauseTruncated).toBe(false);
  });

  it('OpenAI：空 content + finish_reason=length 标记为截断', () => {
    const out = parseChatReply('openai', { choices: [{ message: { content: null }, finish_reason: 'length' }] });
    expect(out.reply).toBe('');
    expect(out.emptyBecauseTruncated).toBe(true);
  });

  it('Anthropic：拼接多个 text block', () => {
    const out = parseChatReply('anthropic', {
      content: [
        { type: 'text', text: '正常' },
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: '。' },
      ],
      stop_reason: 'end_turn',
    });
    expect(out.reply).toBe('正常。');
  });

  it('Google：从 candidates[0].content.parts 取文本', () => {
    const out = parseChatReply('google', {
      candidates: [{ content: { parts: [{ text: '正常' }] }, finishReason: 'STOP' }],
    });
    expect(out.reply).toBe('正常');
  });
});

describe('模型发现请求', () => {
  it('OpenAI 打 /models 并带 Bearer', async () => {
    const { calls } = mockFetch(() => json({ data: [{ id: 'u2-flash' }] }));
    const models = await discoverModels({ protocol: 'openai', baseUrl: 'https://maas.example.com/v1/', apiKey: 'k' });
    expect(calls[0].url).toBe('https://maas.example.com/v1/models');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(models[0].id).toBe('u2-flash');
  });

  it('Anthropic 打 /v1/models 并带 x-api-key', async () => {
    const { calls } = mockFetch(() => json({ data: [{ id: 'claude-opus-5-5' }] }));
    await discoverModels({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBeTruthy();
  });

  it('Google 把 key 放在 x-goog-api-key 请求头而不是 URL', async () => {
    const { calls } = mockFetch(() => json({ models: [{ name: 'models/gemini-3-pro' }] }));
    await discoverModels({
      protocol: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'k',
    });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });

  it('401 给出可读的鉴权失败原因', async () => {
    mockFetch(() => json({ error: { message: 'invalid api key' } }, 401));
    await expect(
      discoverModels({ protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'bad' }),
    ).rejects.toThrow(/鉴权失败.*invalid api key/);
  });

  it('模型列表为空时给出明确原因', async () => {
    mockFetch(() => json({ data: [] }));
    await expect(discoverModels({ protocol: 'openai', baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(
      /模型列表为空/,
    );
  });
});

describe('连接测试', () => {
  it('成功时返回延迟与回复', async () => {
    mockFetch(() => json({ choices: [{ message: { content: '正常' }, finish_reason: 'stop' }] }));
    const result = await testConnection({
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'u2-flash',
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('正常');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('推理模型预算烧在 reasoning 上时自动提高预算重试一次', async () => {
    let call = 0;
    const { calls } = mockFetch(() => {
      call += 1;
      if (call === 1)
        return json({
          choices: [{ message: { content: null, reasoning_content: '思考中' }, finish_reason: 'length' }],
        });
      return json({ choices: [{ message: { content: '正常' }, finish_reason: 'stop' }] });
    });
    const result = await testConnection({
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'u2-flash',
    });
    expect(calls).toHaveLength(2);
    const retryBody = JSON.parse(String(calls[1].init.body)) as { max_tokens: number };
    expect(retryBody.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(result.ok).toBe(true);
  });

  it('始终空回复时明确报错，不当成成功', async () => {
    mockFetch(() => json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
    const result = await testConnection({ protocol: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/没有返回内容/);
  });

  it('网络错误返回中文原因而不是抛出', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await testConnection({ protocol: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/无法连接端点/);
  });

  it('整个 link-local 网段都在发起请求前被拦下', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return json({});
    }) as unknown as typeof fetch;
    for (const host of ['169.254.0.1', '169.254.169.253', '169.254.170.2', '169.254.255.254']) {
      const result = await testConnection({ protocol: 'openai', baseUrl: `http://${host}`, model: 'm' });
      expect(result.ok).toBe(false);
    }
    expect(called).toBe(false);
  });
});

describe('状态码文案', () => {
  it('常见状态各有可读原因', () => {
    expect(describeHttpFailure(401)).toMatch(/鉴权失败/);
    expect(describeHttpFailure(404)).toMatch(/端点不存在/);
    expect(describeHttpFailure(429)).toMatch(/限流/);
    expect(describeHttpFailure(503)).toMatch(/服务端错误/);
  });
});

describe('聊天链路复用', () => {
  it('把 system 与 user 装进请求体', async () => {
    const { calls } = mockFetch(() => json({ choices: [{ message: { content: '0.59' } }] }));
    const out = await chatComplete(
      { protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', maxOutput: 500 },
      'SYS',
      'USER',
      2000,
    );
    expect(out).toEqual({ ok: true, text: '0.59' });
    const body = JSON.parse(String(calls[0].init.body)) as { messages: { role: string; content: string }[] };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'USER' });
  });

  it('Anthropic 用顶层 system 字段', async () => {
    const { calls } = mockFetch(() => json({ content: [{ type: 'text', text: 'ok' }] }));
    await chatComplete(
      { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxOutput: 500 },
      'SYS',
      'USER',
      2000,
    );
    const body = JSON.parse(String(calls[0].init.body)) as { system: string; messages: unknown[] };
    expect(body.system).toBe('SYS');
    expect(body.messages).toHaveLength(1);
  });

  it('Google 聊天使用 header key 与 Gemini body', async () => {
    const { calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: '正常' }] } }] }));
    const out = await chatComplete(
      {
        protocol: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'k',
        model: 'm',
        maxOutput: 500,
      },
      'SYS',
      'USER',
      2000,
    );
    expect(out).toEqual({ ok: true, text: '正常' });
    expect(calls[0].url).not.toContain('key=');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });

  it('非法聊天端点在构造请求前安全失败', async () => {
    const out = await chatComplete(
      { protocol: 'openai', baseUrl: 'http://169.254.170.2/v1', apiKey: 'k', model: 'm', maxOutput: 500 },
      'SYS',
      'USER',
      2000,
    );
    expect(out).toEqual({ ok: false, reason: 'invalid-base-url' });
  });

  it('聊天网络异常返回 network-error', async () => {
    global.fetch = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const out = await chatComplete(
      { protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm', maxOutput: 500 },
      'S',
      'U',
      2000,
    );
    expect(out).toEqual({ ok: false, reason: 'network-error' });
  });

  it('HTTP 失败返回 reason 供降级', async () => {
    mockFetch(() => json({ error: 'nope' }, 500));
    const out = await chatComplete(
      { protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm', maxOutput: 500 },
      'S',
      'U',
      2000,
    );
    expect(out).toEqual({ ok: false, reason: 'http-500' });
  });
});

describe('能力自动匹配', () => {
  it('按命名推断视觉与推理能力', () => {
    expect(inferCapabilities({ id: 'u2-flash' }, 'openai').reasoning).toBe(true);
    expect(inferCapabilities({ id: 'gemini-3-pro' }, 'google').vision).toBe(true);
    expect(inferCapabilities({ id: 'deepseek-v4.1-flash' }, 'openai').reasoning).toBe(false);
  });

  it('端点给了元数据就用端点的', () => {
    const caps = inferCapabilities({ id: 'u2-flash', contextWindow: 1048576, maxOutput: 131072 }, 'openai');
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(131072);
  });

  it('非对话模型被过滤', () => {
    expect(isChatModel('text-embedding-3-large')).toBe(false);
    expect(isChatModel('u2-flash')).toBe(true);
  });

  it('密钥掩码只露头尾', () => {
    const masked = maskApiKey('sk-abcdefghijklmnop');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked).not.toContain('abcdefghij');
    expect(maskApiKey('short')).toBe('••••');
  });
});

describe('抓取类 SSRF 守卫（技能导入 / webhook）', () => {
  it('拒绝内网、回环、链路本地与 .local', () => {
    for (const u of [
      'http://127.0.0.1:8500/v1/status',
      'http://localhost:3000/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://router.local/',
      'http://metadata.google.internal/',
    ]) {
      expect(() => assertPublicFetchUrl(u)).toThrow();
    }
  });

  it('拒绝 IPv4-mapped IPv6 形式的私网与回环地址', () => {
    for (const u of [
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://[::ffff:172.16.0.1]/',
    ]) {
      expect(() => assertPublicFetchUrl(u)).toThrow();
    }
  });

  it('放行真正的公网地址', () => {
    expect(assertPublicFetchUrl('https://example.com/doc.md').hostname).toBe('example.com');
    expect(assertPublicFetchUrl('https://docs.example.org/a/b').hostname).toBe('docs.example.org');
  });

  it('模型端点 DNS alias 解析到 link-local 时也拒绝', async () => {
    await expect(
      resolvePublicFetchAddress(
        'http://model-alias.example/v1',
        async () => [{ address: '169.254.170.2', family: 4 }],
        undefined,
        true,
      ),
    ).rejects.toThrow(/元数据|链路本地/);
  });

  it('DNS 解析结果含私网地址时拒绝整个目标', async () => {
    await expect(
      resolvePublicFetchAddress('https://public.example.com/doc.md', async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ]),
    ).rejects.toThrow(/解析到了内网/);
  });

  it('出站抓取在公网守卫拒绝时不发起请求', async () => {
    await expect(fetchPublicUrl('http://127.0.0.1/')).rejects.toThrow(/内网|回环/);
  });

  it('204/205/304 响应不构造非法 body', async () => {
    for (const status of [204, 205, 304]) {
      const response = await fetchPublicUrl('http://public.example.com/no-body', {
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
        requestImpl: fakeRequest('', status),
      });
      expect(response.status).toBe(status);
      await expect(response.text()).resolves.toBe('');
    }
  });

  it('出站抓取连接固定地址并读取响应', async () => {
    const result = await fetchPublicUrl('http://public.example.com/doc.md', {
      method: 'POST',
      body: 'payload',
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      requestImpl: fakeRequest('ok'),
    });
    await expect(result.text()).resolves.toBe('ok');
    expect(result.status).toBe(200);
  });

  it('出站抓取拒绝超大响应体', async () => {
    await expect(
      fetchPublicUrl('http://public.example.com/doc.md', {
        maxBytes: 1,
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
        requestImpl: fakeRequest('too large'),
      }),
    ).rejects.toThrow(/响应体过大/);
  });

  it('持续 drip 响应也受总 wall-clock deadline 限制', async () => {
    const started = Date.now();
    await expect(
      fetchPublicUrl('http://public.example.com/drip', {
        timeoutMs: 40,
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
        requestImpl: dripRequest(),
      }),
    ).rejects.toThrow(/超时/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('DNS lookup 受同一 deadline 取消', async () => {
    await expect(
      fetchPublicUrl('http://public.example.com/dns', {
        timeoutMs: 20,
        lookup: () => new Promise(() => undefined),
        requestImpl: fakeRequest('never'),
      }),
    ).rejects.toThrow(/超时/);
  });

  it('DNS 解析失败和空结果都 fail-closed', async () => {
    await expect(
      resolvePublicFetchAddress('https://public.example.com/fail', async () => Promise.reject(new Error('dns'))),
    ).rejects.toThrow(/无法解析公网地址/);
    await expect(resolvePublicFetchAddress('https://public.example.com/empty', async () => [])).rejects.toThrow(
      /解析到了内网/,
    );
  });

  it('直接公网 IP 不需要 DNS lookup', async () => {
    await expect(resolvePublicFetchAddress('https://203.0.113.10/doc.md', async () => [])).resolves.toMatchObject({
      address: '203.0.113.10',
    });
  });

  it('已取消的 DNS deadline 不会启动出站请求', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolvePublicFetchAddress(
        'https://public.example.com/cancelled',
        async () => [{ address: '203.0.113.10', family: 4 }],
        controller.signal,
      ),
    ).rejects.toThrow(/超时/);
  });

  it('默认 DNS resolver 能解析公网域名', async () => {
    const result = await resolvePublicFetchAddress('https://example.com/');
    expect(result.address).toMatch(/^[0-9a-f:.]+$/i);
  });

  it('DNS 解析通过后返回固定的公网地址', async () => {
    await expect(
      resolvePublicFetchAddress('https://public.example.com/doc.md', async (host) => {
        expect(host).toBe('public.example.com');
        return [{ address: '203.0.113.10', family: 4 }];
      }),
    ).resolves.toMatchObject({ address: '203.0.113.10' });
  });
});

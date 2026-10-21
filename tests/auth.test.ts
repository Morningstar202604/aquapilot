import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { accessControlEnabled, authorize, extractToken, tokenMatches } from '../src/server/auth';

/**
 * 访问控制测试。
 *
 * 定位：默认关闭（本地开发零配置），设置 AQUAPILOT_TOKEN 后启用。
 * 关键是不能因为加了认证就破坏默认的本地使用。
 */

const makeReq = (headers: Record<string, string> = {}, url = '/'): IncomingMessage => {
  const req = new Readable() as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  (req as unknown as { url: string }).url = url;
  return req;
};

beforeEach(() => {
  delete process.env.AQUAPILOT_TOKEN;
});
afterEach(() => {
  delete process.env.AQUAPILOT_TOKEN;
});

describe('访问控制', () => {
  it('未配置令牌时默认放行（本地开发零配置）', () => {
    expect(accessControlEnabled()).toBe(false);
    expect(authorize(makeReq()).allowed).toBe(true);
    expect(tokenMatches(null)).toBe(true);
  });

  it('配置后无令牌被拒绝', () => {
    process.env.AQUAPILOT_TOKEN = 'secret-abc';
    expect(accessControlEnabled()).toBe(true);
    expect(authorize(makeReq()).allowed).toBe(false);
  });

  it('错误令牌被拒绝', () => {
    process.env.AQUAPILOT_TOKEN = 'secret-abc';
    expect(authorize(makeReq({ authorization: 'Bearer wrong' })).allowed).toBe(false);
  });

  it('正确令牌通过（Bearer 头）', () => {
    process.env.AQUAPILOT_TOKEN = 'secret-abc';
    expect(authorize(makeReq({ authorization: 'Bearer secret-abc' })).allowed).toBe(true);
  });

  it('支持 query 参数传令牌（WebSocket 场景）', () => {
    process.env.AQUAPILOT_TOKEN = 'secret-abc';
    expect(authorize(makeReq({}, '/ws?token=secret-abc')).allowed).toBe(true);
    expect(authorize(makeReq({}, '/ws?token=bad')).allowed).toBe(false);
  });

  it('支持子协议传令牌（浏览器 WebSocket 无法设 header）', () => {
    process.env.AQUAPILOT_TOKEN = 'secret-abc';
    const req = makeReq({ 'sec-websocket-protocol': 'token.secret-abc' });
    expect(authorize(req, 'secret-abc').allowed).toBe(true);
  });

  it('空令牌配置等价于未启用', () => {
    process.env.AQUAPILOT_TOKEN = '   ';
    expect(accessControlEnabled()).toBe(false);
  });

  it('extractToken 优先级：Bearer 头 > query', () => {
    const req = makeReq({ authorization: 'Bearer from-header' }, '/x?token=from-query');
    expect(extractToken(req)).toBe('from-header');
  });
});

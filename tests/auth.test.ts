import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  accessControlEnabled,
  authorize,
  extractToken,
  requiredRoleFor,
  roleAtLeast,
  roleForToken,
  tokenMatches,
} from '../src/server/auth';

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

describe('角色模型（viewer / operator / admin）', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  function setTokens() {
    process.env = {
      ...env,
      AQUAPILOT_TOKEN: 'admin-tok',
      AQUAPILOT_OPERATOR_TOKEN: 'op-tok',
      AQUAPILOT_VIEWER_TOKEN: 'view-tok',
    };
  }

  it('三个令牌分别解析成对应角色', () => {
    setTokens();
    expect(roleForToken('admin-tok')).toBe('admin');
    expect(roleForToken('op-tok')).toBe('operator');
    expect(roleForToken('view-tok')).toBe('viewer');
    expect(roleForToken('wrong')).toBeNull();
    expect(roleForToken(null)).toBeNull();
  });

  it('未配置任何令牌时恒为 admin（本地开发零配置）', () => {
    process.env = { ...env, AQUAPILOT_TOKEN: '', AQUAPILOT_OPERATOR_TOKEN: '', AQUAPILOT_VIEWER_TOKEN: '' };
    expect(roleForToken(null)).toBe('admin');
    expect(accessControlEnabled()).toBe(false);
  });

  it('角色等级比较', () => {
    expect(roleAtLeast('admin', 'viewer')).toBe(true);
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
  });

  it('authorize 按所需角色拒绝', () => {
    setTokens();
    const req = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, url: '/' }) as never;
    expect(authorize(req('view-tok'), null, 'viewer').allowed).toBe(true);
    expect(authorize(req('view-tok'), null, 'operator').allowed).toBe(false);
    expect(authorize(req('view-tok'), null, 'operator').reason).toMatch(/权限不足/);
    expect(authorize(req('op-tok'), null, 'operator').allowed).toBe(true);
    expect(authorize(req('op-tok'), null, 'admin').allowed).toBe(false);
    expect(authorize(req('admin-tok'), null, 'admin').allowed).toBe(true);
  });

  it('消息类型映射到最低角色', () => {
    expect(requiredRoleFor('control')).toBe('operator');
    expect(requiredRoleFor('topology')).toBe('admin');
    expect(requiredRoleFor('llmConfig')).toBe('admin');
    expect(requiredRoleFor('agentConfig')).toBe('admin');
    expect(requiredRoleFor('hello')).toBe('viewer');
    expect(requiredRoleFor('chat')).toBe('viewer');
    expect(requiredRoleFor('analysis')).toBe('viewer');
  });
});

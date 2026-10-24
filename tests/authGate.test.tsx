// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthGate } from '../src/client/components/AuthGate';

/**
 * 登录门的三个关键行为：
 * 1. 服务端未启用访问控制 → 直接放行，不打扰用户；
 * 2. 已保存的令牌失效 → 必须回到登录页，而不是放行后卡在"断线重连"；
 * 3. 首次无令牌 → 显示输入框，输入后用 /api/snapshot 验证。
 *
 * 这些分支在旧实现里是"只看 sessionStorage 有没有值"，轮换令牌后会死锁。
 */

const realFetch = global.fetch;

function mockFetch(routes: Record<string, { status: number; body: unknown }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    const r = routes[key];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('AuthGate', () => {
  it('未启用访问控制时直接渲染子节点', async () => {
    mockFetch({ '/api/auth-required': { status: 200, body: { required: false } } });
    render(
      <AuthGate>
        <div>控制室</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText('控制室')).toBeTruthy());
  });

  it('需要访问控制且无令牌时显示输入框', async () => {
    mockFetch({ '/api/auth-required': { status: 200, body: { required: true } } });
    render(
      <AuthGate>
        <div>控制室</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByLabelText('访问令牌')).toBeTruthy());
    expect(screen.queryByText('控制室')).toBeNull();
  });

  it('已保存令牌有效时放行', async () => {
    window.sessionStorage.setItem('aquapilot_token', 'good');
    mockFetch({
      '/api/auth-required': { status: 200, body: { required: true } },
      '/api/snapshot': { status: 200, body: {} },
    });
    render(
      <AuthGate>
        <div>控制室</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText('控制室')).toBeTruthy());
  });

  it('已保存令牌失效时回到登录页并说明原因（回归：曾永久断线重连）', async () => {
    window.sessionStorage.setItem('aquapilot_token', 'stale');
    mockFetch({
      '/api/auth-required': { status: 200, body: { required: true } },
      '/api/snapshot': { status: 401, body: { error: 'invalid' } },
    });
    render(
      <AuthGate>
        <div>控制室</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText(/保存的令牌已失效/)).toBeTruthy());
    expect(screen.getByLabelText('访问令牌')).toBeTruthy();
    expect(window.sessionStorage.getItem('aquapilot_token')).toBeNull();
  });

  it('输入错误令牌时提示无效且不写入存储', async () => {
    mockFetch({
      '/api/auth-required': { status: 200, body: { required: true } },
      '/api/snapshot': { status: 401, body: { error: 'invalid' } },
    });
    render(
      <AuthGate>
        <div>控制室</div>
      </AuthGate>,
    );
    const input = await screen.findByLabelText('访问令牌');
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    await waitFor(() => expect(screen.getByText('令牌无效')).toBeTruthy());
    expect(window.sessionStorage.getItem('aquapilot_token')).toBeNull();
  });
});

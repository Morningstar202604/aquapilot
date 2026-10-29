import { describe, expect, it, vi } from 'vitest';
import {
  createRateLimiter,
  freshClientState,
  MAX_BUFFERED_BYTES,
  MAX_LLM_IN_FLIGHT,
  MAX_WS_CLIENTS,
  NOTICE_COOLDOWN_MS,
  RATE_LIMIT,
  type ClientState,
} from '../src/server/rateLimit';

/**
 * 每连接限流状态机 + 提示冷却。
 *
 * 三个真实缺陷史：
 *   ① 用 `now - undefined` 比较 → NaN → 静默放行；
 *   ② 被限流的消息逐条回 notice → 保护变放大源；
 *   ③ 状态按连接维护且不限连接数 → 额度可被 N 倍放大。
 */

function makeLimiter(clock: { t: number }) {
  const states = new Map<object, ClientState>();
  const ws = {};
  states.set(ws, freshClientState());
  let limited = 0;
  const limiter = createRateLimiter({
    // 关键：同一连接必须返回同一份状态（真实调用方就是这么做的）
    stateFor: (w) => states.get(w as object) ?? freshClientState(),
    saveState: (w, s) => states.set(w as object, s),
    onLimited: () => {
      limited += 1;
    },
    now: () => clock.t,
  });
  return { limiter, ws, states, limited: () => limited };
}

describe('限流窗口', () => {
  it('窗口内第二次请求被拒', () => {
    const clock = { t: 10_000 };
    const { limiter, ws, limited } = makeLimiter(clock);
    expect(limiter.limited(ws as never, 'control')).toBe(false);
    clock.t += RATE_LIMIT.controlMs - 1;
    expect(limiter.limited(ws as never, 'control')).toBe(true);
    expect(limited()).toBe(1);
  });

  it('窗口结束后放行', () => {
    const clock = { t: 10_000 };
    const { limiter, ws } = makeLimiter(clock);
    expect(limiter.limited(ws as never, 'control')).toBe(false);
    clock.t += RATE_LIMIT.controlMs;
    expect(limiter.limited(ws as never, 'control')).toBe(false);
  });

  it('不同类别互不影响', () => {
    // t 必须大于所有窗口的初始值：t=0 时 lastXxxAt=0，差值 0 会被正确判为「刚发过」
    const clock = { t: 10_000 };
    const { limiter, ws } = makeLimiter(clock);
    expect(limiter.limited(ws as never, 'control')).toBe(false);
    expect(limiter.limited(ws as never, 'chat')).toBe(false);
    expect(limiter.limited(ws as never, 'chat')).toBe(true);
  });

  it('初始状态不会被 NaN 比较放行（回归）', () => {
    const clock = { t: 0 };
    const { limiter, ws } = makeLimiter(clock);
    // t=0 时 lastControlAt=0，差值 0 < window → 首次应被拒
    expect(limiter.limited(ws as never, 'control')).toBe(true);
  });
});

describe('提示冷却', () => {
  it('冷却窗口内只发一条', () => {
    const clock = { t: 10_000 };
    const { limiter, ws } = makeLimiter(clock);
    const sent: string[] = [];
    const send = (p: string) => sent.push(p);
    for (let i = 0; i < 40; i++) limiter.notice(ws as never, 'control', '太频繁', send);
    expect(sent).toHaveLength(1);
  });

  it('冷却结束后可以再发', () => {
    const clock = { t: 10_000 };
    const { limiter, ws } = makeLimiter(clock);
    const sent: string[] = [];
    const send = (p: string) => sent.push(p);
    limiter.notice(ws as never, 'control', 'a', send);
    clock.t += NOTICE_COOLDOWN_MS;
    limiter.notice(ws as never, 'control', 'b', send);
    expect(sent).toHaveLength(2);
  });

  it('不同类别各自冷却', () => {
    const clock = { t: 10_000 };
    const { limiter, ws } = makeLimiter(clock);
    const sent: string[] = [];
    const send = (p: string) => sent.push(p);
    limiter.notice(ws as never, 'control', 'a', send);
    limiter.notice(ws as never, 'chat', 'b', send);
    expect(sent).toHaveLength(2);
  });
});

describe('常量约束', () => {
  it('连接数、在途请求与背压阈值都是有限的合理值', () => {
    expect(MAX_WS_CLIENTS).toBeGreaterThan(0);
    expect(MAX_LLM_IN_FLIGHT).toBeGreaterThan(0);
    expect(MAX_BUFFERED_BYTES).toBeGreaterThan(64 * 1024);
  });

  it('各限流窗口都为正', () => {
    for (const v of Object.values(RATE_LIMIT)) expect(v).toBeGreaterThan(0);
  });

  it('新建连接的状态是 admin（认证关闭时）且各时间戳为 0', () => {
    const s = freshClientState();
    expect(s.role).toBe('admin');
    expect(s.lastControlAt).toBe(0);
    expect(s.helloSent).toBe(false);
    expect(s.noticeAt).toEqual({});
  });
});

describe('依赖注入的时钟', () => {
  it('不传 now 时使用 Date.now', () => {
    const limiter = createRateLimiter({
      stateFor: () => freshClientState(),
      saveState: vi.fn(),
      onLimited: vi.fn(),
    });
    const ws = { readyState: 1, send: vi.fn() } as never;
    expect(limiter.limited(ws, 'control')).toBe(false);
  });
});

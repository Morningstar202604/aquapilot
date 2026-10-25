import { describe, expect, it } from 'vitest';
import { BACKPRESSURE_LIMIT_BYTES, nextSendPlan, reconnectDelayMs } from '../src/client/hooks/wsPolicy';
import type { ClientMessage } from '../src/shared/protocol';

const msg = (type: string): ClientMessage => ({ type: 'chat', text: type }) as unknown as ClientMessage;

describe('wsPolicy 重连退避', () => {
  it('线性退避、封顶并带抖动', () => {
    // 固定抖动 0：得到退避上界
    const noJitter = { jitter: () => 0 };
    expect(reconnectDelayMs(1, noJitter)).toBe(600);
    expect(reconnectDelayMs(3, noJitter)).toBe(1800);
    expect(reconnectDelayMs(20, noJitter)).toBe(8000); // 封顶
    // 抖动加入后总是大于等于确定性上界
    const withJitter = { jitter: () => 400 };
    expect(reconnectDelayMs(2, withJitter)).toBe(1600);
  });

  it('抖动不突破封顶上限', () => {
    // 即使每次加满 400ms 抖动，重试 20/100 次也不得超过 cap=8000
    expect(reconnectDelayMs(20, { jitter: () => 400 })).toBe(8000);
    expect(reconnectDelayMs(100, { jitter: () => 400 })).toBe(8000);
  });

  it('抖动引入分散，避免多客户端同步撞击', () => {
    const seen = new Set<number>();
    let seed = 1;
    const jitter = () => {
      // 确定性伪随机
      seed = (seed * 9301 + 49297) % 233280;
      return (seed / 233280) * 400;
    };
    for (let i = 0; i < 20; i++) seen.add(reconnectDelayMs(1, { jitter }));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('wsPolicy 发送背压', () => {
  it('缓冲超限时合并为「最后一条胜出」，不丢用户意图', () => {
    const plan = nextSendPlan(null, msg('a'), BACKPRESSURE_LIMIT_BYTES + 1);
    expect(plan.toSend).toEqual([]);
    expect(plan.pending).toBeTruthy();

    // 连续合并：后一条覆盖前一条
    const merged = nextSendPlan(plan.pending, msg('b'), BACKPRESSURE_LIMIT_BYTES + 1);
    expect(merged.pending).toBeTruthy();
    expect(merged.pending!.type).toBe('chat');
    expect((merged.pending as { text: string }).text).toBe('b');
  });

  it('缓冲正常时先发积压再发当前', () => {
    const plan = nextSendPlan(msg('pending'), msg('current'), 0);
    expect(plan.pending).toBeNull();
    expect(plan.toSend).toHaveLength(2);
    expect((plan.toSend[0] as { text: string }).text).toBe('pending');
    expect((plan.toSend[1] as { text: string }).text).toBe('current');
  });

  it('无积压且缓冲正常时直接发送', () => {
    const plan = nextSendPlan(null, msg('x'), 0);
    expect(plan.pending).toBeNull();
    expect(plan.toSend).toHaveLength(1);
  });
});

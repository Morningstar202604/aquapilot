import { describe, expect, it } from 'vitest';
import {
  MAX_INFLUENT_CSV_BYTES,
  handleInfluentMessage,
  type InfluentHandlerState,
} from '../src/server/influentHandler';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
import type { InfluentSeries } from '../src/sim/influentSeries';

/**
 * 进水处理器：从 server/index.ts 的 switch 抽出的第一个模块。
 *
 * 这些用例覆盖的是过去只能「起服务 + 手点界面」才能验证的三条判定：
 * 2 MB 上限、质量门禁拒绝 apply、pending 状态机。抽取前它们在 CI 里零覆盖。
 */

type InfluentMessage = Extract<ClientMessage, { type: 'influent' }>;
type InfluentReply = Extract<ServerMessage, { type: 'influent' }>;

/** 取出最后一条回执并窄化为 report（调用方已知道分支） */
function asReport(reply: ServerMessage | undefined): Extract<InfluentReply, { action: 'report' }> {
  if (!reply || reply.type !== 'influent' || reply.action !== 'report') throw new Error('expected influent report');
  return reply;
}

function asError(reply: ServerMessage | undefined): Extract<InfluentReply, { action: 'error' }> {
  if (!reply || reply.type !== 'influent' || reply.action !== 'error') throw new Error('expected influent error');
  return reply;
}

function harness(initial: Partial<InfluentHandlerState> = {}) {
  let state: InfluentHandlerState = { series: null, pending: null, ...initial };
  const sent: ServerMessage[] = [];
  const notices: { level: string; text: string }[] = [];
  return {
    get state() {
      return state;
    },
    sent,
    notices,
    run: (msg: InfluentMessage) =>
      handleInfluentMessage(msg, {
        state: () => state,
        update: (patch) => {
          state = { ...state, ...patch };
        },
        send: (m) => sent.push(m),
        notice: (level, text) => notices.push({ level, text }),
      }),
  };
}

function csv(rows: number, opts: { cod?: number } = {}): string {
  const lines = ['minute,flow,cod,nh,tp,ss,temperature'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${i * 30},1000,${opts.cod ?? 300},25,2,120,18`);
  }
  return lines.join('\n');
}

function seriesOf(rows: number, name = '测试进水'): InfluentSeries {
  return {
    name,
    samples: Array.from({ length: rows }, (_, i) => ({
      minute: i * 30,
      flow: 1000,
      cod: 300,
      nh: 25,
      tp: 2,
      ss: 120,
      temperature: 18,
    })),
    durationMin: Math.max(0, (rows - 1) * 30),
    warnings: [],
  };
}

describe('进水处理器 · load', () => {
  it('合法 CSV 只暂存、不生效', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'load', requestId: 'r1', name: '一周进水', csv: csv(48) });
    expect(h.state.series).toBeNull();
    expect(h.state.pending?.samples.length).toBe(48);
    const reply = asReport(h.sent[0]);
    expect(reply.action).toBe('report');
    expect(reply.applied).toBe(false);
    expect(reply.summary?.points).toBe(48);
  });

  it('超过 2 MB 直接拒绝，且不写入 pending', () => {
    const h = harness();
    const huge = 'x'.repeat(MAX_INFLUENT_CSV_BYTES + 1);
    h.run({ type: 'influent', action: 'load', requestId: 'r2', name: 'huge', csv: huge });
    expect(h.state.pending).toBeNull();
    expect(asError(h.sent[0]).error).toContain('2 MB');
  });

  it('空 CSV 报出解析器的第一条警告而不是静默成功', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'load', requestId: 'r3', name: 'empty', csv: 'minute,flow,cod\n' });
    expect(h.state.pending).toBeNull();
    expect(asError(h.sent[0]).error.length).toBeGreaterThan(0);
  });

  it('名称截断到 80 字符，避免超长标签撑坏界面', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'load', requestId: 'r4', name: 'n'.repeat(200), csv: csv(30) });
    const reply = asReport(h.sent[0]);
    expect(reply.summary?.name.length).toBe(80);
  });
});

describe('进水处理器 · apply / clear / get', () => {
  it('没有 pending 时 apply 明确报错', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'apply', requestId: 'a1' });
    expect(asError(h.sent[0]).error).toContain('没有待应用');
  });

  it('干净序列 apply 后生效并清空 pending', () => {
    const h = harness({ pending: seriesOf(48) });
    h.run({ type: 'influent', action: 'apply', requestId: 'a2' });
    expect(h.state.series?.samples.length).toBe(48);
    expect(h.state.pending).toBeNull();
    const reply = asReport(h.sent[0]);
    expect(reply.applied).toBe(true);
    expect(h.notices[0].level).toBe('info');
  });

  it('越界读数的序列被质量门禁拒绝，状态不变', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'load', requestId: 'a3', name: '脏数据', csv: csv(48, { cod: 999_999 }) });
    const loadReply = asReport(h.sent.at(-1));
    // 解析阶段就会打上越界问题；apply 必须拒绝
    expect(loadReply.action).toBe('report');
    h.run({ type: 'influent', action: 'apply', requestId: 'a4' });
    const applyReply = asError(h.sent.at(-1));
    expect(applyReply.action).toBe('error');
    expect(applyReply.error).toContain('数据质量不通过');
    expect(h.state.series).toBeNull();
  });

  it('clear 同时清掉生效序列与 pending', () => {
    const h = harness({ series: seriesOf(48), pending: seriesOf(48) });
    h.run({ type: 'influent', action: 'clear', requestId: 'c1' });
    expect(h.state.series).toBeNull();
    expect(h.state.pending).toBeNull();
    expect(h.notices[0].text).toContain('合成进水');
  });

  it('get 在无序列时返回空 summary 与零分质量报告', () => {
    const h = harness();
    h.run({ type: 'influent', action: 'get', requestId: 'g1' });
    const reply = asReport(h.sent[0]);
    expect(reply.summary).toBeNull();
    expect(reply.quality.score).toBe(0);
    expect(reply.quality.usable).toBe(false);
  });

  it('get 在已生效时回传 applied=true 与真实统计', () => {
    const h = harness({ series: seriesOf(96, '已生效') });
    h.run({ type: 'influent', action: 'get', requestId: 'g2' });
    const reply = asReport(h.sent[0]);
    expect(reply.applied).toBe(true);
    expect(reply.summary?.name).toBe('已生效');
    expect(reply.summary?.points).toBe(96);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WatchdogPanel } from '../src/client/components/WatchdogPanel';
import type { WatchdogReport } from '../src/shared/protocol';

/**
 * 自检面板渲染。
 *
 * 对应「派 AI 盯着运行情况」这条诉求的可见面：报告必须能读懂，
 * 异常项必须带下一步动作，空状态不能白屏。
 */

afterEach(cleanup);

const okReport: WatchdogReport = {
  at: '2026-10-26T00:00:00.000Z',
  severity: 'ok',
  checks: [
    { id: 'sim-ticks', label: '仿真步进', severity: 'ok', detail: '无异常，仿真已推进 120 分钟', action: '无需处理' },
    { id: 'llm', label: '模型链路', severity: 'ok', detail: '调用 10 次，降级 0 次', action: '无需处理' },
  ],
};

const warnReport: WatchdogReport = {
  at: '2026-10-26T00:05:00.000Z',
  severity: 'warn',
  checks: [
    { id: 'sim-ticks', label: '仿真步进', severity: 'ok', detail: '无异常', action: '无需处理' },
    {
      id: 'llm',
      label: '模型链路',
      severity: 'warn',
      detail: '10 次调用中 7 次降级（70%）',
      action: '打开「模型设置」点连接测试，核对密钥/地址/模型名',
    },
  ],
};

describe('WatchdogPanel', () => {
  it('没有报告时给出等待提示而不是空白', () => {
    render(<WatchdogPanel report={null} />);
    expect(screen.getByText(/正在等待第一份自检报告/)).toBeTruthy();
  });

  it('全部正常时显示正常与 0 异常项', () => {
    render(<WatchdogPanel report={okReport} />);
    expect(screen.getAllByText('正常').length).toBeGreaterThan(0);
    expect(screen.getByText(/仿真已推进 120 分钟/)).toBeTruthy();
  });

  it('异常项显示建议动作', () => {
    render(<WatchdogPanel report={warnReport} />);
    expect(screen.getByText(/7 次降级/)).toBeTruthy();
    expect(screen.getByText(/打开「模型设置」点连接测试/)).toBeTruthy();
  });

  it('异常项有独立样式标记', () => {
    const { container } = render(<WatchdogPanel report={warnReport} />);
    const warn = container.querySelector('.issue[data-sev="warning"]');
    expect(warn).toBeTruthy();
    expect(warn?.textContent).toContain('模型链路');
  });

  it('报告时间被渲染', () => {
    render(<WatchdogPanel report={warnReport} />);
    expect(screen.getByText(new Date(warnReport.at).toLocaleTimeString())).toBeTruthy();
  });
});

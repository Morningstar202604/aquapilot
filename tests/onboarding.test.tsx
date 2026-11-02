// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Onboarding, hasSeenOnboarding, markOnboarded, ONBOARDING_STEPS } from '../src/client/components/Onboarding';

/**
 * 首次访问引导。
 *
 * 傻瓜式设计的验收标准：
 * - 新用户首访能看到引导，5 步内讲完核心操作路径；
 * - 可以跳过（不能强迫看完）；
 * - 看过一次不再打扰（sessionStorage 记忆）；
 * - Escape 能关闭（键盘可退出）。
 */

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('记忆机制', () => {
  it('新会话默认未看过引导', () => {
    expect(hasSeenOnboarding()).toBe(false);
  });

  it('markOnboarded 之后不再显示', () => {
    markOnboarded();
    expect(hasSeenOnboarding()).toBe(true);
  });

  it('看完后清除存储会重新显示（新会话语义）', () => {
    // sessionStorage 按「会话」隔离：关标签页即失效。
    // 清空存储等价于新会话，应视为未看过。
    markOnboarded();
    expect(hasSeenOnboarding()).toBe(true);
    window.sessionStorage.clear();
    expect(hasSeenOnboarding()).toBe(false);
  });
});

describe('引导流程', () => {
  it('第一步显示品牌与步骤计数', () => {
    render(<Onboarding onClose={() => {}} />);
    expect(screen.getByText('AQUAPILOT')).toBeTruthy();
    expect(screen.getByText('1 / 5')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('下一步推进，最后一步变成「开始使用」并关闭', () => {
    const onClose = vi.fn();
    render(<Onboarding onClose={onClose} />);
    fireEvent.click(screen.getByText('下一步'));
    expect(screen.getByText('2 / 5')).toBeTruthy();
    // 快进到最后一步
    fireEvent.click(screen.getByText('下一步'));
    fireEvent.click(screen.getByText('下一步'));
    fireEvent.click(screen.getByText('下一步'));
    expect(screen.getByText('5 / 5')).toBeTruthy();
    fireEvent.click(screen.getByText('开始使用'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hasSeenOnboarding()).toBe(true);
  });

  it('跳过立即关闭且不做记忆标记（由 onClose 调用方决定）', () => {
    const onClose = vi.fn();
    render(<Onboarding onClose={onClose} />);
    fireEvent.click(screen.getByText('跳过'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('上一步可以回退', () => {
    render(<Onboarding onClose={() => {}} />);
    fireEvent.click(screen.getByText('下一步'));
    fireEvent.click(screen.getByText('上一步'));
    expect(screen.getByText('1 / 5')).toBeTruthy();
  });

  it('Escape 关闭（键盘可退出）', () => {
    const onClose = vi.fn();
    render(<Onboarding onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('包含全部 5 步路标，且指向界面里真实存在的入口', () => {
    render(<Onboarding onClose={() => {}} />);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(document.querySelector('.onboarding-tab')!.textContent ?? '');
      if (i < 4) fireEvent.click(screen.getByText('下一步'));
    }
    expect(seen).toEqual([
      '运行监视 · 顶部',
      'AI 对话 / 决策解释',
      '控制与工况 / 告警 / 效益',
      '分析 / 校准 / 进水',
      '回放 / 自检 · 工艺编排',
    ]);
  });

  it('引导提到的每个页签都必须在 App.tsx 里真实存在', async () => {
    // 引导写错名字比不写更糟：用户会去找一个不存在的入口。
    // 反向核对——把界面应有的页签名拿到 App.tsx 里找，找不到即说明文案漂移。
    const appSource = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'App.tsx'), 'utf8');
    const tabNames = ['AI 对话', '决策解释', '控制与工况', '告警', '效益', '分析', '校准', '进水', '回放', '自检'];
    for (const name of tabNames) {
      expect(appSource).toContain(name);
    }
    // 引导文案必须覆盖全部页签，不能漏讲
    const stepText = ONBOARDING_STEPS.map((s) => `${s.tab} ${s.title} ${s.body}`).join(' / ');
    for (const name of tabNames) {
      expect(stepText).toContain(name);
    }
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopbarMenu } from '../src/client/components/TopbarMenu';

/**
 * 顶栏设置菜单。
 *
 * 把两个配置入口收进一个菜单后，必须保证：键盘能打开、Esc 能关、
 * 点外面能关、点菜单项能触发且菜单自动收起（否则用户会以为没反应）。
 */

afterEach(cleanup);

const items = () => [
  { key: 'model', label: '模型设置', hint: 'u2-flash · openai', onSelect: vi.fn() },
  { key: 'agent', label: 'Agent 设置', hint: '首席值班长 · standard', onSelect: vi.fn() },
];

describe('TopbarMenu', () => {
  it('默认收起，只显示触发按钮', () => {
    render(<TopbarMenu label="设置" items={items()} />);
    expect(screen.getByRole('button', { name: /设置/ })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点击展开菜单并显示当前配置摘要', () => {
    render(<TopbarMenu label="设置" items={items()} />);
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('模型设置')).toBeTruthy();
    expect(screen.getByText('u2-flash · openai')).toBeTruthy();
  });

  it('点菜单项触发回调并自动收起', () => {
    const list = items();
    render(<TopbarMenu label="设置" items={list} />);
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /模型设置/ }));
    expect(list[0].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc 关闭菜单', () => {
    render(<TopbarMenu label="设置" items={items()} />);
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点外部关闭菜单', () => {
    render(
      <div>
        <TopbarMenu label="设置" items={items()} />
        <div data-testid="outside">外部</div>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('aria-expanded 跟随开合', () => {
    render(<TopbarMenu label="设置" items={items()} />);
    const btn = screen.getByRole('button', { name: /设置/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});

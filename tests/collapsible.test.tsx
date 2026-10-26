// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Collapsible } from '../src/client/components/Collapsible';

/**
 * 折叠区块。
 *
 * 侧栏要「一屏放下六七个环节」，靠的就是这个：标题行永远显示，
 * 摘要行给出收起状态下的关键读数，正文按需展开。
 */

afterEach(cleanup);

describe('Collapsible', () => {
  it('默认收起，只露出标题与摘要', () => {
    render(
      <Collapsible title="工艺控制变量" summary="DO 2.0">
        <div>滑块</div>
      </Collapsible>,
    );
    expect(screen.getByRole('button', { name: /工艺控制变量/ })).toBeTruthy();
    expect(screen.getByText('DO 2.0')).toBeTruthy();
    expect(screen.queryByText('滑块')).toBeNull();
  });

  it('点击标题展开与收起', () => {
    render(
      <Collapsible title="工况注入" summary="8 种" defaultOpen={false}>
        <div>场景卡片</div>
      </Collapsible>,
    );
    const head = screen.getByRole('button', { name: /工况注入/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(screen.getByText('场景卡片')).toBeTruthy();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(screen.queryByText('场景卡片')).toBeNull();
  });

  it('defaultOpen 时初始展开', () => {
    render(
      <Collapsible title="控制变量" defaultOpen>
        <div>内容</div>
      </Collapsible>,
    );
    expect(screen.getByText('内容')).toBeTruthy();
  });

  it('keepMounted 收起时保留 DOM（图表不重建）', () => {
    const { container } = render(
      <Collapsible title="趋势" keepMounted>
        <div>echarts</div>
      </Collapsible>,
    );
    expect(container.querySelector('.collapsible-body')?.hasAttribute('hidden')).toBe(true);
  });
});

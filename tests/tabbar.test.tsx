// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { nextTabIndex, tabDomIds, tabIndexFor } from '../src/client/components/tabNav';

/**
 * 页签栏可访问性：渲染级断言。
 *
 * tabNav.test.ts 覆盖键位计算；这里覆盖真实的 DOM 契约——
 * 未选中项不进 Tab 序列、方向键真的把选中态与焦点移到下一个页签。
 * 两处都测是因为「计算对了但没接到 DOM 上」是这类改造最常见的漏。
 */

afterEach(cleanup);

const TABS = [
  { id: 'chat', label: 'AI 对话' },
  { id: 'decision', label: '决策解释' },
  { id: 'control', label: '控制与工况' },
];

function TabBar() {
  const [active, setActive] = useState(TABS[0].id);
  return (
    <div
      role="tablist"
      aria-label="测试页签"
      onKeyDown={(e) => {
        const idx = TABS.findIndex((t) => t.id === active);
        const next = nextTabIndex(e.key, idx, TABS.length);
        if (next === null) return;
        e.preventDefault();
        setActive(TABS[next].id);
        e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab-index="${next}"]`)?.focus();
      }}
    >
      {TABS.map((t, i) => (
        <button
          key={t.id}
          role="tab"
          data-tab-index={i}
          aria-selected={active === t.id}
          aria-controls={tabDomIds('side', t.id).panel}
          tabIndex={tabIndexFor(active === t.id)}
          onClick={() => setActive(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

describe('页签 DOM 契约', () => {
  it('tab 与 panel 的 id 成对且稳定', () => {
    const ids = tabDomIds('side', 'alarms');
    expect(ids.tab).toBe('side-tab-alarms');
    expect(ids.panel).toBe('side-panel-alarms');
  });

  it('未选中页签 tabIndex=-1，选中项为 0', () => {
    expect(tabIndexFor(true)).toBe(0);
    expect(tabIndexFor(false)).toBe(-1);
  });

  it('只有选中页签进入 Tab 序列', () => {
    render(<TabBar />);
    expect(screen.getByRole('tab', { name: 'AI 对话' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: '决策解释' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tab', { name: '控制与工况' }).getAttribute('tabindex')).toBe('-1');
  });

  it('方向键切换选中态并移动焦点', () => {
    render(<TabBar />);
    const first = screen.getByRole('tab', { name: 'AI 对话' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '决策解释' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'AI 对话' }).getAttribute('aria-selected')).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '决策解释' }));
  });

  it('End 跳到最后一个页签', () => {
    render(<TabBar />);
    const first = screen.getByRole('tab', { name: 'AI 对话' });
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getByRole('tab', { name: '控制与工况' }).getAttribute('aria-selected')).toBe('true');
  });
});

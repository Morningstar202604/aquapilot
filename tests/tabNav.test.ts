import { describe, expect, it } from 'vitest';
import { nextTabIndex, tabDomIds, tabIndexFor } from '../src/client/components/tabNav';

/**
 * 页签导航的键位语义。
 *
 * 这些断言对应 WAI-ARIA Authoring Practices 的 Tabs 模式：
 * 方向键循环移动、Home/End 跳首尾、未选中项不进 Tab 序列。
 * 之前的页签栏只有 role 与 aria-selected，键盘用户按 11 次 Tab 才能出去。
 */

describe('nextTabIndex', () => {
  it('右箭头前进并在末尾回到开头', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
  });

  it('左箭头后退并在开头回到末尾', () => {
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1);
  });

  it('Home / End 跳到首尾', () => {
    expect(nextTabIndex('Home', 2, 5)).toBe(0);
    expect(nextTabIndex('End', 1, 5)).toBe(4);
  });

  it('RTL 下左右方向相反', () => {
    expect(nextTabIndex('ArrowRight', 0, 3, true)).toBe(2);
    expect(nextTabIndex('ArrowLeft', 0, 3, true)).toBe(1);
  });

  it('其它键不拦截，交回给浏览器/面板', () => {
    expect(nextTabIndex('Enter', 1, 3)).toBeNull();
    expect(nextTabIndex('a', 1, 3)).toBeNull();
    expect(nextTabIndex('Tab', 1, 3)).toBeNull();
  });

  it('空列表与越界索引都被夹紧，不返回负数', () => {
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
    expect(nextTabIndex('ArrowRight', -5, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 99, 3)).toBe(0);
  });
});

describe('roving tabindex', () => {
  it('只有选中项为 0，其余为 -1', () => {
    expect(tabIndexFor(true)).toBe(0);
    expect(tabIndexFor(false)).toBe(-1);
  });
});

describe('tabDomIds', () => {
  it('同一页签生成互指且稳定的 id', () => {
    const ids = tabDomIds('side', 'alarms');
    expect(ids.tab).toBe('side-tab-alarms');
    expect(ids.panel).toBe('side-panel-alarms');
    expect(tabDomIds('side', 'alarms')).toEqual(ids);
  });

  it('不同页签之间不会碰撞', () => {
    const all = new Set(['chat', 'decision', 'control', 'alarms'].map((t) => tabDomIds('side', t).panel));
    expect(all.size).toBe(4);
  });
});

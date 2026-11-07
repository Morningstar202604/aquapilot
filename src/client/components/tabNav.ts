/**
 * 可访问的页签导航（WAI-ARIA Tabs 模式）。
 *
 * 原有实现只有 `role="tablist"` + `role="tab"` + `aria-selected`，缺三样东西，
 * 对读屏和纯键盘用户都是真问题：
 *
 * 1. 每个页签没有 `aria-controls`，面板没有 `role="tabpanel"` ——
 *    读屏软件念出「选项卡」之后无法告知它控制哪一块内容；
 * 2. 没有 roving tabindex：11 个页签全部落在 Tab 序列里，
 *    键盘用户要按 11 次 Tab 才能越过页签栏（WAI-ARIA 要求只有选中项可 Tab）；
 * 3. 没有方向键导航：左右/Home/End 移动焦点并切换（自动激活）。
 *
 * 这里把页签顺序与键位解析做成纯函数，App 只负责渲染与 setTab，
 * 测试可以完全脱离 DOM 断言键位语义。
 */

export interface TabSpec<T extends string> {
  id: T;
  label: string;
}

/**
 * 计算方向键导航后的目标页签。
 *
 * - ArrowRight / ArrowLeft：循环移动（末尾回到开头）；
 * - Home / End：跳到首尾；
 * - 其它键返回 null，调用方不拦截，避免吞掉用户的其它输入。
 */
export function nextTabIndex(key: string, currentIndex: number, total: number, rtl = false): number | null {
  if (total <= 0) return null;
  const index = Math.min(Math.max(currentIndex, 0), total - 1);
  switch (key) {
    case 'ArrowRight':
      return (index + (rtl ? -1 : 1) + total) % total;
    case 'ArrowLeft':
      return (index + (rtl ? 1 : -1) + total) % total;
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    default:
      return null;
  }
}

/**
 * roving tabindex：只有当前选中的页签进入 Tab 序列。
 *
 * 这是 WAI-ARIA Tabs 的硬要求；全部 `tabIndex=0` 会让键盘用户的
 * 每一次「跳到侧栏」都落在页签栏的第一个按钮上。
 */
export function tabIndexFor(isActive: boolean): 0 | -1 {
  return isActive ? 0 : -1;
}

/** 面板 id 与页签 id 必须成对，供 aria-controls / aria-labelledby 互指 */
export function tabDomIds<T extends string>(base: string, id: T): { tab: string; panel: string } {
  return { tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` };
}

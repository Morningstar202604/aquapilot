import { useState, type ReactNode } from 'react';

interface Props {
  title: string;
  /** 标题右侧的摘要（收起时也能看到关键信息） */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** 收起时仍然渲染（用 CSS 隐藏）而不是卸载：图表 DOM 重建代价高 */
  keepMounted?: boolean;
  className?: string;
}

/**
 * 可折叠区块。
 *
 * 工业组态软件（WinCC、Ignition、Aspen）的侧栏都按「折叠分组」组织：
 * 首屏只给分组名与关键读数，需要改参数时再展开。这样一屏能放下
 * 六七个环节，而不是被一整列滑块撑到要滚三屏。
 */
export function Collapsible({ title, summary, children, defaultOpen = false, keepMounted = false, className }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={className ? `collapsible ${className}` : 'collapsible'} data-open={open}>
      <button type="button" className="collapsible-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="collapsible-title">{title}</span>
        {summary && <span className="collapsible-summary">{summary}</span>}
      </button>
      {open ? (
        <div className="collapsible-body">{children}</div>
      ) : keepMounted ? (
        <div className="collapsible-body" hidden>
          {children}
        </div>
      ) : null}
    </section>
  );
}

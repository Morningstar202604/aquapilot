import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  onSelect: () => void;
}

interface Props {
  label: string;
  icon?: ReactNode;
  items: MenuItem[];
  /** 触发按钮上的状态点：有内容时点亮 */
  live?: boolean;
}

/**
 * 顶栏下拉菜单。
 *
 * 顶栏在 1280 宽下已经排了 9 个控件；把「模型设置 / Agent 设置」这类
 * 低频入口收进一个「设置」菜单，是组态软件里常见的做法——
 * 常用操作（暂停、倍速、视图切换）留在外面，配置项留一个入口即可。
 *
 * 交互细节：点外部关闭、Esc 关闭、打开后焦点落到第一项、关闭后焦点回到按钮。
 */
export function TopbarMenu({ label, icon, items, live }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开时把焦点移到第一个菜单项，键盘用户不必再 Tab 一次
  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>('.topbar-menu-item');
    first?.focus();
  }, [open]);

  return (
    <div className="topbar-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        className="pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot" data-live={live} />
        {icon}
        {label}
        <span className="topbar-menu-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="topbar-menu-pop" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className="topbar-menu-item"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="topbar-menu-label">{item.label}</span>
              {item.hint && <span className="topbar-menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

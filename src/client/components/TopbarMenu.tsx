import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
 *
 * 菜单必须挂到 body：`.topbar` 用 `overflow: clip` 防止聚焦时整条顶栏被
 * 程序化滚动，但 clip 同时会把绝对定位的弹层裁掉（实测菜单存在却看不见，
 * 点击穿透到下面的「进水」页签）。portal + fixed 定位让菜单既不被裁，
 * 也不影响顶栏的滚动约束。
 */
export function TopbarMenu({ label, icon, items, live }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 208;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 6,
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
      }
    };
    const onResize = () => place();
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // 打开时把焦点移到第一个菜单项，键盘用户不必再 Tab 一次
  useEffect(() => {
    if (!open) return;
    const first = popRef.current?.querySelector<HTMLButtonElement>('.topbar-menu-item');
    first?.focus({ preventScroll: true });
  }, [open]);

  const toggle = () => {
    if (!open) place();
    setOpen((v) => !v);
  };

  return (
    <div className="topbar-menu" ref={rootRef}>
      <button ref={buttonRef} className="pill" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span className="dot" data-live={live} />
        {icon}
        {label}
        <span className="topbar-menu-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="topbar-menu-pop"
            role="menu"
            aria-label={label}
            style={{ position: 'fixed', left: pos.left, top: pos.top }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}

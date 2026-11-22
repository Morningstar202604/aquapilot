import { Suspense, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { tabDomIds } from './tabNav';

/**
 * 侧栏面板的统一外壳。
 *
 * 12 个页签此前各写一份 `role="tabpanel"` + id/aria-labelledby + ErrorBoundary，
 * 新增页签时最容易漏的是 id 与页签不配对——读屏会指到不存在的面板，
 * 或者错误边界标签各写一套。这里把 DOM 契约和错误兜底收成一处。
 */
export function TabPanel({
  tab,
  label,
  children,
  base = 'side',
  fallback = '面板加载中…',
}: {
  tab: string;
  /** 错误边界展示的模块名 */
  label: string;
  children: ReactNode;
  base?: string;
  fallback?: ReactNode;
}) {
  const ids = tabDomIds(base, tab);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className="tab-panel">
      <ErrorBoundary compact label={label}>
        <Suspense fallback={<div className="empty-note">{fallback}</div>}>{children}</Suspense>
      </ErrorBoundary>
    </div>
  );
}

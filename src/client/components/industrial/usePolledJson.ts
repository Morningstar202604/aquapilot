import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchJson } from './http';

/**
 * 「工业」页签共用的轮询只读 JSON hook。
 *
 * 合规 / 资产 / 仪表三块子视图都是同一个模式：拉一次、按 pollMs 轮询、
 * 失败进错误态、成功进数据态。之前各写一份，jscpd 直接报克隆；抽到这里后
 * 每个面板只剩渲染逻辑。`pollMs=0` 表示不轮询。
 */
export type PolledJson<T> =
  { kind: 'loading' } | { kind: 'error'; message: string; code?: string } | { kind: 'ready'; data: T };

/** 首拉 + 轮询：所有面板共用同一套 effect 顺序，避免复制粘贴漂移。 */
export function usePolling(load: () => Promise<void>, pollMs: number): void {
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);
}

export function usePolledJson<T>(url: string, token: string | null | undefined, pollMs: number): PolledJson<T> {
  const [state, setState] = useState<PolledJson<T>>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', data: await fetchJson<T>(url, token) });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof ApiError ? err.code : undefined,
      });
    }
  }, [url, token]);

  usePolling(load, pollMs);

  return state;
}

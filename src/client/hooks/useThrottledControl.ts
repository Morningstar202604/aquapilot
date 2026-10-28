import { useCallback, useEffect, useRef } from 'react';

/**
 * 控制滑块的提交节流。
 *
 * 原生 range 的 `input`/`change` 在拖动期间约 60 Hz 触发一次。
 * 每条都发一条 `control` 消息的后果：
 * - 服务端限流 500 ms/次，绝大多数被拒，每次都回弹一条「操作过于频繁」；
 * - 最后停下的那个值也可能落在限流窗口里被丢弃，滑块回弹。
 *
 * 策略：首个事件立即提交（保证单击/键盘操作零延迟），
 * 窗口内的后续事件只保留最新值，窗口结束时补发一次 trailing。
 * 这样拖动一次最多 4 条消息，且终值一定送达。
 */
export function useThrottledControl<T extends Record<string, unknown>>(
  commit: (patch: T) => void,
  intervalMs = 250,
): (patch: T) => void {
  const lastEmitAt = useRef(0);
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (patch: T) => {
      const now = Date.now();
      const elapsed = now - lastEmitAt.current;
      if (elapsed >= intervalMs && pending.current === null) {
        lastEmitAt.current = now;
        commit(patch);
        return;
      }
      pending.current = patch;
      if (timer.current) return;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          const queued = pending.current;
          pending.current = null;
          if (!queued) return;
          lastEmitAt.current = Date.now();
          commit(queued);
        },
        Math.max(0, intervalMs - elapsed),
      );
    },
    [commit, intervalMs],
  );
}

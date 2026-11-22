import { useEffect, useMemo, useRef } from 'react';
import { throttle } from 'throttle-debounce';

/**
 * 控制滑块的提交节流。
 *
 * 原生 range 的 `input`/`change` 在拖动期间约 60 Hz 触发一次。逐条发送
 * `control` 会被服务端 500 ms 限流拒掉大半，最后停下的值还可能落在窗口里
 * 被丢弃、滑块回弹。
 *
 * 语义交给 throttle-debounce：首个事件立即提交，窗口内只保留最新参数，
 * 窗口结束时补发一次 trailing。拖动一次最多 4 条消息，终值一定送达。
 */
export function useThrottledControl<T extends Record<string, unknown>>(
  commit: (patch: T) => void,
  intervalMs = 250,
): (patch: T) => void {
  /**
   * 用 ref 存最新 commit，而不是把 commit 放进 useMemo 依赖。
   *
   * ControlPanel 的 onChange 来自 useSimulation，每次 App 重渲染都会换一个
   * 函数身份；若依赖它，节流器会被反复销毁重建，正在等待的 trailing 参数
   * 直接丢失，滑块终值就送不到服务端。
   */
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);
  const throttled = useMemo(() => throttle(intervalMs, (patch: T) => commitRef.current(patch)), [intervalMs]);
  useEffect(() => () => throttled.cancel(), [throttled]);
  return throttled;
}

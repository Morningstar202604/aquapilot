// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThrottledControl } from '../src/client/hooks/useThrottledControl';

describe('useThrottledControl', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('首个参数立即提交，窗口内只补发最后一次', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useThrottledControl(commit, 250));
    act(() => result.current({ doSetpoint: 1 }));
    expect(commit).toHaveBeenLastCalledWith({ doSetpoint: 1 });
    act(() => result.current({ doSetpoint: 2 }));
    act(() => result.current({ doSetpoint: 3 }));
    expect(commit).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(250));
    expect(commit).toHaveBeenLastCalledWith({ doSetpoint: 3 });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('父组件换 callback 身份后，节流器仍保留 trailing 参数', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ commit }) => useThrottledControl(commit, 250), {
      initialProps: { commit: first },
    });
    act(() => result.current({ rasRatio: 1 }));
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ commit: second });
    act(() => result.current({ rasRatio: 2 }));
    act(() => vi.advanceTimersByTime(250));
    expect(second).toHaveBeenLastCalledWith({ rasRatio: 2 });
  });
});

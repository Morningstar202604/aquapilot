import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';

/**
 * ECharts 实例的生命周期。
 *
 * Trends 与 Replay 各自手写了一遍「init → group/connect → ResizeObserver →
 * dispose」，漏掉 dispose 就会在切页/重载后留下常驻 canvas 与监听器。
 * 这里只负责生命周期；注册哪些图表组件仍由使用方决定，避免把整套
 * ECharts 组件打进首屏。
 */
export function useEChart(options: { group?: string } = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const group = options.group;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const instance = echarts.init(node, undefined, { renderer: 'canvas' });
    if (group) {
      instance.group = group;
      // 多图联动：同一时刻的 tooltip/十字线跨图同步
      echarts.connect(group);
    }
    chart.current = instance;
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [group]);

  return { containerRef, chart };
}

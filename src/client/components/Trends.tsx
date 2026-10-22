import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import type { LineSeriesOption } from 'echarts/charts';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { PlantSnapshot } from '../../shared/protocol';

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

interface Props {
  snap: PlantSnapshot;
}

type SeriesKey = 'water' | 'nitrogen' | 'energy';

interface ChartSpec {
  key: SeriesKey;
  title: string;
  unit: string;
  series: { name: string; color: string; key: keyof PlantSnapshot['trends'][number] }[];
  limits: { value: number; label: string }[];
  yMax?: number;
}

const SPECS: ChartSpec[] = [
  {
    key: 'water',
    title: '有机物与悬浮物',
    unit: 'mg/L',
    series: [
      { name: '出水 COD', color: '#3ee0b5', key: 'effluentCod' },
      { name: '出水 SS', color: '#f0a83c', key: 'effluentSs' },
      { name: '进水 COD', color: '#2f6a5d', key: 'influentCod' },
    ],
    limits: [
      { value: 50, label: 'COD 限值' },
      { value: 10, label: 'SS 限值' },
    ],
    yMax: 120,
  },
  {
    key: 'nitrogen',
    title: '营养盐',
    unit: 'mg/L',
    series: [
      { name: '出水 NH₃-N', color: '#4fd6e8', key: 'effluentNh' },
      { name: '出水 TN', color: '#8f7fe8', key: 'effluentTn' },
      { name: '出水 TP', color: '#f0a83c', key: 'effluentTp' },
    ],
    limits: [
      { value: 5, label: 'NH₃-N 限值' },
      { value: 0.5, label: 'TP 限值' },
    ],
    yMax: 20,
  },
  {
    key: 'energy',
    title: '能耗与溶解氧',
    unit: 'kW / mg·L⁻¹',
    series: [
      { name: '总能耗', color: '#f0a83c', key: 'energyKw' },
      { name: '溶解氧', color: '#4fd6e8', key: 'do' },
    ],
    limits: [{ value: 1, label: 'DO 下限' }],
  },
];

function Chart({ spec, snap }: { spec: ChartSpec; snap: PlantSnapshot }) {
  const el = useRef<HTMLDivElement | null>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const onResize = () => instance.resize();
    const ro = new ResizeObserver(onResize);
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const trend = snap.trends.slice(-260);
    const times = trend.map((p) => p.t);
    // 仿真时钟格式：天 时:分，如 D2 03:40。此前写成「55h10」，
    // 跨天后既不可读也无法判断是哪一天。
    const xData = times.map((t) => {
      const day = Math.floor(t / 1440) + 1;
      const h = Math.floor((t % 1440) / 60);
      const m = Math.floor(t % 60);
      return `D${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    });

    const series: LineSeriesOption[] = spec.series.map((s) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      smooth: 0.25,
      lineStyle: { width: 1.4, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: 'series' },
      data: trend.map((p) => Number((p[s.key] as number).toFixed(3))),
      yAxisIndex: (s.key as string) === 'influentCod' ? 1 : 0,
    }));

    if (spec.key === 'water') {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(255,107,90,0.5)', type: 'dashed', width: 1 },
        data: [{ yAxis: 50 }],
      };
    }
    if (spec.key === 'nitrogen') {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(255,107,90,0.5)', type: 'dashed', width: 1 },
        data: [{ yAxis: 5 }],
      };
    }
    if (spec.key === 'energy') {
      series[1].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(240,168,60,0.45)', type: 'dashed', width: 1 },
        data: [{ yAxis: 1 }],
      };
    }

    const tracked = spec.series.filter((s) => (s.key as string) !== 'influentCod');
    const maxTracked = Math.max(...trend.flatMap((p) => tracked.map((s) => p[s.key] as number)), 0.1);
    const limitMax = Math.max(...spec.limits.map((l) => l.value));
    const yMax = Math.max(maxTracked * 1.6, limitMax * 1.35, 0.5);

    instance.setOption(
      {
        animation: false,
        grid: { left: 42, right: 12, top: 22, bottom: 20 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(8,22,21,0.96)',
          borderColor: '#1d3b37',
          borderWidth: 1,
          textStyle: { color: '#e4f2ee', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
          axisPointer: { type: 'line', lineStyle: { color: '#1d3b37' } },
          valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v)),
        },
        xAxis: {
          type: 'category',
          data: xData,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#1d3b37' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#5f7d78',
            fontSize: 9,
            interval: Math.max(0, Math.floor(xData.length / 5)),
            fontFamily: 'JetBrains Mono, monospace',
          },
          splitLine: { show: false },
        },
        yAxis: [
          {
            type: 'value',
            min: 0,
            max: yMax,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: '#5f7d78',
              fontSize: 9,
              fontFamily: 'JetBrains Mono, monospace',
              formatter: (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
            },
            splitLine: { lineStyle: { color: 'rgba(29,59,55,0.5)' } },
          },
          {
            type: 'value',
            show: spec.key === 'water',
            min: 0,
            max: Math.max(...trend.map((p) => p.influentCod), 400) * 1.3,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: '#2f6a5d',
              fontSize: 9,
              fontFamily: 'JetBrains Mono, monospace',
              formatter: (v: number) => String(Math.round(v)),
            },
            splitLine: { show: false },
          },
        ],
        series,
      },
      { notMerge: false, lazyUpdate: true },
    );
  }, [snap, spec]);

  const last = snap.trends[snap.trends.length - 1];
  const readout = spec.series
    .map(
      (s) =>
        `${s.name.replace('出水 ', '').replace('进水 ', '进')} ${last ? Number(last[s.key]).toFixed(s.key === 'energyKw' ? 0 : 2) : '—'}`,
    )
    .join(' · ');

  return (
    <div className="trend-cell">
      <div className="trend-head">
        <span className="trend-title">{spec.title}</span>
        <span className="trend-now" style={{ color: spec.series[0].color }}>
          {readout}
        </span>
      </div>
      <div className="trend-canvas" ref={el} role="img" aria-label={`${spec.title} 趋势图，单位 ${spec.unit}`} />
    </div>
  );
}

export function Trends({ snap }: Props) {
  return (
    <div className="trends">
      {SPECS.map((spec) => (
        <Chart key={spec.key} spec={spec} snap={snap} />
      ))}
    </div>
  );
}

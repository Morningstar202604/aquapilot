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
type BandMetric = 'cod' | 'nh' | 'tn' | 'tp' | 'ss';

interface ChartSpec {
  key: SeriesKey;
  title: string;
  unit: string;
  /** 该图叠加预测扇区时使用哪个出水指标 */
  bandMetric?: BandMetric;
  series: { name: string; color: string; key: keyof PlantSnapshot['trends'][number] }[];
  limits: { value: number; label: string }[];
  yMax?: number;
}

const SPECS: ChartSpec[] = [
  {
    key: 'water',
    title: '有机物与悬浮物',
    unit: 'mg/L',
    bandMetric: 'cod',
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
    bandMetric: 'nh',
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

/** #rrggbb → rgba(r, g, b, a)，给面积渐变用的极简工具 */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

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

    const series: LineSeriesOption[] = spec.series.map((s, idx) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      smooth: 0.25,
      lineStyle: { width: idx === 0 ? 1.8 : 1.3, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: 'series', lineStyle: { width: 2.4 } },
      // 主序列带一条从实到透明的面积底，读起来有厚度
      areaStyle:
        idx === 0
          ? {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: withAlpha(s.color, 0.14) },
                { offset: 1, color: withAlpha(s.color, 0) },
              ]),
            }
          : undefined,
      data: trend.map((p) => Number((p[s.key] as number).toFixed(3))),
      yAxisIndex: (s.key as string) === 'influentCod' ? 1 : 0,
    }));

    /**
     * 预测扇区：把集合预测的 P10–P90 画成半透明带 + P50 虚线。
     *
     * 时间轴是分类轴，预测点只能追加在历史之后；为免把 X 轴拉长 5 倍，
     * 每小时取一个点。扇区只表示"参数不确定性范围"，不是统计置信区间。
     */
    const band = snap.forecastBand;
    let xData2 = xData;
    if (spec.bandMetric && band && band.points.length > 0) {
      const hourly = band.points.filter((_, i) => i % 2 === 0);
      const metric = spec.bandMetric;
      const pad = Array(xData.length).fill(null) as (number | null)[];
      const p10 = pad.concat(hourly.map((p) => Number(p[metric].p10.toFixed(3))));
      const p90 = pad.concat(hourly.map((p) => Number(p[metric].p90.toFixed(3))));
      const p50 = pad.concat(hourly.map((p) => Number(p[metric].p50.toFixed(3))));
      for (const s of series) s.data = [...(s.data as number[]), ...Array(hourly.length).fill(null)];
      xData2 = [...xData, ...hourly.map((p) => `+${Math.round(p.minute / 60)}h`)];
      series.push(
        {
          name: 'P10',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          stack: `band-${spec.key}`,
          data: p10,
          silent: true,
        },
        {
          name: 'P10–P90 预测区间',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'rgba(79,214,232,0.16)' },
          stack: `band-${spec.key}`,
          data: p90.map((v, i) => (v === null ? null : v - (p10[i] ?? 0))),
          silent: true,
        },
        {
          name: 'P50 预测',
          type: 'line',
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { width: 1.2, color: '#4fd6e8', type: 'dashed' },
          data: p50,
          silent: true,
        },
      );
    }

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
        grid: { left: 42, right: 12, top: 20, bottom: 20 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(8,22,21,0.97)',
          borderColor: 'rgba(62,224,181,0.2)',
          borderWidth: 1,
          padding: [6, 9],
          extraCssText: 'border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,0.45);backdrop-filter:blur(4px);',
          textStyle: { color: '#e4f2ee', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
          axisPointer: { type: 'line', lineStyle: { color: 'rgba(62,224,181,0.25)', width: 1 } },
          valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v)),
        },
        xAxis: {
          type: 'category',
          data: xData2,
          boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(29,59,55,0.7)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#72948d',
            fontSize: 9,
            interval: Math.max(0, Math.floor(xData2.length / 5)),
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
              color: '#72948d',
              fontSize: 9,
              fontFamily: 'JetBrains Mono, monospace',
              formatter: (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
            },
            splitLine: { lineStyle: { color: 'rgba(29,59,55,0.35)', type: 'dashed' } },
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
        <div className="trend-title-row">
          <span className="trend-title">{spec.title}</span>
          <span className="trend-now" style={{ color: spec.series[0].color }}>
            {readout}
          </span>
        </div>
        <div className="trend-legend">
          {spec.series.map((s) => (
            <span className="trend-legend-item" key={s.key}>
              <span className="trend-legend-dot" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
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

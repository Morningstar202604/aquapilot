import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import type { LineSeriesOption } from 'echarts/charts';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { PlantSnapshot } from '../../shared/protocol';
import { formatClock } from '../../shared/time';
import {
  RANGE_LABEL,
  RANGE_MINUTES,
  type TrendRange,
  autoYMax,
  loadRangePreference,
  lttb,
  saveRangePreference,
  sliceByRange,
} from './trendData';

/** 排除 'all' 后的窗口分钟数，供「缓冲是否够用」判断使用 */
const RANGE_MINUTES_ONLY = RANGE_MINUTES;

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

interface Props {
  snap: PlantSnapshot;
  /** 全局时间范围（三张图共享同一窗口，便于横向对照） */
  range?: TrendRange;
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
      { name: '出水 COD', color: '#0c9d7e', key: 'effluentCod' },
      { name: '出水 SS', color: '#b0770e', key: 'effluentSs' },
      { name: '进水 COD', color: '#4b6f68', key: 'influentCod' },
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
      { name: '出水 NH₃-N', color: '#0d7f96', key: 'effluentNh' },
      { name: '出水 TN', color: '#7c5cd6', key: 'effluentTn' },
      { name: '出水 TP', color: '#b0770e', key: 'effluentTp' },
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
      { name: '总能耗', color: '#b0770e', key: 'energyKw' },
      { name: '溶解氧', color: '#0d7f96', key: 'do' },
    ],
    limits: [{ value: 1, label: 'DO 下限' }],
  },
];

/** #rrggbb → rgba(r, g, b, a)，给面积渐变用的极简工具 */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function Chart({ spec, snap, range = 'all' }: { spec: ChartSpec; snap: PlantSnapshot; range?: TrendRange }) {
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
    /**
     * 数据量上限与降采样。
     *
     * 缓冲 720 点、三张图各自 Canvas 重绘时，切到 72 h 会明显卡顿；
     * 降到 260 点后肉眼几乎看不出区别，而峰谷由 LTTB 保证保留。
     * 抽样以首条曲线为保形基准，其余曲线同下标取值（共享 X 轴）。
     */
    const windowed = sliceByRange(snap.trends, range);
    const trend = lttb(windowed, 260, (p) => Number(p[spec.series[0].key] as number)) as PlantSnapshot['trends'];
    const times = trend.map((p) => p.t);
    // 仿真时钟格式：天 时:分，如 D2 03:40。此前写成「55h10」，
    // 跨天后既不可读也无法判断是哪一天。
    const xData = times.map(formatClock);

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
          id: 'band-p10',
          name: 'P10',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          stack: `band-${spec.key}`,
          data: p10,
          silent: true,
        },
        {
          id: 'band-range',
          name: 'P10–P90 预测区间',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'rgba(13,127,150,0.14)' },
          stack: `band-${spec.key}`,
          data: p90.map((v, i) => (v === null ? null : v - (p10[i] ?? 0))),
          silent: true,
        },
        {
          id: 'band-p50',
          name: 'P50 预测',
          type: 'line',
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { width: 1.2, color: '#0d7f96', type: 'dashed' },
          data: p50,
          silent: true,
        },
      );
    }

    /**
     * 预测消失后必须显式清空，不能只是「不 push」。
     *
     * `setOption(..., {notMerge:false})` 会按 series 索引做增量合并：
     * 少传 3 条 band 序列时，ECharts 保留上一次的 P10/P90/P50 并继续画，
     * 于是重置仿真后趋势图上会挂着一条幽灵预测扇区（实测可复现）。
     * 用固定 id + 空数据覆盖，保证序列被真正清掉。
     */
    if (!(spec.bandMetric && band && band.points.length > 0)) {
      series.push(
        { id: 'band-p10', name: 'P10', type: 'line', data: [], silent: true },
        { id: 'band-range', name: 'P10–P90 预测区间', type: 'line', data: [], silent: true },
        { id: 'band-p50', name: 'P50 预测', type: 'line', data: [], silent: true },
      );
    }

    if (spec.key === 'water') {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(210,71,47,0.55)', type: 'dashed', width: 1 },
        data: [{ yAxis: 50 }],
      };
    }
    if (spec.key === 'nitrogen') {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(210,71,47,0.55)', type: 'dashed', width: 1 },
        data: [{ yAxis: 5 }],
      };
    }
    if (spec.key === 'energy') {
      series[1].markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(176,119,14,0.5)', type: 'dashed', width: 1 },
        data: [{ yAxis: 1 }],
      };
    }

    const tracked = spec.series.filter((s) => (s.key as string) !== 'influentCod');
    const limitMax = Math.max(...spec.limits.map((l) => l.value));
    // autoYMax 抽到纯函数里：同一套留白规则被三张图与单测共用
    const yMax = autoYMax(
      trend.flatMap((p) => tracked.map((s) => p[s.key] as number)),
      limitMax,
    );

    instance.setOption(
      {
        animation: false,
        grid: { left: 42, right: 12, top: 20, bottom: 20 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(255,255,255,0.97)',
          borderColor: 'rgba(12,157,126,0.28)',
          borderWidth: 1,
          padding: [6, 9],
          extraCssText: 'border-radius:6px;box-shadow:0 10px 30px rgba(16,49,43,0.18);backdrop-filter:blur(4px);',
          textStyle: { color: '#182b26', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
          axisPointer: { type: 'line', lineStyle: { color: 'rgba(12,157,126,0.3)', width: 1 } },
          valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v)),
        },
        xAxis: {
          type: 'category',
          data: xData2,
          boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(16,49,43,0.35)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#5d7871',
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
              color: '#5d7871',
              fontSize: 9,
              fontFamily: 'JetBrains Mono, monospace',
              formatter: (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
            },
            splitLine: { lineStyle: { color: 'rgba(16,49,43,0.12)', type: 'dashed' } },
          },
          {
            type: 'value',
            show: spec.key === 'water',
            min: 0,
            max: Math.max(...trend.map((p) => p.influentCod), 400) * 1.3,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: '#4b6f68',
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
  }, [snap, spec, range]);

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

/**
 * 趋势区。
 *
 * `dense` 用于把三张图压成一行高度更小的紧凑模式（编排视图或小屏），
 * 网格列数仍由 CSS 决定，这里只控制内边距与图表高度。
 *
 * 时间范围是三张图共享的（Grafana 的做法）：只改一张图的范围会让
 * 「同一时刻的能耗与出水」对不上，那正是操作员最需要横向对照的东西。
 */
export function Trends({ snap, dense = false }: Props & { dense?: boolean }) {
  const [range, setRange] = useState<TrendRange>(() => loadRangePreference());
  const pick = (r: TrendRange) => {
    setRange(r);
    saveRangePreference(r);
  };
  const total = snap.trends.length;
  const shownPoints = sliceByRange(snap.trends, range);
  const shown = shownPoints.length;
  /**
   * 缓冲只有 720 点：选中的窗口超过可用数据时如实说明，而不是假装画满。
   * 起点只有一两个点时（刚启动/刚重置）不提示"超出缓冲"——那会让用户
   * 以为数据出了问题，实际只是还没跑起来。
   */
  const spanMin = total > 1 ? snap.trends[total - 1].t - snap.trends[0].t : 0;
  const wantedMin = range === 'all' ? spanMin : RANGE_MINUTES_ONLY[range];
  const clipped = spanMin > 0 && wantedMin > spanMin + 1;

  return (
    <div className={dense ? 'trend-section-inner trends-dense' : 'trend-section-inner'}>
      {/*
        范围条放在网格外面。
        早先它作为 `.trends` 的第一个网格项（grid-column: 1/-1），在窄屏下
        `.trends` 会变成 grid-auto-flow: column 的横滑行——范围条自己占了
        一列，三张图被推到后面，手机上只能看到一张图加一大片空白（截图实测）。
        独立成一层后，两种布局都不会互相干扰。
      */}
      <div className="trend-range-bar" role="group" aria-label="趋势时间范围">
        {(Object.keys(RANGE_LABEL) as TrendRange[]).map((r) => (
          <button
            key={r}
            className="pill trend-range"
            data-active={range === r}
            aria-pressed={range === r}
            onClick={() => pick(r)}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
        <span className="trend-range-note">
          {total <= 1 ? '等待采样点' : `${shown} 点 · 缓冲 ${(spanMin / 60).toFixed(1)} h`}
          {clipped ? '（范围超出缓冲，已显示全部）' : ''}
        </span>
      </div>
      <div className={dense ? 'trends trends-dense' : 'trends'}>
        {SPECS.map((spec) => (
          <Chart key={spec.key} spec={spec} snap={snap} range={range} />
        ))}
      </div>
    </div>
  );
}

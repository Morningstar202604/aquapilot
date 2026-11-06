/**
 * 趋势图的纯数据逻辑（可单测，不依赖 ECharts）。
 *
 * 抽出这些函数的原因：趋势区有三件容易写错、又难以在浏览器里断言的事——
 * 时间窗口的选取、降采样是否保形、坐标轴范围的持久化。做成纯函数后单测
 * 就能覆盖，组件只负责画。
 */

export interface TrendLikePoint {
  t: number;
}

/** 时间范围预设：'all' 用满缓冲，其余按仿真分钟从末尾回看 */
export type TrendRange = 'all' | '6h' | '12h' | '24h' | '72h';

export const RANGE_MINUTES: Record<Exclude<TrendRange, 'all'>, number> = {
  '6h': 360,
  '12h': 720,
  '24h': 1440,
  '72h': 4320,
};

export const RANGE_LABEL: Record<TrendRange, string> = {
  all: '全部',
  '6h': '6 h',
  '12h': '12 h',
  '24h': '24 h',
  '72h': '72 h',
};

/**
 * 按仿真时间窗口截取趋势点。
 *
 * 服务端缓冲上限 720 点（约 24 h 仿真时间），超出缓冲的范围会自然退化为
 * 「全部可用数据」——不报错也不空白。
 */
export function sliceByRange<T extends TrendLikePoint>(points: T[], range: TrendRange): T[] {
  if (range === 'all' || points.length === 0) return points;
  const from = points[points.length - 1].t - RANGE_MINUTES[range];
  const start = points.findIndex((p) => p.t >= from);
  return start <= 0 ? points : points.slice(start);
}

/**
 * Largest-Triangle-Three-Buckets 降采样。
 *
 * 不用 ECharts 的 `sampling: 'lttb'`：那只在内置 dataZoom 采样时生效，
 * 而我们的 X 轴是分类轴、数据已在前端数组里。更重要的是峰谷必须保留——
 * 出水超标点被简单抽稀抹掉，趋势图就会骗人。
 *
 * `valueOf` 由调用方提供，因为每条曲线的 Y 值不同；多序列取首个序列的
 * 值做保形抽样，其余序列按同一组下标取样（共享 X 轴，视觉上对齐）。
 */
export function lttb<T extends TrendLikePoint>(points: T[], threshold: number, valueOf: (p: T) => number): T[] {
  const n = points.length;
  if (threshold >= n || threshold <= 2) return points;

  const sampled: T[] = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i += 1) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    const avgCount = Math.max(1, avgEnd - avgStart);
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j += 1) {
      avgX += points[j].t;
      avgY += valueOf(points[j]);
    }
    avgX /= avgCount;
    avgY /= avgCount;

    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * every) + 1, n);
    const ax = points[a].t;
    const ay = valueOf(points[a]);

    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const area = Math.abs((ax - avgX) * (valueOf(points[j]) - ay) - (ax - points[j].t) * (avgY - ay)) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }
    sampled.push(points[maxIndex]);
    a = maxIndex;
  }

  sampled.push(points[n - 1]);
  return sampled;
}

/**
 * 时间范围记忆（Grafana 的经验：时间选择器一旦改了就该跨刷新保持）。
 *
 * 存在 localStorage 而不是服务端：这是纯展示偏好，随设备走更合理，
 * 也不该为一个下拉框增加协议字段。
 */
const RANGE_KEY = 'aquapilot.trend.range';
const VALID_RANGES: TrendRange[] = ['all', '6h', '12h', '24h', '72h'];

export function loadRangePreference(): TrendRange {
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    return VALID_RANGES.includes(raw as TrendRange) ? (raw as TrendRange) : 'all';
  } catch {
    return 'all';
  }
}

export function saveRangePreference(range: TrendRange): void {
  try {
    localStorage.setItem(RANGE_KEY, range);
  } catch {
    /* 隐私模式禁用 localStorage：不影响图表本身 */
  }
}

/** 自动 Y 轴上限：数据最大值留 60% 余量，且不低于限值的 1.35 倍 */
export function autoYMax(values: number[], limitMax: number): number {
  const dataMax = values.length > 0 ? Math.max(...values) : 0;
  return Math.max(dataMax * 1.6, limitMax * 1.35, 0.5);
}

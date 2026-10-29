import type { InfluentSample, InfluentSeries } from './influentSeries';

/**
 * 进水数据质量校验。
 *
 * 为什么单独做（对标 wwtw-digital-twin 的 `server/src/ingest/quality.ts`）：
 * 真实水厂导出的数据不是干净的——探头漂移、通讯丢包、人工补录、
 * 单位错填。这些脏数据进模型后不会报错，只会让仿真结果悄悄偏掉，
 * 而操作员完全看不出来。质量校验的价值是**在数据进入模型前把问题显性化**。
 *
 * 检查分四类：
 *   1. 取值范围：超出物理可能（如 COD 3000 mg/L）一定是错的；
 *   2. 突变：单步变化超过阈值，可能是探头跳变或单位错；
 *   3. 卡值：连续多点完全相同，典型是探头冻结（stuck-at）；
 *   4. 缺测：相邻采样间隔远大于中位数，说明有断档。
 *
 * 每条问题都带**严重度**与**样本位置**，而不是只给一个"数据质量差"的结论。
 */

export type QualitySeverity = 'error' | 'warning' | 'info';

export interface QualityIssue {
  severity: QualitySeverity;
  /** 问题类别 */
  code: 'out-of-range' | 'spike' | 'stuck' | 'gap' | 'insufficient';
  /** 指标名（缺测类问题无具体指标） */
  metric?: keyof InfluentSample;
  /** 样本索引 */
  index?: number;
  /** 可读描述 */
  message: string;
  /** 建议动作 */
  action: string;
}

export interface QualityReport {
  /** 0–100；100 表示没有任何问题 */
  score: number;
  /** 能否用于仿真（有 error 级问题则不建议） */
  usable: boolean;
  issues: QualityIssue[];
  /** 分指标统计 */
  perMetric: Record<string, { min: number; max: number; mean: number; missing: number }>;
}

/** 物理可能范围（比引擎夹紧范围略宽：这里判"一定错"，那里判"不可运行"） */
const PLAUSIBLE = {
  flow: { min: 100, max: 8000 },
  cod: { min: 50, max: 2000 },
  nh: { min: 2, max: 200 },
  tp: { min: 0.2, max: 30 },
  ss: { min: 20, max: 1500 },
  temperature: { min: 2, max: 40 },
} as const;

/** 单步相对变化阈值：超过它很可能是探头跳变而非真实工况变化 */
const SPIKE_THRESHOLD: Record<string, number> = {
  flow: 0.5,
  cod: 0.6,
  nh: 0.6,
  tp: 0.6,
  ss: 0.8,
  temperature: 0.15,
};

const METRICS: (keyof typeof PLAUSIBLE)[] = ['flow', 'cod', 'nh', 'tp', 'ss', 'temperature'];

/**
 * 卡值判定的连续点数阈值。
 *
 * 快变量（flow/cod/nh）：12 点（3 小时 @15min）完全相同几乎不可能是真实工况；
 * 慢变量（tp/ss/temperature）：24 点（6 小时）恒定在工程上是正常的。
 */
function stuckThreshold(metric: keyof typeof PLAUSIBLE): number {
  return metric === 'tp' || metric === 'ss' || metric === 'temperature' ? 24 : 12;
}

export function checkQuality(series: InfluentSeries): QualityReport {
  const issues: QualityIssue[] = [];
  const samples = series.samples;

  if (samples.length === 0) {
    return {
      score: 0,
      usable: false,
      issues: [
        {
          severity: 'error',
          code: 'insufficient',
          message: '没有任何数据点',
          action: '检查文件格式：至少需要一列时间与三列水质指标',
        },
      ],
      perMetric: {},
    };
  }

  /**
   * 样本量：少于 24 个点（约 6 小时 @15min）不足以支撑动态仿真。
   * 这不是"数据错误"，而是"样本不足"——降级为 warning 而非 error，
   * 因为恒定工况下 1 个点也能跑稳态。
   */
  if (samples.length < 24) {
    issues.push({
      severity: 'warning',
      code: 'insufficient',
      message: `只有 ${samples.length} 个数据点，动态特征可能不足`,
      action: '建议至少覆盖 24 小时的逐 15 分钟数据',
    });
  }

  const perMetric: QualityReport['perMetric'] = {};

  for (const metric of METRICS) {
    const values = samples.map((s) => s[metric]).filter((v): v is number => Number.isFinite(v));
    if (values.length === 0) continue;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    perMetric[metric] = { min, max, mean, missing: samples.length - values.length };

    // 1) 取值范围
    const range = PLAUSIBLE[metric];
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i][metric];
      if (!Number.isFinite(v)) continue;
      if (v < range.min || v > range.max) {
        issues.push({
          severity: 'error',
          code: 'out-of-range',
          metric,
          index: i,
          message: `${metric} 在第 ${i} 点超出物理可能范围（${v.toFixed(1)}，合理区间 ${range.min}–${range.max}）`,
          action: '检查单位（mg/L 与 g/m³ 混用）或探头量程设置',
        });
        break; // 同一指标只报第一条，避免刷屏
      }
    }

    // 2) 突变
    const threshold = SPIKE_THRESHOLD[metric];
    let spikeReported = false;
    for (let i = 1; i < samples.length && !spikeReported; i++) {
      const prev = samples[i - 1][metric];
      const curr = samples[i][metric];
      if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) continue;
      const change = Math.abs(curr - prev) / Math.abs(prev);
      if (change > threshold) {
        issues.push({
          severity: 'warning',
          code: 'spike',
          metric,
          index: i,
          message: `${metric} 在第 ${i} 点单步变化 ${(change * 100).toFixed(0)}%（阈值 ${(threshold * 100).toFixed(0)}%）`,
          action: '确认是真实工况突变还是探头跳变；必要时平滑或标记为缺测',
        });
        spikeReported = true;
      }
    }

    /**
     * 3) 卡值：连续多点完全相同。
     *
     * 阈值按指标区分，不能一刀切：
     * - 快变量（流量/COD/NH）在 15 分钟粒度上几乎不可能连续 12 点逐位相同，
     *   连续相同基本就是探头冻结；
     * - 慢变量（TP/SS/温度）在恒定工况下确实可以长时间不变，
     *   用同样阈值会产生大量假警报，把真正的冻结淹没。
     */
    const stuckLimit = stuckThreshold(metric);
    let stuckRun = 0;
    for (let i = 1; i < samples.length; i++) {
      // 用相对容差而非严格相等：真实探头冻结通常带末位抖动
      const prev = samples[i - 1][metric];
      const curr = samples[i][metric];
      const same = Number.isFinite(prev) && Number.isFinite(curr) && Math.abs(curr - prev) <= Math.abs(prev) * 1e-9;
      if (same) {
        stuckRun += 1;
        if (stuckRun >= stuckLimit) {
          issues.push({
            severity: 'warning',
            code: 'stuck',
            metric,
            index: i,
            message: `${metric} 从第 ${i - stuckRun} 点起连续 ${stuckRun + 1} 点完全相同`,
            action: '典型是探头冻结（stuck-at）；确认仪表是否在线',
          });
          break;
        }
      } else {
        stuckRun = 0;
      }
    }
  }

  // 4) 采样间隔断档
  if (samples.length >= 3) {
    const gaps = samples.slice(1).map((s, i) => s.minute - samples[i].minute);
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
    if (median > 0) {
      const maxGap = Math.max(...gaps);
      if (maxGap > median * 4) {
        issues.push({
          severity: 'warning',
          code: 'gap',
          message: `存在 ${maxGap.toFixed(0)} 分钟的数据断档（中位间隔 ${median.toFixed(0)} 分钟）`,
          action: '断档期由插值补齐；若断档过长，该段的仿真结论不可信',
        });
      }
    }
  }

  // 评分：error 扣 25，warning 扣 8，info 扣 2；最低 0
  const penalty = issues.reduce((sum, i) => sum + (i.severity === 'error' ? 25 : i.severity === 'warning' ? 8 : 2), 0);
  const score = Math.max(0, 100 - penalty);
  const usable = !issues.some((i) => i.severity === 'error');

  return { score, usable, issues, perMetric };
}

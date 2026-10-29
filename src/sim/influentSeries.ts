/**
 * 进水序列：可加载的真实历史剖面。
 *
 * 为什么需要（竞品对标得出的真实缺口）：
 * bsm2-python 自带 `dyninfluent_bsm2.csv`（609 天、逐 15 分钟的历史进水），
 * QSDsan 有 `DynamicInfluent` 单元把时序数据驱动进流程。AquaPilot 此前
 * 只有「理想化昼夜节律 + 确定性噪声」——同一天永远长得一样，无法回答
 * 「拿上周的真实进水跑一遍会怎样」。
 *
 * 现实意义：真实水厂的进水是**有记忆的**——暴雨后会有延迟的稀释峰、
 * 工业排口有周期性冲击、季节温度有趋势。用正弦 + 白噪声生成不出来这些
 * 结构，而它们恰恰是控制策略最容易失效的地方。
 *
 * 数据来源与格式：
 * - 支持内置 BSM2 官方进水（`src/sim/data/constinfluent_bsm2.csv`，恒定工况）
 * - 支持用户上传 CSV：`minute,flow,cod,nh,tp,ss,temperature`（表头可选）
 * - 缺失列按设计值补齐，越界值夹紧到物理区间并记录告警
 *
 * 设计取舍：
 * - 只做**线性插值**，不做样条：进水数据的采样间隔通常 15 分钟以上，
 *   样条会在缺测处振荡出负浓度。
 * - 超出序列末尾后循环使用（真实部署应替换为持续采集）。
 */

import { INFLUENT_DESIGN } from './config';

export interface InfluentSample {
  minute: number;
  flow: number;
  cod: number;
  nh: number;
  tp: number;
  ss: number;
  temperature: number;
  /** 碱度（可选，缺省按设计值） */
  alkalinity?: number;
}

export interface InfluentSeries {
  name: string;
  samples: InfluentSample[];
  /** 采样总时长（分钟） */
  durationMin: number;
  /** 加载时发现的数据问题 */
  warnings: string[];
}

/** 物理区间：与 deriveInfluent 的 clamp 保持一致，避免两套口径 */
const RANGES = {
  flow: { min: 400, max: 5200 },
  cod: { min: 90, max: 1400 },
  nh: { min: 8, max: 120 },
  tp: { min: 0.8, max: 16 },
  ss: { min: 45, max: 900 },
  temperature: { min: 8, max: 31 },
  alkalinity: { min: 60, max: 380 },
};

/**
 * 物理区间夹紧（只在取样时使用，不用于解析）。
 *
 * 解析保留原值供质量校验判断；取样进引擎前才夹紧，
 * 保证「报告能看到问题」与「引擎拿到安全值」两件事分开。
 */
function clampTo(key: keyof typeof RANGES, v: number): number {
  const r = RANGES[key];
  return Math.min(r.max, Math.max(r.min, v));
}

/**
 * 解析 CSV 文本。
 *
 * 容错原则：能救则救，救不了就跳过该行并记录原因。
 * 拒绝整份文件只适用于「没有一行可用」的情况——现场导出的数据
 * 通常有零星坏行，一票否决会让整个功能不可用。
 */
export function parseInfluentCsv(text: string, name = '自定义进水'): InfluentSeries {
  const warnings: string[] = [];
  const samples: InfluentSample[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) {
    return { name, samples: [], durationMin: 0, warnings: ['文件为空'] };
  }

  // 表头检测：第一列不是数字就当作表头
  let startIndex = 0;
  const firstCell = lines[0].split(',')[0]?.trim() ?? '';
  if (!Number.isFinite(Number(firstCell))) {
    startIndex = 1;
  }

  const skipped: number[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    if (cells.length < 3) {
      skipped.push(i + 1);
      continue;
    }
    const nums = cells.map(Number);
    // 前 7 列：minute, flow, cod, nh, tp, ss, temperature
    const [minute, flow, cod, nh, tp, ss, temperature] = nums;
    if (![minute, flow, cod, nh, tp, ss, temperature].every(Number.isFinite)) {
      skipped.push(i + 1);
      continue;
    }
    /**
     * 保留原始值，不在解析层夹紧。
     *
     * 早期版本在这里就 clamp，导致下游的数据质量校验永远看不到越界值——
     * 一个 99999 m³/h 的错填会被静默改成 5200，质量报告显示「一切正常」。
     * 夹紧的职责属于引擎（保证可运行），质量校验的职责属于数据层
     * （暴露问题）。两层混在一起等于把问题藏起来。
     */
    samples.push({
      minute,
      flow,
      cod,
      nh,
      tp,
      ss,
      temperature,
      alkalinity: Number.isFinite(nums[7]) ? nums[7] : undefined,
    });
  }

  if (skipped.length > 0) {
    warnings.push(
      `${skipped.length} 行无法解析已跳过（行号：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? '…' : ''}）`,
    );
  }
  if (samples.length === 0) {
    warnings.push('没有任何可用数据行');
    return { name, samples: [], durationMin: 0, warnings };
  }

  // 按时间排序：现场导出常按批次拼接，时间未必单调
  samples.sort((a, b) => a.minute - b.minute);

  // 去重：同一分钟保留最后一条（后写的覆盖先写的，符合"修订"语义）
  const deduped: InfluentSample[] = [];
  for (const s of samples) {
    const last = deduped[deduped.length - 1];
    if (last && last.minute === s.minute) deduped[deduped.length - 1] = s;
    else deduped.push(s);
  }
  if (deduped.length !== samples.length) {
    warnings.push(`${samples.length - deduped.length} 条重复时刻的记录已被后写覆盖`);
  }

  // 单调性检查：非单调的相邻点说明时间轴有问题
  for (let i = 1; i < deduped.length; i++) {
    if (deduped[i].minute <= deduped[i - 1].minute) {
      warnings.push('时间轴存在非单调点，插值结果可能不准确');
      break;
    }
  }

  const durationMin = deduped[deduped.length - 1].minute - deduped[0].minute;
  return { name, samples: deduped, durationMin, warnings };
}

/**
 * 在序列上取值（线性插值 + 循环）。
 *
 * 循环语义：超出末尾后从头开始。这样一段 24 小时的真实剖面可以驱动
 * 任意长的仿真，不需要预先生成 609 天数据。
 */
export function sampleAt(series: InfluentSeries, minute: number): InfluentSample {
  const { samples } = series;
  if (samples.length === 0) {
    return {
      minute,
      flow: INFLUENT_DESIGN.flow,
      cod: INFLUENT_DESIGN.cod,
      nh: INFLUENT_DESIGN.nh,
      tp: INFLUENT_DESIGN.tp,
      ss: INFLUENT_DESIGN.ss,
      temperature: INFLUENT_DESIGN.temperature,
      alkalinity: INFLUENT_DESIGN.alkalinity,
    };
  }
  if (samples.length === 1) {
    const only = samples[0];
    // 单点序列同样要夹紧：解析层保留原值，取样层负责安全
    return {
      minute,
      flow: clampTo('flow', only.flow),
      cod: clampTo('cod', only.cod),
      nh: clampTo('nh', only.nh),
      tp: clampTo('tp', only.tp),
      ss: clampTo('ss', only.ss),
      temperature: clampTo('temperature', only.temperature),
      alkalinity: only.alkalinity !== undefined ? clampTo('alkalinity', only.alkalinity) : INFLUENT_DESIGN.alkalinity,
    };
  }

  const start = samples[0].minute;
  const span = samples[samples.length - 1].minute - start;
  // 循环到序列窗口内
  const offset = span > 0 ? (((minute - start) % span) + span) % span : 0;
  const target = start + offset;

  // 二分查找：序列可能有几千点，线性扫描在每 tick 调用时会明显变慢
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].minute <= target) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const denom = b.minute - a.minute;
  const t = denom > 0 ? (target - a.minute) / denom : 0;

  const lerp = (x: number, y: number) => x + (y - x) * t;
  // 取样时夹紧：解析层保留原值供质量校验，引擎只接受物理可能值
  return {
    minute,
    flow: clampTo('flow', lerp(a.flow, b.flow)),
    cod: clampTo('cod', lerp(a.cod, b.cod)),
    nh: clampTo('nh', lerp(a.nh, b.nh)),
    tp: clampTo('tp', lerp(a.tp, b.tp)),
    ss: clampTo('ss', lerp(a.ss, b.ss)),
    temperature: clampTo('temperature', lerp(a.temperature, b.temperature)),
    alkalinity:
      a.alkalinity !== undefined && b.alkalinity !== undefined
        ? lerp(a.alkalinity, b.alkalinity)
        : INFLUENT_DESIGN.alkalinity,
  };
}

/**
 * 由序列导出统计摘要（供界面展示「这段进水有多剧烈」）。
 */
export function seriesStats(series: InfluentSeries): {
  points: number;
  days: number;
  flowMean: number;
  flowPeak: number;
  codMean: number;
  codPeak: number;
  temperatureRange: [number, number];
} | null {
  if (series.samples.length === 0) return null;
  const mean = (pick: (s: InfluentSample) => number) =>
    series.samples.reduce((sum, s) => sum + pick(s), 0) / series.samples.length;
  const peak = (pick: (s: InfluentSample) => number) => Math.max(...series.samples.map(pick));
  const temps = series.samples.map((s) => s.temperature);
  return {
    points: series.samples.length,
    days: series.durationMin / 1440,
    flowMean: mean((s) => s.flow),
    flowPeak: peak((s) => s.flow),
    codMean: mean((s) => s.cod),
    codPeak: peak((s) => s.cod),
    temperatureRange: [Math.min(...temps), Math.max(...temps)],
  };
}

/**
 * 内置：BSM2 官方恒定进水（单点序列）。
 *
 * 用它是为了给「真实数据驱动」提供一个可核对的基准：值来自
 * IWA BSM2 技术报告，与本项目 ASM1 的默认设计值同量级但组分口径不同
 * （BSM2 用 22 列 ASM1 组分，这里只取常规指标）。
 */
export function bsm2ConstantSeries(): InfluentSeries {
  return {
    name: 'BSM2 官方恒定进水',
    samples: [
      {
        minute: 0,
        // BSM2 技术报告：Q=18446 m³/d → 768.6 m³/h；COD、NH 为 ASM1 组分折算
        flow: 768.6,
        cod: 300,
        nh: 31.6,
        tp: 5.2,
        ss: 171,
        temperature: 15,
        alkalinity: 320,
      },
    ],
    durationMin: 0,
    warnings: [],
  };
}

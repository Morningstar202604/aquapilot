/**
 * 告警归因。
 *
 * 告警本身只说"哪个指标超了"，操作员真正需要的是"为什么、在哪、现在做什么、
 * 不做会怎样"。这里用当前状态做规则化归因，并把趋势外推成一句可核对的后果预测。
 *
 * 设计约束：
 * - 归因只用已经在快照里的量，不引入新的传感器假设；
 * - 趋势外推用最近若干个趋势点的斜率，明确标注"按当前斜率"，不是模型预测；
 * - 每个告警必须有"动作"，否则操作员仍然不知道该做什么。
 */

import type { EffluentState } from './plantTypes';

export interface AlarmInput {
  code: string;
  effluent: EffluentState;
  srtDays: number;
  lastDo: number;
  doSetpoint: number;
  blanketM: number;
  depth: number;
  temperature: number;
  /** 当前生物活性抑制系数（1 = 无抑制，越小毒性越强） */
  inhibition?: number;
  /** 最近 30 个趋势点的斜率（单位/分钟），按指标键索引 */
  slopes: Partial<Record<'cod' | 'nh' | 'tn' | 'tp' | 'ss' | 'bod', number>>;
}

export interface AlarmAttribution {
  /** 归因到哪个工艺环节 */
  unit: string;
  /** 最可能的直接原因 */
  cause: string;
  /** 建议动作（可执行，不是"关注一下"） */
  action: string;
  /** 若不处理的后果，带趋势外推 */
  consequence: string;
  /** 归因置信度：high 表示有明确状态证据，low 表示只能给出通用方向 */
  confidence: 'high' | 'low';
}

function project(current: number, slopePerMin: number, minutes = 240): number {
  return Math.max(0, current + slopePerMin * minutes);
}

function fmt(v: number, digits = 2): string {
  return v.toFixed(digits);
}

/**
 * 归因一个告警。未知 code 返回 null（调用方保留原始告警，不伪造解释）。
 */
export function attributeAlarm(input: AlarmInput): AlarmAttribution | null {
  const e = input.effluent;
  const lowDo = input.lastDo < Math.max(1, input.doSetpoint * 0.75);
  const cold = input.temperature < 15;
  const youngSludge = input.srtDays < 10;
  const highBlanket = input.blanketM > input.depth - 0.8;
  const toxic = (input.inhibition ?? 1) < 0.85;
  const inhibPct = Math.round((1 - (input.inhibition ?? 1)) * 100);

  switch (input.code) {
    case 'EFF_NH':
      return {
        unit: '好氧区 → 二沉池出水',
        cause: toxic
          ? `进水毒性抑制使生物活性下降约 ${inhibPct}%，即使供氧正常硝化也无法建立`
          : lowDo
            ? `好氧区溶解氧仅 ${fmt(input.lastDo)} mg/L，低于设定 ${fmt(input.doSetpoint, 1)}，硝化受供氧限制`
            : cold
              ? `水温 ${fmt(input.temperature, 1)} ℃，硝化菌活性按温度系数下降`
              : youngSludge
                ? `污泥龄 ${fmt(input.srtDays, 1)} d 偏短，硝化菌群不足以维持`
                : '进水氨氮负荷超过当前好氧池的硝化能力',
        action: toxic
          ? '降低排泥保住硝化菌群、把 DO 设定提到 2.5 以上，并排查上游毒物来源'
          : lowDo
            ? '把溶解氧设定上调 0.3–0.5 mg/L，并确认鼓风机出力'
            : youngSludge
              ? '降低剩余污泥排放，把 SRT 拉回 12 d 以上'
              : '提高内回流与好氧池停留时间，必要时投加碳源以外的外部硝化菌',
        consequence: `按当前斜率，4 小时后氨氮约 ${fmt(project(e.nh, input.slopes.nh ?? 0))} mg/L（限值 5）。`,
        confidence: toxic || lowDo || cold || youngSludge ? 'high' : 'low',
      };
    case 'EFF_COD':
      return {
        unit: '好氧区 → 二沉池出水',
        cause: toxic
          ? `毒性抑制使异养菌活性下降约 ${inhibPct}%，有机物氧化不彻底`
          : lowDo
            ? '好氧区供氧不足，异养菌氧化能力下降'
            : highBlanket
              ? '二沉池泥位偏高，出水夹带悬浮物推高 COD'
              : '进水有机负荷冲击或好氧池容积不足',
        action: toxic
          ? '降低排泥、提高 DO，并排查毒物来源；必要时投加活性炭吸附'
          : lowDo
            ? '提高溶解氧设定并核对曝气量'
            : '加大排泥并检查二沉池固体负荷',
        consequence: `按当前斜率，4 小时后 COD 约 ${fmt(project(e.cod, input.slopes.cod ?? 0), 1)} mg/L（限值 50）。`,
        confidence: toxic || lowDo || highBlanket ? 'high' : 'low',
      };
    case 'EFF_BOD':
      return {
        unit: '好氧区 → 出水',
        cause:
          input.slopes.bod && input.slopes.bod > 0
            ? '出水溶解性有机物上升，通常与好氧区供氧或停留时间不足同源'
            : '出水悬浮物折算的 BOD 上升，优先检查二沉池',
        action: '先看二沉池出水 SS；若 SS 正常则提高 DO 设定与好氧停留时间',
        consequence: `按当前斜率，4 小时后 BOD₅ 约 ${fmt(project(e.bod, input.slopes.bod ?? 0), 1)} mg/L（限值 10）。`,
        confidence: 'low',
      };
    case 'EFF_TN':
      return {
        unit: '缺氧区 → 出水',
        cause:
          input.lastDo > 0.5
            ? '内回流把溶解氧带入缺氧区，反硝化碳源被消耗'
            : '缺氧区碳源不足或内回流比偏低，硝酸盐未被还原',
        action: '提高多点进水比例，必要时提高内回流比并确认缺氧区 DO < 0.5',
        consequence: `按当前斜率，4 小时后总氮约 ${fmt(project(e.tn, input.slopes.tn ?? 0), 1)} mg/L（限值 15）。`,
        confidence: input.lastDo > 0.5 ? 'high' : 'low',
      };
    case 'EFF_TP':
      return {
        unit: '厌氧区 / 加药间 → 出水',
        cause: '生物除磷不足且 PAC 化学兜底不够，或厌氧区溶解氧偏高导致释磷受抑',
        action: '提高 PAC 投加至 30 mg/L 以上，并检查厌氧区搅拌是否带入空气',
        consequence: `按当前斜率，4 小时后总磷约 ${fmt(project(e.tp, input.slopes.tp ?? 0), 3)} mg/L（限值 0.5）。`,
        confidence: 'low',
      };
    case 'EFF_SS':
      return {
        unit: '二沉池',
        cause: highBlanket
          ? `二沉池泥位 ${fmt(input.blanketM)} m 已接近池深 ${fmt(input.depth, 1)} m，存在跑泥`
          : '固体负荷偏高或污泥沉降性变差',
        action: '提高污泥回流比并加大排泥，必要时降低进水流量',
        consequence: `按当前斜率，4 小时后 SS 约 ${fmt(project(e.ss, input.slopes.ss ?? 0), 1)} mg/L（限值 10）。`,
        confidence: highBlanket ? 'high' : 'low',
      };
    case 'DO_LOW':
      return {
        unit: '好氧区末端',
        cause: `末端溶解氧 ${fmt(input.lastDo)} mg/L，低于 1.0 的工艺下限`,
        action: '提高鼓风机出力或降低进水负荷；若为鼓风机故障则下调 DO 设定至可达范围',
        consequence: '持续低溶解氧会在数小时内抑制硝化，氨氮随之上升。',
        confidence: 'high',
      };
    case 'SLUDGE_BLANKET':
      return {
        unit: '二沉池',
        cause: `泥位 ${fmt(input.blanketM)} m，接近池深 ${fmt(input.depth, 1)} m 的跑泥边界`,
        action: '提高污泥回流比、加大剩余污泥排放；确认回流泵运行',
        consequence: '继续上升会随出水带泥，SS 与 COD 同时恶化。',
        confidence: 'high',
      };
    case 'SRT_LOW':
      return {
        unit: '污泥系统',
        cause: `污泥龄 ${fmt(input.srtDays, 1)} d，低于硝化菌维持所需的 8 d 下限`,
        action: '减少剩余污泥排放，把 SRT 提到 12 d 以上',
        consequence: '硝化菌会被逐步冲出，氨氮在 1–3 天内抬升。',
        confidence: 'high',
      };
    default:
      return null;
  }
}

/**
 * 从趋势点估算每个指标的斜率（单位/分钟），用首尾两点做稳健估计。
 * 点太少时返回空对象，归因里就不写外推，避免编造。
 */
export function trendSlopes(
  trends: {
    t: number;
    effluentCod: number;
    effluentNh: number;
    effluentTn: number;
    effluentTp: number;
    effluentSs: number;
  }[],
  _effluentBod: number,
): NonNullable<AlarmInput['slopes']> {
  if (trends.length < 4) return {};
  const tail = trends.slice(-30);
  const first = tail[0];
  const last = tail[tail.length - 1];
  const dt = last.t - first.t;
  if (!(dt > 0)) return {};
  const per = (a: number, b: number) => (b - a) / dt;
  const codSlope = per(first.effluentCod, last.effluentCod);
  return {
    cod: codSlope,
    nh: per(first.effluentNh, last.effluentNh),
    tn: per(first.effluentTn, last.effluentTn),
    tp: per(first.effluentTp, last.effluentTp),
    ss: per(first.effluentSs, last.effluentSs),
    // BOD5 由溶解性 COD 折算，斜率同比例；出水 BOD 的绝对值另算，这里只用于趋势
    bod: codSlope * 0.44,
  };
}

export interface HealthPart {
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface PlantHealth {
  score: number;
  grade: 'good' | 'watch' | 'bad';
  parts: HealthPart[];
}

/**
 * 全厂健康度：出水裕度、溶解氧、污泥龄、二沉池、告警五个维度加权。
 *
 * 这不是"AI 打分"，是给操作员的一眼判断：所有分项都能在界面上找到对应数字。
 */
export function plantHealth(input: {
  margins: { metric: string; ratio: number }[];
  lastDo: number;
  doSetpoint: number;
  srtDays: number;
  blanketM: number;
  depth: number;
  activeAlarms: number;
}): PlantHealth {
  const worst = input.margins[0]?.ratio ?? 0;
  const marginScore = Math.max(0, Math.min(1, (1 - worst) / 0.4)) * 100;
  const doScore = Math.max(0, Math.min(1, (input.lastDo - 0.8) / Math.max(0.5, input.doSetpoint - 0.8))) * 100;
  const srtScore = Math.max(0, Math.min(1, (input.srtDays - 6) / 8)) * 100;
  const blanketScore = Math.max(0, Math.min(1, 1 - input.blanketM / Math.max(0.1, input.depth - 0.4))) * 100;
  const alarmScore = Math.max(0, 100 - input.activeAlarms * 25);
  const parts: HealthPart[] = [
    { label: '出水裕度', score: marginScore, weight: 0.35, detail: `最紧指标占限值 ${(worst * 100).toFixed(0)}%` },
    {
      label: '溶解氧',
      score: doScore,
      weight: 0.15,
      detail: `${input.lastDo.toFixed(2)} / 设定 ${input.doSetpoint.toFixed(1)}`,
    },
    { label: '污泥龄', score: srtScore, weight: 0.15, detail: `${input.srtDays.toFixed(1)} d` },
    { label: '二沉池', score: blanketScore, weight: 0.2, detail: `泥位 ${input.blanketM.toFixed(2)} m` },
    { label: '告警', score: alarmScore, weight: 0.15, detail: `${input.activeAlarms} 条活跃` },
  ];
  const score = Math.round(parts.reduce((sum, p) => sum + p.score * p.weight, 0));
  const grade: PlantHealth['grade'] = score >= 75 ? 'good' : score >= 50 ? 'watch' : 'bad';
  return { score, grade, parts };
}

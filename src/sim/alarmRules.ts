import { LIMITS } from './config';
import type { Alarm, EffluentState } from './plantTypes';

/**
 * 活跃告警的唯一定义（纯函数）。
 *
 * 之前有两份几乎一样的实现：
 * - `sim/networkEngine.raiseLimitAlarms` 把告警推进历史数组（带 45 分钟去重）；
 * - `server/index.currentAlarms` 每次快照重算一遍"当前活跃"。
 *
 * 两份的阈值一开始相同，随后开始漂移（一个用「超限」，一个用「低于下限」，
 * 一条多了 SRT、一条没有），而且服务端那份每次都重新拼字符串。
 * 现在只保留一个定义：输入状态，输出活跃告警；历史数组由它派生。
 */

export interface AlarmRuleInput {
  effluent: EffluentState;
  /** 末端反应器溶解氧（mg/L） */
  lastDo: number;
  srtDays: number;
  blanketM: number;
  depth: number;
  /** 生成 id 与 at 用；不传时用 0 */
  atMin?: number;
}

export interface AlarmRule {
  code: string;
  severity: Alarm['severity'];
  message: (input: AlarmRuleInput) => string;
  metric: string;
  value: (input: AlarmRuleInput) => number;
  /** 触发条件；返回 true 表示告警成立 */
  active: (input: AlarmRuleInput) => boolean;
}

/** 二沉池泥位距离池底的报警余量（m） */
export const BLANKET_MARGIN_M = 0.4;
/** 好氧区溶解氧下限（mg/L） */
export const DO_FLOOR_MG_L = 1;
/** 污泥龄下限（d） */
export const SRT_FLOOR_D = 8;

export const ALARM_RULES: AlarmRule[] = [
  {
    code: 'EFF_NH',
    severity: 'critical',
    metric: 'nh',
    message: (i) => `出水氨氮 ${i.effluent.nh.toFixed(2)} mg/L 超一级A（限值 ${LIMITS.nh}）`,
    value: (i) => i.effluent.nh,
    active: (i) => i.effluent.nh > LIMITS.nh,
  },
  {
    code: 'EFF_COD',
    severity: 'critical',
    metric: 'cod',
    message: (i) => `出水 COD ${i.effluent.cod.toFixed(1)} mg/L 超一级A（限值 ${LIMITS.cod}）`,
    value: (i) => i.effluent.cod,
    active: (i) => i.effluent.cod > LIMITS.cod,
  },
  {
    code: 'EFF_BOD',
    severity: 'warning',
    metric: 'bod',
    message: (i) => `出水 BOD₅ ${i.effluent.bod.toFixed(1)} mg/L 超一级A（限值 ${LIMITS.bod}）`,
    value: (i) => i.effluent.bod,
    active: (i) => i.effluent.bod > LIMITS.bod,
  },
  {
    code: 'EFF_TN',
    severity: 'warning',
    metric: 'tn',
    message: (i) => `出水总氮 ${i.effluent.tn.toFixed(1)} mg/L 超一级A（限值 ${LIMITS.tn}）`,
    value: (i) => i.effluent.tn,
    active: (i) => i.effluent.tn > LIMITS.tn,
  },
  {
    code: 'EFF_TP',
    severity: 'warning',
    metric: 'tp',
    message: (i) => `出水总磷 ${i.effluent.tp.toFixed(3)} mg/L 超一级A（限值 ${LIMITS.tp}）`,
    value: (i) => i.effluent.tp,
    active: (i) => i.effluent.tp > LIMITS.tp,
  },
  {
    code: 'EFF_SS',
    severity: 'warning',
    metric: 'ss',
    message: (i) => `出水悬浮物 ${i.effluent.ss.toFixed(1)} mg/L 超一级A（限值 ${LIMITS.ss}）`,
    value: (i) => i.effluent.ss,
    active: (i) => i.effluent.ss > LIMITS.ss,
  },
  {
    code: 'DO_LOW',
    severity: 'warning',
    metric: 'do',
    message: (i) => `好氧区溶解氧 ${i.lastDo.toFixed(2)} mg/L 低于下限 ${DO_FLOOR_MG_L}`,
    value: (i) => i.lastDo,
    active: (i) => i.lastDo < DO_FLOOR_MG_L,
  },
  {
    code: 'SLUDGE_BLANKET',
    severity: 'critical',
    metric: 'blanket',
    message: (i) => `二沉池泥位 ${i.blanketM.toFixed(2)} m 接近跑泥（池深 ${i.depth.toFixed(1)} m）`,
    value: (i) => i.blanketM,
    active: (i) => i.blanketM > i.depth - BLANKET_MARGIN_M,
  },
  {
    code: 'SRT_LOW',
    severity: 'warning',
    metric: 'srt',
    message: (i) => `污泥龄 ${i.srtDays.toFixed(1)} d 偏低（下限 ${SRT_FLOOR_D} d）`,
    value: (i) => i.srtDays,
    active: (i) => i.srtDays < SRT_FLOOR_D,
  },
];

/** 当前成立的全部告警（不含历史、不含去重） */
export function evaluateAlarms(input: AlarmRuleInput): Alarm[] {
  const at = input.atMin ?? 0;
  const out: Alarm[] = [];
  for (const rule of ALARM_RULES) {
    if (!rule.active(input)) continue;
    out.push({
      id: `LIVE-${rule.code}`,
      at,
      severity: rule.severity,
      code: rule.code,
      message: rule.message(input),
      metric: rule.metric,
      value: rule.value(input),
    });
  }
  return out;
}

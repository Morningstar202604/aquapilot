import { LIMITS } from './config';
import type { DischargeStandard } from './standards';
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
  /** 判读口径；缺省一级 A。告警文案里的标准名与阈值都从它取 */
  standard?: DischargeStandard;
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

function limitsOf(input: AlarmRuleInput) {
  return input.standard?.limits ?? LIMITS;
}

/** 告警文案用短名，避免每条都重复「GB 18918-2002」 */
function labelOf(input: AlarmRuleInput): string {
  return (input.standard?.label ?? 'GB 18918-2002 一级 A').replace(/^GB 18918-2002 /, '');
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
    message: (i) => `出水氨氮 ${i.effluent.nh.toFixed(2)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).nh}）`,
    value: (i) => i.effluent.nh,
    active: (i) => i.effluent.nh > limitsOf(i).nh,
  },
  {
    code: 'EFF_COD',
    severity: 'critical',
    metric: 'cod',
    message: (i) => `出水 COD ${i.effluent.cod.toFixed(1)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).cod}）`,
    value: (i) => i.effluent.cod,
    active: (i) => i.effluent.cod > limitsOf(i).cod,
  },
  {
    code: 'EFF_BOD',
    severity: 'warning',
    metric: 'bod',
    message: (i) => `出水 BOD₅ ${i.effluent.bod.toFixed(1)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).bod}）`,
    value: (i) => i.effluent.bod,
    active: (i) => i.effluent.bod > limitsOf(i).bod,
  },
  {
    code: 'EFF_TN',
    severity: 'warning',
    metric: 'tn',
    message: (i) => `出水总氮 ${i.effluent.tn.toFixed(1)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).tn}）`,
    value: (i) => i.effluent.tn,
    active: (i) => i.effluent.tn > limitsOf(i).tn,
  },
  {
    code: 'EFF_TP',
    severity: 'warning',
    metric: 'tp',
    message: (i) => `出水总磷 ${i.effluent.tp.toFixed(3)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).tp}）`,
    value: (i) => i.effluent.tp,
    active: (i) => i.effluent.tp > limitsOf(i).tp,
  },
  {
    code: 'EFF_SS',
    severity: 'warning',
    metric: 'ss',
    message: (i) => `出水悬浮物 ${i.effluent.ss.toFixed(1)} mg/L 超${labelOf(i)}（限值 ${limitsOf(i).ss}）`,
    value: (i) => i.effluent.ss,
    active: (i) => i.effluent.ss > limitsOf(i).ss,
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
export function evaluateAlarms(input: AlarmRuleInput, standard?: DischargeStandard): Alarm[] {
  const scoped = standard ? { ...input, standard } : input;
  const at = input.atMin ?? 0;
  const out: Alarm[] = [];
  for (const rule of ALARM_RULES) {
    if (!rule.active(scoped)) continue;
    out.push({
      id: `LIVE-${rule.code}`,
      at,
      severity: rule.severity,
      code: rule.code,
      message: rule.message(scoped),
      metric: rule.metric,
      value: rule.value(scoped),
    });
  }
  return out;
}

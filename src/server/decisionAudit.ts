/**
 * 决策审计去重。
 *
 * 结构性风险（例如二沉池面积不足）会让 AI 每个决策周期都得出同一条
 * `critical + hold`：控制量没有变化、摘要一字不差，但 30 天能写 2,880 行
 * 审计。值班员翻历史时看到的全是同一条，真正的新决策被埋掉。
 *
 * 规则：同一条指纹（动作 + 风险等级 + 摘要）在一个仿真小时内只落一次；
 * 人工强制刷新（force）不受限，因为那是用户主动要求留痕。
 */
import type { Recommendation } from '../shared/aiTypes';

export interface DecisionAuditMark {
  /** 上次落库的决策指纹 */
  key: string;
  /** 上次落库的仿真时刻（分钟） */
  atMin: number;
}

/** 去重窗口：一个仿真小时 */
export const DECISION_AUDIT_WINDOW_MIN = 60;

export function decisionFingerprint(rec: Pick<Recommendation, 'action' | 'severity' | 'summary'>): string {
  return `${rec.action}|${rec.severity}|${rec.summary}`;
}

export function shouldRecordDecision(
  last: DecisionAuditMark | null,
  rec: Pick<Recommendation, 'action' | 'severity' | 'summary'>,
  atMin: number,
  options: { force?: boolean; windowMin?: number } = {},
): boolean {
  if (options.force) return true;
  const windowMin = options.windowMin ?? DECISION_AUDIT_WINDOW_MIN;
  const key = decisionFingerprint(rec);
  if (!last) return true;
  if (last.key !== key) return true;
  return atMin - last.atMin >= windowMin;
}

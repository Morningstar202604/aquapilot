/**
 * AI 决策节拍。
 *
 * 旧实现用「advance() 调用次数 % 30」触发决策：
 * - 决策间隔随倍速变化：1× 是 60 仿真分钟，4× 变成 240 分钟；
 * - 与界面写的「每 15 分钟仿真时间」不符，倍速越高越迟钝。
 *
 * 正确口径是仿真时间：距上次决策满 15 仿真分钟就触发一次，
 * 与 wall-clock 和倍速都无关。这里做成纯函数以便单测。
 */

export const AI_DECISION_INTERVAL_MIN = 15;

export function aiCycleDue(lastDecisionAtMin: number, nowMin: number, interval = AI_DECISION_INTERVAL_MIN): boolean {
  if (!Number.isFinite(lastDecisionAtMin) || !Number.isFinite(nowMin)) return false;
  if (nowMin < lastDecisionAtMin) return true; // 仿真重置：时钟回退，立即重算一次
  return nowMin - lastDecisionAtMin >= interval;
}

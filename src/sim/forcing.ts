import type { ControlSettings } from './config';
import type { ScenarioSpec } from './scenarios';

/**
 * 外部强迫（进水节律、季节性水温、事故包络）与由此派生的运行因子。
 *
 * 这些函数有两个消费者：生产引擎与预测克隆。它们必须是纯函数，
 * 否则预测与实时仿真会走出两条不同的曲线——"预测说没事，实际却超标"
 * 正是这类漂移的典型后果。
 */

export function diurnal(timeMin: number): number {
  const h = (timeMin / 60) % 24;
  return 0.78 + 0.3 * Math.exp(-(((h - 10) / 3.6) ** 2)) + 0.26 * Math.exp(-(((h - 20) / 3.2) ** 2));
}

/** 季节性水温：年周期正弦，1 月最低、7 月最高（±3.6 ℃） */
export function seasonalTemperature(timeMin: number): number {
  return 19.5 + 3.6 * Math.sin((2 * Math.PI * (timeMin / 1440 - 60)) / 365);
}

/** 事故包络：带进出斜坡的 0–1 强度，不同事故的斜坡时长不同 */
export function scenarioEnvelope(spec: ScenarioSpec | null, timeMin: number): number {
  if (!spec) return 0;
  const elapsed = timeMin - spec.startedAt;
  if (elapsed < 0 || elapsed > spec.durationMin) return 0;
  const rampIn = spec.type === 'storm' ? 20 : spec.type === 'power_outage' ? 1 : 8;
  const rampOut = spec.type === 'storm' ? 80 : spec.type === 'power_outage' ? 2 : 30;
  if (elapsed < rampIn) return elapsed / rampIn;
  if (spec.durationMin - elapsed < rampOut) return Math.max(0, (spec.durationMin - elapsed) / rampOut);
  return 1;
}

/** 毒性抑制系数：1 = 无抑制，越小越毒；自养菌比异养菌更敏感（见 reactionRatesWithSuppression） */
export function toxicSuppression(spec: ScenarioSpec | null, timeMin: number): number {
  if (!spec || spec.type !== 'toxic') return 1;
  const env = scenarioEnvelope(spec, timeMin);
  return 1 - env * Math.min(0.85, Math.max(0, 0.45 + 0.3 * spec.magnitude));
}

/**
 * 曝气能力系数（0–1）。
 *
 * `blower_failure.magnitude` 的语义是「故障期间**剩余**供气能力」，不是严重度：
 * 0.5 = 降到一半，1 = 没有故障。
 *
 * 两个必须夹紧的理由：
 * 1. 协议允许 magnitude 0–30（为暴雨/冲击负荷这类"倍数"语义预留），
 *    直接代入会把 capacity 放大到 1 + 29×env ≈ 30，即 3000% 供氧；
 * 2. 负值会让 capacity < 0，下游 `capacity > 0.02` 的分支会走到"不曝气"，
 *    语义正确但数值仍应停在 0 而不是负数（便于界面显示）。
 */
export function aerationCapacityOf(spec: ScenarioSpec | null, timeMin: number): number {
  if (!spec) return 1;
  const env = scenarioEnvelope(spec, timeMin);
  if (spec.type === 'blower_failure') {
    // NaN 不是合法强度：按默认 0.5 处理，而不是让整个曝气系数变 NaN
    const raw = Number.isFinite(spec.magnitude) ? spec.magnitude : 0.5;
    const remaining = Math.min(1, Math.max(0, raw));
    return Math.min(1, Math.max(0, 1 - env * (1 - remaining)));
  }
  if (spec.type === 'power_outage') return Math.min(1, Math.max(0, 1 - env));
  return 1;
}

/** 回流比：事故会直接压掉 RAS/IR/WAS（停电）或单独压掉 RAS */
export function recycleFactors(
  controls: Pick<ControlSettings, 'rasRatio' | 'internalRecirc' | 'wasRatio'>,
  spec: ScenarioSpec | null,
  timeMin: number,
): { ras: number; ir: number; was: number } {
  let { rasRatio: ras, internalRecirc: ir, wasRatio: was } = controls;
  if (spec) {
    const env = scenarioEnvelope(spec, timeMin);
    if (spec.type === 'ras_failure') ras *= 1 - env;
    if (spec.type === 'power_outage') {
      ir = 0;
      ras *= 1 - env;
      was *= 1 - env;
    }
  }
  return { ras, ir, was };
}

/** 流量加权混合；两条流都为零时保留左侧浓度 */
export function mixed(cA: number, qA: number, cB: number, qB: number): number {
  const q = qA + qB;
  return q > 0 ? (cA * qA + cB * qB) / q : cA;
}

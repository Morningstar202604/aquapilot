import { CONTROL_BOUNDS, type ControlSettings } from '../sim/config';
import { CONTROL_KEYS, clampControlMoves, type AgentConfig } from '../shared/agentConfig';

/**
 * AI 决策的护栏后处理。
 *
 * 为什么单独成模块：这段逻辑是「AI 想做什么」与「系统允许它做什么」之间的
 * 唯一收敛点，出错的表现是**静默的**——日志照写、提示照发，但控制量没动。
 * 放在 index.ts 里只能靠整机集成测试覆盖，抽出来才能逐条断言。
 */

/** 决策动作：保持 / 微调 / 应急 */
export type GuardedAction = 'hold' | 'adjust' | 'emergency';

/**
 * 与 `shared/protocol` 的 Recommendation 保持结构兼容的最小形状。
 *
 * 不直接 import Recommendation：那个类型带着 forecast/alternatives 等
 * 一大堆与本模块无关的字段，耦合进来只会让测试要为它们造数据。
 */
export interface GuardableRecommendation {
  action: GuardedAction;
  summary: string;
  severity: 'normal' | 'watch' | 'critical';
  tweaks: { key: string; from: number; to: number; reason: string }[];
  chosens: { controls: ControlSettings };
}

export interface GuardResult<T extends GuardableRecommendation> {
  /** 施加约束后的建议（可能已被降级为 hold） */
  recommendation: T;
  /** 实际发生了多少项控制量变化 */
  movedKeys: (keyof Omit<ControlSettings, 'aiEnabled'>)[];
  /** 是否因护栏导致「想调但调不动」而被降级 */
  degradedByGuard: boolean;
}

/**
 * 应用 Agent 约束并把「空动作」降级为 hold。
 *
 * 处理三件事，顺序不能换：
 *
 * 1. **白名单**：`allowedControls` 之外的控制量强制保持当前值。
 * 2. **单步限幅**：`maxStepPct` 限制每个控制量一轮最多走多少量程。
 * 3. **空动作降级**：1、2 之后如果一步都没动，动作必须从 adjust/emergency
 *    降为 hold，摘要改写为「被护栏挡住」。
 *
 * 第 3 步是关键。没有它就会出现这种日志：
 *
 *     AI 已执行：预测到 出水超标风险，立即执行应急调节：
 *
 * 摘要末尾是空的（tweaks 被夹没了），但 `action` 仍是 emergency，
 * 于是每 65 秒重复广播一次，操作员看到的是「AI 在不停执行」，
 * 实际控制量一次都没变。这是「假动作」——比不动作更危险，
 * 因为它会让人以为风险已被处理。
 *
 * 注意：降级只改 `action`/`summary`/`tweaks`，**不改 `severity`**。
 * 风险等级必须如实保留，否则告警会被一起吞掉。
 */
export function applyGuards<T extends GuardableRecommendation>(
  recommendation: T,
  currentControls: ControlSettings,
  constraints: AgentConfig['constraints'],
): GuardResult<T> {
  const next = {
    ...recommendation,
    chosens: { ...recommendation.chosens, controls: { ...recommendation.chosens.controls } },
  } as T;

  // 1. 白名单
  for (const key of CONTROL_KEYS) {
    if (!constraints.allowedControls.includes(key)) {
      (next.chosens.controls[key] as number) = currentControls[key] as number;
    }
  }

  // 2. 单步限幅
  next.chosens.controls = clampControlMoves(currentControls, next.chosens.controls, constraints.maxStepPct);
  next.chosens.controls.aiEnabled = currentControls.aiEnabled;

  // 3. 空动作降级
  const movedKeys = CONTROL_KEYS.filter((key) => {
    const delta = (next.chosens.controls[key] as number) - (currentControls[key] as number);
    return Number.isFinite(delta) && Math.abs(delta) > 1e-9;
  });

  if (movedKeys.length === 0 && next.action !== 'hold') {
    const blockedBy = constraints.requireHumanApproval
      ? '当前为人工确认模式'
      : `单步限幅 ${constraints.maxStepPct}% 或允许调整项受限`;
    const riskWord = next.severity === 'critical' ? '超标' : '逼近限值';
    next.action = 'hold';
    next.summary = `预测存在${riskWord}风险，但本轮无可执行的调节（${blockedBy}）。风险仍在，请人工确认或放宽护栏。`;
    next.tweaks = [];
    next.chosens.controls = { ...currentControls };
    return { recommendation: next, movedKeys, degradedByGuard: true };
  }

  return { recommendation: next, movedKeys, degradedByGuard: false };
}

/** 供界面显示「这轮实际动了哪些量」——空数组即「只建议、未动作」 */
export function describeMoves(
  movedKeys: (keyof Omit<ControlSettings, 'aiEnabled'>)[],
  from: ControlSettings,
  to: ControlSettings,
): string[] {
  return movedKeys.map((key) => {
    const bounds = CONTROL_BOUNDS[key];
    return `${bounds.label} ${(from[key] as number).toFixed(bounds.precision)}→${(to[key] as number).toFixed(bounds.precision)}`;
  });
}

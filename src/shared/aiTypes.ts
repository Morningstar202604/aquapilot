/**
 * AI 决策与回答的共享类型。
 *
 * 放在 shared 而不是 ai/agent：协议层、服务端处理器和客户端都要用这些结构。
 * 之前 protocol.ts 反过来 import ai/agent，形成「协议 → 实现」的反向依赖；
 * 类型单独成文件后，shared 不再依赖 AI 模块。
 */

import type { ControlSettings, ControlKey } from '../sim/config';
import type { EffluentState } from '../sim/plantTypes';
import type { EnsembleForecast } from '../sim/ensemble';

export interface ScoredCandidate extends DecisionCandidate {
  predictedEffluent: EffluentState;
  endSrt: number;
  endBlanket: number;
}

export interface DecisionCandidate {
  label: string;
  /** 模型输出非有限（NaN/Inf）时标记；这类候选不参与排序，也不得被执行 */
  invalid?: boolean;
  controls: ControlSettings;
  score: number;
  violations: number;
  worstRatio: number;
  cost: number;
  energyPeak: number;
  quality: number;
  /** 参数扰动样本中出现超标的比例；未评估时为 null */
  exceedanceProbability: number | null;
}

export interface Recommendation {
  action: 'hold' | 'adjust' | 'emergency';
  severity: 'normal' | 'watch' | 'critical';
  summary: string;
  rationale: string[];
  chosens: DecisionCandidate;
  alternatives: DecisionCandidate[];
  predictedEffluent: EffluentState;
  predictedScore: number;
  horizonMin: number;
  /** 候选区分度 0–1（启发式，非概率） */
  separation: number;
  risks: string[];
  tweaks: { key: ControlKey; from: number; to: number; reason: string }[];
  generatedAt: number;
  /**
   * 选中方案的集合预测（P10/P50/P90）与超限概率。
   * 未启用鲁棒评估时为 null——界面必须显示"未评估"，不能显示 0%。
   */
  ensemble: EnsembleForecast | null;
  /** 本次决策是否真的跑了扰动样本 */
  robustEvaluated: boolean;
}

export interface Answer {
  title: string;
  body: string;
  bullets: string[];
  confidence: number;
  kind: 'status' | 'why' | 'whatif' | 'plan' | 'explain' | 'editor' | 'unknown';
  /** 回答来源：规则引擎或 LLM（失败降级时仍为 rule） */
  source?: 'rule' | 'llm';
  /** 生成该回答的 AI 角色名（来自 Agent 配置） */
  persona?: string;
  /** 本轮命中的技能名 */
  matchedSkills?: string[];
}

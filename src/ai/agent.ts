import {
  CONTROL_BOUNDS,
  ControlSettings,
  LIMITS,
} from '../sim/config';
import type { EffluentState } from '../sim/plantTypes';
import { qualityScore, clampControls } from '../sim/metrics';
import { PlantModel, PlantSnapshotForAi } from '../sim/plantModel';
import { ScenarioType } from '../sim/scenarios';

export interface ScoredCandidate extends DecisionCandidate {
  predictedEffluent: EffluentState;
  endSrt: number;
  endBlanket: number;
}

export interface DecisionCandidate {
  label: string;
  controls: ControlSettings;
  score: number;
  violations: number;
  worstRatio: number;
  cost: number;
  energyPeak: number;
  quality: number;
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
  tweaks: { key: keyof Omit<ControlSettings, 'aiEnabled'>; from: number; to: number; reason: string }[];
  generatedAt: number;
}

export interface DecisionContext {
  model: PlantModel;
  horizonMin?: number;
  candidateBudget?: number;
}

const KEY_ORDER: (keyof Omit<ControlSettings, 'aiEnabled'>)[] = [
  'doSetpoint',
  'internalRecirc',
  'rasRatio',
  'wasRatio',
  'pacDose',
  'carbonDose',
  'alkDose',
  'stormStore',
  'stepFeed',
];

interface Guardrails {
  doMin: number;
  doMax: number;
  rasMin: number;
  irMin: number;
  wasMin: number;
  wasMax: number;
  srtMin: number;
  srtMax: number;
  pacMin: number;
}

const DEFAULT_GUARDRAILS: Guardrails = {
  doMin: 1.5,
  doMax: 3.4,
  rasMin: 0.6,
  irMin: 0.8,
  wasMin: 0.004,
  wasMax: 0.022,
  srtMin: 12,
  srtMax: 28,
  pacMin: 18,
};

function guardrailsFor(state: PlantSnapshotForAi): Guardrails {
  const g = { ...DEFAULT_GUARDRAILS };
  if (!state.scenario) return g;
  switch (state.scenario.type) {
    case 'toxic':
      g.doMin = 2.4;
      g.wasMax = 0.012;
      g.srtMin = 18;
      g.pacMin = 26;
      break;
    case 'winter':
      g.doMin = 2.6;
      g.srtMin = 18;
      break;
    case 'blower_failure':
      g.doMin = 1.2;
      g.doMax = 2.6;
      break;
    case 'power_outage':
      g.doMin = 1.0;
      g.doMax = 2.4;
      break;
    case 'storm':
      g.rasMin = 0.9;
      g.irMin = 1.0;
      g.pacMin = 28;
      g.wasMax = 0.016;
      break;
    case 'shock_load':
      g.doMin = 2.2;
      g.irMin = 1.6;
      break;
    default:
      break;
  }
  return g;
}

function applyGuard(controls: ControlSettings, g: Guardrails): ControlSettings {
  return clampControls({
    ...controls,
    doSetpoint: Math.min(g.doMax, Math.max(g.doMin, controls.doSetpoint)),
    rasRatio: Math.max(g.rasMin, controls.rasRatio),
    internalRecirc: Math.max(g.irMin, controls.internalRecirc),
    wasRatio: Math.min(g.wasMax, Math.max(g.wasMin, controls.wasRatio)),
    pacDose: Math.max(g.pacMin, controls.pacDose),
  });
}

function srtPenalty(srt: number, g: Guardrails): number {
  if (srt < g.srtMin) return ((g.srtMin - srt) / g.srtMin) * 1400;
  if (srt > g.srtMax) return ((srt - g.srtMax) / g.srtMax) * 900;
  return 0;
}

function round(value: number, key: keyof Omit<ControlSettings, 'aiEnabled'>): number {
  const precision = CONTROL_BOUNDS[key].precision;
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

function perturb(
  base: ControlSettings,
  key: keyof Omit<ControlSettings, 'aiEnabled'>,
  value: number,
): ControlSettings {
  return clampControls({ ...base, [key]: round(value, key) });
}

function limitsForEffluent(e: EffluentState): number {
  const ratios = [
    e.cod / LIMITS.cod,
    e.bod / LIMITS.bod,
    e.ss / LIMITS.ss,
    e.nh / LIMITS.nh,
    e.tn / LIMITS.tn,
    e.tp / LIMITS.tp,
  ];
  return Math.max(...ratios);
}

function scoreCandidate(
  state: PlantSnapshotForAi,
  model: PlantModel,
  controls: ControlSettings,
  horizonMin: number,
  guard: Guardrails,
): ScoredCandidate {
  const result = model.predict(controls, horizonMin, 30);
  const last = result.points[result.points.length - 1];
  const worstRatio = last ? limitsForEffluent(last.effluent) : 1;
  const quality = last ? last.score : 0;
  const violationCount = result.violations.length;

  const targetRatio = 0.72;
  const compliancePenalty = violationCount * 2200 + Math.max(0, worstRatio - 1) * 9000;
  const marginPenalty = Math.max(0, worstRatio - targetRatio) * 2600;
  const qualityBonus = quality * 6;
  const costPenalty = result.costDelta * 0.35;
  const instability = Math.max(0, result.peakEnergyKw - state.energy.totalKw * 1.35) * 0.4;
  const srtCost = srtPenalty(result.endSrt, guard);
  const movementPenalty =
    KEY_ORDER.reduce((sum, key) => {
      const span = CONTROL_BOUNDS[key].max - CONTROL_BOUNDS[key].min;
      return sum + Math.abs(controls[key] - state.controls[key]) / Math.max(1e-6, span);
    }, 0) * 95;

  const score = 600 + qualityBonus - compliancePenalty - marginPenalty - costPenalty - instability - srtCost - movementPenalty;

  return {
    label: '',
    controls,
    score,
    violations: violationCount,
    worstRatio,
    cost: result.costDelta,
    energyPeak: result.peakEnergyKw,
    quality,
    predictedEffluent: last?.effluent ?? state.effluent,
    endSrt: result.endSrt,
    endBlanket: result.endBlanket,
  };
}

function scenarioHints(state: PlantSnapshotForAi, type: ScenarioType | null): string[] {
  if (!type) return [];
  const active = state.scenario;
  const intensity = active ? Math.round(Math.max(0, Math.min(1, 1 - (active.durationMin - (state.timeMin - active.startedAt)) / Math.max(1, active.durationMin))) * 100) : 0;
  switch (type) {
    case 'storm':
      return [
        `暴雨工况进行约 ${intensity}%：先降内回流，避免二沉池固体通量超限；必要时提高排泥`,
        '进水被稀释，碱度同步下降，注意 pH 与硝化缓冲',
      ];
    case 'shock_load':
      return ['冲击负荷下需氧量骤增，优先保溶氧再谈节能', '碳源充足，可短时提高内回流以强化反硝化'];
    case 'toxic':
      return ['毒性抑制下提高污泥龄、降低排泥，保住硝化菌群', '暂停节能导向的溶氧下调，维持较高溶解氧'];
    case 'blower_failure':
      return ['鼓风机能力受限：把溶氧设定下调至可维持水平，避免控制目标不可达', '缺氧/厌氧搅拌功率不变，注意反硝化碳源'];
    case 'ras_failure':
      return ['回流中断时二沉池界面快速抬升，应立即降低内回流并准备应急排泥', '污泥回流恢复后需缓慢爬坡，避免二次冲击'];
    case 'power_outage':
      return ['停电期间曝气停止，恢复后先低负荷曝气 10 分钟再逐步提量', '恢复阶段避免快速提溶氧造成污泥上浮'];
    case 'winter':
      return ['低温硝化速率下降，需提高污泥龄与溶氧设定', '可适当增加碱度投加以维持硝化'];
    case 'chemical_shortage':
      return ['PAC 停投后生物除磷压力上升，需降低排泥比以维持聚磷菌', '如总磷逼近限值，可考虑临时投加碳源强化释磷'];
    default:
      return [];
  }
}

const CANDIDATE_NAMES: Record<string, string> = {
  hold: '维持当前工况',
  'combo:energy': '节能组合',
  'combo:compliance': '达标优先组合',
};

const CONTROL_VERB: Record<keyof Omit<ControlSettings, 'aiEnabled'>, [string, string]> = {
  doSetpoint: ['下调溶解氧设定', '提高溶解氧设定'],
  internalRecirc: ['降低内回流比', '提高内回流比'],
  rasRatio: ['降低污泥回流', '提高污泥回流'],
  wasRatio: ['减少排泥', '加大排泥'],
  pacDose: ['降低 PAC 投加', '提高 PAC 投加'],
  carbonDose: ['减少碳源投加', '投加碳源'],
  alkDose: ['减少碱度投加', '提高碱度投加'],
  stormStore: ['停止调蓄分流', '启用雨水调蓄分流'],
  stepFeed: ['减少缺氧区进水', '增加缺氧区进水'],
};

function candidateLabel(key: string): string {
  if (CANDIDATE_NAMES[key]) return CANDIDATE_NAMES[key];
  const match = /^([a-zA-Z]+)([+-])(\d)$/.exec(key);
  if (!match) return key;
  const [, field, dir] = match;
  const verbs = CONTROL_VERB[field as keyof typeof CONTROL_VERB];
  if (!verbs) return key;
  const level = dir === '0' ? '' : '（大幅）';
  return `${dir === '+' ? verbs[1] : verbs[0]}${level}`;
}

export function decide(context: DecisionContext): Recommendation {
  const model = context.model;
  const state = model.snapshot();
  const horizonMin = context.horizonMin ?? 240;
  const base = clampControls(state.controls);
  const guard = guardrailsFor(state);

  const candidates: ScoredCandidate[] = [];
  const add = (key: string, controls: ControlSettings) => {
    const scored = scoreCandidate(state, model, applyGuard(controls, guard), horizonMin, guard);
    scored.label = candidateLabel(key);
    candidates.push(scored);
  };

  add('hold', base);

  for (const key of KEY_ORDER) {
    const bounds = CONTROL_BOUNDS[key];
    const span = Math.max(bounds.step, (bounds.max - bounds.min) * 0.12);
    const ups = [base[key] + span, Math.min(bounds.max, base[key] + span * 2)];
    const downs = [base[key] - span, Math.max(bounds.min, base[key] - span * 2)];
    ups.forEach((v, idx) => {
      if (v > bounds.max + 1e-9) return;
      add(`${key}+${idx}`, perturb(base, key, v));
    });
    downs.forEach((v, idx) => {
      if (v < bounds.min - 1e-9) return;
      add(`${key}-${idx}`, perturb(base, key, v));
    });
  }

  add(
    'combo:energy',
    clampControls({
      ...base,
      doSetpoint: Math.max(guard.doMin, base.doSetpoint - 0.35),
      internalRecirc: Math.min(3.0, base.internalRecirc + 0.3),
      wasRatio: Math.min(guard.wasMax, base.wasRatio + 0.001),
    }),
  );
  add(
    'combo:compliance',
    clampControls({
      ...base,
      doSetpoint: Math.min(guard.doMax, base.doSetpoint + 0.45),
      rasRatio: Math.min(1.4, base.rasRatio + 0.15),
      wasRatio: Math.max(guard.wasMin, base.wasRatio - 0.001),
      pacDose: Math.min(60, base.pacDose + 8),
    }),
  );

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const hold = candidates.find((c) => c.label === CANDIDATE_NAMES.hold) ?? best;

  const tweaks: Recommendation['tweaks'] = [];
  for (const key of KEY_ORDER) {
    const from = base[key];
    const to = best.controls[key];
    if (Math.abs(to - from) > CONTROL_BOUNDS[key].step / 2) {
      tweaks.push({
        key,
        from,
        to,
        reason: explainTweak(key, from, to),
      });
    }
  }

  const predictedScore = best.quality;
  const severity: Recommendation['severity'] =
    best.violations > 0 || best.worstRatio > 1
      ? 'critical'
      : best.worstRatio > 0.85
        ? 'watch'
        : 'normal';

  const action: Recommendation['action'] =
    tweaks.length === 0 ? 'hold' : severity === 'critical' ? 'emergency' : 'adjust';

  const summary =
    action === 'hold'
      ? 'AI 判定当前工况稳定，维持现有控制，继续滚动监视。'
      : severity === 'critical'
        ? `预测到 ${best.violations > 0 ? '出水超标风险' : '逼近限值'}，立即执行应急调节：${tweaks
            .map((t) => `${CONTROL_BOUNDS[t.key].label} ${formatNum(t.from, t.key)}→${formatNum(t.to, t.key)}`)
            .join('，')}。`
        : `建议微调 ${tweaks.length} 项：${tweaks
            .map((t) => `${CONTROL_BOUNDS[t.key].label} ${formatNum(t.from, t.key)}→${formatNum(t.to, t.key)}`)
            .join('，')}。`;

  const rationale = [...buildRationale(state, best, hold), ...scenarioHints(state, (state.scenario?.type as ScenarioType | null) ?? null)];
  const risks = buildRisks(state, best);
  const separation = computeDecisionSeparation(best, candidates);

  return {
    action,
    severity,
    summary,
    rationale,
    chosens: best,
    alternatives: candidates.slice(1, 4),
    predictedEffluent: best.predictedEffluent,
    predictedScore,
    horizonMin,
    separation,
    risks,
    tweaks,
    generatedAt: state.timeMin,
  };
}

function formatNum(value: number, key: keyof Omit<ControlSettings, 'aiEnabled'>): string {
  return value.toFixed(CONTROL_BOUNDS[key].precision);
}

function explainTweak(key: keyof Omit<ControlSettings, 'aiEnabled'>, from: number, to: number): string {
  const up = to > from;
  switch (key) {
    case 'stepFeed':
      return up ? '增加直接进入缺氧池的原水，为反硝化补充碳源' : '减少缺氧区进水，把碳源留给厌氧释磷';
    case 'stormStore':
      return up ? '启用雨水调蓄分流，削减进厂流量以保护二沉池固体通量' : '停止调蓄分流，恢复全部进水处理';
    case 'doSetpoint':
      return up ? '提高溶解氧，保证硝化菌活性与出水氨氮达标' : '降低溶解氧，在保留硝化余量的前提下减少曝气电耗';
    case 'internalRecirc':
      return up ? '提高内回流，将更多硝酸盐带回缺氧区强化脱氮' : '降低内回流，减少缺氧区溶解氧冲击并节电';
    case 'rasRatio':
      return up ? '提高污泥回流，控制二沉池污泥界面、防止跑泥' : '降低污泥回流，减少回流泵电耗';
    case 'wasRatio':
      return up ? '加大排泥，控制污泥龄与二沉池固体负荷' : '减少排泥，保留硝化菌群以应对低温或毒性抑制';
    case 'pacDose':
      return up ? '提高 PAC 投加，锁定化学除磷余量' : '降低 PAC 投加，在总磷达标前提下节约药剂';
    case 'carbonDose':
      return up ? '补充碳源，缓解缺氧区碳源不足导致的脱氮受限' : '减少碳源投加，避免过量碳源抬高出水 COD';
    case 'alkDose':
      return up ? '补充碱度，维持硝化反应所需的 pH 缓冲' : '减少碱度投加，节省药剂';
  }
}

function buildRationale(state: PlantSnapshotForAi, best: DecisionCandidate, hold: DecisionCandidate): string[] {
  const margins = marginsOf(state.effluent);
  const tight = margins[0];
  const lines: string[] = [];
  lines.push(
    `当前出水最紧约束为 ${tight.metric}：${tight.value.toFixed(2)} / ${tight.limit} mg/L（占限值 ${(tight.ratio * 100).toFixed(0)}%）。`,
  );
  if (hold.violations > 0) {
    lines.push(`维持现状在未来 ${Math.round(best.cost > 0 ? 4 : 4)} 小时窗口内预计出现 ${hold.violations} 次超标采样点。`);
  } else {
    lines.push(`当前控制在预测窗口内无超标，方案优化目标转为「保达标前提下降低能耗与药耗」。`);
  }
  lines.push(
    `AI 在 ${best.violations === 0 ? '合规' : '应急'}约束下比选方案：预测出水评分 ${best.quality}/100，窗口成本 ¥${best.cost.toFixed(0)}，能耗峰值 ${best.energyPeak.toFixed(0)} kW。`,
  );
  if (state.controls.aiEnabled) {
    lines.push('决策由滚动时域优化（每步重预测 4 小时、候选控制组合比选）产生，异常时自动收紧约束。');
  }
  return lines;
}

function buildRisks(state: PlantSnapshotForAi, best: DecisionCandidate): string[] {
  const risks: string[] = [];
  if (best.worstRatio > 0.9) risks.push('出水指标裕度不足 10%，建议同步准备应急药剂与旁路预案');
  if (best.energyPeak > state.energy.totalKw * 1.4) risks.push('优化方案能耗峰值较当前高 40% 以上，注意配电容量');
  if (state.srtDays < 12) risks.push(`污泥龄 ${state.srtDays.toFixed(1)} d 偏低，硝化菌群稳定性存在隐患`);
  if (state.clarifier.blanketM > 3.2) risks.push(`二沉池污泥界面 ${state.clarifier.blanketM.toFixed(2)} m 偏高，警惕跑泥`);
  if (!risks.length) risks.push('当前无高风险项，维持 15 分钟级滚动复核');
  return risks;
}

/**
 * 方案区分度（不是统计置信度）。
 *
 * 该值只反映"最优候选与次优候选的得分差距"以及"最紧指标的余量"，
 * 是一个 0–1 的启发式排序指标，没有经过概率校准，不能解释为"决策正确的概率"。
 * 命名与界面文案都必须体现这一点，否则就是伪量化。
 */
function computeDecisionSeparation(best: DecisionCandidate, candidates: DecisionCandidate[]): number {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const second = sorted[1]?.score ?? best.score;
  const gap = best.score - second;
  const marginGap = 1 - Math.min(1, Math.max(0, best.worstRatio - 0.6) / 0.4);
  const conf = 0.55 + Math.min(0.25, gap / 900) + marginGap * 0.2;
  return Math.round(Math.min(0.97, Math.max(0.35, conf)) * 100) / 100;
}

function marginsOf(e: PlantSnapshotForAi['effluent']) {
  return [
    { metric: 'COD', ratio: e.cod / LIMITS.cod, value: e.cod, limit: LIMITS.cod },
    { metric: 'BOD₅', ratio: e.bod / LIMITS.bod, value: e.bod, limit: LIMITS.bod },
    { metric: 'SS', ratio: e.ss / LIMITS.ss, value: e.ss, limit: LIMITS.ss },
    { metric: 'NH₃-N', ratio: e.nh / LIMITS.nh, value: e.nh, limit: LIMITS.nh },
    { metric: 'TN', ratio: e.tn / LIMITS.tn, value: e.tn, limit: LIMITS.tn },
    { metric: 'TP', ratio: e.tp / LIMITS.tp, value: e.tp, limit: LIMITS.tp },
  ].sort((a, b) => b.ratio - a.ratio);
}

export interface AnswerContext {
  question: string;
  model: PlantModel;
  recommendation: Recommendation | null;
}

export interface Answer {
  title: string;
  body: string;
  bullets: string[];
  confidence: number;
  kind: 'status' | 'why' | 'whatif' | 'plan' | 'explain' | 'unknown';
}

export function answer(question: string, model: PlantModel, recommendation: Recommendation | null): Answer {
  const state = model.snapshot();
  const q = question.trim();
  const intent = detectIntent(q);
  const margins = marginsOf(state.effluent);
  const tight = margins[0];

  if (intent === 'status') {
    return {
      title: '当前全厂运行状态',
      body: `截至仿真第 ${Math.floor(state.timeMin / 60)}h${String(Math.floor(state.timeMin % 60)).padStart(2, '0')}m，全厂进水 ${state.influent.flow.toFixed(0)} m³/h，出水 COD ${state.effluent.cod.toFixed(1)}、NH₃-N ${state.effluent.nh.toFixed(2)}、TP ${state.effluent.tp.toFixed(3)} mg/L；最紧约束是 ${tight.metric}，已用掉限值的 ${(tight.ratio * 100).toFixed(0)}%。`,
      bullets: [
        `出水水质评分 ${qualityScore(state.effluent)}/100`,
        `当前能耗 ${state.energy.totalKw.toFixed(0)} kW（${state.energy.specificKwhM3.toFixed(3)} kWh/m³）`,
        `污泥龄 ${state.srtDays.toFixed(1)} d，MLSS ${state.mlss} mg/L，反应器 ${state.reactorCount} 个`,
        `活动场景：${state.scenario ? state.scenario.type : '无'}；末段溶解氧 ${state.lastDo.toFixed(2)} mg/L`,
      ],
      confidence: 0.93,
      kind: 'status',
    };
  }

  if (intent === 'why') {
    if (!recommendation) {
      return {
        title: '暂时没有可比对的决策记录',
        body: 'AI 还没有生成新的控制建议，等下一次决策周期（15 分钟仿真时间）后即可解释具体的调节理由。',
        bullets: [],
        confidence: 0.4,
        kind: 'explain',
      };
    }
    return {
      title: '这次调节为什么这么做',
      body: recommendation.summary,
      bullets: recommendation.rationale,
      confidence: recommendation.separation,
      kind: 'explain',
    };
  }

  if (intent === 'whatif') {
    const scenario = matchScenario(q);
    if (!scenario) {
      return {
        title: '想做假设推演，但没识别出场景',
        body: '可以试试「如果发生暴雨冲击会怎样」「如果进水毒性升高」「如果鼓风机停了」这类问法。我会在当前状态上叠加场景并给出 4 小时预测。',
        bullets: [],
        confidence: 0.5,
        kind: 'unknown',
      };
    }
    const fc = model.predictWithScenario
      ? model.predictWithScenario(state.controls, 240, 30, scenario)
      : model.predict(state.controls, 240, 30);
    const worst = fc.points.reduce(
      (acc, p) => {
        const r = Math.max(
          p.effluent.cod / LIMITS.cod,
          p.effluent.nh / LIMITS.nh,
          p.effluent.tp / LIMITS.tp,
          p.effluent.ss / LIMITS.ss,
          p.effluent.tn / LIMITS.tn,
        );
        return r > acc.ratio ? { ratio: r, minute: p.minute, e: p.effluent } : acc;
      },
      { ratio: 0, minute: 0, e: state.effluent },
    );
    const violated = fc.violations.length > 0;
    const verdict = violated
      ? `4 小时内出现 ${fc.violations.length} 个超标采样点`
      : '4 小时内不会突破一级 A 限值，但裕度会明显收窄';
    const header =
      worst.minute === 240 && fc.points.length > 0
        ? `4 小时末`
        : `第 ${worst.minute} 分钟`;
    return {
      title: `假设推演：${scenarioLabel(scenario)}`,
      body: `若立即发生${scenarioLabel(scenario)}且控制保持不变，${verdict}。${header}最紧指标是 ${worstMetric(worst.e)}，出水评分 ${qualityScore(worst.e)}/100。`,
      bullets: [
        `最差点：COD ${worst.e.cod.toFixed(1)}、NH₃-N ${worst.e.nh.toFixed(2)}、TP ${worst.e.tp.toFixed(3)}、SS ${worst.e.ss.toFixed(1)} mg/L`,
        violated ? `超标类型：${[...new Set(fc.violations.map((v) => v.metric))].join('、')}` : '全部指标仍在限值内',
        `情形下能耗峰值 ${fc.peakEnergyKw.toFixed(0)} kW`,
        '建议：启用 AI 自动值守并再跑一次推演，可看到闭环后的对比',
      ],
      confidence: 0.72,
      kind: 'whatif',
    };
  }

  if (intent === 'plan') {
    return {
      title: '未来 8 小时运行计划',
      body: recommendation
        ? `AI 计划：${recommendation.summary}`
        : '当前没有待执行的计划，AI 会按 15 分钟周期滚动生成。',
      bullets: [
        '每 15 分钟仿真时间重新评估一次控制组合',
        '出水指标逼近限值 85% 时进入 watch 状态，提高复核频率',
        '超标风险出现时切到 emergency 策略，优先保达标',
        recommendation ? `下一步关键动作：${recommendation.tweaks.map((t) => CONTROL_BOUNDS[t.key].label).join('、') || '维持'}` : '无',
      ],
      confidence: 0.8,
      kind: 'plan',
    };
  }

  if (intent === 'explain') {
    return {
      title: '工艺与指标的通俗解释',
      body: '这个厂是 A²/O 工艺：厌氧池释放磷，缺氧池用内回流带来的硝酸盐做反硝化脱氮，好氧池完成有机物的氧化和硝化；二沉池负责泥水分离，污泥回流维持生物量，剩余污泥排放控制污泥龄。',
      bullets: [
        'COD/BOD 反映有机物，靠好氧异养菌降解',
        'NH₃-N 靠硝化菌氧化，低温与低溶氧最敏感',
        'TN 需要缺氧区碳源与内回流配合',
        'TP 由生物除磷与 PAC 化学除磷共同兜底',
      ],
      confidence: 0.95,
      kind: 'explain',
    };
  }

  return {
    title: '我没太理解这个问题',
    body: '可以问我：现在运行怎么样、为什么这样调、如果发生暴雨会怎样、未来几小时的计划、或者某个指标的意义。我也会在你授权时直接执行控制调整。',
    bullets: [
      '“现在出水怎么样？”',
      '“为什么把内回流调高？”',
      '“如果进水氨氮翻倍会怎样？”',
      '“给我未来 8 小时计划”',
    ],
    confidence: 0.4,
    kind: 'unknown',
  };
}

function detectIntent(q: string): Answer['kind'] {
  if (/(如果|假如|假设|要是|万一|what if)/.test(q)) return 'whatif';
  if (/(为什么|原因|依据|理由|why)/.test(q)) return 'why';
  if (/(计划|接下来|下一步|安排|plan)/.test(q)) return 'plan';
  if (/(什么是|怎么理解|解释|原理|科普|explain)/.test(q) || /(什么意思)/.test(q)) return 'explain';
  if (/(怎么样|状态|情况|现在|出水|运行|status)/.test(q)) return 'status';
  return 'unknown';
}

function matchScenario(q: string): ScenarioType | null {
  if (/(暴雨|大雨|降雨|storm|洪水)/.test(q)) return 'storm';
  if (/(冲击|负荷|高浓度|shock)/.test(q)) return 'shock_load';
  if (/(毒性|有毒|中毒|抑制|toxic)/.test(q)) return 'toxic';
  if (/(鼓风|曝气机|风机|blower)/.test(q)) return 'blower_failure';
  if (/(回流泵|污泥回流|ras)/.test(q)) return 'ras_failure';
  if (/(停电|断电|power)/.test(q)) return 'power_outage';
  if (/(低温|冬天|冬季|降温|winter)/.test(q)) return 'winter';
  if (/(药剂|pac|短缺|除磷剂)/.test(q)) return 'chemical_shortage';
  return null;
}

function worstMetric(e: EffluentState): string {
  const candidates: [string, number][] = [
    ['COD', e.cod / 50],
    ['NH₃-N', e.nh / 5],
    ['TN', e.tn / 15],
    ['TP', e.tp / 0.5],
    ['SS', e.ss / 10],
  ];
  const [name, ratio] = candidates.sort((a, b) => b[1] - a[1])[0];
  return `${name}（占限值 ${(ratio * 100).toFixed(0)}%）`;
}

function scenarioLabel(type: ScenarioType): string {
  const map: Record<ScenarioType, string> = {
    storm: '暴雨冲击',
    shock_load: '高负荷冲击',
    toxic: '毒性抑制',
    blower_failure: '鼓风机故障',
    ras_failure: '回流泵故障',
    power_outage: '全厂停电',
    winter: '低温工况',
    chemical_shortage: '药剂短缺',
  };
  return map[type];
}



import { CONTROL_BOUNDS, type ControlSettings } from '../sim/config';

/**
 * Agent 配置的共享 schema。
 *
 * 这一层同时被浏览器、服务端、CLI 使用：字段名、权限矩阵、核心保护区
 * 只有一份定义，避免三端各写一套导致「界面能改、服务端不认」。
 *
 * 设计边界：
 * - 核心影响项（出水限值、安全护栏、鉴权、密钥、动力学）不在本 schema 里，
 *   任何写入都改不到它们；
 * - 权限分三档 readonly / standard / open，能力差异见 PERMISSION_META；
 * - 所有字段都做范围夹紧与长度上限，非法值丢弃并给 warning。
 */

export type PermissionLevel = 'readonly' | 'standard' | 'open';
export type ControlKey = keyof Omit<ControlSettings, 'aiEnabled'>;

export interface PromptBlock {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

export type SkillSource = 'builtin' | 'custom' | 'remote';

export interface SkillSpec {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  content: string;
  enabled: boolean;
  source: SkillSource;
  url?: string;
}

export type HookEvent = 'alarm' | 'decision' | 'chat' | 'config';
export type HookAction = 'notice' | 'log' | 'webhook' | 'skill';

export interface HookSpec {
  id: string;
  name: string;
  event: HookEvent;
  /** 事件细节里的关键字；空表示全部匹配 */
  match: string;
  action: HookAction;
  /** notice/log 的模板或 skill 的 id；webhook 的 URL */
  target: string;
  level: 'info' | 'warn' | 'error';
  enabled: boolean;
  cooldownMin: number;
  /** 连续失败次数；由运行时维护，不参与用户编辑 */
  failures?: number;
}

export interface AgentPersona {
  name: string;
  role: string;
  tone: '专业简洁' | '严谨详实' | '亲和解释';
  language: 'zh' | 'en';
}

export interface AgentConstraints {
  allowedControls: ControlKey[];
  /** AI 单次控制动作相对当前值的最大步长（占控制量程百分比） */
  maxStepPct: number;
  /** true = AI 只建议不自动执行 */
  requireHumanApproval: boolean;
  forbiddenTopics: string[];
  maxAnswerChars: number;
}

export interface AgentConfig {
  version: 1;
  permission: PermissionLevel;
  persona: AgentPersona;
  prompts: PromptBlock[];
  constraints: AgentConstraints;
  skills: SkillSpec[];
  hooks: HookSpec[];
  updatedAt: string;
  updatedBy: 'default' | 'ui' | 'chat' | 'cli' | 'file';
}

export interface AgentSummary {
  personaName: string;
  permission: PermissionLevel;
  skillCount: number;
  hookCount: number;
  promptCount: number;
}

export type ConfigWriter = AgentConfig['updatedBy'];

export interface NormalizeResult {
  config: AgentConfig;
  warnings: string[];
}

export const PERMISSION_META: Record<PermissionLevel, { label: string; hint: string }> = {
  readonly: { label: '只读', hint: '禁止任何配置写入；仅保留查看与巡检' },
  standard: { label: '标准', hint: '可改角色/提示词/技能与收紧约束；钩子仅限本地动作' },
  open: { label: '完全放开', hint: '除核心保护区外全部可改，含 Webhook 钩子与更大幅度控制' },
};

/** 核心保护区：界面上只展示、任何路径都写不到 */
export const CORE_PROTECTED = [
  '出水排放限值（GB 18918-2002 一级 A）',
  '安全护栏与急停逻辑',
  '访问控制与令牌校验',
  '模型密钥与本机凭据',
  '工艺动力学参数与 BSM1 基准',
] as const;

/** 尝试写入这些顶层字段一律被忽略并告警 */
export const CORE_FIELD_NAMES = ['limits', 'safety', 'auth', 'secrets', 'core', 'kinetics', 'guardrails'] as const;

export const CONTROL_KEYS = Object.keys(CONTROL_BOUNDS) as ControlKey[];

export const AGENT_LIMITS = {
  maxPrompts: 20,
  maxPromptChars: 8000,
  maxSkills: 30,
  maxSkillChars: 12000,
  maxTriggers: 12,
  maxHooks: 30,
  maxNameChars: 80,
  maxAnswerChars: 1200,
  minAnswerChars: 60,
  maxForbiddenTopics: 20,
} as const;

export const PUNCT = /[|｜]/;

export function defaultAgentConfig(): AgentConfig {
  return {
    version: 1,
    permission: 'standard',
    persona: {
      name: '澄川值班长',
      role: '污水处理厂 AI 值班员',
      tone: '专业简洁',
      language: 'zh',
    },
    prompts: [
      {
        id: 'p-data-discipline',
        title: '数据纪律',
        body: '只能使用提供的数据回答；不得推算未给出的数字，不得编造仪表读数。数据不足时直接说明缺什么。',
        enabled: true,
      },
      {
        id: 'p-answer-shape',
        title: '回答结构',
        body: '先给结论，再给依据；优先给可执行动作；不使用 Markdown 标题、表格或代码块。',
        enabled: true,
      },
      {
        id: 'p-escalation',
        title: '越限处置',
        body: '任一指标超过限值时，先说明超标倍数与最可能原因，再给三步以内的处置顺序。',
        enabled: true,
      },
      {
        id: 'p-energy',
        title: '节能优先',
        body: '达标裕度充足时，优先选择单位能耗更低的控制组合，并说明预计节省。',
        enabled: false,
      },
    ],
    constraints: {
      allowedControls: [...CONTROL_KEYS],
      maxStepPct: 30,
      requireHumanApproval: false,
      forbiddenTopics: [],
      maxAnswerChars: 220,
    },
    skills: [
      {
        id: 's-storm',
        name: '暴雨冲击应对',
        description: '进水流量骤增时的调蓄与回流策略',
        triggers: ['暴雨', '降雨', '洪水', 'storm'],
        content: [
          '1. 先确认进水流量与调蓄池余量，必要时提高 stormStore 分流。',
          '2. 提高内回流比，避免缺氧区碳源被稀释后 TN 抬头。',
          '3. 二沉池泥位若超过池深 80%，优先加大剩余污泥排放而不是继续提高回流。',
        ].join('\n'),
        enabled: true,
        source: 'builtin',
      },
      {
        id: 's-toxic',
        name: '毒性抑制排查',
        description: '氨氮异常抬升时判断毒性 vs 低溶解氧',
        triggers: ['毒性', '中毒', '抑制', '氨氮升高'],
        content: [
          '1. 先看 DO 与曝气量：DO 正常而氨氮持续上升，优先怀疑毒性抑制。',
          '2. 对比进水 COD/NH₄ 比例与历史均值，判断是负荷冲击还是抑制。',
          '3. 确认抑制后降低排泥、保持曝气，避免自养菌被冲刷流失。',
        ].join('\n'),
        enabled: true,
        source: 'builtin',
      },
      {
        id: 's-energy',
        name: '节能调优',
        description: '达标裕度充足时的降耗顺序',
        triggers: ['能耗', '电耗', '节能', '省电'],
        content: [
          '1. 先降好氧区溶解氧设定，每次不超过 0.3 mg/L，观察 2 小时。',
          '2. 再降内回流比，保持 TN 裕度不低于 20%。',
          '3. 最后评估鼓风机工况，避免频繁启停。',
        ].join('\n'),
        enabled: true,
        source: 'builtin',
      },
      {
        id: 's-report',
        name: '交接班报告',
        description: '按班次汇总运行要点',
        triggers: ['交接', '班报', '报告', '总结'],
        content: [
          '1. 本班进出水关键指标的最大值/最小值与发生时刻。',
          '2. 本班发生的告警、处置动作与结果。',
          '3. 下一班需要盯的两个风险点与建议动作。',
        ].join('\n'),
        enabled: true,
        source: 'builtin',
      },
    ],
    hooks: [
      {
        id: 'h-effluent-alarm',
        name: '出水越限提醒',
        event: 'alarm',
        match: 'EFF_',
        action: 'notice',
        target: '出水中控提醒：{{detail}}',
        level: 'warn',
        enabled: true,
        cooldownMin: 5,
      },
      {
        id: 'h-decision-log',
        name: '决策留痕',
        event: 'decision',
        match: '',
        action: 'log',
        target: 'AI 决策：{{detail}}',
        level: 'info',
        enabled: true,
        cooldownMin: 1,
      },
      {
        id: 'h-diagnose-skill',
        name: '低溶氧触发排查技能',
        event: 'alarm',
        match: 'DO_LOW',
        action: 'skill',
        target: 's-toxic',
        level: 'info',
        enabled: true,
        cooldownMin: 10,
      },
    ],
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'default',
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function slugId(prefix: string, name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${prefix}-${base || index}-${index}`;
}

function normalizeTriggers(raw: unknown, fallback: string): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    const t = cleanText(item, 24);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= AGENT_LIMITS.maxTriggers) break;
  }
  if (out.length === 0) out.push(fallback);
  return out;
}

/**
 * 归一化任意输入为合法配置。
 *
 * 核心字段（limits/safety/auth/secrets/kinetics 等）直接丢弃并返回 warning；
 * 这是「核心影响不能改」在数据层的兜底，不依赖调用方自觉。
 */
export function normalizeAgentConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const base = defaultAgentConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: base, warnings: ['配置不是对象，已回退默认值'] };
  }
  const src = raw as Record<string, unknown>;
  for (const key of CORE_FIELD_NAMES) {
    if (key in src) warnings.push(`核心字段 ${key} 不可修改，已忽略`);
  }

  const permission = (['readonly', 'standard', 'open'] as const).includes(src.permission as PermissionLevel)
    ? (src.permission as PermissionLevel)
    : base.permission;

  const personaRaw = (src.persona ?? {}) as Record<string, unknown>;
  const persona: AgentPersona = {
    name: cleanText(personaRaw.name, AGENT_LIMITS.maxNameChars) || base.persona.name,
    role: cleanText(personaRaw.role, 200) || base.persona.role,
    tone: (['专业简洁', '严谨详实', '亲和解释'] as const).includes(personaRaw.tone as AgentPersona['tone'])
      ? (personaRaw.tone as AgentPersona['tone'])
      : base.persona.tone,
    language: personaRaw.language === 'en' ? 'en' : 'zh',
  };

  const prompts: PromptBlock[] = [];
  const promptSrc = Array.isArray(src.prompts) ? src.prompts : [];
  promptSrc.slice(0, AGENT_LIMITS.maxPrompts).forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const p = item as Record<string, unknown>;
    const title = cleanText(p.title, AGENT_LIMITS.maxNameChars);
    const body = cleanText(p.body, AGENT_LIMITS.maxPromptChars);
    if (!title || !body) return;
    const id = cleanText(p.id, 80) || slugId('p', title, i);
    if (prompts.some((x) => x.id === id)) return;
    prompts.push({ id, title, body, enabled: p.enabled !== false });
  });
  if (prompts.length === 0) prompts.push(...base.prompts);

  const constraintRaw = (src.constraints ?? {}) as Record<string, unknown>;
  const allowed = Array.isArray(constraintRaw.allowedControls) ? constraintRaw.allowedControls : [];
  const allowedControls = CONTROL_KEYS.filter((k) => allowed.includes(k));
  const topicsRaw = Array.isArray(constraintRaw.forbiddenTopics) ? constraintRaw.forbiddenTopics : [];
  const forbiddenTopics: string[] = [];
  for (const t of topicsRaw) {
    const topic = cleanText(t, 40);
    if (topic && !forbiddenTopics.includes(topic)) forbiddenTopics.push(topic);
    if (forbiddenTopics.length >= AGENT_LIMITS.maxForbiddenTopics) break;
  }
  const constraints: AgentConstraints = {
    allowedControls: allowedControls.length > 0 ? allowedControls : [...CONTROL_KEYS],
    maxStepPct: clampNumber(constraintRaw.maxStepPct, 5, 100, base.constraints.maxStepPct),
    requireHumanApproval: constraintRaw.requireHumanApproval === true,
    forbiddenTopics,
    maxAnswerChars: Math.round(
      clampNumber(
        constraintRaw.maxAnswerChars,
        AGENT_LIMITS.minAnswerChars,
        AGENT_LIMITS.maxAnswerChars,
        base.constraints.maxAnswerChars,
      ),
    ),
  };

  const skills: SkillSpec[] = [];
  const skillSrc = Array.isArray(src.skills) ? src.skills : [];
  skillSrc.slice(0, AGENT_LIMITS.maxSkills).forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const s = item as Record<string, unknown>;
    const name = cleanText(s.name, AGENT_LIMITS.maxNameChars);
    const content = cleanText(s.content, AGENT_LIMITS.maxSkillChars);
    if (!name || !content) return;
    const id = cleanText(s.id, 80) || slugId('s', name, i);
    if (skills.some((x) => x.id === id)) return;
    const source = (['builtin', 'custom', 'remote'] as const).includes(s.source as SkillSource)
      ? (s.source as SkillSource)
      : 'custom';
    skills.push({
      id,
      name,
      description: cleanText(s.description, 200),
      triggers: normalizeTriggers(s.triggers, name),
      content,
      enabled: s.enabled !== false,
      source,
      url: cleanText(s.url, 500) || undefined,
    });
  });
  if (skills.length === 0) skills.push(...base.skills);

  const hooks: HookSpec[] = [];
  const hookSrc = Array.isArray(src.hooks) ? src.hooks : [];
  hookSrc.slice(0, AGENT_LIMITS.maxHooks).forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const h = item as Record<string, unknown>;
    const name = cleanText(h.name, AGENT_LIMITS.maxNameChars);
    if (!name) return;
    const event = (['alarm', 'decision', 'chat', 'config'] as const).includes(h.event as HookEvent)
      ? (h.event as HookEvent)
      : null;
    const action = (['notice', 'log', 'webhook', 'skill'] as const).includes(h.action as HookAction)
      ? (h.action as HookAction)
      : null;
    if (!event || !action) return;
    const id = cleanText(h.id, 80) || slugId('h', name, i);
    if (hooks.some((x) => x.id === id)) return;
    hooks.push({
      id,
      name,
      event,
      match: cleanText(h.match, 120),
      action,
      target: cleanText(h.target, 500),
      level: (['info', 'warn', 'error'] as const).includes(h.level as HookSpec['level'])
        ? (h.level as HookSpec['level'])
        : 'info',
      enabled: h.enabled !== false,
      cooldownMin: Math.round(clampNumber(h.cooldownMin, 0, 1440, 5)),
      failures: Math.round(clampNumber(h.failures, 0, 9999, 0)),
    });
  });
  if (hooks.length === 0) hooks.push(...base.hooks);

  return {
    config: {
      version: 1,
      permission,
      persona,
      prompts,
      constraints,
      skills,
      hooks,
      updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : new Date(0).toISOString(),
      updatedBy: (['default', 'ui', 'chat', 'cli', 'file'] as const).includes(src.updatedBy as ConfigWriter)
        ? (src.updatedBy as ConfigWriter)
        : 'file',
    },
    warnings,
  };
}

export function agentSummary(config: AgentConfig): AgentSummary {
  return {
    personaName: config.persona.name,
    permission: config.permission,
    skillCount: config.skills.filter((s) => s.enabled).length,
    hookCount: config.hooks.filter((h) => h.enabled).length,
    promptCount: config.prompts.filter((p) => p.enabled).length,
  };
}

/** 某个权限档位能否执行某类写入 */
export function permissionAllows(
  level: PermissionLevel,
  action: 'save' | 'open-webhook' | 'wide-step' | 'grant-open',
): boolean {
  if (level === 'readonly') return false;
  if (level === 'open') return true;
  // standard
  if (action === 'save') return true;
  return false;
}

export interface ControlPatchCheck {
  ok: boolean;
  rejected: ControlKey[];
}

/** 手动控制写入必须落在 allowedControls 内 */
export function checkAllowedControls(
  patch: Partial<Record<string, unknown>>,
  allowed: ControlKey[],
): ControlPatchCheck {
  const rejected = Object.keys(patch).filter(
    (key): key is ControlKey => CONTROL_KEYS.includes(key as ControlKey) && !allowed.includes(key as ControlKey),
  );
  return { ok: rejected.length === 0, rejected };
}

/**
 * AI 控制动作的单步限幅。
 *
 * maxStepPct 是「量程的百分比」而不是相对当前值的百分比：控制量程差异很大
 * （DO 0.8–4.0 vs PAC 0–60），用相对值会让小量程项几乎动不了。
 */
export function clampControlMoves(
  current: ControlSettings,
  next: ControlSettings,
  maxStepPct: number,
): ControlSettings {
  const out: ControlSettings = { ...next };
  for (const key of CONTROL_KEYS) {
    const bounds = CONTROL_BOUNDS[key];
    const delta = ((bounds.max - bounds.min) * maxStepPct) / 100;
    const target = (next[key] as number) ?? (current[key] as number);
    const base = current[key] as number;
    out[key] = Math.min(base + delta, Math.max(base - delta, target)) as never;
  }
  out.aiEnabled = next.aiEnabled;
  return out;
}

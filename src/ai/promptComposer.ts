import type { AgentConfig, SkillSpec } from '../shared/agentConfig';

/**
 * 提示词合成。
 *
 * 目标：用户在界面里改的角色、提示词、约束、技能必须真的出现在发给模型的
 * system prompt 里，而不是停在数据库里。这里负责把配置拼成一段文本，
 * 并保证长度可控（模型上下文差异很大）。
 *
 * 组成顺序固定：角色 → 硬性约束 → 启用的提示词块 → 命中的技能 → 输出格式。
 */

export const MAX_PROMPT_CHARS = 12000;
const MAX_MATCHED_SKILLS = 3;

// 注意：长度与语气不写死在这里——它们由【角色】与【硬性约束】按配置生成，
// 否则会出现「180 字」和用户设置的「220 字」两条互相矛盾的规则。
const BASE_RULES = [
  '规则：',
  '1. 只能使用用户消息中给出的数据；不得推算未给出的数字，不得编造仪表读数。',
  '2. 如果数据不足以回答，直接说明缺什么，不要猜测。',
  '3. 不要输出 Markdown 标题、表格或代码块。',
];

/** 关键词命中：任一词出现在问题里即视为相关 */
export function matchSkills(skills: SkillSpec[], question: string): SkillSpec[] {
  const q = question.toLowerCase();
  const hits: SkillSpec[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    if (skill.triggers.some((t) => t.length > 0 && q.includes(t.toLowerCase()))) {
      hits.push(skill);
      if (hits.length >= MAX_MATCHED_SKILLS) break;
    }
  }
  return hits;
}

export interface ComposeInput {
  config: AgentConfig;
  question: string;
}

export interface ComposeResult {
  prompt: string;
  matchedSkills: string[];
}

/**
 * 合成 system prompt。
 *
 * 注意：这里只拼"人设与规则"，运行数据仍由 buildGroundingText 单独提供，
 * 两者职责不混，避免提示词里出现会被误当成实测值的数字。
 */
export function composeSystemPrompt(input: ComposeInput): ComposeResult {
  const { config, question } = input;
  const { persona, constraints, prompts } = config;
  const lines: string[] = [];

  lines.push(`【角色】你是${persona.name}，${persona.role}。语气：${persona.tone}。`);
  lines.push(`输出语言：${persona.language === 'en' ? 'English' : '简体中文'}。`);
  lines.push('');
  lines.push(...BASE_RULES);

  lines.push('');
  lines.push('【硬性约束】');
  lines.push(`- 回答不超过 ${constraints.maxAnswerChars} 个字符。`);
  if (constraints.requireHumanApproval) {
    lines.push('- 任何控制调整都只能作为建议提出，必须由操作员确认后才能执行。');
  } else {
    lines.push('- 在 AI 自动值守开启时，可以直接给出可执行的控制建议。');
  }
  if (constraints.forbiddenTopics.length > 0) {
    lines.push(`- 不要讨论以下话题：${constraints.forbiddenTopics.join('、')}。`);
  }
  if (constraints.allowedControls.length > 0) {
    lines.push(`- 只能建议这些控制量：${constraints.allowedControls.join('、')}。`);
  }
  lines.push(`- 单次控制动作幅度不超过量程的 ${constraints.maxStepPct}%。`);

  const enabledPrompts = prompts.filter((p) => p.enabled);
  if (enabledPrompts.length > 0) {
    lines.push('');
    lines.push('【工作准则】');
    for (const p of enabledPrompts) lines.push(`- ${p.title}：${p.body}`);
  }

  const skills = matchSkills(config.skills, question);
  if (skills.length > 0) {
    lines.push('');
    lines.push('【相关技能】');
    for (const s of skills) {
      lines.push(`技能「${s.name}」：`);
      lines.push(s.content);
    }
  }

  let prompt = lines.join('\n');
  if (prompt.length > MAX_PROMPT_CHARS) prompt = `${prompt.slice(0, MAX_PROMPT_CHARS - 20)}\n…（已截断）`;
  return { prompt, matchedSkills: skills.map((s) => s.name) };
}

/** 给界面用的预览（不含运行数据） */
export function previewPrompt(config: AgentConfig, question = '现在运行怎么样'): string {
  return composeSystemPrompt({ config, question }).prompt;
}

import {
  AGENT_LIMITS,
  CONTROL_KEYS,
  PERMISSION_META,
  defaultAgentConfig,
  normalizeAgentConfig,
  type AgentConfig,
  type ControlKey,
  type HookAction,
  type HookEvent,
  type PermissionLevel,
  type PromptBlock,
  type SkillSpec,
} from '../shared/agentConfig';

/**
 * 对话式配置命令。
 *
 * 用户可以在 AI 对话里直接说「设置角色：首席值班长」「添加技能 暴雨|暴雨,storm|1. …」
 * 来完成全部设置，不需要点开面板。解析结果是一个完整的新配置 + 给用户的回执，
 * 由服务端统一走 agentConfigStore.save（权限与核心保护在那一层）。
 *
 * 只识别以这些前缀开头的消息，普通提问不受影响。
 */

export interface CommandOutcome {
  /** 命中命令时为 true；false 表示这是普通对话 */
  handled: boolean;
  /** 回执文本；handled=false 时为 null */
  reply: string | null;
  /** 命中的命令名，用于日志与测试 */
  command?: string;
  /** 新配置；null 表示只读命令（列出/查看） */
  next?: AgentConfig | null;
  /** 权限不足等失败原因 */
  error?: string;
}

function splitParams(rest: string): string[] {
  return rest
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 保留空位的版本：``名称||正文`` 这种写法要能表达「触发词留空」 */
function splitParamsKeepEmpty(rest: string): string[] {
  return rest.split(/[|｜]/).map((s) => s.trim());
}

function parseTone(raw: string): '专业简洁' | '严谨详实' | '亲和解释' | null {
  if (/详实|严谨|详细/.test(raw)) return '严谨详实';
  if (/亲和|解释|通俗|友好/.test(raw)) return '亲和解释';
  if (/简洁|专业|直接/.test(raw)) return '专业简洁';
  return null;
}

function parseLevel(raw: string): PermissionLevel | null {
  if (/只读|readonly|read-only/i.test(raw)) return 'readonly';
  if (/放开|open|全开|完全/i.test(raw)) return 'open';
  if (/标准|standard/i.test(raw)) return 'standard';
  return null;
}

function parseEvent(raw: string): HookEvent | null {
  if (/告警|alarm/i.test(raw)) return 'alarm';
  if (/决策|decision/i.test(raw)) return 'decision';
  if (/对话|chat|提问/i.test(raw)) return 'chat';
  if (/配置|config/i.test(raw)) return 'config';
  return null;
}

function parseAction(raw: string): HookAction | null {
  if (/webhook|回调|http/i.test(raw)) return 'webhook';
  if (/skill|技能/i.test(raw)) return 'skill';
  if (/log|日志/i.test(raw)) return 'log';
  if (/notice|提示|广播/i.test(raw)) return 'notice';
  return null;
}

function clone(config: AgentConfig): AgentConfig {
  return JSON.parse(JSON.stringify(config)) as AgentConfig;
}

function nextPromptId(config: AgentConfig): string {
  let i = config.prompts.length + 1;
  while (config.prompts.some((p) => p.id === `p-custom-${i}`)) i += 1;
  return `p-custom-${i}`;
}

function nextSkillId(config: AgentConfig): string {
  let i = config.skills.length + 1;
  while (config.skills.some((s) => s.id === `s-custom-${i}`)) i += 1;
  return `s-custom-${i}`;
}

function nextHookId(config: AgentConfig): string {
  let i = config.hooks.length + 1;
  while (config.hooks.some((h) => h.id === `h-custom-${i}`)) i += 1;
  return `h-custom-${i}`;
}

/** 帮助文本：在对话里直接回复「命令」时展示 */
export const COMMAND_HELP = [
  '可用对话命令（也可以用界面「Agent 设置」面板做同样的修改）：',
  '· 设置角色 <名称> —— 改 AI 的名字',
  '· 设置语气 <专业简洁|严谨详实|亲和解释>',
  '· 设置回复长度 <60-1200>',
  '· 权限 <只读|标准|完全放开>',
  '· 添加提示词 标题|正文',
  '· 删除提示词 <标题或id>',
  '· 开启提示词 <标题> / 关闭提示词 <标题>',
  '· 添加技能 名称|触发词1,触发词2|正文',
  '· 删除技能 <名称或id>',
  '· 开启技能 <名称> / 关闭技能 <名称>',
  '· 添加钩子 名称|事件|匹配|动作|目标',
  '· 删除钩子 <名称或id>',
  '· 开启钩子 <名称> / 关闭钩子 <名称>',
  '· 约束 禁止话题 <话题1,话题2>',
  '· 约束 单步幅度 <5-100>',
  '· 约束 人工确认 <开|关>',
  '· 约束 允许控制 <doSetpoint,pacDose>',
  '· 列出配置 / 列出技能 / 列出钩子 / 列出提示词',
  '· 恢复默认配置',
].join('\n');

/**
 * 解析一条对话。
 *
 * 返回 handled=false 时调用方应继续走普通问答流程。
 */
export function parseAgentCommand(text: string, config: AgentConfig): CommandOutcome {
  const raw = text.trim();
  if (
    !/^(?:\/|！|!)?\s*(设置|添加|删除|列出|查看|重置|恢复|权限|开启|关闭|约束|技能|钩子|提示词|角色|命令)/.test(raw)
  ) {
    return { handled: false, reply: null };
  }
  const body = raw.replace(/^(?:\/|！|!)\s*/, '');
  const cmdMatch = body.match(
    /^(设置|添加|删除|列出|查看|重置|恢复|权限|开启|关闭|约束|技能|钩子|提示词|角色|命令)\s*(.*)$/,
  );
  if (!cmdMatch) return { handled: false, reply: null };
  const [, verb, restRaw] = cmdMatch;
  const rest = restRaw.trim();
  const next = clone(config);

  if (/^命令$|^help$|^帮助$/i.test(verb)) {
    return { handled: true, reply: COMMAND_HELP, command: 'help', next: null };
  }

  // 列出
  if (verb === '列出' || verb === '查看') {
    if (/技能/.test(rest)) {
      const lines = next.skills.map((s) => `· ${s.enabled ? '✅' : '⛔'} ${s.name}（触发：${s.triggers.join('、')}）`);
      return {
        handled: true,
        reply: `当前技能 ${next.skills.length} 个：\n${lines.join('\n')}`,
        command: 'list-skills',
        next: null,
      };
    }
    if (/钩子/.test(rest)) {
      const lines = next.hooks.map(
        (h) => `· ${h.enabled ? '✅' : '⛔'} ${h.name}（${h.event}｜${h.match || '*'}｜${h.action}→${h.target}）`,
      );
      return {
        handled: true,
        reply: `当前钩子 ${next.hooks.length} 个：\n${lines.join('\n')}`,
        command: 'list-hooks',
        next: null,
      };
    }
    if (/提示词/.test(rest)) {
      const lines = next.prompts.map((p) => `· ${p.enabled ? '✅' : '⛔'} ${p.title}`);
      return {
        handled: true,
        reply: `当前提示词 ${next.prompts.length} 条：\n${lines.join('\n')}`,
        command: 'list-prompts',
        next: null,
      };
    }
    const summary = [
      `角色：${next.persona.name}（${next.persona.role}，${next.persona.tone}）`,
      `权限：${PERMISSION_META[next.permission].label}（${next.permission}）`,
      `技能：${next.skills.filter((s) => s.enabled).length}/${next.skills.length} 启用`,
      `钩子：${next.hooks.filter((h) => h.enabled).length}/${next.hooks.length} 启用`,
      `提示词：${next.prompts.filter((p) => p.enabled).length}/${next.prompts.length} 启用`,
      `约束：单步 ≤${next.constraints.maxStepPct}% 量程，回复 ≤${next.constraints.maxAnswerChars} 字，人工确认 ${
        next.constraints.requireHumanApproval ? '开' : '关'
      }`,
      '输入「命令」查看全部可用的对话配置命令。',
    ];
    return { handled: true, reply: summary.join('\n'), command: 'list-all', next: null };
  }

  if (verb === '角色' || (verb === '设置' && /^角色/.test(rest))) {
    const name = rest
      .replace(/^角色[:：]?\s*/, '')
      .trim()
      .slice(0, AGENT_LIMITS.maxNameChars);
    if (!name)
      return { handled: true, reply: '用法：设置角色 <名称>', command: 'persona-name', next: null, error: '缺少名称' };
    next.persona.name = name;
    return { handled: true, reply: `已把 AI 角色名改为「${name}」，下一轮回答即生效。`, command: 'persona-name', next };
  }

  if (verb === '设置') {
    const toneMatch = rest.match(/^(?:语气|口吻)[:：]?\s*(.+)$/);
    if (toneMatch) {
      const tone = parseTone(toneMatch[1]);
      if (!tone)
        return {
          handled: true,
          reply: '语气只支持：专业简洁 / 严谨详实 / 亲和解释',
          command: 'persona-tone',
          next: null,
          error: 'bad-tone',
        };
      next.persona.tone = tone;
      return { handled: true, reply: `已把语气改为「${tone}」。`, command: 'persona-tone', next };
    }
    const roleMatch = rest.match(/^(?:职责|说明|岗位)[:：]?\s*(.+)$/);
    if (roleMatch) {
      next.persona.role = roleMatch[1].trim().slice(0, 200);
      return { handled: true, reply: `已把角色说明改为「${next.persona.role}」。`, command: 'persona-role', next };
    }
    const lenMatch = rest.match(/^(?:回复长度|回答长度|字数)[:：]?\s*(\d+)$/);
    if (lenMatch) {
      const n = Number(lenMatch[1]);
      if (n < AGENT_LIMITS.minAnswerChars || n > AGENT_LIMITS.maxAnswerChars) {
        return {
          handled: true,
          reply: `回复长度需在 ${AGENT_LIMITS.minAnswerChars}–${AGENT_LIMITS.maxAnswerChars} 之间`,
          command: 'answer-chars',
          next: null,
          error: 'bad-length',
        };
      }
      next.constraints.maxAnswerChars = n;
      return { handled: true, reply: `已把回答长度上限改为 ${n} 字。`, command: 'answer-chars', next };
    }
  }

  if (verb === '权限') {
    const level = parseLevel(rest);
    if (!level)
      return {
        handled: true,
        reply: '用法：权限 <只读|标准|完全放开>',
        command: 'permission',
        next: null,
        error: 'bad-level',
      };
    next.permission = level;
    return {
      handled: true,
      reply: `权限已切到「${PERMISSION_META[level].label}」：${PERMISSION_META[level].hint}`,
      command: 'permission',
      next,
    };
  }

  if (verb === '添加') {
    if (/^提示词/.test(rest)) {
      const parts = splitParams(rest.replace(/^提示词[:：]?\s*/, ''));
      if (parts.length < 2) {
        return {
          handled: true,
          reply: '用法：添加提示词 标题|正文',
          command: 'add-prompt',
          next: null,
          error: 'bad-args',
        };
      }
      if (next.prompts.length >= AGENT_LIMITS.maxPrompts) {
        return {
          handled: true,
          reply: `提示词最多 ${AGENT_LIMITS.maxPrompts} 条`,
          command: 'add-prompt',
          next: null,
          error: 'too-many',
        };
      }
      const block: PromptBlock = {
        id: nextPromptId(next),
        title: parts[0].slice(0, AGENT_LIMITS.maxNameChars),
        body: parts.slice(1).join('\n').slice(0, AGENT_LIMITS.maxPromptChars),
        enabled: true,
      };
      next.prompts.push(block);
      return { handled: true, reply: `已添加提示词「${block.title}」并启用。`, command: 'add-prompt', next };
    }
    if (/^技能|^skill/i.test(rest)) {
      const parts = splitParamsKeepEmpty(rest.replace(/^技能[:：]?\s*|^skill[:：]?\s*/i, ''));
      if (parts.length < 3) {
        return {
          handled: true,
          reply: '用法：添加技能 名称|触发词1,触发词2|正文',
          command: 'add-skill',
          next: null,
          error: 'bad-args',
        };
      }
      if (next.skills.length >= AGENT_LIMITS.maxSkills) {
        return {
          handled: true,
          reply: `技能最多 ${AGENT_LIMITS.maxSkills} 个`,
          command: 'add-skill',
          next: null,
          error: 'too-many',
        };
      }
      const skill: SkillSpec = {
        id: nextSkillId(next),
        name: parts[0].slice(0, AGENT_LIMITS.maxNameChars),
        description: '',
        triggers: parts[1]
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, AGENT_LIMITS.maxTriggers),
        content: parts.slice(2).join('\n').slice(0, AGENT_LIMITS.maxSkillChars),
        enabled: true,
        source: 'custom',
      };
      if (skill.triggers.length === 0) skill.triggers = [skill.name];
      next.skills.push(skill);
      return {
        handled: true,
        reply: `已添加技能「${skill.name}」，触发词：${skill.triggers.join('、')}。提到这些词时会自动作为参考。`,
        command: 'add-skill',
        next,
      };
    }
    if (/^钩子|^hook/i.test(rest)) {
      const parts = splitParamsKeepEmpty(rest.replace(/^钩子[:：]?\s*|^hook[:：]?\s*/i, ''));
      if (parts.length < 5) {
        return {
          handled: true,
          reply: '用法：添加钩子 名称|事件(告警/决策/对话/配置)|匹配词|动作(提示/日志/技能/Webhook)|目标',
          command: 'add-hook',
          next: null,
          error: 'bad-args',
        };
      }
      if (next.hooks.length >= AGENT_LIMITS.maxHooks) {
        return {
          handled: true,
          reply: `钩子最多 ${AGENT_LIMITS.maxHooks} 个`,
          command: 'add-hook',
          next: null,
          error: 'too-many',
        };
      }
      const event = parseEvent(parts[1]);
      const action = parseAction(parts[3]);
      if (!event || !action) {
        return {
          handled: true,
          reply: '事件或动作无法识别，事件支持：告警/决策/对话/配置；动作支持：提示/日志/技能/Webhook',
          command: 'add-hook',
          next: null,
          error: 'bad-event',
        };
      }
      next.hooks.push({
        id: nextHookId(next),
        name: parts[0].slice(0, AGENT_LIMITS.maxNameChars),
        event,
        match: parts[2] === '*' ? '' : parts[2],
        action,
        target: parts.slice(4).join('|').slice(0, 500),
        level: 'info',
        enabled: true,
        cooldownMin: 5,
      });
      return { handled: true, reply: `已添加钩子「${parts[0]}」：${event} → ${action}。`, command: 'add-hook', next };
    }
  }

  if (verb === '删除') {
    const target = rest.replace(/^(提示词|技能|钩子)[:：]?\s*/, '').trim();
    if (/^提示词/.test(rest)) {
      const hit = next.prompts.find((p) => p.id === target || p.title === target);
      if (!hit)
        return {
          handled: true,
          reply: `没找到提示词「${target}」`,
          command: 'del-prompt',
          next: null,
          error: 'not-found',
        };
      next.prompts = next.prompts.filter((p) => p.id !== hit.id);
      return { handled: true, reply: `已删除提示词「${hit.title}」。`, command: 'del-prompt', next };
    }
    if (/^技能/.test(rest)) {
      const hit = next.skills.find((s) => s.id === target || s.name === target);
      if (!hit)
        return {
          handled: true,
          reply: `没找到技能「${target}」`,
          command: 'del-skill',
          next: null,
          error: 'not-found',
        };
      next.skills = next.skills.filter((s) => s.id !== hit.id);
      return { handled: true, reply: `已删除技能「${hit.name}」。`, command: 'del-skill', next };
    }
    if (/^钩子/.test(rest)) {
      const hit = next.hooks.find((h) => h.id === target || h.name === target);
      if (!hit)
        return { handled: true, reply: `没找到钩子「${target}」`, command: 'del-hook', next: null, error: 'not-found' };
      next.hooks = next.hooks.filter((h) => h.id !== hit.id);
      return { handled: true, reply: `已删除钩子「${hit.name}」。`, command: 'del-hook', next };
    }
    return {
      handled: true,
      reply: '用法：删除提示词|技能|钩子 <名称或id>',
      command: 'del',
      next: null,
      error: 'bad-args',
    };
  }

  if (verb === '开启' || verb === '关闭') {
    const on = verb === '开启';
    const target = rest.replace(/^(提示词|技能|钩子)[:：]?\s*/, '').trim();
    if (/^提示词/.test(rest)) {
      const hit = next.prompts.find((p) => p.id === target || p.title === target);
      if (!hit)
        return {
          handled: true,
          reply: `没找到提示词「${target}」`,
          command: 'toggle-prompt',
          next: null,
          error: 'not-found',
        };
      hit.enabled = on;
      return {
        handled: true,
        reply: `提示词「${hit.title}」已${on ? '启用' : '关闭'}。`,
        command: 'toggle-prompt',
        next,
      };
    }
    if (/^技能/.test(rest)) {
      const hit = next.skills.find((s) => s.id === target || s.name === target);
      if (!hit)
        return {
          handled: true,
          reply: `没找到技能「${target}」`,
          command: 'toggle-skill',
          next: null,
          error: 'not-found',
        };
      hit.enabled = on;
      return { handled: true, reply: `技能「${hit.name}」已${on ? '启用' : '关闭'}。`, command: 'toggle-skill', next };
    }
    if (/^钩子/.test(rest)) {
      const hit = next.hooks.find((h) => h.id === target || h.name === target);
      if (!hit)
        return {
          handled: true,
          reply: `没找到钩子「${target}」`,
          command: 'toggle-hook',
          next: null,
          error: 'not-found',
        };
      hit.enabled = on;
      return { handled: true, reply: `钩子「${hit.name}」已${on ? '启用' : '关闭'}。`, command: 'toggle-hook', next };
    }
    return {
      handled: true,
      reply: '用法：开启/关闭 提示词|技能|钩子 <名称或id>',
      command: 'toggle',
      next: null,
      error: 'bad-args',
    };
  }

  if (verb === '约束') {
    const topicMatch = rest.match(/^(?:禁止话题|禁止)[:：]?\s*(.+)$/);
    if (topicMatch) {
      next.constraints.forbiddenTopics = topicMatch[1]
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, AGENT_LIMITS.maxForbiddenTopics);
      return {
        handled: true,
        reply: `已设置禁止话题：${next.constraints.forbiddenTopics.join('、') || '（无）'}`,
        command: 'forbidden',
        next,
      };
    }
    const stepMatch = rest.match(/^(?:单步幅度|步长)[:：]?\s*(\d+)$/);
    if (stepMatch) {
      const n = Number(stepMatch[1]);
      if (n < 5 || n > 100)
        return {
          handled: true,
          reply: '单步幅度需在 5–100 之间（占量程百分比）',
          command: 'step',
          next: null,
          error: 'bad-step',
        };
      next.constraints.maxStepPct = n;
      return { handled: true, reply: `已把 AI 单步控制幅度改为量程的 ${n}%。`, command: 'step', next };
    }
    const approvalMatch = rest.match(/^(?:人工确认|需要确认)[:：]?\s*(开|关|是|否|on|off)$/i);
    if (approvalMatch) {
      const on = /开|是|on/i.test(approvalMatch[1]);
      next.constraints.requireHumanApproval = on;
      return {
        handled: true,
        reply: on ? '已改为：AI 只给建议，必须人工确认。' : '已改为：AI 可自动执行（仍在护栏内）。',
        command: 'approval',
        next,
      };
    }
    const allowedMatch = rest.match(/^(?:允许控制|控制范围)[:：]?\s*(.+)$/);
    if (allowedMatch) {
      const list = allowedMatch[1]
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter((t): t is ControlKey => CONTROL_KEYS.includes(t as ControlKey));
      if (list.length === 0) {
        return {
          handled: true,
          reply: `未识别到合法控制量，可用：${CONTROL_KEYS.join('、')}`,
          command: 'allowed',
          next: null,
          error: 'bad-controls',
        };
      }
      next.constraints.allowedControls = list;
      return { handled: true, reply: `已限定 AI 只能建议：${list.join('、')}`, command: 'allowed', next };
    }
    return {
      handled: true,
      reply: '用法：约束 禁止话题 <…> / 约束 单步幅度 <5-100> / 约束 人工确认 <开|关> / 约束 允许控制 <…>',
      command: 'constraints',
      next: null,
      error: 'bad-args',
    };
  }

  if (verb === '重置' || verb === '恢复') {
    return {
      handled: true,
      reply: '已恢复默认配置（角色、提示词、技能、钩子都回到出厂值）。',
      command: 'reset',
      next: defaultAgentConfig(),
    };
  }

  return { handled: false, reply: null };
}

/** 供测试与界面预览：把规范化后的配置转成一句摘要 */
export function describeConfig(config: AgentConfig): string {
  const norm = normalizeAgentConfig(config).config;
  return [
    `角色 ${norm.persona.name}`,
    `权限 ${norm.permission}`,
    `技能 ${norm.skills.length}`,
    `钩子 ${norm.hooks.length}`,
    `提示词 ${norm.prompts.length}`,
    `回复上限 ${norm.constraints.maxAnswerChars} 字`,
    `单步 ${norm.constraints.maxStepPct}%`,
  ].join(' · ');
}

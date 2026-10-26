import { describe, expect, it } from 'vitest';
import { COMMAND_HELP, describeConfig, parseAgentCommand } from '../src/server/agentConfigCommands';
import { defaultAgentConfig } from '../src/shared/agentConfig';

/**
 * 对话式配置命令。
 *
 * 用户要求「全程在一个对话里把设置全部做完」：因此每条命令都必须
 * 真的返回一份可保存的新配置，而不是只回一句「好的」。
 */

const base = () => defaultAgentConfig();

describe('命令识别', () => {
  it('普通提问不被当成命令', () => {
    for (const q of ['现在运行怎么样', '为什么这么调', '出水氨氮多少', '如果暴雨会怎样']) {
      expect(parseAgentCommand(q, base()).handled).toBe(false);
    }
  });

  it('命令前缀可带 / 或 ！', () => {
    expect(parseAgentCommand('/命令', base()).handled).toBe(true);
    expect(parseAgentCommand('！权限 标准', base()).handled).toBe(true);
  });

  it('帮助命令列出全部可用动作', () => {
    const out = parseAgentCommand('命令', base());
    expect(out.handled).toBe(true);
    expect(out.reply).toBe(COMMAND_HELP);
    expect(out.reply).toContain('添加技能');
    expect(out.reply).toContain('添加钩子');
  });
});

describe('角色与提示词', () => {
  it('改角色名', () => {
    const out = parseAgentCommand('设置角色 首席值班长', base());
    expect(out.next?.persona.name).toBe('首席值班长');
    expect(out.reply).toContain('首席值班长');
  });

  it('改语气，非法值被拒', () => {
    expect(parseAgentCommand('设置语气 严谨详实', base()).next?.persona.tone).toBe('严谨详实');
    const bad = parseAgentCommand('设置语气 暴躁', base());
    expect(bad.next).toBeNull();
    expect(bad.error).toBe('bad-tone');
  });

  it('改回复长度并夹在允许区间', () => {
    expect(parseAgentCommand('设置回复长度 300', base()).next?.constraints.maxAnswerChars).toBe(300);
    expect(parseAgentCommand('设置回复长度 10', base()).next).toBeNull();
    expect(parseAgentCommand('设置回复长度 5000', base()).next).toBeNull();
  });

  it('添加提示词并启用', () => {
    const out = parseAgentCommand('添加提示词 节能优先|优先选择单位能耗更低的组合', base());
    const added = out.next?.prompts.at(-1);
    expect(added?.title).toBe('节能优先');
    expect(added?.body).toContain('能耗');
    expect(added?.enabled).toBe(true);
  });

  it('参数不足时给用法而不是崩溃', () => {
    const out = parseAgentCommand('添加提示词 只有标题', base());
    expect(out.next).toBeNull();
    expect(out.reply).toContain('用法');
  });

  it('关闭与开启提示词按标题定位', () => {
    const cfg = base();
    const title = cfg.prompts[0].title;
    const off = parseAgentCommand(`关闭提示词 ${title}`, cfg);
    expect(off.next?.prompts[0].enabled).toBe(false);
    const on = parseAgentCommand(`开启提示词 ${title}`, off.next!);
    expect(on.next?.prompts[0].enabled).toBe(true);
  });

  it('删除提示词', () => {
    const cfg = base();
    const before = cfg.prompts.length;
    const out = parseAgentCommand(`删除提示词 ${cfg.prompts[0].title}`, cfg);
    expect(out.next?.prompts).toHaveLength(before - 1);
  });
});

describe('技能', () => {
  it('添加技能：名称|触发词|正文', () => {
    const out = parseAgentCommand('添加技能 除磷优化|除磷,PAC,总磷|1. 先看 PAC 投加量 2. 再看二沉池出水 SS', base());
    const skill = out.next?.skills.at(-1);
    expect(skill?.name).toBe('除磷优化');
    expect(skill?.triggers).toEqual(['除磷', 'PAC', '总磷']);
    expect(skill?.content).toContain('PAC');
    expect(skill?.enabled).toBe(true);
    expect(skill?.source).toBe('custom');
  });

  it('触发词为空时用名称兜底', () => {
    const out = parseAgentCommand('添加技能 应急停机||先降曝气再停进水', base());
    expect(out.next?.skills.at(-1)?.triggers).toEqual(['应急停机']);
  });

  it('技能可以关闭与删除', () => {
    const cfg = base();
    const name = cfg.skills[0].name;
    const off = parseAgentCommand(`关闭技能 ${name}`, cfg);
    expect(off.next?.skills[0].enabled).toBe(false);
    const del = parseAgentCommand(`删除技能 ${name}`, cfg);
    expect(del.next?.skills.some((s) => s.name === name)).toBe(false);
  });

  it('列技能带启用状态与触发词', () => {
    const out = parseAgentCommand('列出技能', base());
    expect(out.reply).toContain('暴雨冲击应对');
    expect(out.reply).toContain('触发：');
  });
});

describe('钩子', () => {
  it('添加钩子：名称|事件|匹配|动作|目标', () => {
    const out = parseAgentCommand('添加钩子 越限外发|告警|EFF_|提示|出水超标：{{detail}}', base());
    const hook = out.next?.hooks.at(-1);
    expect(hook?.name).toBe('越限外发');
    expect(hook?.event).toBe('alarm');
    expect(hook?.match).toBe('EFF_');
    expect(hook?.action).toBe('notice');
    expect(hook?.target).toContain('{{detail}}');
  });

  it('事件与动作支持中英文', () => {
    expect(parseAgentCommand('添加钩子 A|decision|*|log|x', base()).next?.hooks.at(-1)?.action).toBe('log');
    expect(parseAgentCommand('添加钩子 B|对话||skill|s-storm', base()).next?.hooks.at(-1)?.event).toBe('chat');
  });

  it('事件非法时拒绝', () => {
    const out = parseAgentCommand('添加钩子 X|乱写|*|提示|x', base());
    expect(out.next).toBeNull();
    expect(out.error).toBe('bad-event');
  });

  it('钩子可关闭、删除、列出', () => {
    const cfg = base();
    const name = cfg.hooks[0].name;
    expect(parseAgentCommand(`关闭钩子 ${name}`, cfg).next?.hooks[0].enabled).toBe(false);
    expect(parseAgentCommand(`删除钩子 ${name}`, cfg).next?.hooks.some((h) => h.name === name)).toBe(false);
    expect(parseAgentCommand('列出钩子', cfg).reply).toContain(name);
  });
});

describe('约束与权限', () => {
  it('关闭人工确认', () => {
    const out = parseAgentCommand('约束 人工确认 关', base());
    expect(out.next?.constraints.requireHumanApproval).toBe(false);
    const on = parseAgentCommand('约束 人工确认 开', base());
    expect(on.next?.constraints.requireHumanApproval).toBe(true);
  });

  it('设定单步幅度并拒绝越界', () => {
    expect(parseAgentCommand('约束 单步幅度 50', base()).next?.constraints.maxStepPct).toBe(50);
    expect(parseAgentCommand('约束 单步幅度 300', base()).next).toBeNull();
  });

  it('限定允许控制量，非法键被过滤', () => {
    const out = parseAgentCommand('约束 允许控制 doSetpoint,pacDose,ghost', base());
    expect(out.next?.constraints.allowedControls).toEqual(['doSetpoint', 'pacDose']);
    const bad = parseAgentCommand('约束 允许控制 ghost', base());
    expect(bad.next).toBeNull();
  });

  it('设置禁止话题', () => {
    const out = parseAgentCommand('约束 禁止话题 薪资,人事', base());
    expect(out.next?.constraints.forbiddenTopics).toEqual(['薪资', '人事']);
  });

  it('权限三档都能切，非法值被拒', () => {
    expect(parseAgentCommand('权限 完全放开', base()).next?.permission).toBe('open');
    expect(parseAgentCommand('权限 只读', base()).next?.permission).toBe('readonly');
    const bad = parseAgentCommand('权限 无敌', base());
    expect(bad.next).toBeNull();
    expect(bad.error).toBe('bad-level');
  });

  it('恢复默认返回出厂配置', () => {
    const cfg = base();
    cfg.persona.name = '被改过的';
    const out = parseAgentCommand('恢复默认配置', cfg);
    expect(out.next?.persona.name).toBe(base().persona.name);
  });
});

describe('查询与摘要', () => {
  it('列出配置给出角色/权限/计数/约束', () => {
    const out = parseAgentCommand('列出配置', base());
    expect(out.reply).toContain('角色：');
    expect(out.reply).toContain('权限：');
    expect(out.reply).toContain('约束：');
  });

  it('describeConfig 归一化后输出一行摘要', () => {
    const text = describeConfig(base());
    expect(text).toContain('角色');
    expect(text).toContain('技能');
    expect(text).toContain('单步');
  });

  it('没找到目标时返回可读错误而不是抛出', () => {
    const out = parseAgentCommand('删除技能 不存在的技能', base());
    expect(out.handled).toBe(true);
    expect(out.next).toBeNull();
    expect(out.reply).toContain('没找到');
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_CHARS, composeSystemPrompt, matchSkills, previewPrompt } from '../src/ai/promptComposer';
import { defaultAgentConfig, type AgentConfig, type SkillSpec } from '../src/shared/agentConfig';

/**
 * 提示词合成。
 *
 * 这是「设置真的生效」的关键证据：配置里的角色、提示词、约束、技能
 * 必须真的出现在发给模型的 system prompt 里。
 */

const cfg = (): AgentConfig => defaultAgentConfig();

describe('角色与提示词进入 prompt', () => {
  it('包含角色名、职责与语气', () => {
    const c = cfg();
    c.persona.name = '首席值班长';
    c.persona.role = '全厂运行负责人';
    c.persona.tone = '严谨详实';
    const { prompt } = composeSystemPrompt({ config: c, question: '现在怎么样' });
    expect(prompt).toContain('首席值班长');
    expect(prompt).toContain('全厂运行负责人');
    expect(prompt).toContain('严谨详实');
  });

  it('只包含启用的提示词块', () => {
    const c = cfg();
    const off = c.prompts.find((p) => !p.enabled)!;
    const { prompt } = composeSystemPrompt({ config: c, question: 'x' });
    expect(prompt).not.toContain(off.title);
    expect(prompt).toContain(c.prompts.find((p) => p.enabled)!.title);
  });

  it('包含回答长度与单步约束', () => {
    const c = cfg();
    c.constraints.maxAnswerChars = 333;
    c.constraints.maxStepPct = 17;
    const { prompt } = composeSystemPrompt({ config: c, question: 'x' });
    expect(prompt).toContain('333');
    expect(prompt).toContain('17');
  });

  it('禁止话题与人工确认写进硬约束', () => {
    const c = cfg();
    c.constraints.forbiddenTopics = ['薪资', '人事'];
    c.constraints.requireHumanApproval = true;
    const { prompt } = composeSystemPrompt({ config: c, question: 'x' });
    expect(prompt).toContain('薪资、人事');
    expect(prompt).toContain('必须由操作员确认');
  });

  it('限定控制量时列出允许项', () => {
    const c = cfg();
    c.constraints.allowedControls = ['doSetpoint', 'pacDose'];
    const { prompt } = composeSystemPrompt({ config: c, question: 'x' });
    expect(prompt).toContain('doSetpoint、pacDose');
  });
});

describe('技能命中', () => {
  it('按触发词匹配，最多 3 个', () => {
    const skills: SkillSpec[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      name: `技能${i}`,
      description: '',
      triggers: ['暴雨'],
      content: `步骤${i}`,
      enabled: true,
      source: 'custom',
    }));
    expect(matchSkills(skills, '如果下暴雨怎么办')).toHaveLength(3);
  });

  it('未启用的技能不参与匹配', () => {
    const c = cfg();
    const skills = c.skills.map((s) => ({ ...s, enabled: false }));
    expect(matchSkills(skills, '暴雨来袭')).toHaveLength(0);
  });

  it('命中技能时正文进入 prompt，未命中则不进入', () => {
    const c = cfg();
    const hit = composeSystemPrompt({ config: c, question: '暴雨来了怎么调' });
    expect(hit.matchedSkills).toContain('暴雨冲击应对');
    expect(hit.prompt).toContain('调蓄池余量');

    const miss = composeSystemPrompt({ config: c, question: '今天天气不错' });
    expect(miss.matchedSkills).toHaveLength(0);
    expect(miss.prompt).not.toContain('调蓄池余量');
  });

  it('多个技能同时命中时都进 prompt', () => {
    const out = composeSystemPrompt({ config: cfg(), question: '暴雨和毒性同时发生，能耗也高' });
    expect(out.matchedSkills.length).toBeGreaterThanOrEqual(2);
    expect(out.prompt).toContain('毒性');
    expect(out.prompt).toContain('节能');
  });
});

describe('长度保护', () => {
  it('超长内容被截断到上限', () => {
    const c = cfg();
    c.prompts.push({
      id: 'p-huge',
      title: '巨长',
      body: 'x'.repeat(8000),
      enabled: true,
    });
    for (let i = 0; i < 10; i += 1) {
      c.skills.push({
        id: `s${i}`,
        name: `技能${i}`,
        description: '',
        triggers: ['触发'],
        content: 'y'.repeat(12000),
        enabled: true,
        source: 'custom',
      });
    }
    const { prompt } = composeSystemPrompt({ config: c, question: '触发' });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it('预览函数不抛异常', () => {
    expect(previewPrompt(cfg()).length).toBeGreaterThan(0);
  });
});

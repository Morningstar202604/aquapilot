import { describe, expect, it } from 'vitest';
import {
  AGENT_LIMITS,
  CONTROL_KEYS,
  agentSummary,
  checkAllowedControls,
  clampControlMoves,
  defaultAgentConfig,
  normalizeAgentConfig,
  permissionAllows,
} from '../src/shared/agentConfig';
import { DEFAULT_CONTROLS } from '../src/sim/config';

/**
 * Agent 配置的数据层契约。
 *
 * 锁定的都是「说了就必须真生效」的点：
 * - 核心字段写进来要被丢弃，不能靠调用方自觉；
 * - 权限矩阵决定能否写、能否提权；
 * - 约束对人工写入与 AI 单步都要真的收紧。
 */

describe('默认配置', () => {
  it('自带角色、提示词、技能、钩子且全部启用', () => {
    const cfg = defaultAgentConfig();
    expect(cfg.persona.name.length).toBeGreaterThan(0);
    expect(cfg.prompts.length).toBeGreaterThanOrEqual(3);
    expect(cfg.skills.length).toBeGreaterThanOrEqual(4);
    expect(cfg.hooks.length).toBeGreaterThanOrEqual(2);
    expect(cfg.permission).toBe('standard');
    expect(cfg.constraints.allowedControls).toHaveLength(CONTROL_KEYS.length);
  });

  it('摘要统计只数启用项', () => {
    const cfg = defaultAgentConfig();
    cfg.skills[0].enabled = false;
    const s = agentSummary(cfg);
    expect(s.skillCount).toBe(cfg.skills.length - 1);
    expect(s.promptCount).toBe(cfg.prompts.filter((p) => p.enabled).length);
  });
});

describe('核心保护区', () => {
  it('写入 limits/safety/auth/secrets/kinetics 被丢弃并告警', () => {
    const raw = {
      ...defaultAgentConfig(),
      limits: { cod: 9999 },
      safety: { bypass: true },
      auth: { disabled: true },
      secrets: { key: 'leak' },
      kinetics: { mu: 99 },
    };
    const { config, warnings } = normalizeAgentConfig(raw);
    expect('limits' in config).toBe(false);
    expect('safety' in config).toBe(false);
    expect('auth' in config).toBe(false);
    expect('secrets' in config).toBe(false);
    expect('kinetics' in config).toBe(false);
    expect(warnings).toHaveLength(5);
    expect(warnings.join()).toContain('limits');
  });

  it('核心保护不影响正常字段', () => {
    const base = defaultAgentConfig();
    base.persona.name = '新名字';
    const { config } = normalizeAgentConfig({ ...base, limits: {} });
    expect(config.persona.name).toBe('新名字');
  });
});

describe('归一化与夹紧', () => {
  it('非法权限/语气回退默认', () => {
    const { config } = normalizeAgentConfig({ permission: 'god', persona: { tone: '暴躁' } });
    expect(config.permission).toBe('standard');
    expect(config.persona.tone).toBe('专业简洁');
  });

  it('超长文本被截断，空技能被丢弃', () => {
    const { config } = normalizeAgentConfig({
      skills: [
        { name: 'a'.repeat(200), content: 'x'.repeat(20000) },
        { name: '', content: 'y' },
      ],
      prompts: [{ title: 't'.repeat(200), body: 'b'.repeat(20000) }],
    });
    expect(config.skills[0].name.length).toBeLessThanOrEqual(AGENT_LIMITS.maxNameChars);
    expect(config.skills[0].content.length).toBeLessThanOrEqual(AGENT_LIMITS.maxSkillChars);
    expect(config.skills).toHaveLength(1);
    expect(config.prompts[0].body.length).toBeLessThanOrEqual(AGENT_LIMITS.maxPromptChars);
  });

  it('重复 id 与重复触发词被去重', () => {
    const { config } = normalizeAgentConfig({
      skills: [
        { id: 'dup', name: 'A', content: 'x', triggers: ['暴雨', '暴雨', 'storm'] },
        { id: 'dup', name: 'B', content: 'y' },
      ],
    });
    expect(config.skills).toHaveLength(1);
    expect(config.skills[0].triggers).toEqual(['暴雨', 'storm']);
  });

  it('allowedControls 只保留合法键，空则回退全量', () => {
    const { config } = normalizeAgentConfig({ constraints: { allowedControls: ['doSetpoint', 'ghost'] } });
    expect(config.constraints.allowedControls).toEqual(['doSetpoint']);
    const { config: empty } = normalizeAgentConfig({ constraints: { allowedControls: ['ghost'] } });
    expect(empty.constraints.allowedControls).toHaveLength(CONTROL_KEYS.length);
  });

  it('数值范围夹紧', () => {
    const { config } = normalizeAgentConfig({
      constraints: { maxStepPct: 9999, maxAnswerChars: 1, forbiddenTopics: ['x'] },
    });
    expect(config.constraints.maxStepPct).toBe(100);
    expect(config.constraints.maxAnswerChars).toBe(AGENT_LIMITS.minAnswerChars);
  });

  it('完全非对象的输入回退默认而不是崩溃', () => {
    expect(normalizeAgentConfig(null).config.persona.name).toBe(defaultAgentConfig().persona.name);
    expect(normalizeAgentConfig([]).warnings.join()).toContain('回退默认值');
  });
});

describe('权限矩阵', () => {
  it('readonly 拒绝一切写入', () => {
    expect(permissionAllows('readonly', 'save')).toBe(false);
    expect(permissionAllows('readonly', 'open-webhook')).toBe(false);
  });

  it('standard 可写但不能开 webhook/提权/超步长', () => {
    expect(permissionAllows('standard', 'save')).toBe(true);
    expect(permissionAllows('standard', 'open-webhook')).toBe(false);
    expect(permissionAllows('standard', 'grant-open')).toBe(false);
  });

  it('open 全放行', () => {
    expect(permissionAllows('open', 'save')).toBe(true);
    expect(permissionAllows('open', 'open-webhook')).toBe(true);
    expect(permissionAllows('open', 'grant-open')).toBe(true);
  });
});

describe('约束生效', () => {
  it('allowedControls 之外的键被点名拒绝', () => {
    const res = checkAllowedControls({ doSetpoint: 2.5, pacDose: 20 }, ['doSetpoint', 'rasRatio']);
    expect(res.ok).toBe(false);
    expect(res.rejected).toEqual(['pacDose']);
  });

  it('全部合法时通过', () => {
    expect(checkAllowedControls({ doSetpoint: 2.5 }, ['doSetpoint']).ok).toBe(true);
  });

  it('非控制字段不影响判定', () => {
    expect(checkAllowedControls({ nonsense: 1 }, ['doSetpoint']).ok).toBe(true);
  });

  it('AI 单步按量程百分比限幅', () => {
    const current = { ...DEFAULT_CONTROLS, aiEnabled: true };
    const next = { ...current, pacDose: 60, doSetpoint: 4.0 };
    const out = clampControlMoves(current, next, 10);
    // PAC 量程 60 → 10% = 6 mg/L
    expect(out.pacDose).toBeCloseTo(current.pacDose + 6, 5);
    // DO 量程 3.2 → 10% = 0.32
    expect(out.doSetpoint).toBeCloseTo(current.doSetpoint + 0.32, 5);
    expect(out.aiEnabled).toBe(true);
  });

  it('限幅不会越过原目标值（目标更小时取目标）', () => {
    const current = { ...DEFAULT_CONTROLS, pacDose: 26 };
    const out = clampControlMoves(current, { ...current, pacDose: 20 }, 100);
    expect(out.pacDose).toBe(20);
  });
});

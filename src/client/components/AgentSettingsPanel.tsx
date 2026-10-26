import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_LIMITS,
  CONTROL_KEYS,
  CORE_PROTECTED,
  PERMISSION_META,
  type AgentConfig,
  type AgentSummary,
  type ControlKey,
  type HookAction,
  type HookEvent,
  type PermissionLevel,
  type SkillSpec,
} from '../../shared/agentConfig';
import type { AgentConfigApi } from '../hooks/useSimulation';

interface Props {
  agent: AgentConfigApi;
  open: boolean;
  onClose: () => void;
}

type Tab = 'persona' | 'prompts' | 'skills' | 'hooks' | 'constraints' | 'permission';

const TABS: { id: Tab; label: string }[] = [
  { id: 'persona', label: '角色与提示词' },
  { id: 'skills', label: '技能' },
  { id: 'hooks', label: '钩子' },
  { id: 'constraints', label: '约束' },
  { id: 'permission', label: '权限与核心' },
];

const HOOK_EVENTS: { value: HookEvent; label: string }[] = [
  { value: 'alarm', label: '告警' },
  { value: 'decision', label: '决策' },
  { value: 'chat', label: '对话' },
  { value: 'config', label: '配置' },
];

const HOOK_ACTIONS: { value: HookAction; label: string }[] = [
  { value: 'notice', label: '界面提示' },
  { value: 'log', label: '写日志' },
  { value: 'skill', label: '引用技能' },
  { value: 'webhook', label: 'Webhook（仅完全放开）' },
];

/**
 * Agent 设置面板。
 *
 * 六个能力都在这里可视化编辑：角色、提示词、技能、钩子、约束、权限。
 * 核心保护区只读展示——这是「大部分放开、核心不可改」在界面上的体现。
 * 保存走 patch，服务端统一做权限与核心校验，界面只负责如实展示被拒绝的原因。
 */
export function AgentSettingsPanel({ agent, open, onClose }: Props) {
  const cfg = agent.config;
  const [tab, setTab] = useState<Tab>('persona');
  const [draft, setDraft] = useState<AgentConfig | null>(cfg);
  const [dirty, setDirty] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: '', triggers: '', content: '' });
  const [importUrl, setImportUrl] = useState('');

  useEffect(() => {
    if (open) {
      agent.reload();
      setDraft(cfg);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 服务端广播新状态时，未编辑则跟随；正在编辑不覆盖用户输入
  useEffect(() => {
    if (!dirty && cfg) setDraft(cfg);
  }, [cfg, dirty]);

  const update = useCallback((mut: (c: AgentConfig) => AgentConfig) => {
    setDraft((prev) => (prev ? mut(JSON.parse(JSON.stringify(prev)) as AgentConfig) : prev));
    setDirty(true);
  }, []);

  if (!open) return null;
  if (!draft || !cfg) {
    return (
      <div className="model-modal" role="dialog" aria-modal="true" aria-label="Agent 设置">
        <div className="model-card">
          <div className="model-head">
            <div>
              <div className="model-title">Agent 设置</div>
              <div className="model-sub">正在读取配置…</div>
            </div>
            <button className="model-close" onClick={onClose} aria-label="关闭 Agent 设置">
              ×
            </button>
          </div>
        </div>
      </div>
    );
  }

  const readonly = draft.permission === 'readonly';
  const standard = draft.permission !== 'open';
  const summary: AgentSummary = agent.summary ?? {
    personaName: draft.persona.name,
    permission: draft.permission,
    skillCount: draft.skills.filter((s) => s.enabled).length,
    hookCount: draft.hooks.filter((h) => h.enabled).length,
    promptCount: draft.prompts.filter((p) => p.enabled).length,
  };

  const save = () => {
    agent.save(draft);
    setDirty(false);
  };
  const revert = () => {
    setDraft(cfg);
    setDirty(false);
  };

  const addSkill = () => {
    const name = newSkill.name.trim();
    const content = newSkill.content.trim();
    if (!name || !content) return;
    const triggers = newSkill.triggers
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, AGENT_LIMITS.maxTriggers);
    update((c) => {
      c.skills.push({
        id: `s-custom-${Date.now().toString(36)}`,
        name: name.slice(0, AGENT_LIMITS.maxNameChars),
        description: '',
        triggers: triggers.length > 0 ? triggers : [name],
        content: content.slice(0, AGENT_LIMITS.maxSkillChars),
        enabled: true,
        source: 'custom',
      });
      return c;
    });
    setNewSkill({ name: '', triggers: '', content: '' });
  };

  const importSkill = () => {
    const url = importUrl.trim();
    if (!url) return;
    agent.importSkill({
      name:
        url
          .split('/')
          .pop()
          ?.replace(/\.(md|txt|json)$/i, '') || '导入技能',
      description: `从 ${url} 导入`,
      triggers: [],
      content: url,
      url,
    });
    setImportUrl('');
  };

  return (
    <div className="model-modal" role="dialog" aria-modal="true" aria-label="Agent 设置">
      <div className="model-card agent-card">
        <div className="model-head">
          <div>
            <div className="model-title">Agent 设置</div>
            <div className="model-sub">
              {draft.persona.name} · {PERMISSION_META[draft.permission].label} · 技能 {summary.skillCount} · 钩子{' '}
              {summary.hookCount} · 提示词 {summary.promptCount}
            </div>
          </div>
          <button className="model-close" onClick={onClose} aria-label="关闭 Agent 设置">
            ×
          </button>
        </div>

        <div className="agent-tabs" role="tablist" aria-label="Agent 设置分页">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className="agent-tab"
              data-active={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="model-body">
          {readonly && (
            <div className="model-error" role="alert">
              当前权限为「只读」，所有修改都会在保存时被拒绝。可在「权限与核心」里切到「标准」。
            </div>
          )}

          {tab === 'persona' && (
            <>
              <div className="field">
                <label htmlFor="agent-persona-name">角色名称</label>
                <input
                  id="agent-persona-name"
                  value={draft.persona.name}
                  onChange={(e) => update((c) => ({ ...c, persona: { ...c.persona, name: e.target.value } }))}
                />
              </div>
              <div className="field">
                <label htmlFor="agent-persona-role">职责说明</label>
                <input
                  id="agent-persona-role"
                  value={draft.persona.role}
                  onChange={(e) => update((c) => ({ ...c, persona: { ...c.persona, role: e.target.value } }))}
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="agent-persona-tone">语气</label>
                  <select
                    id="agent-persona-tone"
                    value={draft.persona.tone}
                    onChange={(e) =>
                      update((c) => ({
                        ...c,
                        persona: { ...c.persona, tone: e.target.value as AgentConfig['persona']['tone'] },
                      }))
                    }
                  >
                    <option value="专业简洁">专业简洁</option>
                    <option value="严谨详实">严谨详实</option>
                    <option value="亲和解释">亲和解释</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="agent-answer-chars">回答长度上限（字）</label>
                  <input
                    id="agent-answer-chars"
                    type="number"
                    min={AGENT_LIMITS.minAnswerChars}
                    max={AGENT_LIMITS.maxAnswerChars}
                    value={draft.constraints.maxAnswerChars}
                    onChange={(e) =>
                      update((c) => ({
                        ...c,
                        constraints: { ...c.constraints, maxAnswerChars: Number(e.target.value) },
                      }))
                    }
                  />
                </div>
              </div>

              <div className="section-label" style={{ marginTop: 12 }}>
                提示词工程（{draft.prompts.length}/{AGENT_LIMITS.maxPrompts}）
              </div>
              {draft.prompts.map((p, i) => (
                <div className="agent-item" key={p.id}>
                  <div className="agent-item-head">
                    <button
                      className="model-toggle"
                      data-active={p.enabled}
                      aria-pressed={p.enabled}
                      onClick={() => update((c) => (void (c.prompts[i].enabled = !c.prompts[i].enabled), c))}
                    >
                      <span className="model-toggle-dot" />
                      {p.title}
                    </button>
                    <button
                      className="model-inline-btn"
                      onClick={() => update((c) => (void c.prompts.splice(i, 1), c))}
                    >
                      删除
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    value={p.body}
                    aria-label={`${p.title} 正文`}
                    onChange={(e) => update((c) => (void (c.prompts[i].body = e.target.value), c))}
                  />
                </div>
              ))}
              <button
                className="btn"
                disabled={draft.prompts.length >= AGENT_LIMITS.maxPrompts}
                onClick={() =>
                  update((c) => {
                    c.prompts.push({
                      id: `p-custom-${Date.now().toString(36)}`,
                      title: `自定义提示词 ${c.prompts.length + 1}`,
                      body: '',
                      enabled: true,
                    });
                    return c;
                  })
                }
              >
                添加提示词
              </button>

              <div className="section-label" style={{ marginTop: 12 }}>
                提示词预览
              </div>
              <div className="control-hint">保存前可以先看合成后的 system prompt，确认角色与规则真的会发出去。</div>
              <div className="decision-actions">
                <button className="btn" onClick={() => agent.requestPreview('现在运行怎么样', draft)}>
                  预览合成提示词
                </button>
              </div>
              {agent.promptPreview && <pre className="agent-preview">{agent.promptPreview}</pre>}
            </>
          )}

          {tab === 'skills' && (
            <>
              <div className="section-label">
                技能库（{draft.skills.length}/{AGENT_LIMITS.maxSkills}）
              </div>
              <div className="control-hint">
                命中触发词的技能会被拼进下一轮回答的 system prompt。内置技能可直接改；也可以新建或从 URL
                导入——导入内容以后台抓取的方式存成新技能。
              </div>
              {draft.skills.map((s, i) => (
                <div className="agent-item" key={s.id}>
                  <div className="agent-item-head">
                    <button
                      className="model-toggle"
                      data-active={s.enabled}
                      aria-pressed={s.enabled}
                      onClick={() => update((c) => (void (c.skills[i].enabled = !c.skills[i].enabled), c))}
                    >
                      <span className="model-toggle-dot" />
                      {s.name}
                    </button>
                    <span className="agent-tag">
                      {s.source === 'builtin' ? '内置' : s.source === 'remote' ? '导入' : '自定义'}
                    </span>
                    <button className="model-inline-btn" onClick={() => update((c) => (void c.skills.splice(i, 1), c))}>
                      删除
                    </button>
                  </div>
                  <input
                    aria-label={`${s.name} 触发词`}
                    value={s.triggers.join(',')}
                    onChange={(e) => {
                      const next = e.target.value
                        .split(/[,，\s]+/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .slice(0, AGENT_LIMITS.maxTriggers);
                      update((c) => {
                        c.skills[i].triggers = next;
                        return c;
                      });
                    }}
                    placeholder="触发词，用逗号分隔"
                  />
                  <textarea
                    rows={3}
                    aria-label={`${s.name} 正文`}
                    value={s.content}
                    onChange={(e) => update((c) => (void (c.skills[i].content = e.target.value), c))}
                  />
                </div>
              ))}

              <div className="section-label" style={{ marginTop: 12 }}>
                新建技能
              </div>
              <div className="field">
                <label htmlFor="new-skill-name">名称</label>
                <input
                  id="new-skill-name"
                  value={newSkill.name}
                  onChange={(e) => setNewSkill((s) => ({ ...s, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="new-skill-triggers">触发词（逗号分隔）</label>
                <input
                  id="new-skill-triggers"
                  value={newSkill.triggers}
                  onChange={(e) => setNewSkill((s) => ({ ...s, triggers: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="new-skill-body">正文（步骤/规则）</label>
                <textarea
                  id="new-skill-body"
                  rows={3}
                  value={newSkill.content}
                  onChange={(e) => setNewSkill((s) => ({ ...s, content: e.target.value }))}
                />
              </div>
              <button className="btn" onClick={addSkill} disabled={!newSkill.name.trim() || !newSkill.content.trim()}>
                添加技能
              </button>

              <div className="section-label" style={{ marginTop: 12 }}>
                从 URL 导入技能
              </div>
              <div className="field">
                <label htmlFor="import-skill-url">技能文件地址（.md / .txt）</label>
                <input
                  id="import-skill-url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.com/skill.md"
                />
              </div>
              <button className="btn" onClick={importSkill} disabled={!importUrl.trim()}>
                导入
              </button>
            </>
          )}

          {tab === 'hooks' && (
            <>
              <div className="section-label">
                钩子（{draft.hooks.length}/{AGENT_LIMITS.maxHooks}）
              </div>
              <div className="control-hint">
                钩子是声明式动作，不会执行任意脚本：可广播提示、写日志、引用技能，或在「完全放开」权限下 调用
                Webhook（受 SSRF 守卫限制）。
              </div>
              {draft.hooks.map((h, i) => (
                <div className="agent-item" key={h.id}>
                  <div className="agent-item-head">
                    <button
                      className="model-toggle"
                      data-active={h.enabled}
                      aria-pressed={h.enabled}
                      onClick={() => update((c) => (void (c.hooks[i].enabled = !c.hooks[i].enabled), c))}
                    >
                      <span className="model-toggle-dot" />
                      {h.name}
                    </button>
                    <button className="model-inline-btn" onClick={() => update((c) => (void c.hooks.splice(i, 1), c))}>
                      删除
                    </button>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor={`hook-event-${h.id}`}>事件</label>
                      <select
                        id={`hook-event-${h.id}`}
                        value={h.event}
                        onChange={(e) => {
                          const next = e.target.value as HookEvent;
                          update((c) => {
                            c.hooks[i].event = next;
                            return c;
                          });
                        }}
                      >
                        {HOOK_EVENTS.map((e) => (
                          <option key={e.value} value={e.value}>
                            {e.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`hook-action-${h.id}`}>动作</label>
                      <select
                        id={`hook-action-${h.id}`}
                        value={h.action}
                        onChange={(e) => {
                          const next = e.target.value as HookAction;
                          update((c) => {
                            c.hooks[i].action = next;
                            return c;
                          });
                        }}
                        disabled={standard && h.action === 'webhook'}
                      >
                        {HOOK_ACTIONS.map((a) => (
                          <option key={a.value} value={a.value} disabled={standard && a.value === 'webhook'}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor={`hook-match-${h.id}`}>匹配词（留空 = 全部）</label>
                    <input
                      id={`hook-match-${h.id}`}
                      value={h.match}
                      onChange={(e) => {
                        const next = e.target.value;
                        update((c) => {
                          c.hooks[i].match = next;
                          return c;
                        });
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`hook-target-${h.id}`}>目标（提示模板 / 技能 id / Webhook URL）</label>
                    <input
                      id={`hook-target-${h.id}`}
                      value={h.target}
                      onChange={(e) => {
                        const next = e.target.value;
                        update((c) => {
                          c.hooks[i].target = next;
                          return c;
                        });
                      }}
                    />
                  </div>
                </div>
              ))}
              <button
                className="btn"
                disabled={draft.hooks.length >= AGENT_LIMITS.maxHooks}
                onClick={() =>
                  update((c) => {
                    c.hooks.push({
                      id: `h-custom-${Date.now().toString(36)}`,
                      name: `自定义钩子 ${c.hooks.length + 1}`,
                      event: 'alarm',
                      match: '',
                      action: 'notice',
                      target: '{{detail}}',
                      level: 'info',
                      enabled: true,
                      cooldownMin: 5,
                    });
                    return c;
                  })
                }
              >
                添加钩子
              </button>
            </>
          )}

          {tab === 'constraints' && (
            <>
              <div className="section-label">约束工程</div>
              <div className="field">
                <label htmlFor="agent-step">AI 单步控制幅度（量程 %）</label>
                <input
                  id="agent-step"
                  type="number"
                  min={5}
                  max={100}
                  value={draft.constraints.maxStepPct}
                  onChange={(e) =>
                    update((c) => ({ ...c, constraints: { ...c.constraints, maxStepPct: Number(e.target.value) } }))
                  }
                />
                <div className="model-hint">标准权限最大 30%；完全放开可以到 100%</div>
              </div>
              <div className="field">
                <label>允许的控制量</label>
                <div className="agent-checks">
                  {CONTROL_KEYS.map((key) => {
                    const on = draft.constraints.allowedControls.includes(key);
                    return (
                      <button
                        key={key}
                        className="model-toggle"
                        data-active={on}
                        aria-pressed={on}
                        onClick={() =>
                          update((c) => {
                            const list = new Set<ControlKey>(c.constraints.allowedControls);
                            if (on) list.delete(key);
                            else list.add(key);
                            c.constraints.allowedControls = CONTROL_KEYS.filter((k) => list.has(k));
                            return c;
                          })
                        }
                      >
                        <span className="model-toggle-dot" />
                        {key}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="field">
                <button
                  className="model-toggle"
                  data-active={draft.constraints.requireHumanApproval}
                  aria-pressed={draft.constraints.requireHumanApproval}
                  onClick={() =>
                    update((c) => ({
                      ...c,
                      constraints: { ...c.constraints, requireHumanApproval: !c.constraints.requireHumanApproval },
                    }))
                  }
                >
                  <span className="model-toggle-dot" />
                  需要人工确认（AI 只建议，不自动执行）
                </button>
              </div>
              <div className="field">
                <label htmlFor="agent-forbidden">禁止话题（逗号分隔）</label>
                <input
                  id="agent-forbidden"
                  value={draft.constraints.forbiddenTopics.join(',')}
                  onChange={(e) =>
                    update((c) => ({
                      ...c,
                      constraints: {
                        ...c.constraints,
                        forbiddenTopics: e.target.value
                          .split(/[,，\s]+/)
                          .map((t) => t.trim())
                          .filter(Boolean)
                          .slice(0, AGENT_LIMITS.maxForbiddenTopics),
                      },
                    }))
                  }
                />
              </div>
            </>
          )}

          {tab === 'permission' && (
            <>
              <div className="section-label">权限级别</div>
              {(['readonly', 'standard', 'open'] as PermissionLevel[]).map((level) => (
                <button
                  key={level}
                  className="agent-perm"
                  data-active={draft.permission === level}
                  onClick={() => update((c) => ({ ...c, permission: level }))}
                >
                  <span className="agent-perm-label">{PERMISSION_META[level].label}</span>
                  <span className="agent-perm-hint">{PERMISSION_META[level].hint}</span>
                </button>
              ))}
              <div className="control-hint" style={{ marginTop: 6 }}>
                「标准」不能自行提到「完全放开」——需要先在当前档位保存后，再由完全放开档位授予。
              </div>

              <div className="section-label" style={{ marginTop: 14 }}>
                核心保护区（任何权限都不可修改）
              </div>
              {CORE_PROTECTED.map((item) => (
                <div className="issue" data-sev="warning" key={item}>
                  <span className="issue-code">锁定</span>
                  <span>{item}</span>
                </div>
              ))}
              <div className="control-hint">
                这些项直接关系到出水达标、安全与凭据，界面只读展示；改动只能通过代码评审与重新部署完成。
              </div>
            </>
          )}
        </div>

        {agent.lastError && (
          <div className="model-error" role="alert" style={{ margin: '0 16px 10px' }}>
            {agent.lastError}
          </div>
        )}
        {agent.warnings.length > 0 && (
          <div className="model-saved" role="status" style={{ margin: '0 16px 10px' }}>
            {agent.warnings.join('；')}
          </div>
        )}

        <div className="model-actions">
          <button className="btn" onClick={revert} disabled={!dirty}>
            还原
          </button>
          <button className="btn btn-primary" onClick={save} disabled={readonly || agent.saving}>
            {agent.saving ? '保存中…' : '保存配置'}
          </button>
          <button
            className="btn"
            onClick={() => {
              agent.reset();
              setDirty(false);
            }}
          >
            恢复默认
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export type { SkillSpec };

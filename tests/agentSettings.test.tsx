// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentSettingsPanel } from '../src/client/components/AgentSettingsPanel';
import type { AgentConfigApi } from '../src/client/hooks/useSimulation';
import { defaultAgentConfig } from '../src/shared/agentConfig';

/**
 * Agent 设置面板的交互契约。
 *
 * 这里验证的是「界面上的每个能力都真的接上了回调」：
 * 角色输入、提示词启停、技能新增/删除、钩子新增、约束勾选、权限切换、保存。
 */

afterEach(cleanup);

function makeApi(overrides: Partial<AgentConfigApi> = {}): AgentConfigApi {
  return {
    config: defaultAgentConfig(),
    summary: {
      personaName: '澄川值班长',
      permission: 'standard',
      skillCount: 4,
      hookCount: 3,
      promptCount: 3,
    },
    warnings: [],
    coreProtected: ['出水排放限值（GB 18918-2002 一级 A）'],
    saving: false,
    lastError: null,
    save: vi.fn(),
    reset: vi.fn(),
    reload: vi.fn(),
    promptPreview: null,
    requestPreview: vi.fn(),
    importSkill: vi.fn(),
    ...overrides,
  };
}

describe('Agent 设置面板', () => {
  it('打开时拉取配置并显示摘要', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    expect(api.reload).toHaveBeenCalled();
    expect(screen.getByText(/澄川值班长/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Agent 设置' })).toBeTruthy();
  });

  it('改角色名后保存带上新值', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '首席值班长' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(api.save).toHaveBeenCalledTimes(1);
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.persona.name).toBe('首席值班长');
  });

  it('提示词可启停与删除', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    const first = api.config!.prompts[0];
    fireEvent.click(screen.getByRole('button', { name: first.title }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.prompts[0].enabled).toBe(!first.enabled);
  });

  it('新增提示词出现在草稿里', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    const before = api.config!.prompts.length;
    fireEvent.click(screen.getByRole('button', { name: '添加提示词' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.prompts).toHaveLength(before + 1);
  });

  it('技能页可新建技能并保存', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新技能' } });
    fireEvent.change(screen.getByLabelText('触发词（逗号分隔）'), { target: { value: '测试' } });
    fireEvent.change(screen.getByLabelText('正文（步骤/规则）'), { target: { value: '第一步；第二步' } });
    fireEvent.click(screen.getByRole('button', { name: '添加技能' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    const added = saved.skills.find((s) => s.name === '新技能');
    expect(added?.content).toContain('第二步');
    expect(added?.triggers).toEqual(['测试']);
  });

  it('技能页可从 URL 导入', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    fireEvent.change(screen.getByLabelText('技能文件地址（.md / .txt）'), {
      target: { value: 'https://example.com/skill.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(api.importSkill).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/skill.md' }));
  });

  it('钩子页可新增钩子并保存', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '钩子' }));
    const before = api.config!.hooks.length;
    fireEvent.click(screen.getByRole('button', { name: '添加钩子' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.hooks).toHaveLength(before + 1);
  });

  it('标准权限下 Webhook 选项被禁用', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '钩子' }));
    const webhookOptions = screen.getAllByRole('option', { name: /Webhook/ }) as HTMLOptionElement[];
    expect(webhookOptions.length).toBeGreaterThan(0);
    expect(webhookOptions.every((o) => o.disabled)).toBe(true);
  });

  it('约束页取消某个控制量后保存', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '约束' }));
    fireEvent.click(screen.getByRole('button', { name: 'pacDose' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.constraints.allowedControls).not.toContain('pacDose');
  });

  it('约束页开启人工确认', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '约束' }));
    fireEvent.click(screen.getByRole('button', { name: /需要人工确认/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.constraints.requireHumanApproval).toBe(true);
  });

  it('权限页展示三档与核心保护区', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '权限与核心' }));
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.getByText('标准')).toBeTruthy();
    expect(screen.getByText('完全放开')).toBeTruthy();
    expect(screen.getByText(/出水排放限值/)).toBeTruthy();
    expect(screen.getByText(/任何权限都不可修改/)).toBeTruthy();
  });

  it('切到完全放开后保存', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '权限与核心' }));
    fireEvent.click(screen.getByRole('button', { name: /完全放开/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    const saved = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof defaultAgentConfig>;
    expect(saved.permission).toBe('open');
  });

  it('只读权限禁用保存并提示', () => {
    const cfg = defaultAgentConfig();
    cfg.permission = 'readonly';
    const api = makeApi({ config: cfg });
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('只读');
    expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('错误与告警原地展示', () => {
    const api = makeApi({ lastError: '当前权限为「只读」', warnings: ['Webhook 钩子仅「完全放开」权限可用'] });
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('只读');
    expect(screen.getByText(/Webhook 钩子仅/)).toBeTruthy();
  });

  it('恢复默认走 reset', () => {
    const api = makeApi();
    render(<AgentSettingsPanel agent={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(api.reset).toHaveBeenCalled();
  });

  it('关闭时不渲染', () => {
    const api = makeApi();
    const { container } = render(<AgentSettingsPanel agent={api} open={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

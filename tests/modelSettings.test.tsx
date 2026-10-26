// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelSettingsPanel } from '../src/client/components/ModelSettingsPanel';
import type { LlmConfigApi } from '../src/client/hooks/useSimulation';
import { DEFAULT_CAPABILITIES } from '../src/shared/llm';

/**
 * 模型设置面板的交互契约。
 *
 * 锁定的都是用户实际会走的路径：
 * - 选协议 → 填地址 → 密钥 → 自动拉模型 → 点选模型 → 能力自动匹配 → 测试 → 保存；
 * - 已保存时密钥只显掩码；
 * - 错误原地展示，不白屏。
 */

afterEach(cleanup);

function makeApi(overrides: Partial<LlmConfigApi> = {}): LlmConfigApi {
  return {
    config: null,
    models: [
      { id: 'u2-flash', label: 'u2-flash', contextWindow: 1048576, maxOutput: 131072 },
      { id: 'glm-5.2', label: 'glm-5.2', contextWindow: 1048576, maxOutput: 131072 },
    ],
    discovering: false,
    testing: false,
    busy: false,
    lastError: null,
    lastDiscoverAt: Date.now(),
    testResult: null,
    discover: vi.fn(),
    test: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}

describe('模型设置面板', () => {
  it('打开时拉取当前配置并展示协议/地址/密钥占位', () => {
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    expect(api.reload).toHaveBeenCalled();
    expect(screen.getByLabelText('协议')).toBeTruthy();
    expect(screen.getByLabelText('Base URL')).toBeTruthy();
    expect(screen.getByLabelText('API Key')).toBeTruthy();
  });

  it('已保存配置时显示掩码且不出现明文', () => {
    const api = makeApi({
      config: {
        protocol: 'openai',
        baseUrl: 'https://maas-api.unisound.com/v1',
        model: 'u2-flash',
        capabilities: { ...DEFAULT_CAPABILITIES },
        autoCapabilities: true,
        hasKey: true,
        apiKeyMasked: 'sk-••••1234',
        updatedAt: new Date().toISOString(),
      },
    });
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toContain('sk-••••1234');
    expect(screen.getByText(/已启用/)).toBeTruthy();
  });

  it('常用地址一键填入并触发自动发现', () => {
    vi.useFakeTimers();
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'UniSound MaaS' }));
    const urlInput = screen.getByLabelText('Base URL') as HTMLInputElement;
    expect(urlInput.value).toBe('https://maas-api.unisound.com/v1');
    // 还缺密钥：不应发起请求
    vi.advanceTimersByTime(1000);
    expect(api.discover).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('地址与密钥齐备后防抖自动拉模型，且只请求一次', () => {
    vi.useFakeTimers();
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://maas-api.unisound.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test-key-123' } });
    vi.advanceTimersByTime(800);
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.discover).toHaveBeenCalledWith({
      protocol: 'openai',
      baseUrl: 'https://maas-api.unisound.com/v1',
      apiKey: 'sk-test-key-123',
    });
    vi.useRealTimers();
  });

  it('展开列表能看到全部模型，点选后自动匹配上下文与能力', () => {
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    expect(screen.getByText('已发现 2 个可用模型')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /u2-flash/ }));
    const modelInput = screen.getByLabelText('模型') as HTMLInputElement;
    expect(modelInput.value).toBe('u2-flash');
    const ctx = screen.getByLabelText('上下文窗口') as HTMLInputElement;
    expect(ctx.value).toBe('1048576');
    // 推理能力按命名自动打开
    expect(screen.getByRole('button', { name: /推理模型/ }).getAttribute('data-active')).toBe('true');
  });

  it('筛选框能把模型列表收窄', () => {
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('筛选模型'), { target: { value: 'glm' } });
    expect(screen.queryByRole('option', { name: /u2-flash/ })).toBeNull();
    expect(screen.getByRole('option', { name: /glm-5.2/ })).toBeTruthy();
  });

  it('关闭自动匹配后手动改的数值原样进入保存草稿', () => {
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('option', { name: /u2-flash/ }));
    fireEvent.click(screen.getByRole('button', { name: '自动（推荐）' }));
    const ctx = screen.getByLabelText('上下文窗口') as HTMLInputElement;
    expect(ctx.disabled).toBe(false);
    fireEvent.change(ctx, { target: { value: '65536' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }));
    expect(api.save).toHaveBeenCalledTimes(1);
    const draft = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      capabilities: { contextWindow: number };
    };
    expect(draft.capabilities.contextWindow).toBe(65536);
  });

  it('连接测试按钮带上当前地址、模型与输出上限', () => {
    const api = makeApi();
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('option', { name: /u2-flash/ }));
    fireEvent.click(screen.getByRole('button', { name: '连接测试' }));
    expect(api.test).toHaveBeenCalledWith({
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'u2-flash',
      maxOutput: 131072,
    });
  });

  it('成功与失败的测试结果都有可读反馈', () => {
    const api = makeApi({ testResult: { ok: true, latencyMs: 42, reply: '正常' } });
    const { unmount } = render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    expect(screen.getByText(/连接成功 · 42 ms/)).toBeTruthy();
    expect(screen.getByText(/模型回复：正常/)).toBeTruthy();
    unmount();

    const failing = makeApi({ testResult: { ok: false, latencyMs: 12, error: '鉴权失败（HTTP 401）' } });
    render(<ModelSettingsPanel llm={failing} open onClose={vi.fn()} />);
    expect(screen.getByText(/连接失败 · 12 ms/)).toBeTruthy();
    expect(screen.getByText(/鉴权失败/)).toBeTruthy();
  });

  it('错误信息原地展示', () => {
    const api = makeApi({ lastError: '端点不存在（HTTP 404）' });
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('端点不存在');
  });

  it('已保存时可清除配置', () => {
    const api = makeApi({
      config: {
        protocol: 'openai',
        baseUrl: 'https://a/v1',
        model: 'm',
        capabilities: { ...DEFAULT_CAPABILITIES },
        autoCapabilities: true,
        hasKey: true,
        apiKeyMasked: 'sk-••••1234',
        updatedAt: new Date().toISOString(),
      },
    });
    render(<ModelSettingsPanel llm={api} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '清除配置' }));
    expect(api.clear).toHaveBeenCalled();
  });

  it('保存成功后清空页面上的明文密钥', () => {
    const base = makeApi();
    const { rerender } = render(<ModelSettingsPanel llm={base} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-plain-text-key' } });
    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(keyInput.value).toBe('sk-plain-text-key');
    const savedConfig = {
      protocol: 'openai' as const,
      baseUrl: 'https://api.example.com/v1',
      model: 'u2-flash',
      capabilities: { ...DEFAULT_CAPABILITIES },
      autoCapabilities: true,
      hasKey: true,
      apiKeyMasked: 'sk-••••-key',
      updatedAt: new Date().toISOString(),
    };
    rerender(<ModelSettingsPanel llm={{ ...base, config: savedConfig }} open onClose={vi.fn()} />);
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  });

  it('关闭时不渲染任何内容', () => {
    const api = makeApi();
    const { container } = render(<ModelSettingsPanel llm={api} open={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

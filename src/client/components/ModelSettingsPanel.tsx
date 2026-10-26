import { useEffect, useMemo, useRef, useState } from 'react';
import type { LlmConfigApi } from '../hooks/useSimulation';
import {
  BASE_URL_PRESETS,
  DEFAULT_CAPABILITIES,
  PROTOCOL_META,
  PROTOCOLS,
  inferCapabilities,
  maskApiKey,
  type LlmProtocol,
  type ModelCapabilities,
} from '../../shared/llm';

interface Props {
  llm: LlmConfigApi;
  open: boolean;
  onClose: () => void;
}

const CAP_LABELS: { key: keyof ModelCapabilities; label: string; kind: 'number' | 'flag'; hint: string }[] = [
  { key: 'contextWindow', label: '上下文窗口', kind: 'number', hint: 'tokens，决定一次能带多少历史' },
  { key: 'maxOutput', label: '最大输出', kind: 'number', hint: 'tokens，单次回答上限' },
  { key: 'tools', label: '工具调用', kind: 'flag', hint: 'function calling / tool_use' },
  { key: 'vision', label: '图像输入', kind: 'flag', hint: '可读取截图与图片' },
  { key: 'reasoning', label: '推理模型', kind: 'flag', hint: '先思考后回答（如 u2-flash、o 系列）' },
  { key: 'streaming', label: '流式输出', kind: 'flag', hint: '逐字返回' },
];

/**
 * 自定义模型配置。
 *
 * 交互目标：用户只需要选协议、填地址、贴密钥，
 * 剩下的模型清单、上下文、能力开关全部自动补齐；
 * 想改的时候再展开「高级」手动覆盖。
 */
export function ModelSettingsPanel({ llm, open, onClose }: Props) {
  const saved = llm.config;
  const [protocol, setProtocol] = useState<LlmProtocol>(saved?.protocol ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(saved?.model ?? '');
  const [autoCapabilities, setAutoCapabilities] = useState(saved?.autoCapabilities ?? true);
  const [reasoningEffort, setReasoningEffort] = useState<'auto' | 'low' | 'off'>(saved?.reasoningEffort ?? 'auto');
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(saved?.capabilities ?? DEFAULT_CAPABILITIES);
  const [modelFilter, setModelFilter] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const autoTried = useRef<string>('');

  // 面板打开时拉一次当前配置；关闭时清空明文密钥，避免下次打开又回显
  useEffect(() => {
    if (open) {
      llm.reload();
      setSavedAt(null);
    } else {
      setApiKey('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!saved) return;
    setProtocol(saved.protocol);
    setBaseUrl(saved.baseUrl);
    setModel(saved.model);
    setAutoCapabilities(saved.autoCapabilities);
    setCapabilities(saved.capabilities);
    setReasoningEffort(saved.reasoningEffort ?? 'auto');
    // 保存成功后密钥已落到服务端，浏览器不再保留明文
    setApiKey('');
  }, [saved]);

  const selectedModel = useMemo(() => llm.models.find((m) => m.id === model) ?? null, [llm.models, model]);

  // 选中模型后自动匹配能力（端点元数据优先，缺失按命名推断）
  useEffect(() => {
    if (!selectedModel || !autoCapabilities) return;
    const caps = inferCapabilities(selectedModel, protocol);
    setCapabilities(caps);
    /**
     * 推理模型默认「压低思考」。
     *
     * 实测 u2-flash 在默认思考下要 30–60 秒才出正文，用户会以为没配置成功；
     * 压低思考后 6–18 秒返回，答案质量不受影响。用户仍可手动改回「自动」。
     */
    if (caps.reasoning && reasoningEffort === 'auto') setReasoningEffort('low');
  }, [selectedModel, autoCapabilities, protocol, reasoningEffort]);

  /**
   * 自动发现：地址与密钥都填好、且与上次尝试的签名不同时，防抖 700ms 后请求。
   * 不做逐击键请求；换协议会重新触发。
   */
  useEffect(() => {
    if (!open) return;
    const url = baseUrl.trim();
    const key = apiKey.trim();
    if (url.length < 8 || (!key && !saved?.hasKey)) return;
    if (!/^https?:\/\//i.test(url)) return;
    const signature = `${protocol}|${url}|${key ? maskApiKey(key) : (saved?.apiKeyMasked ?? '')}`;
    if (autoTried.current === signature) return;
    const timer = setTimeout(() => {
      autoTried.current = signature;
      llm.discover({ protocol, baseUrl: url, apiKey: key || undefined });
    }, 700);
    return () => clearTimeout(timer);
  }, [open, protocol, baseUrl, apiKey, saved?.hasKey, saved?.apiKeyMasked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const presets = BASE_URL_PRESETS.filter((p) => p.protocol === protocol);
  const filteredModels = llm.models.filter((m) => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
  });
  const keyReady = Boolean(apiKey.trim() || saved?.hasKey);
  const canDiscover = baseUrl.trim().length >= 8 && keyReady && !llm.busy;
  const canTest = canDiscover && model.trim().length > 0;

  const save = () => {
    llm.save({
      protocol,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      capabilities,
      autoCapabilities,
      reasoningEffort,
    });
    setSavedAt(new Date().toISOString());
  };

  return (
    <div className="model-modal" role="dialog" aria-modal="true" aria-label="模型设置">
      <div className="model-card">
        <div className="model-head">
          <div>
            <div className="model-title">自定义模型</div>
            <div className="model-sub">
              {saved
                ? `已启用 ${PROTOCOL_META[saved.protocol].label} · ${saved.model}`
                : '尚未配置，当前仅用内置规则引擎'}
            </div>
          </div>
          <button className="model-close" onClick={onClose} aria-label="关闭模型设置">
            ×
          </button>
        </div>

        <div className="model-body">
          <div className="field">
            <label htmlFor="llm-protocol">协议</label>
            <select
              id="llm-protocol"
              value={protocol}
              onChange={(e) => {
                setProtocol(e.target.value as LlmProtocol);
                setModel('');
                autoTried.current = '';
              }}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_META[p].label}
                </option>
              ))}
            </select>
            <div className="model-hint">{PROTOCOL_META[protocol].hint}</div>
          </div>

          <div className="field">
            <label htmlFor="llm-base-url">Base URL</label>
            <input
              id="llm-base-url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                autoTried.current = '';
              }}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              autoComplete="off"
            />
            {presets.length > 0 && (
              <div className="model-presets" role="group" aria-label="常用地址">
                {presets.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    className="model-preset"
                    data-active={baseUrl === p.url}
                    onClick={() => {
                      setBaseUrl(p.url);
                      autoTried.current = '';
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="llm-api-key">API Key</label>
            <input
              id="llm-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                autoTried.current = '';
              }}
              placeholder={saved?.hasKey ? `已保存 ${saved.apiKeyMasked}，留空沿用` : '粘贴密钥'}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <div className="model-field-row">
              <label htmlFor="llm-model">模型</label>
              <button
                type="button"
                className="model-inline-btn"
                onClick={() => {
                  autoTried.current = '';
                  llm.discover({ protocol, baseUrl, apiKey: apiKey.trim() || undefined });
                }}
                disabled={!canDiscover}
              >
                {llm.discovering ? '正在拉取…' : '拉取模型'}
              </button>
            </div>
            <input
              id="llm-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="选择下方列表，或直接填写模型名"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="model-field-row">
              <span className="model-hint" role="status" aria-live="polite">
                {llm.discovering
                  ? '正在请求模型列表…'
                  : llm.models.length > 0
                    ? `已发现 ${llm.models.length} 个可用模型`
                    : llm.lastDiscoverAt
                      ? '未返回模型，可手动填写模型名'
                      : '填好地址与密钥后自动拉取'}
              </span>
              {llm.models.length > 0 && (
                <button type="button" className="model-inline-btn" onClick={() => setListOpen((v) => !v)}>
                  {listOpen ? '收起列表' : '展开列表'}
                </button>
              )}
            </div>
            {listOpen && llm.models.length > 0 && (
              <div className="model-list-wrap">
                <input
                  className="model-filter"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="筛选模型"
                  aria-label="筛选模型"
                />
                <ul className="model-list" role="listbox" aria-label="可用模型">
                  {filteredModels.slice(0, 200).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={model === m.id}
                        className="model-item"
                        data-active={model === m.id}
                        onClick={() => {
                          setModel(m.id);
                          if (autoCapabilities) setCapabilities(inferCapabilities(m, protocol));
                        }}
                      >
                        <span className="model-item-id">{m.id}</span>
                        <span className="model-item-meta">
                          {m.label !== m.id ? `${m.label} · ` : ''}
                          {m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k 上下文` : '上下文未知'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {filteredModels.length === 0 && <li className="model-empty">没有匹配的模型</li>}
                </ul>
              </div>
            )}
          </div>

          <div className="field">
            <div className="model-field-row">
              <label>能力匹配</label>
              <button
                type="button"
                className="model-inline-btn"
                onClick={() => setAutoCapabilities((v) => !v)}
                aria-pressed={autoCapabilities}
                data-active={autoCapabilities}
              >
                {autoCapabilities ? '自动（推荐）' : '自定义'}
              </button>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="llm-reasoning">推理强度</label>
              <select
                id="llm-reasoning"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as 'auto' | 'low' | 'off')}
              >
                <option value="auto">自动（按模型默认）</option>
                <option value="low">压低思考（更快、更省 token）</option>
                <option value="off">关闭思考（最快，仅下发兼容字段）</option>
              </select>
              <div className="model-hint">
                推理模型（如 u2-flash）默认会把预算花在思考上，回答可达 30–60 秒；选「压低思考」可显著缩短等待。
              </div>
            </div>
            <div className="model-cap-grid" data-auto={autoCapabilities}>
              {CAP_LABELS.map((cap) => (
                <div className="model-cap" key={cap.key}>
                  {cap.kind === 'number' ? (
                    <>
                      <label htmlFor={`cap-${cap.key}`}>{cap.label}</label>
                      <input
                        id={`cap-${cap.key}`}
                        type="number"
                        min={cap.key === 'maxOutput' ? 64 : 1024}
                        step={1024}
                        disabled={autoCapabilities}
                        value={capabilities[cap.key] as number}
                        onChange={(e) => setCapabilities((prev) => ({ ...prev, [cap.key]: Number(e.target.value) }))}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="model-toggle"
                      id={`cap-${cap.key}`}
                      aria-pressed={Boolean(capabilities[cap.key])}
                      disabled={autoCapabilities}
                      data-active={Boolean(capabilities[cap.key])}
                      onClick={() => setCapabilities((prev) => ({ ...prev, [cap.key]: !prev[cap.key] }))}
                    >
                      <span className="model-toggle-dot" />
                      {cap.label}
                    </button>
                  )}
                  <span className="model-cap-hint">{cap.hint}</span>
                </div>
              ))}
            </div>
            <button type="button" className="model-link" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? '收起高级设置' : '展开高级设置'}
            </button>
            {advancedOpen && (
              <div className="model-advanced">
                <div className="model-hint">
                  自动匹配优先使用端点返回的上下文元数据，缺失时按模型命名推断。关闭「自动」后以下数值会原样保存。
                </div>
                <div className="model-hint">
                  当前：上下文 {capabilities.contextWindow.toLocaleString()} tokens · 输出上限{' '}
                  {capabilities.maxOutput.toLocaleString()} tokens
                </div>
              </div>
            )}
          </div>

          {llm.lastError && (
            <div className="model-error" role="alert">
              {llm.lastError}
            </div>
          )}
          {llm.testResult && (
            <div className="model-test" data-ok={llm.testResult.ok} role="status">
              <div className="model-test-head">
                {llm.testResult.ok ? '连接成功' : '连接失败'} · {llm.testResult.latencyMs} ms
              </div>
              <div className="model-test-body">
                {llm.testResult.ok ? `模型回复：${llm.testResult.reply}` : llm.testResult.error}
              </div>
            </div>
          )}
          {savedAt && !llm.lastError && !llm.testResult && (
            <div className="model-saved" role="status">
              已保存，下一轮对话即用新模型
            </div>
          )}
        </div>

        <div className="model-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              llm.test({
                protocol,
                baseUrl,
                apiKey: apiKey.trim() || undefined,
                model,
                maxOutput: capabilities.maxOutput,
              })
            }
            disabled={!canTest}
          >
            {llm.testing ? '测试中…' : '连接测试'}
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!model.trim() || !baseUrl.trim()}>
            保存并启用
          </button>
          {saved && (
            <button type="button" className="btn" onClick={() => llm.clear()}>
              清除配置
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

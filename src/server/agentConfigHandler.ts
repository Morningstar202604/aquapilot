import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { CORE_PROTECTED, normalizeAgentConfig, type AgentConfig } from '../shared/agentConfig';
import { agentConfigStore } from './agentConfig';
import { composeSystemPrompt } from '../ai/promptComposer';
import { assertPublicFetchUrl } from '../ai/providers';
import { errorText } from './llmChat';
import type { HookRuntime } from './hooks';

/**
 * Agent 配置（界面驱动）。
 *
 * 与 llmConfig 同一套 request/response 模式；写入统一走 agentConfigStore.save，
 * 权限与核心保护在存储层实现，因此界面、对话命令、CLI 三条路径行为一致。
 *
 * 从 server/index.ts 抽出的原因：这里有一组独立的信任边界决策
 * （URL 导入的公网守卫、技能数量上限、权限交由存储层判定），
 * 与仿真编排无关，值得单独审阅。
 */

export interface AgentConfigHandlerDeps {
  broadcast: (message: ServerMessage) => void;
  hooks: HookRuntime;
}

export function agentStateMessage(
  requestId?: string,
  previewQuestion?: string,
  previewConfig?: AgentConfig,
): ServerMessage {
  const status = agentConfigStore.status();
  const cfg = previewConfig ?? status.config;
  return {
    type: 'agentConfig',
    action: 'state',
    requestId,
    config: status.config,
    summary: status.summary,
    warnings: status.warnings,
    coreProtected: [...CORE_PROTECTED],
    promptPreview:
      previewQuestion === undefined
        ? undefined
        : composeSystemPrompt({ config: cfg, question: previewQuestion }).prompt,
  };
}

export function createAgentConfigHandler(deps: AgentConfigHandlerDeps) {
  const broadcastAgentState = (): void => deps.broadcast(agentStateMessage());

  return async function handleAgentConfig(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'agentConfig' }>,
  ): Promise<void> {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    const send = (payload: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    try {
      if (msg.action === 'get') {
        send(agentStateMessage(requestId));
        return;
      }
      if (msg.action === 'previewPrompt') {
        const question = typeof msg.question === 'string' ? msg.question.slice(0, 200) : '现在运行怎么样';
        let previewConfig: AgentConfig | undefined;
        if (msg.config) {
          try {
            previewConfig = normalizeAgentConfig(msg.config).config;
          } catch {
            previewConfig = undefined;
          }
        }
        send(agentStateMessage(msg.requestId, question, previewConfig));
        return;
      }
      if (msg.action === 'reset') {
        const outcome = agentConfigStore.reset({ writer: 'ui' });
        send({
          type: 'agentConfig',
          action: 'saved',
          requestId: msg.requestId,
          ok: outcome.ok,
          config: outcome.config,
          summary: outcome.summary,
          warnings: outcome.warnings,
          error: outcome.error,
        });
        if (outcome.ok) {
          broadcastAgentState();
          void deps.hooks.fire(agentConfigStore.get(), { event: 'config', detail: 'reset', key: 'reset' });
        }
        return;
      }
      if (msg.action === 'importSkill') {
        await handleImportSkill(msg, requestId, send, broadcastAgentState);
        return;
      }
      if (msg.action === 'save' || msg.action === 'patch') {
        const payload = msg.action === 'save' ? msg.config : msg.patch;
        const outcome =
          msg.action === 'save'
            ? agentConfigStore.save(payload, { writer: 'ui' })
            : agentConfigStore.patch(payload, { writer: 'ui' });
        send({
          type: 'agentConfig',
          action: 'saved',
          requestId: msg.requestId,
          ok: outcome.ok,
          config: outcome.config,
          summary: outcome.summary,
          warnings: outcome.warnings,
          error: outcome.error,
        });
        if (outcome.ok) {
          broadcastAgentState();
          void deps.hooks.fire(agentConfigStore.get(), { event: 'config', detail: msg.action, key: msg.action });
        }
        return;
      }
      send({ type: 'agentConfig', action: 'error', requestId, error: '未知的配置动作' });
    } catch (err) {
      send({ type: 'agentConfig', action: 'error', requestId, error: errorText(err) });
    }
  };

  async function handleImportSkill(
    msg: Extract<ClientMessage, { type: 'agentConfig'; action: 'importSkill' }>,
    requestId: string | undefined,
    send: (payload: ServerMessage) => void,
    broadcastAgentState: () => void,
  ): Promise<void> {
    const status = agentConfigStore.status();
    const cfg = JSON.parse(JSON.stringify(status.config)) as typeof status.config;
    if (cfg.skills.length >= 30) {
      send({ type: 'agentConfig', action: 'error', requestId, error: '技能最多 30 个' });
      return;
    }
    const incoming: {
      name?: string;
      description?: string;
      triggers?: string[];
      content?: string;
      url?: string;
    } = msg.skill;
    const name = typeof incoming?.name === 'string' ? incoming.name.trim().slice(0, 80) : '';
    let content = typeof incoming?.content === 'string' ? incoming.content.trim().slice(0, 12000) : '';
    let fetchedSkillTitle = '';
    /**
     * URL 导入：这里做的是服务端抓取，不是浏览器跳转。
     *
     * 抓取用严格公网守卫，而不是模型端点的宽松守卫：抓回的正文会写进技能、
     * 并在 agentConfig/get 里原样回传，允许私网就等于给任意客户端一个
     * 可读的内网探测器。同时不跟随重定向（避免 302 到元数据地址）。
     */
    if (!content && typeof incoming?.url === 'string' && incoming.url.trim()) {
      try {
        const url = assertPublicFetchUrl(incoming.url.trim());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const res = await fetch(url.toString(), { signal: controller.signal, redirect: 'manual' });
          if (!res.ok) {
            send({ type: 'agentConfig', action: 'error', requestId, error: `导入失败：HTTP ${res.status}` });
            return;
          }
          const text = (await res.text()).trim();
          if (!text) {
            send({ type: 'agentConfig', action: 'error', requestId, error: '导入失败：目标返回空内容' });
            return;
          }
          fetchedSkillTitle = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
          content = text.slice(0, 12000);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        send({ type: 'agentConfig', action: 'error', requestId, error: `导入失败：${errorText(err)}` });
        return;
      }
    }
    if (!name && !content) {
      send({ type: 'agentConfig', action: 'error', requestId, error: '导入技能需要名称与正文（或可抓取的 URL）' });
      return;
    }
    const finalName = (name || fetchedSkillTitle || '导入技能').slice(0, 80);
    const triggers = Array.isArray(incoming.triggers)
      ? incoming.triggers
          .filter((t): t is string => typeof t === 'string')
          .map((t: string) => t.trim().slice(0, 24))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    cfg.skills.push({
      id: `s-import-${Date.now().toString(36)}`,
      name: finalName,
      description: typeof incoming.description === 'string' ? incoming.description.slice(0, 200) : '',
      triggers: triggers.length > 0 ? triggers : [finalName],
      content,
      enabled: true,
      source: 'remote',
      url: typeof incoming.url === 'string' ? incoming.url.slice(0, 500) : undefined,
    } as (typeof cfg.skills)[number]);
    const outcome = agentConfigStore.save(cfg, { writer: 'ui' });
    send({
      type: 'agentConfig',
      action: 'saved',
      requestId: msg.requestId,
      ok: outcome.ok,
      config: outcome.config,
      summary: outcome.summary,
      warnings: outcome.warnings,
      error: outcome.error,
    });
    if (outcome.ok) broadcastAgentState();
  }
}

import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { discoverModels, testConnection } from '../ai/providers';
import { errorText } from './llmChat';
import { llmConfigStore, sanitizeDraft } from './llmConfig';
import { freshClientState, type ClientState } from './rateLimit';

/**
 * 自定义模型配置的 WS 处理器。
 *
 * 从 `server/index.ts` 抽出的原因与 agentConfigHandler 相同：这是一组
 * 独立的信任边界（出站网络、密钥同源保护、限流），不该和仿真 tick
 * 混在同一个文件里。入口只保留一行装配。
 */

const LLM_RATE_LIMIT_MS = 800;

export interface LlmConfigHandlerDeps {
  /** 返回连接状态表；用函数而不是 Map，绑定到当前 runtime 而不会拿到旧副本 */
  clientState: () => Map<WebSocket, ClientState>;
}

export function createLlmConfigHandler(deps: LlmConfigHandlerDeps) {
  return async function handleLlmConfig(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'llmConfig' }>,
  ): Promise<void> {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    const send = (payload: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    if (msg.action === 'get') {
      send({ type: 'llmConfig', action: 'config', requestId, config: llmConfigStore.getPublic() });
      return;
    }

    if (msg.action === 'clear') {
      llmConfigStore.clear();
      send({ type: 'llmConfig', action: 'saved', requestId: requestId ?? '', ok: true });
      return;
    }

    const state = deps.clientState().get(ws) ?? freshClientState();
    const now = Date.now();
    if (now - state.lastLlmAt < LLM_RATE_LIMIT_MS) {
      send({ type: 'llmConfig', action: 'error', requestId, error: '操作过于频繁，请稍后再试' });
      return;
    }
    state.lastLlmAt = now;
    deps.clientState().set(ws, state);

    if (msg.action === 'discover') {
      if (typeof msg.baseUrl !== 'string' || msg.baseUrl.length > 500) {
        send({ type: 'llmConfig', action: 'error', requestId, error: 'Base URL 不合法' });
        return;
      }
      if (llmConfigStore.hasKeyForOtherOrigin(msg.baseUrl) && !(typeof msg.apiKey === 'string' && msg.apiKey.trim())) {
        send({
          type: 'llmConfig',
          action: 'error',
          requestId: msg.requestId,
          error: '目标地址与已保存配置不同源，请重新填写 API Key（已保存的密钥不会发往新地址）',
        });
        return;
      }
      try {
        const models = await discoverModels({
          protocol: msg.protocol,
          baseUrl: msg.baseUrl,
          apiKey: llmConfigStore.resolveKey(typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '', msg.baseUrl),
        });
        send({ type: 'llmConfig', action: 'discovered', requestId: msg.requestId, models });
      } catch (err) {
        send({ type: 'llmConfig', action: 'error', requestId, error: errorText(err) });
      }
      return;
    }

    if (msg.action === 'test') {
      if (typeof msg.baseUrl !== 'string' || typeof msg.model !== 'string' || !msg.model.trim()) {
        send({ type: 'llmConfig', action: 'error', requestId, error: '请先填写地址与模型' });
        return;
      }
      if (llmConfigStore.hasKeyForOtherOrigin(msg.baseUrl) && !(typeof msg.apiKey === 'string' && msg.apiKey.trim())) {
        send({
          type: 'llmConfig',
          action: 'error',
          requestId: msg.requestId,
          error: '目标地址与已保存配置不同源，请重新填写 API Key（已保存的密钥不会发往新地址）',
        });
        return;
      }
      const result = await testConnection({
        protocol: msg.protocol,
        baseUrl: msg.baseUrl,
        apiKey: llmConfigStore.resolveKey(typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '', msg.baseUrl),
        model: msg.model.trim(),
        maxOutput: typeof msg.maxOutput === 'number' ? msg.maxOutput : undefined,
        // 按用户选择的思考档位测试：缺省时测试与保存后的行为一致
        reasoningEffort: msg.reasoningEffort,
      });
      send({ type: 'llmConfig', action: 'tested', requestId: msg.requestId, result });
      return;
    }

    if (msg.action === 'save') {
      const parsed = sanitizeDraft(msg.draft);
      if (!parsed.ok) {
        send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: false, error: parsed.error });
        return;
      }
      const saved = llmConfigStore.save(parsed.draft);
      if (!saved.ok) {
        send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: false, error: saved.error });
        return;
      }
      send({ type: 'llmConfig', action: 'saved', requestId: msg.requestId, ok: true, config: saved.config });
      return;
    }

    send({ type: 'llmConfig', action: 'error', requestId, error: '未知的配置动作' });
  };
}

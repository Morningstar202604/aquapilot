import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { Answer } from '../shared/aiTypes';
import { canEditAgentConfig, type Role } from './auth';
import { agentConfigStore } from './agentConfig';
import { parseAgentCommand } from './agentConfigCommands';
import { MAX_LLM_IN_FLIGHT, type ClientState } from './rateLimit';
import { sanitizeChatText } from './validation';
import { metrics } from './observability';
import type { HookRuntime } from './hooks';

type ChatMessage = Extract<ClientMessage, { type: 'chat' }>;

export interface ChatHandlerDeps {
  send: (payload: ServerMessage) => void;
  role: Role;
  rateLimited: (kind: 'chat') => boolean;
  throttledNotice: (kind: string, text: string) => void;
  state: () => ClientState;
  saveState: (state: ClientState) => void;
  hooks: HookRuntime;
  ruleAnswer: (text: string) => Answer;
  enhance: (text: string, ruleAnswer: Answer) => Promise<void>;
}

/**
 * 聊天分支：配置命令优先，规则答案保底，LLM 增强异步追加。
 *
 * 从 server/index.ts 的 800 行 switch 抽出；只依赖注入的发送/限流/状态，
 * 不直接碰 runtime，便于用假的 deps 做分支测试。
 */
export function handleChatMessage(msg: ChatMessage, deps: ChatHandlerDeps): void {
  const text = sanitizeChatText((msg as { text?: unknown }).text);
  if (text === null) {
    deps.send({
      type: 'notice',
      level: 'error',
      text: '问题为空或过长（上限 2000 字）',
    });
    return;
  }
  /** 配置类回答统一外壳：四个分支此前各抄一份 chat/editor 消息体 */
  const sendEditorAnswer = (title: string, body: string, confidence = 0.95): void => {
    deps.send({
      type: 'chat',
      question: text,
      answer: { title, body, bullets: [], confidence, kind: 'editor', source: 'rule' },
    });
  };
  /**
   * 聊天限流：每条消息最多触发 4 次长超时出站 LLM 请求
   * （两套请求预算 × 数字校验失败后的整轮重试，推理模型单次 60 s）。
   * 不限流时一条连接即可堆满内存与第三方配额。
   */
  if (deps.rateLimited('chat')) {
    deps.throttledNotice('chat', '提问过于频繁，请稍后再试');
    return;
  }
  const chatState = deps.state();
  if (chatState.llmInFlight >= MAX_LLM_IN_FLIGHT) {
    metrics.rateLimited += 1;
    deps.send({
      type: 'notice',
      level: 'warn',
      text: '上一条回答仍在生成，请等它完成',
    });
    return;
  }
  // 对话式配置：命令先于规则引擎处理，命中即回执并不再走问答
  const agentCfgForChat = agentConfigStore.get();
  const cmd = parseAgentCommand(text, agentCfgForChat);
  if (cmd.handled) {
    if (cmd.next && !canEditAgentConfig(deps.role)) {
      sendEditorAnswer('配置未生效', '当前令牌无权修改 Agent 配置，需要 admin 权限。');
      return;
    }
    if (cmd.next) {
      const outcome = agentConfigStore.save(cmd.next, { writer: 'chat' });
      if (!outcome.ok) {
        sendEditorAnswer('配置未生效', outcome.error ?? '保存失败', 0.9);
        return;
      }
      void deps.hooks.fire(agentConfigStore.get(), {
        event: 'config',
        detail: cmd.command ?? 'chat',
        key: cmd.command,
      });
      const warn = outcome.warnings.length > 0 ? `\n（${outcome.warnings.join('；')}）` : '';
      sendEditorAnswer(`配置已更新 · ${cmd.command ?? 'chat'}`, `${cmd.reply ?? '已完成'}${warn}`);
    } else {
      sendEditorAnswer(cmd.error ? '命令未执行' : `配置查询 · ${cmd.command ?? 'list'}`, cmd.reply ?? '');
    }
    return;
  }

  const ruleAnswer = deps.ruleAnswer(text);
  deps.send({ type: 'chat', question: text, answer: ruleAnswer });

  /**
   * LLM 增强（可选，异步）。
   *
   * 先发规则答案保证「任何配置下都有回答」，再尝试 LLM 追问一条补充。
   * 失败只记指标，不打扰用户——用户已经看到可用答案。
   *
   * 在途计数必须成对增减：它保证单连接不会堆满长超时出站请求，
   * 漏掉 finally 会让一次超时永久占掉一个名额（最终把聊天卡死）。
   */
  const trackState = deps.state();
  trackState.llmInFlight += 1;
  deps.saveState(trackState);
  void deps.enhance(text, ruleAnswer).finally(() => {
    const cur = deps.state();
    if (cur) {
      cur.llmInFlight = Math.max(0, cur.llmInFlight - 1);
      deps.saveState(cur);
    }
  });
}

import type { WebSocket } from 'ws';
import { askLlm, readLlmConfig, type GroundingContext } from '../ai/llm';
import { answer } from '../ai/agent';
import { PLANT } from '../sim/config';
import { formatClockLong } from '../shared/time';
import type { ServerMessage } from '../shared/protocol';
import type { LlmPublicConfig } from '../shared/llm';
import { llmConfigStore } from './llmConfig';
import { agentConfigStore } from './agentConfig';
import { composeSystemPrompt } from '../ai/promptComposer';
import { metrics, logger } from './observability';
import { estimateMargin } from '../sim/metrics';
import type { NetworkSimState } from '../sim/networkEngine';
import type { Recommendation } from '../ai/agent';

/**
 * 对话增强：规则答案之后的可选模型补充。
 *
 * 从 server/index.ts 抽出的原因：这段逻辑包含 4 个真实坑——
 * ① 预算按 maxOutput 给会全部烧在 reasoning 上；
 * ② 推理模型需要更长超时；
 * ③ 数字白名单拦下后要做一次「零数字」重试；
 * ④ 任何失败都必须保留规则答案并可见。
 * 它和 WebSocket 编排、仿真循环没有耦合，单独成模块后可独立测试。
 */

export interface LlmChatDeps {
  snapshot: () => { net: NetworkSimState; recommendation: Recommendation | null };
  isOpen: (ws: WebSocket) => boolean;
  send: (ws: WebSocket, message: ServerMessage) => void;
}

/** 降级原因 → 界面可读文案（不暴露内部实现细节） */
export function reasonText(reason: string | null): string {
  switch (reason) {
    case 'not-configured':
      return '尚未配置模型';
    case 'timeout':
      return '模型响应超时，可换更快的模型或在模型设置里降低输出上限';
    case 'network-error':
      return '无法连接模型端点';
    case 'empty-response':
      return '模型没有返回内容';
    case 'ungrounded-numbers':
      return '回答包含未经数据支持的数字，已被事实校验拦下';
    default:
      return reason?.startsWith('http-') ? `模型端点返回 ${reason.slice(5)}` : '调用失败';
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : '请求失败';
}

/**
 * 把当前状态压成 LLM 可引用的最小事实集。
 *
 * 只放已经有数值的量，不放控制器写权限、不放日志、不放环境变量。
 */
export function buildLlmGrounding(s: NetworkSimState, rec: Recommendation | null): GroundingContext {
  const margins = estimateMargin(s.effluent);
  const facts: GroundingContext['facts'] = [
    { label: '进水流量', value: s.influent.flow.toFixed(0), unit: 'm³/h' },
    { label: '进水 COD', value: s.influent.cod.toFixed(0), unit: 'mg/L' },
    { label: '进水氨氮', value: s.influent.nh.toFixed(1), unit: 'mg/L' },
    { label: '出水 COD', value: s.effluent.cod.toFixed(1), unit: 'mg/L（限值 50）' },
    { label: '出水氨氮', value: s.effluent.nh.toFixed(2), unit: 'mg/L（限值 5）' },
    { label: '出水总氮', value: s.effluent.tn.toFixed(2), unit: 'mg/L（限值 15）' },
    { label: '出水总磷', value: s.effluent.tp.toFixed(3), unit: 'mg/L（限值 0.5）' },
    { label: '出水 SS', value: s.effluent.ss.toFixed(1), unit: 'mg/L（限值 10）' },
    { label: '最紧指标', value: margins[0]?.metric ?? '—', unit: `占限值 ${(margins[0]?.ratio ?? 0) * 100}%` },
    { label: '溶解氧设定', value: s.controls.doSetpoint.toFixed(1), unit: 'mg/L' },
    { label: '内回流比', value: s.controls.internalRecirc.toFixed(1), unit: '×Q' },
    { label: '污泥回流比', value: s.controls.rasRatio.toFixed(2), unit: '×Q' },
    { label: '污泥龄', value: s.srtDays.toFixed(1), unit: 'd' },
    { label: 'MLSS', value: ((s.biomassKg * 1000) / Math.max(1, s.volume.bio)).toFixed(0), unit: 'mg/L' },
    { label: '二沉池泥位', value: s.clarifier.blanketM.toFixed(2), unit: 'm' },
    { label: '吨水电耗', value: (s.energy.totalKw / Math.max(1, s.influent.flow)).toFixed(3), unit: 'kWh/m³' },
    { label: '活动场景', value: s.scenario ? s.scenario.type : '无' },
    { label: '活动告警数', value: s.alarms.filter((a) => s.timeMin - a.at < 60).length },
  ];
  return {
    plant: `${PLANT.name} · ${PLANT.code}`,
    simClock: formatClockLong(s.timeMin),
    facts,
    recommendation: rec ? rec.summary : null,
    risks: rec ? rec.risks : [],
  };
}

/** 模型链路预算：推理模型必须给足 token 与超时，否则正文永远为空 */
export function llmBudget(
  publicCfg: LlmPublicConfig | null,
  maxAnswerChars: number,
): { maxOutput: number; timeoutMs: number } {
  const reasoningModel = publicCfg?.capabilities.reasoning ?? false;
  const runtime = llmConfigStore.getRuntime();
  const thinkingOn = !runtime || runtime.reasoningEffort === 'auto' || runtime.reasoningEffort === 'low';
  const maxOutput =
    reasoningModel && thinkingOn ? 4096 : Math.min(4096, Math.max(512, Math.round(maxAnswerChars * 3 + 600)));
  const timeoutMs = reasoningModel && thinkingOn ? 60000 : 25000;
  return { maxOutput, timeoutMs };
}

export function createLlmChat(deps: LlmChatDeps) {
  return async function enhance(ws: WebSocket, question: string, ruleAnswer: ReturnType<typeof answer>): Promise<void> {
    const started = Date.now();
    const { net, recommendation } = deps.snapshot();
    const grounding = buildLlmGrounding(net, recommendation);
    const agentCfg = agentConfigStore.get();
    const composed = composeSystemPrompt({ config: agentCfg, question });
    const { maxOutput, timeoutMs } = llmBudget(llmConfigStore.getPublic(), agentCfg.constraints.maxAnswerChars);

    const saved = llmConfigStore.getRuntime();
    const config = saved
      ? {
          baseUrl: saved.baseUrl,
          apiKey: saved.apiKey,
          model: saved.model,
          timeoutMs,
          protocol: saved.protocol,
          maxOutput,
          reasoningEffort: saved.reasoningEffort,
        }
      : readLlmConfig();

    const result = await askLlm(question, grounding, config, composed.prompt);
    metrics.llmCalls += 1;

    if (!result.ok) {
      metrics.llmFallbacks += 1;
      logger.debug('llm fallback', { reason: result.reason, ms: Date.now() - started });
      /**
       * 数字白名单没通过时做一次「零数字」重试。
       *
       * 推理模型很容易写出「4 小时内」「87%」这类派生数字，被 fail-closed 拦下后
       * 用户看到的就是「没有模型补充」，却不知道原因。第二次明确要求不写任何
       * 未提供数字，绝大多数情况能拿到可用文本。
       */
      if (result.reason === 'ungrounded-numbers') {
        const strict = `${composed.prompt}

【最后一次机会】只允许使用数据中已出现的数字；不要写时长、百分比、温度、倍数等任何新增数值。宁可不写数字，也不要推算。`;
        const retry = await askLlm(question, grounding, config, strict);
        metrics.llmCalls += 1;
        if (!retry.ok) {
          metrics.llmFallbacks += 1;
          // 失败必须可见：否则「配置好了却没补充」无法自查。
          // 但连接已关闭时不能再写（会抛异常并打断调用链）。
          if (!deps.isOpen(ws)) return;
          deps.send(ws, {
            type: 'notice',
            level: 'warn',
            text: `模型补充未生成（${reasonText(result.reason)}），已保留规则答案。可在「自检」页查看链路状态。`,
          });
          return;
        }
        if (!deps.isOpen(ws)) return;
        deps.send(ws, {
          type: 'chat',
          question,
          answer: {
            ...ruleAnswer,
            title: `${ruleAnswer.title} · 模型补充`,
            body: retry.text,
            bullets: [],
            source: 'llm',
            persona: agentCfg.persona.name,
            matchedSkills: composed.matchedSkills,
          },
        });
        return;
      }
      if (!deps.isOpen(ws)) return;
      deps.send(ws, {
        type: 'notice',
        level: 'warn',
        text: `模型补充未生成（${reasonText(result.reason)}），已保留规则答案。`,
      });
      return;
    }
    if (!deps.isOpen(ws)) return;
    deps.send(ws, {
      type: 'chat',
      question,
      answer: {
        ...ruleAnswer,
        title: `${ruleAnswer.title} · 模型补充`,
        body: result.text,
        bullets: [],
        source: 'llm',
        persona: agentCfg.persona.name,
        matchedSkills: composed.matchedSkills,
      },
    });
  };
}

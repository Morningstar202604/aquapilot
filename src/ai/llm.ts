/**
 * 可选的 LLM 对话适配层。
 *
 * 定位：规则引擎（agent.answer）保证「永远有一个基于当前状态的答案」；
 * LLM 只负责把同一份状态数据组织成更自然的语言。因此这里的设计是
 * fail-closed + 数字白名单：
 *
 * 1. 未配置 AQUAPILOT_LLM_BASE_URL / MODEL 时不发起任何网络请求；
 * 2. 只发送「已计算的快照摘要」，不把令牌、原始日志或控制写权限交给模型；
 * 3. 回答里的数字必须在摘要里出现过（或由摘要派生），否则退回规则引擎；
 * 4. 超时 8 秒、单次最多 500 token，失败即降级，不阻塞 WebSocket。
 *
 * 用 OpenAI 兼容的 /chat/completions 协议而不是某个厂商 SDK：
 * 这样 DeepSeek、GLM、Qwen、Ollama、vLLM 都能直接接，不新增依赖。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface GroundingFact {
  label: string;
  value: number | string;
  unit?: string;
}

export interface GroundingContext {
  plant: string;
  simClock: string;
  facts: GroundingFact[];
  recommendation: string | null;
  risks: string[];
}

export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const baseUrl = env.AQUAPILOT_LLM_BASE_URL?.trim();
  const model = env.AQUAPILOT_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.AQUAPILOT_LLM_API_KEY?.trim() ?? '',
    model,
    timeoutMs: Number(env.AQUAPILOT_LLM_TIMEOUT_MS ?? 8000),
  };
}

export function buildGroundingText(context: GroundingContext): string {
  const facts = context.facts.map((f) => `- ${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ''}`).join('\n');
  return [
    `厂站：${context.plant}`,
    `仿真时钟：${context.simClock}`,
    '当前实测与预测数据（唯一可引用的事实来源）：',
    facts,
    context.recommendation ? `当前 AI 建议：${context.recommendation}` : '当前没有待执行的建议。',
    context.risks.length ? `风险提示：${context.risks.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const SYSTEM_PROMPT = [
  '你是污水处理厂的 AI 值班员，用简洁、专业的中文回答操作员的问题。',
  '规则：',
  '1. 只能使用用户消息中给出的数据；不得推算未给出的数字，不得编造仪表读数。',
  '2. 如果数据不足以回答，直接说明缺什么，不要猜测。',
  '3. 回答控制在 180 字以内，先给结论，再给依据。',
  '4. 不要输出 Markdown 标题、表格或代码块。',
].join('\n');

/**
 * 数字白名单校验。
 *
 * 取回答中所有数值，逐个与「grounding 文本里出现的数值」比对：
 * 允许 5% 相对误差（模型可能把 0.59 写成 0.6 或做四舍五入），
 * 但一个完全不存在于数据里的数量级（如凭空出现 42.0）会被拒绝。
 */
export function numbersAreGrounded(answer: string, grounding: string, tolerance = 0.05): boolean {
  const extract = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = extract(grounding);
  if (known.length === 0) return false;
  const allowed = new Set<number>(known);
  for (const n of extract(answer)) {
    if (allowed.has(n)) continue;
    const near = known.some((k) => Math.abs(k - n) <= Math.max(Math.abs(k) * tolerance, 0.05));
    if (!near) return false;
  }
  return true;
}

export interface LlmAnswer {
  ok: boolean;
  text: string;
  /** 失败原因，成功时为 null；只用于日志，不返回给浏览器 */
  reason: string | null;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * 调用 OpenAI 兼容端点。永不抛出：失败返回 { ok:false }，调用方降级。
 *
 * 不记录 apiKey，也不把请求体写日志（其中可能包含运行数据）。
 */
export async function askLlm(
  question: string,
  context: GroundingContext,
  config: LlmConfig | null = readLlmConfig(),
): Promise<LlmAnswer> {
  if (!config) return { ok: false, text: '', reason: 'not-configured' };
  const grounding = buildGroundingText(context);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${grounding}\n\n操作员问题：${question}` },
        ],
      }),
    });
    if (!res.ok) return { ok: false, text: '', reason: `http-${res.status}` };
    const json = (await res.json()) as ChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) return { ok: false, text: '', reason: 'empty-response' };
    if (!numbersAreGrounded(text, grounding)) {
      return { ok: false, text: '', reason: 'ungrounded-numbers' };
    }
    return { ok: true, text, reason: null };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network-error';
    return { ok: false, text: '', reason };
  } finally {
    clearTimeout(timer);
  }
}

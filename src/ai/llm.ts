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
 * 界面上另行支持 Anthropic Messages 与 Google Gemini，由 providers.ts 承担。
 */

import type { LlmProtocol } from '../shared/llm';
import { chatComplete } from './providers';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 缺省按 OpenAI 兼容处理，保持既有环境变量行为不变 */
  protocol?: LlmProtocol;
  maxOutput?: number;
  /** 推理强度：auto 不干预；low 压低思考；off 关闭思考 */
  reasoningEffort?: 'auto' | 'low' | 'off';
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
 * 规则演进（真实使用反馈）：
 * 最早只允许「字面出现在 grounding 里的数字」，结果模型只要写一句
 * 「去除率约 89.6%」就被整条拒绝——而 89.6 完全是从 337 与 35 推出来的，
 * 这在事实层面是正确的。过度严格等于把可用回答全挡掉。
 *
 * 现在的判定分三层：
 * 1. 字面命中（含 5% 相对误差，容忍四舍五入）；
 * 2. 派生命中：任意两个已知数之间的和/差/比值/百分比/变化率；
 * 3. 结构性小整数：0–12 视为「几步、几小时、几号池」这类计数，不是测量值。
 *
 * 真正会伤人的凭空量级（如氨氮 42.7）仍然会被拒。
 */
/**
 * 数字是否出现在「计数语境」里。
 *
 * 允许：「分 3 步执行」「停 2 小时」「1 号池」
 * 拒绝：「出水氨氮 9 mg/L」「总磷 0.9」「去除率 12%」
 * ——后者带测量单位，必须走字面/派生命中。
 */
const COUNT_UNITS = /^(步|个|小时|分钟|秒|次|号|项|台|座|池|层|条|组|轮|天)/;
const PERCENT_UNITS = /^(%|％|个百分点)/;

/** 取某个数字后面紧跟的单位类型：percent / measure / count / none */
function unitAfter(answer: string, n: number): 'percent' | 'measure' | 'count' | 'none' {
  const re = new RegExp(`${n}\\s*([^\\s，。；、]{1,6})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const unit = m[1].trim();
    if (!unit) continue;
    if (PERCENT_UNITS.test(unit)) return 'percent';
    if (MEASURE_UNITS.test(unit)) return 'measure';
    if (COUNT_UNITS.test(unit)) return 'count';
  }
  return 'none';
}
const MEASURE_UNITS = /(mg\/L|mg|g\/m3|g\/m³|%|％|℃|°C|m³|m3|kWh|kW|m\/d|m\/h|d|h|倍|元)/;

function isCountContext(answer: string, n: number): boolean {
  const re = new RegExp(`${n}\\s*([^\\s，。；、]{1,3})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const unit = m[1].trim();
    if (!unit) continue;
    if (COUNT_UNITS.test(unit)) return true;
    if (MEASURE_UNITS.test(unit)) return false;
  }
  return false;
}

export function numbersAreGrounded(answer: string, grounding: string, tolerance = 0.05): boolean {
  const extract = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = extract(grounding);
  if (known.length === 0) return false;
  const allowed = new Set<number>(known);
  /**
   * 比值/百分比派生单独一组。
   *
   * 和与差的问题：grounding 里有「第 1 天」和「限值 10」，两者相减得 9，
   * 于是凭空写出的「出水氨氮 9 mg/L」被当成合法派生值放行——9 甚至正是
   * 超标读数。两个不相关量之间的和差没有物理意义，只有比值/占比才是
   * 模型真正会在回答里计算的派生量，因此整数只允许从比值类派生命中。
   */
  const ratioAllowed = new Set<number>();
  for (const a of known) {
    for (const b of known) {
      if (a === b) continue;
      allowed.add(a + b);
      allowed.add(Math.abs(a - b));
      // 除零会产出 Infinity，而 Infinity 与任何数比较都成立——
      // 曾经因为这一点，凭空出现的 42.7 被"近似匹配"放行。
      //
      // 只保留「人话里真会出现的派生值」：比值与百分比变化。
      // 曾把 a/b*100 也放进白名单，结果 337/35*100≈962 让 999.9 这类
      // 凭空数字"近似命中"，所以这类跨量级派生直接不收。
      if (b !== 0 && Math.abs(a / b) <= 20) {
        allowed.add(a / b);
        ratioAllowed.add(a / b);
        // 「占限值的 87%」是最高频的派生值：8.7 / 10 × 100。
        // 只在 a ≤ b（真正的"占比"）时收录，否则 337/35*100≈962 这类
        // 跨量级乘积会把 999.9 之类的凭空数字吸附成"近似命中"。
        if (Math.abs(a) <= Math.abs(b)) {
          allowed.add((a / b) * 100);
          ratioAllowed.add((a / b) * 100);
        }
      }
      if (b !== 0) {
        allowed.add(((a - b) / b) * 100);
        ratioAllowed.add(((a - b) / b) * 100);
      }
      if (a !== 0) {
        allowed.add(((b - a) / a) * 100);
        allowed.add(((a - b) / a) * 100);
        ratioAllowed.add(((b - a) / a) * 100);
        ratioAllowed.add(((a - b) / a) * 100);
      }
    }
  }
  const derived = [...allowed].filter((v) => !known.includes(v));
  const derivedRatio = [...ratioAllowed].filter((v) => !known.includes(v));
  for (const n of extract(answer)) {
    // 1) 字面命中，允许四舍五入的 5% 相对误差
    if (known.some((k) => Math.abs(k - n) <= Math.max(Math.abs(k) * tolerance, 0.05))) continue;
    /**
     * 2) 派生命中：只接受近似精确的匹配。
     * 这里放宽到 0.5% 会误放「100 vs 99.9」这类相邻量级；
     * 0.05% 相对 + 0.005 绝对既容得下四舍五入（89.6 vs 89.614），
     * 又不会把凭空数字吸附到 100 这类整数派生值上。
     */
    /**
     * 2a) 派生命中：小数形态的派生值（89.6、1.234）任何来源都接受。
     * 2b) 整数形态只接受比值/占比类派生（87% 这类「占限值多少」）。
     *     纯整数且只能由和差得到时一律拒绝，避免 10−1=9 这类伪命中。
     */
    /**
     * 派生匹配必须看**数字出现的语境**。
     *
     * 只有「百分数」语境允许用比值类派生（去除率 89.6%、占限值 87%）。
     * 带浓度/流量/电量等测量单位的读数必须字面命中：grounding 是扁平的数字
     * 序列，跨量纲相除会造出伪派生值（1.20 / 10 × 100 = 12，于是凭空写出的
     * 「出水 SS 12 mg/L」被当成合法派生），而 12 恰好可能是超标读数。
     */
    const near = (k: number) => Math.abs(Math.abs(k) - Math.abs(n)) <= Math.max(Math.abs(k) * 0.0005, 0.005);
    const unit = unitAfter(answer, n);
    if (unit === 'percent') {
      // 百分数只承认比值/占比类派生：和差同样会造出伪命中
      if (derivedRatio.some(near)) continue;
    } else if (unit === 'measure') {
      // 测量值只承认字面命中（已在第 1 步处理），派生一律不认
      return false;
    } else if (Number.isInteger(n) ? derivedRatio.some(near) : derived.some(near)) {
      continue;
    }
    /**
     * 3) 结构性小整数：只放行「计数语境」，不是无条件放行。
     *
     * 旧实现无条件接受 0–12 的整数，于是「出水氨氮 9 mg/L」「总磷 0.9」
     * 这类凭空读数直接通过——事实校验形同虚设（9 甚至正是超标值）。
     * 现在要求该数字紧跟计数单位（步/个/小时/分钟/次/号池…），
     * 且不能带浓度或比例单位。
     */
    if (Number.isInteger(n) && n >= 0 && n <= 12 && isCountContext(answer, n)) continue;
    return false;
  }
  return true;
}

export interface LlmAnswer {
  ok: boolean;
  text: string;
  /** 失败原因，成功时为 null；只用于日志，不返回给浏览器 */
  reason: string | null;
}

/**
 * 调用已配置的端点。永不抛出：失败返回 { ok:false }，调用方降级。
 *
 * 不记录 apiKey，也不把请求体写日志（其中可能包含运行数据）。
 * 协议由 config.protocol 决定（缺省 OpenAI 兼容），三协议共用 providers.ts 的适配层。
 */
export async function askLlm(
  question: string,
  context: GroundingContext,
  config: LlmConfig | null = readLlmConfig(),
  systemPrompt: string = SYSTEM_PROMPT,
): Promise<LlmAnswer> {
  if (!config) return { ok: false, text: '', reason: 'not-configured' };
  const grounding = buildGroundingText(context);
  const result = await chatComplete(
    {
      protocol: config.protocol ?? 'openai',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxOutput: config.maxOutput ?? 500,
      reasoningEffort: config.reasoningEffort ?? 'auto',
    },
    systemPrompt,
    `${grounding}\n\n操作员问题：${question}`,
    config.timeoutMs,
  );
  if (!result.ok) return { ok: false, text: '', reason: result.reason };
  const text = result.text.trim();
  if (!text) return { ok: false, text: '', reason: 'empty-response' };
  if (!numbersAreGrounded(text, grounding)) {
    return { ok: false, text: '', reason: 'ungrounded-numbers' };
  }
  return { ok: true, text, reason: null };
}

import * as v from 'valibot';

/**
 * 客户端消息的 schema 校验（valibot）。
 *
 * 为什么替换手写校验：
 * 手写版 `sanitizeMessage` 只检查 `type` 是字符串，分支内的字段靠调用方各自
 * 判断。审查实测有三处真实缺口：
 *   - `scenario.kind` 未校验：任意值都按 start 分支处理；
 *   - `sim.action` 未校验：非法动作仅广播一次 simState，静默成功；
 *   - `llmConfig.protocol` 未校验：未知值落入 Google 适配分支。
 * 这些都不是"风格问题"——它们让非法输入以合法身份穿过信任边界。
 *
 * 为什么选 valibot 而不是 zod：本场景是对象字段校验，valibot 的体积约
 * 1.8 MB（zod 6.1 MB），且按 schema 树摇，服务端打包只带上用到的部分。
 *
 * 设计原则：**宽松解析 + 明确拒绝**。不在 schema 里做业务夹紧（那是
 * validation.ts 里 CONTROL_BOUNDS/SCENARIO_MAGNITUDE_RANGE 的职责），
 * 这里只回答"这条消息的结构是否可被信任"。
 */

const FiniteNumber = v.pipe(v.number(), v.finite());
const BoundedText = (max: number) => v.pipe(v.string(), v.maxLength(max));

/** 控制量补丁：只允许已知键，值必须是有限数（范围由业务层夹紧） */
const ControlPatch = v.partial(
  v.object({
    doSetpoint: FiniteNumber,
    internalRecirc: FiniteNumber,
    rasRatio: FiniteNumber,
    wasRatio: FiniteNumber,
    pacDose: FiniteNumber,
    carbonDose: FiniteNumber,
    alkDose: FiniteNumber,
    stormStore: FiniteNumber,
    stepFeed: FiniteNumber,
  }),
);

const Protocol = v.picklist(['openai', 'anthropic', 'google']);

export const ClientMessageSchema = v.variant('type', [
  v.object({ type: v.literal('hello') }),
  v.object({ type: v.literal('chat'), text: BoundedText(2000) }),
  v.object({ type: v.literal('control'), patch: ControlPatch }),
  v.object({ type: v.literal('aiEnabled'), enabled: v.boolean() }),
  v.object({ type: v.literal('applyRecommendation') }),
  v.object({
    type: v.literal('scenario'),
    kind: v.picklist(['start', 'clear']),
    scenario: v.optional(v.string()),
    durationMin: v.optional(FiniteNumber),
    magnitude: v.optional(FiniteNumber),
  }),
  v.object({
    type: v.literal('sim'),
    action: v.picklist(['pause', 'resume', 'reset']),
  }),
  v.object({ type: v.literal('speed'), value: FiniteNumber }),
  v.object({ type: v.literal('refreshDecision') }),
  v.object({ type: v.literal('preset'), id: BoundedText(64) }),
  v.variant('action', [
    v.object({ type: v.literal('topology'), action: v.literal('get') }),
    v.object({ type: v.literal('topology'), action: v.literal('history'), requestId: v.optional(v.string()) }),
    v.object({ type: v.literal('topology'), action: v.literal('revert'), revision: FiniteNumber }),
    v.object({ type: v.literal('topology'), action: v.literal('apply'), topology: v.unknown() }),
  ]),
  v.variant('action', [
    v.object({ type: v.literal('llmConfig'), action: v.literal('get'), requestId: v.optional(v.string()) }),
    v.object({
      type: v.literal('llmConfig'),
      action: v.literal('discover'),
      requestId: v.string(),
      protocol: Protocol,
      baseUrl: BoundedText(500),
      apiKey: v.optional(BoundedText(500)),
    }),
    v.object({
      type: v.literal('llmConfig'),
      action: v.literal('test'),
      requestId: v.string(),
      protocol: Protocol,
      baseUrl: BoundedText(500),
      apiKey: v.optional(BoundedText(500)),
      model: BoundedText(200),
      maxOutput: v.optional(FiniteNumber),
    }),
    v.object({
      type: v.literal('llmConfig'),
      action: v.literal('save'),
      requestId: v.string(),
      draft: v.unknown(),
    }),
    v.object({ type: v.literal('llmConfig'), action: v.literal('clear'), requestId: v.string() }),
  ]),
  v.variant('action', [
    v.object({ type: v.literal('agentConfig'), action: v.literal('get'), requestId: v.optional(v.string()) }),
    v.object({
      type: v.literal('agentConfig'),
      action: v.literal('save'),
      requestId: v.string(),
      config: v.unknown(),
    }),
    v.object({
      type: v.literal('agentConfig'),
      action: v.literal('patch'),
      requestId: v.string(),
      patch: v.unknown(),
    }),
    v.object({ type: v.literal('agentConfig'), action: v.literal('reset'), requestId: v.string() }),
    v.object({
      type: v.literal('agentConfig'),
      action: v.literal('importSkill'),
      requestId: v.string(),
      skill: v.object({
        name: v.optional(BoundedText(80)),
        description: v.optional(BoundedText(200)),
        triggers: v.optional(v.array(BoundedText(24))),
        content: v.optional(BoundedText(12000)),
        url: v.optional(BoundedText(500)),
      }),
    }),
    v.object({
      type: v.literal('agentConfig'),
      action: v.literal('previewPrompt'),
      requestId: v.string(),
      question: v.optional(BoundedText(200)),
      config: v.optional(v.unknown()),
    }),
  ]),
  v.object({ type: v.literal('watchdog'), action: v.literal('get'), requestId: v.optional(v.string()) }),
  v.object({
    type: v.literal('analysis'),
    action: v.literal('run'),
    requestId: v.string(),
    horizonMin: v.optional(FiniteNumber),
  }),
  v.variant('action', [
    v.object({ type: v.literal('influent'), action: v.literal('get'), requestId: v.string() }),
    v.object({
      type: v.literal('influent'),
      action: v.literal('load'),
      requestId: v.string(),
      name: BoundedText(80),
      csv: v.pipe(v.string(), v.maxLength(2 * 1024 * 1024)),
    }),
    v.object({ type: v.literal('influent'), action: v.literal('apply'), requestId: v.string() }),
    v.object({ type: v.literal('influent'), action: v.literal('clear'), requestId: v.string() }),
  ]),
  v.variant('action', [
    v.object({ type: v.literal('calibration'), action: v.literal('identify'), requestId: v.string() }),
    v.object({
      type: v.literal('calibration'),
      action: v.literal('start'),
      requestId: v.string(),
      maxIterations: v.optional(FiniteNumber),
    }),
    v.object({ type: v.literal('calibration'), action: v.literal('cancel'), requestId: v.string() }),
  ]),
]);

export type ParsedClientMessage = v.InferOutput<typeof ClientMessageSchema>;

export type ParseResult = { ok: true; message: ParsedClientMessage } | { ok: false; error: string };

/**
 * 解析一条 WS 消息。
 *
 * 与手写版的行为差异（都是修复，不是收紧）：
 * - `scenario.kind` 越界 → 直接拒绝，不再当成 start；
 * - `sim.action` 越界 → 直接拒绝，不再静默成功；
 * - `llmConfig.protocol` 越界 → 直接拒绝，不再落入默认分支；
 * - `chat.text` 超长 → 由 schema 拒绝（此前在分支里二次判断）。
 *
 * 错误信息只回字段路径与简述，不回显用户输入（避免把注入内容反射回去）。
 */
export function parseClientMessage(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '消息必须是对象' };
  }
  const result = v.safeParse(ClientMessageSchema, raw);
  if (result.success) return { ok: true, message: result.output };
  const first = result.issues[0];
  const path = first?.path?.map((p) => String(p.key)).join('.') ?? '';
  /**
   * 错误文案只给字段路径与类别，**不回显收到的值**。
   *
   * valibot 默认消息形如 `Expected (...) but received "kill"`，
   * 把客户端输入原样回射：轻则回显注入串，重则让日志带上攻击载荷。
   * 这里按 issue 类型收敛成固定措辞。
   */
  const kind: string = first?.type ?? 'invalid_type';
  const reason =
    kind === 'invalid_type' || kind === 'literal' || kind === 'picklist' || kind === 'variant'
      ? '类型或取值不在允许范围内'
      : kind === 'max_length'
        ? '超出长度上限'
        : kind === 'finite'
          ? '必须是有限数值'
          : '校验未通过';
  return { ok: false, error: path ? `字段 ${path}：${reason}` : reason };
}

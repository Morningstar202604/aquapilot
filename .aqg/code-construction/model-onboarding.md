---
task_slug: model-onboarding
path: plan
created_at: 2026-10-25T18:40:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — model-onboarding

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 读既有约定：协议集中在 shared/protocol.ts、服务端校验在 server/validation.ts、LLM 适配层 ai/llm.ts 只用 OpenAI 兼容 + fail-closed、WS 是唯一写通道、组件测试用 jsdom + testing-library | `src/ai/llm.ts:1-140`、`src/server/validation.ts:1-90`、`src/client/components/AuthGate.tsx:1-60`、`tests/components.test.tsx:1-40` | rg 命中 provider 仅 llm.ts/README/.env.example；现有 395 tests 全绿 |
| 2. Behavior Lock | yes | 先写失败测试：三协议模型发现/连接测试/能力推断/SSRF 守卫、配置存储与脱敏、设置面板自动拉模型+展开+测试+保存（covers: R1, R2, R3, R4, R5） | `tests/llmProviders.test.ts`、`tests/llmConfig.test.ts`、`tests/modelSettings.test.tsx` | 先 RED 后 GREEN，见第 5 步 |
| 3. Thin Slice | yes | 每个切片一条链路：协议适配层 → 配置存储 → WS 协议 → 设置面板 → 顶栏入口；不改仿真/决策引擎 | `src/ai/providers.ts`、`src/server/llmConfig.ts`、`src/client/components/ModelSettingsPanel.tsx` | 不实现工具调用执行、不做多供应商并行路由 |
| 4. Construction Rules | yes | 复用内置 fetch（零新依赖）；URL 只在服务端校验；错误统一映射为可读中文；配置原子写 + 密钥不回传 | `src/ai/providers.ts`、`src/server/llmConfig.ts` | 运行时依赖仍为 echarts/react/react-dom/ws |
| 5. Local Verification | yes | 聚焦测试 → 全量 tests → typecheck → lint → build → 浏览器真实鼠标键盘验收 | `tests/llmProviders.test.ts` | 见收尾记录 |
| 6. Self Review (5 axes) | yes | 正确性：分协议请求/解析各有测试；可读性：适配层单文件纯函数；架构：UI→WS→server→providers 单向；安全：SSRF 守卫、密钥脱敏、日志不落 key；性能：模型探测 10s 超时、测试 30s 超时、面板按需请求 | `src/ai/providers.ts`、`src/server/llmConfig.ts`、`src/server/index.ts` | 人工复核 diff |

## Behavior Contract

### R1: Model discovery per protocol
The system MUST list available models for OpenAI-compatible, Anthropic and Google endpoints after the user supplies a base URL and API key.

- Scenario S1.1: OpenAI-compatible discovery
  - GIVEN a reachable `/models` endpoint
  - WHEN the user submits base URL and key
  - THEN the UI shows every returned model with its id

### R2: Capabilities auto-match with override
The system MUST fill context window and capability flags automatically for the selected model, and SHALL let the user override them.

- Scenario S2.1: metadata present
  - GIVEN a model advertised with context_window and max_output
  - WHEN the user selects it
  - THEN those numbers are shown as auto-matched values
- Scenario S2.2: user override
  - GIVEN auto-matched capabilities
  - WHEN the user enables custom capabilities and edits a value
  - THEN the edited value is what gets saved

### R3: Connection test
The system MUST provide a connection test that performs a real chat request and reports success or a readable failure.

- Scenario S3.1: valid credentials
  - GIVEN a valid endpoint, key and model
  - WHEN the user clicks 连接测试
  - THEN the UI reports success with latency and the model reply
- Scenario S3.2: invalid key
  - GIVEN an invalid key
  - WHEN the user clicks 连接测试
  - THEN the UI reports an authentication failure and stays usable

### R4: Config persists and drives chat
The system MUST persist a saved configuration and MUST use it for LLM chat answers without restarting the server.

- Scenario S4.1: save then chat
  - GIVEN a saved model configuration
  - WHEN the operator asks a question
  - THEN an LLM answer is attempted with that model and falls back to rules on failure

### R5: Secrets stay server-side
The system MUST NOT return the API key to the browser after saving and MUST NOT log it.

- Scenario S5.1: reload panel
  - GIVEN a saved key
  - WHEN the settings panel is reopened
  - THEN only a masked key and a hasKey flag are shown

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README.md:138 / README.zh-CN.md:120 / docs/API.md:175 / CHANGELOG.md:8 均描述同一套 `llmConfig` 契约，避免文档与实现漂移 |

## Predicted Objections

1. **Objection**: 服务端接受任意 baseUrl，可能被用来访问内网元数据服务（SSRF） (`src/ai/providers.ts:44`) — **Mitigation**: `assertSafeBaseUrl` 拒绝非 http(s)、URL 内嵌凭据、169.254.169.254/link-local 与 metadata 主机，并写单测 `tests/llmProviders.test.ts`。
2. **Objection**: 密钥可能通过 WS 回传或写入日志 (`src/server/llmConfig.ts:120`) — **Mitigation**: 公开视图只返回 `apiKeyMasked`+`hasKey`，保存与探测路径不写日志；单测断言 get 结果不含明文 key。
3. **Objection**: 自动拉模型在每次击键触发会打爆第三方接口 (`src/client/components/ModelSettingsPanel.tsx:76`) — **Mitigation**: 700ms 防抖 + 同签名去重 + 服务端 1s 限流，组件测试验证只调用一次。
4. **Objection**: 推理模型（如 u2-flash）小 max_tokens 下 content 为空，会把连接测试误判为失败 (`src/ai/providers.ts:213`) — **Mitigation**: 测试请求 512 token，空 content 且 finish_reason=length 时重试一次并把预算提到 2048；单测覆盖空 content 分支。
5. **Objection**: 新协议请求/响应形状解析错误会让聊天静默降级 (`src/ai/llm.ts:110`) — **Mitigation**: `chatComplete` 三协议各写解析单测，失败返回 reason 并保留规则引擎答案（既有 `askLlm` 契约不变）。

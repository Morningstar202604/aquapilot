---
task_slug: agent-settings
path: plan
created_at: 2026-10-25T19:55:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: "本次仅更新 AQG 台账验证证据，不含代码改动；代码与 objections 已在 e4225a9 提交审查"
behavior_contract_exception: null
---

# AQG Code Construction Ledger — agent-settings

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 既有约定：协议集中在 shared/protocol.ts，服务端校验在 validation.ts，配置持久化参考 server/llmConfig.ts 的原子写 + 0600，WS 是唯一写通道，测试用 vitest + jsdom | `src/server/llmConfig.ts:1`、`src/shared/protocol.ts:94`、`src/server/validation.ts:1`、`tests/modelSettings.test.tsx:1` | rg 确认无既有 agent 配置/钩子/技能实现；基线 446 tests 全绿 |
| 2. Behavior Lock | yes | 先写测试：配置校验与权限（readonly/standard/open）、Webhook 仅 open、核心项不可改、技能匹配与提示词合成、对话命令解析、钩子去重、设置面板交互（covers: R1, R2, R3, R4, R5, R6） | `tests/agentConfig.test.ts`、`tests/agentConfigStore.test.ts`、`tests/configCommands.test.ts`、`tests/promptComposer.test.ts`、`tests/agentSettings.test.tsx` | 先 RED 后 GREEN，见第 5 步 |
| 3. Thin Slice | yes | 每个切片一条链路：共享 schema → 文件存储/热加载 → 提示词与约束生效 → 钩子事件 → WS/对话/CLI → 设置面板 | `src/shared/agentConfig.ts`、`src/server/agentConfig.ts`、`src/ai/promptComposer.ts`、`src/server/hooks.ts`、`src/server/agentConfigCommands.ts` | 不实现任意脚本执行，钩子只做声明式动作 |
| 4. Construction Rules | yes | 复用既有 atomic write、CONTROL_BOUNDS、assertSafeBaseUrl、metrics/logger；零新依赖；未知字段忽略并 warn；核心项不进 schema | `src/shared/agentConfig.ts`、`src/server/agentConfig.ts` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | 聚焦测试 → 全量 tests → typecheck → lint → prettier → build → 浏览器真实鼠标键盘验收（面板六页 + 对话命令 + 约束拦截 + 拖拽 + CLI 热加载） | `tests/agentConfig.test.ts`、`tests/agentConfigStore.test.ts`、`tests/configCommands.test.ts`、`tests/promptComposer.test.ts`、`tests/hooks.test.ts`、`tests/agentSettings.test.tsx`、`tests/watchdog.test.ts` | `npx vitest run` 570 passed / 37 files；`tsc --noEmit` 0；`eslint src tests` 0；`prettier --check` 通过；`npm run build` 成功；UI：角色改名/语气切换/提示词预览/技能新增/钩子/约束/权限六页全部操作成功，保存后落盘 `data/agent-config.json`；对话命令 `设置角色`/`添加技能`/`列出技能`/`约束 允许控制` 全部生效；手动拖 PAC 被服务端拒绝并提示；编排视图新增单元/改名/撤销/校验阻断/应用拓扑/1:1 拖拽平移；CLI `set-persona` 写入后服务端热加载（WS 读回 updatedBy=cli）；webhook 钩子对活服务端点实测 200；控制滑块拖动后 `/api/snapshot` 读到 internalRecirc=2.5（界面 3.3 → AI 在优先期后接管回调）；场景按钮注入暴雨后服务端 scenario.type=storm、stormStorage≈1000 m³；三个导出端点 200 + 正确 content-type |
| 6. Self Review (5 axes) | yes | 正确性：权限与核心项双端校验；可读性：schema/存储/命令/钩子分文件；架构：UI→WS→server→store 单向；安全：钩子无任意脚本、Webhook SSRF 守卫、配置不含密钥；性能：配置 mtime 缓存、钩子 5 分钟去重 | `src/shared/agentConfig.ts`、`src/server/hooks.ts`、`src/client/components/AgentSettingsPanel.tsx` | 人工复核 diff |

## Behavior Contract

### R1: Permission levels gate edits
The system MUST reject configuration writes at `readonly` level and MUST allow `standard` and `open` with different capabilities.

- Scenario S1.1: readonly
  - GIVEN the stored permission level is `readonly`
  - WHEN any UI/chat/CLI save is attempted
  - THEN the save is rejected with a readable reason

### R2: Core protections are immutable
The system MUST keep effluent limits, safety guardrails, auth, secrets and engine kinetics outside the editable configuration surface.

- Scenario S2.1: attempt to inject core fields
  - GIVEN a payload containing `limits` or `core`
  - WHEN it is saved at any permission level
  - THEN those fields are ignored and a warning is returned

### R3: Persona and prompts reach the model
The system MUST compose the LLM system prompt from persona, enabled prompt blocks, constraints and matching skills.

- Scenario S3.1: chat with persona
  - GIVEN a saved persona and enabled prompt block
  - WHEN the operator asks a question
  - THEN the outgoing system prompt contains both

### R4: Constraints constrain control writes and AI moves
The system MUST reject manual control patches for keys outside `allowedControls` and MUST clamp AI control moves to `maxStepPct`.

- Scenario S4.1: forbidden control key
  - GIVEN `allowedControls` excludes `pacDose`
  - WHEN a manual patch sets `pacDose`
  - THEN the server rejects it with a readable reason

### R5: Hooks fire on runtime events
The system MUST evaluate enabled hooks on alarm/decision/chat/config events with a dedupe window, and MUST allow webhook actions only at `open` level.

- Scenario S5.1: alarm hook
  - GIVEN an enabled alarm hook matching a new alarm code
  - WHEN the alarm appears
  - THEN a notice is broadcast once per dedupe window

### R6: Config changes apply from UI, chat, CLI and file
The system MUST apply a valid configuration immediately from the settings dialog, chat commands, the CLI, or a direct file edit.

- Scenario S6.1: CLI while server runs
  - GIVEN a running server
  - WHEN the CLI writes a valid config
  - THEN the server hot-reloads it and broadcasts the new config

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README.md:138 / README.zh-CN.md:120 / docs/API.md:213 / CHANGELOG.md:8 / .env.example:44 描述同一套 `agentConfig` + 钩子 + 自检契约，避免文档漂移 |

## Predicted Objections

1. **Objection**: 钩子可能变成任意代码执行入口 (`src/server/hooks.ts:1`) — **Mitigation**: 只支持 notice/log/webhook/skill 四种声明式动作，不执行 shell；webhook 走 `assertSafeBaseUrl`，单测覆盖。
2. **Objection**: 配置热加载可能读到写了一半的文件 (`src/server/agentConfig.ts:1`) — **Mitigation**: 写入走 staging + rename 原子替换，读取 JSON 失败保留上一份并在日志里 warn，单测覆盖损坏文件。
3. **Objection**: 权限检查只在 UI 做会被 WS 直接绕过 (`src/server/agentConfig.ts:120`) — **Mitigation**: store.save 在服务端统一校验 readonly/standard/open 与核心项，UI/chat/CLI 共用同一入口，单测覆盖。
4. **Objection**: 技能内容过长或过多会撑爆提示词 (`src/ai/promptComposer.ts:1`) — **Mitigation**: 单技能 ≤12000 字、最多匹配 3 个、总长截断 12000 字符，单测覆盖。
5. **Objection**: 旧调用方仍传 3 个参数给 askLlm (`src/ai/llm.ts:110`) — **Mitigation**: 第 4 个 systemPrompt 参数可选，默认 SYSTEM_PROMPT，既有 release030 测试保持通过。

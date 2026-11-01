---
task_slug: security-boundary-hardening-20261101
path: plan
created_at: 2026-11-01T06:50:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — security-boundary-hardening-20261101

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 复核模型端点守卫、DNS/HTTP 出站、WS 角色校验、Agent 配置写入、监听启动、校准服务和现有测试；独立复现 link-local 放行、drip timeout、chat config save 越权、默认匿名 admin/公网监听风险 | src/ai/providers.ts:86; src/server/index.ts:726; src/server/index.ts:2024; src/server/agentConfigHandler.ts:99; tests/llmProviders.test.ts:319 | 改前复现：169.254.0.1/169.254.169.253/169.254.170.2/169.254.255.254 可进入模型请求；socket inactivity timeout 可被 drip 响应绕过 |
| 2. Behavior Lock | yes | 为 link-local 全段、DNS/响应 deadline、角色写入、监听安全默认和 admission limit 先补回归测试；covers: R1, R2, R3, R4, R5, R6, R7, R8 | tests/llmProviders.test.ts:184; tests/wsAgentConfigAuth.integration.test.ts:84; tests/listenConfig.test.ts:1; tests/calibration.test.ts:245 | RED：link-local 聚焦先失败；GREEN：当前聚焦测试覆盖 R1-R8 |
| 3. Thin Slice | yes | Slice A：IPv4/出站边界；Slice B：角色/启动边界；Slice C：高成本 admission；不改模型方程和数据模型 | src/ai/providers.ts:86; src/server/index.ts:690; src/server/auth.ts:77; src/server/calibrationService.ts:229 | 每个 slice 以聚焦回归 + typecheck/lint 为 done 条件，最后跑全量门禁 |
| 4. Construction Rules | yes | 仅使用 Node 标准库 AbortController/Resolver/HTTP；不新增依赖；默认 fail-closed；不回显秘密；固定已验证 IP 和 Host/SNI | src/ai/providers.ts:178; src/server/index.ts:2024; .env.example:1 | 任何外部地址、角色、监听 host 和并发入口都在服务端验证；普通私网模型端点仍允许 |
| 5. Local Verification | yes | 聚焦 RED→GREEN、全量 verify、ci、e2e、AQG checker、secret scan、实际启动安全行为 | tests/llmProviders.test.ts:184; tests/wsAgentConfigAuth.integration.test.ts:84; tests/listenConfig.test.ts:1; tests/calibration.test.ts:245 | 聚焦安全测试 8 文件/111 测试全过；全量 verify/CI 91 文件/1119 测试全过，typecheck/lint/format/build/smoke/backup/audit/secret 全绿；E2E 通过；AQG checker PASS |
| 6. Self Review (5 axes) | yes | 正确性、可读性、架构、安全、性能；特别检查 timer/DNS/socket 清理、连接角色不可伪造、默认监听不暴露、长任务有 admission | src/ai/providers.ts:213; src/server/index.ts:726; src/server/index.ts:2024; src/server/calibrationService.ts:229 | 待执行：深度安全复核、全量门禁、工作树收尾 |

## Behavior Contract

### R1: Model endpoints reject every link-local IPv4 address
The model endpoint guard MUST reject every address in `169.254.0.0/16` before any fetch call, while continuing to allow explicitly supported ordinary private model endpoints.

- Scenario S1.1: link-local endpoint
  - GIVEN a model endpoint at `http://169.254.169.253/`
  - WHEN `testConnection` validates the endpoint
  - THEN no network request is made and the result is a safe failure

### R2: Public fetch has one wall-clock deadline
The public fetch path MUST settle DNS lookup, connection, response headers, body reads, and cleanup under one wall-clock deadline; a continuous low-rate response MUST NOT extend the deadline indefinitely.

- Scenario S2.1: drip response
  - GIVEN a response that emits a small body chunk repeatedly below socket inactivity timeout
  - WHEN the total deadline expires
  - THEN the request is aborted, resources are cleaned, and the promise rejects

### R3: Chat configuration writes require admin role
The server MUST authorize chat-driven Agent configuration writes using the authenticated connection role; a client-provided writer label MUST NOT grant permission.

- Scenario S3.1: viewer chat command
  - GIVEN a viewer WebSocket connection
  - WHEN it sends a chat command that changes Agent permission or adds a webhook
  - THEN configuration is unchanged and the server returns an authorization failure

### R4: Operator chat cannot edit Agent configuration
The server MUST reject Agent configuration writes from operator chat connections while preserving operator control actions.

- Scenario S4.1: operator chat command
  - GIVEN an operator WebSocket connection
  - WHEN it sends a configuration-changing chat command
  - THEN configuration is unchanged and the command is denied

### R5: Public non-loopback startup requires authentication
The server MUST bind to loopback by default and MUST fail closed when an explicitly non-loopback host is configured without at least one access token.

- Scenario S5.1: unsafe public bind
  - GIVEN `HOST=0.0.0.0` and no access token
  - WHEN the server starts
  - THEN startup fails before listening

### R6: Google API keys do not enter URLs
The Google provider MUST send its API key through an appropriate header when supported and MUST NOT place the key in a query URL.

- Scenario S6.1: Google discovery
  - GIVEN a Google provider API key
  - WHEN model discovery builds the request
  - THEN the URL contains no key query parameter and the supported header carries the key

### R7: Remote import and webhook admission is bounded
The server MUST cap concurrent remote skill imports and webhook executions, rejecting excess work without creating unbounded promises.

- Scenario S7.1: import burst
  - GIVEN more than the configured import admission limit
  - WHEN concurrent imports arrive
  - THEN excess requests are rejected immediately

### R8: Calibration identify admission is bounded
The calibration identify path MUST enforce a global admission limit and reject excess tasks before expensive work starts.

- Scenario S8.1: identify burst
  - GIVEN the global calibration admission limit is full
  - WHEN another connection requests identify
  - THEN the request is rejected without starting another expensive task

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs/status changed | yes | Security defaults, environment examples, deployment runbook, changelog and audit evidence must reflect the new bind/auth/deadline behavior |
| W6: package script changed | yes | `docker:run` now passes HOST and the token environment variable explicitly; no package dependency was added |

## Predicted Objections

1. **Objection**: A total deadline can abort a slow but valid provider response. **Mitigation**: expose a bounded timeout constant and test the drip boundary in `tests/llmProviders.test.ts:528`; callers treat timeout as a safe model fallback.
2. **Objection**: Requiring admin for chat config changes may surprise operator users. **Mitigation**: preserve read-only chat commands and operator control messages; `tests/wsAgentConfigAuth.integration.test.ts:84` covers viewer/operator/admin behavior.
3. **Objection**: Loopback-only defaults can break existing LAN deployments. **Mitigation**: document explicit `HOST` plus mandatory token configuration in `.env.example:6` and `docs/DEPLOYMENT.md:11`; fail closed for non-loopback without a token.
4. **Objection**: Admission limits can reject legitimate bursts. **Mitigation**: use explicit bounded constants and return retryable errors; `tests/calibration.test.ts:245` covers concurrent task protection.
5. **Objection**: Native HTTP implementation increases resource-cleanup complexity. **Mitigation**: centralize deadline/abort/finally logic and run drip, oversize, DNS timeout and request tests in `tests/llmProviders.test.ts:464`.

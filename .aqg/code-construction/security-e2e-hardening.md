---
task_slug: security-e2e-hardening
path: plan
created_at: 2026-11-01T02:31:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — security-e2e-hardening

| step                    | required | evidence                                                                                                                                                                         | file:line                                                                                                                       | command/result                                                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Pattern Mining       | yes      | 读取 E2E 脚本、Provider SSRF 守卫、认证、现有测试、CI、README 和部署文档；确认浏览器启动固定依赖托管 Chromium，且 IPv4-mapped IPv6 只复用元数据检查，HTTP query token 未限制路径 | scripts/e2e-ci.ts:1; src/ai/providers.ts:57; src/server/auth.ts:90; tests/llmProviders.test.ts:366; .github/workflows/ci.yml:93 | 基线：npm run e2e 因本机缺少 Playwright Chromium 退出 1；映射私网地址复现为 ALLOWED；非 WS query token 可认证 |
| 2. Behavior Lock        | yes      | 先补浏览器路径选择、IPv4-mapped 私网拒绝、私网 DNS 拒绝和 query token 路径限制回归断言；covers: R1, R2                                                       | tests/llmProviders.test.ts:366; tests/auth.test.ts:58; tests/e2eBrowser.test.ts:4                                                     | RED：映射私网断言在修复前失败；GREEN：聚焦测试 54/54，E2E 使用系统 Edge 通过                                       |
| 3. Thin Slice           | yes      | 仅修改 E2E 浏览器启动/清理、媒体脚本复用浏览器选择、SSRF 私网地址判定、WS query token 限制、对应回归测试和操作文档；不改模型计算                                                 | scripts/e2e-ci.ts:1; scripts/media.ts:1; src/ai/providers.ts:57; src/server/auth.ts:90; README.md:59; README.zh-CN.md:59        | Done：真实浏览器冒烟通过；映射私网变体拒绝；HTTP API query token 拒绝                                         |
| 4. Construction Rules   | yes      | 复用现有 Playwright、Node 标准库和 Provider 守卫；不新增依赖；安全路径 fail-closed；不回显路径或令牌                                                                             | package.json:55; src/ai/providers.ts:98; src/server/auth.ts:90                                                                  | 仅增加可选环境变量浏览器路径、最小地址分类和 WebSocket 路径判断                                               |
| 5. Local Verification   | yes      | 聚焦 SSRF/auth/browser 测试、E2E（系统 Edge）、全量 verify、CI gate、覆盖率、密钥扫描、diff 检查                                                                                 | tests/llmProviders.test.ts:366; tests/auth.test.ts:58; scripts/e2e-ci.ts:59; package.json:20-24                                 | 聚焦 54/54；verify 89 文件/1094 测试全过；ci 1094/1094、覆盖率 94.08/81.48/95.66、build/smoke/secret/backup/audit 全绿；AQG checker PASS |
| 6. Self Review (5 axes) | yes      | 正确性、可读性、架构、安全、性能；审查环境变量不回显、URL 不带凭据、浏览器与服务进程 finally 清理                                                                                | src/ai/providers.ts:182; src/server/auth.ts:95; scripts/e2e-ci.ts:57; scripts/media.ts:79; docs/DEPLOYMENT.md:60                 | 本地安全清单与五维台账已验证；跨模型审计仍未执行，明确标记 needs-cross-llm-rerun；受管文件密钥扫描无命中                                                     |

## Behavior Contract

### R1: Public fetch rejects private IPv4-mapped IPv6 addresses

The public-fetch guard MUST reject IPv4-mapped IPv6 URLs whose mapped IPv4 address is loopback, private, link-local, or otherwise non-public.

- Scenario S1.1: mapped private address
  - GIVEN a public-fetch URL using `::ffff:10.0.0.1`
  - WHEN `assertPublicFetchUrl` validates it
  - THEN validation throws before any outbound request can be made

### R2: Browser smoke can use an explicit installed browser

The browser smoke command MUST use the browser executable named by `AQUAPILOT_BROWSER_PATH` when that path exists, and MUST retain managed Playwright browser behavior when the variable is absent.

- Scenario S2.1: explicit browser path
  - GIVEN `AQUAPILOT_BROWSER_PATH` points to an installed Edge or Chromium executable
  - WHEN `npm run e2e` launches the browser
  - THEN the smoke suite launches that executable and reaches its behavioral assertions

## Warning Acknowledgements

| condition        | ack | reason                                                                                                                |
| ---------------- | --- | --------------------------------------------------------------------------------------------------------------------- |
| W8: docs changed | yes | README and deployment instructions must document the explicit browser override and the public-fetch security boundary |

## Predicted Objections

1. **Objection**: URL text validation alone cannot prevent DNS rebinding after a hostname resolves. **Mitigation**: `src/ai/providers.ts:182-267` resolves all addresses, rejects non-public answers, connects to the checked address, refuses redirects at callers, and caps response bodies; `npx vitest run tests/llmProviders.test.ts` verifies private DNS answers are rejected.
2. **Objection**: A system browser may differ from the CI-managed Chromium engine. **Mitigation**: `scripts/e2e-ci.ts:57-63` keeps managed Playwright behavior as the default, while `scripts/e2eBrowser.ts:40-51` makes the override explicit; the same E2E assertions run unchanged.
3. **Objection**: Browser path errors could leak local filesystem details. **Mitigation**: `scripts/e2eBrowser.ts:45-48` reports only a generic unavailable-path error and never prints the value; `npx vitest run tests/e2eBrowser.test.ts` locks this behavior.
4. **Objection**: Query tokens can leak through request URLs. **Mitigation**: `src/server/auth.ts:95-103` accepts query tokens only for `/ws`, while `tests/auth.test.ts:58-64` proves an API URL query token is denied.
5. **Objection**: CI mirrors could omit the new security and browser gates. **Mitigation**: `.gitcode/pipeline.yml:21-26` and `.workflow/aquapilot-ci.yml:26-46` invoke `npm run ci`, install Chromium, and run `npm run e2e`; inspect both YAML files and run `npm run ci` locally before commit.

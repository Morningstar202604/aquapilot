---
task_slug: release-hardening-021
path: full
created_at: 2026-10-23T09:20:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — release-hardening-021

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 先读服务端路由/静态托管/指标实现与现有测试风格：路由为 `startsWith` 链、静态回落 index.html、指标集中在 observability.ts、测试为纯函数单测（tests/observability.test.ts） | `src/server/index.ts:766-919`、`src/server/observability.ts:96-104`、`tests/observability.test.ts:70` | 实测 `POST /api/snapshot` → 200、`/api/nope` → 200 text/html、`/assets/nope.js` → 200 text/html |
| 2. Behavior Lock | yes | 新增路由判定单测 5 项，锁定四个真实回归（未知 API 返回 HTML、前缀误匹配、缺资源回落、方法不设限）；新增 WS 指标单测 1 项 | `tests/httpRoutes.test.ts:12`、`tests/observability.test.ts:112` | `npx vitest run tests/httpRoutes.test.ts tests/observability.test.ts` → 18 passed；covers: R1, R2, R3 |
| 3. Thin Slice | yes | 只修四个已复现的 HTTP/指标缺陷 + NUL 字节；未改仿真物理、未改前端交互、未引入依赖 | `src/server/httpRoutes.ts:1` | 明确不做：认证模型重构、静态资源缓存策略、HTTP 写接口 |
| 4. Construction Rules | yes | YAGNI：判定逻辑抽成纯函数而不是引入路由框架；复用现有 `metrics` 对象而不是加 prom-client | `src/server/httpRoutes.ts:18-52` | 依赖数不变（运行时 4 个） |
| 5. Local Verification | yes | typecheck / lint / prettier / 313 tests / build / 真实 HTTP 探测 / Playwright E2E | `scripts/ci-gate.sh:1` | `npm run ci` 全绿；`npx tsx scripts/e2e-ci.ts` → E2E PASS；探测：`/api/nope` 404 JSON、`POST /api/snapshot` 405、`/assets/nope.js` 404、SPA 路由 200 |
| 6. Self Review (5 axes) | yes | 正确性：路径判定改为精确匹配并去查询串；可读性：判定规则集中到一个文件；架构：server 不引入新层；安全：路径穿越前缀校验保留；性能：无新增 IO | `src/server/httpRoutes.ts`、`src/server/index.ts`、`src/server/observability.ts` | 人工复核 diff；`curl --path-as-is /../../package.json` → 403 |

## Behavior Contract

### R1: Unknown API paths must not return the SPA shell
The server MUST answer an unmatched `/api/*` request with `404` and a JSON body.

- Scenario S1.1: client asks for a route that does not exist
  - GIVEN a running server
  - WHEN `GET /api/nope`
  - THEN the status is 404 and the content type is application/json

### R2: API routes are read-only
The server SHALL reject any method other than `GET`/`HEAD` on `/api/*` with `405` and an `Allow` header.

- Scenario S2.1: write attempt
  - GIVEN a running server
  - WHEN `POST /api/snapshot`
  - THEN the status is 405 and `Allow: GET, HEAD`

### R3: Missing static assets must 404
The server MUST NOT fall back to `index.html` for a path whose last segment contains a dot.

- Scenario S3.1: missing bundle chunk
  - GIVEN a built client
  - WHEN `GET /assets/nope.js`
  - THEN the status is 404 and the body is not HTML

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W7: large diff | yes | 本次为收尾治理：删除 42 个无引用脚本、补 7 个治理文件、改 3 个服务端文件与 6 份文档；删除项已逐个核实无任何引用（npm scripts / CI / 文档均未提及） |
| W8: docs changed | yes | README/SECURITY/CHANGELOG/API 更新是为了与代码事实一致（鉴权已存在、持久化已存在、测试数 313），不改功能 |

## Predicted Objections

1. **Objection**: 精确路径匹配可能漏掉带子路径的端点（如 `/api/history/snapshots/extra`）(`src/server/index.ts:901`) — **Mitigation**: 现有端点均为精确路径，`tests/httpRoutes.test.ts:24` 锁定前缀不被误判；真实探测 6 条路由全部 200。
2. **Objection**: 405 会挡住未来可能新增的写接口 (`src/server/httpRoutes.ts:44`) — **Mitigation**: 写操作当前全部走 WebSocket（`src/server/index.ts:487`），`docs/API.md` 已声明 API 只读；新增写接口时需同时改判定与文档。
3. **Objection**: 删除脚本可能带走复现手段 (`scripts/README.md:1`) — **Mitigation**: 每个删除项都在 `docs/AUDIT-REPORT.md` 与测试中有对应结论，且 `scripts/README.md` 保留了仍在使用 15 个脚本的用途表。

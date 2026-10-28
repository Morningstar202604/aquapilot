---
task_slug: polish-and-correctness-audit
path: plan
created_at: 2026-10-28T06:45:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — polish-and-correctness-audit

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 全仓审计：跑门禁拿基线（794 测试 / tsc 0 / lint 0 / build OK / e2e PASS），再读 layout、PlantCanvas、App、snapshotMerge、agent、observability；用脚本核对 23 条连线端点与端口锚点、9 档视口几何、真实浏览器截图 6 个面板 | `src/model/layout.ts:310`、`src/client/components/PlantCanvas.tsx:520`、`src/client/hooks/snapshotMerge.ts:10`、`src/ai/agent.ts:287`、`src/server/observability.ts:128` | 基线：`npx vitest run` 794 passed / 66 files；coverage lines 92.89 / branches 82.37；`npm run build` 900.24 kB |
| 2. Behavior Lock | yes | 新增 `tests/auditPolish.test.ts`（连线端点=端口锚点、紧凑标题宽度、决策死区、指标路由、泵/分流告警）+ `tests/notices.test.ts`（提示上限/过期）+ 扩展 `tests/snapshotMerge.test.ts`（预测扇区与双跑摘要必须随增量更新）；先 RED 后 GREEN（covers: R1, R2, R3, R4, R5） | `tests/auditPolish.test.ts`、`tests/notices.test.ts`、`tests/snapshotMerge.test.ts` | 见 Verification 节 |
| 3. Thin Slice | yes | 每个缺陷单独成片：连线端点走真实端口 → 紧凑标题自适应 → 决策死区 → 增量补预报/双跑 → 提示自动过期 → 顶栏/页签/静态缓存；不顺手改动力学 | `src/model/layout.ts`、`src/client/components/labels.ts`、`src/ai/agent.ts` | 不改 `src/sim/**` 物理方程 |
| 4. Construction Rules | yes | 复用既有纯函数与测试基建，不新增运行时依赖（仍 4 个）；渲染层只取共享元数据；所有新增行为 fail-closed（无端口锚点不画线、无增益不动作、无 Accept-Encoding 不发 gzip） | `package.json`、`src/model/layout.ts`、`src/ai/agent.ts` | `npm ls --depth=0` 无新增 |
| 5. Local Verification | yes | 聚焦测试 → 全量测试 + 覆盖率 → tsc/eslint/prettier → build → e2e → 真实浏览器逐面板截图复验 | 全仓 | 见 Verification 节 |
| 6. Self Review (5 axes) | yes | 正确性：端点不变量、标题不越界、决策不抖动均由测试锁定；可读性：标题适配与死区是纯函数；架构：无新循环依赖；安全：静态缓存不绕过鉴权（仅静态资源）；性能：静态资源 gzip + immutable 缓存，包体不变 | `src/model/layout.ts`、`src/client/components/labels.ts`、`src/ai/agent.ts` | 人工复核 diff |

## Behavior Contract

### R1: Every connection edge terminates on its declared port anchors
The system MUST start each rendered connection at the source port anchor and end it at the target port anchor.

- Scenario S1.1: cross-layer edges
  - GIVEN the standard plant topology
  - WHEN the layout is computed
  - THEN every edge's first point equals the outlet anchor and its last point equals the inlet anchor within 0.75 px

### R2: Compact node titles never overflow their node body
The system MUST fit every compact-mode unit title inside its node rectangle.

- Scenario S2.1: long Chinese names
  - GIVEN a node 118 px wide named 污泥浓缩池
  - WHEN the title is fitted
  - THEN the estimated text width is at most node width minus padding and the font size is reduced or the text shortened

### R3: Incremental snapshots refresh live panels
The system MUST carry the forecast band and the shadow-benchmark summary in every snapshot patch so those panels cannot freeze at connection time.

- Scenario S3.1: patch replaces stale band
  - GIVEN a snapshot with an old forecast band
  - WHEN a patch with a new band and benchmark arrives
  - THEN the merged snapshot exposes both new values

### R4: AI adjustments require material gain
The system MUST hold when the best candidate's score advantage over holding is below the deadband, unless the prediction is critical.

- Scenario S4.1: marginal gain
  - GIVEN best score 500, hold score 495, severity normal, deadband 18
  - WHEN the decision is classified
  - THEN the action is hold
- Scenario S4.2: critical risk
  - GIVEN best score 500, hold score 495 and severity critical
  - WHEN the decision is classified
  - THEN the action is emergency, not hold

### R5: Operators are not buried by stale notices
The system MUST keep at most 3 notices and drop each after its lifetime.

- Scenario S5.1: fourth notice
  - GIVEN three notices already shown
  - WHEN a fourth arrives
  - THEN only the newest three remain
- Scenario S5.2: expiry
  - GIVEN a notice older than the lifetime
  - WHEN notices are pruned
  - THEN it is removed

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W7: large diff | yes | 本轮是跨层审计修复：涉及布局、画布、决策、协议、服务端静态资源与测试；按 plan 级流程分片，每片独立跑门禁 |
| W8: docs changed | yes | 更新 CHANGELOG、README 测试数、AUDIT-REPORT 走查记录与记忆文件；数字全部来自本轮真实运行 |

## Predicted Objections

1. **Objection**: 把跨层连线改到端口锚点会新增折返段，可能穿越节点 (`src/model/layout.ts:470`) — **Mitigation**: 新增 `tests/auditPolish.test.ts` 端点不变量 + 既有 `tests/topology.test.ts` 穿体采样 + e2e 300 点采样同时回归。
2. **Objection**: 紧凑标题缩小字号会降低全览可读性 (`src/client/components/PlantCanvas.tsx:966`) — **Mitigation**: 只在估算宽度超出时降级（24→21→18），并保留 `unit-value-lg` 数值字号；e2e 量测标题不越界且仍 ≥15px。
3. **Objection**: 决策死区会让真实风险响应变慢 (`src/ai/agent.ts:287`) — **Mitigation**: 死区只抑制 `severity !== 'critical'` 的微调；critical 永远放行；闭环 24 h 实测对准入次数与出水极值对比后再定阈值。
4. **Objection**: 补丁新增字段会增大每帧体积 (`src/shared/protocol.ts:230`) — **Mitigation**: 双跑摘要仅 6 个数字、预测扇区每 15 仿真分钟才变；e2e/浏览器观察帧体积与 CPU，必要时只在变更时带。
5. **Objection**: 静态资源加长缓存会让升级后旧页面引用旧 chunk (`src/server/index.ts:1779`) — **Mitigation**: 只有 `/assets/` 的哈希文件名用 immutable；`index.html` 显式 `no-cache`，升级后必然重新取入口。

## Verification

| check | command | result |
|---|---|---|
| full | `npx vitest run` | 见交付 |
| coverage | `npx vitest run --coverage` | 见交付 |
| types/lint/format | `npm run typecheck && npm run lint && npm run format` | 见交付 |
| build | `npm run build` | 见交付 |
| e2e | `npx tsx scripts/e2e-ci.ts` | 见交付 |
| browser | 内置浏览器 1440/1600/1366 + 6 面板截图 | 见交付 |

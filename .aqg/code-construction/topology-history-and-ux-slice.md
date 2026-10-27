---
task_slug: topology-history-and-ux-slice
path: plan
created_at: 2026-10-27T07:20:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — topology-history-and-ux-slice

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 复用 TopologyStore 的原子写模式、WS 的 requestId/rate-limit 约定、ProcessEditor 的 pane 结构与 pill 样式、PlantCanvas 的 portAnchors/pointer 处理；参考 Aspen 的版本回滚与 WinCC 的沿程趋势 | `src/server/topologyStore.ts:42`、`src/client/components/ProcessEditor.tsx:646`、`src/client/components/PlantCanvas.tsx:823` | 基线 724 tests / tsc 0 / eslint 0 / build OK / e2e PASS |
| 2. Behavior Lock | yes | 先写纯逻辑与组件测试（RED）：版本历史追加/裁剪/非法条目丢弃、回滚到指定版本、沿程剖面行数与高亮、拖拽连线的命中与去重（covers: R1, R2, R3） | `tests/topologyHistory.test.ts`、`tests/unitInspector.test.tsx`、`tests/processEditor.test.tsx` | 先 RED 后 GREEN |
| 3. Thin Slice | yes | 每片一条链路：版本存储 → WS 协议 → 编辑器历史页 → 沿程剖面 → 端口拖拽；每片独立可回滚 | `src/server/topologyStore.ts`、`src/shared/protocol.ts`、`src/server/index.ts`、`src/client/components/ProcessEditor.tsx`、`src/client/components/UnitInspector.tsx`、`src/client/components/PlantCanvas.tsx` | 不改求解动力学与告警阈值 |
| 4. Construction Rules | yes | 复用既有原子写与 sanitizeTopologyInput；无新依赖；回滚走与 apply 完全相同的校验路径（fail-closed）；拖拽命中用 DOM 命中测试，不引入第三方拖拽库 | `src/server/topologyStore.ts`、`src/model/topologyInput.ts` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | 聚焦测试 → 全量 vitest 752 passed / 61 files（coverage 92.85 / 82.23 / 96.45）→ tsc 0 → eslint 0 → prettier clean → build OK → e2e PASS → 浏览器真机（沿程 5 行、版本 v1→v2→回滚 v3、拖拽橡皮筋与 23 物流） | 全仓 | 见 Verification 节 |
| 6. Self Review (5 axes) | yes | 正确性：回滚复用 apply 的校验与预热；可读性：历史逻辑独立成纯函数；架构：协议层只传摘要、完整拓扑留服务端；安全：回滚帧同样过 sanitize + 速率限制；性能：历史文件只在读写时加载，不进 tick 路径 | `src/server/topologyStore.ts`、`src/shared/protocol.ts` | 人工复核 diff |

## Behavior Contract

### R1: Every applied topology is recorded and can be rolled back
The system MUST append each applied topology to a bounded version history and MUST be able to re-apply any recorded version through the same validation path as a normal apply.

- Scenario S1.1: roll back to the previous version
  - GIVEN the plant has applied v2 after v1
  - WHEN the operator reverts to v1
  - THEN the running topology equals v1 and a new revision v3 is recorded with the label "回滚到 v1"

- Scenario S1.2: bounded history
  - GIVEN more than 20 versions were applied
  - WHEN the history is listed
  - THEN at most 20 newest versions are returned and the oldest are dropped

### R2: The inspector shows the train profile
The system MUST show, for any unit that belongs to the main train, the per-reactor DO/NH/NO₃ values along the train with the selected unit highlighted.

- Scenario S2.1: aerobic tank selected
  - GIVEN the standard plant with five train reactors
  - WHEN the inspector opens for `aerobic1`
  - THEN five profile rows are rendered and exactly one carries the current-unit marker

### R3: Ports can be connected by dragging
The system MUST create the same connection when the user drags from an outlet port to an inlet port as when the two ports are clicked in sequence, and MUST reject duplicates.

- Scenario S3.1: drag outlet to inlet
  - GIVEN the editor with an empty connection between two units
  - WHEN the user drags from the outlet dot to the inlet dot and releases
  - THEN exactly one connection is added with the target port's stream type

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README/README.zh-CN 与 CHANGELOG 同步版本历史、沿程剖面与拖拽连线；docs/API.md 增加 /api/topology/history |

## Predicted Objections

1. **Objection**: 历史文件无限增长（每个拓扑约 18 KB）(`src/server/topologyStore.ts:60`) — **Mitigation**: 上限 20 版并按 revision 去重，实测 20 版约 360 KB；测试锁定裁剪行为。
2. **Objection**: 回滚到旧版后 `topologyRevision` 倒退，客户端无法判断新旧 (`src/server/index.ts:1334`) — **Mitigation**: 回滚是「以旧版内容创建一个新 revision」，只增不减，历史页显示 `v3（回滚到 v1）`。
3. **Objection**: 拖拽与点击双触发，导致连出两条线 (`src/client/components/PlantCanvas.tsx:823`) — **Mitigation**: 拖拽完成后置 `suppressClick` 并在下一帧清除；连接创建前查重（既有 DUPLICATE 逻辑）。
4. **Objection**: 沿程剖面在非主序列单元（如鼓风机）上显示空表 (`src/client/components/UnitInspector.tsx:109`) — **Mitigation**: 仅当 `topo.train.includes(unit.id)` 时渲染，测试覆盖非主序列单元。
5. **Objection**: 回滚绕过输入校验，把坏拓扑带进引擎 (`src/server/index.ts:1291`) — **Mitigation**: 历史条目在写入时与读取时都过 `sanitizeTopologyInput`，回滚再走 `applyTopology` 的 readiness 校验。

## Verification (2026-10-27)

| check | command | result |
|---|---|---|
| focused | `npx vitest run tests/topologyHistory.test.ts tests/topologyVersionsUi.test.tsx tests/trainProfile.test.ts tests/portDragConnect.test.tsx tests/unitInspector.test.tsx` | 37 passed |
| full | `npx vitest run` | 759 passed / 62 files |
| coverage | `npx vitest run --coverage` | lines 92.75 / branches 82.09 / functions 96.15 |
| types | `npx tsc --noEmit` (+ noUnused) | 0 |
| lint / format | `npx eslint src tests` · `npm run format` | 0 · clean |
| build / e2e | `npm run build` · `npm run e2e` | OK · PASS |

### Browser evidence (production build, 1600×1000 headless Chromium)

- 沿程剖面：点好氧池 A → 5 行（厌氧 0.02/16.3、缺氧 0.02/9.4、A 2.00/5.4、B 2.00/2.1、C 2.00/0.5），
  当前行唯一高亮；`out/verify-train-profile.png`
- 版本历史：启动基线 v1 → 拖动厌氧池并应用 → v2；等待 5 s 限流后点「回滚」→ revision 3，
  历史 `[[3,'回滚到 v1'],[2,'应用自定义拓扑'],[1,'标准厂基线']]`；`out/verify-topology-versions.png`
- 拖拽连线：删除 aerobic2→aerobic3 后从出口圆点拖到入口圆点，橡皮筋可见，松手后草稿
  「23 物流 / 草稿未应用 / 0 错误」，未进入点击连线模式；`out/verify-drag-connect.png`
- 控制台 0 error

### Notable defect found during verification

拖拽连线在 jsdom 里"通过"、在真实浏览器里完全无反应：jsdom 把 move/up 都派给同一元素，
而真实浏览器里指针一旦离开圆点事件就改派给光标下的元素。改为在画布容器上跟踪
pointermove/pointerup + `elementFromPoint` 命中，并把测试改为在容器上派事件、
显式 stub `elementFromPoint`，两条路径（命中/未命中）都有断言。

## 追加：分池 MLSS 口径（T4）

审计发现快照把全局 `biomassKg / bioVolume` 平摊给每个反应器：五个池全部显示 2475 mg/L，
看起来像分池实测。新增 `src/server/tankStates.ts`：

- 简化模式：值仍是全厂均值，但 `mlssSource: 'plant-average'`，检视器如实标注「全厂均值」；
- ASM1 模式：按该池 `(X_I+X_S+X_B_H+X_B_A+X_P)/1.42` 给出真实分池浓度（实测
  2339/1943/1931/1924/1918 mg/L），`mlssSource: 'reactor'`；
- 全量快照与增量帧改为同一函数派生，避免两帧口径分叉。

测试：`tests/tankStates.test.ts` 4 项 + 检视器 2 项（标注/不标注）。

## 追加：场景状态缺失（同一个"只在全量帧里"的类缺陷）

复现：注入毒性场景后界面显示「进行中」；服务端 `scenario=null` 后界面仍显示进行中。
根因：`scenario` 只存在于全量快照，增量补丁没带、`snapshotMerge` 也没合并。
修法：`SnapshotPatch` 增加 `scenario`（含 null 表示已清除），服务端每帧下发，
`snapshotMerge` 直接覆盖。浏览器实测：窗口结束后 `uiActive` 由 1 变 0。
测试：`tests/snapshotMerge.test.ts` 增加「合并场景状态」。

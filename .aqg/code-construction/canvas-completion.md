---
task_slug: canvas-completion
path: plan
created_at: 2026-10-26T23:20:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — canvas-completion

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 沿用既有 positions/portAnchors/topoHistory/editorSelection 分层；参考 Node-RED 连线折点、Simulink 多选删除、WinCC 二沉池剖面视图；服务端输入校验沿用 validation.ts 的 fail-closed 风格；趋势游标沿用 trendCursor.ts | `src/model/topology.ts:102`、`src/model/layout.ts:216`、`src/client/hooks/topoHistory.ts:24`、`src/server/validation.ts:1`、`src/server/trendCursor.ts:23` | 基线 627 tests / tsc 0 / eslint 0 / build OK |
| 2. Behavior Lock | yes | 先写纯函数与组件测试（RED）：批量删除、折点正交路径、人工坐标对公用工程生效、拖拽基准、趋势游标重置、拓扑输入校验、二沉池剖面、SMIL 移除（covers: R1, R2, R3, R4, R5, R6） | `tests/topologyEdit.test.ts`、`tests/topologyInput.test.ts`、`tests/layoutManual.test.ts`、`tests/trendCursor.test.ts`、`tests/processEditor.test.tsx`、`tests/unitInspector.test.tsx`、`tests/snapshotMerge.test.ts`、`tests/aiCadence.test.ts` | 先 RED 后 GREEN；新增 50 项测试（627 → 677） |
| 3. Thin Slice | yes | 每片一条链路：拓扑编辑纯函数 → App 键盘/多选接线 → 画布折点拖动 → 布局路由 → 服务端 sanitize → 快照剖面/补丁 → 文档 | `src/model/topologyEdit.ts`、`src/model/topologyInput.ts`、`src/client/components/PlantCanvas.tsx`、`src/client/App.tsx`、`src/server/index.ts` | 不改求解动力学与告警阈值 |
| 4. Construction Rules | yes | 复用现有 pill/btn/var(--*) 与 layoutTopology/portAnchors；不引新依赖；服务端不可信输入一律先 sanitize 再 apply（fail-closed）；折点为界面层字段，引擎不读 | `src/model/topologyInput.ts`、`src/model/topology.ts` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | 聚焦测试 → 全量 vitest 677 passed / 50 files（lines 93.45 / branches 82.94 / functions 95.32）→ tsc 0 → eslint 0 → prettier clean → build OK → e2e PASS → 浏览器真机（剖面/折点/批量删除/撤销/拖动/键控微调/告警历史/累计量） | 全仓 | 见下方 Verification 节 |
| 6. Self Review (5 axes) | yes | 正确性：拖拽用起始基准、游标随全量快照重置、折点正交化；可读性：拓扑编辑纯函数独立；架构：模型层不依赖 React；安全：服务端 sanitize 限制数量/长度/数值；性能：拖拽只在本地 state，松手一次提交 | `src/model/topologyEdit.ts`、`src/server/index.ts`、`src/client/hooks/snapshotMerge.ts`、`src/server/aiCadence.ts` | 人工复核 diff |

## Behavior Contract

### R1: Batch deletion removes every selected unit and its links in one undo step
The system MUST delete all selected units together with every connection that touches them, and the deletion MUST be undoable as a single step.

- Scenario S1.1: select two units and press Delete
  - GIVEN the editor has units `aerobic1` and `aerobic2` selected
  - WHEN the user presses Delete
  - THEN both units, all their connections, their train entries and their stored positions are gone
  - AND one undo restores the previous topology exactly

### R2: Connections can carry hand-placed orthogonal waypoints
The system MUST persist user waypoints per connection and MUST draw the connection through them with horizontal/vertical segments.

- Scenario S2.1: drag the midpoint handle
  - GIVEN a connection without waypoints in the editor
  - WHEN the user drags its midpoint handle to (x, y)
  - THEN the connection path passes through that point and the topology stores it under `routes[connectionId]`
  - AND a second undoable action removes it

### R3: The clarifier inspector shows the ten-layer profile
The system MUST expose the settler layer concentrations in the snapshot and MUST render them in the unit inspector for the clarifier.

- Scenario S3.1: open the clarifier
  - GIVEN the running plant with a Takács settler
  - WHEN the clarifier unit inspector opens
  - THEN ten layer bars are shown and the feed layer is marked

### R4: Dragging and arrow keys use the rendered position as the base
The system MUST move a dragged or nudged unit relative to its rendered position, and repeated moves MUST NOT accumulate the same delta twice.

- Scenario S4.1: drag a unit two grid steps
  - GIVEN a unit at x = 100 with no stored position
  - WHEN the user drags it by +14 px and then +14 px again in the same gesture
  - THEN the stored x is 100 + 28, not 100 + 42
  - AND pressing ArrowRight once from an auto-laid-out unit moves it from its rendered x, not from 0

### R5: Topology input is validated before it reaches the engine
The system MUST reject a topology whose units/connections/positions/routes are structurally invalid, and MUST cap their counts and coordinate ranges.

- Scenario S5.1: malformed apply frame
  - GIVEN a WebSocket `topology.apply` frame whose `units` contains `null`
  - WHEN the server handles it
  - THEN the apply is refused with a readable notice and the running plant is unchanged

### R6: Full snapshots reset the per-client trend cursor
The system MUST reset each client's trend cursor to the end of the current buffer whenever a full snapshot is sent, so a reset or topology change cannot freeze the charts.

- Scenario S6.1: reset the simulation
  - GIVEN a client whose cursor is at t = 5000
  - WHEN the simulation resets and the server sends a full snapshot at t = 0
  - THEN the next patch delivers the new low-t trend points instead of nothing

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W7: large diff | yes | 本轮同时完成两个遗留项（多选删除、连线折点）与 6 项 debug，跨模型层/服务端/客户端，diff 必然超过 300 行；已按 plan 级流程分片并逐片验证 |
| W8: docs changed | yes | README/README.zh-CN/CHANGELOG/docs/API.md 与代码同步：新增 routes 字段、clarifier profile、拓扑导入校验与批量删除快捷键 |

## Predicted Objections

1. **Objection**: 拖拽每帧都用最新布局坐标叠加位移，会导致位移被重复累加 (`src/client/components/PlantCanvas.tsx:281`) — **Mitigation**: 拖动开始时快照原始坐标，移动只按 `原始 + 吸附后的总位移` 计算；新增 `tests/layoutManual.test.ts` 与浏览器实测连续拖动。
2. **Objection**: 人工坐标在公用工程/污泥单元上不生效 (`src/model/layout.ts:143`) — **Mitigation**: 把 `applyManualPositions` 移到全部泳道节点建好之后；`tests/layoutManual.test.ts` 断言 blower/thickener 的坐标等于存储值。
3. **Objection**: 折点路径可能斜穿节点 (`src/model/layout.ts:335`) — **Mitigation**: 折点统一展开为 H/V 正交段，并在 `tests/layoutManual.test.ts` 用采样断言不进入中间节点矩形。
4. **Objection**: 服务端直接 `as ProcessTopology` 会把 `null` 单元带进引擎 (`src/server/index.ts:1226`) — **Mitigation**: 新增 `sanitizeTopologyInput` 在 apply 前校验并限流数量/长度/坐标；`tests/topologyInput.test.ts` 覆盖 12 类畸形输入。
5. **Objection**: 重置/换拓扑后客户端趋势游标仍停在旧时间，图表静止 (`src/server/index.ts:409`) — **Mitigation**: `broadcastSnapshot` 逐客户端把游标重置到当前缓冲末尾；`tests/trendCursor.test.ts` 锁定。
6. **Objection**: 批量删除可能把厂拆散 (`src/client/App.tsx:113`) — **Mitigation**: 删除仍走可撤销历史，且校验面板立即给出阻断；应用前服务端还会跑 readiness，非法拓扑不会被接受。

## Verification (2026-10-27)

| check | command | result |
|---|---|---|
| focused | `npx vitest run tests/topologyEdit.test.ts tests/topologyInput.test.ts tests/trendCursor.test.ts tests/layoutManual.test.ts tests/processEditor.test.tsx tests/snapshotMerge.test.ts tests/aiCadence.test.ts` | 50 passed |
| full | `npx vitest run` | 677 passed / 50 files |
| coverage | `npx vitest run --coverage` | lines 93.45 / branches 82.94 / functions 95.32 |
| types | `npx tsc --noEmit` + `--noUnusedLocals --noUnusedParameters` | 0 |
| lint | `npx eslint src tests` | 0 |
| format | `npm run format` | clean |
| build | `npm run build` | client + server OK |
| e2e | `npm run e2e` | PASS 7 KPIs / 17 nodes / 3 charts / 6 panels / 0 console errors |

### Browser evidence (production build, 1440×900, headless Chromium)

- 二沉池检视器：10 层剖面条 + 进料层高亮；`out/verify-clarifier-profile.png`
- 增量补丁：累计处理水量 9.4 → 9.6 千 m³、累计电耗 1.44 → 1.48 MWh（5 s 内真实增长）
- 折点：拖动手柄后草稿出现 `routes`，`应用到仿真` 后 `/api/topology` 返回 `routes.c-inlet-screen=[{x:179,y:107}]`，revision 1→2
- 批量删除：Shift 多选 2 个 → 工具栏显示「已选 2 个」→ 删除后 17→15 单元，Ctrl+Z 恢复 15→17
- 键盘删除：Del 同样 17→15，整步可撤销
- 拖拽：同一手势两次 +14 px 后总位移 28 px（不再累加）；鼓风机房拖动 (884,250)→(940,306)
- 方向键微调：好氧池 x 596→610（+14，从渲染位置起算）
- 告警：DO 拉到 0.8 后 25 s 内告警历史 0→6，活跃告警 EFF_NH/EFF_COD/EFF_BOD；`out/verify-alarm-history.png`
- SMIL：`svg animate` 元素 0（流动指示走 CSS `flow-pulse`）
- 畸形 WebSocket 输入：17 类（非 JSON/控制越界/未知场景/畸形拓扑/SSRF baseUrl…）全部被拒，服务 `tickErrors=0` 且时钟照常推进

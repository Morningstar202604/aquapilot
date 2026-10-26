---
task_slug: canvas-ux
path: plan
created_at: 2026-10-26T05:00:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — canvas-ux

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 参考 Node-RED 编辑器（节点可拖、端口连线的交互模型）与 Simulink 的 block/port 约定；本仓既有约定：拓扑是唯一真相源、布局独立成层、端口锚点由 layout 计算、撤销走 topoHistory 纯函数 | `src/model/layout.ts`、`src/model/topology.ts:100`、`src/client/hooks/topoHistory.ts:1` | rg 确认无既有 positions/端口交互实现；基线 591 tests 全绿 |
| 2. Behavior Lock | yes | 先写测试：人工坐标覆盖自动布局、非法坐标不产生 NaN、端口锚点在边界且同侧不重叠、连线端点与锚点一致、折叠面板的展开/收起/keepMounted、单元检视器只列自身参数（covers: R1, R2, R3, R4, R5） | `tests/layoutManual.test.ts`、`tests/collapsible.test.tsx`、`tests/unitInspector.test.tsx` | 10 + 4 + 7 项，先 RED 后 GREEN |
| 3. Thin Slice | yes | 每片一条链路：布局加 positions/锚点 → 画布可拖与端口 → 编辑器拖入与自动接线 → 侧栏折叠 → 单元检视器 | `src/model/layout.ts`、`src/client/components/PlantCanvas.tsx`、`ProcessEditor.tsx`、`Collapsible.tsx`、`UnitInspector.tsx` | 不改仿真求解与拓扑校验规则 |
| 4. Construction Rules | yes | 复用既有 layoutTopology / validateTopology / topoHistory；新增 UI 全部用现有 --var 与组件类，不引新依赖；坐标只存界面层字段（引擎不读） | `src/model/topology.ts:100`、`src/client/components/Collapsible.tsx` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | 聚焦测试 → 全量 591 passed / 40 files → typecheck → eslint → prettier → build → 浏览器真机拖拽/连线/折叠/参数修改 | `tests/layoutManual.test.ts` | 见下：浏览器实测 8 项 |
| 6. Self Review (5 axes) | yes | 正确性：positions 只在界面层、非法坐标夹紧；可读性：Collapsible/UnitInspector 单职责；架构：布局仍是纯函数；安全：拖动与连线都只改草稿，需显式应用；性能：拖动仅 setState 局部、松手才提交历史 | `src/model/layout.ts`、`src/client/components/PlantCanvas.tsx` | 人工复核 diff |

## Behavior Contract

### R1: Manual placement wins over automatic layout
The system MUST render a unit at its stored `positions` coordinate when present and SHALL keep automatic layout for units without one.

- Scenario S1.1: dragged unit
  - GIVEN a topology with `positions.anaerobic = {x:900,y:400}`
  - WHEN the canvas lays out
  - THEN that node's x/y equal 900/400 and other nodes keep their automatic coordinates

### R2: Ports are visible and connectable in the editor
The system MUST render an anchor dot for every port on the node boundary and MUST complete a connection when an outlet then an inlet is clicked.

- Scenario S2.1: two-click connect
  - GIVEN editor mode with an outlet selected
  - WHEN the user clicks a target inlet port
  - THEN exactly one new connection is added with the target port's stream type

### R3: New biological tanks join the train automatically
The system MUST splice a newly added aerobic/anoxic/anaerobic unit into the main train between the previous last train unit and its downstream node.

- Scenario S3.1: drop a 4th aerobic tank
  - GIVEN the standard plant with aerobic3 → clarifier
  - WHEN an aerobic unit is dropped on the canvas
  - THEN the train grows to 6, aerobic3 → new → clarifier, and validation reports 0 errors

### R4: Panels collapse to a single summary row
The system MUST collapse long side-panel groups into a title row that still shows the key reading, and SHALL expand on click.

- Scenario S4.1: control panel first paint
  - GIVEN the control tab opens
  - WHEN it renders
  - THEN 工艺模板 and 工况注入 are collapsed with summaries, 工艺控制变量 is expanded

### R5: Per-unit parameter editing
The system MUST show, for a selected unit, only the controls that unit declares in `interventions`, and MUST write changes through the same control channel as the control panel.

- Scenario S5.1: aerobic tank
  - GIVEN aerobic1 is selected
  - WHEN the inspector renders
  - THEN it lists doSetpoint/pacDose/alkDose and no rasRatio/wasRatio, and moving DO writes controls.doSetpoint

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README.md:8 / README.zh-CN.md:8 的 tests 徽章已同步到 591；README 的 Agent 设置段落与 `docs/UI-ARCHITECTURE.md` 描述的是同一套画布编排约定 |

## Predicted Objections

1. **Objection**: 人工坐标可能让连线横穿节点 (`src/model/layout.ts:330`) — **Mitigation**: 人工摆放后改走 `routeManual` 中缝折线 + 现有「无连线穿越」测试仍对自动布局生效；单测 `tests/layoutManual.test.ts` 覆盖人工布局下每条边仍有路径。
2. **Objection**: 重叠节点拖不动/点不到 (`src/client/components/PlantCanvas.tsx:150`) — **Mitigation**: 拖动用 pointer capture，松手才提交；缩放下位移除以 effectiveZoom；实测 51%/100% 两档都能拖。
3. **Objection**: 端口圆点被节点矩形遮挡导致点不中 (`src/client/components/PlantCanvas.tsx:300`) — **Mitigation**: 端口图层改画在节点之后（上层），并在 `onPointerDown` 里排除 `.port-dot` 以免被画布平移捕获；实测 elementFromPoint 命中的是 circle。
4. **Objection**: 新增池子重复接线 (`src/client/components/ProcessEditor.tsx:320`) — **Mitigation**: 改写 downstream 边而不是追加新边，并在手动连线入口加重复判定；实测校验 0 错误、24 物流。
5. **Objection**: 折叠把关键读数藏起来 (`src/client/components/Collapsible.tsx:20`) — **Mitigation**: 标题行强制显示 summary（DO/内回流/PAC、活动场景），`tests/collapsible.test.tsx` 断言收起时摘要可见。

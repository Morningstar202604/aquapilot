---
task_slug: canvas-polish
path: plan
created_at: 2026-10-26T09:00:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — canvas-polish

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 沿用 canvas-ux 的 positions/portAnchors/routeManual；参考 Node-RED 的多选与组操作、Simulink 的对齐工具、Figma 的框选交互；既有测试 layoutManual/collapsible/unitInspector 已就位 | `src/model/layout.ts:300`、`src/client/hooks/editorSelection.ts:1` | 基线 608 tests 全绿 |
| 2. Behavior Lock | yes | 先写纯几何测试：框选相交、加选语义、外接框、六种对齐、等距分布、批量位移吸附；再补顶栏菜单的展开/关闭/回调（covers: R1, R2, R3, R4, R5） | `tests/editorSelection.test.ts`、`tests/topbarMenu.test.tsx` | 17 + 6 项，先 RED 后 GREEN |
| 3. Thin Slice | yes | 每片一条链路：几何纯函数 → 画布多选/框选 → 工具栏对齐 → 键盘微调/删除 → 顶栏菜单 → 检视器补充 | `src/client/hooks/editorSelection.ts`、`PlantCanvas.tsx`、`ProcessEditor.tsx`、`TopbarMenu.tsx`、`UnitInspector.tsx` | 不动求解与校验规则 |
| 4. Construction Rules | yes | 复用现有 pill/btn/var 样式；菜单零依赖手写；图标用 Unicode 几何符号（不引图标库、不用 emoji）；所有新交互只改草稿 | `src/client/components/unitIcons.ts`、`TopbarMenu.tsx` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | 全量 614 passed / 42 files；tsc 0；eslint 0；prettier clean；build OK；浏览器逐项实测（见下） | `tests/editorSelection.test.ts`、`tests/topbarMenu.test.tsx` | 见浏览器实测 |
| 6. Self Review (5 axes) | yes | 正确性：框选用 ref 保存终值、Scale 换算、负坐标夹紧；可读性：几何/组件分离；架构：App 只做快捷键转发；安全：删除仅删选中单元且可撤销；性能：拖动 setState 局部、松手一次提交 | `PlantCanvas.tsx`、`ProcessEditor.tsx`、`App.tsx` | 人工复核 diff |

## Behavior Contract

### R1: Marquee selects intersecting units
The system MUST select every unit whose rectangle intersects the marquee rectangle and MUST clear the selection on a tiny (<6px) drag.

- Scenario S1.1: box over four units
  - GIVEN the editor with units laid out left to right
  - WHEN the user drags a box covering the first four
  - THEN exactly those four ids are selected and the toolbar shows 已选 4 个

### R2: Multi-select drags and aligns as a group
The system MUST move all selected units by the same snapped delta and SHALL align them to the selection bounds.

- Scenario S2.1: top-align
  - GIVEN four selected units at different y
  - WHEN 顶对齐 is clicked
  - THEN all four share the same top y

### R3: Keyboard edits stay undoable
The system MUST nudge the selected unit by one grid step per arrow key and MUST delete it with all its links on Delete.

- Scenario S3.1: arrow right
  - GIVEN a selected unit
  - WHEN ArrowRight is pressed
  - THEN its x increases by 14 and the change lands in the undo stack

### R4: Settings entry stays discoverable and current
The system MUST show the active model/persona inside the 设置 menu, and MUST fetch both configs on connect.

- Scenario S4.1: reload
  - GIVEN a saved model and persona
  - WHEN the page reloads
  - THEN the menu shows "u2-flash · openai" and the persona/permission without opening either dialog

### R5: Trends collapse frees canvas height
The system MUST collapse the trend strip to a single header row and MUST let the canvas take the freed height.

- Scenario S5.1: collapse trends
  - GIVEN the monitoring view with the trend strip open
  - WHEN the trend header is clicked
  - THEN the strip collapses to its header and the canvas height grows (339 -> 530 at 1280x720)
  - AND re-expanding restores the three charts

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README.md:8 / README.zh-CN.md:8 徽章更新到 614；两份 README 的画布段落与 CHANGELOG 描述同一套多选/对齐/快捷键契约 |

## Predicted Objections

1. **Objection**: 框选依赖 pointerup 时的 state，异步更新会读到 null (`src/client/components/PlantCanvas.tsx:210`) — **Mitigation**: 用 `marqueeRef` 保存终值，state 只负责渲染；实测分步 pointerdown→move→up 能选中 4 个。
2. **Objection**: 多选后普通点击会塌成单选，导致整组拖不动 (`src/client/components/PlantCanvas.tsx:225`) — **Mitigation**: 编排模式下 `onClick` 早退，选择只由 pointerdown 的 `nextSelection` 决定；实测 Shift 加选后整组同步位移。
3. **Objection**: 对齐按钮挤爆工具栏 (`src/client/styles.css:2030`) — **Mitigation**: 工具栏 `flex-wrap` + 对齐组独立换行；实测 1280 宽下 8 个按钮全部可见（width>20, height>10）。
4. **Objection**: 顶栏「设置」菜单永远显示未配置 (`src/client/hooks/useSimulation.ts:130`) — **Mitigation**: WS onopen 主动拉 llmConfig/agentConfig；实测菜单显示 "u2-flash · openai" 与 "首席值班长 · standard"。
5. **Objection**: 删除单元后残留连线导致校验报错 (`src/client/App.tsx:80`) — **Mitigation**: Delete 同时过滤 units/connections/train/positions，走 commitHistory 可撤销；实测 17→16 单元、23→21 物流、0 错误。

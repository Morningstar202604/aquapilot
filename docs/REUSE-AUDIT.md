# 复用与去重审计（2026-11-22）

这份清单只记录**还能继续删代码的地方**，以及已经落地、可复核的合并。判断标准不是“有没有现成库”，而是：

1. 这段逻辑是否已经有成熟实现，且替换后行为可被现有测试锁住；
2. 合并后是否减少“同一口径多处维护”，而不是把两个不相干的东西硬塞进一个文件；
3. 新增依赖的体积、维护面是否小于手写成本。

## 一、本轮已落地

| 位置                                      | 原实现                                           | 现在                                                  | 收益                                                         |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| `src/server/messageSchema.ts`             | `ControlPatch` 手写九个键                        | 从 `CONTROL_KEYS` 派生                                | 新增控制量不会再漏 schema                                    |
| `src/client/hooks/useThrottledControl.ts` | 手写 leading + trailing 定时器                   | `throttle-debounce`                                   | 删除自维护的定时器/取消逻辑，保留终值送达语义                |
| `tests/*.test.tsx`                        | `jsdom` 环境                                     | `happy-dom`                                           | DOM 测试环境启动从约 14 s 降到约 4 s/文件，移除 `jsdom` 依赖 |
| `src/sim/config.ts`                       | `LIMITS` 再写一份六项限值                        | 从 `GB18918_1A.limits` 派生                           | 标准、告警、评分卡、AI 护栏同源                              |
| `src/sim/metrics.ts`                      | `estimateMargin` / 决策 / 集合预测各自写六项比值 | `effluentMarginRows` / `worstRatio`                   | 六项指标只有一个映射表；BOD 不再漏判                         |
| `src/sim/alarmRules.ts`                   | 告警文案硬编码“一级A”和 `LIMITS`                 | 从 `AlarmRuleInput.standard` 取标准名与阈值           | 标准档案切换后告警文案和阈值同步                             |
| `src/server/snapshotView.ts`              | `margins` / `limits` 固定一级 A                  | 跟随 `SnapshotSource.standard`                        | 快照、评分卡、告警同一口径                                   |
| `src/sim/scenarios.ts`                    | 场景类型清单、幅度区间、界面顺序各写一份         | `ScenarioMeta.magnitudeRange` + `SCENARIO_ORDER` 派生 | 新增场景只改一处                                             |
| `src/server/tankStates.ts`                | 全量帧与增量帧各写一遍反应器字段                 | `tankCommon` 共享映射                                 | 两帧不会字段漂移，少一次 `reactorMlss` 计算                  |
| `src/ai/agent.ts`                         | 手写 `KEY_ORDER`                                 | `CONTROL_KEYS`                                        | 与配置顺序同源                                               |
| `src/sim/analysis.ts`                     | `LABELS` 与 `CONTROL_BOUNDS` 重复                | 直接用 `CONTROL_BOUNDS.label`                         | 删除一份标签表                                               |
| `src/server/agentConfig*.ts`              | `JSON.parse(JSON.stringify())` 克隆              | `structuredClone`                                     | 原生实现，保留 Date/Map 等类型                               |
| `src/server/index.ts` 的 MCP HTTP 块      | 约 100 行嵌在入口文件里                          | 独立成 `mcpHttp.ts`                                   | 鉴权/按工具分级/IP 滑窗/协议分发自成边界                     |
| `src/server/index.ts` 的 JSON 响应        | 23 处 `writeHead + JSON.stringify`               | `httpJson.sendJson`                                   | 状态码/Content-Type/额外头只有一个出口                       |
| `PlantCanvas.tsx` 画布交互                | 1,528 行自绘 SVG：缩放/平移/框选/拖节点/端口拖拽 | `@xyflow/react` + `PlantNode.tsx` / `PlantEdge.tsx`   | 画布交互交给框架；自定义节点/边保留外观与路由语义，减少约 400 行 |
| `src/model/topologyInput.ts`              | 手写类型/上限/枚举/端口去重                      | `valibot` schema + 跨引用校验                          | 字段类型与运行时白名单同源；未知干预项不再硬塞进引擎        |
| `src/model/topology.ts`                   | `StreamKind` / `InterventionKey` 各写一份联合类型 | `STREAM_KINDS` / `INTERVENTION_KEYS` 运行时清单反推类型 | 新增物流或控制项只改一处；sanitize 直接复用同一份清单        |
| `src/shared/agentConfig.ts`               | 200 行手写 `typeof`/枚举/截断                    | `valibot` 字段 schema + 业务后处理                     | 非法字段逐项回退的宽容语义不变，结构校验集中一处             |
| `src/server/index.ts` 的 HTTP API         | 约 340 行路由、鉴权、405、导出头                 | `apiRoutes.ts`                                        | 入口只剩安全头/MCP/静态回落；路由可脱离仿真服务器做契约测试   |
| `src/server/index.ts` 的模型配置 WS      | 约 100 行嵌在入口                               | `llmConfigHandler.ts`                                 | 出站网络、密钥同源保护、限流自成边界                         |
| `src/server/index.ts` 的聊天分支          | 约 140 行嵌在消息 switch                          | `chatHandler.ts`                                      | 配置命令/规则答案/LLM 增强的优先级与在途计数独立可测         |
| `src/server/index.ts` 的分析分支          | 约 55 行嵌在消息 switch                           | `analysisHandler.ts`                                  | 重预测的限流与错误回执不再混在 800 行 switch                 |
| `src/server/index.ts` 的模板/模型切换     | 两条重建运行时分支各写一遍限流/广播               | `topologySwitchHandler.ts`                            | 模板与求解模型共用“重建 + 预热 + 重置”语义                   |
| `src/server/index.ts` 的下载响应          | 4 处重复 `writeHead + Content-Disposition`       | `httpJson.sendDownload`                               | CSV/Markdown 导出头只有一个出口                              |
| `src/server/snapshotView.ts`              | 全量帧/增量帧各拼一遍 20+ 字段                   | `liveFrame` / `costTotals` / `scorecardFor`            | 两帧同源；评分卡只算一次口径                                 |
| `src/client/App.tsx` 的 11 个侧栏面板     | 每段重复 tabpanel id/ARIA/ErrorBoundary          | `TabPanel` + `SIDE_TAB_ORDER`                         | 新增页签只改顺序表；DOM 契约不会漏                           |
| `AgentSettingsPanel` / `ModelSettingsPanel` | 各写一遍 `.model-modal` 外壳、标题栏、关闭按钮与读取空态 | `SettingsModal.tsx`                                   | dialog aria/关闭/空态只有一个实现，表单内容仍各自独立         |
| `TopbarMenu` 设置下拉                  | 绝对定位弹层被 `.topbar` 的 `overflow: clip` 裁掉，DOM 存在但不可见、点击穿透到下层页签 | `createPortal` 到 body + `fixed` 定位 + 视口内夹取 | 菜单真正可见可点；浏览器实测从“点不到”恢复为可打开模型/Agent 设置 |
| `Trends` / `Replay` 的 ECharts 生命周期   | 两份 init/ResizeObserver/dispose                 | `useEChart`                                           | 切页不残留 canvas；多图联动只在一处配置                      |
| `Trends` 的参考线                       | COD 50 / NH 5 硬编码                             | 跟随 `snap.limits`                                    | 切一级 B / BSM1 口径时趋势线与 KPI 不再互相矛盾              |
| `snapshotMerge` 的校验键                 | 手抄九项控制键与六项出水                       | `CONTROL_KEYS` / `EFFLUENT_METRICS`                   | 新增控制量或指标时客户端校验自动同步                         |

## 二、下一批高 ROI：值得单独开一批做

### 1. ~~用 `@xyflow/react` 重做工艺画布/编辑器~~（已完成）

`PlantCanvas.tsx` 现在只负责 React Flow 的外壳、布局映射、缩放控件与图例；
`PlantNode.tsx` / `PlantEdge.tsx` 负责自定义节点与边。拖拽、框选、缩放平移、
MiniMap、Handle 连接由框架承担。人工折点与端口吸附仍保留在画布层（`RouteHandles`
与 `portDragRef`），因为这两项是工艺语义，不是通用画布能力。

后续已继续收口：`ProcessEditor.tsx` 从 1,141 行降到 467 行，组件库/工具栏/右侧页签
分别独立（见第五节）。`layout.ts` 暂保留手写分层，理由见下一项的 A/B。

### 2. ~~用 `elkjs` 或 `dagre` 替换手写分层布局~~（已 A/B，结论：不迁移）

`layout.ts` 的分层、支线、回流走廊规则是产品资产，不应整体交给通用布局；但“节点坐标 + 边路径”可以交给 ELK/Dagre，保留：

- `layerOf` / `orderMainLine` 决定主序列与支线分层；
- 人工 `positions` / `routes` 仍优先；
- 自动布局只负责在层内排坐标和正交走线。

已用 `@dagrejs/dagre@3.1.3` 做临时 A/B（不写入依赖）：同一标准厂、同节点尺寸、
同 `rankdir=LR` 参数下，手写布局 `1774×480`，Dagre `1902×612`；两者节点重叠都是 0。
Dagre 多出约 27% 高度、7% 宽度，且输出不保留“主处理线 / 公用工程 / 污泥线”
三条泳道——要恢复产品读图顺序，仍得把 `layerOf` 与 300 行路由重写一遍。
Dagre 解包约 1.4 MB，换不来可测收益，因此保留手写布局；ELK 更重，不试。
报告数字只在 `tests/topology.test.ts` 的“无连线穿池体”断言下成立，不迁移。

### 3. ~~`valibot` 收口拓扑输入与 Agent 配置~~（已完成）

`topologyInput.ts` 已改为 `valibot` schema：单元、端口、连线字段的类型/上限/枚举、
端口 id 去重都在 schema 里；跨单元引用（端口是否存在、train 是否去重）仍由
sanitizer 做，因为这类规则依赖整棵树。

`shared/agentConfig.ts` 也已迁到 `valibot`：每个字段自带 fallback，
非法 tone/权限只会回退该字段，不会把整份提示词和技能清空；核心字段
（limits/safety/auth/secrets/kinetics）仍由入口显式丢弃并告警。

### 4. `lru-cache` 替换静态 gzip 缓存的手写 FIFO

`staticFiles.ts` 的 `Map` + 手工淘汰只有 64 项，逻辑简单；换成 `lru-cache` 的收益主要是命中率与 TTL 能力，代码只少 6 行。**优先级低**，不建议为了“用库”而引入 3 MB 包。


### 5. 本轮追加：把“同一件事写两遍”继续压掉

- **标定算法只留一份**：`sim/calibration.ts` 的 `identifiability` / `calibrate`
  改为 async，并通过 `beforeEvaluate` / `shouldCancel` 钩子把“让出事件循环”
  交给服务端注入。`server/calibrationService.ts` 不再维护第二套坐标下降，
  `calibrateAsync` 只是核心算法 + `setImmediate`。同步 CLI 与测试改为 `await`。
- **标定任务准入**：`run` / `identify` 的重复连接、全局并发上限、`activeTasks`
  登记收口到 `acquireTask()`。
- **控制滑块**：`ControlPanel` 与 `UnitInspector` 的 label/range/aria/精度共 10 行
  完全重复，抽成 `ControlSlider.tsx`；滑块顺序从 `CONTROL_KEYS` 派生，
  新控制量自动出现（`stormStore` 由暴雨工况驱动，仍排除）。
- **控制量夹紧**：`clampControls` 改为遍历 `CONTROL_KEYS`，不再逐字段抄 9 行。
- **网络引擎基准**：新增 `NETWORK_CONTROL_DEFAULTS`，`createNetworkState` 与
  人工基准 `MANUAL_BASELINE_CONTROLS` 共用，不再靠注释保持 0.022 一致。
- **达标判定**：影子双跑与 MCP `simulate_headless` 改用 `worstRatio` /
  `EFFLUENT_METRICS` + `LIMITS`，MCP 样本补上 BOD₅，不再手抄五项限值。
- **告警阈值**：画布二沉池泥位红线改用 `BLANKET_MARGIN_M`，与告警规则同源。
- **聊天回执**：`server/index.ts` 四处 chat/editor 消息体收口到 `sendEditorAnswer`。
- **Agent 配置**：`agentConfigHandler` 的 admin 守卫与 `saved` 回执收口到
  `requireAdmin` / `sendSaved`。
- **拓扑编辑器拆壳**：`ProcessEditor.tsx` 从 1,141 行降到 467 行。
  组件库元数据与单元构造抽到 `model/editorPalette.ts`（`PALETTE` / `PALETTE_GROUPS` /
  `insertPaletteUnit` / `duplicateTopologyUnit`），左侧库、顶部工具栏、右侧四个页签
  分别拆成 `EditorPalette` / `EditorToolbar` / `EditorSidePane`。新增
  `tests/editorPalette.test.ts` 5 个用例锁住“生物池自动接线 / 复制偏移 / 非生物不改 train”。
- **聊天/分析/切换分支拆壳**：`chatHandler.ts`（117 行）承载配置命令优先、
  规则答案保底、LLM 增强异步追加与三处 `llmInFlight` 计数；`analysisHandler.ts`
  独立承担 25 次 4h 预测的限流与错误回执；`topologySwitchHandler.ts` 合并
  `preset` 与 `model` 两条“重建运行时 + 预热 30 天 + 广播”路径。
  `server/index.ts` 从 2,027 行降到 1,502 行，只保留接线、仿真循环与生命周期。
- **复制粘贴检测**：以 `jscpd --min-lines 8 --min-tokens 80` 扫描 `src`，
  当前 **0 个克隆、0 行重复**（37,186 行）。

## 三、明确不建议替换

| 候选                                | 结论   | 原因                                                                                                                              |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `express` / `hono` 替换 `node:http` | 不做   | 现有路由要和 WebSocket upgrade、MCP、静态文件安全、默认拒绝鉴权共用一个入口；框架会把这套边界拆散，收益是写法好看，不是安全或性能 |
| `pino` 替换 `observability.ts`      | 不做   | 现有 logger 已有 JSON Lines、敏感字段递归脱敏、循环引用降级；换 pino 还要重配 redact，测试与日志格式都会漂移                      |
| `date-fns` 替换 `shared/time.ts`    | 不做   | 这里是“仿真第几天第几分钟”，不是墙钟日期；`date-fns` 反而要把领域概念翻译成日期对象                                               |
| `immer` 替换 `topologyEdit.ts`      | 暂不做 | 现有纯函数用 filter/fromEntries 明确构造白名单对象，正好满足原型污染防线；immer 的 draft 会把这层边界变得不直观                   |
| `simple-statistics` 替换分位数/均值 | 暂不做 | 当前只有单数组分位数和均值，十几行；新增依赖的体积大于收益，且 `Math.min(...values)` 的样本上限已被 2 MB CSV 限住                 |
| `react-query` / `zustand`           | 暂不做 | 状态来自单一 WebSocket 快照流，现有 `useSimulation` 的合并/增量逻辑是协议的一部分；状态库会引入第二套缓存语义                     |

## 四、模块合并检查表（按“同一口径多处维护”排序）

- [x] 排放限值：`standards.ts` → `config.LIMITS`
- [x] 六项出水比值：`metrics.effluentMarginRows`
- [x] 告警阈值与标准名：`alarmRules` 跟随 `standard`
- [x] 场景类型/幅度/顺序：`scenarios.ts`
- [x] 全量帧/增量帧反应器字段：`tankStates.tankCommon`
- [x] 控制键清单：`config.CONTROL_KEYS`
- [x] 客户端消息控制补丁：`messageSchema` 从 `CONTROL_KEYS` 派生
- [x] `server/index.ts` 的 HTTP JSON 响应：23 处已收口到 `httpJson.sendJson`
- [x] `server/index.ts` 的 MCP HTTP 处理器：已独立成 `mcpHttp.ts`（鉴权/按工具分级/IP 滑窗/协议分发）
- [x] `PlantCanvas` / `PlantNode` / `PlantEdge`：React Flow 迁移
- [x] `topologyInput`：`valibot` schema + 运行时白名单
- [x] `shared/agentConfig.ts`：`valibot` 归一化（保留逐字段丢弃语义）
- [x] `server/index.ts` 的 HTTP API：`apiRoutes.ts`
- [x] `server/index.ts` 的模型配置：`llmConfigHandler.ts`
- [x] `server/index.ts` 的聊天分支：`chatHandler.ts`
- [x] `server/index.ts` 的分析分支：`analysisHandler.ts`
- [x] `server/index.ts` 的模板/模型切换：`topologySwitchHandler.ts`
- [x] 侧栏面板：`TabPanel` + `SIDE_TAB_ORDER`
- [x] 设置弹层外壳：`SettingsModal`
- [x] 顶栏设置菜单：portal 到 body，脱离 topbar 裁切上下文
- [x] ECharts 生命周期：`useEChart`
- [x] 趋势参考线跟随当前排放标准
- [x] 标定：同步/异步共用 `sim/calibration.ts` 一套算法
- [x] 标定任务准入：`acquireTask`
- [x] 控制滑块：`ControlSlider`
- [x] 控制量夹紧：遍历 `CONTROL_KEYS`
- [x] 网络引擎/人工基准控制默认值：`NETWORK_CONTROL_DEFAULTS`
- [x] 影子双跑与 MCP 达标判定：`worstRatio` + `LIMITS`
- [x] 二沉池泥位红线：`BLANKET_MARGIN_M`
- [x] 聊天配置回执：`sendEditorAnswer`
- [x] Agent 配置权限/回执：`requireAdmin` / `sendSaved`
- [x] 拓扑编辑器：`editorPalette` + `EditorPalette` / `EditorToolbar` / `EditorSidePane`
- [x] `layout.ts`：Dagre A/B 完成，结论保留手写分层（体积/泳道/路由三项都更差）
- [x] 画布组件壳：`PlantNode` 统一卡片外框 / 标题栏 / 分隔线 / 工艺色条 / 阴影，所有单元共用
- [x] 画布泳道：`ViewportPortal` 渲染主处理线 / 公用工程 / 污泥线分隔线与标签，不额外造节点
- [x] 画布端口：只读态隐藏 Handle；编辑态默认 22% 透明度，悬停/选中恢复，端口文字改绝对定位胶囊
- [x] 边标签：按长线段中点放置并避开节点外框，短直连不重复刷「进水」

## 五、验收口径

本轮实测：`115` 个测试文件 / `1415/1415` 测试通过，全量耗时约 **176 s**（改造前 294 s）；typecheck、eslint、build 通过；`jscpd` 8 行/80 token 阈值下 0 克隆、0 行重复（37,698 行）；服务端 `/api/health` 与 WebSocket 冒烟通过：chat 返回规则答案、analysis 返回快照、model/preset 切换均按预期广播；`/api/models` 中 ASM1 为 `active: true`。浏览器复测工艺编排：17 节点 0 重叠、5 条边标签 0 压卡、1:1 与 83% 全览标题均不越界。

本轮改动必须同时满足：

```bash
npx tsc -p tsconfig.json --noEmit
npx eslint src tests
npx vitest run
npm run build
```

并保持工作树未提交；ELK/Dagre 这类布局迁移不混入本批提交。

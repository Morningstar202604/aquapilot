> 本文档记录对 14 个相关开源项目的调研（2026-03）与借鉴映射。
> 总表中的「已做/建议做」逐项对应 AquaPilot 的落地位置；`建议做` 项构成
> 功能路线图的输入。来源均为公开 README/源码，检索于 2026-03-04。

# AquaPilot 可借鉴开源项目调研报告

调研日期：2026-11-04。方法：GitHub README + 源码目录/提交记录 + 官方文档交叉核验。
AquaPilot 现状基线：React 19 + Vite 前端（PlantCanvas SVG 画布、ProcessEditor 拖拽编排、ReplayPanel 回放）、手写 Node HTTP+WS 后端（src/server）、ASM1/Takács 内核（src/sim）、EKF（src/sim/stateEstimation.ts）、AI 决策引擎（src/ai）、SQLite、Prometheus、webhook；默认亮色主题。

## 1. OpenModelica（过程仿真）
定位与活跃度：开源 Modelica 建模仿真环境，巨型 monorepo（OMCompiler/OMEdit/OMPlot 等），4 万+ commits，最近提交 2026-11，极活跃。
可学优点：
- OMEdit 支持点击图元跳转到模型定义行、图-对象分层视图，"画布即源码"双向联动值得参考。
- 文档按 User's Guide / 开发者文档 / BUGREPORTING / CITATION.cff 分层，仓库内置 AGENTS.md/CLAUDE.md 约束 AI 贡献行为——AquaPilot 可在仓库根加一份给 AI 助手的约束文档。
- 保存/恢复绘图轴范围（figure annotations），趋势图持久化视角状态的思路。
AquaPilot 落地：Trends.tsx 增加轴范围记忆（localStorage 每图保存）；根目录补 AGENTS.md。双向"图元→模型定义"跳转可做 PlantCanvas 单位块 → plantModel.ts 参数定位（建议做）。

## 2. DWSIM（化工流程仿真）
定位与活跃度：稳态+动态序贯模块法流程模拟器，.NET 跨平台，提交至 2026-07，活跃。
可学优点：
- 2026-01 新增 AutomationMode：headless 跳过 Eto.Forms UI 更新，使 DWSIM 可作为库嵌入 REST API/LLM Agent——与 AquaPilot "仿真内核可被 AI 调用"的架构完全同构，验证了 headless 分离的价值。
- 提交信息写法：把用户真实场景、数学依据（泵相似律 sratio²/sratio³）、API 编号（PROP_PU_8）全部写进 commit，可读性极高。
- 单位操作以 IUnitOperationExtension 接口插件化，独立目录一物一仓式组织。
AquaPilot 落地：已做——src/sim 与 src/server 已与前端解耦；未做——commit 规范可借鉴（CONTRIBUTING.md 补 commit 模板）；unit 参数暴露机制可对照 src/sim/units.ts 做"可调参数白名单"供 AI 候选生成（建议做）。

## 3. BSM1 开源实现（EXPOsan/bsm1、BSM1_in_Python）
定位与活跃度：fau-evt/bsm1-python 已 404（已删除/改名），改调研两个替代：Ghent 大学 BSM1_in_Python（硕士论文级实现）与 QSD-Group/EXPOsan 的 bsm1 模块，后者持续维护。
可学优点：
- EXPOsan 将 MATLAB/Simulink 官方输出（matlab_exported_data_asm1.xlsx）放进 data/ 供回归对比——**官方基准数据做验收测试**是工艺仿真可信度的金标准。
- README 明确列出对标准模型的偏差（加 S_N2、去掉氨限制项）并给出依据，模型差异透明化。
- system.py 单脚本内集中所有可定制项（进水负荷、初值、求解器选项）。
AquaPilot 落地：建议把 IWA 官方 BSM1 稳态值做成 vitest 基准断言（src/sim/bsm1.ts 已有实现，可加 tests/bsm1-benchmark.test.ts）；docs/API.md 或 README 中标注对标准 ASM1 的任何修改（建议做）。

## 4. BSM1_gym（BSM1 + 强化学习）
定位与活跃度：把 Modelica BSM1 编译为 FMU 封装成 OpenAI Gym 环境，用 RL 优化运行成本（2021-2022，低活跃但思路被广泛引用）。
可学优点：
- "仿真即环境（env）：step()→观测+奖励"的接口范式，AI 决策引擎可以按同款抽象重构。
- README 按"准备→OpenModelica→FMU→Gym→训练"步骤化教学，含故障排除（除零崩溃需重跑）。
AquaPilot 落地：src/ai/agent.ts 的候选生成→鲁棒评估链路可抽象出 step/observe/reset 三接口（建议做），便于未来接入外部 RL 策略对比。

## 5. Node-RED（流式编排）
定位与活跃度：事件驱动低代码平台，23.8k stars，提交至 2026-10，OpenJS 基金会项目。
可学优点：
- 左侧 palette 按类别折叠 + 拖拽即添加节点，双击开配置面板；AquaPilot ProcessEditor 可补"组件库侧栏按类别折叠"。
- 流程 JSON 一键导入/导出（剪贴板），分享即粘贴——AquaPilot 的拓扑编排可加 export/import 到 data/topology-history.json 同格式。
- 节点端口悬停显示上次消息内容（调试体验），以及 subflow 子流程复用。
AquaPilot 落地：ProcessEditor.tsx 建议做 palette 侧栏+子流程；连线悬停显示实时流量/水质（已部分有 UnitInspector，可下沉到连线上）。

## 6. Grafana（仪表盘信息层级）
定位与活跃度：可组合观测平台，77.6k stars，日级提交。
可学优点：
- 信息层级：row 分组 → panel → 覆盖物（thresholds/annotations），关键值大字+趋势线小图的 stat panel 模式。
- 时间范围选择器：快捷区间（5m/1h/24h）+ 自定义，所有面板共享时间轴；AquaPilot Trends 可加全局 time-range bar。
- Dashboard JSON 可导入导出、变量（template variables）让一个看板适配多数据源。
AquaPilot 落地：Trends.tsx 全局时间范围与阈值着色（alarm 阈值线叠加曲线，建议做）；InsightsPanel 可借鉴 stat+sparkline 层级（部分已做）。

## 7. Home Assistant（状态与自动化 UI）
定位与活跃度：本地优先的家庭自动化，core 仓库日级提交，极活跃。
可学优点：
- 设备"不可用/未知"状态显式灰显，与"关闭=0"严格区分——对传感器掉线的污水厂场景极重要。
- 自动化编辑器固定三段式：触发器→条件→动作，结构化表单而非自由脚本。
- 开发者工具内嵌模板实时预览，状态徽章（badge）把最关键实体置顶。
AquaPilot 落地：AlarmsPanel/PlantCanvas 对仪表掉线用"unavailable 灰显"语义（建议核对 dataQuality.ts 输出到 UI）；ControlPanel 可借鉴三段式（条件→动作→护栏）呈现 AI 决策（DecisionPanel 已有类似结构，如实标注）。

## 8. Apache ECharts（大数据 dashboard 官方实践）
定位与活跃度：ECharts 6.1 已发布，官方强调渐进渲染可实时渲染千万点。
可学优点（官方最佳实践要点）：
- 大数据：sampling:'lttb' 降采样、large:true、初始渲染关动画；流式更新用 merge setOption 而非重建实例。
- 多图联动：chart.group + echarts.connect 同步 tooltip/dataZoom——AquaPilot 多曲线趋势联动可直接套用。
- 主题注册一次（registerTheme），暗色切换 setTheme（v6）；AquaPilot 未来上暗色主题时按此架构。
- SSR（renderToSVGString）可服务端生成报表 PNG/SVG。
AquaPilot 落地：Trends.tsx（已用 echarts，vendor-echarts 分包已做）加 lttb 采样与 connect 联动（建议做）；主题令牌集中到 registerTheme（建议做，为暗色主题铺路）。

## 9. Windmill / n8n（工作流产品化）
定位与活跃度：Windmill 18.2k stars（AGPL，Rust 引擎，code-first，脚本签名自动生成表单 UI）；n8n 207k stars（fair-code，可视化画布+400 集成+AI Agent 节点+MCP 支持），两者均活跃。
可学优点：
- Windmill：类型化输入自动生成运行表单——AI 决策的候选参数可自动渲染成确认表单。
- Windmill 的 Git 同步把工作区当仓库，版本化是一等公民（对照 AquaPilot 已有的版本回滚，方向一致）。
- n8n：执行历史逐节点回放输入/输出，失败节点红色高亮——ReplayPanel 可借鉴"按决策步回放"。
- n8n 的 human approval 步骤（需人批准才继续）与 AI 护栏执行天然契合。
AquaPilot 落地：DecisionPanel.tsx 候选确认表单化（建议做）；ReplayPanel.tsx 按步进回放每步 AI 输入输出（部分已做，可细化）；MCP 接入可参考 n8n 的 MCP 节点参数约定（建议做）。

## 10. FUXA（开源 SCADA）
定位与活跃度：Web 版 SCADA/HMI，Node.js + Angular + SVG，5.2k stars，提交至 2026-10，MIT。
可学优点：
- 纯 SVG 图形 + 数据点绑定（tag 绑定属性面板：刷新频率/显示格式），与 AquaPilot PlantCanvas 同路线，可对照其绑定交互。
- 左设备列表/中画布/右属性面板三栏布局，工业 HMI 编辑器成熟范式。
- 内置 DAQ 历史库支持采样间隔与死区（deadband）配置——trendCursor 存储可加死区压缩。
- 独立仓库 FUXA-SVG-Widgets 提供可复用 SVG 部件库及作者指南。
AquaPilot 落地：ProcessEditor 三栏布局（建议做）；src/server/trendCursor.ts 死区压缩（建议做）；SVG 部件独立化（沉淀 src/client/components 可复用单元图元）。

## 11. ScadaLTS（企业级 SCADA）
定位与活跃度：Java/Tomcat + Vue，GPL-2.0，约 1k stars，v2.8.0（2025-10），中等活跃。
可学优点：
- 事件检测器类型化：限值、无更新（no-update）、状态跳变分别建模——AquaPilot alarmRules 可补"无更新"类告警（传感器断线）。
- Watch List：用户自选点位组合成个人监控清单（建议做进 WatchdogPanel/InfluPanel）。
- 语义化版本 + WAR/Docker 多形态分发。
AquaPilot 落地：src/sim/alarmRules.ts 增加 no-update 检测（建议做）；版本与分发已做（Dockerfile、CHANGELOG）。

## 12. FALCON（帝国理工，AI+仿真数字孪生）
定位与活跃度：LLM Agent 与 OpenModelica 工厂仿真闭环故障处理的研究原型（2025-05，学术活跃）。
可学优点：
- 系统比较三种"工厂表示喂给 LLM"的方式：自然语言描述 / Modelica 源码 / P&ID 图+状态图，结论是结构化图表示效果最好——直接指导 AquaPilot promptComposer 的上下文编码策略。
- 闭环：agent 提议动作 → 仿真验证 → 重提示（reprompt），与 AquaPilot 鲁棒评估→护栏链路同构。
AquaPilot 落地：src/ai/promptComposer.ts 增加"拓扑图结构化摘要"作为主要上下文（部分已做，建议参照其对比结论调优权重）；日志落盘 code/logs 模式可借鉴到 aiCadence.ts（建议做）。

## 13. LLMDrivenSimulation（斯图加特大学 IAT）
定位与活跃度：LLM 多智能体驱动仿真参数化的 IEEE ETFA 2024 论文配套仓库，博士论文（2026）延续，学术活跃。
可学优点：
- "用户给目标 → 多智能体启发式探索仿真 → 汇总参数方案"的循环，与 AI 决策引擎目标一致。
- LLM 无关设计（任意厂商模型可插拔），providers.ts 已是同思路（已做）。
AquaPilot 落地：src/ai/agent.ts 多轮探索可参考其"实验-总结"两阶段输出格式（建议做）。

## 14. MABDT Engine（Auburn 大学，多智能体数字孪生引擎）
定位与活跃度：2026-06 发布的开源制造数字孪生运行时（Python，Zenodo v1.0.0）。
可学优点：
- 四层清晰架构：仿真内核 / 事件通信内核（MQTT 桥接 IoT）/ 只读状态接口层 / 应用层（仪表盘+LLM 查询）——"只读状态接口"隔离写操作，正是护栏架构。
AquaPilot 落地：src/server/snapshotView.ts 已实现只读视图（已做），可借鉴其四层划分在 docs/UI-ARCHITECTURE.md 中明确分层表述（建议做）。

## 总表

| 项目 | 学到的核心优点 | AquaPilot 落地位置（已做/建议做） |
|---|---|---|
| OpenModelica | 图元↔源码跳转；AGENTS.md 约束 AI；轴范围持久化 | Trends.tsx 轴记忆（建议）；根目录 AGENTS.md（建议） |
| DWSIM | AutomationMode headless 供 LLM 调用；高质量 commit | 已做内核解耦；units.ts 参数白名单（建议） |
| EXPOsan/BSM1 | 官方基准数据回归测试；模型偏差透明化 | tests/bsm1-benchmark.test.ts（建议） |
| BSM1_gym | 仿真即 Gym env（step/observe/reset） | agent.ts 环境接口抽象（建议） |
| Node-RED | palette 折叠+拖拽；流程 JSON 导入导出；连线悬停显示消息 | ProcessEditor.tsx（建议）；拓扑导出（建议） |
| Grafana | row/panel/覆盖物层级；全局时间范围；stat+sparkline | Trends.tsx 全局 range+阈值线（建议） |
| Home Assistant | unavailable 灰显语义；触发-条件-动作三段式 | AlarmsPanel 断线灰显（建议）；DecisionPanel 已有类似 |
| ECharts 官方 | lttb 采样；connect 多图联动；registerTheme 暗色 | Trends.tsx（建议）；主题集中化（建议） |
| Windmill | 类型化输入自动生成表单；Git 版本化一等公民 | DecisionPanel 确认表单（建议）；回滚已做 |
| n8n | 逐节点执行回放；human approval 步骤 | ReplayPanel 细化（建议）；护栏已做 |
| FUXA | SVG+tag 绑定；三栏编辑器；死区压缩；独立部件库 | ProcessEditor（建议）；trendCursor 死区（建议） |
| ScadaLTS | no-update 事件检测；Watch List | alarmRules.ts（建议）；面板 watchlist（建议） |
| FALCON | 结构化 P&ID 表示最优；动作-验证-重提示闭环 | promptComposer.ts 上下文编码（建议） |
| LLMDrivenSimulation | LLM 无关；实验-总结两阶段 | providers.ts 已做；agent.ts 输出格式（建议） |
| MABDT | 只读状态接口隔离写路径；四层架构 | snapshotView.ts 已做；架构文档（建议） |

## 结论要点
1. 已被 AquaPilot 覆盖并被外部项目验证正确的：内核/UI 解耦（DWSIM、MABDT）、只读快照+护栏（MABDT、n8n）、版本回滚（Windmill）、LLM 无关 providers（LLMDrivenSimulation）。
2. 最值得优先落地的三件事：① ECharts lttb+connect（Trends.tsx，纯前端收益大）；② 官方 BSM1 基准回归测试（可信度差异化）；③ ProcessEditor 的 palette+导入导出（对标 Node-RED/FUXA 的编排体验）。
3. AI 侧差异化：FALCON 的结论（结构化图表示优于源码喂给 LLM）可直接用于 promptComposer 调优；候选确认表单（Windmill 风格）能提升护栏的可感知性。

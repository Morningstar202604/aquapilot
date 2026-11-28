# AquaPilot v2：从零重构计划（Clean-room Rust）

> 决策日期：2026-11-26  
> 决策：放弃“逐模块 parity 迁移”，旧 Rust 线冻结；v2 从产品规格与领域模型出发，在 `rust-v2/` 新建一套干净实现。  
> 过渡策略：TypeScript 版本继续作为可运行产品，直到 v2 通过 cutover gate；旧 `rust/` 已于 2026-11-27 删除，需要历史时从 v0.11.23 tag 取，不再作为新实现的参考代码。

## 1. 这次到底做什么

AquaPilot v2 是一套**污水处理厂仿真建模软件**，不是“把 TS 函数逐个翻译成 Rust”的迁移工程。

v2 的产品能力按以下顺序交付：

1. 可编辑的厂区拓扑：反应器、二沉池、回流、进水、出水、泥线；
2. 可运行的整厂模型：ASM1 / ASM2d / ADM1 / Takács / 水力学；
3. 可复现实验：固定种子、固定边界、固定拓扑快照，能重跑、能导出；
4. 可审计结果：出水、库存、COD/N/P 三本账、告警、合规报表；
5. 可部署服务：单一 Rust 二进制 + HTTP/WS API + CLI + 静态界面；
6. 工业接口与 AI 编排：OPC UA/Modbus/MQTT 适配层、AI 建议、审计链。

v2.0 不包含：3D 厂区、无人值守闭环、真实 PLC 控制、法定报表签字。它们是 v2.x / 现场验收门，不冒充首版完成。

## 2. 为什么放弃旧路线

旧路线把“Rust 模块与 TS 逐点一致”当成进度单位。结果：

- v0.11.17–v0.11.23 连续 7 个版本都在 M1b，产品端没有新增一个用户能用的功能；
- 每个函数切片都能通过门禁、都能发版，但整厂 `stepNetwork` 始终没有闭环；
- M1b 阻塞 M2-1，M2-1 阻塞 M2-3，形成一条永远到不了终点的串行链；
- 旧 Rust 代码是为 parity 长出来的，不是为整厂运行时设计的；继续打补丁会把迁移债变成架构债。

v2 改用**纵向切片**：每个阶段结束都必须有一个能启动、能跑、能验收的产品能力，而不是一组“已对齐的函数”。

## 3. Clean-room 规则

从本文件生效起，v2 的实现者遵守以下规则：

**禁止读取：**

- `src/sim/**`、`src/server/**`、`src/client/**` 下的旧实现代码；
- 旧 `rust/**` 已删除；不得从 v0.11.23 tag 或其他副本读取其源码、注释、测试与生成器；
- 任何旧代码的复制、改名、注释改写或“照着抄结构”。

**允许使用：**

- `README.md`、`docs/*.md` 中的产品规格、单位、边界、验收口径；
- 公开教材、论文与标准：ASM1、ASM2d、ADM1、Takács、BSM1/BSM2；
- 把旧版本当作黑盒运行，通过 HTTP/API/CLI 观察输入输出，不读源码；
- 用户明确给出的需求与验收标准。

**实现要求：**

- 使用 Rust 领域语言命名，按 v2 自己的模块边界组织；
- 每个模型公式必须能追溯到公开文献或产品规格，不靠“旧代码就是这么写的”；
- 测试以公开基准、物理守恒和产品验收为主；如使用旧版本黑盒输出做对照，必须在测试中标注来源与用途；
- 代码审查时先问“这个模块解决哪个产品问题”，再问“数值是否对”。

## 4. 目标架构

```text
rust-v2/
├── Cargo.toml                 # 独立 workspace，不加入旧 rust workspace
├── crates/
│   ├── aquapilot-domain/      # 拓扑、单元、物流、单位、校验、ID
│   ├── aquapilot-model/       # ASM1/ASM2d/ADM1/Takács、参数、速率、化学计量
│   ├── aquapilot-engine/      # 编译、拓扑排序、水力、整厂状态、步进、快照、三本账
│   ├── aquapilot-service/     # Axum HTTP/WS、任务队列、持久化、报表、鉴权
│   └── aquapilot-cli/         # simulate / experiment / study / report
└── fixtures/                  # 公开基准与产品验收输入，不放旧代码导出物
```

依赖方向：`domain ← model ← engine ← service ← cli`。`engine` 不依赖 `service`，`model` 不依赖 `engine`，避免把 HTTP 关注点漏进物理层。

技术选择：

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 异步运行时 | Tokio | HTTP/WS 与后台实验队列 |
| HTTP | Axum | 轻量、类型安全、易做 OpenAPI |
| 序列化 | serde / serde_json | 拓扑、快照、API |
| 错误 | thiserror / anyhow | 领域错误与边界错误分开 |
| CLI | clap | 单二进制交付 |
| 持久化 | SQLite（rusqlite，bundled） | 单文件、可备份、无外部服务 |
| 观测 | tracing + metrics | 结构化日志与 Prometheus |
| 随机 | rand_chacha | 可复现实验 |
| 数值 | f64 + 显式子步 | 先保证稳定与守恒，再谈性能 |

v2 首版不引入 Node。前端作为静态资源由 Rust 服务托管；v2.0 先做最小只读仪表盘与 API，完整 2D 编排器在 v2.1 接回，不复用旧前端源码。

## 5. 领域模型（先定，后写代码）

### 5.1 单位契约

| 量 | 单位 |
| --- | --- |
| 流量 | m³/h |
| 浓度 | mg/L = g/m³ |
| 质量 | kg |
| 时间（引擎） | min |
| 时间（报表） | d |
| 功率 | kW |
| 电耗 | kWh |
| 碱度 | mol HCO₃/m³；展示为 mg/L as CaCO₃ |

### 5.2 拓扑

- `PlantTopology`：单元、连接、预设、版本；
- `Unit`：`Reactor` / `Clarifier` / `Influent` / `Effluent` / `Splitter` / `SludgeLine`；
- `Connection`：`from`、`to`、`stream`、`recycle_kind`、几何 meta；
- 编译期完成：拓扑排序、循环检测、系列回溯、端口/物流校验、流量守恒；
- 编译失败必须返回可读错误，不允许静默跳过单元。

### 5.3 整厂状态

- `PlantState`：时间、拓扑快照、反应器状态、二沉池、水力、仪表、资产、控制层、全厂账本；
- `Snapshot`：全量帧与增量帧共用同一投影函数；
- 所有状态字段必须可序列化、可回放、可测试；不允许把关键状态藏在闭包里。

## 6. 数值与验收口径

- 显式欧拉，子步上限 1 min；ASM2d 网络按子步积分；
- 负值/非有限值在物理边界钳制，并记录诊断码；不在展示层修数；
- 三本账按“进水 + 回流 − 出水 − 排泥 − 沼气 COD − 氧化 − 反硝化 − 库存变化”计算；
- 闭合判据：`|残差| / (进水 + 回流) ≤ 5%`，超阈值只告警、不阻断仿真；
- BSM1 Table 6 作为 ASM1 行为门禁；30 天三本账作为全厂门禁；
- 每阶段必须同时有：单元测试、网络级集成测试、守恒测试、无 NaN/负值测试。

## 7. 纵向切片与硬门禁

### V2-0 骨架与单池（本阶段）

交付：

- 新 workspace、domain 模型、ASM1 13 组分单池 CSTR；
- CLI `simulate --topology ... --minutes ...`；
- 输出 JSON 快照；
- 测试：24 h 内 NH 下降、COD 下降、无 NaN、质量守恒趋势。

硬门禁：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿；CLI 能跑 24 h 并输出有限值。

### V2-1 整厂 ASM1

交付：

- 多反应器拓扑编译、入流聚合、RAS/内回流、Takács 风格 10 层二沉池、曝气/DO 控制；
- 30 天 ASM1 整厂运行；
- 出水、MLSS、回流量、二沉池剖面、WAS 可观测；
- BSM1-like 30 天门禁；官方 BSM1 Table 6 对照为后续补强项。

硬门禁：30 天无发散、无负值泄漏；三本账正负残差可解释；BSM1 关键指标落在公开门限内。

### V2-2 全厂 ASM2d + ADM1（已完成）

当前进度（2026-11-28）：

- [x] ASM2d 19 组分、21 过程、公开化学计量矩阵与速率方程；
- [x] A2O 整厂路径：厌氧/缺氧/多级好氧 + 10 层二沉池 + RAS/内回流/WAS；
- [x] 30 天 A2O 运行：出水 COD 44.41、NH4-N 0.771、TN 9.767、TP 1.004、SS 11.44 mg/L；
- [x] COD/N/P 三本账闭合（残差 2.13% / 1.09% / 1.52%，均低于 5% 门限）；
- [x] 多系列二沉池：`asm2d_parallel` 并行系列编排、逐系列二沉池/RAS/WAS、全厂流量与三本账汇总；2×500 m3/h fixture 与单系列结果一致；
- [x] ADM1 核心 CSTR：24 个动力学组分 + 2 个强离子状态、22 个过程、pH/电荷平衡、准稳态气相、COD/N 双账；
- [x] 独立泥线单元：重力浓缩 + ADM1 消化 + 机械脱水 + 沼气 + 磷示踪，20 天 COD/N/P 账 0.00% / 0.00% / 0.00%；
- [x] ASM2d→ADM1 双向接口：A2O 二沉池底流接入泥线，泥线回流液翻回 ASM2d，边界 COD/N/P 守恒；CLI `asm2d-sludge`；
- [x] 泥线回流闭环：浓缩溢流 + 滤液合并回 A2O，successive substitution 4 次收敛；30 天整厂 COD/N/P 残差 -1.03% / 2.19% / 0.71%，均 closed；CLI `asm2d-loop`；
- [x] PAC 基础投加：产品 40 mg/L、Al2O3 品位 30%，投 `aerobic-3`，按三价金属当量映射 `X_MeOH`；PAC + 回流闭环 6 次收敛，净化学除磷 1,751.8 kg/30 d，出水 TP 从 3.872 降到 1.760 mg/L，整厂 P 账 1.31% closed；CLI `asm2d --pac-dose` / `asm2d-loop --pac-dose`；
- [x] 三级过滤 + PO4 抛光：二沉池后捕集 90% TSS，按 70% 经验效率去除溶解 PO4；PAC 20 mg/L + 回流闭环 30 天出水 COD 41.66、NH4-N 0.617、TN 10.073、TP 0.387、SS 1.18 mg/L，关键指标达到 GB 18918 一级 A 常见限值；整厂 COD/N/P 残差 -1.07% / 2.16% / 1.29%，均 closed；CLI `asm2d --tertiary-tss-removal --tertiary-po4-removal` / `asm2d-loop`；

交付：

- ASM2d 19 组分逐池积分、生物除磷、PAC 基础投加、三级过滤 + PO4 抛光；
- 泥线：浓缩、消化、脱水、沼气、浓缩溢流 + 滤液回流；
- 30 天整厂 COD/N/P 三本账闭合；
- 多系列二沉池。

硬门禁：三本账 `closed=true`；ASM2d 状态边界诊断可见；出水门与 PAO 循环通过。V2-2 已按关键指标 + 三本账闭合验收；BOD、粪大肠菌群、色度等未建模，不能宣称全指标合规。

### V2-3 服务与实验（进行中）

已交付（2026-11-28）：

- [x] `aquapilot-service` crate：Axum HTTP、SSE 状态流、OpenAPI 3.1、RFC 9457；
- [x] SQLite 持久实验队列：`queued/running/succeeded/failed/cancelled`、幂等键、队列满 429 + `Retry-After: 30`；
- [x] 取消/恢复：queued 立即取消，ASM1/ASM2d 逐步检查；运行中重启自动重新入队；
- [x] CSV/Markdown 报告、`GET /api/health`、CLI `serve` 单二进制；
- [x] 请求步数/采样预算、ADM1 时间步保护、原子取消、`backup` 一致快照；
- [x] 18 项 service 单元测试 + 1 项 worker 集成、60 s soak smoke（30 个实验全部成功）；
- [x] 同源可视化编排台（`GET /`、`GET /api/v1/presets`）；浏览器实测 8 个 preset、场景注入、新增反应器、ASM1/ASM2d 提交；
- [x] 代表性端到端矩阵 11/11 通过（`docs/coverage-matrix.json`），覆盖 5 个服务模型 + 5 类工况，93.386 s；最大三本账残差 2.85%。

未完成：

- [ ] 24 h soak 与正式 `summary.json`（当前只有 60 s smoke 和代表性矩阵，`completed_24h=false`）；
- [ ] WebSocket（当前用 SSE）、Bearer 角色鉴权、MCP；
- [ ] 长模型（`asm2d-adm1-loop`/`adm1`/`sludge-line`）的运行中取消只能在下一次运行边界生效。

硬门禁：OpenAPI 契约测试、幂等重放、队列满 429、取消语义、24 h soak 有 `summary.json`。前四项已测；代表性矩阵已过，但 wall-clock 24 h 未过，V2-3 仍不能标完成。

### V2-4 界面与工业验收（进行中，0.0.9 自由拓扑、0.0.10 自由拓扑工况已落）

已交付（2026-11-28）：

- [x] 同源单文件工艺编排台：8 个 preset，A2O 画布，反应器增删/拖拽/参数编辑，二沉池/内回流/PAC/三级过滤/进水边界；
- [x] 工况注入：高流量、低 DO、冬季、PAC 停加、过滤旁路、厌氧扩容；
- [x] SSE 实验监看、队列、出水指标、三本账、趋势图、CSV/报告下载；
- [x] 高级 JSON 导入导出；ASM1/ADM1/泥线从同一页面提交；
- [x] ASM1 任意节点/分支的可视化编排：增删节点、连接表、内回流/RAS/WAS、服务端编译预览；`docs/topology-journey.json` 3 预设 + 编辑后 1 d 运行；
- [x] 告警、评分卡、日/周汇总；UI 显示评分卡/告警并下载 `daily.csv`/`weekly.csv`；
- [x] 五条角色旅程：暴雨、风机故障、三级过滤 what-if、7 d 周报、脏数据；`docs/journeys-v2.json` 5/5 通过。

未完成：

- [ ] ASM2d 分支管网与多系列画布（当前 A2O 仍是线性池链）；
- [ ] OPC UA/Modbus/MQTT 模拟适配层与写审计；
- [ ] AI Provider、审计链、限流、看门狗；
- [ ] 24 h wall-clock 内存/句柄验收（`completed_24h=false`）。

硬门禁：五条角色旅程与自由拓扑验收旅程已通过；24 h soak 内存/句柄无增长仍未通过，V2-4 不能标完成。

## 8. Cutover Gate

v2 不直接替换 TS 生产入口。满足以下条件才切换：

1. 同一拓扑、同一进水、同一种子，30 天运行；
2. 出水六项指标、反应器库存、三本账残差与旧版黑盒输出在约定容差内；
3. API 契约兼容（或提供明确迁移层）；
4. 24 h soak 通过，内存/句柄稳定；
5. 回滚方案可执行：旧 TS 二进制与数据目录保留。

不满足就继续双轨，不搞“大爆炸”切换。

## 9. 时间盒与停止线

按一个主线 agent 连续执行，粗排：

| 阶段 | 目标 | 时间盒 |
| --- | --- | --- |
| V2-0 | 骨架 + 单池 + CLI | 2–3 天 |
| V2-1 | 整厂 ASM1 + 二沉池 | 7 个工作日 |
| V2-2 | ASM2d + ADM1 + 三本账 | 10 个工作日 |
| V2-3 | 服务 + 实验 + soak | 7 个工作日 |
| V2-4 | 界面 + 工业验收 | 10 个工作日 |

停止线：

- V2-1 超过 10 个工作日仍未跑通 30 天 ASM1：缩减 v2.0 范围为“ASM1 + 单系列”，ASM2d/ADM1 后置；
- V2-2 三本账 15 个工作日仍未闭合：先交付“可运行 + 可诊断”，不冒充工业闭合；
- Cutover 失败：继续 TS 产品，v2 保留为实验引擎，不阻塞产品交付。

## 10. 立刻执行

1. 删除旧 `rust/` parity 线：不再新增切片，不再为它发版本；历史只在 v0.11.23 tag；
2. 新建 `rust-v2/`，按第 4 节建 workspace；
3. 写 `docs/CLEAN-ROOM.md`，把第 3 节规则变成可检查清单；
4. 完成 V2-0：domain + ASM1 单池 + CLI + 测试；
5. 把 v2 CI 接入现有质量门禁，旧 Rust CI 保留但不再扩展；
6. 每完成一个纵向切片，更新 `WORKLOG.md` 与本文件的状态表。

## 11. 状态表

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 旧 Rust parity 线 | 冻结 | v0.11.23 为最后 checkpoint |
| V2-0 骨架 + 单池 | 已完成 | `rust-v2/`；单池与三段串联 24 h 跑通；当前全工程 22 项测试 |
| V2-1 整厂 ASM1 | 已完成 | 5 池 + 二沉池 + RAS/内回流 + DO；30 天 BSM1-like 出水 COD 58.01、SS 12.20、NH4-N 0.292；官方参数集 S_S/SS/NO3/碱度/MLSS 接近 Table 6，NH4/DO 未全过；校准候选在 ±20% 内通过 Table 6 关键指标 |
| V2-2 ASM2d + ADM1 | 已完成 | ASM2d 19 组分/21 过程 + A2O 整厂 30 天跑通，内部 COD/N/P 账 2.13%/1.09%/1.52% 闭合；多系列 2×500 m3/h 汇总通过；ADM1 核心、独立泥线、双向接口与回流闭环已落，整厂 COD/N/P 残差 -1.03%/2.19%/0.71% 均 closed；PAC 基础投加 + 三级过滤已落，PAC + 三级过滤回流闭环 TP 0.387 mg/L，整厂 COD/N/P -1.07%/2.16%/1.29% 均 closed |
| V2-3 服务 + 实验 | 进行中 | `aquapilot-service` + CLI `serve`/`backup`；26 项 service 单测 + 1 项 worker；60 s smoke 30/30；代表性矩阵 11/11（5 模型 + 5 工况，93.386 s）；24 h soak 未跑 |
| V2-4 界面 + 验收 | 进行中 | 同源编排台：8 preset、A2O 画布、ASM1 自由拓扑画布（增删节点/连接/回流边、服务端编译）、回流/二沉池/PAC/三级过滤、工况注入、SSE/队列/趋势/报告；0.0.8 评分卡/告警/日周汇总 + 五条角色旅程；0.0.9 自由拓扑验收 3 预设 + 编辑后 1 d 运行（`docs/topology-journey.json`）；0.0.10 自由拓扑工况（高流量/低 DO/冬季）；截图 `v2-ui-topology.png`、`v2-ui-topology-scenarios.png` 等；ASM2d 分支管网、工业接口、AI/审计和 24 h soak 未完成 |
| Cutover | 未开始 | — |

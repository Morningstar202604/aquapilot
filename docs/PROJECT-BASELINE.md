# AquaPilot 项目基线（Project Baseline）

> 文档类型：工业级项目基线 / 单一事实源  
> 基线日期：2026-11-26  
> 维护责任：项目负责人（架构、仿真、交付同一责任人）  
> 变更规则：任何影响范围、接口、质量门禁的变更，必须在本文件、`docs/INDUSTRIAL-READINESS-PLAN.md`、`CHANGELOG.md` 同一提交内同步，禁止只在聊天记录里口头约定。

## 0. 版本锚点与远程一致性

| 层级          | 版本     | 提交   | 状态                                    |
| ------------- | -------- | ------ | --------------------------------------- |
| 本地 `main`   | `0.11.20` | `HEAD` | M1b phase 1、入流聚合、4–7 parity；stepNetwork 未移植 |
| 五平台 `main` | `0.11.20` | `HEAD` | 待推送后复核 |
| 当前工作树    | clean    | —      | 全部回归门禁通过 |

一致性结论：`v0.11.20` 推送后须用 `git ls-remote` 复核到同一提交；
若后续再改动，必须重新推送并复验，不能沿用本文的旧哈希。

核对命令：

```bash
git rev-parse --short HEAD
git rev-parse --short origin/main
git status --short
git log --oneline --decorate -3
```

## 1. 当前核心状态

### 1.1 产品定位

面向污水处理厂的**仿真建模软件**：以可复现的模型/实验为核心，AI 全流程自主编排；
用高精度检测、多维度验证与可审计 provenance，保证稳定、高效、优质的输出。

实时控制室仍是产品入口，但模型、实验、研究、验证报告和 API 才是可被集成、被审计、
被复现的部分。当前前端仍是 2D 工艺编排 + 数据面板 + AI 助手，不宣称 3D 厂区/无人闭环。

### 1.2 技术栈与规模

| 层       | 技术                                                         | 代码量（行） |
| -------- | ------------------------------------------------------------ | -----------: |
| 仿真内核 | TypeScript，ASM1 / ASM2d / ADM1 / Takács / 水力学 / 质量平衡 |       14,534 |
| 服务端   | Node 22、原生 `http`、`ws`、文件持久化、Modbus TCP 适配      |       12,058 |
| 领域模型 | 拓扑、预设、编辑、交换、输入校验                             |        2,404 |
| AI 层    | Provider 适配、提示词、审计、限流                            |        2,130 |
| 共享类型 | 协议、配置、时间、版本                                       |        1,502 |
| 前端     | React 19、Vite、ECharts、@xyflow/react                       |       10,132 |
| 测试     | Vitest，144 个文件                                           |       22,574 |
| 合计     | —                                                            |   **48,331** |

### 1.3 质量门禁现状

最近一次全量 `npx vitest run --coverage`（2026-11-25，v0.11.14）：

| 指标                          | 结果                                     |
| ----------------------------- | ---------------------------------------- |
| 测试文件                      | 144                                      |
| 用例                          | 1,739                                    |
| 通过                          | 1,739                                    |
| 失败                          | 0                                        |
| 覆盖率 lines/branches/functions | 94.11% / 82.15% / 95.23%（阈值 90/81/95） |
| 预期失败占位                  | 0（全部为普通 `it`，无 `it.fails`/skip） |
| `tsc --noEmit`                | 通过                                     |
| `lint` / `prettier` / `build` | 通过                                     |
| 研究领域/服务/API             | 13 项测试通过                            |
| Rust 内核                     | 101 项（53 单元 + 48 集成/parity/fuzz）   |
| ASM1 CSTR/网络                | 3 项 TS 不变量 + Rust 1e-12 parity 通过  |
| 整厂 production replay        | 96 步 × 15 min；最大残差 1.73e-9，容差 1e-8 |
| M2-2 Rust ops parity          | 14 watchdog / 5 decision / 2 rate / 9 URL  |
| Takács 二沉池                 | 24 h BSM1 profile，Rust↔TS 64 f64 ulp 内 |

WP2 门禁：

- `tests/plantBoundary.test.ts` — 30 d 稳态 COD/N/P 三本账残差全部 <5% 且 `closed=true`。
  当前 COD 4.93% / N 4.64% / P 4.89%；生物学、出水门与 PAO 循环均通过。

这意味着 **WP2 已达到“工业级可审计闭合”**；没有放宽容差、没有 `it.fails`、没有投影反推。

### 1.4 已运行的工业接口

- `/api/hydraulics`
- `/api/plant/balance`
- `/api/instruments`
- `/api/control/interlocks`
- `/api/assets`
- `/api/compliance/*`
- `/api/calibration/uncertainty`
- `/api/protocols/*`

协议层：28 个标签，Modbus TCP FC03/04/06/16 真 socket，断线指数退避 100→1000 ms，写审计可查。

### 1.5 当前不承诺的能力

以下内容尚未达到可对外承诺的工业级证据：

- 真实水厂标定数据闭环；
- 真实 PLC / OPC UA / Modbus 现场接入；
- SIS/ESD 功能安全认证；
- 法定排放报表签字；
- 3D 厂区实时渲染；
- 全自动 AI 无人闭环与全场景规则库；
- 5 个工业技术社区的正式上线；
- 全量代码语言迁移。

## 2. 已交付功能清单

| 编号 | 能力                                                     | 状态                                      | 主要证据                                                   |
| ---- | -------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| WP1  | ASM1 温度/pH/游离氨抑制、KLa 氧传递、DO PI、风机功率     | 已完成（本地）                            | `src/sim/aeration.ts`、`tests/aeration.test.ts`            |
| WP2  | ASM2d 生物除磷 + ADM1 泥线闭环                           | **部分交付**                              | 水质/MLSS/PAO 循环可达；三本账与三路径未闭合               |
| WP3  | 阻力分流、管渠容积/输运延迟、多系列/多二沉池             | 已完成（本地）                            | `tests/hydraulics.test.ts`、`tests/networkPhysics.test.ts` |
| WP4  | 传感器死时间/漂移/卡死、执行器速率限制、6 条联锁、ESD    | 已完成（本地）                            | `src/sim/instruments.ts`、`src/sim/controlLayer.ts`        |
| WP5  | 参数后验、置信区间、蒙特卡洛、P10/P50/P90                | 已完成（本地）                            | `src/sim/calibration.ts`、`src/sim/uncertainty.ts`         |
| WP6  | 日混合样、95% 分位、QA 剔除、CSV、422/400                | 已完成（本地）                            | `src/sim/compliance.ts`、`src/server/routes/compliance.ts` |
| WP7  | 21 台设备、故障/维护/备机/ESD 锁存                       | 已完成（本地）                            | `src/sim/assets.ts`、`src/sim/maintenance.ts`              |
| WP8  | 28 标签、Modbus 真 socket、退避、写审计                  | 已完成（本地）                            | `src/server/protocols/*`                                   |
| WP9  | 回归、构建、浏览器验收、文档                             | 已完成（本地），但 WP2 红灯使总验收不成立 | `docs/INDUSTRIAL-READINESS-PLAN.md` §3.6                   |
| 基础 | 拓扑编辑、工艺画布、趋势、回放、AI 对话、CLI、单文件 exe | 已存在                                    | `src/client/*`、`src/cli.ts`、`scripts/build-exe.mjs`      |

“已完成（本地）”不等于“远程已合并”。截至 v0.11.19，五平台 `main` 与 tag 已一致；v0.11.20 待推送后复核。

## 3. 待开发任务池

### P0 — 阻塞发布（已全部关闭，v0.11.14）

| ID    | 任务               | 完成定义                                                         |
| ----- | ------------------ | ---------------------------------------------------------------- |
| P0-01 | WP2 三本账闭合     | 30 d COD/N/P 残差 ≤5%，`closed=true`，无投影/反算归零            |
| P0-02 | WP2 三条除磷路径   | 生物除磷开关、PAC、厌氧旁路三者出水 TP 与 X_PP/X_PHA 可分辨      |
| P0-03 | ASM2d 氨化计量     | `ammonification` 恢复为守恒路径；批次 `X_S` 含氮释放测试通过     |
| P0-04 | 移除全部红灯       | 全量 1,739 用例 0 failed，0 expected-fail；禁止删断言/放宽阈值   |
| P0-05 | 基线文档与远程同步 | 远程 main、CHANGELOG、README、本文件版本一致；未推送内容明确标注 |
| P0-06 | 语言迁移决策       | ADR 通过评审，冻结黄金向量，确定迁移边界                         |

### P1 — 工业级能力（进行中）

当前进度：P1-01 的 TS→Rust 六项模块切片（ASM1/ASM2d/ADM1 CSTR/ADM1 泥线/Takács/水力输运）均已 parity，水力模块已有随机差分与属性不变量，三本账已有 96 步 parity，整厂 production `stepNetwork` 轨迹 96 步逐态 replay 已通过；M1 的模块切片与预捕获 replay 完成，但整厂闭环未被 Rust 独立执行，M1b 正在补此缺口，P1-01 暂不整体标完成。v0.11.15 完成 M2-2 的 Rust AI Provider / 哈希链审计 / 限流 / 看门狗（17 项测试，TS oracle 逐项 parity）；v0.11.16 冻结 HTTP/WS 契约（32 legacy / 9 versioned / 19→14 WS），但 Rust 服务端尚未实现；v0.11.17 补 M1b 的 forcing/influent parity；v0.11.18 补 `solveBiomass`/`solveEffluent`/`solveEnergyAndCost`/metrics/alarms 纯函数；v0.11.19 补 phase 1 调蓄与告警历史；v0.11.20 补 `aggregateInflow`；整厂 `stepNetwork` 仍未移植；P1-03 仍缺 24 h 墙钟 soak 报告。P1-04 3D 厂区未开始；P1-05/06 持续迭代。

| ID    | 任务               | 完成定义                                                   |
| ----- | ------------------ | ---------------------------------------------------------- |
| P1-01 | 仿真内核语言迁移   | 确定性内核在目标语言中与 TS 黄金结果逐点对齐               |
| P1-02 | 全自动 AI 推演闭环 | 规则库覆盖正常/极端/故障；可无人值守出报告，可人工干预     |
| P1-03 | 7×24 调度          | 断点恢复、看门狗、任务队列、背压、幂等、长时无泄漏         |
| P1-04 | 3D 厂区            | 真实拓扑映射、实时状态着色、视角自由切换、性能预算         |
| P1-05 | 可视化升级         | 推演过程参数、时序、物料流、报警联动可追溯                 |
| P1-06 | 代码重构           | 全量逐文件审计；重复代码、死分支、无意义抽象清零；模块解耦 |

### P2 — 交付与生态

| ID    | 任务             | 完成定义                                                   |
| ----- | ---------------- | ---------------------------------------------------------- |
| P2-01 | 工业场景压力测试 | 高复杂度全周期用例 100% 场景覆盖；并发/长稳/精度报告       |
| P2-02 | 现场验收门       | 真实标定数据、PLC/OPC UA/Modbus、SIS/ESD、法定报表逐项签字 |
| P2-03 | 5 社区上线       | GitHub/GitCode/Gitee/掘金/知乎（或等价工业社区）发布记录   |
| P2-04 | README 交付      | 3D 截图、精度校验报告、部署/回滚/运维手册齐全              |
| P2-05 | 品牌质感         | 平滑过渡动画、操作指引、异常提示、3D 视角、统一视觉规范    |

## 4. 迭代规划路线图

### M0 — 基线与语言决策（当前）

退出条件：

- 本文件与远程 `origin/main` 锚点一致；
- ADR-0001 语言选型通过；
- 黄金输入/输出向量冻结；
- WP2 三个红灯的根因有可复核记录。

### M1 — 确定性内核迁移

状态：**模块 parity 与预捕获 production replay 已满足（v0.11.14，2026-11-25）；整厂闭环另立 M1b**。整厂 production replay 见
`docs/PLANT-REPLAY.md`；replay 重建的是 TS 捕获的每步 pre-state，不等于 Rust 自己跑
`stepNetwork`。M1 关闭不推导 M2 完成。

退出条件：

- 新内核通过 ASM1/ASM2d/ADM1/水力学/质量平衡的逐点 parity；
- 新旧内核在同一输入下出水、库存、三本账误差在约定容差内；
- 不引入 `unsafe`；无 panic 泄漏到服务层；fuzz/属性测试通过。

### M1b — 整厂 networkEngine 闭环移植（进行中）

状态：**强迫/进水、phase 1 调蓄、入流聚合、phase 4–7、告警历史已 parity（v0.11.20）；反应器求解、二沉池与 `stepNetwork` 未移植。**

| 层 | 状态 | 证据 |
| --- | --- | --- |
| `forcing.ts` 强迫函数 | **已满足** | 112 组 TS oracle 逐项一致，`tests/forcing_parity.rs` |
| `deriveInfluent` / `sampleAt` | **已满足** | 1098 组合成/真实序列/uncertainty 用例一致 |
| phase 1 `resolveHydraulics` | **已满足（纯函数）** | 10 组暴雨调蓄/缓释/最低流量用例一致 |
| phase 4 `solveBiomass` | **已满足（纯函数）** | 36 组 simple/ASM1/ASM2d 用例一致 |
| phase 5 `solveEffluent` | **已满足（纯函数）** | 48 组出水与 PAC 截断用例一致 |
| phase 6 `solveEnergyAndCost` | **已满足（纯函数）** | 24 组能耗/成本/三本账积分用例一致 |
| phase 7 告警规则 + 出水评分 | **已满足（纯函数）** | 12 组 metrics、12 组三种标准告警用例一致 |
| `aggregateInflow` | **已满足（纯函数）** | 12 组外部水/反应器/RAS/内回流/顺序/零流量用例一致 |
| 告警历史 `AlarmLedger` | **已满足（纯函数）** | 45 分钟去重、序号、80 条上限 7 组用例一致 |
| `createNetworkState` / `NetworkSimState` | **未完成** | 依赖拓扑编译、水力、仪表、资产、控制层、全厂边界 |
| phase 2–3 `solveReactors` / `solveClarifier` / `aggregateInflow` | **未完成** | 尚未移植，`stepNetwork` 无法闭环 |
| `stepNetwork` 七阶段编排 + `PlantSnapshot` | **未完成** | 尚无整厂顺序执行、趋势与快照 |

M1b 的退出条件是 Rust 能独立跑完整整厂闭环，并与 TS 在同输入下逐态对齐；
不是重复模块测试，也不是拿 TS pre-state replay 冒充闭环。M1b 完成前，M2-1
服务端不具备自带仿真的前提。

### M2 — 服务端与 AI 编排迁移

状态：**M2-1 契约冻结、M2-2 已完成（v0.11.16）；M2-1 服务端因 M1b 未完成而继续阻塞，M2-3 未完成，M2 总里程碑不关闭。**

| 退出条件 | 状态 | 证据 |
| --- | --- | --- |
| HTTP/WS/协议/持久化接口契约不变 | **未完成** | `rust/golden/http-contract.json` 已冻结 32 legacy / 9 versioned / 19→14 WS；Rust 服务端尚未实现，生产监听仍是 TypeScript |
| AI Provider、审计、限流、看门狗在目标语言中可用 | **已满足** | `rust/crates/aquapilot-ops` + `tests/ops_parity.rs`；见 `docs/M2-SERVICES.md` |
| 7×24 soak 测试通过，内存/句柄无增长 | **未完成** | `scripts/soak.ts` 已具备真实墙钟采样与 boot id 防伪；v0.11.15 与 v0.11.16 两轮 TS soak 均中断（v0.11.16 仅 19 个样本、18 分钟，无 `summary.json`，进程已消失且宿主 boot id 已变化），无有效 24 h 记录 |

M2-2 不是服务端迁移：crate 尚未接线到生产入口。不得用“Rust 已有 ops crate”
冒充“HTTP/WS 已迁移”，也不得用 1 分钟 soak 或跨重启样本冒充 24 h。
M2-1 的契约 crate 是迁移义务清单，不是服务端实现。

### M3 — 3D 与全自动推演

退出条件：

- 3D 厂区与拓扑、实时状态、报警、操作联动；
- 规则库覆盖全部工艺分支与故障场景；
- 无人值守报告与人工干预均可复现。

### M4 — 工业验收与发布

退出条件：

- 现场验收门逐项完成；
- 全量压力/精度/合规报告归档；
- 5 社区上线；
- README、截图、回滚方案齐全。

## 5. 开源溯源与复用边界

### 5.1 模型来源

| 模型/算法     | 来源                              | 复用方式                    | 边界                                                                    |
| ------------- | --------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| ASM1 / BSM1   | Henze et al., 1987；BSM1 基准报告 | 按公开论文/基准方程独立实现 | 不复制第三方代码；参数与状态方程在 `src/sim/asm1.ts`、`src/sim/bsm1.ts` |
| ASM2d         | Henze et al., 1999                | 按标准矩阵独立实现          | 19 组分、生物除磷、PAO 储存池；实现自研                                 |
| ADM1          | Batstone et al., 2002             | 按标准矩阵独立实现          | 泥线消化；实现自研                                                      |
| Takács 二沉池 | Takács et al., 1991               | 按公开模型独立实现          | 10 层固体通量；实现自研                                                 |
| GB 18918-2002 | 国家标准                          | 规则引擎与报表口径          | 不复制标准正文；仅引用限值                                              |

### 5.2 运行时与工具依赖

| 依赖                      | 版本          | 许可证     | 复用范围       |
| ------------------------- | ------------- | ---------- | -------------- |
| React / React DOM         | 19.3.1        | MIT        | UI 运行时      |
| @xyflow/react             | 13.0.2        | MIT        | 工艺画布       |
| ECharts                   | 6.1.0         | Apache-2.0 | 趋势/回放图表  |
| ws                        | 8.23.0        | MIT        | WebSocket      |
| csv-parse / csv-stringify | 7.0.3 / 6.9.0 | MIT        | CSV 导入导出   |
| valibot                   | 1.5.x         | MIT        | 运行时校验     |
| Vite / Vitest             | 8.3.8 / 5.1.1 | MIT        | 构建/测试      |
| TypeScript                | 6.0.3         | Apache-2.0 | 类型系统       |
| esbuild                   | 0.28.2        | MIT        | 服务端打包/SEA |
| Playwright Core           | 1.65.1        | Apache-2.0 | 浏览器验收     |

复用原则：

1. 只复用成熟底层能力，不引入与仿真核心无关的功能；
2. 所有第三方能力必须通过适配层与核心计算链路解耦；
3. 不把开源项目当图床、素材库或备份盘；
4. 新增依赖必须记录许可证、维护状态、替代方案与退出路径；
5. 详细审计见 `docs/REUSE-AUDIT.md` 与 `docs/DEPENDENCY-EVALUATION.md`。

## 6. 变更控制

- **单一事实源**：远程 `origin/main` + 本文件 + `CHANGELOG.md`。
- **每次提交**：必须写明影响的工作包、测试证据、未完成项；禁止用“预期失败”掩盖红灯。
- **文档同步**：接口、版本、验收阈值变更未同步文档的提交，不进入发布分支。
- **回滚**：任何迁移/重构必须保留上一版可运行产物与回滚脚本。
- **审计**：质量平衡、合规报表、协议写操作均保留输入、参数、输出、版本四元组。

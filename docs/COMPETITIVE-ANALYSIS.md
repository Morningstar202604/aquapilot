# AquaPilot 竞品深度对标

> 目的：回答一个具体问题——**AquaPilot 到底比同领域开源项目多做了什么，少了什么。**
> 所有事实均通过 GitHub API 在 2026-10-29 核实（star / 最近推送 / 许可证 / README 内容）。
> 无法核实的一律标注「未核实」，不凭印象补全。

---

## 一、对标对象与选择理由

| 项目 | 类型 | 选择理由 |
|---|---|---|
| [fau-evt/bsm2-python](https://github.com/fau-evt/bsm2-python) | Python 库 | IWA 标准 BSM1/BSM2 最完整实现，有论文与 CI |
| [QSD-Group/QSDsan](https://github.com/QSD-Group/QSDsan) | Python 平台 | 工艺建模 + TEA + LCA 一体化，学术影响力最大 |
| [toogad/PooPyLab_Project](https://github.com/toogad/PooPyLab_Project) | Python 软件 | 明确支持「用户自建流程图做稳态计算」，与本项目拓扑编辑直接可比 |
| [dgaida/PyADM1ODE](https://github.com/dgaida/PyADM1ODE) | Python 框架 | ADM1 厌氧侧最活跃实现，含参数辨识扩展 |
| [alexha11/Junction-2025](https://github.com/alexha11/Junction-2025) | 全栈应用 | FastAPI + React + 多 agent，最接近「AI 值守 + Web 界面」形态 |
| [Gift404/wwtw-digital-twin](https://github.com/Gift404/wwtw-digital-twin) | 全栈应用 | 明确声明「对厂控只读」的企业级数字孪生，工程化程度高 |
| [wwtmodels/Activated-Sludge-Models](https://github.com/wwtmodels/Activated-Sludge-Models) | 文档/模型集合 | 模型权威性参照 |

**为什么没选 GPS-X / BioWin / SIMBA#**：商业闭源，无法读实现做逐项比对，只能做功能清单比较（在下文「商业参照」一节单独说明）。

---

## 二、逐项目事实清单

### 2.1 fau-evt/bsm2-python

**核实事实**
- Python；BSD-3-Clause；44 stars / 10 forks；最近推送 2025-09-09
- 实现 BSM1/BSM2，提供 5 种开箱配置：`BSM2OL`（开环）、`BSM2CL`（曝气控制 + 第 4 池 PID）、`BSM2OLEM`（含能量管理）、`BSM1OL`、`BSM1AC`
- 附带 CHP/锅炉/火炬能量管理与小型技术经济分析
- `tests/` 含单元测试与参考结果文件；有 GitHub Actions CI 与 GitLab 覆盖率徽章
- README 明确：**无 GUI**（列为未完成 roadmap 项）
- 维护为兼职，「don't expect rapid development」
- 论文：Miederer et al., *Energy Reports* 13 (2025)

**与 AquaPilot 对照**

| 维度 | bsm2-python | AquaPilot |
|---|---|---|
| 模型标准性 | **强**：完整 BSM1/BSM2 + 官方验证参考文件 | 中：ASM1 + Takács，BSM1 Table 6 对照在测试里 |
| 厌氧/能量侧 | **强**：ADM1 侧 + CHP + 技术经济 | 水线运行侧；ADM1 standalone，未接 BSM2 全流程 |
| 拓扑/流程图编辑 | 无（代码定义布局） | **有**：可视化编排 + 版本历史 + 回滚 |
| Web 界面 / 实时 | 无 | **有**：WebSocket 实时 + 增量帧 |
| AI 决策 | 无 | **有**：候选生成 + 护栏 + 影子对照 |
| 不确定性 | 无 | **有**：固定扰动集合 P10–P90 |
| 参数灵敏度 | 无 | **有**：中心差分（本次新增） |
| Pareto 前沿 | 无 | **有**（本次新增） |
| 质量平衡审计 | 测试里有守恒断言 | **有**：运行时可见审计（本次新增） |
| 测试规模 | 未核实（有 tests/ 目录） | 1119 项，覆盖率门禁 90/81/95 |

**结论**：在「标准模型权威性」上 AquaPilot **落后**（BSM2 与能量侧完全缺失）；在「可操作性与决策支持」上 AquaPilot **领先**。两者定位不同：bsm2-python 是研究用库，AquaPilot 是运行原型。

---

### 2.2 QSD-Group/QSDsan

**核实事实**
- Python；许可证为 `NOASSERTION`（LICENSE.txt 含免责声明，具体条款未在 API 中识别）；52 stars / 32 forks；最近推送 2026-10-27
- 定位：卫生与资源回收系统的定量可持续设计（QSD）
- 基于 BioSTEAM，集成工艺建模 + 系统仿真 + 技术经济分析（TEA）+ 生命周期评价（LCA）
- 内置「常用处理工艺与生物动力学模型」，工艺图用 Graphviz 生成
- 依赖 Python 3.12+；`pip install qsdsan`
- CI 含 build-coverage 工作流；README 未给测试数量
- **README 未提及**灵敏度、不确定性、优化、质量平衡模块
- 论文：*Environmental Science: Water Research & Technology* (2022)

**与 AquaPilot 对照**

| 维度 | QSDsan | AquaPilot |
|---|---|---|
| TEA + LCA | **强**：完整的可持续性评估链 | 弱：只有运行成本（电/药/泥），无 LCA |
| 工艺广度 | **强**：卫生系统全链条（含资源回收） | 窄：只做活性污泥水线 |
| 权威模型 | 强（BioSTEAM 生态） | 中（ASM1 + Takács） |
| 流程图 | Graphviz 静态生成 | **可交互编辑** + 版本回滚 |
| 实时运行 / Web | 无（Jupyter + Binder） | **有** |
| AI 值守决策 | 无 | **有** |
| 不确定性/灵敏度/Pareto | README 未提及 | **有** |
| 质量平衡审计 | README 未提及（作为仿真内核应隐含） | **有**：显式可见 |

**结论**：QSDsan 的**系统边界更宽**（从污水处理扩到资源回收 + LCA），这是 AquaPilot 的结构性劣势，不可能靠加模块追平——那需要重做整个物料/能量建模层。AquaPilot 的优势在**运行时的实时性与可操作性**。

---

### 2.3 toogad/PooPyLab_Project

**核实事实**
- Python；GPL-3.0；79 stars；最近推送 2025-09-07
- 主题标签含 `process-flow-diagram`——与本项目拓扑编辑直接可比
- README：「用户可以自建处理厂流程图并得到稳态结果」，示例在 `examples/`
- `pip3 install poobylab`
- 文档在 toogad.github.io/brownbook，README 自承 wiki「没有很多细节」
- README **未提及**：具体支持模型、单元工艺数量、灵敏度、不确定性、优化、质量平衡、测试套件
- 许可证在 README 中未声明（API 显示 GPL-3.0）

**与 AquaPilot 对照**

| 维度 | PooPyLab | AquaPilot |
|---|---|---|
| 流程图自建 | **有**（稳态求解） | **有**（动态求解 + 版本历史） |
| 动态仿真 | 未核实 | **有**：1 分钟步长 + 场景注入 |
| Web 界面 | 无 | **有** |
| AI 决策 | 无 | **有** |
| 不确定性/灵敏度/Pareto | 未提及 | **有** |
| 测试与 CI | 未提及 | **有**：1119 项 + 覆盖率门禁 |
| 文档完整度 | 自承不足 | 完整（API/部署/SLO/对标） |

**结论**：PooPyLab 与 AquaPilot 在「可自建流程图」上定位最接近，但它是**离线稳态**工具，AquaPilot 是**在线动态 + 决策**系统。AquaPilot 在工程化（测试/CI/文档）上明显更强；PooPyLab 的 GPL-3.0 也限制了商业嵌入。

---

### 2.4 dgaida/PyADM1ODE

**核实事实**
- Python；MIT；4 stars；最近推送 2026-10-27（非常活跃）
- 实现 ADM1 厌氧消化模型，规划 ADM1da 变体
- 模块化组件：发酵罐、BHKW/CHP、泵、搅拌器；含浆料与缓冲储存的「干式通道仿真」
- 扩展：`calibrate`（灵敏度与可辨识性分析）、`estimate`（UKF / 深度学习集合状态估计）
- 配置用 Python 或 JSON
- 有单元/集成测试、lint、tests、CodeQL CI
- topics 含 `mcp-server`

**与 AquaPilot 对照**

| 维度 | PyADM1ODE | AquaPilot |
|---|---|---|
| 厌氧模型 | **强**：ADM1 完整实现 | 有：ADM1 standalone，未接 BSM2 水线 |
| 参数校准/可辨识性 | **强**：专门的 calibrate 扩展 | 实验性：合成 BSM1 目标，不是现场拟合 |
| 状态估计 | **强**：UKF + 深度学习集合 | 实验性：默认关闭，仿真状态 + 确定性噪声 |
| 水线模型 | 无 | **强**：ASM1 + Takács + 拓扑求解 |
| 实时界面 / AI 决策 | 无 | **有** |
| 灵敏度分析 | 有（校准场景） | 有（运行场景，本次新增） |

**结论**：PyADM1ODE 仍在完整 ADM1、现场级校准与状态估计方面更成熟。AquaPilot 已提供实验性仿真校准/EKF 链路，但默认使用合成或仿真观测，不能替代真实水厂数据验证。

---

### 2.5 alexha11/Junction-2025

**核实事实**
- Python（后端）+ TypeScript（前端）；许可证未声明；5 stars；最近推送 2026-03-03
- FastAPI + Pydantic + SQLAlchemy + APScheduler + Redis/Postgres
- React 18 + Vite + React Query + Zustand + Tailwind + Recharts + NGINX
- 五个 MCP/HTTP agent（天气、电价、进水、状态、优化器），各自独立端口
- `AgentsCoordinator` + 调度器每 15 分钟刷新建议
- 数字孪生：OPC UA server + MCP bridge，可安全读写实验
- **不做生物过程建模**：`simulation/` 只有泵/隧道水力动力学，孪生回放历史遥测
- Junction 2025 黑客松第二名

**与 AquaPilot 对照**

| 维度 | Junction-2025 | AquaPilot |
|---|---|---|
| 生物过程模型 | **无**（只做水力） | **强**：ASM1 + Takács |
| 多 agent 架构 | **强**：5 个独立 agent + 协调器 | 中：单 AI 决策循环 + 钩子 |
| 工业协议 | **强**：OPC UA + MCP bridge | 无（纯 WebSocket） |
| 真实遥测接入 | **强**：回放历史数据 | 无（纯仿真） |
| 优化求解器 | 有（OR-Tools/Pyomo 在 roadmap） | 无（枚举候选 + 加权评分） |
| 实时 Web 界面 | **有** | **有** |
| 决策可解释性 | 未提及 | **强**：候选排名 + 逐项理由 + 分离度 |
| 护栏/约束工程 | 未提及 | **强**：4 道护栏 + 权限档位 |

**结论**：Junction-2025 暴露了两个 AquaPilot 的真实劣势：**① 无工业协议接入（OPC UA/Modbus）**；**② 优化用枚举而非求解器**。前者是「接真实水厂」的硬门槛，后者影响候选空间的上限。二者都在下节列出。

---

### 2.6 Gift404/wwtw-digital-twin

**核实事实**
- TypeScript；许可证未声明；0 stars；最近推送 2026-10-12
- 网关 + WebSocket（`VITE_DATA_MODE=api`），可选纯浏览器仿真模式
- 前端 5173 / API 3001，Vite 代理
- **明确声明「对厂控只读」**
- 安全：CSP、CORS 白名单、登录/API 限流、输入 schema
- 测试：22 个 web 测试 + 26 个 API 测试；Playwright 端到端冒烟
- 性能：2k+ tag 摄取压测、UI 节流、instanced pipes
- 运维材料：runbook、plant onboarding plan、OpenAPI 文档
- 可选 SSO，角色 viewer/operator/engineer/admin

**与 AquaPilot 对照**

| 维度 | wwtw-digital-twin | AquaPilot |
|---|---|---|
| 角色权限（RBAC） | **强**：四角色 SSO | 弱：单令牌 + Agent 权限档位 |
| 输入 schema 校验 | 有 | **有**：valibot 逐分支（本次强化） |
| 安全头 / 限流 | **有** | **有** |
| 运行手册 / onboarding | **强** | 弱：有部署文档，无 onboarding 清单 |
| 性能压测 | **强**：2k+ tag 摄取 | 中：有 bench 脚本，无摄取压测（无外部数据源） |
| 生物过程模型 | 未在 README 说明 | **强** |
| AI 决策 / 分析 | 无 | **强** |
| 对厂控写入 | **只读**（更保守） | 可写，但有护栏与人工优先期 |

**结论**：这是**工程化程度最高的参照**。AquaPilot 在「角色权限」「运维 runbook」「大规模标签摄取」三处落后。其中 RBAC 是真实缺口（当前单令牌，无法区分观察者与操作者）。

---

### 2.7 wwtmodels/Activated-Sludge-Models

**核实事实**
- 59 stars；最近推送 2025-03-12；语言字段为空（文档型仓库）
- 无描述、无许可证字段、无 topics

**结论**：作为模型权威性参照（ASM 系列公式与参数的整理），不是可运行软件。AquaPilot 的 ASM1 参数应以此为交叉核对来源，但不构成能力对标。

---

## 三、总表

| 能力 | AquaPilot | bsm2-python | QSDsan | PooPyLab | PyADM1ODE | Junction-2025 | wwtw-twin |
|---|---|---|---|---|---|---|---|
| ASM1 水线 | ✅ | ✅ | ✅ | 未核实 | ❌ | ❌ | 未说明 |
| BSM1/BSM2 标准布局 | 部分（BSM1 对照） | ✅✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| ADM1 厌氧 | ✅（standalone，未接 BSM2 水线） | ✅ | 部分 | ❌ | ✅✅ | ❌ | ❌ |
| Takács 二沉池 | ✅ | ✅ | ✅ | 未核实 | ❌ | ❌ | ❌ |
| 拓扑编译求解 | ✅ | ❌ | ❌ | ✅（稳态） | ❌ | ❌ | ❌ |
| 可视化流程图编辑 | ✅ | ❌ | ❌（Graphviz 静态） | ❌ | ❌ | ❌ | ❌ |
| 实时 Web 界面 | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| AI 值守决策 | ✅ | ❌ | ❌ | ❌ | ❌ | 部分（调度优化） | ❌ |
| 决策护栏/可解释 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 不确定性（集合预测） | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 参数灵敏度 | ✅（新增） | ❌ | ❌ | ❌ | ✅（校准场景） | ❌ | ❌ |
| Pareto 前沿 | ✅（新增） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 质量平衡审计 | ✅（新增） | 测试内断言 | 未提及 | 未提及 | ❌ | ❌ | ❌ |
| 影子双跑对照 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 场景注入 + 回放 | ✅ | 部分（预置场景） | ❌ | ❌ | ❌ | ❌ | ❌ |
| 参数校准 / 状态估计 | 实验性（合成/仿真观测） | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| OPC UA / 工业协议 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | 部分 |
| RBAC 多角色 | ❌ | ❌ | ❌ | ❌ | ❌ | 部分 | ✅ |
| TEA + LCA | ❌（仅运行成本） | 部分（TEA） | ✅✅ | ❌ | ❌ | ❌ | ❌ |
| 测试规模 | 1094 | 未核实 | 未核实 | 未提及 | 有 | 未核实 | 48 |
| 许可证 | MIT | BSD-3 | NOASSERTION | GPL-3.0 | MIT | 未声明 | 未声明 |

图例：✅✅ 完整实现 / ✅ 有 / 部分 有限或间接 / ❌ 无 / 未核实 无法从公开信息确认

---

## 四、AquaPilot 的真实优势（已验证落地）

这四项在 7 个参照项目中**没有任何一个同时具备**：

1. **拓扑即模型**：流程图不是绘图，而是编译成反应器并拓扑求解。
   证据：`src/sim/network.ts` 的 `compileNetwork` + 拓扑排序；增删池子会真实改变池容与出水（`tests/topology.test.ts` 的几何回归）。
2. **AI 决策的四道护栏**：allowedControls 白名单、单步幅度限幅、人工优先期、critical 优先于死区。
   证据：`tests/agent-production.test.ts`、`tests/auditPolish.test.ts`。
3. **决策可解释性**：候选排名、逐项理由、分离度（明确不是概率）、P10–P90 集合带。
   证据：`Recommendation` 类型与 `DecisionPanel`。
4. **影子双跑**：同 seed 同进水，AI vs 固定策略，把「策略差异」与「初始条件差异」分开。
   证据：`src/server/benchmark.ts` 的 `stepShadow` 同步 rngCount。

新增的三项分析能力（灵敏度/Pareto/质量平衡）进一步拉开差距——它们在其他项目中要么没有，要么只在校准场景里间接存在。

---

## 五、AquaPilot 的真实劣势与补全计划

| 劣势 | 影响 | 补全方案 | 状态 |
|---|---|---|---|
| 实验性校准 / 状态估计边界 | 不能用合成/仿真观测证明现场参数或软测量 | 接入真实观测、固定数据协议和现场验证 | 已实现仿真链路；现场验证未做 |
| 无 OPC UA / Modbus | 无法接现场 PLC | 需要工业协议栈与安全评估，属独立项目 | 已记录，未实施 |
| 共享令牌而非完整 RBAC | 不能按命名用户审计或细分账户生命周期 | 引入用户身份、会话与审计模型 | 三档共享令牌已实现；完整 RBAC 未做 |
| 优化用枚举而非求解器 | 候选空间受限于手工构造的组合 | 候选维度低（≤9 个连续量），枚举 + 局部搜索已够；引入 NLP 求解器收益不抵复杂度 | 评估后不实施，理由记录 |
| 无 TEA + LCA | 无法做可持续性评估 | 与 AquaPilot 定位（运行值守）不符，属不同产品 | 不在范围内 |
| ADM1 未接主水线 | 无法覆盖 BSM2 全流程消化池 | 接入完整 BSM2 流程并做端到端验证 | ADM1 standalone 已实现；主线接入不在当前范围 |

---

## 六、商业参照（仅功能清单，无法比对实现）

| 产品 | 定位 | AquaPilot 的差异 |
|---|---|---|
| GPS-X | 商业稳态/动态工艺设计 | AquaPilot 不做设计校核，做运行值守 |
| BioWin | 商业工艺模拟 + 能耗 | 同上；AquaPilot 有 AI 决策与 Web 实时 |
| SIMBA# | 商业仿真 + 控制 | 同上；AquaPilot 开源且可改拓扑 |

这三者的共同点是「假设操作者是工艺工程师」。AquaPilot 的定位反转了这一点：**AI 是操作者，人是监督者**。这是产品定位差异，不是能力高低。

---

## 七、下一步（按性价比排序）

1. **真实观测校准与状态估计验证**——需要现场数据和测量协议，成本高
2. **OPC UA / Modbus 接入**——独立项目，需要工业安全评估
3. **完整 RBAC 与用户审计**——当前三档共享令牌不提供命名用户生命周期
4. **BSM2 全流程集成**——ASM2d/ADM1 standalone 之外的端到端验证
5. **TEA + LCA**——与运行值守原型不同的产品边界

---

## 附：核实来源

- https://api.github.com/repos/fau-evt/bsm2-python
- https://api.github.com/repos/fau-evt/bsm2-python/readme
- https://api.github.com/repos/QSD-Group/QSDsan
- https://api.github.com/repos/QSD-Group/QSDsan/readme
- https://api.github.com/repos/toogad/PooPyLab_Project
- https://api.github.com/repos/toogad/PooPyLab_Project/readme
- https://api.github.com/repos/dgaida/PyADM1ODE
- https://api.github.com/repos/dgaida/PyADM1ODE/readme
- https://api.github.com/repos/alexha11/Junction-2025/readme
- https://api.github.com/repos/Gift404/wwtw-digital-twin/readme
- https://api.github.com/repos/wwtmodels/Activated-Sludge-Models
- https://api.github.com/search/repositories?q=digital+twin+wastewater
- https://api.github.com/search/repositories?q=BSM1+benchmark+simulation

核实时间：2026-10-29。star 数与推送时间会随时间变化，引用时请注明快照日期。

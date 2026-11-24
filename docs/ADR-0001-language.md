# ADR-0001：仿真平台语言选型与迁移边界

- 状态：**Accepted（架构负责人决策）**
- 日期：2026-11-24
- 决策范围：AquaPilot 全项目技术栈
- 关联：`docs/PROJECT-BASELINE.md`、`docs/INDUSTRIAL-READINESS-PLAN.md`
- 取代：无

## 1. 结论

**生产级仿真内核、服务端、AI 编排与 CLI 全部迁移到 Rust（2024 edition）。**

- Rust 承担：ASM1/ASM2d/ADM1、Takács、水力学、质量平衡、积分器、参数标定、调度、协议、持久化、AI Provider 编排、CLI。
- TypeScript/React 暂时保留为 **表现层**：工艺画布、图表、3D 视角、交互。它不承担数值计算，不拥有仿真状态，不成为第二套业务逻辑。
- 如果“单语言”是硬约束，前端在 M3 迁移到 **Leptos + wgpu**；但这不是首版发布门禁，也不建议与内核迁移同时做。

**一句话：换的是项目的大脑和骨架，不是把 10,132 行 React 一次性改成 Rust。**

## 2. 为什么必须换掉当前数值内核

当前 TypeScript 内核不是“不能算”，而是不适合作为 7×24 工业级重型仿真的长期底座：

1. **单线程事件循环**：`stepNetwork` 的 19 组分 × 多反应器 × 最多 120 子步是 CPU 密集循环；Node 主线程同时承担 HTTP/WS、AI、协议、序列化，长任务会阻塞控制回路。
2. **GC 不可预测**：工业控制最忌讳在关键步出现不可控停顿；当前对象/数组在每步大量分配，长稳后堆压力不可控。
3. **数值类型弱约束**：`number` 不区分 kg COD、gN/m³、m³/h；单位错配只能靠注释和测试发现，工业审计需要的量纲安全无法在编译期保证。
4. **状态不可序列化审计**：大量 `Map`/对象/闭包混在运行时；要做“输入—参数—状态—输出”四元组可追溯，需要一层层手工快照。
5. **部署链长**：Node + Vite + esbuild + SEA；Windows 单文件 84 MB，仍依赖 Node 运行时语义；Rust 静态链接后是单二进制，无运行时依赖。

这些问题是架构问题，不是加几个 `for` 循环或换一个图表库能解决的。

## 3. 候选语言评估

评分是工程判断（1–5），不是 benchmark 实测；权重按本项目的工业约束设定。

| 维度 | 权重 | Rust | C++ | Python | Julia | Go | TypeScript |
|---|---:|---:|---:|---:|---:|---:|---:|
| 数值确定性/无 GC 停顿 | 15% | 5 | 5 | 3 | 4 | 3 | 2 |
| 7×24 长稳与并发 | 15% | 5 | 4 | 3 | 3 | 5 | 3 |
| 计算性能/内存控制 | 20% | 5 | 5 | 2 | 5 | 2 | 2 |
| 内存/线程安全 | 15% | 5 | 2 | 5 | 4 | 5 | 4 |
| 领域/数值生态 | 10% | 3 | 5 | 5 | 3 | 2 | 4 |
| 部署/单文件/跨平台 | 15% | 5 | 4 | 2 | 3 | 5 | 3 |
| UI/3D 生态 | 10% | 3 | 5 | 4 | 2 | 2 | 5 |
| **加权总分** | 100% | **4.60** | **4.25** | **3.25** | **3.60** | **3.50** | **3.10** |

### 3.1 Rust — 选定

优势：

- 无 GC、无运行时、单静态二进制；7×24 长稳和确定性最好。
- 所有权/借用 + `Send/Sync` 把并发数据竞争变成编译错误；可 `#![deny(unsafe_code)]`。
- `serde` 做状态/协议契约；`nalgebra`/`faer`/`ndarray` 做线性代数；`tokio`/`axum` 做服务；`napi-rs`/WASM 做桥接。
- 类型系统能承载“组分 newtype + 单位 newtype”，把 kg COD / gN/m³ 的量纲错误挡在编译期。
- 可直接编 Windows/Linux 单文件，适配现有 EXE + 服务器交付。

劣势与对策：

- 领域库不如 Python/C++丰富 → 模型本来就是自研，不依赖污水领域库；只用通用数值库。
- 开发速度慢于 TS/Python → 用 strangler 分阶段迁移，不搞大爆炸；先冻结黄金向量，再逐模块 parity。
- 团队 Rust 经验 → 先做 2 个垂直切片（单位/组分 + ASM2d 单池），用编译器和测试兜底；不先碰 3D。

### 3.2 Python — 不选为生产内核

优势是迁移最快、NumPy/SciPy/JAX 生态最强、AI 工具链最熟；适合标定脚本、离线分析、研究型探索。  
不选原因：

- GIL + 解释器让“多反应器 + 多子步 + 多并发任务”必须靠多进程，状态同步和内存放大严重。
- PyInstaller 产物大、启动慢、动态链接/字节码审计复杂；7×24 现场部署不如静态二进制。
- 运行时类型与单位错误要到测试/运行期才暴露，不满足工业审计的编译期约束。

### 3.3 C++ — 不选

性能、OpenFOAM/SUNDIALS/IPOPT 生态、Qt/OpenGL 3D 都是优势；但内存安全、构建链、依赖管理、跨平台交付对单人全栈项目风险过高。Rust 在同等性能量级下提供更好的安全边界。

### 3.4 Julia — 不选

DifferentialEquations.jl / ModelingToolkit.jl 是方程建模的强项；但部署、Windows 单文件、Web/3D、团队可维护性弱，不适合作为产品底座。可作为离线参数辨识的辅助工具。

### 3.5 Go — 不选

并发和单二进制很好，但没有运算符重载、泛型数值表达弱、科学计算生态薄；写 ASM 矩阵会变成大量手写索引，维护性差。

### 3.6 TypeScript — 保留为 UI，不保留为内核

React/ECharts/XYFlow 的交互生态仍是当前最优；UI 不承担数值。内核迁走后，Node 只做静态文件/WS 网关或直接由 Rust 服务替代。

## 4. 迁移边界

| 当前模块 | 行数 | 目标 | 处理方式 |
|---|---:|---|---|
| `src/sim` | 14,534 | `crates/aquapilot-sim` | 全量 Rust；ASM/水力学/积分器/平衡 |
| `src/model` | 2,404 | `crates/aquapilot-domain` | 拓扑、校验、预设、交换 |
| `src/server` | 12,058 | `crates/aquapilot-server` | Axum + tokio；HTTP/WS/协议/持久化 |
| `src/ai` | 2,130 | `crates/aquapilot-ai` | Provider、提示词、审计、限流 |
| `src/cli.ts` | — | `crates/aquapilot-cli` | clap；simulate/bench/report/serve |
| `src/shared` | 1,502 | `crates/aquapilot-contract` | serde 契约；JSON Schema 导出 |
| `src/client` | 10,132 | 保留 React | 只做表现层；可选 M3 迁 Leptos |
| `tests` | 22,574 | 黄金语料 + Rust 测试 | 先冻结 TS 输出，再做 parity |

### 4.1 “完全换语言”的准确含义

- **计算、状态、调度、协议、AI 编排、CLI：100% Rust。**
- **浏览器呈现：React/TypeScript 是客户端，不是第二套仿真。**
- 这是工业软件的常规分层（内核 native，HMI web），不是“半成品”。
- 若验收方要求“仓库里没有 TypeScript”，则追加 M3：Leptos + wgpu + 自绘图表；工期和风险显著上升，不建议作为首版门禁。

## 5. 迁移策略：Strangler，不是 Big Bang

### 5.1 为什么拒绝一次性全量重写

- 当前 48,331 行、132 个测试文件、1,617 个用例；WP2 还有 3 条真实红灯。
- 没有冻结的黄金输出，重写后无法判断“算对了”还是“算错了”。
- 一次性重写会把“模型不闭合”和“移植引入的偏差”混在一起，无法定位。
- 用户要求 7×24、可溯源；大爆炸重写本身不可审计。

### 5.2 分阶段

**M0 冻结基线**

1. 从当前 TS 引擎导出黄金语料：正常/暴雨/冬季/故障/高氨氮/低负荷，至少 6 类场景。
2. 每类记录：输入拓扑、参数、初始状态、逐步状态、出水、库存、三本账。
3. 约定容差：溶解态/颗粒态相对误差 ≤1e-8，质量平衡残差 ≤1e-6（迁移 parity 用，不放宽产品 5% 门禁）。
4. 黄金语料只读，迁移期间不得改。

**M1 Rust 内核垂直切片**

1. `aquapilot-contract`：组分/单位 newtype、状态、输入输出。
2. `aquapilot-sim`：单位、RNG、ASM2d 单池 CSTR → ASM2d 网络 → ASM1 → ADM1 → Takács → 水力学。
3. 每个模块先过 Rust 单元测试，再过 TS 黄金 parity。
4. 不引入 `unsafe`；`#![deny(unsafe_code)]`；`cargo clippy -D warnings`；`cargo deny`。

**M2 桥接与双跑**

- `napi-rs` 或 C ABI 把 Rust 内核暴露给现有 Node；TS 服务继续跑，但 `stepNetwork` 切到 Rust。
- 同一进程双跑：TS 内核与 Rust 内核同步计算，比较每一步；差异超容差即失败。
- 双跑通过后，TS 内核降级为测试 oracle，不再进生产路径。

**M3 服务端与 AI 迁移**

- Axum + tokio 替 Node HTTP/WS；协议、持久化、审计、限流、看门狗逐项 parity。
- AI Provider 用 `reqwest` + `rustls`；保留现有配置/审计语义。
- 7×24 soak：72 h，内存/句柄/FD 无增长；断线重连、任务取消、背压通过。

**M4 可选 UI 单语言化**

- Leptos + wgpu 替换 React/ECharts；3D 厂区用 wgpu 或 Bevy。
- 只在“仓库零 TypeScript”是硬性验收时启动；否则保持 React 表现层。

## 6. 验收门（迁移专用）

| 门 | 条件 |
|---|---|
| G0 黄金语料 | 6 类场景冻结，哈希入库，不可变 |
| G1 内核 parity | 所有状态/出水/库存/三本账在容差内；0 例外 |
| G2 双跑 | 连续 30 d 模拟无差异超限；无 panic；无 NaN/Inf |
| G3 性能 | 同输入下 P95 步耗时 ≤ 当前 TS 的 0.5×；内存 ≤ 当前 0.7×（以实测报告为准） |
| G4 长稳 | 72 h soak，RSS/FD 无增长；任务取消/重启可恢复 |
| G5 安全 | `deny(unsafe_code)`、`cargo audit`、`cargo deny`、依赖许可证清单 |
| G6 接口 | HTTP/WS/Modbus/CSV 契约不变；旧客户端可连 |
| G7 交付 | Linux 单二进制 + Windows EXE；无 Node 运行时依赖 |

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Rust 学习曲线 | 迁移慢 | 先做 2 个垂直切片；不并行改 UI；用编译器驱动 |
| 数值差异 | 出水/账本漂移 | 黄金语料 + 双跑 + 容差门禁；不接受“看起来差不多” |
| FFI 复杂度 | Node 桥接崩溃/泄漏 | 优先 C ABI + `catch_unwind`；进程隔离兜底 |
| WP2 未闭合 | 迁移把错误固化 | **先闭合或至少冻结已知差异**，迁移只保证 parity，不负责修模型 |
| 3D 生态 | UI 单语言化风险 | 首版保留 React；M4 可选 |
| 工期 | 5–7 个月单人 | 分 M1–M3 交付，不承诺一次性完成 |

## 8. 立即执行顺序

1. 本 ADR 与 `docs/PROJECT-BASELINE.md` 入库（不 push）。
2. 建立 `golden/` 语料导出脚本；先覆盖 ASM2d 单池 + 网络 30 d。
3. 建 Rust workspace：`aquapilot-contract`、`aquapilot-sim`、`aquapilot-server`、`aquapilot-cli`。
4. M1 第一个切片：ASM2d 单池 CSTR + 单位/组分 newtype；与 TS 单池测试对齐。
5. 语言迁移期间 **不删除 TS 内核**，直到 G1/G2 通过。

## 9. 不做什么

- 不把“换语言”当成 WP2 红灯的解药；模型不闭合，换任何语言都不闭合。
- 不做只有 CLI/演示页的“概念迁移”。
- 不在没有黄金语料的情况下重写数值核心。
- 不为了“单语言”把 3D/图表生态强行塞进 Rust，牺牲交付质量。
- 不在迁移期间放宽现有测试阈值或删除断言。

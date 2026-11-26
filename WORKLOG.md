# AquaPilot Work Log

## 2026-11-27 — V2-1 首版：整厂 ASM1、二沉池、RAS/内回流、DO 控制

- `aquapilot-domain` 新增 `Waste` 沉泥汇、10 层二沉池几何与 `SettlerParams`。
- `aquapilot-model` 新增 Takács 风格 10 层有限体积二沉池：feed layer、上/下流、hindered settling、逐层质量积分与流量校核。
- `aquapilot-engine` 编译支持多反应器、RAS、内回流、WAS、二沉池；反应器入流可来自进水、上游池或二沉池底流。
- 新增 DO 控制器：按设定值调节 KLa，输出实际 KLa；RAS 底流按缺氧处理（DO 置 0）。
- 新增 `fixtures/bsm1-like.json`：2 缺氧 + 3 好氧 + 二沉池，Q=1000 m3/h，RAS 1000，内回流 1500，WAS 30。
- 30 天 / 43,200 步：出水 COD 59.14、SS 12.22、NH4-N 0.239 mg/L；MLSS 2741–2790；二沉池 feed/underflow/overflow TSS 2789.8/5407.8/12.2。
- 质量门：18 项测试全过（model 11 + engine 7），fmt/clippy 干净；30 天测试 debug 约 0.3 s。
- 删除旧 `rust/` parity 工程、旧 golden 生成脚本、旧 CI/release 的 Rust parity 门禁；TypeScript 产品保留为 cutover 过渡运行时，历史只在 v0.11.23 tag。
- 新增官方 BSM1 几何 fixture：1000/1000/1333/1333/1333 m3、1500 m2 二沉池、Q0 18446 m3/d、RAS 18446、内回流 55338、WAS 385、15 ℃。
- 官方 BSM1 30 天首跑：SS 12.96、NH4-N 0.222、NO3-N 0、DO 6.900、MLSS 5213–5219；与 Table 6 的 DO/NO3/MLSS 偏差明显，未通过，需先做参数集与 KLa 标定。
- 明确未做：官方 BSM1 Table 6 标定、pH/碱度限制、ASM2d/ADM1、氧化项入账、HTTP/WS、界面、24 h soak。


## 2026-11-26 — v2 路线切换：放弃逐模块 parity，启动 clean-room Rust

- 新增 `docs/ROADMAP-V2.md`：v2 的架构、纵向切片、时间盒、停止线、cutover gate 与状态表。
- 新增 `docs/CLEAN-ROOM.md`：禁止读取/复制旧 `src/sim`、`src/server`、`src/client` 与 `rust/` 源码；只允许产品规格、公开文献和黑盒行为。
- 旧 `rust/` parity 线冻结在 v0.11.23；不再新增切片，不再为它发版本。
- 新建 `rust-v2/`：domain / model / engine / cli 四个 crate，ASM1 13 组分、单池与三段串联 CSTR、固定 KLa、CLI、两套 clean-room fixture。
- V2-0 验证：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿；单池 24 h 与三段串联 24 h 均输出有限值，NH 下降。
- V2-0 明确未做：二沉池、RAS/内回流、DO 控制器、ASM2d/ADM1、三本账闭合、HTTP/WS、实验队列、界面、24 h soak。


## 2026-11-26 — v0.11.23 M1b ASM1 reactor reaction integration

- 新增 `asm1reactors.rs`：13 组分 CSTR、初始化、碳源、TP 示踪、`fromAsm1`、三层抑制、KLa 曝气闭环。
- 复用 `aquapilot-core` 的 ASM1 速率与曝气模型；温度按 0.1 ℃ 分档，抑制用原始温度。
- `scripts/gen-sim-react-asm1.ts` 生成 16 组 oracle；`tests/react_asm1_parity.rs` 3 项测试，13 组分 + 11 聚合字段 + 9 flux 全部 `1e-12` 内一致。
- Rust 119 项（60 单元 + 59 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 只完成 `solveReactors` 的 `asm1` 分支；ASM2d 逐池积分、`solveClarifier`、`stepNetwork` 仍未完成。

## 2026-11-26 — v0.11.22 M1b simple reactor integration

- 新增 `kinetics.rs` / `reactors.rs`：简单模型 17 个常数、三类池型积分、DO 曝气闭环、缺氧区碳源、非好氧衰减与 6 项 flux 累加。
- `scripts/gen-sim-react-simple.ts` 生成 13 组 oracle；`tests/react_simple_parity.rs` 3 项测试，逐池 10 字段 + 6 flux 全部 `1e-12` 内一致，3 个源哈希实际校验。
- Rust 113 项（57 单元 + 56 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 只完成 `solveReactors` 的 `simple` 分支；ASM1/ASM2d 反应积分、`solveClarifier`、`stepNetwork`、`createNetworkState`、`PlantSnapshot` 仍未完成。

## 2026-11-26 — v0.11.21 M1b ASM1 inflow mixing

- 新增 `asm1mix.rs`：`toAsm1` / `influentToAsm1` / `aggregateAsm1Inflow`，13 组分按 `ASM1_COMPONENTS` 顺序混合，RAS 颗粒态按浓缩倍数放大。
- `scripts/gen-sim-asm1-inflow.ts` 生成 8 组映射、2 组进水映射、12 组混合用例；`tests/asm1_inflow_parity.rs` 5 项测试。
- Rust 108 项（55 单元 + 53 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 仍未完成：`solveReactors` 反应/曝气积分、`solveClarifier`、`stepNetwork`、`createNetworkState`、`PlantSnapshot`。

## 2026-11-26 — v0.11.20 M1b aggregateInflow

- 新增 `inflow.rs`：`aggregateInflow` 的厂外来水/上游池/RAS/内回流、末端取水、未知源回退、零/负流量跳过与顺序语义全部移植。
- `scripts/gen-sim-inflow.ts` 生成 12 组 oracle；`tests/inflow_parity.rs` 3 项测试，源哈希实际计算 SHA-256。
- Rust 101 项（53 单元 + 48 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 仍未完成：`aggregateAsm1Inflow`、`solveReactors`、`solveClarifier`、`stepNetwork`、`createNetworkState`、`PlantSnapshot`。

## 2026-11-26 — v0.11.19 M1b phase 1 + alarm history

- 新增 `hydraulics.rs`：`resolveHydraulics` 的暴雨调蓄、16,000 m³ 上限、雨后 320 m³/h 缓释、200 m³/h 最低进厂流量全部移植。
- 新增 `alarm_ledger.rs`：45 分钟同码去重、`A0001` 序号、80 条上限；`raise_limit_alarms` 串联 `evaluate_alarms`。
- `scripts/gen-sim-step.ts` 生成 10 组调蓄、7 组告警历史 oracle；`tests/step_parity.rs` 4 项测试，源哈希实际计算 SHA-256。
- Rust 95 项（50 单元 + 45 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 仍未完成：`aggregateInflow`、`solveReactors`、`solveClarifier`、`stepNetwork` 编排、`createNetworkState`、`PlantSnapshot`。

## 2026-11-26 — v0.11.18 M1b output phases

- 新增 `output.rs`、`metrics.rs`、`alarms.rs`、`phases.rs`：`solveBiomass`（simple/ASM1/ASM2d）、`solveEffluent`（含 PAC 化学药剂短缺截断）、`solveEnergyAndCost`（日清零/累计三本账）、`qualityScore`/margin、9 条告警规则。
- `scripts/gen-sim-phases.ts` 生成 `rust/golden/sim-phases.json`：metrics 12、alarms 12、effluent 48、biomass 36、energy 24；5 个源文件 SHA-256 锁定。
- `tests/phases_parity.rs` 6 项测试逐字段一致；`serde_json` 开启 `float_roundtrip` 解决 1 ULP 假失败。
- Rust 85 项（44 单元 + 41 集成/parity）全过，fmt/clippy 干净；TS 1739/1739 不变。
- 仍未完成：`createNetworkState`、`resolveHydraulics`/`solveReactors`/`solveClarifier`、`stepNetwork` 编排与 `PlantSnapshot`。M1b 任务仍 in_progress，M2-1 继续 blocked。

## Current milestone

- [x] M0 Rust workspace, ASM2d CSTR + 5-pool network parity
- [x] M1 ASM1 reaction surface (13 components, 8 processes, 20/15 C parity)
- [x] M1 ASM1 CSTR / network integration (5-tank slice, TS↔Rust 1e-12)
- [x] M1 Takács settler parity (10-layer BSM1 slice, 64 f64 ulp)
- [x] M1 ADM1 standalone CSTR parity (48 h, 27 components)
- [x] M1 ADM1 sludge-line integration (process chain + filtrate recycle, 48 h golden)
- [x] M1 hydraulics / transport parity (resistance split, pump/valve/weir, segmented CSTR, tracer RTD; 48-step TS golden)
- [x] M1 hydraulics randomized differential fuzz + property invariants (64 state / 191 edge / 64 split / 64 geometry cases)
- [x] M1 plant boundary COD/N/P mass books parity (96-step golden + residual/flag properties)
- [x] M1 production `stepNetwork` trace replay (96 steps × 15 min, ASM2d + Takács + ADM1 + 三本账 + 出水/库存/生物量)
- [x] WP2 30 d COD/N/P balance closure
- [x] M2-2 Rust AI provider / hash-chain audit / rate limit / watchdog (TS oracle parity)
- [ ] M1b Rust whole-plant `networkEngine` closed loop (forcing/influent parity done, `stepNetwork` not ported)
- [ ] M2-1 Rust HTTP/WS server migration（契约已冻结，服务端未实现，blocked by M1b）
- [ ] M2-3 7×24 wall-clock soak / RSS + FD acceptance
- [ ] M3 frontend / industrial acceptance
- [ ] M4 optional zero-TypeScript migration
- [x] B1 reproducible experiments / durable queue
- [x] B2 OpenAPI 3.1 + RFC 9457 + idempotency
- [x] B3 multi-dimensional validation + MCP experiment bus
- [x] B4 full regression, docs, five-platform delivery
- [x] B5 simulation studies / batch variants / Pareto / reproducible report

## Latest verifiable state

- `cargo test`: 34 unit + 40 integration/parity/fuzz = 74, all pass (core 41 + ops 17 + contract 6 + sim 10)
- `cargo clippy --all-targets -- -D warnings`: clean
- `npx vitest run --coverage`: 1739 passed / 1739 (144 files); WP2 30 d COD/N/P 三账闭合；覆盖率 94.11/82.15/95.23（阈值 90/81/95 未下调）
- `npm run typecheck && npm run lint && npm run format && npm run build`: pass
- `npm run e2e`: pass (17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors)
- M2-3 soak: v0.11.16 TS run 于 2026-11-26 01:58 CST 启动，02:16 最后样本（19 个、18 分钟），无 `summary.json`；进程已消失，宿主 boot id 已变化，不计入 24 h
- Latest release: `v0.11.23` (M1b ASM1 reactor reaction integration parity; `stepNetwork` not ported; M2 not closed); prior `v0.11.16` (M2-1 HTTP/WS contract freeze + soak boot guard), prior `v0.11.15` (Rust M2-2 ops crate), `v0.11.14` (production trace replay; M1 gates met), `v0.11.13`, `v0.11.12`, `v0.11.11`, `v0.11.10`, `v0.11.9`, `v0.11.8`, `v0.11.7`, `v0.11.6`, `v0.11.5`, `v0.11.4`, `v0.11.3`, `v0.11.2`, `v0.11.1`, `v0.11.0`
- GitHub CI: v0.11.7 全绿；v0.11.8 把 `cargo fmt/clippy/test` 纳入 CI 与 Release；v0.11.9 清掉 Node20 告警；v0.11.10 接入 ADM1 泥线；v0.11.11 接入水力/输运；v0.11.12 加随机差分并修掉分流截流后的丢流量；v0.11.13 补齐三本账 Rust parity；v0.11.14 整厂 96 步 production replay 通过；v0.11.15 M2-2 ops crate 58 项 Rust 全过；v0.11.16 冻结 HTTP/WS 契约 64 项 Rust 全过；v0.11.17 M1b forcing/influent parity 74 项 Rust 全过；v0.11.18 输出阶段 4–7 85 项 Rust 全过；v0.11.19 phase 1/告警历史 95 项 Rust 全过；v0.11.20 入流聚合 101 项 Rust 全过；v0.11.21 ASM1 入流 108 项 Rust 全过；v0.11.22 simple 反应器积分 113 项 Rust 全过；v0.11.23 ASM1 反应器积分 119 项 Rust 全过

## Rule

Every turn must land a code/test/golden commit or explicitly record a blocker;
do not repeat the same probe without a code change.

## 2026-11-26 M1b forcing/influent 纯层 parity（v0.11.17）

- 新增 `rust/crates/aquapilot-sim`：`forcing.ts` 的七类强迫函数、`deriveInfluent` 的合成与真实序列分支、`sampleAt` 的循环插值/夹紧、Mulberry32 与 JS `>>> 0` 语义移植到 Rust；全部 `#![forbid(unsafe_code)]`。
- 新增 `scripts/gen-sim-forcing.ts` 与 `rust/golden/sim-forcing.json`：112 组 forcing（8 场景 × 14 时间点）、96 组回流（4 控制 × 8 场景 × 3 时间）、1098 组进水（9 场景含 null × 3 seed × 4 rngCount × 5 时间 × 2 uncertainty + 18 组真实/单点/空序列）。
- `tests/forcing_parity.rs` 五项测试锁定条数、7 个源文件哈希、forcing/recycle/influent 全字段 1e-12 一致；`cargo test -p aquapilot-sim` 10 项全过。
- `npm run gen:sim-forcing -- --check` 接入 `npm run ci`；`src/sim/networkEngine.ts` 仅导出 `deriveInfluent` 供 oracle 调用，行为不变。
- **未完成**：`createNetworkState`、`NetworkSimState` 依赖、`stepNetwork` 七阶段、`PlantSnapshot` 仍未移植；Rust 不能独立跑整厂闭环，M1b 保持 in_progress，M2-1 继续 blocked。

## 2026-11-26 M2-1 契约冻结（v0.11.16）

- 新增 `scripts/gen-http-contract.ts`：扫描 `apiRoutes.ts`、`httpRoutes.ts`、`openapi.ts`、路由模块与 `protocol.ts`，冻结 32 条 legacy 路由、3 个别名前缀、9 条版本化路由、3 个公开端点、`/mcp`、`/ws`、19 类客户端消息、14 类服务端消息、512 KiB 帧上限与 8 个源文件 SHA-256。
- 新增 `rust/crates/aquapilot-contract`：读取 `rust/golden/http-contract.json`，6 项测试锁定条数、公开端点归属、路径前缀、版本化参数风格、WS 标签唯一性与源文件哈希。该 crate 不是服务端实现，只声明 M2-1 的迁移义务。
- `npm run gen:http-contract -- --check` 纳入 `npm run ci`；源文件改动而 golden 未更新会直接失败。
- `scripts/soak.ts` 增加防覆盖与 boot id 证据：已有 `samples.csv` 拒绝启动；`run.json` 记录启动时 boot id；结束时 boot id 变化则 `hostRebooted=true`、`passed=false`。`.gitignore` 增加 `/soak/`。1 分钟 smoke 采到 6 个样本、FD 25→25、`hostRebooted=false`，`passed=false` 仍按设计只作 harness 验证。
- v0.11.15 的 TS soak 在 2026-11-26 00:02 宿主重启时中断（约 24 分钟、25 个样本），未生成 `summary.json`，不计入 M2-3。M2-1 服务端、M2-3 24 h 均未完成，M2 不关闭。

## 2026-11-25 M2-2：Rust ops 能力（v0.11.15）

- 新增 `rust/crates/aquapilot-ops`：`provider`（OpenAI 兼容/Anthropic/Gemini 非流式 chat、URL 守卫、DNS 钉扎、禁重定向）、`audit`（SHA-256 JSONL 哈希链 + 启动复验 + 决策去重）、`rate_limit`（每连接固定窗口/提示冷却/LLM 在途上限）、`watchdog`（10 项确定性自检）。
- 新增 `scripts/gen-ops-cases.ts` 与 `rust/golden/ops-cases.json`：TS oracle 冻结 14 组 watchdog、5 组决策、2 组限流、9 组 URL；Rust `tests/ops_parity.rs` 逐项比对。
- 新增 `scripts/soak.ts`：真实墙钟采样 `/proc` RSS/线程/FD，周期探活 HTTP + 真实 WS；`SOAK_MINUTES` 默认 1440，1 分钟只验 harness。M2-3 未跑满，不能签。
- `cargo test`：58 项（34 单元 + 24 集成/parity），`fmt/clippy` 干净。
- M2-2 退出条件满足；M2-1（HTTP/WS 迁移）与 M2-3（24 h soak）仍未完成，M2 总里程碑不关闭。

## 2026-11-25 整厂 production 轨迹 replay（v0.11.14）

- 新增 `src/sim/networkTrace.ts`，给 `stepNetwork` 加可选 trace hook：在生产路径捕获 ASM2d 反应器 pre/post、边流量/回流、二沉池 Takács 剖面、ADM1 泥线 27 组分与气体、三本账真实 `BalanceInput`、出水/库存/生物量。未传 hook 不克隆。
- 新增 `scripts/gen-plant-replay.ts` 与 `rust/golden/plant-replay-96step.json`：seed 21、20 d spin-up、`carbonDose=8`、96 步 × 15 min。
- 新增 `rust/crates/aquapilot-core/src/plant_replay.rs` 与 `tests/plant_replay_parity.rs`：逐步复算 5 反应器 19 组分、flux、二沉池、泥线、三本账、出水/库存/生物量；实测最大绝对残差 1.73e-9，测试容差 1e-8（模块 golden 仍为 1e-12）。
- 修复 Rust 四个真实 parity 缺陷：ASM2d ammonification 化学计量缺失、`k_amm` 放大 10 倍、速率缓存未按 0.1 ℃ 取整、`o2_transferred_kg_h` 重复除 `dt_h`；另修复 CSTR `q_pp=1.5` 与缺失好氧磷 uptake。
- `asm2d-network-48h`、`asm2d-cstr-24h` 原为 stale golden 且 Rust 测试硬编码不读文件；已用当前 TS 重生成，测试改为直接读 golden，新增 `asm2d-cstr-aerobic-30h.json`。
- M1：六项模块切片 + 水力随机差分 + 三本账 + 整厂 production replay 全部通过；M1 三项退出条件满足。M2 未开始。

## 2026-11-25 全厂三本账 Rust parity (v0.11.13)

- 新增 `rust/crates/aquapilot-core/src/plant_boundary.rs`，按 `src/sim/plantBoundary.ts` 移植 COD/N/P 三本账：进水/出水/排泥/沼气 COD/氧化/反硝化/库存变化/滤液回流/钳制损失，支持组分口径与标量口径两种负荷路径。
- 新增 `rust/golden/plant-boundary-96step.json`：96 个 0.5 h 步，交替使用组分负荷与标量负荷，含动态泥线进料、库存变化与显式钳制损失。
- `tests/plant_boundary_parity.rs`：96 步每行每字段、库存、诊断逐项 1e-12 比对；另有 500 步残差/闭合标志属性测试、关闭泥线零回流与 reset 测试。
- M1：六项模块切片 + 水力随机差分 + 三本账 parity 完成；整厂 production `stepNetwork` 轨迹逐态 replay 仍未做，M1 总里程碑不关闭。M2 未开始。
- `cargo test` 41 项全过；`cargo fmt/clippy` 通过；TS 1739/1739 不变。

## 2026-11-25 水力随机差分、分流修复 (v0.11.12)

- 新增 `rust/golden/hydraulics-fuzz.json`：固定种子生成 64 个状态场景（191 条边）、64 个分流场景、64 个几何推导场景，全部以 TS `src/sim/hydraulics.ts` 为 oracle。
- 随机差分发现真实缺陷：支路达到能力上限后，旧两遍分流会覆盖未封顶支路的首轮份额并丢掉余量。三支路样例总流量 478.96 m³/h，旧实现只分 445.48 m³/h。
- 同步修复 TS 与 Rust：按 1/√R 逐轮分配余量，封顶支路移出集合、余量在剩余支路重分；全部支路能力不足时返回 `HYDRAULICS_UNSOLVABLE_SPLIT`，不再静默少分。
- 新增 2 个 TS 回归（封顶守恒、能力不足错误码）与 3 个 Rust 测试（随机差分、分流/几何差分、1000 组分流与 1000 组几何属性不变量），并保留原有 48 步 parity。
- CodeQL workflow 从 `codeql-action@v3` 升到 v4 固定 SHA（action 声明 `node24`），清掉 Node20 弃用告警。
- M1：六项模块切片与水力随机差分门禁已完成；全厂同输入 TS↔Rust 出水/库存/三本账对比仍未开始，M1 总里程碑不关闭。M2–M4 未开始。
- `cargo test` 36 项全过；TS 1736/1736；`cargo fmt/clippy` 通过；`npm run ci` ALL GREEN。

## 2026-11-25 Rust 水力 / 输运 parity，M1 模块切片收口 (v0.11.11)

- 新增 `rust/crates/aquapilot-core/src/hydraulics.rs`：按 `src/sim/hydraulics.ts` 移植阻力分流、沿程+阀/堰局部阻力、泵 H-Q 曲线、分段 CSTR 输运、示踪剂注入/RTD 矩、质量守恒账、系列视图与快照。
- 用 TS oracle 生成 `rust/golden/hydraulics-48h.json`：6 条边（进水、好氧→二沉、RAS 泵、WAS 阀、空气、V 形堰出水），48 个 1 min 步长，含 900/850/1000 m³/h 流量阶跃与进水 60 kg 示踪剂脉冲。
- `tests/hydraulics_parity.rs` 对纯函数（管径、摩擦、泵/阀/堰、分流、段数）、6 条边全部字段、各段示踪剂/5 组分浓度、RTD、系列聚合逐项比对，相对容差 1e-12；阈值未放宽。
- 新增 `examples/hydraulics.rs`；`serde_json` 仅为测试读取 golden 的 dev-dependency，不进入运行时。
- M1 六项模块切片 parity 全部完成；但按 `docs/PROJECT-BASELINE.md` 的 M1 退出条件，全厂同输入 TS↔Rust 出水/库存/三本账对比与 fuzz/属性测试当时仍未开始（v0.11.12 已补水力部分），因此不把 M1 总里程碑标为完成。M2（Rust 服务端/AI/CLI）与 M3（3D/工业验收）、M4 同样未开始，不用占位实现冒充。
- `cargo test` 33 项全过；`cargo fmt/clippy` 通过；TS 全量 1734/1734 不变。

## 2026-11-25 Rust ADM1 泥线接入 (v0.11.10)

- 新增 `rust/crates/aquapilot-core/src/sludge_line.rs`：浓缩池固定分流/浓缩倍数、ADM1 CSTR 消化池（体积按进料流量与 SRT 反推）、VS 降解产气、脱水泥饼/滤液分配、累计负荷。
- 新增 `apply_filtrate_to_influent`：按厂流量把 NH4-N/COD/TP 回流负荷并入 `Influent`；流量为零时拒绝施加载荷，避免无流量基准的假回流。
- 用 TS oracle 生成 `rust/golden/sludge-line-48h.json`：80 m³/h WAS、8000 g/m³ SS、0.5 h 步长 48 h；`tests/sludge_line_parity.rs` 对 27 个 ADM1 组分、产气、脱水与累计量做 1e-12 相对容差比对，阈值未放宽。
- `cargo test` 26 项全过；`cargo fmt/clippy` 通过；TS 全量 1734/1734 不变。

## 2026-11-25 顶栏与 e2e 稳定性 (v0.11.7)

- 1366px + Linux Noto CJK 下顶栏最右控件落到 1369px：<=1500 断点再收紧 2px 间距与左右各 2px 内边距，留出字体度量余量。
- CI 2 核 runner 上「回放」页签 600ms 固定等待会误判：改为轮询真实标志元素最多 4s。
- 本地 e2e 六档宽度全过、0 控制台错误；TS 1729/1729。

## 2026-11-25 覆盖率门禁补测 (v0.11.6)

- Release `v0.11.5` 的 `npm run ci` 卡在覆盖率：lines 89.51% < 90、functions 92.19% < 95、branches 76.66% < 81；v0.11.4 基线同样为 89.44/92.19/76.38，属累积欠账。
- 新增 77 个分支级用例：MCP HTTP 壳、MCP 工具矩阵、聊天/模型配置处理器、ExperimentStore 内存降级、OPC UA/MQTT 模拟器、实验与研究 REST 边界。
- 覆盖率回到 93.84/81.83/95.16，阈值未下调；TS 全量 1729/1729（143 文件）。

## 2026-11-25 WP2 全厂边界三账闭合 (v0.11.5)

- ASM2d 排泥比从 0.1% Q 恢复到 0.6%–1.74% Q（默认 1.74%，SRT ≈ 12 d）；旧钳制与注释矛盾，导致 P 去除能力不足。
- 二沉池存泥 N/P 库存改用底流组分含量，替代固定 0.07/0.02；澄清池 P 库存不再少记 3–4 倍。
- 出水 N/P 计入溢流悬浮固体；RAS 硝酸盐在二沉池/回流管内的反硝化显式记入 N₂。
- RAS 底流 P 按进料/出水/流量闭合补足到 `X_PP`，不抬高可溶磷；排泥 P 按 98% 脱水捕集率折算。
- 结果：COD 4.93%、N 4.64%、P 4.89%，三账 `closed=true`；`plantBoundary` 17/17，TS 全量 1652/1652。

## 2026-11-25 ADM1 口径修正与子步进 (v0.11.4)

- [x] 修正 TS oracle：`hydCh/hydPr/hydLi` 改回 `X_ch/X_pr/X_li`；崩解产物进入 `X_ch/X_pr/X_li`，不再误加 `X_su/X_aa/X_fa`。
- [x] `stepAdm1`/`step_adm1` 公开入口按 <=0.05 h 自动子步，消除 0.5 h 显式 Euler 的酸化振荡（pH 6.42、S_ac 200 g/m³）。
- [x] `sludgeToAdm1In` 不再同时写入 `X_c` 与 `X_ch/X_pr/X_li`，避免泥线 COD 重复计量。
- [x] 重新生成 `rust/golden/adm1-48h.json`；Rust parity 全 27 组分 + 沼气/ pH 通过。
- [ ] WP2 三账仍红，和本次 ADM1 泥线修正无关（WP2 稳态关闭泥线）。

## 2026-11-25 ADM1 standalone parity (v0.11.3)

- [x] `rust/crates/aquapilot-core/src/adm1.rs`: 27-component ADM1, 11 rate processes, gas transfer, pH/inhibition diagnostics, explicit-Euler CSTR.
- [x] `rust/golden/adm1-48h.json`: 96 steps × 0.5 h at 1000 m³ / 100 m³/d.
- [x] `tests/adm1_parity.rs`: all 27 states within 64 f64 ulps; methane rate, methane fraction, pH and inhibition flag exact.
- [x] Parity finding: TS oracle's `hydCh/hydPr/hydLi` rates read `X_su/X_aa/X_fa` and never deplete `X_ch/X_pr/X_li`; Rust mirrors this intentionally. Correcting the oracle is a separate model change.
- [ ] ADM1 sludge-line integration and hydraulics parity still open.

## 2026-11-25 Takács settler parity (v0.11.2)

- [x] `rust/crates/aquapilot-core/src/takacs.rs`: 10-layer BSM1 Takács, double-exponential v_s, limiting-flux interfaces, feed layer, CFL sub-stepping, solids loading
- [x] `rust/golden/takacs-24h.json`: 24 h profile from TS oracle; Rust matches within 64 f64 ulps (bottom layer ~14,349 g/m³)
- [x] Rust unit tests for settling velocity / invalid geometry; one parity test; clippy `-D warnings` clean
- [ ] ADM1 / hydraulics parity still not started
- [x] WP2 30 d COD/N/P 三账闭合（v0.11.5）

## 2026-11-25 ASM1 CSTR/network parity (v0.11.1)

- [x] `src/sim/asm1Network.ts`: constant-volume CSTR + ordered 5-tank network slice; RAS particulate thickening, internal recycle, deterministic sub-stepping
- [x] `rust/crates/aquapilot-core/src/asm1_network.rs`: same slice in Rust; 24 h CSTR + 48 h network match TS at `<=1e-12`
- [x] Golden fixtures `asm1-cstr-24h.json`, `asm1-network-48h.json`; 3 TS invariants + 2 Rust parity tests
- [x] Removed the last Rust `AP_DEBUG_REACT` console probe; clippy `-D warnings` clean
- [x] WP2 30 d COD/N/P 三账闭合；无 tolerance relaxation、projection 或 `it.fails`

## 2026-11-24 simulation studies (v0.11.0)

- [x] `src/sim/study.ts`: base + 1–12 variants + 1–2 replicates (24 max), deterministic seeds, metrics/P95, ranking, Pareto, Markdown report
- [x] `studySchema/studyStore/studyService/routes/studies.ts`: valibot boundaries, SQLite WAL + memory fallback, batch queue capacity (`429 STUDY_QUEUE_FULL`), idempotency, cancel, ETag
- [x] OpenAPI 3.1 study paths/schemas; MCP `create_study/get_study/list_studies/cancel_study/get_study_report`; CLI `aquapilot study --file`
- [x] 13 study tests (domain/service/API); production smoke: POST 202, poll succeeded 2/2, report.md 200
- [x] Removed leftover `AP_DEBUG` console probes from ASM2d network path
- [x] README/README.zh-CN, API, backend modernization, plant-boundary and changelog updated
- [x] WP2 30 d COD/N/P 三账闭合（v0.11.5）; no tolerance relaxation, no projection, no `it.fails`

## 2026-11-24 repository delivery

- [x] Concise English/Chinese README, screenshots and demo linked
- [x] Five-platform main synced; all side branches removed
- [x] GitHub descriptions, topics, auto-merge, delete-branch-on-merge and main protection enabled
- [x] Gitee/GitCode descriptions, main branch and merge settings set
- [x] Docs consistency tests repaired
- [x] WP2 30 d COD/N/P balance closure (remaining red CI gate)

## 2026-11-24 前端收尾（已做完）

- [x] 工艺编排默认 1:1，不再在桌面被强制压到 64% 小字
- [x] 全览随容器尺寸重算，1024/1280 不再沿用旧缩放裁掉右侧单元
- [x] 1100px 以下编辑器改单列可滚动：组件库横条、画布固定可用高度、属性栏可到达
- [x] 画布解除监视视图的 30dvh 高度上限，三条泳道在窄屏完整可见
- [x] 编辑态节点间距 46px、泳道分隔线加深、图例移到画布上方工具带、端口热区扩到 21px
- [x] 触屏单指平移画布，1:1 下可拖到右侧与下方单元
- [x] 前端相关 87 项单测通过；全量 1618/1619，唯一红灯仍是 WP2 全厂 COD/N/P 边界
- [x] 本地 `npm run e2e` 通过；五平台 main 已同步到 `2604ddf`

## 2026-11-24 后端现代化（代码与文档已做完，待推送）

- [x] 实验领域层：拓扑快照 + 显式 spec + 种子；fixed/AI 闭环；30 d/20k 样本/288 决策上限
- [x] 持久队列：SQLite WAL + 内存降级；并发 2/队列 24；429 背压；幂等重放/冲突；重启恢复
- [x] 版本化 API：`/api/v1/experiments` CRUD/cancel、CSV、Markdown、OpenAPI 3.1、RFC 9457、ETag、cursor
- [x] MCP 工具总线：`create_experiment` / `get_experiment` / `list_experiments` / `cancel_experiment`
- [x] CLI：`aquapilot experiment --minutes/--days/--policy/--validation/--plant --csv --json`
- [x] 多维校验：有限性、非负、采样覆盖、运行合规、三本账、重复性、1/2 min 步长收敛
- [x] 认证边界：viewer 读 / operator 写；未认证返回 problem+json；OpenAPI 公开
- [x] `npm run typecheck` / `npm run lint` / `npm run format` / `npm run build` 通过
- [x] 新增实验测试 6 + 服务 5 + API 6，全部通过；全量 1635/1636，唯一红灯仍是 WP2
- [x] `npm run e2e`：PASS（17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors）
- [x] 生产构建冒烟：202+Location、幂等 200、冲突 409、422/415/400、ETag 304、CSV/Markdown、MCP 4 工具、CLI
- [x] 生产重启恢复：30 d AI 实验在 SIGKILL 后重排队并成功完成（43200 min, 100%）
- [x] README 中英、API、BACKEND-MODERNIZATION、CHANGELOG 更新；产品定位改为仿真建模软件
- [x] 五平台 main 推送与远端 CI 复核（提交后执行）
- [ ] WP2 全厂 COD/N/P 三本账（本轮未解决，唯一红灯）

已知边界：FMI 3.0 / SSP 1.0 未实现；当前对外互操作是 REST/OpenAPI 3.1 + MCP 2025-06-18，不宣称 FMI 兼容。

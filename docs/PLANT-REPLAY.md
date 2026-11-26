# 整厂 production 轨迹 replay（v0.11.14）

> **历史参考（2026-11-27）**：旧 `rust/` parity 实现与 golden 已删除；本文保留旧版 replay 口径记录，现行 v2 见 `docs/ROADMAP-V2.md` 与 `rust-v2/`。

> 目的：给 M1 的“新旧内核在同一输入下出水、库存、三本账误差在约定容差内”
> 提供可复现证据。不是模块拼接测试，也不是把各模块 golden 相加冒充整厂。

## 1. 证据链

1. `src/sim/networkTrace.ts` 定义 `NetworkTraceHook` 与各阶段 trace 结构。
2. `src/sim/networkEngine.ts` 的 `stepNetwork(state, topo, dtMin, trace?)` 在
   **生产路径** 的真实调用点捕获输入与输出：
   - `stepAsm2dNetwork` 前的 pre-state、边流量、回流类型、进水、`xRas`、
     `rasPExact`、`xBiomass`、温度、`dtH`、`bioP`、`carbonDose`、曝气能力、
     DO 设定、毒性抑制，以及调用后的 19 组分、`kla`、积分项、`o2Demand`、flux；
   - `stepSettler` 前的 Takács 配置、10 层剖面、进料/底流，以及调用后的
     新剖面、`xEffluent`、`xUnderflow`、`solidsLoading`、`blanketM`、`sludgeMassKg`；
   - `stepSludgeLine` 前的泥线状态与进料，以及调用后的 27 组分 ADM1、
     气体、脱水、累计量、滤液；
   - `updatePlantBalance` 前的 row/inventory/errors 与真实 `BalanceInput`，
     以及调用后的 row/inventory/errors；
   - `solveEffluent`、`solveBiomass` 的生产投影输入与 expected。
3. 未传 `trace` 时 hook 不执行，零克隆开销；生产服务器默认不传。
4. `scripts/gen-plant-replay.ts` 用固定 seed 21、ASM2d、`plantEnabled`，
   `spinUpNetwork(..., 20 天)` 后设 `carbonDose = 8`，连续 96 步、每步 15 min，
   生成 `rust/golden/plant-replay-96step.json`（96 步，约 1.79 MiB）。
5. `rust/crates/aquapilot-core/src/plant_replay.rs` 按生产 `solveEffluent` 的
   clamp 口径复算出水，按逐池 19 组分 + 二沉池污泥 N/P 复算库存，按 ASM2d
   颗粒 COD 复算 MLSS/SRT/F-M。
6. `rust/crates/aquapilot-core/tests/plant_replay_parity.rs` 逐步：
   - 校验时间连续；
   - 用 trace pre-state 与捕获边流量重建 `Network`，设置 `net.order`，调用
     Rust `Network::step`，比对 5 个反应器 19 组分、`kla`、积分项、
     `o2Demand`、完整 flux；
   - 校验反应器 pre-state 与上一步 expected 连续；
   - 用 trace pre-state 调用 `step_settler`，比对 10 层剖面与派生量；
   - 反序列化泥线 pre-state（含 ADM1 27 组分、气体、脱水、累计量），调用
     `SludgeLine::step`，逐字段比对并与下一步 pre-state 连续；
   - 用生产 pre-row/inventory/errors 与真实 `BalanceInput` 调用
     `PlantBoundaryState::update`，逐 row/inventory/error code 比对；
   - 从 expected 反应器态独立复算库存、出水、生物量/SRT/F-M 并比对。

## 2. 容差口径

- 模块 golden（ASM1/ASM2d/ADM1/Takács/水力/三本账）维持 1e-12 绝对容差。
- 整厂闭环轨迹的记录值是 96 步、每步 15 min、带真实回流与控制的生产序列。
  状态、二沉池、泥线、三本账、出水、库存、生物量统一用 **1e-8 绝对容差**；
  本次实测最大绝对残差 **1.73e-9**，余量约 5.8 倍。
- 这不是把模块容差放宽到 1e-8 来掩盖差异：模块仍按 1e-12/1e-9 卡；
  1e-8 只用于闭环轨迹的累积浮点噪声，且容差值和实测残差都写在测试注释里。

## 3. 本轮 replay 暴露并修复的真实缺陷

1. Rust `asm2d.rs` 的 `ammonification` 化学计量为空，而 TS 为
   `S_F:-1`、`S_A:0.3`、`S_I:0.7`、`S_NH4:i_N_SI`；已补齐。
2. Rust `Params::default().k_amm` 为 `0.08`，TS 为 `0.008`，放大 10 倍；已改为
   `0.008`。
3. TS 网络按 0.1 ℃ 分档缓存速率闭包，Rust 之前用未分档温度；已在 Rust
   reaction 路径按 0.1 ℃ 取整，曝气仍用真实温度。
4. Rust `Network::step` 把 `o2_transferred_kg_h` 又除了 `dt_h`，导致 4 倍偏大；
   已改为与 TS 一致直接累加 kg/h。
5. Rust CSTR 切片 `q_pp=1.5`，TS CSTR 覆盖为 `20.0`；且缺好氧段磷酸盐
   luxury uptake 后处理。已补齐并新增 `golden/asm2d-cstr-aerobic-30h.json`。
6. 旧 `asm2d-network-48h.json` 与 `asm2d-cstr-24h.json` 是 ammonification /
   CSTR 参数变更前的 stale fixture；测试原先硬编码期望、不读 golden。已用当前
   TS 重生成，并让 Rust 测试直接读 fixture，避免再次漂移。

## 4. 边界

- replay 只覆盖一个固定工况（seed 21、20 d spin-up、碳源 8、96 步），
  不是全工况证明；参数标定、现场污泥性质、真实 PLC 接入仍属现场验收门。
- 不替代 7×24 soak；soak 需要至少 24 h 真实时钟与 RSS/句柄/线程/重连/队列指标，
  归 M2-3。
- M1 退出条件已由本证据补齐；M2–M4 仍按原计划推进，不能由本文件推导为已完成。

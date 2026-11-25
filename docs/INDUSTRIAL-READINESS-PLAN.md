# AquaPilot 工业级仿真实施计划

> 版本：2026-11-25（历史计划；文档状态截至 v0.11.10）
> 基线：`05c5642`（v0.9.0，MIT，仅 `main`）  
> 本文件保留 2026-11-24 的计划口径；实际已按批次推送五平台，当前状态以 `docs/PROJECT-BASELINE.md` 为准。

## 1. 交付边界（先说清楚，避免假承诺）

本计划把“工业级”拆成 **代码内可验证的仿真能力** 与 **必须依赖现场数据/硬件的接入能力** 两类。

**代码内可完成并验收：**

- ASM1/ASM2d/ADM1 的机理与全厂物料边界
- 水力学、多系列、仪表与执行机构、PID/联锁
- 标定、不确定性、质量平衡、合规统计
- 资产状态、工业协议适配层（模拟服务器 + 可测试契约）

**不能只靠代码承诺、必须由现场条件完成的：**

- 具体水厂的参数标定与验收（需要历史运行数据、实验室报告、采样口径）
- OPC UA/Modbus 真实 PLC 接入（需要协议栈、网络分区、安全评估、现场联调）
- 安全仪表系统（SIS/ESD）认证、法定排放报表签字
- 与 DCS/SCADA 的闭环控制投运

这些不在本轮“代码做完”里冒充完成；计划中单列为 **现场验收门**，交付物是可测试适配层、接口契约、模拟器和接入清单，而不是一句“已支持”。

## 2. 工作包与验收标准

| ID | 工作包 | 核心交付 | 验收标准 | 状态 |
|---|---|---|---|---|
| WP1 | ASM1 温度/pH/游离氨 + KLa 曝气闭环 | `src/sim/aeration.ts`、ASM1 抑制、DO PI、风机功率 | 冬季场景实际降温且硝化变差；鼓风机故障 DO 脱离设定值；KLa 不贴设定值；单元 + 网络回归通过 | 已完成 |
| WP2 | ASM2d 生物除磷 + ADM1 泥线闭环 | 主引擎支持 ASM2d；消化池/沼气/沼液回流接入；TP/TN 全厂账 | 厌氧释磷、好氧吸磷、PAC 三条路径可区分；泥线回流对水线 N/P 负荷可见；质量平衡闭合 | **已交付 / 17/17**：过程级 COD/N/P 计量闭合；30 d 全厂 COD 4.93%、N 4.64%、P 4.89%，三账 `closed=true`；无 `it.fails`、无放宽容差（见 `docs/PLANT-BOUNDARY.md` §5.1） |
| WP3 | 水力学与多系列 | 阻力分流、管渠容积/输运延迟、泵/阀/堰、多二沉池 | 两支路流量不按数量均分；示踪剂有停留时间分布；两条完整系列可独立回流/排泥 | 已完成：阀位 0.3/0.7 → 303.99/696.01 m³/h，示踪剂 τ=4.5 min、σ²=11.98，双系列 2 trains/2 clarifiers，82 项测试 |
| WP4 | 仪表、执行机构、控制层 | 传感器模型、执行器模型、PID/联锁、测量与真值分离 | 报警/AI 只读测量值；传感器故障/漂移/死时间可注入；阀门/风机饱和与速率限制生效 | 已完成：两阶段共 35 项测试；默认理想仪表零扰动，故障/漂移/死时间/联锁/ESD/资产折减均进物理路径 |
| WP5 | 标定与不确定性 | 内部剖面观测、参数置信区间、蒙特卡洛/后验 | 不只拟合 4 个出水指标；给出参数相关性与 P10/P90；质量平衡可审计 | 已完成：真值恢复 mu_A 3.9%/K_NH 4.8%/b_H 11.6%，区间覆盖 19/20，P10/P50/P90 COD 17.88/22.62/26.26，50 项测试 |
| WP6 | 合规与报表 | 日混合样、24h 均值、95% 分位、采样 QA/QC | 按许可证口径出报表；分钟值不再直接冒充达标率 | 已完成：type-7 95 分位、加权日均、QA 剔除、CSV/422/400 错误码，24 项测试 |
| WP7 | 资产与运维 | 设备状态、故障码、维护、备机、ESD | 设备不是拓扑图标；故障/检修/备机影响可用性 | 已完成：21 台设备、健康度衰减、备机 5 min 自启、ESD 锁存/复位，22 项测试 |
| WP8 | 工业接口 | OPC UA/Modbus/MQTT 适配层、标签映射、质量码、审计 | 模拟服务器可跑通；断线重连/质量码/只读边界有测试；现场接入单列 | 已完成：28 标签、Modbus 真 socket FC03/04/06/16、指数退避、写审计，36 项测试 |
| WP9 | 验收与交付 | 回归、性能、浏览器、文档、差距矩阵 | tsc/eslint/vitest/build/jscpd 全绿；报告与复现命令齐全 | 已完成：见 §3.6 |

## 3. WP1 已完成内容（2026-11-23）

### 3.1 温度

- `buildRates(p, temperatureC)` 本来支持 Arrhenius，但生产路径在模块加载时用 `buildRates()` 固定成 20 ℃。
- 改为按反应器实际水温取速率闭包，按 0.1 ℃ 分档缓存；`reactionRatesWithSuppression` 接收 `temperatureC`。
- 冬季场景不再只改显示温度：水温进入 `mu_H/b_H/mu_A/b_A/k_h/k_a` 的温度修正。

### 3.2 pH 与游离氨

- 新增 `phFromAlkalinity`，由 ASM1 碱度给出反应器 pH 代理值。
- 新增 `freeAmmoniaMgL` 与 `processInhibition`：
  - 低 pH 抑制硝化更明显，异养菌阈值更低；
  - 高 pH + 高氨氮时游离氨抑制自养菌；
  - 衰减过程不叠加 pH 抑制；
  - 基准 pH 7.2 以上不额外惩罚，避免改变原 ASM1 基准。
- `ASM1_LIMITATIONS` 同步更新，避免文档继续写“未做温度修正”。

### 3.3 曝气与风机

- 新增 `src/sim/aeration.ts`：
  - `saturationDo(T)`：水温对饱和溶解氧的影响；
  - `stepAeration`：KLa 氧传递 + 前馈/PI + 积分限幅 + 执行器速率限制；
  - 氧平衡用解析解，避免大 KLa/大步长显式欧拉发散；
  - 风量与风机功率按实际传递氧量计算，不再按需氧量倒推。
- 默认 ASM1 好氧池 DO 不再是 `min(doSat, doSetpoint × capacity)` 的直接赋值；鼓风机故障时 DO 会真实下降。

### 3.4 回归

新增：

- `tests/aeration.test.ts`：11 个单元用例
- `tests/networkPhysics.test.ts`：3 个网络级用例（冬季、鼓风机故障、DO 非贴值）

已跑：

```bash
npx tsc -p tsconfig.json --noEmit
npx eslint src/sim/aeration.ts src/sim/asm1.ts src/sim/asm1Mapping.ts src/sim/networkEngine.ts src/sim/networkTypes.ts tests/aeration.test.ts tests/networkPhysics.test.ts
npx vitest run tests/aeration.test.ts tests/networkPhysics.test.ts tests/asm1.test.ts tests/asm1-nitrogen.test.ts tests/network.test.ts tests/tankStates.test.ts tests/bsm1-benchmark.test.ts
```

结果：类型检查、lint、全部相关测试通过；BSM1 Table 6 对照未退化。

全量验收（2026-11-23）：

```text
npx vitest run                115 files / 1415 tests passed，约 176 s
npm run build                 client + server + cli 全部成功
npx jscpd ...                 37,698 行，0 克隆，0 重复行
```

服务端冒烟：`PORT=5199 AQUAPILOT_PERSIST=0 node dist/server/index.mjs`，`/api/snapshot` 返回正常，出水 NH₄-N 约 0.48 mg/L、DO 由 KLa 平衡、风机功率约 163 kW（随进水温度变化）。


## 3.5 工作包交付结果（2026-11-23）

### WP3 水力学与多系列 — 已完成

- 新增 `src/sim/hydraulics.ts`、`src/server/routes/hydraulics.ts`、`tests/hydraulics.test.ts`（14 项）、`docs/HYDRAULICS.md`。
- 阀位 0.3 / 0.7 → 303.988 / 696.012 m³/h（30.4% / 69.6%），总量守恒；示踪剂 θ=3 min 实测 τ=4.5 min、σ²=11.98；管段质量残差 0.00000 kg。
- 双系列编译 2 trains / 2 clarifiers，各系列独立回流/排泥；`resolveFlows` 阻力分流 Q ∝ 1/√R。

### WP4 仪表、执行机构、控制层 — 已完成（两阶段）

- 阶段一：`src/sim/instruments.ts`、`actuators.ts`、`controlLayer.ts`，23 项单测；死时间 2 步保持旧值、第 3 步 4.518，漂移 0.2096/24h，阀门 0→100% 5 步，PID 限幅积分 0。
- 阶段二：仪表/控制层/资产挂进 `NetworkSimState` 与快照两帧；`/api/instruments`、`/api/control/interlocks` 接线。
- 默认理想仪表（τ=0、死时间 0、噪声 0）保证基线数值逐位不变；stuck 质量码 `bad`、漂移偏差 0.01–0.03、死时间第 5 步跟随。
- 联锁 DO 低 → 风机拉满、DO 回升；锁存/显式复位/回差（1.2 拒绝、1.4 允许）。
- 资产风机 `MOTOR_OVERLOAD` → 因子 <0.7、DO 回落，备机 5 min 自启 → 因子 >0.8；ESD → 曝气容量 0、手动指令被拒并写审计。
- 新增 `tests/instrumentationEngine.test.ts`（12 项），本批 35 项。

### WP5 标定与不确定性 — 已完成

- `src/sim/uncertainty.ts`（635 行）、`src/server/routes/calibration.ts`、`tests/uncertainty.test.ts`（9）、`tests/calibrationProfile.test.ts`（12）、`docs/CALIBRATION-UNCERTAINTY.md`。
- 真值恢复 mu_A 3.9% / K_NH 4.8% / b_H 11.6%；区间覆盖 19/20；P10/P50/P90 出水 COD 17.88 / 22.62 / 26.26 mg/L。
- 数据不足 → `CALIBRATION_INSUFFICIENT_DATA`；质量平衡 5% 不告警、8.33% 行级告警。
- 合成数据边界：r(mu_A, b_A) = −1.0000 由 GN 协方差退化补偿导致，测试只断言符号与 |r|>0.5，未据此宣称可辨识。

### WP6 合规与报表 — 已完成

- `src/sim/sampling.ts`、`compliance.ts`、`src/server/routes/compliance.ts`、`tests/compliance.test.ts`（24）、`docs/COMPLIANCE.md`。
- 95 分位 type-7；加权均值 21.636 vs 算术 29；QA 剔除后达标率 100%；422 `COMPLIANCE_NO_SAMPLES`、400 `PERMIT_WINDOW_INVALID`。
- 服务端 40 天环形分钟读数账本 `src/server/complianceLedger.ts`，每步推进自动入账。

### WP7 资产与运维 — 已完成

- `src/sim/assets.ts`（664 行）、`maintenance.ts`（261）、`routes/assets.ts`、`AssetsPanel.tsx`、`tests/assets.test.ts`（22）、`docs/ASSET-MANAGEMENT.md`。
- 21 台设备；风机故障组因子 1.0→0.5、备机 5 min 自启恢复 1.0；健康度 100→99.95/10h；ESD 锁存/复位；未知 id 404 `ASSET_NOT_FOUND`。
- 资产状态现在由引擎每步 `tickAssets` 维护，`/api/assets` 直接读 `runtime.net.assets`。

### WP8 工业接口 — 已完成

- `src/server/protocols/{tags,audit,adapter,fromNetworkState}.ts` + `transports/{opcua,modbus,mqtt}.ts`、`routes/protocols.ts`、36 项测试、`docs/INDUSTRIAL-PROTOCOLS.md`。
- 28 标签；Modbus 真 socket FC03/04/06/16；退避 100→200→400→800→1000 上限；拒绝写入可审计。
- 真引擎 4 标签一致：DO 2.0、flow 1519.5126、NH 0.3163、总功率 76.693。

### WP2 ASM2d 除磷 + ADM1 泥线 — 已交付

已落地：

- 真积分 ASM2d 网络（非单池投影）、泥线消化/沼气/沼液回流、三本账（COD/N/P）逐项记账。
- 本轮定位并修复根因：`ammonification` 曾按 **1 gN/gCOD** 释放氨氮，正确应为 `i_N_SI≈0.01`；水解按 `i_N_XS − i_N_SI` 释放差额。修复后 NH₄ 0.14、COD 41.9、SS 7.8、缺氧 NO₃ 降 85.7%、X_H 1070、X_AUT 176。
- 新增 `tests/asm2dConservation.test.ts`（5 项）：闭合批次只投 X_S 时 NH₄ 增量不超过 X_S 含氮量；过程级 COD/N 残差 <1e-9。

验收门（默认拓扑/进水，seed 5，10 d 预热 + 20 d，泥线开启）：

| 项 | 实测 | 门限 |
|---|---|---|
| MLSS | 2572.6 mg/L | 2000–4000 |
| 出水 COD / SS | 59.46 / 8.84 mg/L | <60 / <20 |
| 出水 NH₄-N / TN / TP | 0.134 / 8.42 / 0.129 mg/L | <5 / <20 / <1.5 |
| X_PAO / X_PP / X_PHA | 474.8 / 898.2 / 0.05 gCOD/m³ | 非零循环 |
| 三账残差 COD / N / P | 4.93% / 4.64% / 4.89% | ≤5% |

闭合口径：ASM2d 排泥比 0.6%–1.74% Q（默认 1.74%，SRT ≈ 12 d）；二沉池存泥 N/P 用底流组分；
出水 N/P 计入溢流悬浮固体；RAS 反硝化 N₂ 入账；RAS 底流 P 按流量闭合补足 `X_PP`；排泥 P 按
98% 脱水捕集率。没有投影、反推归零、放宽阈值或 `it.fails`。

### 集成层新增

- `src/server/apiRoutes.ts` 接线：水力学、合规、资产、协议、全厂平衡、仪表/联锁、标定不确定性（无剖面时 409）。
- `src/client/components/InstrumentsPanel.tsx` + 工业页签第 4 个子视图「仪表联锁」；`tests/industrialPanel.test.tsx` 6 项。
- `tests/industrialRoutes.test.ts` 16 项覆盖新路由与空子系统降级。


### 3.6 WP9 验收记录（2026-11-23）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `npx tsc -p tsconfig.json --noEmit` | 0 错误 |
| Lint | `npx eslint src tests` | 0 错误 |
| 格式 | `npx prettier --check "src/**/*.{ts,tsx,css}" "tests/**/*.{ts,tsx}"` | 全部匹配 |
| 回归 | `npx vitest run --maxWorkers=4` | 132 文件 / 1614 通过 + 3 预期失败 / 0 失败，278 s（v0.10.0 当时记录） |
| 构建 | `npm run build` | client + server + cli 成功 |
| 重复代码 | `npx jscpd src --min-lines 8 --min-tokens 80 --format ...` | 0 克隆（48,050 行） |

- WP2 网络级稳态/三账/三路径用例已全部真实通过（17/17），断言与阈值未改。
- 并发压测下 `wsAgentConfigAuth.integration.test.ts` 的 tsx 冷启动会超过 10 s，健康轮询上限由 40×250 ms 提到 240×250 ms（断言不放宽），全量套件恢复全绿。
- 服务端冒烟（`PORT=5199 AQUAPILOT_PERSIST=0 node dist/server/index.mjs`）：`/api/health`、`/api/snapshot`、`/api/hydraulics`、`/api/instruments`、`/api/control/interlocks`、`/api/assets`、`/api/plant/balance`、`/api/protocols/tags`、`/api/compliance/report` 均 200；`/api/calibration/uncertainty` 409 `CALIBRATION_INSUFFICIENT_DATA`（无剖面数据，符合契约）。
- 浏览器冒烟（Chromium）：侧栏 12 个页签；工业页 4 个子视图（合规 / 资产 / 协议 / 仪表联锁）；仪表 25 测点、0 异常，`measured` 与 `truth` 逐位一致；快照、仪表、联锁三处 `timeMin` 对齐（t=42 min）。
- 提交方式：单次统一 commit（不 push、不建分支），版本 `0.10.0`（历史记录；当前 v0.11.10 已推送五平台）。
- **当前门禁（v0.11.10）**：143 文件 / 1734 用例全部通过，0 预期失败；覆盖率 94.07/82.02/95.22（阈值 90/81/95）。见 `docs/PROJECT-BASELINE.md` §1.3。


### 3.7 语言迁移 M1：Rust 仿真内核切片（2026-11-24）

- `rust/` Cargo workspace 已建立，`aquapilot-core` 启用 `#![forbid(unsafe_code)]`；Rust 1.100.0。
- 已完成 ASM2d 19 组分/19 过程、CSTR、曝气/DO PI、前馈、风机功率、5 池网络（外回流/RAS/发酵/好氧吸磷/DO 控制）移植。
- CSTR 24 h 与 TS 逐位一致（≤1e-12），黄金 `rust/golden/asm2d-cstr-24h.json`；5 池 48 h 的 19 组分 × 5 反应器与 TS **逐点完全一致**，黄金 `rust/golden/asm2d-network-48h.json`。
- `cargo test` 7 单元 + CSTR parity + network parity 全过；`cargo clippy --all-targets -- -D warnings` 0 报错。
- 后续已完成：ASM1 反应面/CSTR/网络、ADM1 standalone CSTR、Takács 二沉池的 Rust parity；CI 现在会跑 `cargo fmt/clippy/test`。
- 当前 M1 剩余：ADM1 泥线整链与水力/输运 parity；M2–M4 未开始。状态以 `WORKLOG.md` 与 `docs/PROJECT-BASELINE.md` 为准。

## 4. 实施顺序与依赖

```text
WP1（物理内核）
  ↓
WP3（水力学/多系列）──→ WP2（ASM2d/ADM1 全厂边界）
  ↓                         ↓
WP4（仪表/执行机构/PID）──→ WP5（标定/不确定性）
  ↓                         ↓
WP7（资产/运维）          WP6（合规/报表）
  ↓
WP8（工业接口）
  ↓
WP9（总验收）
```

顺序理由：

1. 没有真实水力学，多系列和泥线回流只是“图上连线”；
2. 没有仪表/执行机构，AI 决策和报警仍然是读真值；
3. 没有标定与合规口径，模型再准也不能用于运行报告；
4. 工业协议必须建立在稳定的状态契约和审计之上，否则只是把 WebSocket 换层皮。

## 5. 每个工作包的完成定义（DoD）

- 代码：类型安全、无重复实现、错误路径有明确错误码/信息；
- 数值：有基准或守恒测试，不引入发散、负浓度、NaN；
- 回归：相关单测 + 网络级集成测试 + 原有 BSM1 不退化；
- 性能：单步耗时不显著回退，趋势接口不因新增状态爆炸；
- 文档：模型边界、单位、参数来源、未做项写清楚；
- 可观测：新增状态能在 snapshot/API/UI 中看到，而不是藏在闭包里；
- 迁移：旧拓扑/旧快照/旧配置有兼容策略，不静默丢字段。

## 6. 现场验收门（不冒充代码完成）

| 门 | 需要用户/现场提供 | 交付前的状态 |
|---|---|---|
| 真实标定 | 至少 2 周历史数据：进出水、池内剖面、DO/MLSS、泥位、药剂、电耗 | 代码支持后，用数据出报告 |
| OPC UA/Modbus | PLC 型号、标签表、网络分区、只读/写权限、安全评估 | 模拟器 + 契约先行，现场联调单列 |
| SIS/ESD | 联锁矩阵、因果表、SIL 等级 | 仿真联锁可做，认证不在代码内 |
| 法定报表 | 当地许可证口径、采样频次、实验室 QA/QC | 报表引擎可做，签字/备案不能代做 |

## 7. 当前不承诺的事项

- 不承诺“一次提交就达到商业 GPS-X/BioWin 的设计校核能力”；
- 不承诺“没有现场数据也能给出这座厂的参数置信区间”；
- 不承诺“没有 PLC/安全评估就能直接控制真实水厂”；
- 不承诺“所有工作包在同一轮全部完成”；按上表逐包验收，未完成的不标完成。

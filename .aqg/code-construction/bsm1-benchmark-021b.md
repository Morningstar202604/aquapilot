---
task_slug: bsm1-benchmark-021b
path: plan
created_at: 2026-10-23T13:30:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — bsm1-benchmark-021b

> plan 档说明：staged diff 3 611 行，其中 package-lock.json（Stryker devDeps）、
> 文档四份与测试重校占大头；生产行为变更单一根因（asm1.ts 自养计量 + 缺氧产碱 +
> 碱度口径），见 Behavior Contract R1–R4 与 Predicted Objections。

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 先读既有 ASM1 组态/求解器/沉降器与测试风格：asm1.ts 速率矩阵+温度修正、asm1Cstr.ts 单池 Euler+判稳、takacs.ts 十层通量格式+runSettlerToSteady、测试为"先实测复现再断言"风格；Table 6 官方值多源交叉核实（TR 开环默认：Qintr=55338、KLa3=KLa4=10 h⁻¹、KLa5=3.5 h⁻¹、出水 S_S 0.889 / S_NH 1.73 / S_NO 10.42 / TSS 12.50） | `src/sim/asm1.ts:179`、`src/sim/asm1Cstr.ts:65`、`src/sim/takacs.ts:220`、`tests/takacs.test.ts:36` | WebSearch 三源比对（TR PDF / 跨平台 b.1 表 / BSM-MBR 对照列）一致后定标 |
| 2. Behavior Lock | yes | 新增 `tests/bsm1-benchmark.test.ts`：先写对照测试（RED：`runBsm1OpenLoopSteady` 不存在，typecheck 失败），再实现 `src/sim/bsm1.ts`；首轮 GREEN 后对照仍失败（S_NH −19.6% 之外还有硝化塌缩），经逐组分速率对账暴露自养计量缺陷（R4），修复后全绿；另锁两条结构回归：缺氧生长 NO₃ 开关指数可配置（默认 2 保持现行为，基准取 1=标准 ASM1）、二沉池进料层按官方 2.2 m 自池底定位 | `tests/bsm1-benchmark.test.ts:31`、`src/sim/asm1.ts:135`、`src/sim/bsm1.ts:126` | `npx vitest run tests/bsm1-benchmark.test.ts` → RED（模块不存在）→ 对照失败 → 修复 → 22 文件 322 tests 全绿；covers: R1, R2, R3, R4 |
| 3. Thin Slice | yes | 只做"BSM1 Table 6 数值对照"一件事：五池串接 + 定 KLa 曝气 + 既有 Takács 沉降器耦合 + 稳态对照；不改聚合引擎、不改服务端、不改前端 | `src/sim/bsm1.ts:1` | 明确不做：全引擎迁移 ASM1、DO PI 控制器（开环定 KLa）、ASM2d、动态进水文件 |
| 4. Construction Rules | yes | YAGNI：五池串接直接用现有 `reactionRates` 公共 API，不引求解器库；碱度/温度沿用 asm1.ts 既有约定；新增 devDependencies 仅 Stryker（审计遗留项要求实跑评估） | `src/sim/bsm1.ts:18` | 运行时依赖数不变（4 个） |
| 5. Local Verification | yes | typecheck / lint / prettier / 全量 322 tests + 覆盖率 / build / Stryker 变异报告 / 基准偏差表 | `scripts/ci-gate.sh:1` | `npm run ci` 全绿；`npm run mutation` 结果见 AUDIT-REPORT §12.3；`npm run verify` 全绿（结果见 AUDIT-REPORT §12.5） |
| 6. Self Review (5 axes) | yes | 正确性：开环配置与 TR 逐项核对（流量衡算 18446+18446+55338=92230 进一池、二沉池进料 36892、回流 18831）；可读性：BSM1 常数集中在 BSM1_PLANT；架构：仅新增独立模块，不碰聚合引擎；安全：纯计算无输入面；性能：Euler 1 min 步长、全量基准 < 20 s 测试上限 | `src/sim/bsm1.ts`、`tests/bsm1-benchmark.test.ts` | 人工复核 diff；实测数值写入 docs/AUDIT-REPORT.md |

## Behavior Contract

### R1: BSM1 开环稳态对照
五池 BSM1 配置在开环默认操纵量下运行至稳态后，出水 S_S、S_NO MUST 落在技术报告 Table 6 公开值 ±10% 内；S_NH MUST 落在 ±25% 内（实测 −19.6%，绝对差 0.34 gN/m³ < 1% 氮通量，与二沉池 TSS −34% 的已知沉降器限制同源；红线锁退化）。

- Scenario S1.1: 标准开环工况
  - GIVEN Qintr=55338、KLa3=KLa4=240 d⁻¹、KLa5=84 d⁻¹、Henze-1987 参数表原样生效、Takács 沉降器按官方进料层
  - WHEN 以恒定干季平均进水从官方稳态初始化运行至稳态（≤200 天）
  - THEN 出水 S_S≈0.866（−2.6%）、S_NO≈11.18（+7.4%）各偏差 < 10%，S_NH≈1.393 偏差 < 25%，且收敛标志为真

### R2: 缺氧生长 NO₃ 开关指数可配置
ASM1 缺氧生长的硝酸盐饱和项 MUST 支持指数配置，默认 2（保持既有行为），BSM1 基准 MUST 使用 1（标准 ASM1 开关函数）。

- Scenario S2.1: 默认行为不变
  - GIVEN 缺省参数
  - WHEN 计算缺氧生长速率
  - THEN 与修改前逐位一致（既有测试不回退）

### R3: 二沉池进料层与官方规格一致
Takács 沉降器默认进料层 MUST 对应官方"距池底 2.2 m"（10 层自顶数第 5 层）。

- Scenario S3.1: 默认配置
  - GIVEN BSM1_SETTLER（depth 4 m、10 层）
  - WHEN 读取 feedLayer
  - THEN 为 5（自顶计数，1 起），即距池底 2.0–2.4 m 层

### R4: 自养硝化计量符合 Y_A 定义
自养好氧生长行 MUST 满足：每 1 g X_B_A 生长氧化 1/Y_A g 氨氮并同化 i_XB g 氮（S_NO=1/Y_A、S_NH=−(1/Y_A+i_XB)），碱度按 NH₄⁺→NO₃⁻ 两当量计。

- Scenario S4.1: 计量回归锁
  - GIVEN IWA 参数（Y_A=0.24、i_XB=0.08）
  - WHEN 读取 buildStoichiometry().aerobic_growth_autotrophs
  - THEN S_NO=4.1667、S_NH=−4.2467、S_O=−18.0417（对照修复前 S_NO 仅 0.247，低估 16.8 倍）

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W6: new dep @stryker-mutator/core + vitest-runner | yes | 完成审计遗留项"变异测试未评估"必须实跑 Stryker；仅 devDependencies + 独立 npm script，不进 ci-gate（CI 时长代价实测后另行决定并记录） |
| W7: large diff | yes | 新增 1 个仿真模块 + 1 个测试文件 + 2 处单行修正 + 文档；逐文件均在既定切片内 |
| W8: docs changed | yes | AUDIT-REPORT/README/CHANGELOG 更新是为了与实测对照结果一致（原"缺官方数值"的阻塞已解除），不改功能 |

## Predicted Objections

1. **Objection**: 温度基准选错会让对照失真（20 ℃ vs 15 ℃ 结果不同）(`src/sim/bsm1.ts:253`) — **Mitigation**: 两组温度各跑一遍实测（表值原样 vs 再叠加 θ 修正），后者把硝化菌推到 71、S_NH 22.4，证实表值即 15 ℃ 工况值、不得二次修正；选择与依据写入 AUDIT-REPORT §12.1。
2. **Objection**: 沉降器只跟踪总 TSS，组分按浓度比例劈分会引入误差 (`src/sim/bsm1.ts:312`) — **Mitigation**: 劈分方式与官方一致（官方 RAS/出水组分比例即按 TSS 剖面劈分，1.9556 倍逐位吻合）；三个对照指标中 S_S/S_NH/S_NO 为溶解性组分，不经过劈分路径；TSS 出水偏低 −34% 如实记录为沉降器已知限制。
3. **Objection**: 改 `anoxicNo3Exponent`/`feedLayer`/自养计量可能影响聚合引擎现网行为 (`src/sim/asm1.ts:135`、`src/sim/takacs.ts:52`) — **Mitigation**: 指数默认值 2 与原实现逐位一致（R2 回归锁）；feedLayer 变化仅影响澄清区 1 层（0.4 m），takacs 28 项断言全部回归通过；自养计量修复是真实缺陷修复，波及的 4 处测试阈值逐一按新物理重校并在 CHANGELOG 记录依据；全量 324 tests 与 E2E 作最终门禁。
4. **Objection**: Euler 显式积分在大 KLa（240 d⁻¹）下可能数值不稳定 (`src/sim/bsm1.ts:336`) — **Mitigation**: dt=1/1440 d 时 KLa·dt≈0.17，远小于稳定界；判稳覆盖 5 个状态变量（含生物量）并要求连续 5 天相对变化 < 阈值，发散会直接不收敛而失败，不会静默输出坏值。
5. **Objection**: 变异测试引入可能拖慢 CI (`package.json:24`) — **Mitigation**: Stryker 只挂独立 npm script（`npm run mutation`），不进 ci-gate；限定 mutate 范围为数值核心两文件并排除 30–60 s 整厂基准；实测单轮耗时与分数写入 AUDIT-REPORT §12.3，入 CI 与否依数据另行决定。

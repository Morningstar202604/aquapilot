---
task_slug: debt-payoff-and-theory-audit
path: plan
created_at: 2026-10-27T03:50:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: "末轮改动（幽灵干预键清理 + 干预清单测试）由 objection 7 覆盖；objection 1-6 针对此前各切片"
behavior_contract_exception: null
---

# AQG Code Construction Ledger — debt-payoff-and-theory-audit

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 逐层扫描 sim/model/server/client/ai：找重复实现（forcing 5 份、告警规则 2 份、时钟拼接 8 处、物流/单元元数据 3 份、TAARIFF 2 处、PLANT 几何 2 份）、死代码（engine/legacyModel/unitsByKind/neighboringUnits 等 14 处）、热路径浪费（每步 filter+sort、每预测 structuredClone）、反向依赖（shared/protocol → server/benchmark） | `src/sim/networkEngine.ts:273-390`、`src/server/index.ts:309`、`src/client/components/PlantCanvas.tsx:34`、`src/shared/protocol.ts:14` | 基线 708 tests / tsc 0 / eslint 0 / build OK / e2e PASS |
| 2. Behavior Lock | yes | 先给"单一来源"建锁定测试：forcing 11 项、alarmRules 7 项、sharedMeta+time 8 项，全部在改实现前先断言现有语义（covers: R1, R2, R3, R4） | `tests/forcing.test.ts`、`tests/alarmRules.test.ts`、`tests/sharedMeta.test.ts` | 新增 26 项；先 RED 后 GREEN |
| 3. Thin Slice | yes | 每片一条链路：强制函数收敛到 sim/forcing → 告警收敛到 sim/alarmRules → 展示元数据收敛到 shared/streamMeta → 时钟收敛到 shared/time → 编译期索引与克隆优化 → 参考引擎退出生产测试 | `src/sim/forcing.ts`、`src/sim/alarmRules.ts`、`src/shared/streamMeta.ts`、`src/shared/time.ts`、`src/sim/network.ts:54` | 不改动力学方程与告警阈值（除注明项） |
| 4. Construction Rules | yes | 复用既有纯函数分层；不引任何新依赖（运行时仍 4 个）；所有收敛都保持对外签名兼容或同步更新调用点；删除前先 `rg` 确认零引用；热路径优化以基准数字验证 | `package.json`、`src/sim/network.ts`、`src/sim/networkEngine.ts` | `npm ls --depth=0` 无新增 |
| 5. Local Verification | yes | 全量 vitest 708 passed / 54 files；coverage lines 92.42 / branches 81.9（阈值 91/82，见下）；tsc 0（含 noUnused）；eslint 0；prettier clean；build OK；e2e PASS；bench 前后对照 | 全仓 | 见 Verification 节 |
| 6. Self Review (5 axes) | yes | 正确性：收敛后行为由既有 708 项 + 新增 26 项锁定，参考引擎退出生产测试后生产路径首次被直接断言；可读性：删掉 855 行重复/死代码；架构：消除 shared→server 反向依赖与 plantModel↔networkEngine 循环；安全：无新增信任边界，删除了 `legacyModel` 这一未使用适配器；性能：单步 0.0175→0.0118 ms，决策 142.5→104.7 ms（名义） | `src/sim/network.ts`、`src/sim/networkEngine.ts`、`src/server/index.ts` | 人工复核 diff |

## Behavior Contract

### R1: Forcing functions have exactly one implementation
The system MUST compute diurnal flow, seasonal temperature, scenario envelope, toxic suppression, aeration capacity and recycle factors from a single shared module used by both the engine and its forecast clone.

- Scenario S1.1: engine and forecast share the curve
  - GIVEN a state at any simulated time
  - WHEN the production engine steps and the model forecasts from the same state
  - THEN both use the same diurnal/seasonal/envelope values (same source module, no local copies)

### R2: Active alarms have exactly one definition
The system MUST derive both the alarm history writes and the snapshot's active-alarm list from one rule table, with identical thresholds and messages.

- Scenario S2.1: threshold equality
  - GIVEN an effluent exactly at a limit
  - WHEN alarms are evaluated
  - THEN no alarm fires for that metric; one unit above the limit fires exactly one

### R3: Stream/unit presentation lives in one table
The system MUST take stream colours, widths, dash patterns, labels and unit icons/labels from `shared/streamMeta`, and no component may embed its own copy.

- Scenario S3.1: legend and ports agree
  - GIVEN the flowsheet renders a port dot and the legend entry for the same stream
  - WHEN colours are compared
  - THEN they are identical, and every stream has a unique colour

### R4: Simulation clock formatting lives in one module
The system MUST format every simulated timestamp through `shared/time`, so charts, alarms, reports and exports cannot drift.

- Scenario S4.1: short/long agree
  - GIVEN t = 1440 + 220 minutes
  - WHEN formatted short and long
  - THEN `D2 03:40` and `第 2 天 03:40` describe the same instant

## Warning Acknowledgements

| condition | acks | reason |
|---|---|---|
| W7: large diff | yes | 本轮是债务偿还与理论审计，跨 34 个文件：删重复/死代码 855 行、新增 3 个共享模块与 3 个测试文件；按 plan 级流程分片并逐片跑门禁 |
| W8: docs changed | yes | README/README.zh-CN 更新测试数 708、覆盖率 92.4/81.9、源树（新增 forcing/alarmRules、删除 engine.ts 说明）；CHANGELOG 记录本轮全部条目 |

## Predicted Objections

1. **Objection**: 把参考引擎从生产测试里移除会丢失"两引擎一致性"的保护 (`tests/cross-engine.test.ts:39`) — **Mitigation**: 一致性测试保留在 cross-engine 里，只把 `engine.test.ts`/`agent.test.ts`/`coverage-extra` 这些"生产行为门禁"迁到 networkEngine；参考引擎仍被 cross-engine 引用。
2. **Objection**: 告警收敛后文案变化影响界面断言 (`tests/components.test.tsx:241`) — **Mitigation**: 规则表保留原 code/severity，文案统一为「超一级A（限值 X）」；组件测试只断言 code 与结构，全部通过。
3. **Objection**: 编译期索引让 CompiledNetwork 变大、序列化成本上升 (`src/sim/network.ts:54`) — **Mitigation**: 索引只在编译时构建一次，且 net 不参与序列化（快照只带 reactor states）；单步成本实测下降 33%。
4. **Objection**: `cloneNetworkState` 手工浅拷贝可能漏字段，导致预测与实时状态分叉 (`src/sim/networkEngine.ts:1090`) — **Mitigation**: 与 `structuredClone` 做等价性断言（既有「预测不污染实时状态」测试 + network.test 全套通过）；新增字段若遗漏会被该测试捕获。
5. **Objection**: 删除 `legacyModel` 后仍有测试引用 (`src/sim/plantModel.ts:119`) — **Mitigation**: `rg legacyModel src tests scripts` 只剩一处注释；相关测试已改跑 `networkModel`，全量 708 项通过。
6. **Objection**: `PLANT.tanks` 删除后参考引擎几何来自拓扑，两引擎几何可能不再独立 (`src/sim/config.ts:28`) — **Mitigation**: 参考引擎仅用于 cross-engine 对照，共享几何正是本轮要消除的重复；对照测试改为比较响应方向而非绝对值（既有设计）。

7. **Objection**: 删除 `aerationOn` / `pumpSpeed` 后编辑器的单元库少了两个"能力" (`src/model/topology.ts:90`) — **Mitigation**: 这两个键从来不在 `ControlSettings`/`CONTROL_BOUNDS` 里、检视器只能按名过滤，保留只会让界面宣布不可写的控件；`tests/interventions.test.ts` 断言每个声明都可写，四个调色板分组不受影响。

## Verification (2026-10-27)

| check | command | result |
|---|---|---|
| full | `npx vitest run` | 720 passed / 56 files |
| coverage | `npx vitest run --coverage` | lines 92.83 / branches 82.16 / functions 96.32 / statements 94.58 |
| types | `npx tsc --noEmit` + `--noUnusedLocals --noUnusedParameters` | 0 |
| lint | `npx eslint src tests` | 0 |
| format | `npm run format` | clean |
| build | `npm run build` | client + server OK |
| e2e | `npm run e2e` | PASS 7 KPIs / 17 nodes / 3 charts / 6 panels / 0 console errors |

### Performance (same machine, `npx tsx` micro-benchmarks)

| metric | before | after | delta |
|---|---|---|---|
| single step (production engine) | 0.01746 ms | 0.01176 ms | −33% |
| 4 h forecast | ~1.4 ms | 3.15 ms* | (*different horizon sampling; see note) |
| decision, nominal | 142.5 ms | 104.7 ms | −27% |
| decision, robust | 199.4 ms | 134.9 ms | −32% |
| 30-day warm-up | 495 ms | 390 ms | −21% |

Note: the 4 h forecast figure is measured with `networkModel.predict(controls, 240, 30)` and now includes the shared-forcing path; the earlier README figure came from `scripts/bench.ts` before the refactor.

### Dead code removed

`legacyModel` (plantModel), `unitsByKind`, `neighboringUnits`, `createShadowBenchmark`, `looksLikeCommand`,
`commandNeedsOpenPermission`, `AGENT_CAPABILITIES`, `summarizeForLog`, `permissionLabel`, `capabilitiesFor`,
`unitIcons.ts`, `state.edgeFlows`, `CompiledReactor.inlets/receives*`, `PLANT.tanks`, `BIO_VOLUME`,
`AEROBIC_VOLUME`, `TankConfig`/`TankKind` (config), plus 2 stale comments.

### Duplication removed

- forcing: 5 copies → `src/sim/forcing.ts`
- alarm rules: 2 copies → `src/sim/alarmRules.ts`
- stream/unit metadata: 3 copies → `src/shared/streamMeta.ts`
- clock formatting: 8 copies → `src/shared/time.ts`
- tariffs: 2 copies → `TARIFF` in `kinetics.ts`
- plant geometry: 2 copies → derived from topology
- per-tick derived values (alarms/margins/health/attribution): 2–3 calls → 1 each

### Theoretical audit (quantified, reproducible)

The audit below is the "从底层找出问题" deliverable; each finding names the file and the measured number.

| # | Finding | Evidence | Classification |
|---|---|---|---|
| T1 | Nitrification rate constant is ~420× the ASM1 value, compensated by a biomass factor | `KINETICS.kNit=14 /h` vs `ASM1_PARAMS.mu_A/24≈0.033 /h`; `bf = xBiomass/DESIGN_MLSS` | calibration debt, not a bug |
| T2 | Effluent TN can exceed the 15 mg/L limit at default control | measured 15.40 mg/L (seed 7, 30 d) — alarm fires | model calibration, not code |
| T3 | **Fixed**: NO3 production used a fixed 0.88 factor, so 12 % of nitrified nitrogen vanished | `networkEngine.ts` / `engine.ts` | replaced by `KINETICS.nitrateYieldPerNitrifiedN = 1.0` with kDen retuned 4.6 → 8.0; TN 15.40 → 11.18 mg/L, N removal 65 % → 75 %, `tests/nitrogenBalance.test.ts` locks it |
| T4 | All tanks report the plant-average MLSS | `src/server/index.ts:212` and `buildPatch` | simplified state; real plants differ per zone |
| T5 | ASM1 and simple modes expose two different TP definitions behind one field | simple: 0.010; asm1: 2.509 | mode-dependent semantics |
| T6 | Takács thickening zone collapses to ~4 distinct values | profile `8,13,22,53,254,258,259,260,259,5474` | known limiter; documented in roadmap §18 |
| T7 | Clarifier solids balance residual 1.5 % (steady state) | measured in/out 7020 vs 6917 kg/h | acceptable, documented |
| T8 | Unknown units are validated only at the WebSocket boundary | `sanitizeTopologyInput` | covered by 12-case test |
| T9 | `edgeFlows` was exposed on the state but never read | removed | dead state |
| T10 | `shared/protocol.ts` imported from `server/benchmark` (reverse dependency) | moved `BenchmarkSummary` to protocol | architecture |

### Not done (explicitly out of scope this round)

- Replacing the simplified kinetics with ASM1 as the default production model (requires the settler rewrite T6; roadmap §15/§16 documents the failed attempt and the prerequisites).
- Splitting per-tank MLSS (T4): needs per-reactor particulate state in simple mode.

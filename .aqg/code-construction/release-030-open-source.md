---
task_slug: release-030-open-source
path: plan
created_at: 2026-10-23T17:00:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: null
---

# AQG Code Construction Ledger — release-030-open-source

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 通读 src/sim、src/ai、src/server、src/client 与 tests；既有约定：纯函数优先、协议集中在 shared/protocol.ts、服务端校验集中在 validation.ts、测试用 vitest + jsdom | `src/server/index.ts:111-206`、`src/shared/protocol.ts:31-69`、`tests/agent-production.test.ts:1` | 基线：typecheck 0、lint 0、324 tests passed、build OK、E2E PASS |
| 2. Behavior Lock | yes | 新增测试覆盖：趋势游标不丢点/不重复、集成预测分位单调、鲁棒决策超标概率、双跑基准计数、CSV 转义、LLM 适配器降级、工艺模板可运行（covers: R1, R2, R3, R4, R5, R6, R7, R8） | `tests/release030.test.ts`（20 项）、`tests/components.test.tsx`（新增 3 项） | 真实测试文件与行号：`tests/release030.test.ts:1`（先写失败断言再实现）；`tests/components.test.tsx:131`（面板渲染）； |
| 3. Thin Slice | yes | 每个切片只改一条链路：先修数据口径与趋势推送，再加集成预测/鲁棒决策，再加双跑与导出，最后加 LLM 适配层与 UI | `src/server/index.ts`、`src/sim/ensemble.ts`、`src/server/benchmark.ts` | 不重写引擎物理、不引入运行时依赖（LLM 用内置 fetch） |
| 4. Construction Rules | yes | YAGNI：分位数/CSV/报告写成纯函数；LLM 适配层用 OpenAI 兼容协议而非 SDK；模板复用 PLANT_TOPOLOGY 克隆而非新建 DSL | `src/sim/ensemble.ts`、`src/server/export.ts`、`src/ai/llm.ts` | 运行时依赖仍为 4 个 |
| 5. Local Verification | yes | typecheck / lint / prettier / 全量测试 + 覆盖率 / build / E2E / 真实 HTTP 探针 / 生产冒烟 | `scripts/ci-gate.sh:1` | 见收尾验证记录；`npm run ci` 全绿 |
| 6. Self Review (5 axes) | yes | 正确性：累计量改为积分而非当前流量乘时间；可读性：新能力各自单文件；架构：协议单向依赖；安全：LLM 密钥只读环境变量、不落日志；性能：鲁棒样本默认 3、决策仍 <200ms | `src/server/index.ts`、`src/ai/llm.ts` | 人工复核 diff + 基准脚本 |

## Behavior Contract

### R1: Incremental trend patches never drop or duplicate points
The server MUST send each trend point to a connected client exactly once, even after the ring buffer reaches capacity.

- Scenario S1.1: buffer full
  - GIVEN a client connected for more than 720 trend points
  - WHEN a new trend point is produced
  - THEN the patch contains exactly the new point

### R2: Ensemble forecast bands are ordered
The ensemble forecast MUST return p10 <= p50 <= p90 for every sampled minute.

- Scenario S2.1: normal operation
  - GIVEN a plant state and controls
  - WHEN the ensemble forecast runs
  - THEN every metric satisfies p10 <= p50 <= p90

### R3: Robust decision reports exceedance probability
The decision layer SHALL report a 0-1 exceedance probability when robustness is enabled.

- Scenario S3.1: storm scenario
  - GIVEN robust decision enabled
  - WHEN a recommendation is produced
  - THEN exceedanceProbability is within [0,1]

### R4: Shadow benchmark counts both strategies
The server MUST accumulate AI and fixed-manual benchmark counters from the same influent realization.

- Scenario S4.1: ten ticks
  - GIVEN a running shadow benchmark
  - WHEN ten ticks are stepped
  - THEN both sample counters equal ten

### R5: CSV export escapes commas and quotes
The export layer MUST quote fields containing commas, quotes or newlines.

- Scenario S5.1: summary with comma
  - GIVEN a decision summary containing a comma
  - WHEN exported to CSV
  - THEN the field is wrapped in quotes with internal quotes doubled

### R6: LLM adapter degrades to the rule engine
The chat path MUST return a rule-based answer when the LLM endpoint is not configured or fails.

- Scenario S6.1: endpoint down
  - GIVEN an LLM endpoint that rejects
  - WHEN a user asks a question
  - THEN the response still contains a grounded answer

### R7: Every shipped topology preset is runnable
Each preset MUST pass readiness and compile into a solvable network.

- Scenario S7.1: preset list
  - GIVEN the shipped presets
  - WHEN each is compiled and spun up
  - THEN readiness is true and effluent values are finite

### R8: Cost totals use integrated quantities
The snapshot MUST report cumulative inflow, energy and waste from integration, not current-rate extrapolation.

- Scenario S8.1: variable flow
  - GIVEN two ticks with different flow
  - WHEN the snapshot is built
  - THEN inflowM3 equals the sum of flow x dt

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W6: package.json dep/entry change | yes | 只改 version 0.3.0 / private / 新增 media 与 benchmark:prove 两个 npm script，未新增依赖；LLM 适配层用内置 fetch |
| W7: large diff | yes | 0.3.0 release: new modules + tests + docs + media; reviewed file by file |
| W8: docs changed | yes | README/docs/CHANGELOG updated to measured facts |

## Predicted Objections

1. **Objection**: 鲁棒决策会增加每次决策耗时，可能拖慢 1 Hz tick (`src/ai/agent.ts:272`) — **Mitigation**: 仅对前 5 个候选做 3 样本集成，`scripts/bench.ts` 记录决策耗时；超过预算则退回单点评分。
2. **Objection**: 双跑基准会与主仿真的随机序列漂移 (`src/server/benchmark.ts:1`) — **Mitigation**: 影子状态与主状态同 seed、同 rngCount、同步推进；测试断言两条链的进水序列一致。
3. **Objection**: LLM 可能编造数字 (`src/ai/llm.ts:1`) — **Mitigation**: 系统提示要求只引用给定 JSON，且回答后做数字白名单校验；失败即降级到规则引擎。
4. **Objection**: 新增 API 导出可能泄露数据 (`src/server/index.ts:887`) — **Mitigation**: 沿用统一鉴权；CSV 只含仿真数据，不含令牌；测试覆盖 401。
5. **Objection**: 模板拓扑可能不可运行 (`src/model/presets.ts:1`) — **Mitigation**: 每个模板在测试中跑 readiness + compile + 3 天预热，不通过即失败。

## Round 2 — alarm attribution and health (post-review)

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 复用 `estimateMargin` 的排序口径与 `metrics` 的纯函数风格；告警 code 沿用引擎已有 `EFF_*` / `DO_LOW` / `SLUDGE_BLANKET` / `SRT_LOW` | `src/sim/metrics.ts:50`、`src/sim/networkEngine.ts:920` | 读取 8 个告警产生点，确认无新增传感器假设 |
| 2. Behavior Lock | yes | 新增 15 项归因/健康度测试 + 5 项 AuthGate 令牌生命周期测试 + 3 项组件测试（covers: R9, R10） | `tests/alarmAttribution.test.ts:1`、`tests/authGate.test.tsx:1`、`tests/components.test.tsx:155` | 先写失败断言（`getByText(/保存的令牌已失效/)` 在旧实现下失败） |
| 3. Thin Slice | yes | 归因/健康度写成 `src/sim/alarmAttribution.ts` 纯函数；服务端只组装，前端只渲染 | `src/sim/alarmAttribution.ts:1` | 未改引擎物理、未新增依赖 |
| 4. Construction Rules | yes | 未知告警返回 null；趋势点不足不写外推；毒性优先于低 DO 归因 | `src/sim/alarmAttribution.ts:59` | 测试覆盖未知 code 与点数不足 |
| 5. Local Verification | yes | typecheck / lint / format / 370 tests / coverage / build / E2E / ci-gate | `scripts/ci-gate.sh:1` | 全绿；E2E 新增健康度胶囊与 5 个分项断言 |
| 6. Self Review (5 axes) | yes | 正确性：归因只用快照内量；可读性：原因/动作/后果三段；安全：无新输入面；性能：每次快照一次纯函数 | `src/sim/alarmAttribution.ts`、`src/client/components/AlarmsPanel.tsx` | 毒性场景实测：归因到「生物活性下降 75%」 |

### R9: Alarm attribution never fabricates a cause
The system MUST return no attribution for an unknown alarm code.

- Scenario S9.1: unknown code
  - GIVEN an alarm code outside the eight known ones
  - WHEN attribution runs
  - THEN the result is null and the raw alarm is still shown

### R10: Stored token must be verified before entering the app
The client SHALL verify a stored token against `/api/snapshot` before rendering the control room.

- Scenario S10.1: rotated token
  - GIVEN a stale token in sessionStorage
  - WHEN the app boots
  - THEN the token is cleared and the login prompt returns with an explanation

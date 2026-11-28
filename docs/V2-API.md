# AquaPilot V2 Rust 服务 API

> 版本 0.0.19。状态（2026-11-28）：`aquapilot-service` 已落地 HTTP + SSE、SQLite 持久实验队列、幂等、取消/恢复、CSV/Markdown 报告、OpenAPI 3.1、同源可视化编排台（`GET /`、`GET /api/v1/presets`）、ASM1 自由拓扑校验（`POST /api/v1/topologies/validate`），以及出水评分卡、告警、日/周聚合、五条角色旅程与自由拓扑验收旅程。代表性端到端矩阵 11/11 通过（`docs/coverage-matrix.json`），五条旅程 5/5 通过（`docs/journeys-v2.json`）；0.0.14 的 wall-clock 24 h soak 在 17 分钟处被执行环境重启打断，`docs/soak-24h-summary.json` 未生成，不能算完成；60 s smoke 见 `docs/soak-smoke-summary.json`。9 个 preset 覆盖 ASM2d 整厂、ASM2d 双系列、ASM1、ADM1 与泥线；`asm2d-parallel` 配置为 `{name,trains[]}`，每个系列独立二沉池/RAS/WAS，结果按总流量汇总。0.0.17 增加模拟工业网关（OPC UA/Modbus/MQTT 点位、写入与 SHA-256 审计链）、可选 Bearer + RBAC、按主体限流、本地 evidence AI 解读与队列看门狗；详见 `docs/V2-INDUSTRIAL.md`。0.0.19 增加 ADM1/泥线/闭环的长模型运行中取消，以及旧版只读别名 `/api/auth-required`、`/api/standards`、`/api/limits`；健康响应同时带旧字段。OpenAPI 22 paths。0.0.20–0.0.22 增加批量研究、旧版只读迁移层、远程 OpenAI-compatible AI Provider、MCP stdio 工具桥；仍不包含真实 PLC 连接与 WebSocket；实时推送使用 SSE，单进程单 worker。Cutover 判定见 `docs/CUTOVER.md`。

## 启动

```bash
cd rust-v2
cargo run -q -p aquapilot-cli -- serve \
  --bind 127.0.0.1:5173 \
  --db ./aquapilot.sqlite \
  --queue-capacity 32
```

等价于构建后运行 `aquapilot-v2 serve ...`。SQLite 是唯一持久化状态；进程重启时，`running` 实验会重新入队，已请求取消的实验直接标记 `cancelled`。

## 实验请求

`POST /api/v1/experiments`，`Content-Type: application/json`，请求体上限 64 KiB。`Idempotency-Key` 可选；同 key 同 body 返回 `200` 和原资源，同 key 不同 body 返回 `409 IDEMPOTENCY_KEY_REUSED`。首次创建返回 `202` 和 `Location`。

```json
{
  "name": "a2o-30d",
  "model": "asm2d",
  "config": { "...": "model-specific config object" },
  "duration_min": 43200,
  "dt_min": 1,
  "sample_every_min": 360
}
```

`model` 取值：

| 值 | `config` 类型 | 执行函数 |
| --- | --- | --- |
| `asm1` | `PlantTopology` | `aquapilot_engine::Simulator` 分步 |
| `asm2d` | `Asm2dPlantConfig` | `Asm2dSimulator` 分步 |
| `asm2d-adm1-loop` | `{ "plant": Asm2dPlantConfig, "sludge"?: Asm2dSludgeConfig }` | `simulate_asm2d_adm1_loop` |
| `adm1` | `Adm1Config` | `simulate_adm1` |
| `sludge-line` | `SludgeLineConfig` | `simulate_sludge_line` |

顶层可选字段：`duration_min` 默认 1440，范围 1–525600；`dt_min` 默认 1，范围 (0,1]；`sample_every_min` 默认 60；`sludge_days` 默认 30，范围 (0,3650]；`sludge_dt_days` 默认 0.002，必须为正；`max_iterations` 和 `relaxation` 只对 `asm2d-adm1-loop` 生效，并覆盖 `config` 内的同名值。

为防止单 worker 被一条请求拖死，服务在 422 校验阶段限制：`duration_min / dt_min` 和 `max(sludge_days, duration_min/1440) / sludge_dt_days` 均不超过 5,000,000 个积分步；`duration_min / sample_every_min` 不超过 1,000,000 个采样点；`max_iterations` 为 0（默认）或不超过 64；`relaxation` 为 0（默认）或位于 [0,1]。

`asm2d-adm1-loop` 可以省略 `sludge`，服务使用 `Asm2dSludgeConfig::default()`；`plant` 必填。`adm1`/`sludge-line` 的 `duration_min` 会换算为天。

## 端点

| Method | Path | 语义 |
| --- | --- | --- |
| `GET` | `/` | 同源单文件工艺编排台（HTML） |
| `GET` | `/api/health` | 队列深度、容量、版本、uptime |
| `GET` | `/api/openapi.json` | OpenAPI 3.1.0 |
| `GET` | `/api/v1/presets` | 8 个内嵌场景预设与完整 model config |
| `POST` | `/api/v1/topologies/validate` | 编译 ASM1 `PlantTopology`，返回节点/连接/反应器/二沉池/出水流量；不落库 |
| `POST` | `/api/v1/experiments` | 入队，`202`；幂等重放 `200` |
| `GET` | `/api/v1/experiments` | `status`、`limit`、`cursor` 分页 |
| `GET` | `/api/v1/experiments/{id}` | 详情；成功时含 `result` 快照 |
| `POST` | `/api/v1/experiments/{id}/cancel` | 取消 queued，或给 running 设取消标记 |
| `GET` | `/api/v1/experiments/{id}/events` | SSE 状态流，每 0.5 s 一帧，终态后关闭 |
| `GET` | `/api/v1/experiments/{id}/samples.csv` | 成功实验的原始采样序列 |
| `GET` | `/api/v1/experiments/{id}/daily.csv` | 按 1440 min 聚合的日均值 |
| `GET` | `/api/v1/experiments/{id}/weekly.csv` | 按 10080 min 聚合的周均值 |
| `GET` | `/api/v1/experiments/{id}/report.md` | 成功实验的 Markdown 报告（含评分卡、告警、日/周汇总） |

### ASM1 自由拓扑校验

`POST /api/v1/topologies/validate` 接收完整 `PlantTopology`（`name`、`units`、`connections`、`metadata`），只编译、不创建实验。成功 `200`：

```json
{
  "valid": true,
  "name": "three-stage",
  "units": 5,
  "connections": 4,
  "reactors": 3,
  "clarifiers": 0,
  "influent_flow_m3_h": 1000.0,
  "effluent_flow_m3_h": 1000.0
}
```

失败返回 `422 application/problem+json`，`code=VALIDATION_FAILED`，`errors[0].code=TOPOLOGY_INVALID`，`detail` 是具体编译错误（例如 `reactor aer has no incoming stream`）。编译检查包括：恰好一个进水/出水、waste ≤ 1、每条连接显式正流量、反应器必须有入流、二沉池恰好一个反应器进料且有溢流/底流路由、全厂流量闭合、回流方向限制、非回流边不得成环。

当前 `GET /api/v1/presets` 的 ASM1 预设：

- `bsm1`：官方 BSM1，9 units / 10 connections，含 RAS 与内回流；
- `asm1-three-stage`：厌氧/缺氧/好氧三池，无二沉池；
- `asm1-single`：单好氧池，最小自由拓扑。

状态：`queued → running → succeeded | failed | cancelled`；running 且已请求取消时，详情里的展示状态是 `cancelling`，数据库仍是 running，worker 在下一个检查点收口。

### 可视化编排台

`GET /` 直接返回服务托管的单文件页面；`GET /api/v1/presets` 返回内嵌预设。页面与 API 同源，不需要 Node 构建链。可视化层对 `asm2d`、`asm2d-adm1-loop` 展开 A2O 池链，对 `asm1` 展开自由拓扑画布；ADM1、泥线仍用高级 JSON。详细交互与边界见 `docs/V2-UI.md`。

```text
GET /                     HTML 工艺编排台
GET /api/v1/presets       { default, presets: [{ id, label, model, description, config }] }
```

页面能力：8 个 preset；A2O 拖拽改反应器顺序，新增/复制/删除反应器，编辑池型/池容/温度/KLa/DO；二沉池 RAS/WAS、内回流端点与流量（可新增/删除）、PAC（点胶囊进入）、三级过滤（点胶囊进入）、进水边界；高流量、低 DO、冬季、PAC 停加、过滤旁路、厌氧扩容 6 类工况注入；ASM1 自由拓扑画布支持增删节点、编辑节点参数、增删连接与回流边；高级 JSON 导入导出；SSE 实验监看、队列、出水趋势、三本账、出水评分卡/告警、日汇总/周汇总 CSV 和 Markdown 报告下载。

### SSE

```
GET /api/v1/experiments/{id}/events
Accept: text/event-stream
```

事件名 `experiment`，data 是实验摘要 JSON；终态后服务端关闭。未知 id 返回 404，不会建立流。

### 错误

所有非 2xx 使用 RFC 9457 `application/problem+json`：

```json
{
  "type": "urn:aquapilot:problem:QUEUE_FULL",
  "title": "Experiment queue is full",
  "status": 429,
  "detail": "queued and running experiments exceed the configured capacity",
  "instance": "urn:aquapilot:request",
  "code": "QUEUE_FULL"
}
```

主要 code：`MALFORMED_JSON`、`VALIDATION_FAILED`、`IDEMPOTENCY_KEY_REUSED`、`QUEUE_FULL`、`EXPERIMENT_NOT_FOUND`、`EXPERIMENT_NOT_SUCCEEDED`、`EXPERIMENT_TERMINAL`、`UNSUPPORTED_MEDIA_TYPE`。队列满时带 `Retry-After: 30`。

## 示例

ASM1：

```bash
jq -n --argjson config "$(cat fixtures/bsm1-official.json)" \
  '{name:"bsm1-30d",model:"asm1",config:$config,duration_min:43200,dt_min:1,sample_every_min:360}' \
  > /tmp/asm1-request.json
curl -sS -X POST http://127.0.0.1:5173/api/v1/experiments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bsm1-30d' \
  --data-binary @/tmp/asm1-request.json
```

ASM2d/ADM1 回流闭环：

```bash
jq -n --argjson plant "$(cat fixtures/a2o-asm2d-pac-tertiary.json)" \
  '{name:"a2o-loop-30d",model:"asm2d-adm1-loop",
    config:{plant:$plant},duration_min:43200,dt_min:1,
    sludge_days:30,sludge_dt_days:0.002,max_iterations:6,relaxation:0.5}' \
  > /tmp/loop-request.json
curl -sS -X POST http://127.0.0.1:5173/api/v1/experiments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: a2o-loop-30d' \
  --data-binary @/tmp/loop-request.json
```

## 备份与恢复

```bash
cd rust-v2
cargo run -q -p aquapilot-cli -- backup \
  --db ./aquapilot.sqlite \
  --out ./backup/aquapilot-$(date +%Y%m%d).sqlite
```

`backup` 使用 SQLite `VACUUM INTO` 写一致快照，包含 WAL 中已提交的事务；目标已存在时需 `--force`。恢复时把快照复制为新的 `--db` 路径再 `serve`，不要直接覆盖运行中的数据库。

## 持久化与恢复

SQLite 表 `experiments` 保存 spec、状态、进度、结果、采样和 idempotency 哈希；原始 idempotency token 不落库。`Store::recover()` 在启动时：

- `running` + `cancel_requested=1` → `cancelled`；
- `running` + `cancel_requested=0` → `queued`，从头重跑。

已验证：365 天 ASM2d 实验运行中终止进程，重启后自动重新入队并跑完；已完成实验在重启后仍可读取结果、CSV 和报告。

## 取消语义

- `queued`：立即 `cancelled`。
- `running` + ASM1/ASM2d：每一步检查取消标记，通常在下一步内收口。
- `running` + `asm2d-adm1-loop`/`adm1`/`sludge-line`：模型函数是整体调用，只能在当前运行结束后收口；API 会先显示 `cancelling`，不会假装已经停止。
- `succeeded`/`failed`/`cancelled`：`409 EXPERIMENT_TERMINAL`。

## 采样与报告

`asm1`/`asm2d` 按 `sample_every_min` 收集时间序列；`asm2d-adm1-loop`/`adm1`/`sludge-line` 目前只写最终状态一行。CSV 列为：

```
minute,flow_m3_h,cod_mg_l,bod_mg_l,ss_mg_l,nh4_n_mg_l,tn_mg_l,tp_mg_l,
po4_p_mg_l,ph,temperature_c,do_mg_l,mlss_mg_l,srt_d,energy_kw,score,blanket_depth_m
```

BOD、pH、温度、MLSS、SRT、能耗、评分、泥毯厚度在当前 V2 模型中多数未建模，CSV 留空；这不是 0 值。报告汇总最终出水、三本账、请求 spec，并附出水评分卡、告警、日/周汇总和数据质量；不伪造未建模指标。

### 结果分析层（0.0.8 / 0.0.13 / 0.0.21）

`detail` 在 `include_result=true`（默认）时带 `analysis`：

- `applicability`：`effluent_compliance` 或 `process_only`；ASM1 检查 COD/SS/NH4-N/TN 四项，ASM2d 与 loop 再加 TP/PO4-P，ADM1/泥线不冒充出水合规。
- `scorecard`：`grade` A/B/C/D/N/A、`score`、`passed`/`total`、各项 `limit`/`value`/`passed`、`mass_balance_closed`。等级只基于出水指标，不把短时三本账包装成达标。
- `inventory`（0.0.21）：`time_min`、`total_cod_kg`、`total_nitrogen_kg`、`total_phosphorus_kg`、`total_mlss_kg` 与逐池 `reactors[]`；由 `C × V / 1000` 从反应器状态推导，MLSS 缺失时回退 `ss`。`note` 明确只含反应器，不含二沉池/三级过滤固体，不是整厂库存证明。
- `alarms`：`EFFLUENT_*_HIGH`、`LOW_DO`、`MASS_BALANCE_OPEN`、`NO_SAMPLES`、`SPARSE_SAMPLES`、`NONFINITE_SAMPLE`。`LOW_DO` 只看 60 min 之后的样本，避免启动瞬时 0 DO 误报。0.0.13 起每条告警还带 `evidence[]`（实测证据）、`possible_causes[]`（可能原因）与 `recommended_actions[]`（建议动作）；三者均可为空，旧客户端仍可只读 `code`/`message`。
- `data_quality`：样本数、有限值数、重复分钟数、缺失可选字段。
- `daily`/`weekly`：周期边界样本归入刚结束的周期，7 d 实验得到 7 个日桶 + 1 个周桶，不生成“只有一个末点”的第 8 天/第 2 周。`daily.csv`/`weekly.csv` 是派生聚合，不覆盖 `samples.csv` 原始数据。

对 `asm2d-adm1-loop`/`adm1`/`sludge-line`，采样器当前只有最终状态一行，日/周聚合只是终态单桶，并会触发 `SPARSE_SAMPLES`；不能把这些桶当趋势。

### ASM1 自由拓扑验收（0.0.9）

```bash
python3 scripts/topology_journey.py --base http://127.0.0.1:5173 \
  --summary docs/topology-journey.json
```

结果（`docs/topology-journey.json`）：3 个 ASM1 预设全部 `200` 编译；把三池预设删除厌氧节点、补一条 `in → anx 1000 m³/h` 连接后，得到 4 units / 3 connections / 2 reactors 并编译成功；提交 1 d 实验后 `succeeded`，评分卡严格按 ASM1 四项打分（D、1/4），触发 `EFFLUENT_COD_HIGH`、`EFFLUENT_SS_HIGH`、`EFFLUENT_TN_HIGH`。该结果说明“无二沉池”的拓扑会如实表现悬浮固体穿透，不被评分卡掩盖。`completed_24h=false`，这不是 24 h soak。

## Soak

```bash
python3 scripts/soak_v2.py --duration 86400 --interval 30
```

脚本启动独立服务、按间隔提交短 ASM1 实验、采样 RSS/fd/健康检查，最后写 `summary.json`。默认 60 s 是 smoke，不是 24 h 验收；`completed_24h` 字段会明确为 `false`。

正式 24 h 验收应把 summary 单独落盘并保留数据库：

```bash
python3 scripts/soak_v2.py --duration 86400 --interval 30 \
  --summary docs/soak-24h-summary.json --keep-db
```

只有实际跑满 24 h 且 `completed_24h=true`，才算通过 V2-3 的 soak 门。

### 代表性端到端矩阵

在不能维持跨会话 24 h 后台进程的环境里，用同一服务 API 做“以小见大”的链路覆盖，不替代 wall-clock 24 h，但能提前证明每条模型/工况分支都通：

```bash
python3 scripts/coverage_v2.py --summary docs/coverage-matrix.json
```

结果（`docs/coverage-matrix.json`）：11/11 通过，95.938 s；覆盖 `asm1`、`asm2d`、`asm2d-adm1-loop`、`adm1`、`sludge-line` 五个模型，以及 A2O 基础、PAC + 三级过滤、高流量、低 DO、冬季、PAC 停加、过滤旁路 7 个工况组合。每个 case 都检查 `202` 入队、终态、detail、`samples.csv`、`report.md`，有 `mass_balance`/`whole_balance` 的模型还检查残差 ≤ 5%。loop 30 天单例 74.65 s，最大残差 2.85%。`completed_24h` 仍为 `false`。

### 五条角色旅程（0.0.8）

```bash
python3 scripts/journeys_v2.py --summary docs/journeys-v2.json
```

结果（`docs/journeys-v2.json`）：5/5 通过，总耗时约 3.3 s，仍明确 `completed_24h=false`。

| 旅程 | 证据 |
| --- | --- |
| 暴雨 1500 m³/h 24 h | 202 → succeeded，出水流量 1480 m³/h，六项出水有限且非负 |
| 风机故障/KLa=0 | succeeded，触发 `LOW_DO`，同时给出六项 `EFFLUENT_*_HIGH`，没有 NaN |
| 三级过滤开/关 what-if | 30 d 出水 TP：开 0.1496 vs 关 1.0430 mg/L |
| 7 d 周报 | `daily` 7 行、`weekly` 1 行；`daily.csv`/`weekly.csv` 200；报告含评分卡/告警/日周/数据质量 |
| 脏数据 | 400 `MALFORMED_JSON` + problem+json、422 校验、409 幂等冲突、404、415 |

旅程只证明角色路径和错误路径通，不替代 24 h soak，也不把三级过滤当真实滤池标定。

### 0.0.19 取消与旧版只读别名

长模型 `adm1`、`sludge-line`、`asm2d-adm1-loop` 现在都接收同一取消信号：ADM1 每个外层积分步、闭环每次迭代/每步检查 `cancel_requested`，命中即返回 `RunError::Cancelled`，worker 落 `cancelled`，不会把半截状态写成成功。活动实验 `745ccd30-d674-4a18-8e14-2ed55b67171d` 在 `running`、progress 0.05 时取消，终态 `cancelled`。

为旧监控/脚本补三个只读别名（不改变 v1 实验契约）：

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/auth-required` | `{required: bool}` |
| GET | `/api/standards` | 三套排放口径 + `default` |
| GET | `/api/limits` | 一级 A 限值、控制边界、老厂常量 |

`GET /api/health` 同时保留旧字段 `authRequired`、`uptimeSeconds`、`paused`、`tickErrors`、`lastTickMs`，以及 V2 的 `version/status/queue/watchdog`。这组别名只覆盖只读监控子集；0.0.20 新增 `/api/snapshot`、`/api/topology` 的派生只读迁移层（`compatibility.liveTick=false`），WebSocket 仍未迁移，详见 `docs/CUTOVER.md`。

### 0.0.20 批量研究 + 只读迁移层

`POST /api/v1/studies` 现在是一等入口：持久 study 父记录 + 整批原子入队，变体支持 `config`、RFC 7396 `config_patch` 或 `controls`（DO/内回流/RAS/WAS/PAC）。容量不足整批 429；旧版 `ExperimentSpec` 中 V2 无法兑现的 `scenario/warmupDays/plantEnabled` 等字段返回 422 `UNSUPPORTED_FIELD`，不静默忽略。

```json
{
  "name": "do-scan",
  "base": {"model": "asm2d", "duration_min": 1440},
  "variants": [
    {"name": "do-2", "controls": {"do_setpoint": 2.0}},
    {"name": "do-1", "controls": {"do_setpoint": 1.0}}
  ],
  "objectives": [{"metric": "effluent.cod", "direction": "min"}]
}
```

只读迁移层：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/snapshot` | 最新成功实验的旧版字段投影；`compatibility.liveTick=false` |
| GET | `/api/topology` | 最新实验请求配置翻译成旧 topology 形状 |
| GET | `/api/metrics` | Prometheus 文本子集，不是旧版按路由计数器 |
| GET | `/api/history/snapshots` | 成功实验历史投影 |

没有成功实验时 snapshot/topology 返回 503 `NO_BASELINE`。能量、SRT、F/M 不存于 V2 结果，返回 `null` 并列在 `compatibility.missing`；不要把它们当 live 控制值。


### 0.0.22 远程 AI 与 MCP

- `GET /api/v1/ai/status`：返回 `provider/model/mode/remote_configured/fallback`；key 永不出现在响应。
- `POST /api/v1/ai/explain`：配置 `AQUAPILOT_AI_BASE_URL` 后调用 OpenAI-compatible `/chat/completions`；远端失败回退本地规则，响应带 `degraded` 与 `provider_error`。
- MCP stdio：`aquapilot-v2 mcp --api http://127.0.0.1:5173 [--token ...]`；提供 6 个工具，`tools/call` 的 `run_experiment` 直接桥接 `POST /api/v1/experiments`，走同一队列与幂等键。证据 `docs/V2-0.0.22.md`、`docs/cutover/mcp-0.0.22-tools.json`。

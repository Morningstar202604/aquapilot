# AquaPilot V2 Rust 服务 API

> 版本 0.0.6。状态（2026-11-28）：`aquapilot-service` 已落地 HTTP + SSE、SQLite 持久实验队列、幂等、取消/恢复、CSV/Markdown 报告和 OpenAPI 3.1。24 h soak 尚未执行；60 s smoke 已通过，见 `docs/soak-smoke-summary.json`。首版不包含 Bearer 角色鉴权、MCP 或 WebSocket；实时推送使用 SSE，单进程单 worker。

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
| `GET` | `/api/health` | 队列深度、容量、uptime |
| `GET` | `/api/openapi.json` | OpenAPI 3.1.0 |
| `POST` | `/api/v1/experiments` | 入队，`202`；幂等重放 `200` |
| `GET` | `/api/v1/experiments` | `status`、`limit`、`cursor` 分页 |
| `GET` | `/api/v1/experiments/{id}` | 详情；成功时含 `result` 快照 |
| `POST` | `/api/v1/experiments/{id}/cancel` | 取消 queued，或给 running 设取消标记 |
| `GET` | `/api/v1/experiments/{id}/events` | SSE 状态流，每 0.5 s 一帧，终态后关闭 |
| `GET` | `/api/v1/experiments/{id}/samples.csv` | 成功实验的采样序列 |
| `GET` | `/api/v1/experiments/{id}/report.md` | 成功实验的 Markdown 报告 |

状态：`queued → running → succeeded | failed | cancelled`；running 且已请求取消时，详情里的展示状态是 `cancelling`，数据库仍是 running，worker 在下一个检查点收口。

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

BOD、pH、温度、MLSS、SRT、能耗、评分、泥毯厚度在当前 V2 模型中多数未建模，CSV 留空；这不是 0 值。报告只汇总最终出水、三本账和请求 spec，不伪造未建模指标。

## Soak

```bash
python3 scripts/soak_v2.py --duration 86400 --interval 30
```

脚本启动独立服务、按间隔提交短 ASM1 实验、采样 RSS/fd/健康检查，最后写 `docs/soak-smoke-summary.json`。默认 60 s 是 smoke，不是 24 h 验收；`completed_24h` 字段会明确为 `false`。

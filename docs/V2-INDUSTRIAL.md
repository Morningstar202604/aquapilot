# V2 工业网关、鉴权与 AI 解读

> 版本 0.0.17。本文描述的是**模拟适配层**：服务不连接真实 PLC、不打开 OPC UA/Modbus/MQTT 现场端口；它提供与网关一致的点位、写入、审计和健康形状，供 UI、审计链和后续适配器复用。AI 解读是本地证据提供者，不调用外部大模型。

## 1. 点位与适配器

`GET /api/v1/industrial/points` 返回 10 个点位，7 个可写设定点、3 个只读仪表：

| 点位 | 单位 | 适配器 | 范围 | 写 |
|---|---|---|---|---|
| `influent.flow` | m³/h | Modbus TCP | 200–3000 | 是 |
| `aerobic.do` | mg/L | OPC UA | 0–10 | 是 |
| `aerobic.kla` | 1/h | OPC UA | 0–600 | 是 |
| `clarifier.ras` | m³/h | Modbus TCP | 0–2000 | 是 |
| `clarifier.was` | m³/h | Modbus TCP | 0–200 | 是 |
| `pac.dose` | mg/L | OPC UA | 0–200 | 是 |
| `reactor.temperature` | °C | Modbus TCP | 5–40 | 是 |
| `effluent.cod` | mg/L | MQTT | 0–1000 | 否 |
| `effluent.nh4` | mg/L | MQTT | 0–100 | 否 |
| `effluent.tp` | mg/L | MQTT | 0–50 | 否 |

`GET /api/v1/industrial/adapters` 返回三种适配器的 endpoint、`state:"connected"`、`simulated:true` 与点位数。

## 2. 写入与审计链

`POST /api/v1/industrial/write`：

```json
{"point_id":"influent.flow","value":1500,"client_id":"ui-operator","reason":"验收写入"}
```

服务校验点位存在、可写、数值有限且在范围内；只读点返回 409，越界返回 422，未知点返回 404。写入成功后：

1. 更新网关镜像的当前值；
2. 在同一 SQLite 事务里追加 `audit_log`；
3. 返回 `previous_value`、新点位和审计记录。

审计链字段：`seq`、`created_at`、`action`、`actor`、`target`、`previous_value`、`new_value`、`reason`、`previous_hash`、`hash`。`hash = SHA-256(previous_hash|seq|created_at|action|actor|target|old|new|reason)`，第一条 `previous_hash="genesis"`。`GET /api/v1/industrial/audit?limit=N` 按 seq 倒序返回，需要 admin 角色（启用鉴权时）。

## 3. Bearer 与 RBAC

默认单机安装不启用鉴权，`/api/health` 显示 `auth.mode="local-dev"`。设置环境变量后启用：

```bash
AQUAPILOT_TOKENS='reader:viewer,writer:operator,root:admin' \
AQUAPILOT_RATE_LIMIT_PER_MIN=30 \
./aquapilot-v2 serve --bind 127.0.0.1:5173 --db aquapilot.sqlite
```

角色：`viewer` 可读；`operator` 可提交/取消实验、写工业点、调用 AI 解读；`admin` 额外可读审计。缺 token 401（带 `WWW-Authenticate: Bearer`），角色不足 403。写入的审计 `actor` 是 `token:operator` 这类主体，不再信任请求体里的 `client_id`。限流按主体固定 60 s 窗口，超限 429 + `Retry-After`。

## 4. 本地 AI 解读

`POST /api/v1/ai/explain`：

```json
{"experiment_id":"...","question":"最该先处理什么？"}
```

返回 `provider:"local-evidence"`、`model:"rules-v1"`、评分卡、告警、`answer` 和审计记录。实现只读实验分析，不发送实验数据到外部；`answer` 里的每条告警、可能原因、建议动作都来自 `analysis.rs`。这是可替换的 Provider 形状，不是远程模型能力声明。

UI 在评分卡下提供“AI 解读”按钮，结果写入 `ai.explain` 审计；截图 `docs/screenshots/v2-ui-ai-explain.png`。

## 5. 看门狗

后台线程每 5 s 查询最老的 `running` 实验的 `updated_at`；超过 `AQUAPILOT_WATCHDOG_STALE_SECONDS`（默认 300 s）标记 `healthy:false` 并写 warning。`GET /api/health` 和 `GET /api/v1/watchdog` 返回 `healthy/checked_at/stale_after_seconds/oldest_running_seconds`。它不自动杀进程或重启 worker，只把“worker 卡住”变成可观测状态，交给外部 supervisor。

## 6. 验收

- 三个 adapter 均 `connected` 且 `simulated:true`，10 点位、7 可写。
- UI 写入 `influent.flow` 1000→1500 m³/h，审计 #1、`previous_hash=genesis`、64 hex hash；`docs/industrial-adapter-check.json`。
- 5193 鉴权实例：无 token 401、viewer 写 403、operator 写 201 且 actor=`token:operator`、viewer 审计 403、admin 审计 200、同主体窗口内超限 429 + Retry-After；`docs/security-ai-check.json`。
- 1 d ASM2d 实验 `c15e311a-a209-49c7-8524-1ce65ba91729` 评分 A 6/6；AI 解读 `local-evidence`/`rules-v1`，审计 #4；watchdog `healthy:true`。
- UI 截图 `docs/screenshots/v2-ui-industrial-audit.png`、`docs/screenshots/v2-ui-ai-explain.png`。

## 7. 边界

- 不连接真实 PLC；写入只改网关镜像，不影响正在运行的模型实验。
- 没有 WebSocket/MCP；实时推送仍是 SSE。
- 远程 AI Provider 未接入；本地 evidence provider 是可替换的最小实现。
- 看门狗只观测，不自动恢复。

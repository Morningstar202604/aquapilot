# 后端现代化：从实时仿真器到仿真建模软件

本文记录 2026-11-24 这轮后端升级的边界、标准与验收口径。它不是路线图宣传页：
下面每一条都对应仓库中的实现或明确的未完成项。

## 1. 产品定位

AquaPilot 的产品定位收敛为：

> **面向污水处理厂的仿真建模软件。**
> 以可复现的模型/实验为核心，AI 全流程自主编排；用高精度检测、多维度验证与
> 可审计的 provenance，保证稳定、高效、优质的输出。

实时控制室仍是产品入口，但不再是唯一交付：模型、实验、验证报告和 API
才是可被集成、被审计、被复现的部分。

## 2. 这轮补齐的后端核心

### 2.1 可复现实验（`src/sim/experiment.ts`）

一次实验由四件事唯一确定：

1. **拓扑快照**：创建时 `structuredClone` 当前拓扑，后续改厂不影响已排队实验；
2. **显式 spec**：模型（simple/asm1/asm2d）、种子、暖机天数、时长、采样间隔；
3. **边界条件**：场景、控制量、是否开启全厂边界、排放标准；
4. **AI 策略**：`fixed` 固定控制，或 `ai` 让 AI 在实验内闭环决策（有决策数上限）。

结果包含：

- 逐点样本（minute / effluent / DO / MLSS / SRT / energy / score / blanket）；
- 出水统计（min/mean/P50/P95/max）；
- 六项指标逐标准合规行；
- 能耗、药耗、吨水能耗、平均 MLSS、末段 SRT/DO；
- 多维校验：有限性、非负性、采样覆盖、运行合规、三本账、重复性、步长收敛；
- `ExperimentValidation.certified`（模型/数值认证）与
  `operatingCompliant`（本次运行是否达标）分离，避免把“模型可信”误读成“这次一定达标”。

**确定性**：同 spec、同拓扑、同种子重复运行逐点一致；`full` 级别会实际重跑一次并比较。
**边界**：30 天 / 20,000 采样点 / AI 288 次决策；超过即 422，不静默降采样。
**可中断**：`AbortSignal` 在启动前、暖机后和每个仿真日检查；取消不会覆盖结果。

### 2.2 持久队列与恢复（`experimentService.ts` / `experimentStore.ts`）

- 状态机：`queued → running → succeeded | failed | cancelled`；
- 单进程并发上限 2，`queued+running` 合计上限 24（环境变量可调），队满返回 429 + `Retry-After`；
- 同 `Idempotency-Key` + 同请求体返回既有资源；同键不同体返回 409；
- 结果写 SQLite（`experiments` 表，WAL），列表只读 summary，详情才读 samples/topology；
- 进程重启把中断的 `running` 标回 `queued` 并重新执行；仿真确定性使重跑可接受；
- `AQUAPILOT_PERSIST=0` 或 Node 无 `node:sqlite` 时退化为内存队列，服务仍可用。

### 2.3 版本化 API（`src/server/routes/experiments.ts`）

```text
POST   /api/v1/experiments                    创建实验（operator）
GET    /api/v1/experiments                    列表（viewer，keyset cursor）
GET    /api/v1/experiments/{id}               详情（viewer，ETag/304）
POST   /api/v1/experiments/{id}/cancel        取消（operator）
GET    /api/v1/experiments/{id}/samples.csv   逐点样本
GET    /api/v1/experiments/{id}/report.md     可复现 Markdown 报告
GET    /api/openapi.json                      OpenAPI 3.1 契约（公开）
```

- `202 Accepted` + `Location` 表示入队；幂等重放返回 `200`；
- 错误统一 RFC 9457 `application/problem+json`：`type/title/status/detail/instance/code/errors`；
- `ETag` / `If-None-Match`（RFC 9110）；
- 64 KiB 请求体上限、`application/json` 媒体类型校验、控制字符幂等键拒绝；
- 旧 `/api/*` GET 端点保持原行为，避免破坏前端；新能力从 `/api/v1` 开始。

### 2.4 AI 工具总线（`src/server/mcp.ts`）

MCP 2025-06-18 端点新增四个工具：

| 工具 | 语义 |
| --- | --- |
| `create_experiment` | 创建立即返回的资源；不阻塞 MCP 调用，可轮询 |
| `get_experiment` | 读状态、summary、validation、provenance |
| `list_experiments` | 按状态列实验 |
| `cancel_experiment` | 取消排队/运行中的实验 |

写工具要求 operator 角色；读工具 viewer。外部 agent 不再只能跑 1 天的
`simulate_headless`，而是可以编排 30 天、带校验、可取消的完整实验。

### 2.5 CLI（`src/cli.ts`）

```bash
npm run cli -- experiment --minutes 1440 --validation full --standard gb18918-1b
npm run cli -- experiment --days 7 --scenario storm --policy ai --plant --json
```

CLI 与 HTTP/MCP 共用同一 spec/runner/校验；不是第三套逻辑。

## 3. 标准对照

| 领域 | 采用标准 | 状态 |
| --- | --- | --- |
| API 契约 | OpenAPI 3.1.0 / JSON Schema 2020-12 | 已实现，`/api/openapi.json` |
| 错误语义 | RFC 9457 Problem Details | 已实现 |
| HTTP 缓存 | RFC 9110 ETag / If-None-Match | 已实现 |
| 幂等创建 | IETF Idempotency-Key 语义（draft/行业惯例） | 已实现 |
| Agent 工具 | MCP 2025-06-18 Streamable HTTP | 已有端点，本轮扩实验工具 |
| 工艺模型 | IWA ASM1 / ASM2d / BSM1 基准 | 已有；WP2 三本账仍红 |
| 模型互操作 | FMI 3.0 / SSP 1.0 | **未实现**；需要 Rust cdylib 与打包链路，不能假装已支持 |

这张表是“现在到哪”，不是“未来会有什么”。FMI 是下一阶段最值得做的
互操作标准，但它需要真正的 C ABI、模型描述 XML 与跨平台二进制；
在未完成前，本仓库不会在 README 里宣称 FMI 兼容。

## 4. 验证口径

一个实验只有在以下 mandatory checks 全过时，`certified=true`：

- 采样值全 finite；
- 出水浓度非负；
- 采样覆盖达到 `floor(duration/sampleEvery)+1`；
- （`full`）同种子重复运行逐点一致；
- （`plantEnabled`）COD/N/P 三本账闭合。

以下不参与模型认证，但会单独给出：

- `operating.compliance`：本次运行六项指标是否达标（场景实验可能故意失败）；
- `numerics.stepConvergence`：1 min vs 2 min 末端均值相对差 ≤5% 为 pass，>5% 为 warn。

当前 `plantEnabled=true` 的实验会如实返回 `massBalance.closed=fail`，因为
WP2 全厂 COD/N/P 账本尚未闭合。这是**唯一核心红灯**，本轮的 API/队列/校验
没有用 `it.fails`、放宽容差或投影归零去掩盖它。

## 5. 安全与多租户边界

- 单实例、单厂、单租户；`topology` 不通过实验 API 暴露给 viewer；
- 创建/取消需要 operator，历史查询需要 viewer；认证关闭时默认 admin（本地开发）；
- 幂等键只存哈希后的请求体比对值，不存原始令牌；
- 报告与 CSV 只含实验数据，不含环境变量、令牌、数据库路径；
- 实验 spec 的未知字段被 strict schema 拒绝，避免“客户端以为设置了、服务端忽略了”。

## 6. 性能与容量

本机 Node 22、默认 ASM1、5 天暖机：

- 1 天 1 min 步长实验约 0.4–0.5 s；30 天约 15 s；
- `full` 校验约 3 倍成本；`policy=ai` 每次决策约 0.15–0.6 s，受 horizon/candidate budget 影响；
- 队列默认 2 并发、合计 24 个积压，适合单机“提交—轮询—下载”的批量实验，不是 HPC 调度器。

下一步若要跑 100+ 情景的不确定性扫描，应把 worker 从主进程拆出，
再评估 SQLite → PostgreSQL/TimescaleDB；本轮不引入这些重依赖。

## 7. 验收命令

```bash
npm run typecheck
npm run build
npx vitest run tests/experiment.test.ts tests/experimentService.test.ts tests/experimentApi.test.ts
npm run cli -- experiment --minutes 60 --json
curl -s http://127.0.0.1:5173/api/openapi.json | head
```

已知红灯：`tests/plantBoundary.test.ts` 的 WP2 30 天 COD 账本。它不属于
本轮的实验编排/AI 工具/API 改造，也不会被本轮的认证逻辑误判为通过。

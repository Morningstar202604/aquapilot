# M2 服务能力：Rust 侧 AI Provider、审计、限流、看门狗与 HTTP/WS 契约

> 状态：M2-2 已交付（v0.11.15）；M2-1 仅完成契约冻结（v0.11.16），服务端未实现
> 且被 M1b 整厂引擎阻塞（v0.11.17–0.11.22 仅完成纯函数层）；M2-3 7×24 soak 未完成。
> 本文只记录已经实现、可测试的能力，不把“crate 已存在”写成“服务端已迁移”。

## 1. 为什么先做 M2-2

M2 有三项退出条件，其中“AI Provider、审计、限流、看门狗在目标语言中可用”
可以独立于 HTTP/WS 服务端迁移先行完成。先做这一层有两个实际收益：

1. 这些能力是横切关注点，服务器从 Node 换到 Axum 时不需要再重写一遍；
2. 它们有大量“看起来一致、实际不一致”的边界（限流 NaN、提示放大、审计断链、
   SSRF 绕过），可以先冻结 TS oracle，逐项 parity，而不是等换服务器时混在一起。

## 2. 已实现模块

### 2.1 AI Provider（`src/provider.rs`）

支持三种协议：

| 协议 | 端点 | 鉴权 |
| --- | --- | --- |
| OpenAI 兼容 | `{base}/chat/completions` | `Authorization: Bearer …` |
| Anthropic Messages | `{base}/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` |
| Google Gemini | `{base}/models/{model}:generateContent` | `?key=…` |

安全边界：

- 只允许 `http` / `https`；拒绝 URL 内嵌账号密码；
- 拒绝云元数据主机（`metadata.google.internal` 等）、`169.254.0.0/16`、
  `100.100.100.200`、IPv6 链路本地/ULA/未指定地址；
- 覆盖 IPv4-mapped、IPv4-compatible、NAT64、6to4 内嵌地址；
- 域名先解析，再把已校验地址钉扎到 `reqwest` 客户端，关闭 DNS rebinding 窗口；
- `redirect::Policy::none()`，3xx 不跟随；
- API key 只进请求头，不进错误串；`mask_api_key` 只用于设置页展示。

边界：当前是**非流式** chat；工具调用、视觉、结构化输出尚未移植。这些不在
M2 的三项退出条件内，不能被宣传成已支持。

### 2.2 审计（`src/audit.rs`）

- append-only JSONL；每条事件含 `seq / at_unix_ms / kind / actor / subject / detail /
  prev_hash / hash`；
- `hash = SHA-256(prev_hash + "\n" + canonical(event))`；
- 启动打开文件时先复验全链，序号断档、prev_hash 不符、内容被改都返回
  `AuditError::Chain`；
- 决策去重：`action|severity|summary` 指纹在 60 仿真分钟内只落一次，`force`
  不受限，与 TS `decisionAudit.ts` 一致。

文件轮转与远端 WORM 尚未实现；当前是单机 append-only 证据链，不是合规级
不可篡改存储。

### 2.3 限流（`src/rate_limit.rs`）

| 类别 | 窗口 |
| --- | ---: |
| control | 500 ms |
| topology | 5 s |
| decision | 2 s |
| chat | 1.5 s |
| snapshot | 1 s |

- 每连接状态独立；首请求不被 NaN/缺失时间戳误伤；
- 提示 2 s 冷却，40 条被限流消息只回 1 条，冷却后可再回 1 条；
- 单连接 LLM 在途上限 2；
- 连接总数上限仍是服务端职责（常量 `MAX_WS_CLIENTS = 50`）。

### 2.4 看门狗（`src/watchdog.rs`）

10 项确定性检查，输出既有 `WatchdogReport`：

`sim-ticks / sim-live / sim-latency / llm / persistence / agent-config / hooks /
agent-file / ws / influent-source`。

与 TS 的 parity 由 `rust/golden/ops-cases.json` 锁定：14 组输入，逐 check
比对 `id/label/severity/detail/action` 与整份报告 severity。

## 3. 证据

```bash
cd rust
cargo test -p aquapilot-ops --all-targets
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```

- `aquapilot-ops`：13 单元 + 4 parity = 17 项；
- `aquapilot-contract`：6 项契约完整性测试；
- 整仓 Rust：113 项（57 单元 + 56 集成/parity）；
- oracle 生成：`npm run gen:ops-cases` → `rust/golden/ops-cases.json`；
  `npm run gen:http-contract` → `rust/golden/http-contract.json`。

## 4. soak harness（M2-3 前置，不等于 M2-3 通过）

`scripts/soak.ts` 做的是真实墙钟长稳，不是把仿真时间加速：

- 启动 `dist/server/index.mjs`（或 `SOAK_BASE` 指向已运行服务）；
- 每 `SOAK_INTERVAL_MS` 采样 `/proc/<pid>/status` 的 RSS/线程数、
  `/proc/<pid>/fd` 的句柄数；
- 探活 `/api/health?deep=1` 与 `/api/snapshot`，每 5 个样本开一次真实 WS，
  发 `hello` 并等 `snapshot`；
- 输出 `samples.csv`、`run.json` 与 `summary.json`；
- 验收默认 `SOAK_MINUTES=1440`（24 h），通过条件：至少 24 h、0 探针错误、
  预热后 RSS 增长 ≤10%、线性斜率 ≤1 MiB/h、FD 增长 ≤2；
- 防伪：拒绝覆盖已有 `samples.csv`；`run.json` 记录启动时宿主 boot id，
  结束时 boot id 变化则判 `hostRebooted`、`passed=false`，跨重启样本不能拼成
  连续 24 h。

已跑过的 1 分钟快速跑只证明 harness 能采到 RSS/FD/WS，**不能**写进 24 h
验收。v0.11.15 的 TS soak 在 2026-11-26 00:02 宿主重启时中断（约 24 分钟、
25 个样本），没有 `summary.json`，不计入 M2-3。M2-3 必须在目标服务上跑满
连续 24 h 墙钟后再签。

## 5. M2-1 契约冻结（v0.11.16，不等于迁移完成）

`scripts/gen-http-contract.ts` 从 TS 生产服务冻结
`rust/golden/http-contract.json`：

- 32 条 legacy 路由（含 `/api/assets/{id}` 模板）与 3 个 `startsWith` 前缀；
- 9 条 `/api/v1/*` 版本化路由与 `/api/openapi.json`；
- 3 个公开端点（`/api/auth-required`、`/api/health`、`/api/openapi.json`）；
- `/mcp`、`/ws`、512 KiB WS 帧上限；
- 19 类客户端消息、14 类服务端消息；
- 8 个 TS 源文件的 SHA-256。

`rust/crates/aquapilot-contract` 只读加载这份 golden，测试锁定条数、公开端点
归属、路径前缀、版本化参数风格与 WS 标签唯一性。`npm run gen:http-contract
-- --check` 已接入本地 CI：TS 契约改动而 golden 未重生成会直接失败。

该 crate 是**迁移义务清单**，不是 HTTP/WS 服务端。生产监听仍然是
TypeScript；M2-1 未完成。

M2-1 的 Rust 服务端若要自带仿真，必须先有 M1b 的整厂闭环。v0.11.17–0.11.22 只完成
`aquapilot-sim` 的 forcing/influent、phase 1 调蓄、聚合/ASM1 入流与输出阶段纯函数（112/96/1098 + 12/12/48/36/24 + 10/7 + 12 + 8/2/12 组 oracle），
`createNetworkState`/`stepNetwork`/`PlantSnapshot` 仍未移植；因此 M2-1 服务端
继续 blocked by M1b，不能用契约 crate 或纯函数 crate 冒充服务端。

## 6. 明确未做

- HTTP/WS 路由、鉴权、持久化、实验/研究 API 仍在 TypeScript 服务端；
- `aquapilot-ops` 尚未接线到生产服务端（当前是独立 crate + 测试）；
- `aquapilot-contract` 只冻结契约，Rust 监听、路由、鉴权、WS 会话尚未实现；
- 7×24 soak 未跑满，M2-3 未签；
- 因以上四项，M2 总里程碑仍未关闭。

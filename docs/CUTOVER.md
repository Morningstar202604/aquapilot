# V2 Cutover Gate — 判定：NO-GO（双轨）

> 日期：2026-11-28。候选：`aquapilot-v2 0.0.19`。旧产品：`aquapilot 0.11.23`（`dist/server/index.mjs`）。
> 本文件只记录可复现证据与判定，不把“水线包络通过”冒充成六项全指标或三本账整厂通过。

## 1. 判定

**不切换。** V2 继续作为实验/验证引擎，旧 TS 继续作为生产入口。触发继续双轨的原因：

- 24 h soak 尚未跑完（0.0.19 已启动，见 `docs/soak-24h-progress.json`；只有 `completed_24h=true` 的 summary 才算通过）；
- 六项出水指标没有同时对照：旧 ASM1 不建模 BOD/TP，旧 ASM2d 的 NH 均值 28.19 mg/L、三本账最大残差 70.6%，不能当六项 oracle；
- 反应器库存与 COD/N/P 三本账的整厂对照未建立；
- v1 `studies` API 与旧版 live snapshot/topology/WebSocket 未迁移。

## 2. 30 天 ASM1 水线包络（通过，但不是 bitwise parity）

同一套旧厂几何与边界从黑盒导出重建：厌氧 3000 m³、缺氧 4500 m³、好氧 5750 m³ ×3、二沉池 4800 m² ×4.5 m；进水 COD 330.09、NH₄-N 31.86、TP 4.87、SS 179.94 mg/L，流量 1800 m³/h，RAS 0.8Q、内回流 2Q、WAS 0.022Q，温度 16.67 °C。旧厂 30 天 experiment 用 5 天暖机；V2 采样剔除前 5 天启动段。

唯一标定项：旧二沉池实测 `xEff≈9.3 mg/L`，V2 的 Takács 参数把 `v_max` 从 474 调到 240 m/d 以复现该泥水分离水平；没有改动力学参数。

| 指标 | 旧 0.11.23 均值 | V2 0.0.19 均值 | 偏差 | 包络 |
| --- | ---: | ---: | ---: | --- |
| COD | 43.83 | 49.90 | +13.85% | ±15% 通过 |
| SS | 11.91 | 11.48 | −3.62% | ±15% 通过 |
| NH₄-N | 0.320 | 0.073 | −0.247 mg/L | 绝对 ≤0.30 通过 |
| TN | 19.50 | 17.97 | −7.87% | ±10% 通过 |
| DO | 1.97 | 2.00 | −0.05% | ±5% 通过 |

判定：**ASM1 水线包络通过**。它不等于六项达标等价：ASM1 没有 BOD/TP 状态，旧 ASM1 的 TP≈4.97 只是未去除的示踪值，不能作为 V2 的 TP 对照。六项与除磷必须走 ASM2d 路径另行验收。

证据：`docs/cutover/parity-30d.json`、`docs/cutover/old-experiment-30d.json`、`docs/cutover/rust-30d-samples.csv`、`docs/cutover/translated-topology-v2.json`、V2 实验 `4fb0a170-5481-4608-86c8-8263448e975c`。

## 3. API 契约

- v1 实验路径兼容：`POST/GET /api/v1/experiments`、详情、取消、`samples.csv`、`report.md` 与旧版同名同形。
- 新增旧版只读别名：`GET /api/auth-required`、`GET /api/standards`、`GET /api/limits`；`GET /api/health` 同时带旧字段 `ok/authRequired/uptimeSeconds/paused/tickErrors/lastTickMs`。
- 未迁移：`/api/v1/studies` 四个路径、旧版 `/api/snapshot`、`/api/topology`、WebSocket 增量。V2 是实验队列模型，不提供旧版“实时 tick 快照”；直接换客户端会断。
- 结论：v1 实验契约可接，旧 UI/研究 API 需要迁移层，不能宣称 drop-in。

证据：`docs/cutover/api-rollback.json`、`docs/cutover/old-openapi.json`、`docs/cutover/rust-openapi.json`。

## 4. 回滚

旧 TS 二进制与数据未动：`dist/server/index.mjs`、`data/aquapilot.db`、`data/topology.json`。本次已在 5180 启动旧服务并探测 `/api/health` 返回 `ok=true`；V2 使用独立 SQLite（`/tmp/aquapilot-ui19.sqlite`），不回写旧库。

回滚步骤：

1. 停止 V2 进程（按 PID，不用 `pkill -f`）；
2. 用旧环境变量/端口启动 `node dist/server/index.mjs`；
3. 探测 `/api/health` 与 `/api/snapshot`；
4. 反向代理指回旧端口；V2 数据目录保留供复盘，不迁移进旧库。

## 5. 重新评估条件

同时满足以下条件才可把 `cutover_approved` 改为 true：

1. `docs/soak-24h-summary.json` 存在且 `completed_24h=true`、`request_failure=0`、`health_failure=0`；
2. ASM2d 六项出水 + 反应器库存 + COD/N/P 三本账在同一拓扑/进水/初始条件下 30 天对照通过；
3. `studies` API 与旧 live 读路径有迁移层或明确下线窗口；
4. 回滚演练再次通过。

在那之前，任何“V2 已替换旧产品”的表述都是假的。

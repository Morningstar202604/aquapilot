# AquaPilot Work Log

## Current milestone

- [x] M0 Rust workspace, ASM2d CSTR + 5-pool network parity
- [x] M1 ASM1 reaction surface (13 components, 8 processes, 20/15 C parity)
- [x] M1 ASM1 CSTR / network integration (5-tank slice, TS↔Rust 1e-12)
- [x] M1 Takács settler parity (10-layer BSM1 slice, 64 f64 ulp)
- [x] M1 ADM1 standalone CSTR parity (48 h, 27 components)
- [ ] M1 ADM1 sludge-line integration
- [ ] M1 hydraulics / transport parity
- [ ] WP2 30 d COD/N/P balance closure
- [ ] M2 Rust server / AI / CLI
- [ ] M3 frontend / industrial acceptance
- [ ] M4 optional zero-TypeScript migration
- [x] B1 reproducible experiments / durable queue
- [x] B2 OpenAPI 3.1 + RFC 9457 + idempotency
- [x] B3 multi-dimensional validation + MCP experiment bus
- [ ] B4 full regression, docs, five-platform delivery（WP2 三账仍红，不冒充全绿）
- [x] B5 simulation studies / batch variants / Pareto / reproducible report

## Latest verifiable state

- `cargo test`: 13 unit + ADM1 parity 1 + ASM1 parity 2 + ASM1 network parity 2 + ASM2d CSTR 1 + ASM2d network 1 + Takács 1, all pass
- `cargo clippy --all-targets -- -D warnings`: clean
- `npx vitest run`: 1651 passed / 1652 (139 files); one WP2 30 d COD/N/P balance failure (real failure, no `it.fails`)
- `npm run typecheck && npm run lint && npm run format && npm run build`: pass
- `npm run e2e`: pass (17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors)
- Latest release: `v0.11.4` (ADM1 口径修正 + 子步进); prior `v0.11.3`, `v0.11.2`, `v0.11.1`, `v0.11.0`
- GitHub CI: typecheck/lint/build pass；unit 仅 WP2 30 d 账本失败；browser smoke 因前置单测红灯跳过

## Rule

Every turn must land a code/test/golden commit or explicitly record a blocker;
do not repeat the same probe without a code change.

## 2026-11-25 ADM1 口径修正与子步进 (v0.11.4)

- [x] 修正 TS oracle：`hydCh/hydPr/hydLi` 改回 `X_ch/X_pr/X_li`；崩解产物进入 `X_ch/X_pr/X_li`，不再误加 `X_su/X_aa/X_fa`。
- [x] `stepAdm1`/`step_adm1` 公开入口按 <=0.05 h 自动子步，消除 0.5 h 显式 Euler 的酸化振荡（pH 6.42、S_ac 200 g/m³）。
- [x] `sludgeToAdm1In` 不再同时写入 `X_c` 与 `X_ch/X_pr/X_li`，避免泥线 COD 重复计量。
- [x] 重新生成 `rust/golden/adm1-48h.json`；Rust parity 全 27 组分 + 沼气/ pH 通过。
- [ ] WP2 三账仍红，和本次 ADM1 泥线修正无关（WP2 稳态关闭泥线）。

## 2026-11-25 ADM1 standalone parity (v0.11.3)

- [x] `rust/crates/aquapilot-core/src/adm1.rs`: 27-component ADM1, 11 rate processes, gas transfer, pH/inhibition diagnostics, explicit-Euler CSTR.
- [x] `rust/golden/adm1-48h.json`: 96 steps × 0.5 h at 1000 m³ / 100 m³/d.
- [x] `tests/adm1_parity.rs`: all 27 states within 64 f64 ulps; methane rate, methane fraction, pH and inhibition flag exact.
- [x] Parity finding: TS oracle's `hydCh/hydPr/hydLi` rates read `X_su/X_aa/X_fa` and never deplete `X_ch/X_pr/X_li`; Rust mirrors this intentionally. Correcting the oracle is a separate model change.
- [ ] ADM1 sludge-line integration and hydraulics parity still open.

## 2026-11-25 Takács settler parity (v0.11.2)

- [x] `rust/crates/aquapilot-core/src/takacs.rs`: 10-layer BSM1 Takács, double-exponential v_s, limiting-flux interfaces, feed layer, CFL sub-stepping, solids loading
- [x] `rust/golden/takacs-24h.json`: 24 h profile from TS oracle; Rust matches within 64 f64 ulps (bottom layer ~14,349 g/m³)
- [x] Rust unit tests for settling velocity / invalid geometry; one parity test; clippy `-D warnings` clean
- [ ] ADM1 / hydraulics parity still not started
- [ ] WP2 30 d COD/N/P balance remains the only red test

## 2026-11-25 ASM1 CSTR/network parity (v0.11.1)

- [x] `src/sim/asm1Network.ts`: constant-volume CSTR + ordered 5-tank network slice; RAS particulate thickening, internal recycle, deterministic sub-stepping
- [x] `rust/crates/aquapilot-core/src/asm1_network.rs`: same slice in Rust; 24 h CSTR + 48 h network match TS at `<=1e-12`
- [x] Golden fixtures `asm1-cstr-24h.json`, `asm1-network-48h.json`; 3 TS invariants + 2 Rust parity tests
- [x] Removed the last Rust `AP_DEBUG_REACT` console probe; clippy `-D warnings` clean
- [ ] WP2 30 d COD/N/P balance remains the only red test; no tolerance relaxation, projection or `it.fails`

## 2026-11-24 simulation studies (v0.11.0)

- [x] `src/sim/study.ts`: base + 1–12 variants + 1–2 replicates (24 max), deterministic seeds, metrics/P95, ranking, Pareto, Markdown report
- [x] `studySchema/studyStore/studyService/routes/studies.ts`: valibot boundaries, SQLite WAL + memory fallback, batch queue capacity (`429 STUDY_QUEUE_FULL`), idempotency, cancel, ETag
- [x] OpenAPI 3.1 study paths/schemas; MCP `create_study/get_study/list_studies/cancel_study/get_study_report`; CLI `aquapilot study --file`
- [x] 13 study tests (domain/service/API); production smoke: POST 202, poll succeeded 2/2, report.md 200
- [x] Removed leftover `AP_DEBUG` console probes from ASM2d network path
- [x] README/README.zh-CN, API, backend modernization, plant-boundary and changelog updated
- [ ] WP2 30 d COD/N/P balance remains the only red test; no tolerance relaxation, no projection, no `it.fails`

## 2026-11-24 repository delivery

- [x] Concise English/Chinese README, screenshots and demo linked
- [x] Five-platform main synced; all side branches removed
- [x] GitHub descriptions, topics, auto-merge, delete-branch-on-merge and main protection enabled
- [x] Gitee/GitCode descriptions, main branch and merge settings set
- [x] Docs consistency tests repaired
- [ ] WP2 30 d COD/N/P balance closure (remaining red CI gate)

## 2026-11-24 前端收尾（已做完）

- [x] 工艺编排默认 1:1，不再在桌面被强制压到 64% 小字
- [x] 全览随容器尺寸重算，1024/1280 不再沿用旧缩放裁掉右侧单元
- [x] 1100px 以下编辑器改单列可滚动：组件库横条、画布固定可用高度、属性栏可到达
- [x] 画布解除监视视图的 30dvh 高度上限，三条泳道在窄屏完整可见
- [x] 编辑态节点间距 46px、泳道分隔线加深、图例移到画布上方工具带、端口热区扩到 21px
- [x] 触屏单指平移画布，1:1 下可拖到右侧与下方单元
- [x] 前端相关 87 项单测通过；全量 1618/1619，唯一红灯仍是 WP2 全厂 COD/N/P 边界
- [x] 本地 `npm run e2e` 通过；五平台 main 已同步到 `2604ddf`


## 2026-11-24 后端现代化（代码与文档已做完，待推送）

- [x] 实验领域层：拓扑快照 + 显式 spec + 种子；fixed/AI 闭环；30 d/20k 样本/288 决策上限
- [x] 持久队列：SQLite WAL + 内存降级；并发 2/队列 24；429 背压；幂等重放/冲突；重启恢复
- [x] 版本化 API：`/api/v1/experiments` CRUD/cancel、CSV、Markdown、OpenAPI 3.1、RFC 9457、ETag、cursor
- [x] MCP 工具总线：`create_experiment` / `get_experiment` / `list_experiments` / `cancel_experiment`
- [x] CLI：`aquapilot experiment --minutes/--days/--policy/--validation/--plant --csv --json`
- [x] 多维校验：有限性、非负、采样覆盖、运行合规、三本账、重复性、1/2 min 步长收敛
- [x] 认证边界：viewer 读 / operator 写；未认证返回 problem+json；OpenAPI 公开
- [x] `npm run typecheck` / `npm run lint` / `npm run format` / `npm run build` 通过
- [x] 新增实验测试 6 + 服务 5 + API 6，全部通过；全量 1635/1636，唯一红灯仍是 WP2
- [x] `npm run e2e`：PASS（17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors）
- [x] 生产构建冒烟：202+Location、幂等 200、冲突 409、422/415/400、ETag 304、CSV/Markdown、MCP 4 工具、CLI
- [x] 生产重启恢复：30 d AI 实验在 SIGKILL 后重排队并成功完成（43200 min, 100%）
- [x] README 中英、API、BACKEND-MODERNIZATION、CHANGELOG 更新；产品定位改为仿真建模软件
- [x] 五平台 main 推送与远端 CI 复核（提交后执行）
- [ ] WP2 全厂 COD/N/P 三本账（本轮未解决，唯一红灯）

已知边界：FMI 3.0 / SSP 1.0 未实现；当前对外互操作是 REST/OpenAPI 3.1 + MCP 2025-06-18，不宣称 FMI 兼容。

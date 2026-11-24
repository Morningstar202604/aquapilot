# AquaPilot Work Log

## Current milestone

- [x] M0 Rust workspace, ASM2d CSTR + 5-pool network parity
- [x] M1 ASM1 reaction surface (13 components, 8 processes, 20/15 C parity)
- [ ] M1 ASM1 CSTR / network integration
- [ ] M1 Takács settler parity
- [ ] M1 ADM1 parity
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

- `cargo test`: 8 unit + ASM1 parity 2 + CSTR parity 1 + network parity 1, all pass
- `cargo clippy --all-targets -- -D warnings`: clean
- `npx vitest run`: 1648 passed / 1649; one WP2 30 d COD/N/P balance failure (real failure, no `it.fails`)
- `npm run typecheck && npm run lint && npm run format && npm run build`: pass
- `npm run e2e`: pass (17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors)
- Latest release: `v0.11.0` (simulation studies); prior `v0.10.1`, `7ad5a99`, `2604ddf`
- GitHub CI: typecheck/lint/build pass；unit 仅 WP2 30 d 账本失败；browser smoke 因前置单测红灯跳过

## Rule

Every turn must land a code/test/golden commit or explicitly record a blocker;
do not repeat the same probe without a code change.

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

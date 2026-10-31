---
task_slug: README-factual-gate
path: plan
created_at: 2026-10-31T16:35:00Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: "本切片同时包含文档、CI 和验证脚本改动；objection 1-5 分别覆盖其对应行为与门禁文件"
behavior_contract_exception: "纯文档、CI 门禁和验证脚本修复；不新增生产运行时功能"
---

# AQG Code Construction Ledger — README-factual-gate

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 交叉读取 README、源码、测试、benchmark、CI 和脚本，确认能力状态与验证入口 | README.md:1; docs/BENCHMARKS.md:1; src/server/auth.ts:1; src/sim/dataSources.ts:1 | 已完成：发现旧 benchmark、旧边界声明和两个假绿路径 |
| 2. Behavior Lock | yes | 保留既有测试；验证脚本将关键失败结论转换为非零退出，CI 保留 Vitest 原始退出码 | scripts/prove-topology-matters.ts:25; .github/workflows/ci.yml:175 | `npx tsx scripts/prove-topology-matters.ts` 四项结论 true；CI test-count parser checks 1084/1084/0/0/0 |
| 3. Thin Slice | yes | 只改 README 双语、BENCHMARKS、历史提示、CI 测试门禁和 topology proof；不改模型运行逻辑 | README.md:1; README.zh-CN.md:1 | 范围锁定为事实口径和 fail-closed 验证 |
| 4. Construction Rules | yes | 不新增依赖；不把 synthetic/standalone/unimplemented 能力写成生产能力；远程写入不在本切片执行 | package.json:30; src/server/calibrationService.ts:245 | 依赖零变更；远程更新阻塞于安全凭据库结构 |
| 5. Local Verification | yes | typecheck、lint、test、build、coverage、ci、secret scan、脚本行为和 diff check | package.json:11-21; scripts/ci-gate.sh:1 | `npm run ci` 全绿：1084 tests、94.01/81.58/95.94 coverage、build、smoke、secret、backup、audit、hygiene；E2E 全绿 |
| 6. Self Review (5 axes) | yes | 正确性、可读性、架构、安全、性能逐项检查 | README.md:1; .github/workflows/ci.yml:166 | 文档与门禁改动不触及生产计算路径；安全扫描不得发现令牌 |

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W8: docs changed | yes | README、BENCHMARKS、竞品分析、路线图和历史审计报告均按当前源码可复现或明确边界的内容同步，旧数字从当前叙事移除 |
| W7: diff size | yes | 双语 README 采用短结构替代重复叙事，修改范围仍限于展示与验证门禁 |
| W6: new dependency | yes | package.json 新增项目级 allowScripts 安全策略但未新增依赖；package-lock 仅同步根元数据 |

## Predicted Objections

1. **Objection**: 基准结果受 seed、Node 和初始化影响。**Mitigation**: `docs/BENCHMARKS.md:31` 明确命令、seed、决策间隔、robust 开关和受控仿真边界。
2. **Objection**: coverage 数字可能被误读为全前端覆盖率。**Mitigation**: `README.md:96` 与 `docs/BENCHMARKS.md:119` 明确写成领域覆盖率并引用 include 范围。
3. **Objection**: synthetic calibration/EKF 被误读为现场能力。**Mitigation**: `README.md:34` 明确 synthetic、default-off、simulated measurement、不会自动写回参数。
4. **Objection**: CI JSON 解析仍可能在空报告时通过。**Mitigation**: `.github/workflows/ci.yml:175` 保留 Vitest 原始退出码，Node 解析同时检查总数、失败、跳过和 todo。
5. **Objection**: topology proof 只打印结果会产生假绿。**Mitigation**: `scripts/prove-topology-matters.ts:25` 对关键结论集中检查，任一 false 设置非零退出码；运行脚本进行反证。

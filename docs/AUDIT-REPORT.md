# 项目全维度审查与对标报告

**审查对象**：AquaPilot（`C:\Users\X1882\Desktop\workspace\zcode\agent\huanjing`）
**审查日期**：2026-10-21
**审查基线**：git 提交 `19225d8`，211 项测试通过

---

## 一、总体结论

**整体质量评级：B+（原型级优秀，产品级不足）**

核心模型与工程纪律扎实（ASM1 守恒精确到机器精度、拓扑驱动求解真实可用、211 项测试、CI 三平台配置、输入校验完备），但**产品化与运维维度存在系统性缺口**：无覆盖率门禁、无前端测试、无 E2E 纳入 CI、认证会破坏前端可用性、无安全响应头、无 SLO/指标、`stepNetwork` 复杂度超标 5 倍。

**最大风险**：`AQUAPILOT_TOKEN` 一旦启用，浏览器打开首页直接 401——认证功能与前端完全不兼容，是一个"启用即故障"的功能。

**最优先三项行动**：
1. 修复认证与前端不兼容（F-001，High，已实测复现）
2. 建立覆盖率与前端测试门禁（F-004/F-005，High，当前分支覆盖 74.85% 不达标）
3. 补齐安全响应头（F-002，Medium，OWASP A02）

---

## 二、证据与基线

### 2.1 项目类型与技术栈

| 项 | 值 | 证据 |
|---|---|---|
| 项目类型 | **AI 应用 + 实时 Web 服务 + 前端可视化应用**（非 SaaS，无多租户） | `package.json`、`src/` 结构 |
| 语言 | TypeScript 5.9.3（strict + noUnusedLocals/Parameters） | `tsconfig.json:8-10` |
| 运行时 | Node >= 22.12.0 | `package.json` engines |
| 前端 | React 19.3.1 + ECharts 6.1.0 + 手写 SVG | `package.json`、`src/client/` |
| 服务端 | Node http + ws 8.22.0 | `src/server/index.ts` |
| 持久化 | `node:sqlite`（Node 22+ 内置，动态加载） | `src/server/store.ts:17-28` |
| 部署形态 | 单进程，localhost，无容器化 | `src/server/index.ts:475` |
| 用户角色 | 单一角色（操作员），无 RBAC | `src/server/auth.ts` |
| 数据敏感等级 | **低**（无 PII、无凭据、仿真数据） | 全仓扫描无 PII |

### 2.2 实际运行的命令与输出

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，0 错误 |
| `npx vitest run` | **211 passed / 211**，14 个测试文件，15.21s |
| `npm run build` | 成功，client 821.43 kB（gzip 268.45 kB），server bundle |
| `npx vitest run --coverage` | 见 §6 看板 |
| `npm audit --registry=https://registry.npmjs.org` | **0 vulnerabilities** |
| `bash scripts/ci-gate.sh` | **8/8 全绿** |
| GitHub Actions | Node 20 ✓ / Node 22 ✓ / Quality gate ✓ |

### 2.3 对标对象（具名）

| 竞品 | 类型 | 选择理由 |
|---|---|---|
| **fau-evt/bsm2-python** ⭐44 | Python 库，BSM1/BSM2 标准实现 | 同领域最接近的"标准模型实现"，有 9 个测试文件覆盖 BSM1/BSM2 全系列，BSD-3 许可，2025-09 仍在维护 |
| **toogad/PooPyLab_Project** ⭐79 | Python 库，污水处理工艺模拟 | 同品类中 star 最高，GPL-3.0，含 `examples/` 与 `docs/` |
| **wwtmodels/Activated-Sludge-Models** ⭐59 | 模型集合（文档型） | 作为"模型权威性"参照 |

**未选择 GPS-X / BioWin / SIMBA#**：商业闭源，无法读取实现细节做逐项对比，只能做功能清单对比（本报告在 §5 中仅用于 Must-have 判断）。

---

## 三、发现清单（按严重级别排序）

| ID | 级别 | 置信度 | 维度 | 位置 | 问题 | 证据 | 建议修复 | 对标含义 |
|---|---|---|---|---|---|---|---|---|
| **F-001** | **High** | **高** | 安全 / 可用性 | `src/server/index.ts:676-681` | **启用 `AQUAPILOT_TOKEN` 后，浏览器访问 `/` 直接返回 401 JSON，前端完全无法加载**。鉴权中间件覆盖了静态文件，而浏览器导航请求无法携带 `Authorization` 头。前端也没有任何 token 输入入口（`App.tsx`、`useSimulation.ts` 均无 `token` 字样）。 | 实测：`AQUAPILOT_TOKEN=secret123` 启动后 `curl /` → **401**，body 为 `{"error":"缺少或无效的访问令牌"}`；`/?token=secret123` → 200。`grep token src/client/` 无命中。 | 静态资源与 HTML 不参与鉴权；或改为「页面可加载，API/WS 需 token」；前端增加 token 输入并存入 sessionStorage，WS 用子协议传递。 | 关闭差距：任何有认证的产品都必须保证登录页可达 |
| **F-002** | Medium | 高 | 安全（OWASP A02） | `src/server/index.ts` 全局 | **无任何安全响应头**：缺 `X-Content-Type-Options`、`X-Frame-Options`、`Content-Security-Policy`、`Referrer-Policy`、`Strict-Transport-Security`。 | `python` 扫描 `src/server/index.ts`：`X-Frame-Options`/`CSP`/`HSTS` 等关键字**均无命中**。 | 增加统一响应头中间件；CSP 需允许 `unsafe-inline`（当前样式内联） | 关闭差距：bsm2-python 作为库不涉及；但任何 Web 产品基线 |
| **F-003** | Medium | 高 | 安全（OWASP A05） | `src/server/store.ts:122,245` | SQL 使用模板字符串插值表名。**外部不可控**（来源为硬编码数组 `['decisions','snapshots']` 与三个字面量），**不构成注入漏洞**，属代码质量告警。 | 读取 L120 `for (const table of ['decisions','snapshots'])`；L246 `one('decisions')` 等均为字面量 | 改为白名单映射常量，消除插值形式 | 忽略差距：无实际风险 |
| **F-004** | **High** | 高 | 测试有效性 | 全项目 | **分支覆盖率 74.85%，低于 85% 红线**；语句 89.29% 接近但未达 90%。`src/client/` **完全无测试**（无 `.test.tsx`，覆盖率报告无 client 行）。 | `npx vitest run --coverage` 输出：`All files 89.29 / 74.85 / 87.25 / 90.84`；`ls tests | grep -i client` 无结果 | 为核心域补分支测试；引入前端测试（@testing-library/react） | 关闭差距：bsm2-python 有 9 个模型测试文件，本项目前端零覆盖 |
| **F-005** | **High** | 高 | CI 完整性 | `.github/workflows/ci.yml` | CI **不运行覆盖率、不运行 `npm audit`、不运行 E2E**。 | `python` 检查 ci.yml：`coverage`/`audit`/`playwright`/`e2e` **全部 False** | 加三步：coverage 阈值、audit、Playwright smoke | 关闭差距：成熟项目 CI 必含覆盖率与依赖扫描 |
| **F-006** | Medium | 高 | 可维护性 | `src/sim/networkEngine.ts:426` | `stepNetwork` 单函数 261 行、**55 个判定点**，圈复杂度约 56，远超红线 10。 | 脚本统计：`55 判定点 src/sim/networkEngine.ts::stepNetwork`；函数跨度 261 行 | 拆分为 `solveReactors` / `solveClarifier` / `solveBiomass` / `solveEffluent` | 承认差距：bsm2-python 按模块拆分（asm1/bsm1/bsm2 分层） |
| **F-007** | Medium | 高 | 运维（SRE） | 全项目 | **无 SLO/SLI、无错误预算、无 metrics 端点、无分布式追踪**。仅有 `console.log/error`（6 处）与 `/api/health`（返回固定 `{ok:true}`，不检查依赖）。 | `grep "SLO|SLI|prometheus|opentelemetry"` 无命中；`/api/health` 实现仅 `res.end(JSON.stringify({ok:true,...}))` | 增加 `/api/metrics`（Prometheus 文本格式）与深健康检查 | 承认差距：库类项目不要求；作为服务是缺口 |
| **F-008** | Medium | 高 | 可靠性 | `src/server/store.ts` | **无备份/恢复机制**，SQLite 单文件，WAL 模式但未做 checkpoint 策略。崩溃可能丢失最多 5 秒缓冲（flush 间隔）。 | `grep backup\|restore` 无命中；`flushTimer = setInterval(..., 5000)` | 定时 checkpoint + 文档化备份/恢复步骤 | 承认差距 |
| **F-009** | Medium | 高 | 产品功能 | `src/client/` 全前端 | **无前端测试**，且关键交互（拓扑编辑、连线、应用）只能靠手工 Playwright 脚本验证，脚本未纳入 CI。 | `ls tests` 14 个文件均为 `.ts`，无 `.tsx` | 引入 `@testing-library/react` + 关键组件测试 | 关闭差距 |
| **F-010** | Low | 高 | 工程质量 | 全项目 | **无 ESLint / Prettier 配置**，无 `lint` 脚本（当前 `lint` 只是 `tsc --noUnusedLocals`）。 | `npm ls eslint` → empty；`package.json` scripts 无 eslint | 引入 ESLint flat config + prettier | 承认差距 |
| **F-011** | Low | 高 | 工程质量 | 全项目 | **无 CHANGELOG 自动生成、无 release 流程、无版本 tag**。`CHANGELOG.md` 手写且只到 0.1.0。 | `git tag` 无输出；`git rev-list --count HEAD` = 23，无 tag | 引入 semantic-release 或 changesets | 承认差距 |
| **F-012** | Low | 高 | 安全（OWASP A09） | `src/server/index.ts` | **无结构化安全日志**：认证失败、限流触发、非法输入均未记录（仅部分 `console.error`）。 | 检索 `auth.*fail\|unauthorized` 无命中 | 认证失败写结构化日志（含 IP、时间、原因） | 承认差距 |
| **F-013** | Low | 高 | 性能 | `src/client/styles.css` | **CSS 21.6 kB 未分块**，ECharts 全量引入（`import * as echarts from 'echarts/core'` + 按需注册，实际已优化）。client bundle 821 kB / gzip 268 kB，偏大但可接受。 | 构建输出：`821.43 kB │ gzip: 268.45 kB` | 若需优化可用 manualChunks 拆 echarts | 忽略差距：单页应用可接受 |
| **F-014** | Low | 中 | 配置一致性 | `package.json` vs `ci.yml` | `engines: node >=22.12.0`，但 CI matrix 含 **Node 20**（已通过，因代码做了动态降级）。语义上矛盾：声明不支持却测试通过。 | `package.json` engines；`ci.yml:22` matrix `[20, 22]` | 要么去掉 Node 20，要么把 engines 改为 `>=20`（并接受 sqlite 不可用） | 关闭差距：配置自洽性 |
| **F-015** | Low | 高 | 文档 | `README.md` | 声称 "CI configuration is provided... whether they execute depends on enabling CI" —— **表述准确但暴露了"CI 未真正启用"的事实**。GitHub Actions 实际已运行并通过（实测），文档过时。 | GitHub API：runs 返回 `success`；README 措辞保守 | 更新为"GitHub Actions 已验证通过" | 关闭差距 |

### 3.1 Critical / High 的可复现路径

**F-001 PoC（已执行）**

```bash
AQUAPILOT_TOKEN=secret123 PORT=5173 node dist/server/index.mjs &
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/
# 输出：401
curl -s http://127.0.0.1:5173/ | head -c 80
# 输出：{"error":"缺少或无效的访问令牌","authRequired":true}
```

**最小补丁建议**：在鉴权判断前放行静态资源路径（非 `/api/` 开头），或改为 `GET /` 返回一个登录页。

**F-004 / F-005 复现**

```bash
npx vitest run --coverage --coverage.reporter=text | grep "All files"
# All files | 89.29 | 74.85 | 87.25 | 90.84   ← 分支 74.85 < 85
grep -c "coverage\|audit\|playwright" .github/workflows/ci.yml
# 0
```

---

## 四、查漏补缺清单（按项目类型）

项目类型：**AI 应用 + 实时 Web 服务 + 前端可视化**。以下为该类型专项检查结果。

| 检查项 | 状态 | 说明 |
|---|---|---|
| 实时连接的心跳与半开检测 | ✅ 有 | `ws.ping()` 每 30s，`maxPayload` 512KB |
| 断线重连与退避 | ⚠️ 部分 | 有重试（600ms×n，上限 8s），**无 jitter**，无"最后更新时间"标识 |
| 增量推送与背压 | ⚠️ 部分 | 有增量 patch（−75%），但**无 `bufferedAmount` 背压检查** |
| 客户端协议校验 | ✅ 有 | `isUsableSnapshot()` + ErrorBoundary 自恢复 |
| AI 输出的可解释性 | ✅ 有 | 决策含候选排名、逐项理由、区分度 |
| LLM 集成的幻觉防护 | N/A | 当前未接 LLM（`answer()` 为规则引擎），不适用 |
| 模型可复现性（seed） | ✅ 有 | 同 seed 同序列结果一致，有测试 |
| 数值稳定性（NaN/发散） | ✅ 有 | 有 NaN/负值测试 + 性能基线 |
| 长时运行漂移 | ✅ 有 | 15→25 天漂移 <15% 测试 |
| 数据导出 | ❌ 无 | 无 CSV/JSON 导出，回放数据只能看不能导 |
| 多用户并发 | ❌ 无 | 单 runtime，所有客户端共享同一厂 |
| 审计日志（谁改了什么） | ❌ 无 | 决策入库但无操作者身份 |
| 容器化 / 部署清单 | ❌ 无 | 无 Dockerfile、无 k8s manifest |
| 前端国际化 | ❌ 无 | 硬编码中文，无 i18n 框架 |
| 移动端手势 | ⚠️ 部分 | 可滚动但无 pinch zoom |
| 无障碍（WCAG） | ⚠️ 部分 | 有 role/tabIndex，但对比度不足（`--text-3` 3.74:1 < 4.5:1） |

---

## 五、竞品对标矩阵

### 5.1 功能差距映射

**Must-have（入场券）**

| 能力 | AquaPilot | bsm2-python | PooPyLab | 差距类型 |
|---|---|---|---|---|
| ASM1 实现 | ✅ 13 组分/8 过程 | ✅ | ✅ | 持平 |
| BSM1 基准对照 | ⚠️ 有 BSM1 进水但**无官方 Table 6 数值对照** | ✅ 完整 BSM1/BSM2 测试 | ❌ | **关闭差距**（缺权威验证） |
| 二沉池模型 | ✅ Takács 10 层 | ✅ Takács | ✅ | 持平 |
| 可复现（seed） | ✅ | ✅ | ⚠️ | 持平 |
| 单元测试 | ✅ 211 | ✅ 9 文件 | ⚠️ | 持平 |
| 文档 | ✅ README + 2 docs | ✅ ReadTheDocs | ✅ docs/ | 持平 |

**Differentiating（差异化）**

| 能力 | AquaPilot | bsm2-python | PooPyLab | 差距类型 |
|---|---|---|---|---|
| **可视化工艺流程图** | ✅ 拓扑驱动 SVG | ❌ 无 | ❌ 无 | **跨越差距**（本项目独有） |
| **AI 自动决策** | ✅ 滚动优化 + 护栏 | ❌ | ❌ | **跨越差距** |
| **可视化编排** | ✅ 拖入/连线/校验 | ❌ | ❌ | **跨越差距** |
| **实时 Web 服务** | ✅ WebSocket | ❌ 脚本式 | ❌ | **跨越差距** |
| **历史回放** | ✅ SQLite + 时间轴 | ❌ | ❌ | **跨越差距** |
| 情景注入（8 类） | ✅ | ⚠️ 仅 BSM 标准情景 | ⚠️ | 领先 |
| BSM2（含厌氧消化） | ❌ | ✅ | ❌ | **承认差距**（不在范围） |
| ADM1（厌氧模型） | ❌ | ✅ | ❌ | **刻意忽略**（范围外） |

**Nice-to-have**

| 能力 | AquaPilot | bsm2-python | 差距类型 |
|---|---|---|---|
| 参数敏感性分析 | ❌ | ⚠️ | 承认差距 |
| Monte Carlo | ❌ | ❌ | 忽略 |
| 多语言 | ❌ | ✅ 英文 | 关闭差距（低成本） |

### 5.2 体验对标（核心页面）

| 维度 | AquaPilot | 评价 | 差距 |
|---|---|---|---|
| 首屏是否清楚下一步 | ✅ 有全览 + 对话入口 | 良好 | — |
| 关键操作反馈 | ⚠️ 控制有 notice，但**拓扑应用失败后已跳转回监视视图**（用户失去上下文） | 不足 | 关闭差距 |
| 空状态 | ✅ 有（无告警/无历史/持久化关闭） | 良好 | — |
| 错误态 | ✅ ErrorBoundary + 自动恢复 | 优于多数同类 | 领先 |
| 加载态 | ⚠️ 仅首屏 loading，拓扑应用无进度 | 不足 | 关闭差距 |
| 信息层级 | ✅ KPI → 流程图 → 趋势 → 侧栏 | 良好 | — |
| 操作链路长度 | ⚠️ 改拓扑需 3 步（点编排→改→应用），无撤销 | 不足 | 关闭差距 |

---

## 六、量化指标看板

| 指标 | 当前值 | 红线 | 判定 | 证据 |
|---|---|---|---|---|
| 行覆盖率 | **90.84%** | ≥90% | **通过**（勉强） | `--coverage` |
| 语句覆盖率 | 89.29% | ≥90% | **不通过** | 同上 |
| **分支覆盖率** | **74.85%** | ≥85% | **不通过** | 同上 |
| 函数覆盖率 | 87.25% | — | 参考 | 同上 |
| 变异分数 | [未确认] | ≥80% | **[未确认]** | 需引入 Stryker；未安装 |
| 圈复杂度（最大函数） | **≈56**（`stepNetwork`，55 判定点） | ≤10 | **不通过** | 脚本统计 |
| 认知复杂度 | [未确认] | ≤15 | **[未确认]** | 需 SonarQube 或 eslint-plugin-sonarjs |
| 技术债务比率 | [未确认] | ≤5% | **[未确认]** | 需 SonarQube |
| 重复行（新代码） | [未确认] | <3% | **[未确认]** | 需 jscpd |
| Critical 漏洞 | **0** | 0 | **通过** | `npm audit` |
| High 漏洞 | **0** | 0 | **通过** | 同上 |
| 测试数量 | 211 | — | 通过 | `vitest run` |
| 断言密度 | 2.1/测试 | — | 参考（偏低） | 脚本统计 |
| 前端测试数 | **0** | >0 | **不通过** | `ls tests` |
| CI 覆盖率门禁 | **无** | 有 | **不通过** | ci.yml |
| CI 依赖扫描 | **无** | 有 | **不通过** | ci.yml |
| CI E2E | **无** | 有 | **不通过** | ci.yml |

**覆盖率明细（不达标文件）**

| 文件 | 分支覆盖 | 问题 |
|---|---|---|
| `src/sim/topologyEngine.ts` | **46.05%** | 可运行性校验分支大量未测 |
| `src/ai/agent.ts` | **58.1%** | 决策分支覆盖不足 |
| `src/sim/plantModel.ts` | 62.5% | 适配器分支 |
| `src/server/store.ts` | 65.95% | 错误路径 |
| `src/sim/networkEngine.ts` | 73.44% | 主引擎分支 |
| `src/client/**` | **无数据** | 零测试 |

---

## 七、修复与补齐路线图

| 优先级 | 任务 | 对应发现 | 工作量 | 验收标准 |
|---|---|---|---|---|
| P0 | 修复认证与前端不兼容 | F-001 | S | `AQUAPILOT_TOKEN=x` 启动后浏览器可打开首页并输入 token 完成连接；`curl /` 返回 HTML 而非 401 |
| P0 | 引入覆盖率门禁（行 90/分支 85） | F-004, F-005 | M | CI 在覆盖率低于阈值时失败；`npm run ci` 输出覆盖率表 |
| P1 | 补分支测试至 85% | F-004 | M | `topologyEngine` 分支 ≥80%，`agent` ≥80% |
| P1 | 引入前端测试 | F-004, F-009 | M | 至少覆盖 `PlantCanvas` 渲染、`DecisionPanel` 数据展示、`useSimulation` 合并逻辑 |
| P1 | CI 加 audit + E2E | F-005 | S | CI 三步全部执行并在失败时红 |
| P2 | 加安全响应头 | F-002 | S | `curl -I` 可见 CSP/X-CTO/XFO/Referrer-Policy |
| P2 | 拆分 `stepNetwork` | F-006 | L | 单函数 ≤80 行、判定点 ≤15，测试全绿 |
| P2 | 加 metrics 端点 | F-007 | M | `/api/metrics` 返回 Prometheus 文本，含 tick 耗时/连接数/AI 周期耗时 |
| P3 | 加备份/恢复 | F-008 | S | 文档化 `sqlite3 .backup` 步骤并实测恢复 |
| P3 | 引入 ESLint/Prettier | F-010 | S | `npm run lint` 通过，CI 包含 |
| P3 | 更新 README CI 表述 | F-015 | S | 明确"GitHub Actions 已验证通过" |
| P3 | 统一 engines 与 CI matrix | F-014 | S | 二者一致 |
| P4 | 数据导出（CSV） | §4 | M | 回放面板可导出当前区间为 CSV |
| P4 | 拓扑应用失败留在编排页 | §5.2 | S | 失败时 `setView('plant')` 不执行 |

### 验收方式说明

- **覆盖率**：以 `vitest --coverage` 的实际数字为准，不引用估算。
- **前端测试**：必须能在 jsdom 下运行并断言 DOM 内容，不能是快照占位。
- **安全响应头**：必须用 `curl -I` 实测，不能只看代码。
- **`stepNetwork` 拆分**：拆分后 211 项测试必须全部保持绿色，且物理结果不变（同一 seed 出水数值差 <1%）。

---

## 八、明确不适用的维度

| 维度 | 不适用原因 |
|---|---|
| 多租户隔离 / IDOR | 单用户单厂设计，无租户概念 |
| 支付 / 计费 | 无商业化功能 |
| CSP 严格 nonce | 当前样式内联（`styles.css` 单文件），nonce 化需构建改造，暂用 `unsafe-inline` |
| 数据库迁移框架 | 单文件 SQLite + 内联迁移，规模不需要 Prisma/Flyway |
| 消息队列 / 分布式事务 | 单进程，无跨服务事务 |
| LLM 幻觉防护 | 未接 LLM |
| k8s / 自动伸缩 | 单实例原型，非集群部署 |

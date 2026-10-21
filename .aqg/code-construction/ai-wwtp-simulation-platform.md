---
task_slug: ai-wwtp-simulation-platform
path: plan
created_at: 2026-10-19T15:36:31Z
session_agent: zcode
skipped_checks: []
objections_diff_coverage_exception: null
behavior_contract_exception: 新建项目、无仓库历史与需求规格书；行为契约改由 tests/engine.test.ts 与 tests/agent.test.ts 中的 31 项可执行断言承担，逐条覆盖稳态达标、场景物理响应、预测不变性、护栏边界与闭环安全。
---

# AQG Code Construction Ledger — ai-wwtp-simulation-platform

> 从零新建的完整项目（工作目录初始为空）。下列证据均指向仓库内真实文件与真实运行结果。

| step | required | evidence | file:line | command/result |
|---|---|---|---|---|
| 1. Pattern Mining | yes | 工作区为空，无相邻代码可循。改为对标成熟做法：ECharts 官方按需引入 API、Vite 8 + React 19 插件约定、ws 服务端挂载约定、AQG 账本模板（`~/.deeppattern/agent-quality-gates/templates/code-construction-ledger.md`） | `src/client/components/Trends.tsx:1-8`、`scripts/build-server.mjs:1-13` | `npm view echarts/vite/vitest peerDependencies` 取得真实版本与 peer 约束；首次 `npm install` 因 esbuild 0.25 与 vite 8 的 peer 冲突失败，改钉 0.28.2 后安装成功（54 包） |
| 2. Behavior Lock | yes | 先写断言再修引擎：测试暴露 4 个真实物理缺陷（MLSS 崩塌、硝化失效、二沉池收支反向、DO 越饱和），逐个修复至绿 | `tests/engine.test.ts:14-70`、`tests/agent.test.ts:11-90` | `npx vitest run` → 2 files / 31 tests passed；covers: R1, R2, R3, R4, R5 |
| 3. Thin Slice | yes | 单一行为面：从"引擎能稳态达标"切到"AI 闭环能守住"，再到"UI 能读到真实数据"；未做多厂区模板、历史归档、LLM 接入 | `src/sim/engine.ts:1-60`、`src/ai/agent.ts:1-40` | 明确不做：RL 策略、权限体系、持久化（见 `README.md:96-101`） |
| 4. Construction Rules | yes | YAGNI 阶梯：仿真用纯函数无依赖；图表用 ECharts 而非手写 SVG 坐标系；对话用意图识别而非引入 LLM SDK；服务端用 ws 而不用框架 | `src/sim/engine.ts:1-14`、`src/ai/agent.ts:460-520` | 依赖仅 5 个运行时包（echarts/lucide-react/react/react-dom/ws），无 ORM、无状态库、无 UI 框架 |
| 5. Local Verification | yes | 类型检查、单测、构建、真实浏览器端到端、移动端截图逐项通过 | `tests/engine.test.ts:1`、`scripts/e2e.ts:1` | `npx tsc --noEmit` → 0 error；`npx vitest run` → 31/31；`npm run build` → client 774 kB / gzip 255 kB + server bundle；`npx tsx scripts/e2e.ts` → 3 canvas、35 SVG 节点、5 tab、`CONSOLE_ERRORS []` |
| 6. Self Review (5 axes) | yes | 正确性：质量平衡与确定性已测；可读性：模块边界 sim/ai/server/client/shared 单向依赖；架构：引擎无 IO、AI 纯函数、协议集中一处；安全：无密钥、无外部请求、静态路径做前缀校验；性能：单 tick 2 仿真分钟、趋势环形截断 720 点 | `src/server/index.ts:300-312`（路径穿越校验）、`src/client/hooks/useSimulation.ts:36-105`（断线重连）、`src/server/index.ts:64-67`（趋势截断在服务端） | 人工通读全部源码；`npm ls --depth=0` 确认无多余依赖 |

## Behavior Contract

### R1: 出厂水质稳态达标
系统 SHALL 在设计进水负荷与默认控制下把出水稳定在 GB 18918-2002 一级 A 限值以内。

- Scenario S1.1: 40 天培养后的稳态
  - GIVEN 设计进水（COD 350、NH₃-N 34、TP 4.8）与默认控制
  - WHEN 连续运行至稳态
  - THEN 出水 COD < 50、NH₃-N < 5、TP ≤ 0.5、SS < 10 mg/L
- Scenario S1.2: 生物量与污泥龄处于设计窗口
  - GIVEN 同上
  - WHEN 读取 MLSS 与 SRT
  - THEN MLSS 在 2000–6000 mg/L、SRT 在 10–40 d

### R2: 场景物理响应方向正确
系统 SHALL 让每类工况产生符合工艺常识的方向性响应，而不是任意漂移。

- Scenario S2.1: 鼓风机故障
  - GIVEN 稳态运行
  - WHEN 注入鼓风机故障并推进 200 分钟
  - THEN 好氧区 DO < 1.5 mg/L 且出水氨氮高于故障前
- Scenario S2.2: 回流泵故障
  - GIVEN 稳态运行
  - WHEN 注入回流泵故障并推进 180 分钟
  - THEN 二沉池污泥界面高于故障前
- Scenario S2.3: 药剂短缺
  - GIVEN 稳态运行
  - WHEN 注入药剂短缺并推进 400 分钟
  - THEN 出水总磷高于短缺前

### R3: AI 决策不越过工艺护栏
系统 MUST NOT 输出超出生理与工艺安全边界的控制量。

- Scenario S3.1: 任意场景下的决策
  - GIVEN 稳态或任一场景运行中
  - WHEN 调用决策
  - THEN DO 设定 ≥ 1.5、PAC ≥ 18、所有控制量在 CONTROL_BOUNDS 内
- Scenario S3.2: 毒性抑制下的强化
  - GIVEN 注入毒性抑制
  - WHEN 调用决策
  - THEN DO 设定 ≥ 2.4

### R4: 预测不污染实时状态
系统 SHALL 让预测计算成为纯操作，不改变被预测对象。

- Scenario S4.1: 预测后的状态一致性
  - GIVEN 任意实时状态
  - WHEN 执行 4 小时滚动预测
  - THEN 原状态序列化结果与调用前完全一致
- Scenario S4.2: 预测时域与采样
  - GIVEN 240 分钟时域、30 分钟采样
  - WHEN 读取预测点
  - THEN 恰好 8 个点、首点 30 分钟、末点 240 分钟且严格递增

### R5: 闭环控制的安全性
系统 SHALL 在 AI 接管全厂控制时仍把出水维持在可控范围。

- Scenario S5.1: 暴雨闭环
  - GIVEN AI 自动执行且注入暴雨
  - WHEN 连续 8 个决策周期
  - THEN 出水 SS 不超过限值的 2 倍且无 NaN
- Scenario S5.2: 全天闭环的溶氧稳定性
  - GIVEN AI 自动执行连续 24 小时
  - WHEN 读取三段好氧池 DO
  - THEN 每段 DO 在 0.9–5.0 mg/L

## Warning Acknowledgements

| condition | ack | reason |
|---|---|---|
| W6: 新增运行时依赖 echarts / lucide-react / react / react-dom / ws | yes | 图表交互与 Canvas 高密度绘制用成熟库而非手写坐标系；图标用 lucide 避免内联 SVG 路径；WebSocket 用 ws 而非自写协议栈。构建体积已测：客户端 774 kB / gzip 255 kB，在可接受范围内，后续可按需裁剪 ECharts 模块 |
| W6: 开发依赖 playwright-core | yes | 仅用于真实浏览器端到端验证与截图审查，不进产物；跑完即用于验证，不参与运行时代码 |
| W7: 大 diff（新建项目） | yes | 工作目录初始为空，本任务即从零构建可运行产品；按 `plan` 级流程执行，账本与测试先行于修复 |
| W8: 新增文档 README.md | yes | 记录架构、启动方式、已知边界与延伸方向；已知边界一节明确声明这是仿真原型而非可接管真实水厂的系统 |

## Predicted Objections

1. **Objection**: 动力学参数是手调的，可能与真实水厂偏差较大，导致"看起来达标"但结论不可信 (`src/sim/engine.ts:124-160`) — **Mitigation**: 引擎的每条动力学常数都对应一个可解释的物理量（kCod、kNit、kDen、kP、yield、decay），并以 `tests/engine.test.ts` 锁住稳态在合理窗口；README 的"已知边界"明确说明未做实测回归、不可替代 GPS-X/BioWin 的设计校核。后续可用 `scripts/calibrate.ts` 对接实测数据做参数回归。
2. **Objection**: 二沉池用一维固体通量近似，无法反映污泥膨胀、短流与异重流，泥位结论可能过于乐观 (`src/sim/engine.ts:555-585`) — **Mitigation**: 泥位由固体收支累积量除以浓度再除以面积得到，回流中断会真实抬升（测试 S2.2 锁定方向性），并在 UI 与告警里同时暴露 SLR 与泥位两个独立指标；README 声明未做流场与形态学建模。
3. **Objection**: AI 不是学习出来的策略，只是规则化滚动优化，遇到未建模工况可能给出次优甚至错误建议 (`src/ai/agent.ts:123-200`) — **Mitigation**: 护栏 `applyGuard` 在候选生成后强制夹紧，`tests/agent.test.ts` 锁定 DO/PAC/SRT 边界；每个候选都做完整 4 小时预测后再排序，超标重罚（2200/次）显著高于成本项；决策结果给出置信度与候选排名，人工可一键夺回控制权。
4. **Objection**: 对话层是意图识别 + 模板，不是自然语言理解，用户问法超出关键词会答非所问 (`src/ai/agent.ts:460-580`) — **Mitigation**: `answer()` 返回 `kind: 'unknown'` 时给出 4 条可用问法引导；`tests/agent.test.ts` 覆盖 status / why / whatif / unknown 四类意图；README 说明接 LLM 的替换点在 `answer()`，引擎作为工具层可被 function calling 复用。
5. **Objection**: 服务端状态全在内存，重启即丢失，无多用户隔离，不适合演示之外的使用 (`src/server/index.ts:28-42`) — **Mitigation**: 这是刻意的范围裁剪，README 的"已知边界"与"可以往哪延伸"明确标注；静态文件服务做了路径前缀校验防穿越（`src/server/index.ts:300-312`）；若要多用户需引入每连接独立 runtime，已在架构上隔离为单一 `Runtime` 对象，替换面清晰。

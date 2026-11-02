# AquaPilot

**AI 值守的污水处理工艺仿真。** 工艺流程可以随手改，改完立即重算；AI 值守员接管控制，但每一次预测、每一个决策、每一条护栏都在浏览器里可查。

[English](README.md) · [API](docs/API.md) · [基准数据](docs/BENCHMARKS.md) · [部署](docs/DEPLOYMENT.md)

[![CI](https://github.com/Morningstar202604/aquapilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Morningstar202604/aquapilot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Morningstar202604/aquapilot/actions/workflows/codeql.yml/badge.svg)](https://github.com/Morningstar202604/aquapilot/actions/workflows/codeql.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933)](package.json)
[![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![测试](https://img.shields.io/badge/测试-1159%20通过-2ea44f)](docs/BENCHMARKS.md)

![AquaPilot 总览](docs/screenshots/01-overview.jpg)

## 你能得到什么

- **改得动的工艺流程，不是画死的图。** 流程就是一张图：加一个池子、改一根回流、切一个模板，求解器按拓扑重新编译网络，画布跟着变。默认 A²/O 厂 17 个单元、23 条连线，每条线都落在端口锚点上。
- **ASM1 + Takács 沉淀池，有基准背书。** 水线在 CI 里对照 IWA BSM1 Table 6 官方值；偏差最大的 TSS（受 Takács 非沉降分数 `f_ns` 影响）为 **+5.1%**。ASM2d 与 ADM1 作为独立、经过组分守恒校验的模块交付。
- **把自己的 reasoning 摊开的 AI 值守员。** 滚动 4 小时预测对候选控制动作按达标、成本、稳定性排序，在硬边界内执行，并解释每个动作——包括它**没动**的动作和原因。被护栏挡住的调节会如实说「被挡住」；没有任何一条日志会在控制量真的没动的情况下写「已执行」。
- **分析内建。** 参数灵敏度（中心差分）、达标-成本 Pareto 前沿、覆盖四路去向（出水 / 排泥 / 曝气氧化 / 系统内库存变化）的全厂 COD 质量平衡审计。
- **证据，不是话术。** AI 与固定策略影子双跑共享 seed、进水与初始状态；效益页展示的是真实差值。参数校准与六维 EKF 作为实验性工具随仓库交付，边界写明。
- **运维级卫生。** 三档令牌访问（`viewer` / `operator` / `admin`）、出站请求 SSRF 防护、SQLite 历史 + 备份恢复、Prometheus 指标、带数据质量拒绝的 CSV 进水回放，以及一条本地 11 步 CI 门禁，在 GitHub Actions、GitCode、Gitee 三端等价执行。

**它不是**：设计级模拟器、现场控制系统、合规保证。仿真输出只用于测试与工程讨论；精确边界见 [docs/BENCHMARKS.md](docs/BENCHMARKS.md)。

## 界面截图

| 控制室 | AI 决策链 |
| --- | --- |
| ![](docs/screenshots/01-overview.jpg) | ![](docs/screenshots/03-decision.jpg) |
| **工艺编排** | **移动端** |
| ![](docs/screenshots/07-editor.jpg) | ![](docs/screenshots/09-mobile.jpg) |

更多视图：[AI 对话](docs/screenshots/02-chat.jpg) · [工况注入](docs/screenshots/04-control.jpg) · [告警](docs/screenshots/10-alarms.jpg) · [回放](docs/screenshots/06-replay.jpg) · [效益](docs/screenshots/05-insights.jpg) · [笔记本布局](docs/screenshots/08-laptop.jpg)，演示视频见 `docs/media/demo.mp4` / `demo.gif`。

## 快速开始

需要 **Node.js 22.12+**（推荐 24）。无需外部数据库或服务——历史持久化使用 Node 内置 SQLite。

```bash
npm ci
npm run build
npm start                 # → http://127.0.0.1:5173
```

开发模式（热更新）：

```bash
npm run dev               # Vite 客户端 :5174，API/WS 代理到 :5173
```

验证（CI 同款）：

```bash
npm run verify            # 类型检查 + lint + 1159 项测试 + 构建
npm run ci                # 完整 11 步门禁：覆盖率、冒烟、密钥扫描、备份、审计
npm run e2e               # Playwright 浏览器冒烟（优先用本机 Edge/Chromium）
```

Docker：

```bash
docker build -t aquapilot:local .
docker run --rm -p 5173:5173 \
  -e AQUAPILOT_TOKEN="$AQUAPILOT_TOKEN" \
  -v aquapilot-data:/app/data aquapilot:local
```

## 配置

零配置即可运行——不配令牌就是本地无鉴权沙箱；配上令牌即启用访问控制：

```text
HOST=127.0.0.1                 # 非本机监听必须配令牌（fail-closed）
AQUAPILOT_TOKEN=...            # admin —— 模型、Agent、拓扑、校准
AQUAPILOT_OPERATOR_TOKEN=...   # operator —— 场景、控制调节
AQUAPILOT_VIEWER_TOKEN=...     # viewer —— 只读大屏
AQUAPILOT_DB=data/aquapilot.db # 历史库位置（node:sqlite，WAL）
```

LLM 服务商（OpenAI 兼容 / Anthropic Messages / Google Gemini）在界面里配置，密钥以受限文件权限落盘；AI 层可选，未配置时回退到确定性规则。完整变量清单见 [.env.example](.env.example)，部署细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/API.md](docs/API.md) | HTTP + WebSocket 契约、消息 schema |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | 每一条实测数字，附复现命令 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 运维、备份恢复、故障排查 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker、持久化、反向代理、镜像仓库布局 |
| [docs/UI-ARCHITECTURE.md](docs/UI-ARCHITECTURE.md) | 前端模块划分与数据流 |
| [docs/QUALITY-ROADMAP.md](docs/QUALITY-ROADMAP.md) | 已知模型局限与处理计划 |
| [docs/COMPETITIVE-ANALYSIS.md](docs/COMPETITIVE-ANALYSIS.md) | 对照 7 个同类项目的核实比较 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 分支、提交规范、本地门禁、发版步骤 |

## 参与贡献

欢迎 PR。`npm run ci` 就是契约：本地跑的 11 步与远程 CI 完全一致，本地绿 = 远程绿。分支命名、提交风格与发版清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

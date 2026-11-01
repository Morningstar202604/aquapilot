# AquaPilot

拓扑驱动的污水处理仿真原型与 AI 值守员。

[English](README.md)

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.19-339933)](package.json) [![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![AquaPilot 总览](docs/screenshots/01-overview.jpg)

## 项目定位

AquaPilot 是一个可运行的运行侧仿真原型：工艺流程以拓扑图保存，编译为反应器网络后按拓扑顺序求解，并在控制室界面中展示。AI 值守员做滚动预测、比较控制动作、执行硬护栏并解释结果，人可以检查、提问或接管。

它**不是**设计级工艺模拟器、真实水厂控制系统、合规保证或现场数字孪生。输出仅用于仿真、测试和工程讨论，不能直接作为设计计算、监管材料或现场操作指令。

## 已验证能力

- **拓扑驱动求解**：单元数量、容积、端口、物流、回流和路线均来自可编辑拓扑；改图会改变实际求解网络。
- **运行水线**：ASM1 + Takács 十层二沉池，并有 BSM1 Table 6 对照测试。
- **AI 值守**：四小时预测、候选控制动作、合规/成本/稳定性评分、硬边界、人工优先期和严重告警处理。
- **鲁棒分析**：固定扰动压力测试、参数灵敏度、合规与成本 Pareto 前沿、全厂 COD 质量平衡审计。
- **影子双跑**：AI 策略和固定策略共享 seed、进水与初始状态；这是受控仿真对照，不是现场 A/B 测试。
- **运维流程**：工况注入、告警归因、全厂健康度、回放/导出、备份，以及带数据质量拒绝的 CSV 进水回放。
- **实验性校准与估计**：基于 BSM1 合成目标的有界校准，以及默认关闭、使用仿真测量的六维 EKF；不等于现场标定或传感器软测量。
- **模型注册表**：ASM1 是当前运行模型；ASM2d 与 ADM1 已实现并测试，但作为独立单元，未接入主水线，也未完成 BSM2 全流程验证。
- **模型服务商**：界面可配置 OpenAI 兼容、Anthropic Messages 和 Google Gemini；LLM 为可选项，未配置时回退到确定性规则。
- **访问级别**：`viewer`、`operator`、`admin` 由共享环境令牌映射。这不是用户账户管理，也不是完整的多用户 RBAC。

## 实现状态与边界

| 能力 | 状态 | 边界 |
| --- | --- | --- |
| ASM1 + Takács 水线 | 运行水线 | 主水线使用 ASM1；BSM1 对照仍有文档化容差。 |
| ASM2d 与 ADM1 | 已实现但未接主线 | 有独立测试和注册表元数据；没有 BSM2 全流程集成。 |
| 参数校准 | 实验性 | 使用合成 BSM1 观测；结果不会自动改写运行参数。 |
| 状态估计 | 实验性、默认关闭 | 使用仿真状态与确定性噪声；没有现场传感器流。 |
| CSV 进水回放 | 已实现 | 应用前执行大小、格式和数据质量校验。 |
| MQTT / OPC UA | 未实现 | 仅保留适配器契约并明确报告不可用，不包含协议客户端。 |
| 历史持久化 | 依赖运行环境 | Node 22+ 可使用内置 `node:sqlite`；Node 20 可能降级为内存历史。请检查 `/api/health?deep=1`。 |
| 访问控制 | 已实现，共享令牌模式 | 三档访问级别，不是命名用户或完整 RBAC。 |

## 快速开始

要求 Node.js 20.19 或更高版本；需要历史/回放持久化时建议使用 Node 22+。

```bash
npm ci
npm run build
npm start                 # http://127.0.0.1:5173
```

开发模式：

```bash
npm run dev
```

验证命令：

```bash
npm run typecheck
npm run lint
npm run test
npm run verify            # 类型检查 + lint + 测试 + 构建
npm run ci                # 本地质量门禁、审计、冒烟、备份和卫生检查
npm run e2e               # Playwright 浏览器冒烟，使用托管 Chromium 或 AQUAPILOT_BROWSER_PATH
```

Docker：

```bash
docker build -t aquapilot:local .
docker run --rm -p 5173:5173 -v aquapilot-data:/app/data aquapilot:local
```

## 配置

LLM 设置可在界面中保存；部署和自动化也可使用环境变量。只使用占位符，绝不提交真实值。

```text
AQUAPILOT_TOKEN=...            # 可选：admin 访问令牌
AQUAPILOT_OPERATOR_TOKEN=...   # 可选：operator 访问令牌
AQUAPILOT_VIEWER_TOKEN=...     # 可选：只读访问令牌
AQUAPILOT_LLM_BASE_URL=...
AQUAPILOT_LLM_MODEL=...
AQUAPILOT_LLM_API_KEY=...
```

启用鉴权后：读取需要 `viewer`，控制和工况操作需要 `operator`，拓扑/模型/Agent 配置需要 `admin`。服务暴露到本机以外时必须使用 TLS 和反向代理。LLM 配置文件使用受限权限保存，浏览器只接收掩码和是否存在密钥的标记。

## 可复现实测

当前数字的唯一维护入口是 [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)，其中记录命令、Node 版本、seed、策略和已知模型限制。

最近一次本地门禁基线为 89 个测试文件、1094 项测试通过。覆盖率是已配置模型/AI/服务端源码的**领域覆盖率**，不代表所有 React 组件都被统计；当前行、分支和函数数字只在 `docs/BENCHMARKS.md` 维护。

## 限制与安全声明

- 仿真结果不能作为设计计算、监管提交、现场操作指令或自动控制授权。
- 当前运行水线是 ASM1 + Takács；ASM2d 和 ADM1 是独立实现，尚未完成 BSM2 全流程验证。
- 校准是合成数据验证；EKF 默认关闭，不读取现场传感器。
- P10/P50/P90 和超限比例是固定扰动压力测试，不是统计置信区间或现场风险概率。
- MQTT 和 OPC UA 未实现；当前外部数据路径是 CSV 回放。
- 实时状态由单个运行实例共享；访问级别是共享令牌映射，不是命名用户。
- Node 20 在 SQLite 不可用时仍可运行，但历史可能只存在内存；请通过健康检查和回放面板确认持久化状态。
- BSM1 的 S_NH 与二沉池浓度剖面仍有已知偏差，解读数字前先看基准表。

## 文档

- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — 可复现的模型、策略、性能和覆盖率测量
- [`docs/API.md`](docs/API.md) — HTTP 与 WebSocket 契约
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — 运维、备份、恢复和故障排查
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Docker、持久化、代理和部署边界
- [`docs/QUALITY-ROADMAP.md`](docs/QUALITY-ROADMAP.md) — 历史路线和剩余模型工作
- [`docs/COMPETITIVE-SOURCE-ANALYSIS.md`](docs/COMPETITIVE-SOURCE-ANALYSIS.md) — 模型范围与源码证据
- [`scripts/README.md`](scripts/README.md) — 验证与开发脚本

## 许可证

MIT

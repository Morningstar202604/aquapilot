# AquaPilot

浏览器里的污水处理厂仿真器，带可审计的 AI 值守员。

[English](README.md) · [API](docs/API.md) · [部署](docs/DEPLOYMENT.md) · [基准](docs/BENCHMARKS.md)

[![CI](https://github.com/Morningstar202604/aquapilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Morningstar202604/aquapilot/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![AquaPilot 控制室](docs/screenshots/01-overview.jpg)

AquaPilot 可以直接改工艺流程、跑过程模型，也可以把控制权交给 AI 值守员——预测、决策和护栏都留在界面上可查。

- **可编辑的厂，真实的过程模型。** 加池子、改回流、换模板；ASM1、ASM2d、Takács 与泥线按拓扑重新编译。
- **AI 值守有据可查。** 提议、拒绝、被护栏阻断的动作都留日志；评分卡由引擎计算，不由 AI 自报。
- **工业接口。** 水力学、仪表故障、PID/联锁、排污许可口径报表、设备健康，以及 OPC UA / Modbus / MQTT 适配层。
- **多种运行方式。** Node.js 服务、CLI、Windows 单文件可执行程序，以及浏览器界面。

![AI 决策链](docs/screenshots/03-decision.jpg)

| 工艺编排 | 运营评分卡 |
| --- | --- |
| ![](docs/screenshots/07-editor.jpg) | ![](docs/screenshots/11-scorecard.jpg) |

[![演示](docs/media/demo.gif)](docs/media/demo.mp4)

## 快速开始

需要 Node.js 22.12 或更高版本。

```bash
npm ci
npm run build
npm start          # http://127.0.0.1:5173
```

无头运行：

```bash
npm run cli -- simulate --days 7 --scenario storm
npm run cli -- bench
```

Windows 单文件构建：`npm run exe`。

## 边界

AquaPilot 是仿真与工程工具，不是设计级模拟器、现场控制系统，也不构成合规保证。模型边界与已知差距见 [docs/BENCHMARKS.md](docs/BENCHMARKS.md) 与 [docs/PLANT-BOUNDARY.md](docs/PLANT-BOUNDARY.md)。

MIT 许可。

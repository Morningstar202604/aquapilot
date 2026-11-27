# AquaPilot v2（clean-room Rust）

这是 AquaPilot 的**新一代实现**，不是旧 TypeScript 仿真内核的逐函数翻译。

- 设计原则与阶段计划：`../docs/ROADMAP-V2.md`
- Clean-room 规则：`../docs/CLEAN-ROOM.md`
- 旧 `rust/` 已冻结为 v0.11.23 的历史 checkpoint，v2 不读取、不复制它的源码。

## 当前状态：V2-1 已完成，V2-2 ASM2d 与 ADM1 核心已落

V2-1 已完成并推送：ASM1 五池整厂、Takács 10 层二沉池、RAS/内回流/WAS、DO 控制、BSM1-like 与官方 BSM1 对照、22 项测试。

V2-2 当前已落：

- `aquapilot-model::asm2d`：19 组分（18 个独立动力学状态 + 由颗粒组分导出的 `X_TSS`）、21 个 ASM2d 过程、公开化学计量矩阵与速率方程；
- `aquapilot-model::asm2d_plant`：A2O 整厂路径（厌氧/缺氧/多级好氧 + 二沉池 + RAS/内回流/WAS），30 天稳定运行，CLI `asm2d` 可执行；
- ASM2d 质量账：A2O fixture 30 天的 COD/N/P 三本账均闭合（残差分别为 1.98% / 1.09% / 1.52%）；
- 多系列：`aquapilot-model::asm2d_parallel` 支持多个独立 A2O 系列并行运行并汇总全厂出水与三本账；`a2o-asm2d-2train.json` 为 2×500 m3/h 示例，系列各自拥有二沉池、RAS/WAS；
- `aquapilot-model::adm1`：24 个动力学组分 + 2 个强离子状态、22 个过程、强离子 pH/电荷平衡、准稳态气相、COD/N 双账；10 天 tutorial 残差 -0.01% / -0.00%；
- `aquapilot-model::adm1_sludge`：重力浓缩 + ADM1 消化 + 机械脱水 + 沼气 + 磷示踪的独立泥线，20 天 COD/N/P 账残差 0.79% / 1.64% / 0.00%；
- 尚未实现：ASM2d→ADM1 整厂接口（排泥接入泥线、滤液回流、P 路由）、PAC。

30 天 A2O ASM2d 实测（`fixtures/a2o-asm2d.json`）：

| 指标 | 实测 |
| --- | --- |
| 出水 COD | 44.17 mg/L |
| 出水 S_S | 1.347 mg/L |
| 出水 NH4-N | 0.771 mg/L |
| 出水 NO3-N | 8.094 mg/L |
| 出水 TN | 9.767 mg/L |
| 出水 TP | 1.004 mg/L |
| 出水 SS | 11.44 mg/L |
| 二沉池 feed / underflow / overflow TSS | 3093.95 / 6056.61 / 11.44 mg/L |
| COD 账残差 | 1.98%（closed） |
| N 账残差 | 1.09%（closed） |
| P 账残差 | 1.52%（closed） |

两系列各 500 m3/h、反应器与二沉池按 1/2 缩放后，汇总出水与三本账残差与单系列一致，证明多系列汇总路径可用。当前仍不能把 V2-2 表述为完成：ADM1 泥线尚未接入 A2O 整厂，PAC 未实现。

![V2 30 天质量账 dashboard](../docs/screenshots/v2-30d-dashboard.png)

## 运行

```bash
cd rust-v2
cargo run -p aquapilot-cli -- validate fixtures/single-aerobic.json
cargo run -p aquapilot-cli -- simulate fixtures/single-aerobic.json --minutes 1440
cargo run -p aquapilot-cli -- simulate fixtures/three-stage.json --minutes 1440 --out /tmp/three-stage.json
cargo run -p aquapilot-cli -- simulate fixtures/bsm1-like.json --minutes 43200 --params default --out /tmp/bsm1-30d.json
cargo run -p aquapilot-cli -- simulate fixtures/bsm1-official.json --minutes 43200 --params bsm1 --out /tmp/bsm1-official-30d.json
cargo run -p aquapilot-cli -- simulate fixtures/bsm1-calibrated.json --minutes 43200 --params bsm1-cal --out /tmp/bsm1-calibrated-30d.json
cargo run -p aquapilot-cli -- asm2d fixtures/a2o-asm2d.json --minutes 43200 --out /tmp/a2o-asm2d-30d.json
cargo run -p aquapilot-cli -- asm2d-parallel fixtures/a2o-asm2d-2train.json --minutes 43200 --out /tmp/a2o-asm2d-2train.json
cargo run -p aquapilot-cli -- adm1 fixtures/adm1-tutorial.json --days 10 --dt 0.002 --out /tmp/adm1.json
cargo run -p aquapilot-cli -- sludge-line fixtures/adm1-sludge-line.json --days 20 --dt 0.002 --out /tmp/adm1-sludge.json
```

质量门：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## 目录

```text
rust-v2/
├── crates/aquapilot-domain
├── crates/aquapilot-model
├── crates/aquapilot-engine
├── crates/aquapilot-cli
└── fixtures/
```

## 边界

- 单池和串联池都是固定体积 CSTR；入流按流量加权混合；出流按显式连接流量计。
- `dt` 上限 1 min；负值/非有限值在物理下界钳制并输出 `ASM1_STATE_CLAMPED` 诊断。
- 二沉池是 10 层有限体积 Takács 风格模型；RAS 底流按缺氧处理（DO 置 0），WAS 进沉泥汇。
- ASM1 COD 账只做到“进水/出水/排泥/库存变化/未解释项”，氧化项尚未入账，因此**不声称闭合**。
- ASM2d A2O 的 COD/N/P 三本账在当前 fixture 均闭合；ADM1 核心与独立泥线的 COD/N/P 账也闭合，但两者尚未接入同一整厂边界，不能合并声称 V2-2 完成。
- 未实现：ASM2d→ADM1 整厂接口、PAC、HTTP/WS 服务、实验队列、界面、24 h soak；官方 BSM1 参数集仍未全部通过 Table 6，只有校准候选在 ±20% 内通过。

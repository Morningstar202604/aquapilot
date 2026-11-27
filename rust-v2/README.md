# AquaPilot v2（clean-room Rust）

这是 AquaPilot 的**新一代实现**，不是旧 TypeScript 仿真内核的逐函数翻译。

- 设计原则与阶段计划：`../docs/ROADMAP-V2.md`
- Clean-room 规则：`../docs/CLEAN-ROOM.md`
- 旧 `rust/` 已冻结为 v0.11.23 的历史 checkpoint，v2 不读取、不复制它的源码。

## 当前状态：V2-1 已完成，V2-2 ASM2d 整厂已起步

V2-1 已完成并推送：ASM1 五池整厂、Takács 10 层二沉池、RAS/内回流/WAS、DO 控制、BSM1-like 与官方 BSM1 对照、22 项测试。

V2-2 当前已落：

- `aquapilot-model::asm2d`：19 组分（18 个独立动力学状态 + 由颗粒组分导出的 `X_TSS`）、21 个 ASM2d 过程、公开化学计量矩阵与速率方程；
- `aquapilot-model::asm2d_plant`：A2O 整厂路径（厌氧/缺氧/多级好氧 + 二沉池 + RAS/内回流/WAS），30 天稳定运行，CLI `asm2d` 可执行；
- ASM2d 质量账：COD 账在 A2O fixture 上闭合（残差 <5%）；N/P 账已输出氧化/反硝化/库存/排泥各行，仍有残差，尚不声称闭合；
- ADM1 泥线、多系列二沉池、PAC 尚未开始。

30 天 A2O ASM2d 实测（`fixtures/a2o-asm2d.json`）：

| 指标 | 实测 |
| --- | --- |
| 出水 COD | 43.98 mg/L |
| 出水 S_S | 1.199 mg/L |
| 出水 NH4-N | 0.673 mg/L |
| 出水 NO3-N | 8.149 mg/L |
| 出水 TN | 9.719 mg/L |
| 出水 TP | 1.214 mg/L |
| 出水 SS | 11.45 mg/L |
| 二沉池 feed / underflow / overflow TSS | 3139.4 / 6146.3 / 11.5 mg/L |
| COD 账残差 | 1.73%（closed） |
| N 账残差 | 14.55%（open） |
| P 账残差 | 17.45%（open） |

这组数字证明 ASM2d 生物除磷与硝化/反硝化路径已经跑通，但还不是最终 V2-2 验收：N/P 账没有闭合，ADM1 泥线和多系列二沉池未实现。不得把当前结果表述为 V2-2 完成。

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
- ASM2d A2O 的 COD 账已把异养/PAO 氧耗与反硝化 COD 计入氧化行，当前 fixture 闭合；N/P 账仍有残差，不能声称三本账闭合。
- 未实现：ADM1 泥线、多系列二沉池、PAC、HTTP/WS 服务、实验队列、界面、24 h soak；官方 BSM1 参数集仍未全部通过 Table 6，只有校准候选在 ±20% 内通过。

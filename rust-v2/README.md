# AquaPilot v2（clean-room Rust）

这是 AquaPilot 的**新一代实现**，不是旧 TypeScript 仿真内核的逐函数翻译。

- 设计原则与阶段计划：`../docs/ROADMAP-V2.md`
- Clean-room 规则：`../docs/CLEAN-ROOM.md`
- 旧 `rust/` 已冻结为 v0.11.23 的历史 checkpoint，v2 不读取、不复制它的源码。

## 当前状态：V2-1 首版

已实现：

- `aquapilot-domain`：厂区拓扑、单元、连接、单位、结构校验、二沉池几何、WAS 沉泥汇；
- `aquapilot-model`：ASM1 13 组分、温度修正、好氧/缺氧/自养过程、Takács 风格 10 层二沉池；
- `aquapilot-engine`：多反应器编译、RAS/内回流、DO 控制器、二沉池出流重建、全厂快照与 COD 账；
- `aquapilot-cli`：`validate` / `simulate`；
- 四套 clean-room fixture：单池、三段厌氧-缺氧-好氧、BSM1-like 五池 + 二沉池 + RAS/内回流/WAS、官方 BSM1 几何 + 稳定进水组分。

30 天 BSM1-like 实测（详细数字见 `../docs/V2-BENCHMARKS.md`）：

| 指标 | 实测 |
| --- | --- |
| 出水 COD | 59.14 mg/L |
| 出水 SS | 12.22 mg/L |
| 出水 NH4-N | 0.239 mg/L |
| 反应器 MLSS | 2741–2790 mg/L |
| 二沉池 feed / underflow / overflow TSS | 2789.8 / 5407.8 / 12.2 mg/L |

这不是官方 BSM1 Table 6 对照，也没有做正式标定；它是 V2-1 的整厂行为门禁。官方 BSM1 几何 fixture 也已跑通，但 30 天首跑在 DO、NO3-N、MLSS 上仍有明显偏差，Table 6 尚未通过，详见 `../docs/V2-BENCHMARKS.md`。

## 运行

```bash
cd rust-v2
cargo run -p aquapilot-cli -- validate fixtures/single-aerobic.json
cargo run -p aquapilot-cli -- simulate fixtures/single-aerobic.json --minutes 1440
cargo run -p aquapilot-cli -- simulate fixtures/three-stage.json --minutes 1440 --out /tmp/three-stage.json
cargo run -p aquapilot-cli -- simulate fixtures/bsm1-like.json --minutes 43200 --out /tmp/bsm1-30d.json
cargo run -p aquapilot-cli -- simulate fixtures/bsm1-official.json --minutes 43200 --out /tmp/bsm1-official-30d.json
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
- COD 账只做到“进水/出水/排泥/库存变化/未解释项”，氧化项尚未入账，因此**不声称闭合**；完整三本账属于 V2-2。
- 未实现：ASM2d、ADM1 泥线、官方 BSM1 Table 6 标定、HTTP/WS 服务、实验队列、界面、24 h soak。

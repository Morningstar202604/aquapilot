# AquaPilot v2（clean-room Rust）

这是 AquaPilot 的**新一代实现**，不是旧 TypeScript 仿真内核的逐函数翻译。

- 设计原则与阶段计划：`../docs/ROADMAP-V2.md`
- Clean-room 规则：`../docs/CLEAN-ROOM.md`
- 旧 `rust/` 已冻结为 v0.11.23 的历史 checkpoint，v2 不读取、不复制它的源码。

## 当前状态：V2-0

已实现：

- `aquapilot-domain`：厂区拓扑、单元、连接、单位与结构校验；
- `aquapilot-model`：ASM1 13 组分、20 ℃ 参数、温度修正、好氧/缺氧/自养过程；
- `aquapilot-engine`：拓扑编译、顺序 CSTR、固定 KLa 曝气、快照与 COD 账；
- `aquapilot-cli`：`validate` / `simulate`；
- 两套 clean-room fixture：单池、三段厌氧-缺氧-好氧。

尚未实现（明确不冒充）：

- 二沉池、RAS/内回流、DO 控制器；
- ASM2d、ADM1、三本账闭合；
- HTTP/WS 服务、实验队列、界面；
- 30 天整厂与 24 h soak。

## 运行

```bash
cd rust-v2
cargo run -p aquapilot-cli -- validate fixtures/single-aerobic.json
cargo run -p aquapilot-cli -- simulate fixtures/single-aerobic.json --minutes 1440
cargo run -p aquapilot-cli -- simulate fixtures/three-stage.json --minutes 1440 --out /tmp/three-stage.json
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

## V2-0 边界

单池和串联池都是固定体积 CSTR；入流按流量加权混合；出流按显式连接流量计。`dt` 上限 1 min，负值/非有限值在物理下界钳制并输出 `ASM1_STATE_CLAMPED` 诊断。COD 账只做到“进水/出水/库存变化/未解释项”，氧化项尚未入账，因此**不声称闭合**；完整三本账属于 V2-2。

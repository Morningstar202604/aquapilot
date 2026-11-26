# Clean-room 实施规则（AquaPilot v2）

> 目的：保证 `rust-v2/` 是从产品规格与公开领域知识出发的新实现，而不是旧 TypeScript/Rust 代码的改写。  
> 适用范围：所有参与 v2 的人与 agent，包括代码生成、测试、文档和审查。

## 1. 必须遵守

1. **不读旧实现源码**：`src/sim/**`、`src/server/**`、`src/client/**` 的源码、测试、生成器、注释都不得作为参考；旧 `rust/**` 已于 2026-11-27 删除，不得从 v0.11.23 tag 或其他副本读取。
2. **不复制**：不得复制旧代码片段、变量名、函数名、注释、错误消息结构；即使改名也不允许。
3. **从规格出发**：每个模型公式、单位、边界条件必须能指向 `docs/*.md` 的产品规格或公开文献。
4. **黑盒可用**：可以把旧版本当运行中的服务或 CLI，通过 API/界面观察输入输出；不得反编译、不得读源码。
5. **测试独立**：v2 测试不得依赖旧 Rust golden 文件；如需旧版黑盒输出做对照，必须标注“黑盒对照、非源码参考”。
6. **审查门槛**：每个 PR 先回答三个问题：
   - 这个模块解决哪个产品问题？
   - 公式/参数来源是什么？
   - 失败时返回什么错误，如何观测？

## 2. 允许的资料

- `README.md`、`docs/DEPLOYMENT.md`、`docs/API.md`、`docs/PLANT-BOUNDARY.md`、`docs/HYDRAULICS.md`、`docs/BENCHMARKS.md`、`docs/COMPLIANCE.md`、`docs/INSTRUMENTATION.md`、`docs/ASSET-MANAGEMENT.md`、`docs/INDUSTRIAL-INTERFACES.md`、`docs/INDUSTRIAL-PROTOCOLS.md`；
- 公开教材/论文/标准：ASM1、ASM2d、ADM1、Takács、BSM1/BSM2；
- 现有产品的黑盒行为：HTTP API、CLI、运行界面；
- 用户明确给出的验收标准。

## 3. 命名与结构

- 使用 Rust 领域术语：`Reactor`, `Clarifier`, `Influent`, `Effluent`, `Recycle`, `Snapshot`；
- 模块按职责分：`domain`, `model`, `engine`, `service`, `cli`；
- 不按旧代码的文件名/函数名组织；旧代码的“七阶段”只作为产品流程参考，不作为模块边界。

## 4. 测试来源

优先级：

1. 公开基准：BSM1 Table 6、质量守恒、物理不变量；
2. 产品规格中的验收场景：暴雨、风机故障、低 DO、低碱度、高氨氮、RAS/内回流；
3. 旧版黑盒输出：只用于 cutover 对照，不作为单元测试的默认 oracle。

## 5. 违规处理

发现读取旧实现、复制旧代码、用旧 golden 冒充独立测试的，立即停止该分支，删除相关代码，重新从规格实现；不在原代码上“改一改”。

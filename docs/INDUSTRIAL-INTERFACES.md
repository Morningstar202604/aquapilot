# 工业级改造：跨工作包接口契约

> 版本：2026-11-23
> 适用：WP2–WP8 并行/串行实现期间的唯一口径。任何与本文件冲突的实现以本文件为准；
> 需要变更契约时，先改本文件，再改代码。

## 1. 为什么要有这份文件

WP2–WP8 有四个执行单元同时在同一份工作树上写代码。没有冻结的接口，会出现：

- 同一份快照字段被两个包各起一个名字（`instruments` / `sensors` / `measurements`），
  合并时只能二选一，另一边的 UI 与测试全废；
- 两个包各自往 `src/server/apiRoutes.ts` 加路由，后写的覆盖先写的；
- 一个包新增的状态藏在闭包里，`snapshot()` 看不到，验收时无法证明"真的算出来了"。

因此本文件锁定：**状态放哪、字段叫什么、路由长什么样、错误码怎么给、谁的代码归谁改**。

## 2. 单位与数值口径（全仓库统一）

| 量 | 单位 | 说明 |
|---|---|---|
| 流量 | m³/h | 与现有 `influent.flow`、`controls.rasRatio` 一致 |
| 容积 | m³ | 池容、管段容积 |
| 浓度 | mg/L | 除 pH、温度、DO 饱和度 |
| 质量 | kg | 物料累计、加药、沼气 |
| 时间 | min | 仿真时间；报表层可再换算成 d |
| 功率 | kW | 瞬时；电耗 kWh |
| 水头/扬程 | m | 泵、堰、沿程损失 |
| 温度 | ℃ | — |
| pH | - | 无量纲 |

硬性要求：

1. `snapshot()` 与任何 API 响应里**不得出现 NaN / Infinity**。算不出来就是错误，
   不能把 `NaN` 序列化成 `null` 让前端猜。
2. 任何新增浓度不得为负；钳制要发生在物理边界（反应器、管段、回流），
   不允许在展示层"修数"。
3. 所有随机项必须走 `state.seed`（`mulberry32`），保证同 seed 可复现。

## 3. 状态扩展：放在 `NetworkSimState` 上

新增状态一律作为 `NetworkSimState` 的**可选字段**，保证旧快照/旧持久化数据
反序列化后仍能跑（缺失即视为该子系统未启用）。

| 字段 | 归属 | 语义 |
|---|---|---|
| `hydraulics?: HydraulicState` | WP3 | 管段输运、泵/阀/堰、分流、示踪剂、多系列流量 |
| `plant?: PlantBoundaryState` | WP2 | ASM2d 反应器状态、泥线（浓缩/消化/脱水）、沼气、沼液回流、全厂质量平衡 |
| `instruments?: InstrumentationState` | WP4 | 传感器测量值、质量码、故障注入、执行机构实际位置 |
| `controlLayer?: ControlLayerState` | WP4 | PID 回路状态、联锁/ESD 状态、被拒绝的写指令 |
| `assets?: AssetPlantState` | WP7 | 设备运行时数、故障码、检修工单、备机、可用性因子 |

字段命名规则：同一个概念在 state、snapshot、API 里**同名**，不另起别名。

- state 里是引擎内部结构（可含 Map/数组/历史缓冲）；
- `PlantSnapshot` 里是序列化视图（纯 JSON、已四舍五入到展示精度）；
- `GET /api/<domain>` 返回结构化诊断，允许比 snapshot 更细。

投影函数必须独立导出并可单测，例如：

```ts
// src/sim/hydraulics.ts
export function hydraulicView(s: HydraulicState): PlantSnapshot['hydraulics'];
```

不允许把投影逻辑写进 `snapshotView.ts` 的匿名表达式里——那正是"新增字段只改全量帧、
忘了增量帧"的复发点。

## 4. 路由契约

新增只读端点统一放在 `src/server/routes/<domain>.ts`，每个模块导出**纯函数**：

```ts
export interface RouteReply {
  status: number;
  body: unknown;
}
/** 返回 null 表示该模块不处理这个 pathname，交回调用方 404 */
export function complianceRoute(pathname: string, url: URL, input: ComplianceInput): RouteReply | null;
```

- 纯函数只吃显式入参（快照、采样缓冲、资产状态），不读模块全局、不开定时器；
- 接线（在 `apiRoutes.ts` 里调用）由集成方统一做，各包不直接改 `apiRoutes.ts`；
- 路径命名：`/api/hydraulics`、`/api/plant/balance`、`/api/instruments`、
  `/api/control/interlocks`、`/api/compliance/report`、`/api/assets`、
  `/api/protocols/tags`、`/api/protocols/status`；
- 查询参数必须做边界校验：时间窗上限、条数上限、非法数字返回 400 而不是静默取默认。
- 写操作不得新增 HTTP 端点：真实 PLC 写入走 WP8 适配层，并带审计。

## 5. 错误码

错误响应形状固定：

```json
{ "error": "人可读的原因", "code": "UPPER_SNAKE_CODE" }
```

新增错误码（按包）：

| 包 | 错误码 | 触发 |
|---|---|---|
| WP3 | `HYDRAULICS_INVALID_GEOMETRY` | 管径/长度/容积非法 |
| WP3 | `HYDRAULICS_UNSOLVABLE_SPLIT` | 支路阻力全为无穷，无法分配流量 |
| WP3 | `HYDRAULICS_TRACER_OVERFLOW` | 示踪剂总量超出数值上限 |
| WP2 | `PLANT_BALANCE_UNCLOSED` | 质量平衡残差超阈值（诊断，不阻断仿真） |
| WP2 | `ASM2D_STATE_INVALID` | 组分越界/负值 |
| WP4 | `SENSOR_OUT_OF_RANGE` | 测量超量程 |
| WP4 | `SENSOR_FAULT_ACTIVE` | 故障注入导致质量码 bad |
| WP4 | `ACTUATOR_SATURATED` | 执行机构到达行程/速率极限 |
| WP4 | `INTERLOCK_TRIPPED` | 联锁动作 |
| WP5 | `CALIBRATION_INSUFFICIENT_DATA` | 观测点不足，拒绝给出置信区间 |
| WP5 | `CALIBRATION_NOT_IDENTIFIABLE` | 参数不可辨识 |
| WP6 | `PERMIT_WINDOW_INVALID` | 报表时间窗不合法 |
| WP6 | `COMPLIANCE_NO_SAMPLES` | 窗口内没有合格样品 |
| WP7 | `ASSET_NOT_FOUND` | 未知设备 id |
| WP7 | `ASSET_UNAVAILABLE` | 设备故障/检修/ESD，不可用 |
| WP8 | `PROTOCOL_DISCONNECTED` | 通道断开 |
| WP8 | `PROTOCOL_TAG_UNKNOWN` | 标签不在映射表 |
| WP8 | `PROTOCOL_WRITE_DENIED` | 非白名单写入或被只读策略拒绝 |

## 6. 完成定义（每个包都要交）

1. **代码**：类型安全、无重复实现（jscpd 阈值 8 行/80 token）、错误路径返回上表错误码。
2. **测试**：新增 `tests/<wp>-*.test.ts`；
   - 至少 1 条**行为断言**（数值随输入变化，而不是"字段存在"）；
   - 至少 1 条**集成断言**（用 `createNetworkState`/`spinUpNetwork`/`stepNetwork` 跑网络级）；
   - 至少 1 条**错误路径**断言；
   - 随机性用固定 seed，断言写区间（如 `expect(tp).toBeLessThan(0.5)`），不写死小数。
3. **文档**：`docs/<WP-NAME>.md`，必须写清：模型边界、单位、参数来源、**未做项**、
   与现场验收门的关系。禁止"已支持 OPC UA"这类没有开关、没有测试的表述。
4. **可观测**：新增状态必须能在 `PlantSnapshot` 或 `/api/<domain>` 看到；
   只在 `console.log` 里出现的不算。
5. **迁移**：旧拓扑、旧快照、旧配置缺字段时走默认值，不抛错、不静默丢字段。

## 7. 文件归属（并行期间唯一真相）

| 归属 | 文件 |
|---|---|
| WP3/物理链 | `src/sim/network.ts`、`networkEngine.ts`、`networkTypes.ts`、`hydraulics.ts`、`plantBoundary.ts`、`sludgeLine.ts`、`instruments.ts`、`actuators.ts`、`aeration.ts`、`asm1*.ts`、`asm2d.ts`、`adm1.ts`、`takacs.ts`、`bsm1.ts`、`modelRegistry.ts`、`modelDescriptor.ts`、`src/shared/protocol.ts`、`src/server/snapshotView.ts`、`src/server/tankStates.ts` |
| WP6 合规 | `src/sim/compliance.ts`、`src/sim/sampling.ts`、`src/server/routes/compliance.ts`、`docs/COMPLIANCE.md`、`src/client/components/CompliancePanel.tsx` |
| WP7 资产 | `src/sim/assets.ts`、`src/sim/maintenance.ts`、`src/server/routes/assets.ts`、`docs/ASSET-MANAGEMENT.md`、`src/client/components/AssetsPanel.tsx` |
| WP8 接口 | `src/server/protocols/**`、`src/server/routes/protocols.ts`、`docs/INDUSTRIAL-PROTOCOLS.md`、`src/client/components/ProtocolsPanel.tsx` |
| 集成方（组织者） | `src/server/apiRoutes.ts`、`src/server/index.ts`、`src/client/App.tsx`、`src/client/components/tabNav.ts`、`src/client/components/TabPanel.tsx`、`docs/INDUSTRIAL-READINESS-PLAN.md`、`README*`、`package.json` |

并行硬规则：

- **只改上表里属于你的文件**。共享文件（`package.json`、`apiRoutes.ts`、`index.ts`、
  `App.tsx`、`tabNav.ts`、`TabPanel.tsx`、README、计划文档）一律不碰。
- 不为本任务新增 npm 依赖（环境离线；现依赖已够）：OPC UA 用"协议语义 + 可插拔传输"，
  Modbus 用 `node:net` 自己拼帧。
- 不执行 `git commit` / `git stash` / `git checkout` / `git restore`；工作树里所有改动
  都是本批次待统一提交的内容。
- 测试只跑**自己的测试文件**（`npx vitest run tests/<你的>.test.ts`），不要跑全量——
  其它执行单元正在写文件，全量失败不代表你的代码错。
- `npx tsc --noEmit` 可能报别人文件里的错误：只看你负责的文件，别人的在最终消息里列出即可。
- 提交前自查：`npx eslint <你的文件>`、`npx prettier --check <你的文件>`。
- 每个执行单元最终消息必须给出：改了哪些文件、新增测试名与数量、跑过的命令与结果、
  文档路径、**未做项/现场依赖**、以及"是否已做完"的明确标注。

## 8. 与现场验收门的关系

本契约只覆盖"代码内可验证"的部分。真实 PLC 接入、水厂参数标定、SIS/ESD 认证、
法定报表签字一律以 `docs/INDUSTRIAL-READINESS-PLAN.md` 第 6 节为准，不得在代码或文档里
宣称已完成。WP8 交付的是适配层 + 模拟服务器 + 契约测试；WP5 在没有现场观测数据时
只给算法与合成数据验证，并在输出里显式标 `dataSource: 'synthetic'`。

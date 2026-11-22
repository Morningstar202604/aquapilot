# WP7 资产与运维（设备状态 · 故障码 · 维护工单 · 备机 · ESD）

> 版本：2026-11-23 · 归属工作包：WP7 · 代码：`src/sim/assets.ts`、`src/sim/maintenance.ts`、
> `src/server/routes/assets.ts`、`src/client/components/AssetsPanel.tsx`、`tests/assets.test.ts`

## 1. 边界与定位

本包把设备从「拓扑图标 + 几个汇总功率数字」推进到**单台设备可仿真的运行状态**：
单台设备的运行状态、故障码、检修工单、备机切换、ESD 安全位，以及按组/单元计算的可用性因子。

**本包交付：**

- 资产注册表（从拓扑派生）、设备状态机、故障码与严重度、健康度退化；
- N+1 备机延时自启、全厂/单元级 ESD 锁存与显式复位；
- 预防性维护计划（运行时数 / 日历天双触发）、工单生命周期、检修不可用与健康度恢复；
- 只读路由 `/api/assets`、`/api/assets/:id` 与只读面板 `AssetsPanel`；
- 纯 JSON 可序列化状态，可进快照与审计。

**本包不做（见第 11 节未做项）：** 不直接改 `networkEngine`——可用性因子如何乘到泵/风机能力、
备机自启如何影响 DO，由后续 WP4 集成方在引擎步内调用本包接线点完成。本包只提供接线点函数与口径。

## 2. 设备派生（注册表）

`assetRegistryFromTopology(topo)` 按单元种类派生单台设备。台数优先解析单元 `meta`
（`×N`、`N 用 M 备`），解析不到走类别默认值。

| 拓扑单元 kind | 设备类别 | 默认台数 | 默认主机/备机 | 额定口径（工程假设） |
|---|---|---|---|---|
| `screening` | 提升泵 `pump` | 4 | 3 用 1 备 | 500 m³/h · 22 kW |
| `anaerobic` | 潜水搅拌器 `mixer` | 4 | 4 用 | 4 kW |
| `anoxic` | 潜水搅拌器 `mixer` | 2 | 2 用 | 5.5 kW |
| `blower` | 离心风机 `blower` | 3 | 2 用 1 备 | 6000 m³(air)/h · 110 kW |
| `chemical` | 加药泵 `dosing_pump` | 3 | 3 用 | 2 m³/h · 1.5 kW |
| `clarifier` | 刮泥机 `scraper` | 2 | 2 用 | 1.1 kW |
| `thickener` | 浓缩机 `thickener` | 1 | 1 用 | 3 kW |
| `dewatering` | 离心脱水机 `dewatering` | 2 | 2 用 | 30 m³/h · 37 kW |

默认拓扑（澄川 A²/O）派生 **21 台**设备。设备 `id` 形如 `<category>-<unitId>-<序号>`，
冗余组 `groupId = <unitId>:<category>`。

## 3. 设备状态机

### 3.1 状态定义

| 状态 | 含义 | 是否可用 |
|---|---|---|
| `running` | 主机运行 | 是（按健康度 × 降容系数折算） |
| `standby` | 备机待命（N+1 备用位） | 否（待命不计运行时数） |
| `fault` | 故障停机，**锁存**，需显式复位 | 否 |
| `maintenance` | 检修中，**不可用** | 否 |
| `esd_tripped` | ESD 安全位，**锁存**，需显式复位 | 否 |

### 3.2 显式转换白名单

| 从 \ 到 | running | standby | fault | maintenance | esd_tripped |
|---|---|---|---|---|---|
| running | — | ✔ | ✔ | ✔ | ✔ |
| standby | ✔ | — | ✘ | ✔ | ✔ |
| fault | ✔（故障复位） | — | — | ✔ | ✔ |
| maintenance | ✔（工单完工） | — | — | — | ✔ |
| esd_tripped | ✘ | ✘ | ✘ | ✘ | — |

两条硬锁存规则：

- **故障锁存**：进入 `fault` 后 `faultLatched = true`，不会随时间自恢复；
  必须显式调用 `resetAssetFault` 清除。
- **ESD 锁存**：进入 `esd_tripped` 后 `esdLatched = true`，状态机白名单里没有任何
  自动出口；必须显式调用 `resetEsd` 复位。ESD 位上拒绝故障注入与故障复位。

每次状态变化写入 `events[]`：`{ atMin, from, to, code, detail }`，进审计。

## 4. 故障码表

| 故障码 | 标签 | 严重度 | 出现概率（/运行小时） | 健康度惩罚 | 降容系数 |
|---|---|---|---|---|---|
| `BEARING_OVERHEAT` | 轴承过热 | 降容 `derate` | 0.00020 | 8 | 0.60 |
| `SEAL_LEAK` | 密封泄漏 | 停机 `stop` | 0.00008 | 15 | 0 |
| `MOTOR_OVERLOAD` | 电机过载 | 停机 `stop` | 0.00010 | 12 | 0 |
| `VIBRATION_HIGH` | 振动高 | 锁存 `latch` | 0.00006 | 20 | 0 |
| `CONTROL_FAULT` | 控制回路故障 | 锁存 `latch` | 0.00005 | 10 | 0 |

严重度语义：

- `derate`：不跳闸，继续运行但能力按降容系数折算；故障码仍锁存，需复位清除；
- `stop`：跳闸停机，同组备机按 N+1 逻辑顶替；
- `latch`：跳闸停机且锁存，备机顶替，复位前不得自恢复。

故障两个入口：

1. **显式注入**：事件 `{ type: 'injectFault', assetId, code }`（测试 / 场景脚本使用）；
2. **概率滚动**：每运行小时按上表概率独立判定，随机源走 `state.seed`（mulberry32），
   同 seed 可复现。可通过 `state.defaults.enableProbabilisticFaults = false` 关闭。

> 概率值是工程假设，未用现场故障台账标定；真实故障率见第 11 节。

## 5. N+1 备机逻辑

1. 主机发生 `stop` / `latch` 故障后，在同组内寻找可用备机：
   状态 `standby`、健康度 > 0、未 ESD 锁存、未故障锁存；
2. 找到后备机登记启动延时 `standbyAvailableAtMin = 当前时刻 + standbyStartDelayMin`
   （默认 **5 min**，工程假设）；
3. 时间推进到延时到期，备机自启 → `running`，`startCount + 1`，
   事件码 `BACKUP_AUTOSTART`；能力按备机额定能力计入组可用能力；
4. 备机不可用（故障 / 检修 / ESD / 健康为 0）则不顶替，整组按剩余主机折算；
   主机全停且无可用备机时，组可用性因子为 **0**（对应 `ASSET_UNAVAILABLE` 语义，
   由路由/引擎层解释）。

**恢复比例口径**：备机自启后，组可用能力 = 剩余主机额定能力 + 备机额定能力；
因子 = 可用能力 ÷ 主机额定能力。默认拓扑风机/提升泵备机与主机同额定，
一台主机故障后备机顶替，组能力恢复到 100%；若备机额定低于主机，按其额定折算。

## 6. ESD（紧急停车）

- `triggerEsd(state, { unitId? })`：不传 `unitId` 为**全厂级**；传 `unitId` 为**单元级**。
  匹配设备全部进入 `esd_tripped` 并锁存，清除待启动备机定时器；
- `resetEsd(state)`：**显式**复位，解除锁存，设备回到角色位（主机 `running`、备机 `standby`），
  记录 `resetAtMin`；ESD 状态 `{ active, scope, unitId, triggeredAtMin, resetAtMin }` 进审计；
- ESD 期间故障注入被拒绝，故障复位不能退出 ESD 位。

## 7. 健康度（Condition Index）

健康度 `health` 取值 0–100，初始 100。

**运行退化**（仅 `running` 状态计时）：

```text
health(t+dt) = health(t) − (100 / designLifeH) × (dtMin / 60)
```

`designLifeH` 为分类别额定设计寿命（见第 10 节默认参数表）。停机、待命、检修、ESD 期间不计磨损。

**故障惩罚**：注入故障时按故障码 `healthPenalty` 扣减（见第 4 节）。

**维护恢复**：工单完工后 `health = 100`，`lastMaintenanceMin` 重置；
故障复位**不**恢复健康度——健康度只能由检修工单恢复。

单台当前能力折算：

```text
assetFactor = (health / 100) × derateFactor        // 仅 running 状态；其余为 0
```

## 8. 维护工单

### 8.1 预防性触发（双触发，先到为准）

| 触发口径 | 判定 |
|---|---|
| 运行时数 | `(runtimeMin − lastMaintenanceMin) / 60 ≥ runtimeH` |
| 日历天数 | `(timeMin − lastMaintenanceMin) / 1440 ≥ calendarD` |

任一越限即自动生成 `preventive` 工单（`open` 待派工）。已有未闭环工单的设备不重复派工。

### 8.2 工单生命周期

```text
open（待派工） → in_progress（检修中） → completed（已完工）
                    └─ 超过 plannedDurationMin 未完工 → overdue（逾期标记）
open 超过 plannedDurationMin 未开工 → overdue
```

- **开工**：设备进入 `maintenance`，检修期间不可用；同组备机按第 5 节顶替；
- **完工**：登记 `downtimeMin`（开工→完工实际停机时长），健康度恢复 100，
  设备回到角色位；备件清单 `parts` 按类别默认登记（库存管理未做）；
- 工单字段：`id, assetId, kind, status, reason, createdAtMin, startedAtMin,
  completedAtMin, plannedDurationMin, downtimeMin, dueRuntimeH, dueCalendarD, parts, overdue`。

## 9. 可用性因子

```text
capacityFactorFor(state, key)   // key = groupId 或 unitId，返回 0–1
```

```text
组额定能力 R = Σ 主机额定能力（无主机时取全组）
可用能力 A = Σ 额定能力 × assetFactor（仅 running 计入）
factor = clamp(A / R, 0, 1)
```

- 匹配不到组、或资产子系统未启用（`state = null` / 无设备）时返回 **1**
  （旧快照兼容：缺字段视为子系统未启用，不拖累引擎）；
- 路由层另提供组视图 `groupAvailability`：主机数、备机数、运行数、不可用数、组因子。

## 10. 引擎接线点签名

> 集成方（WP4 / 组装方）在引擎步内调用以下纯函数；本包不反向引用 `networkEngine`。

```ts
// src/sim/assets.ts
export interface AssetPlantState { /* 见第 2/3/8 节字段，纯 JSON 可序列化 */ }

/** 从拓扑创建资产子系统状态（旧快照缺该字段时按 null 处理，不抛错） */
export function createAssetStateFromTopology(
  topo: ProcessTopology,
  opts?: { seed?: number; timeMin?: number; standbyStartDelayMin?: number },
): AssetPlantState;

/** 推进一个时间步：应用事件 → 累计时数/退化 → 备机自启 → 概率故障 → 维护到期/逾期 */
export function tickAssets(
  state: AssetPlantState,
  dtMin: number,
  events?: AssetInEvent[],
): AssetPlantState;

/** 组/单元可用性因子（0–1），供引擎把泵/风机能力乘上去 */
export function capacityFactorFor(
  state: AssetPlantState | null | undefined,
  key: string,
): number;

/** 故障锁存复位；未知 id / 未锁存返回 false */
export function resetAssetFault(state: AssetPlantState, assetId: string): boolean;

/** ESD 触发（全厂或单元级），设备进安全位并锁存 */
export function triggerEsd(state: AssetPlantState, scope?: { unitId?: string }): void;

/** ESD 显式复位，解除锁存并恢复角色位 */
export function resetEsd(state: AssetPlantState): void;

// src/sim/maintenance.ts
export function createWorkOrder(state, assetId, kind, reason, atMin): WorkOrder | null;
export function startWorkOrder(state, orderId, atMin): WorkOrder | null;
export function completeWorkOrder(state, orderId, atMin): WorkOrder | null;
```

事件类型 `AssetInEvent`：

```ts
| { type: 'injectFault'; assetId: string; code: string }
| { type: 'esdTrigger'; unitId?: string }
| { type: 'esdReset' }
| { type: 'faultReset'; assetId: string }
| { type: 'workOrderCreate'; assetId: string; kind?: WorkOrderKind; reason?: string }
| { type: 'workOrderStart'; workOrderId: string }
| { type: 'workOrderComplete'; workOrderId: string }
```

路由接线点（`apiRoutes.ts` 由集成方接入，本包不改）：

```ts
// src/server/routes/assets.ts
export function assetsRoute(
  pathname: string,
  url: URL,
  input: { state: AssetPlantState | null },
): { status: number; body: unknown } | null;
```

## 11. 默认参数来源（工程假设，非现场台账）

下列数值在代码内给可配置默认值，**均为工程假设**，用于让仿真可跑、行为可测；
现场验收门要求用真实设备台账 / CMMS 数据标定：

| 参数 | 默认值 | 位置 |
|---|---|---|
| 备机启动延时 | 5 min | `state.defaults.standbyStartDelayMin` |
| 提升泵额定 | 500 m³/h · 22 kW | `KIND_SPECS` |
| 风机额定 | 6000 m³(air)/h · 110 kW | `KIND_SPECS` |
| 各类保养周期 / 寿命 / 计划时长 / 备件 | 见 `MAINTENANCE_DEFAULTS` | `src/sim/maintenance.ts` |
| 故障概率 / 健康惩罚 / 降容系数 | 见第 4 节 | `FAULT_CODES` |

## 12. 未做项（代码内不冒充完成）

- **CMMS / EAM 对接**：工单为仿真内对象，不连真实维修管理系统；
- **备件库存**：`parts` 仅登记类别默认备件名，无库存数量、领用与缺货逻辑；
- **真实故障率标定**：故障概率为工程假设，未用现场故障记录 / MTBF 标定；
- **真实检修周期与停机时长**：保养周期、计划时长来自经验值，非现场台账；
- **引擎能力折算落地**：`capacityFactorFor` 已就绪，但泵/风机能力、DO 响应如何
  乘上该因子由 WP4 集成；本包未改 `networkEngine`；
- **SIS/ESD 认证**：仿真联锁可做，安全仪表系统认证、法定联锁矩阵与 SIL 评级不在代码内；
- **工单派发流程**：无排班、无人员、无审批流；开工/完工由事件显式驱动。

## 13. 测试与验收

```bash
npx vitest run tests/assets.test.ts
npx eslint src/sim/assets.ts src/sim/maintenance.ts src/server/routes/assets.ts \
  src/client/components/AssetsPanel.tsx tests/assets.test.ts
npx prettier --check src/sim/assets.ts src/sim/maintenance.ts src/server/routes/assets.ts \
  src/client/components/AssetsPanel.tsx tests/assets.test.ts
```

覆盖：注册表与拓扑一致性（21 台）、故障注入与锁存、复位恢复、备机延时自启与恢复比例、
备机不可用整组降容 0、ESD 全厂/单元级锁存与复位、运行时数与日历天双触发、检修不可用、
健康度下降与完工回升、逾期标记、未知设备错误路径（`ASSET_NOT_FOUND`）、
24 h 时间推进集成、纯 JSON 序列化往返。

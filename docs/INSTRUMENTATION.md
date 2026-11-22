# WP4 仪表、执行机构与控制层（纯模型 + 引擎接线）

> 版本：2026-11-23 · 归属工作包：WP4 · 代码：`src/sim/instruments.ts`、
> `src/sim/actuators.ts`、`src/sim/controlLayer.ts`；引擎接线：`src/sim/networkEngine.ts`、
> `src/sim/networkTypes.ts`、`src/shared/protocol.ts`、`src/server/snapshotView.ts`、
> `src/server/routes/instruments.ts` · 测试：`tests/instruments.test.ts`、
> `tests/actuators.test.ts`、`tests/controlLayer.test.ts`、`tests/instrumentationEngine.test.ts`
>
> 第 1–11 节为第一阶段纯模型口径；第 12 节为第二阶段引擎/快照/路由接线现状。

## 1. 边界与定位

第一阶段只交付**与引擎解耦的纯模型模块和单元测试**：传感器测量链、执行机构
速率/饱和/失效模型、PID 回路、联锁矩阵与 ESD、指令审计。本阶段**没有改引擎、
没有接快照字段、没有接路由与面板**；第二阶段接线（引擎步内调用、快照投影、
`/api/instruments` 与 `/api/control/interlocks` 只读端点）由集成方另行通知后续写。

**现状缺陷（本包要解决的问题）：** 旧回路直接读反应器真值（`doLevel`），报警
也读真值；没有探头滞后、死时间、漂移、故障卡死，没有阀位/风机速率限制，没有
联锁与 ESD 命令边界。结果是仿真里"AI 调 DO"永远有效，而现场可能读到一个卡死
的探头。本阶段把**测量值与真值分开**：控制器和报警只能读仪表读数与质量码，真值
只作为测量链输入。

**本包交付：**

- 传感器链：真值 → 死时间 FIFO → 一阶滞后 → seeded 噪声 → 漂移/偏置 → 量程与质量码判定；
- 故障注入：stuck / drift / dropout / spike / out-of-range；
- 执行机构：阀门、泵-VFD、风机的速率限制、死区、失效安全位、可用性因子折减；
- 控制层：通用位置式 PID（输出限幅、抗积分饱和、手动/自动无扰、微分滤波），
  DO→风机、RAS→回流比、WAS→排泥比三个回路；
- 联锁矩阵：触发锁存、显式复位、回差（hysteresis）；ESD 安全位与手动指令拒绝；
- 被拒绝/被限幅/被覆盖指令的审计队列，供 WP8 写入边界复用。

**本包不做（见第 10 节未做项）：** 真实仪表标定、SIS/ESD 认证、冗余表决、
PLC/DCS 闭环投运。

## 2. 测量链框图（文字）

```text
反应器/二沉池真值（只作输入，不进控制层）
        │
        ▼
┌─────────────────┐
│ 死时间 FIFO      │  deadTimeMin 内读数保持旧值；样本到期才进入下一环节
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ 一阶滞后 τ       │  lag += (delayed − lag)·(1 − e^(−dt/τ))
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ seeded 噪声      │  独立 PRNG 状态随注册表序列化；同 seed 同序列可复现
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ 漂移/偏置累计    │  driftOffset += driftPerDay · (dt/1440)
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ 量程 / 质量码判定 │  good / uncertain / bad + 原因 + 错误码
└─────────────────┘
        │
        ▼
  读数 { measured, quality, reason, code, atMin, sensorId }
```

## 3. 传感器规格与默认参数（工程假设）

每台仪表登记：`id`、所属 `unitId`、变量、量程 `min/max`、滞后时间常数 `tauMin`、
死时间 `deadTimeMin`、噪声标准差 `noiseStd`、漂移率 `driftPerDay`、故障模式。

| 变量 | 量程 | τ (min) | 死时间 (min) | 噪声 std | 漂移率 (/天) | 说明 |
|---|---|---|---|---|---|---|
| `do` | 0–12 mg/L | 0.5 | 0.3 | 0.08 | 0.05 | 膜式/光学 DO 探头 |
| `nh` | 0–60 mg/L | 2 | 1 | 0.3 | 0.2 | 氨氮在线仪 |
| `no3` | 0–30 mg/L | 2 | 1 | 0.2 | 0.15 | 硝氮在线仪 |
| `mlss` | 0–8000 mg/L | 5 | 2 | 200 | 120 | 浊度/污泥浓度计 |
| `flow` | 0–5000 m³/h | 1 | 0.5 | 30 | 20 | 流量计 |
| `level` | 0–6 m | 1 | 0.5 | 0.05 | 0.01 | 液位计 |
| `ph` | 4–10 | 2 | 1 | 0.05 | 0.02 | pH 电极 |
| `temperature` | 0–40 ℃ | 5 | 1 | 0.1 | 0.05 | 温度探头 |
| `pressure` | 0–1 bar | 1 | 0.5 | 0.02 | 0.005 | 风压/压力 |
| `tp` | 0–20 mg/L | 3 | 1 | 0.1 | 0.05 | 总磷 |
| `tn` | 0–60 mg/L | 3 | 1 | 0.3 | 0.2 | 总氮 |

以上数值是**工程假设**，量级参照市政污水厂常见在线仪表，不是本厂标定值。现场
必须以仪表台账（探头型号、校准记录、响应时间、年漂移）替换；第二阶段在注册表
`overrides` 字段按 `sensorId` 覆盖。

拓扑派生规则（`createInstrumentRegistry`）：好氧池挂 DO/NH/NO3/MLSS，缺氧池挂
NH/NO3，厌氧池挂 NH/TP，二沉池挂液位/MLSS，风机挂压力/风量，进水挂流量/pH/
温度，出水挂流量/NH/TN。

## 4. 故障模式与质量码

### 4.1 故障模式

| 模式 | 行为 | 读数 | 质量码 | 错误码 |
|---|---|---|---|---|
| `none` | 正常测量链 | 滞后+噪声+漂移 | good/uncertain | — |
| `stuck` | 探头卡死，首次延迟值冻结，之后不再跟随 | 恒定冻结值 | bad | `SENSOR_FAULT_ACTIVE` |
| `drift` | 偏置随时间按漂移率累计 | 真值 + 累计偏置 | good（偏差可见但未判故障） | — |
| `dropout` | 掉线 | `null` | bad | `SENSOR_FAULT_ACTIVE` |
| `spike` | 单点跳变，下一帧恢复正常链 | 延迟值 ± 跳变幅度 | uncertain | `SENSOR_FAULT_ACTIVE` |
| `out-of-range` | 注入超量程故障 | 推到量程外 | bad | `SENSOR_FAULT_ACTIVE` |

### 4.2 质量码语义

| 质量码 | 含义 | 控制/报警口径（第二阶段） |
|---|---|---|
| `good` | 测量在量程内、无故障 | 可进闭环与报警判定 |
| `uncertain` | 超量程、单点跳变等可信度不足 | 报警可提示，闭环应降权或切手动 |
| `bad` | 卡死、掉线、故障激活、信号缺失、非有限值 | 禁止进闭环；按仪表失效处理 |

量程判定：读数 `< min` 或 `> max` 时给 `SENSOR_OUT_OF_RANGE`；信号缺失或非有限值
直接 bad，不补默认值。任何读数不输出 NaN/Infinity。

## 5. 执行机构模型

### 5.1 三类机构

| 机构 | 指令口径 | 约束 | 功率口径 |
|---|---|---|---|
| 阀门 `valve` | 开度 %（0–100） | 速率限制 %/min、死区、失效位 | — |
| 泵 `pump` | 转速比例 0–1 | 爬坡、最小/最大转速 | 相似定律 P ∝ n³：`pumpPowerKw = ratedKw · ratio³` |
| 风机 `fan` | 负荷比例 0–1 | 爬坡、容量上限、喘振下限 | 近似 P ∝ n²：`fanPowerKw = ratedKw · ratio²` |

### 5.2 指令结果与错误码

每条指令返回 `accepted / clamped / rejected` + 错误码 + 人可读原因：

| 结果 | 触发 | 错误码 |
|---|---|---|
| `accepted` | 指令在死区外、速率内、量程内且设备可用 | — |
| `clamped` | 越界钳位、超速率爬坡、可用性折减后上限、风机拉回喘振下限 | `ACTUATOR_SATURATED` |
| `rejected` | NaN/Infinity 非法指令 | `ACTUATOR_INVALID_INPUT` |
| `rejected` | 可用性因子 ≤ 0.02（故障/检修/ESD） | `ACTUATOR_UNAVAILABLE` |

可用性因子 0–1 由集成方从资产模块 `capacityFactorFor` 传入；缺省 1（子系统未启用，
不拖累引擎）。因子对折减后上限有效：`effMax = min + (max − min) · factor`；
因子 0 时指令被拒，不静默落到 0。

### 5.3 失效安全位

| 失效模式 | 安全位 |
|---|---|
| `fail-open` | 上限（阀全开） |
| `fail-closed` | 下限（阀全关/泵停） |
| `lock` | 保持当前位置 |

## 6. PID 回路

### 6.1 回路与默认参数（工程假设）

| 回路 | 过程量 | 设定值 | 输出范围 | kp | ki | kd | 积分限幅 |
|---|---|---|---|---|---|---|---|
| `do` | DO mg/L | 2.0 | 0–1（风机负荷） | 0.6 | 0.15 | 0.05 | 10 |
| `ras` | 回流比 ×Q | 0.8 | 0.3–1.5 | 0.5 | 0.10 | 0 | 5 |
| `was` | 排泥比 ×Q | 0.0085 | 0.002–0.03 | 0.4 | 0.08 | 0 | 0.05 |

### 6.2 控制律与保护

- **位置式 PID**：输出 = kp·e + ki·∫e + kd·de/dt；微分基于测量值，避免设定值
  阶跃造成微分冲击；微分项经一阶滤波（`dFilterTauMin`）。
- **输出限幅**：结果钳到 `[outMin, outMax]`。
- **抗积分饱和（条件积分）**：输出已顶到上限且误差仍在推高饱和（或顶到下限且
  误差仍为负）时，积分项保持不继续累计。测试证据：持续正误差饱和两步后，
  积分项第二步与第一步相等（不增长）。
- **手动/自动无扰切换**：手动 → 自动时把积分锚定到当前手动输出，输出不突跳；
  手动模式下积分不推进。
- 化学加药回路（PAC/碳源/碱度）本阶段只留回路结构扩展位，不投运。

## 7. 联锁矩阵与 ESD

### 7.1 默认联锁条件（工程假设阈值）

| 条件 | 度量 | 动作阈值 | 回差 | 动作 |
|---|---|---|---|---|
| `do-low` | DO 低 | DO < 1.0 mg/L | 0.3 mg/L | 风机拉满（`fanMax`） |
| `nh-high` | 氨氮高 | NH > 30 mg/L | 3 mg/L | 加大曝气（`fanMax`） |
| `blanket-high` | 泥位高 | 泥位 > 3.5 m | 0.3 m | RAS 拉满（`rasMax`） |
| `fan-fault` | 风机故障 | 布尔 | — | 跳闸（`trip`） |
| `level-high` | 液位高 | 液位 > 5.5 m | 0.3 m | 停止进水（`stopInflow`） |
| `esd` | ESD | 布尔 | — | 跳闸（`trip`） |

### 7.2 锁存、回差与复位

- **触发锁存**：条件越限即 `tripped + latched`，即使条件恢复也保持动作，必须
  显式 `resetInterlock` 复位。
- **回差**：模拟量条件退回到阈值 ± 回差之外才置 `armed`（允许复位）。例如
  `do-low` 动作阈值 1.0 mg/L，复位阈值 1.3 mg/L：DO 回到 1.2 仍不允许复位，
  回到 1.4 才允许。布尔型故障（风机故障、ESD）不允许靠信号自然恢复。
- **ESD**：接收资产模块 ESD 状态后，全部回路输出进安全位（下限），锁存直到
  显式 `resetEsd`；ESD 期间手动指令一律拒绝并留审计。
- **优先级**：ESD > 跳闸联锁 > 动作联锁（fanMax/rasMax/stopInflow）> PID 输出。
  联锁/ESD 覆盖 PID 输出时，审计记录原始 PID 值、覆盖后实际值与原因。

## 8. 指令审计

被拒绝、被限幅、被联锁/ESD 覆盖的指令进审计队列（最多 200 条，先进先出），
条目含：时刻、回路、请求值、实际值、状态、错误码、原因。队列状态纯 JSON 可
序列化；第二阶段给 WP8 写入边界与只读路由复用。

错误码口径与 `docs/INDUSTRIAL-INTERFACES.md` 第 5 节一致：
`SENSOR_OUT_OF_RANGE`、`SENSOR_FAULT_ACTIVE`、`ACTUATOR_SATURATED`、
`INTERLOCK_TRIPPED`；本包另用 `ACTUATOR_INVALID_INPUT`、`ACTUATOR_UNAVAILABLE`、
`ESD_ACTIVE` 作为模块内补充码，集成时映射到 WP7/WP8 口径。

## 9. 第二阶段接线点（函数签名）

引擎步内按下列顺序调用；本阶段不接引擎，签名在此冻结，避免合并时字段/函数
各起一套名字。

```ts
// 仪表
createInstrumentRegistry(topo: ProcessTopology | null, opts?: RegistryOptions): InstrumentRegistry
addInstrument(registry: InstrumentRegistry, spec: InstrumentSpec): void
measure(registry: InstrumentRegistry, truth: Record<string, number>, dtMin: number): InstrumentReading[]
instrumentView(registry: InstrumentRegistry): { seed: number; timeMin: number; instruments: [...] }

// 执行机构
createValve(id: string, unitId: string, opts?: FactoryOpts): ActuatorState
createPump(id: string, unitId: string, opts?: FactoryOpts): ActuatorState
createFan(id: string, unitId: string, opts?: FactoryOpts): ActuatorState
commandActuator(state: ActuatorState, request: number, dtMin: number, availability?: number): ActuatorCommandResult
pumpPowerKw(state: ActuatorState, speedRatio: number): number
fanPowerKw(state: ActuatorState, airflowRatio: number): number
failSafePosition(state: ActuatorState): number

// 控制层
createControlLayer(opts?: ControlLayerOptions): ControlLayerState
evaluateInterlocks(layer: ControlLayerState, inputs: InterlockInputs, dtMin: number): void
stepLoop(layer: ControlLayerState, key: LoopKey, measurement: number, dtMin: number): LoopStepResult
setManualOutput(layer: ControlLayerState, key: LoopKey, value: number): boolean
resetInterlock(layer: ControlLayerState, conditionId: string): boolean
triggerEsd(layer: ControlLayerState, unitId?: string | null): void
resetEsd(layer: ControlLayerState): void
applyEsdState(layer: ControlLayerState, esd: Pick<EsdState, 'active' | 'unitId'>): void
controlLayerView(layer: ControlLayerState): Record<string, unknown>
```

第二阶段落地情况见第 12 节：引擎步内测量链、快照三字段、只读路由、资产因子
折减均已接线；化学加药回路仍未投运。

## 10. 参数来源与现场验收门

- 所有仪表精度、漂移率、死时间、PID 增益、联锁阈值与回差都是**工程假设**，
  代码给可配置默认；现场参数必须由仪表台账、历史运行数据、联锁因果表替换。
- 对照 `docs/INDUSTRIAL-READINESS-PLAN.md` 第 6 节：真实标定、SIS/ESD 认证、
  PLC/DCS 闭环投运属于现场验收门，本包不宣称已完成。

## 11. 未做项

- 真实仪表标定与现场置信区间（依赖历史数据，WP5 口径）；
- SIS/ESD 安全等级认证、因果表 SIL 校核（依赖安全评估）；
- 冗余仪表表决（二取一/二取二/三取二）与仪表比对诊断；
- 仪表维护周期、校准工单与资产模块的联动；
- 执行机构与网络水力学（WP3）流量/扬程的耦合；
- RAS/WAS 自动模式回路输出回写回流/排泥比，阀门/泵逐台进流量折减（当前仅
  风机进曝气容量回路，RAS/WAS 默认手动直通 `controls`）；
- AI 推演快照 `networkSnapshot()` 的 `lastDo` 仍读反应器真值（`plantModel.ts`
  不在本阶段授权边界，留待后续改为测量值）。

## 12. 第二阶段：引擎 / 快照 / 路由接线

### 12.1 每步接线时序（`stepNetwork` 内）

```text
stepNetwork(state, topo, dtMin)
  1. 懒初始化：旧快照缺 instruments / controlLayer / assets 时补默认理想实例
  2. tickAssets(assets, dtMin)                 // 故障降容、备机延时自启、健康退化
  3. blowerFactor = capacityFactorFor(assets, 'blower:blower')
  4. aerationCapacity = aerationCapacityOf(scenario, timeMin) × blowerFactor
  5. 组装真值 truth{do/nh/no3/mlss/flow/level/ph/temperature/pressure/tn}
  6. readings = measure(registry, truth, dtMin)   // 控制层/告警只读 readings
     truth 保留在 state.instruments.truth，仅供 /api/instruments 诊断差值
  7. applyEsdState(controlLayer, assets.esd)      // 资产 ESD 单向同步进控制层
  8. evaluateInterlocks(layer, {do, nh, blanket, level, fanFault, esd}, dtMin)
  9. stepLoop(do / ras / was, 测量值, dtMin)
 10. 联锁/ESD 覆盖回流比与进水；风机指令：ESD 或跳闸→0，fanMax→1，否则场景容量
 11. commandActuator(fan, fanCommand, dtMin, blowerFactor) → 回写 aerationCapacity
 12. 告警 lastDo 取测量值（坏探头回退真值，避免 NaN）
```

### 12.2 测量与真值分离

- 真值只在第 5 步作为 `measure` 输入；PID、联锁、告警、健康度、裕度估算一律读
  测量值（`measuredValue`：bad/掉线回退传真值兜底，uncertain 仍给测量值）。
- 快照与路由同时给出 `measured` 与 `truth`，差值可见；控制回路拿不到真值 map。

### 12.3 联锁与 ESD 对真实物理量的影响

| 动作 | 物理路径 |
|---|---|
| `fanMax`（DO 低 / NH 高） | 风机指令拉到 1 → KLa/风量上限 → 好氧池 DO 回升 |
| `rasMax`（泥位高） | RAS 回路输出拉到上限 → 回流比增大 → 二沉池泥位下降 |
| `stopInflow`（液位高） | `inflowStopped` 置位，进水支路按停进处理 |
| `trip`（风机故障 / ESD） | 全部回路输出进安全位（下限），风机指令 0，RAS 停回流 |

- 触发即锁存；条件退回回差之外只置 `armed`，必须显式 `resetInterlock` 复位；
  布尔型故障（风机故障、ESD）不能靠信号自然恢复。
- **联锁默认不介入物理回路**：`controlLayer.interlocksEnabled = false` 时，联锁
  条件照常求值、状态与审计留痕，但不覆盖 PID 输出、不改执行机构/回流/进水；
  测试与投运时 `enableInterlocks(layer, true)` 启用覆盖。这是默认零扰动的关键
  开关（启动瞬态 DO 波动不应被联锁锁存放大）。
- ESD 独立于联锁开关：资产模块 `triggerEsd/resetEsd` 单向同步进控制层，ESD
  期间执行机构进安全位、手动指令拒绝并写 `ESD_ACTIVE` 审计。

### 12.4 资产可用性因子

- 组键 `${unitId}:${category}`，风机组 `blower:blower`（2 用 1 备）。
- 组因子 = Σ(额定能力 × 单台因子) ÷ 主机额定能力；单台因子 = health/100 ×
  derateFactor，非 `running` 计 0；组内无设备返回 1（不拖累引擎）。
- 容量链路：场景剩余供气能力 × 资产因子，再经风机执行机构爬坡/死区/可用性
  折减；主机停机后备机按 `standbyStartDelayMin`（默认 5 min）自启。
- 故障码降容：`BEARING_OVERHEAT` derate 0.6；`SEAL_LEAK`/`MOTOR_OVERLOAD`/
  `VIBRATION_HIGH`/`CONTROL_FAULT` 停机率 0。

### 12.5 快照字段（全量帧与增量帧同源）

`PlantSnapshot` 与 `SnapshotPatch` 均带可选字段：

| 字段 | 视图 | 内容 |
|---|---|---|
| `instruments?` | `instrumentationView` | 测点 measured/truth/质量码/原因/错误码/故障模式/时刻 |
| `controlLayer?` | `controlLayerView` | 回路输出、模式、设定值、积分项、联锁状态、ESD、审计 |
| `assets?` | `assetView` | 设备台数、ESD 状态、分组可用性 |

投影函数独立可测；全量帧 `liveFrame` 与增量帧 `buildPatchBody` 共用同一投影，
不会出现一帧有字段、另一帧缺失。旧快照缺字段时投影给 `undefined`，不抛错。

### 12.6 只读路由（纯函数，接线在 `apiRoutes.ts`）

| 路径 | 入参 | 返回 |
|---|---|---|
| `GET /api/instruments` | `?sensor=<id>`（可选） | 测点清单；单测点诊断；空参 400、未知测点 404 |
| `GET /api/control/interlocks` | `?condition=<id>`（可选） | 回路输出、联锁状态、ESD、审计、资产分组；未知联锁 404 |

`instrumentsRoute(pathname, url, { state })` 返回 `RouteReply | null`：本模块不
处理的路径返回 `null` 交调用方 404；函数不读模块全局、不开定时器。

### 12.7 默认零扰动策略（基线口径）

为保证既有数值测试逐位不变，默认实例全部取直通/理想口径：

- 仪表 `ideal: true`：τ=0、死时间 0、噪声 0、漂移 0，测量值与真值逐位一致，
  质量码 good；
- 执行机构速率足够大（风机 `rateLimitPerMin=100`）、可用性因子 1，指令直通；
- 回路默认手动，初始输出直通 `controls.rasRatio / wasRatio`，PID 不接管；
- 联锁覆盖默认禁用；ESD 默认未触发；资产全部 running、健康满格。

故障、偏差、联锁动作、ESD 只在测试或显式注入时出现。

### 12.8 第二阶段接线点（已落地签名）

```ts
// 子状态
createInstrumentationState(topo, opts?: RegistryOptions): InstrumentationState
createControlLayer(opts?: ControlLayerOptions): ControlLayerState
createAssetStateFromTopology(topo, opts?): AssetPlantState

// 步进与读取
measure(registry, truth, dtMin): InstrumentReading[]
measuredValue(state, sensorId, fallback): number
readingOf(state, sensorId): InstrumentReading | undefined
tickAssets(state, dtMin, events?): AssetPlantState
capacityFactorFor(state, key): number
evaluateInterlocks(layer, inputs, dtMin): void
stepLoop(layer, key, measurement, dtMin): LoopStepResult
commandActuator(fan, request, dtMin, availability?): ActuatorCommandResult
enableInterlocks(layer, enabled: boolean): void
applyEsdState(layer, esd): void

// 投影与路由
instrumentationView(state): InstrumentationSnapshot
controlLayerView(layer): ControlLayerSnapshot
groupAvailability(state): AssetGroupView[]
instrumentsRoute(pathname, url, input): RouteReply | null
```

### 12.9 本阶段未做项（第二阶段遗留）

- RAS/WAS 自动模式输出回写回流/排泥比；阀门、泵逐台进流量/扬程折减与饱和码；
- 化学加药回路（PAC/碳源/碱度）投运；
- `plantModel.networkSnapshot()` 已改为读测量值（集成层完成）；
- 真实标定、SIS/ESD 认证、冗余表决、仪表比对诊断（见第 11 节）。

### 12.10 测点覆盖（与模型能力对齐）

只登记引擎能给出真值的点，避免“仪表全红”的假故障：进水 flow/pH/温度；厌氧 NH；缺氧 NH/NO₃；好氧 DO/NH/NO₃/MLSS；二沉池泥位/回流 MLSS；鼓风机压力/风量；出水 flow/NH/TN。筛网、沉砂、初沉、消毒、加药、储池等单元暂不挂测点——引擎没有对应物理量，宁可不测，也不注册一个永远 `bad signal_lost` 的假探头。默认 25 个测点，理想仪表下全部 `good`。

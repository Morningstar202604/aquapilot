> 状态注（0.0.25）：服务运行时已接入真实 MQTT 3.1.1 订阅与真实 Modbus TCP 轮询/写入；本文第 7、8 节保留 0.0.17 进程内模拟适配层的历史边界，当前能力以 `docs/V2-0.0.25.md` 与 `docs/CUTOVER.md` 为准。OPC UA 仍为 `unsupported`，现场设备验收仍未做。

# WP8 工业接口：协议适配层与模拟服务器

> 版本：2026-11-23
> 归属：WP8（文件清单见 `docs/INDUSTRIAL-INTERFACES.md` 第 7 节）
> 定位：代码内可验证的**适配层 + 契约 + 模拟器**；真实 PLC 联调单列现场验收门，不在本包冒充完成。

## 1. 本包交付了什么

系统对外原本只有 HTTP + WebSocket，没有工业协议语义。WP8 在引擎与现场之间加一层
可测试的协议适配层：

- **标签映射表**：内部仿真量 ↔ OPC UA 节点 ID / Modbus 保持寄存器 / MQTT topic，
  含数据类型、工程单位、量程缩放、只读/可写策略、坏值处理；
- **适配层**：连接状态机、指数退避重连（带抖动、带上限）、读写接口、质量码、时标、
  写边界校验与写入审计；
- **三种传输语义**：
  - OPC UA：会话 / 浏览 / 读 / 写 / 订阅的**语义层** + 可插拔 Transport 接口 +
    进程内模拟服务器；
  - Modbus TCP：`node:net` 自实现功能码 03 / 04 / 06 / 16 的帧编解码与真实
    本地 TCP 模拟服务器；
  - MQTT：发布/订阅 JSON 载荷 + 进程内模拟 broker（QoS0 / QoS1 去重标记、保留消息）；
- **只读路由**：标签表、通道状态、最近写入审计；
- **测试**：映射往返、未知标签、坏质量传播、退避序列、写白名单与审计、Modbus 真实
  socket 往返、MQTT 发布订阅、OPC UA 模拟服务器读写订阅、真引擎快照 → 标签解析 → 协议读取集成断言。

## 2. 标签命名规范

### 2.1 内部标签 ID

稳定主键，审计与路由使用，格式 `<域>.<量>`：

- `reactor1.<量>`：第一座好氧池测量值（DO / NH / COD / NO3 / TP / 温度 / 碱度）；
- `influent.<量>`：进水；`effluent.<量>`：出水；`energy.<量>`：能耗；
- `pump.<量>`：派生设备状态；`control.<量>`：可写控制量。

### 2.2 三种协议地址

| 协议 | 地址格式 | 示例 |
|---|---|---|
| OPC UA | `ns=2;s=Aquapilot.<域>.<量>` | `ns=2;s=Aquapilot.Reactor1.DO` |
| Modbus TCP | 保持寄存器 4xxxx（1 基，偏移 = 寄存器号 − 40001） | `40001` |
| MQTT | `aquapilot/<域>/<量>` | `aquapilot/reactor1/do` |

- 标签表唯一真相在 `src/server/protocols/tags.ts`；新增现场量先登记地址、量程、
  读写策略，适配层不接受表外地址（返回 `PROTOCOL_TAG_UNKNOWN`）。
- Modbus 寄存器为 16 位有符号整数；工程量 → 原始整数按标签 `scale.rawPerUnit`
  缩放（`raw = round(unit × rawPerUnit)`），超量程或超出 int16 范围编码为 `null`。
- 数据类型：`float32`（缩放进寄存器）、`int16`、`bool`（0/1）。

### 2.3 量程与坏值处理

- 每条标签声明 `unitMin / unitMax`；内部值非有限（NaN / Infinity）解析为 `null`；
- 读值超量程：质量码 `uncertain`；内部量缺失/非有限：质量码 `bad`；
- 任何 API 与协议响应都不出现 NaN / Infinity（对齐接口契约第 2 节）。

## 3. 质量码语义

| 质量码 | 含义 | 典型原因 |
|---|---|---|
| `good` | 值可用，在量程内，通道在线 | 正常采样 |
| `uncertain` | 值可用但存疑，不宜直接进闭环 | 超量程；通道 degraded |
| `bad` | 值不可用，禁止冒充实时数据 | 通道断开且无缓存；内部量缺失/非有限；节点不存在 |

- 每条样本带 ISO 时标；断开期间读返回**缓存值 + `bad` 质量码**，不允许把上一次
  好值标注成实时好值；无缓存时返回 `null` 坏值。
- 质量码随 OPC UA 数据值、MQTT 载荷元数据一并带出；Modbus 侧质量由适配层在
  进入寄存器之前判定，寄存器本身不携带质量位。

## 4. 连接状态机与重连参数

状态机：`connecting → connected → degraded → disconnected`。

- 传输层上报中断：`connected → degraded`，立即安排一次重连；
- 重连失败：进入 `disconnected`，按退避序列安排下一次；
- 重连成功：回到 `connected`，清零失败计数。

退避参数（`adapter.ts` `DEFAULT_BACKOFF`，可注入覆盖）：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `baseMs` | 1000 ms | 首次重连等待 |
| `factor` | 2 | 指数因子 |
| `maxMs` | 30000 ms | 单次等待上限 |
| `jitter` | 0.2 | 抖动幅度，实际等待 = 基数 × (1 ± jitter/2) |

第 n 次等待 = `min(maxMs, baseMs × factorⁿ) × (1 ± 抖动)`；时钟与随机源可注入，
测试用假时钟断言间隔递增与上限截断。写传输带超时（默认 5000 ms），超时留痕为
`timeout` 审计结果。

## 5. 写入边界与审计

### 5.1 写前校验顺序

1. **标签存在**：表外标签拒绝，`PROTOCOL_TAG_UNKNOWN`；
2. **通道在线**：断开拒绝，`PROTOCOL_DISCONNECTED`；
3. **鉴权**：写操作最低角色 `operator`（与 WebSocket 控制消息口径一致），
   权限不足拒绝，`PROTOCOL_WRITE_DENIED`；
4. **白名单**：只读测量标签拒绝写入，`PROTOCOL_WRITE_DENIED`；
5. **量程校验**：非有限值或超出 `[unitMin, unitMax]` 拒绝，`PROTOCOL_WRITE_DENIED`；
6. **写频校验**：同一标签两次写入间隔小于 `writeMinIntervalMs`（可配置，0 为关闭）
   拒绝，`PROTOCOL_WRITE_DENIED`；
7. **传输确认**：传输层 NACK 或超时分别留痕 `denied` / `timeout`；
8. 全部通过后才落到内部控制量，并记一条 `success` 审计。

### 5.2 审计形状

每次写尝试（成功 / 拒绝 / 超时 / 未知标签 / 断开）落一条记录：

| 字段 | 含义 |
|---|---|
| `seq` | 单调递增序号 |
| `at` / `atMin` | 墙钟 ISO 时标 / 仿真分钟 |
| `actor` / `role` | 操作者标识与角色（未鉴权为 `anonymous`） |
| `protocol` | `opcua` / `modbus` / `mqtt` |
| `tag` / `address` | 内部标签 ID 与协议侧地址 |
| `requestedValue` | 写入请求值 |
| `result` | `success` / `denied` / `timeout` / `unknown_tag` / `disconnected` |
| `reason` / `code` | 人可读原因 / `PROTOCOL_*` 错误码 |

审计为进程内环形缓冲（默认 500 条）；持久化入库由集成方接线既有 Store，WP8 不直接
写数据库。只读查询走 `GET /api/protocols/audit?limit=`（上限 500，非法数字 400）。

## 6. 错误码

| 错误码 | 触发 |
|---|---|
| `PROTOCOL_DISCONNECTED` | 通道断开；写传输超时 |
| `PROTOCOL_TAG_UNKNOWN` | 标签 / 地址不在映射表 |
| `PROTOCOL_WRITE_DENIED` | 非白名单写入、只读策略拒绝、权限不足、超量程 |

错误响应形状：`{ "error": "人可读原因", "code": "UPPER_SNAKE_CODE" }`。

## 7. 模拟服务器用法

三种模拟服务器都运行在**进程内**：不提供独立常驻端口或启动命令，
只在自动化测试与服务进程内接线时实例化；Modbus 服务器虽走真实 TCP socket，
但仅绑定 127.0.0.1 临时端口，测试结束即关闭。

### 7.1 测试方式（离线、进程内）

```bash
# 只跑 WP8 自己的测试（不跑全量）
npx vitest run tests/protocols.test.ts tests/modbus.test.ts
```

覆盖项：标签双向映射、量程缩放往返、未知标签错误、NaN/超量程质量码、断开缓存坏值、
退避序列递增与上限、写白名单 / 鉴权 / 量程 / 写频拒绝与审计条数、MQTT 发布订阅 / QoS1 去重 /
保留消息 / 通配符、OPC UA 模拟服务器读 / 写 / 订阅、Modbus 真实 socket 功能码往返。

集成链路分两层：

- `tests/protocols.test.ts`：状态视图夹具上的协议契约断言（隔离引擎内部变动）；
- `tests/protocolsEngine.test.ts`：**真引擎**链路——`createNetworkState` →
  `spinUpNetwork(…, 2)` → `stepNetwork(…, 1)`，经 `protocolStateFromNetwork`
  投影后读标签，好氧池 DO / 进水流量 / 出水 NH / 总功率逐项与引擎状态一致；
  断线后同一批标签降级为 bad 质量码。

### 7.2 Modbus TCP 模拟服务器

- `ModbusTcpSimServer.start()` 只监听 **127.0.0.1** 随机端口；传入非回环地址直接抛错；
- 功能码：03 读保持寄存器、04 读输入寄存器、06 写单寄存器、16 写多寄存器；
  异常码 01 非法功能 / 02 非法地址 / 03 非法值；
- 测试结束 `server.close()` 销毁全部 socket，不长期占端口；
- 内存寄存器表可替换为自定义 `ModbusRegisterMap` 实现。

### 7.3 OPC UA 模拟服务器

- `SimulatedOpcUaServer` 实现 `OpcUaTransport` 接口：`open / close / read / write /
  subscribe / browse`；订阅建立时先推送一次当前值；引擎节拍推进后可 `publish`
  主动下发变更通知；
- `SemanticOpcUaSession` 封装会话开闭状态，关闭后再调用读 / 写 / 订阅抛错；
- 取值可注入 resolver（节点 ID → 引擎实时值），resolver 优先于本地缓存。

### 7.4 MQTT 模拟 broker

- `InMemoryMqttBroker`：topic 精确匹配 + `#` 前缀通配；QoS0 直接派发；QoS1 带
  packetId，去重窗口内重复 packetId 标记 `dup` 且不重复投递；
- 保留消息按 topic 留存，新订阅者上线即收到一次；客户端 `disconnect()` 摘除全部
  订阅；不做跨进程持久化与会话恢复（clean session 口径）。

### 7.5 路由（纯函数，接线由集成方完成）

`src/server/routes/protocols.ts` 导出 `protocolsRoute(pathname, url, input)`：

| 路径 | 说明 |
|---|---|
| `GET /api/protocols/tags` | 标签表（地址 / 类型 / 单位 / 量程 / 读写策略） |
| `GET /api/protocols/status` | 各通道状态；`?channel=<protocol>` 指定通道断开时 503 + `PROTOCOL_DISCONNECTED` |
| `GET /api/protocols/audit?limit=` | 最近写入审计 |

路由为纯函数，不读模块全局、不开定时器；在 `apiRoutes.ts` 中的接线由集成方统一做，
WP8 不修改 `apiRoutes.ts`。

## 8. 明确未做项（边界声明）

- **未实现 OPC UA 二进制协议栈**：没有 Hello / OpenSecureChannel / Publish 报文交互，
  没有节点树地址空间建模，没有信息模型编译；本包只有会话 / 浏览 / 读 / 写 / 订阅的
  语义形状；
- **未做 OPC UA 安全策略协商**：没有签名 / 加密 / 证书签发 / 用户身份令牌策略；
- **未连接任何外部 MQTT broker**：broker 为进程内实现，无网络握手、无 TLS；
- **未接真实 PLC / DCS / SCADA**：Modbus 服务器只在 127.0.0.1 内存表上往返；
- 未做 Modbus RTU 串行链路、未做 TLS 网关、未做读写锁之外的并发控制；
- 审计只在进程内环形缓冲，未落数据库；历史长期留存依赖集成方接既有 Store；
- 标签表是仿真口径，不代表任何现场 PLC 的真实点表。

## 9. 真实 PLC 接入所需现场清单（现场验收门）

以下输入全部属于现场条件，代码内无法承诺；对齐 `INDUSTRIAL-READINESS-PLAN.md`
第 6 节：

1. **PLC / 控制系统清单**：厂商型号、固件版本、支持的协议（OPC UA / Modbus TCP /
   MQTT）、点位数量与寄存器分布；
2. **现场点表**：每个测点的真实地址、数据类型、工程单位、量程、报警上下限，与本包
   仿真标签逐一对照映射；
3. **网络分区与连通性**：控制网 / 监控网分区、防火墙策略、端口、路由、时钟同步；
4. **读写权限边界**：哪些点允许远程写、哪些只读；操作员 / 工程师 / 管理员角色划分；
5. **安全评估**：OPC UA 安全策略（签名 / 加密 / 证书）、MQTT TLS 与认证、网络隔离、
   闭环写入的联锁与人工确认机制；
6. **联调记录**：读写往返核对、质量码与现场仪表一致性、断线重连实测、审计留痕核对；
7. **现场数据标定**：仪表偏差、量程漂移、采样口径（不在本包代码范围内）。

在上述清单齐备并完成现场联调之前，对外表述应为"提供协议适配层与模拟契约"，
不得宣称"已接入真实 PLC"或"已支持 OPC UA 通信"。

## 10. 与其他工作包的关系

- 协议层只依赖最小状态视图 `ProtocolStateView`（反应器 / 进水 / 出水 / 控制量 /
  能耗），不绑定引擎完整内部结构；`fromNetworkState.ts` 负责把 `NetworkSimState`
  逐字段投影成该视图；WP2/WP3/WP4 调整内部状态时，协议层口径不受冲击；
- 控制量写入最终落到 `controls` 字段，与 WebSocket 控制消息共用同一套控制边界；
- 合规报表（WP6）、资产状态（WP7）不经过本包写入路径。

# WP3 水力学与多系列：模型边界与口径

> 版本：2026-11-23
> 归属：`src/sim/hydraulics.ts`、`src/sim/network.ts`、`src/sim/networkEngine.ts`、
> `src/sim/networkTypes.ts`、`src/server/routes/hydraulics.ts`、`src/shared/protocol.ts`、
> `src/server/snapshotView.ts`。

## 1. 这一层做什么

WP3 把「两条支路平分流量」的占位实现换成阻力驱动的水力求解，并补上管渠容积、
输运延迟、泵/阀/堰特性与多二沉池系列：

1. **阻力分流**：同一节点的各支路按下游阻力分配流量，支路损失水头相等
   `h = Rᵢ Qᵢ²`，因此 `Qᵢ ∝ 1/√Rᵢ`，总流量守恒。阀门开度不同、管径不同，
   份额就不同；等阻力时退化为均分，旧拓扑行为不变。
2. **管渠容积与输运延迟**：每条水力边有容积、停留时间、实际流速；边内按
   N 段串联 CSTR 传递保守组分（COD/NH/NO₃/TP/SS）与示踪剂，给出停留时间分布。
3. **泵/阀/堰**：泵 H-Q 二次曲线带转速折算与超曲线判定；阀门 Cv/开度带全关
   判定；矩形薄壁堰与 90° V 形三角堰 Q-H 带溢流判定。饱和/不可解状态显式落
   错误码，不出 NaN、不凭空造流量。
4. **多系列**：编译期按二沉池向上回溯反应器链，每条系列有自己的链、二沉池与
   RAS/WAS 回流标签；`NetworkSimState.clarifier` 保持向后兼容（首池/汇总口径），
   新增 `clarifiers` 与 `hydraulics`。

## 2. 单位口径（与契约 §2 一致）

| 量        | 单位 | 备注                                   |
| --------- | ---- | -------------------------------------- |
| 流量      | m³/h | 与进水、回流比口径一致                 |
| 容积      | m³   | 池容、管段容积                         |
| 浓度      | mg/L | 示踪剂同为 mg/L（= g/m³）              |
| 质量      | kg   | 示踪剂存量/排出                        |
| 时间      | min  | 仿真步长；RTD 矩以 min 计              |
| 水头/扬程 | m    | 沿程损失、阀局部损失、泵扬程、堰上水头 |
| 管径      | mm   | 几何输入；内部计算换算为 m             |
| 流速      | m/s  | 实际流速 = 流量/截面积                 |

快照与 API 响应中不允许出现 NaN / Infinity；求解失败走错误码。

## 3. 几何参数来源与默认假设

`Connection` 本身没有 meta（现状契约），边几何从**起点单元 meta** 读取，缺省再取
**终点单元 meta**；都没有时用编译期确定性默认。识别的 meta 键：

| meta 键          | 含义                        | 默认                     |
| ---------------- | --------------------------- | ------------------------ |
| `lengthM`        | 管渠长度 m                  | 6 m                      |
| `diameterMm`     | 管径 mm；0 = 按目标流速反推 | 反推                     |
| `roughnessMm`    | 管壁粗糙度 mm               | 0.5 mm（新钢/PE 管量级） |
| `targetVelocity` | 设计目标流速 m/s            | 1.2（合同区间 1.0–1.5）  |
| `valveOpen`      | 阀门开度 0–1                | 1（全开）                |
| `valveCv`        | 阀门额定 Cv                 | 120                      |
| `pumpRpm`        | 泵实际转速 rpm              | 1450                     |
| `pumpHead0`      | 额定转速关死扬程 m          | 18                       |
| `pumpK`          | H-Q 二次曲线系数            | 2.4e-5                   |
| `weirWidthM`     | 堰顶宽度 m                  | 1.0                      |
| `weirType`       | `rectangular` / `v-notch`   | rectangular              |

- 无几何信息时，按目标流速 `v = 1.2 m/s` 由设计流量反推管径：
  `D = √(4Q/(πv))`，管径钳制在 100–2000 mm。
- 沿程阻力用 Swamee-Jain 摩擦因子（层流退回 64/Re）；水运动黏度取 20 ℃
  `1.004e-6 m²/s`。
- 这些默认值是**工程量级兜底**，不是现场标定结果；见第 7 节未做项。

## 4. 设备特性

### 泵

```
H(Q) = H₀·(n/n₀)² − K·Q²
```

- 转速折算按相似定律（扬程 ∝ 转速平方）；
- 曲线交点流量为能力上限 `Q_max = √(H₀·(n/n₀)²/K)`；
- 工作点 `Q > Q_max` 记 `pump_over_curve`，支路流量按上限截流。

### 阀门

- 开度 `α ≤ 0.02` 视为全关（支路阻力无穷大，流量 0，状态 `closed`）；
- 局部阻力系数 `ζ = ζ₀/α²`，`ζ₀ = 2.5`；
- Cv 口径流量 `Q = Cv(α)·√ΔP`，`Cv(α) = Cv_max·α`。

### 堰

- 矩形薄壁堰：`Q = Cd·b·√(2g)·h^(3/2)`，`Cd = 0.62`；
- 90° V 形三角堰：`Q = Cd·(8/15)·√(2g)·h^(5/2)`；
- 堰上水深 > 0.5 m 记 `weir_overflow`。

## 5. 示踪剂与 RTD 方法

- 示踪剂在指定边脉冲注入（质量 kg），起始段浓度 `C = m·1000/V`（mg/L）；
- 边内 N 段串联 CSTR：`C′ⱼ = (Cⱼ + C′ⱼ₋₁/τⱼ)/(1 + 1/τⱼ)`，
  `τⱼ = V_seg/(Q·dt)`；段数 `N = clamp(round(θ/5 min), 1, 4)`；
- 出口响应在出水边（`effluent` 物流）记录历史曲线；
- 矩量计算：`τ = Σ t·C·dt / Σ C·dt`，`σ² = Σ t²·C·dt/ΣC·dt − τ²`；
- 质量守恒：注入量 = 管段存留 + 出口排出；残差由 `/api/hydraulics/tracer` 给出。

理想 N 段串联 CSTR 的解析口径：平均停留时间 `τ = V/Q`，方差 `σ² = τ²/N`。
测试用这个口径判定峰值时刻、平均停留时间与方差量级，不写死小数。

## 6. 多系列口径与限制

- 编译期：每个二沉池从进水边向上回溯反应器链，链内前向边与该池引出的
  RAS/内回流/WAS 边打上 `trainId`；
- `clarifiers[]` 逐池持有独立 Takács 十层剖面、泥层、xRas/xEff；
- 回流流量仍按全厂控制比（RAS = ras×Q 等）计算，按系列标签分别记账；
- **已知限制**：多系列之间的固体分配、各池独立进料浓度暂取全厂末端池口径，
  系列间物料平衡归 WP2（ASM2d/ADM1 全厂边界）；本包只保证各池状态独立、
  回流标签独立、流量可观测。

## 7. 未做项（不冒充完成）

- **没有真实管网标定**：管径、长度、粗糙度、泵曲线、堰宽均来自 meta 或默认
  兜底，不是厂区 CAD/现场实测；阻力分流的绝对份额需要现场水力校核。
- **没有泵实测曲线**：H-Q 是二次近似，不含汽蚀、并联串联工况、变频效率曲线。
- **未做管网平差**：本包是支路阻力分配，不是闭环管网节点压力求解；
  没有压损平衡迭代、没有并联泵组联动。
- **组分输运耦合有限**：边内保守组分缓冲随上游池浓度推进，但反应器主物料
  平衡仍按流量加权混合（与 BSM1 标定口径一致）；边延迟默认量级很小，
  稳态结果不受影响，动态组分延迟的全厂耦合留待 WP2。
- **现场验收门**：真实 PLC 接入、SIS/ESD、法定报表签字见
  `INDUSTRIAL-READINESS-PLAN.md` 第 6 节，不在本包代码承诺内。

## 8. 可观测口径

- 状态：`NetworkSimState.hydraulics?: HydraulicState`；
- 快照：`PlantSnapshot.hydraulics` 与 `SnapshotPatch.hydraulics` 同名字段，
  全量帧与增量帧都下发；投影函数 `hydraulicView()` 独立导出，不埋在视图层
  匿名表达式里；
- API：`GET /api/hydraulics`、`GET /api/hydraulics?edge=<id>`、
  `GET /api/hydraulics/tracer`（纯路由函数，接线由集成方在 `apiRoutes.ts` 完成）；
- 错误码：`HYDRAULICS_INVALID_GEOMETRY`、`HYDRAULICS_UNSOLVABLE_SPLIT`、
  `HYDRAULICS_TRACER_OVERFLOW`。

## 9. Rust parity（v0.11.11）

- `rust/crates/aquapilot-core/src/hydraulics.rs` 按本文口径移植：阻力分流、
  沿程/阀/堰阻力、泵 H-Q、分段 CSTR、示踪剂 RTD、质量守恒账、系列聚合与快照。
- 黄金 `rust/golden/hydraulics-48h.json`：6 条边、48 个 1 min 步长，
  900/850/1000 m³/h 阶跃、进水 60 kg 示踪剂脉冲。
- `tests/hydraulics_parity.rs` 对纯函数、边字段、各段示踪剂/5 组分、RTD 与
  系列聚合逐项比对，相对容差 1e-12；`examples/hydraulics.rs` 为烟测入口。
- 边界仍同第 7 节：Rust 目前是模块级 parity，不是全厂同输入出水/库存/
  三本账对比，也不是闭环管网平差。

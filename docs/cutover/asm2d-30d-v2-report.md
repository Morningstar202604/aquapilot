# Experiment `03bd6c0a-d89c-4106-8f7c-1042842439ec` — ASM2d 30d cutover inventory/ledger

- Model: `asm2d`
- Status: `succeeded`
- Created: `1795886843`
- Updated: `1795886844`
- Progress: 100.0%

## Effluent (final state)

| Metric | Value | Unit |
|---|---:|---|
| cod | 85.3272 | mg/L |
| ss | 46.2965 | mg/L |
| nh4_n | 0.2187 | mg/L |
| tn | 12.3675 | mg/L |
| tp | 4.9482 | mg/L |
| po4_p | 3.0505 | mg/L |
| flow_m3_h | 1760.4000 | m3/h |
| do | 1.9998 | mg/L |

## Mass balance

```json
{
  "cod": {
    "closed": true,
    "effluent_kg": 109669.26617036224,
    "gas_kg": 0.0,
    "inflow_kg": 492480.000000376,
    "inventory_change_kg": -43369.83437591202,
    "oxidized_kg": 269158.5627768338,
    "residual_fraction": 0.022235576502007182,
    "unaccounted_kg": -10950.57671571686,
    "waste_kg": 167972.5821448088
  },
  "nitrogen": {
    "closed": true,
    "effluent_kg": 16148.785559937727,
    "gas_kg": 34711.97004515497,
    "inflow_kg": 56451.89580985063,
    "inventory_change_kg": -2736.7569830364773,
    "oxidized_kg": 0.0,
    "residual_fraction": 0.004987044399302043,
    "unaccounted_kg": 281.52811082849803,
    "waste_kg": 8046.369076965901
  },
  "note": "ASM2d COD/N/P ledger closed at the 5% threshold",
  "phosphorus": {
    "closed": true,
    "effluent_kg": 5838.946023019378,
    "gas_kg": 0.0,
    "inflow_kg": 10724.009639735614,
    "inventory_change_kg": -2038.2819406645983,
    "oxidized_kg": 0.0,
    "residual_fraction": 0.004588389938174642,
    "unaccounted_kg": 49.205937927850755,
    "waste_kg": 6874.139619452983
  }
}
```

## Scorecard

- Grade: **D** (effluent score 33.3/100, 2/6 limits passed)
- Mass balance closed: `true`; max residual: 2.22%
- Applicability: `effluent_compliance`

## Alarms

| Code | Severity | Scope | Message |
|---|---|---|---|
| `EFFLUENT_COD_HIGH` | high | effluent | COD 85.327 exceeds 50.0 mg/L |
| `EFFLUENT_SS_HIGH` | high | effluent | SS 46.296 exceeds 10.0 mg/L |
| `EFFLUENT_TP_HIGH` | high | effluent | TP 4.948 exceeds 0.5 mg/L |
| `EFFLUENT_PO4_P_HIGH` | high | effluent | PO4-P 3.051 exceeds 0.5 mg/L |

### Alarm explanations

- **`EFFLUENT_COD_HIGH`**
  - Evidence: 末次采样 minute=43200：COD=85.3272 mg/L；限值 50.0 mg/L。
  - Possible causes: 进水 COD 负荷或流量超过当前池容/曝气能力；好氧池 HRT 过短、KLa 不足或 DO 长期偏低；自由拓扑没有二沉池，生物量随出水流失
  - Recommended actions: 核对进水 COD 与流量，先做 1 d 短实验确认是否随负荷下降；检查好氧池池容、KLa、DO 设定与回流比；确认拓扑里有二沉池或等效固液分离单元
- **`EFFLUENT_SS_HIGH`**
  - Evidence: 末次采样 minute=43200：SS=46.2965 mg/L；限值 10.0 mg/L。
  - Possible causes: 自由拓扑缺少二沉池或过滤单元，悬浮固体直接穿透；污泥回流不足或排泥过量，生物量无法维持；进水 SS 过高或池体混合过强
  - Recommended actions: 先确认拓扑中二沉池/过滤单元是否存在并连接；检查 RAS 回流比、污泥浓度与排泥设置；若模型边界没有沉淀单元，应在报告中说明，不能把 SS 解释成处理失败
- **`EFFLUENT_TP_HIGH`**
  - Evidence: 末次采样 minute=43200：TP=4.9482 mg/L；限值 0.5 mg/L。
  - Possible causes: 生物除磷不足：厌氧段缺失、VFA 不足或 SRT 不匹配；化学除磷剂量不足或 PAC 投加点不合理；二沉池/污泥回流异常导致磷释放或穿透
  - Recommended actions: 先确认厌氧段与回流路径存在，且没有把 DO/NO3 带入厌氧区；核对 PAC 剂量与投加点，做 0/20/40 mg/L 小矩阵；检查剩余污泥排放是否正常，避免磷在系统内循环
- **`EFFLUENT_PO4_P_HIGH`**
  - Evidence: 末次采样 minute=43200：PO4-P=3.0505 mg/L；限值 0.5 mg/L。
  - Possible causes: 生物除磷不足：厌氧段缺失、VFA 不足或 SRT 不匹配；化学除磷剂量不足或 PAC 投加点不合理；二沉池/污泥回流异常导致磷释放或穿透
  - Recommended actions: 先确认厌氧段与回流路径存在，且没有把 DO/NO3 带入厌氧区；核对 PAC 剂量与投加点，做 0/20/40 mg/L 小矩阵；检查剩余污泥排放是否正常，避免磷在系统内循环

## Daily averages

| Period | Samples | COD | SS | NH4-N | TN | TP | DO min | Flow |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| day-1 | 24 | 197.103 | 148.474 | 1.435 | 19.382 | 6.990 | 0.243 | 1760.4 |
| day-2 | 24 | 85.847 | 48.489 | 0.055 | 13.271 | 2.599 | 2.016 | 1760.4 |
| day-3 | 24 | 86.761 | 48.250 | 0.059 | 13.288 | 2.726 | 2.008 | 1760.4 |
| day-4 | 24 | 86.677 | 48.040 | 0.064 | 13.181 | 2.831 | 2.005 | 1760.4 |
| day-5 | 24 | 86.481 | 47.854 | 0.069 | 13.088 | 2.950 | 2.004 | 1760.4 |
| day-6 | 24 | 86.290 | 47.690 | 0.076 | 13.007 | 3.116 | 2.002 | 1760.4 |
| day-7 | 24 | 86.120 | 47.544 | 0.083 | 12.937 | 3.412 | 2.001 | 1760.4 |
| day-8 | 24 | 85.979 | 47.413 | 0.091 | 12.875 | 3.969 | 2.001 | 1760.4 |
| day-9 | 24 | 85.873 | 47.294 | 0.100 | 12.819 | 4.692 | 2.000 | 1760.4 |
| day-10 | 24 | 85.797 | 47.186 | 0.110 | 12.769 | 5.237 | 2.000 | 1760.4 |
| day-11 | 24 | 85.739 | 47.089 | 0.119 | 12.723 | 5.480 | 1.999 | 1760.4 |
| day-12 | 24 | 85.691 | 47.002 | 0.129 | 12.683 | 5.524 | 1.999 | 1760.4 |
| day-13 | 24 | 85.650 | 46.923 | 0.139 | 12.647 | 5.481 | 1.999 | 1760.4 |
| day-14 | 24 | 85.613 | 46.853 | 0.148 | 12.616 | 5.411 | 1.999 | 1760.4 |
| day-15 | 24 | 85.580 | 46.789 | 0.157 | 12.587 | 5.340 | 1.999 | 1760.4 |
| day-16 | 24 | 85.551 | 46.732 | 0.165 | 12.562 | 5.274 | 1.999 | 1760.4 |
| day-17 | 24 | 85.524 | 46.680 | 0.173 | 12.539 | 5.217 | 1.999 | 1760.4 |
| day-18 | 24 | 85.500 | 46.633 | 0.179 | 12.519 | 5.169 | 1.999 | 1760.4 |
| day-19 | 24 | 85.477 | 46.590 | 0.185 | 12.500 | 5.128 | 1.999 | 1760.4 |
| day-20 | 24 | 85.457 | 46.551 | 0.191 | 12.483 | 5.093 | 1.999 | 1760.4 |
| day-21 | 24 | 85.439 | 46.516 | 0.195 | 12.467 | 5.064 | 1.999 | 1760.4 |
| day-22 | 24 | 85.422 | 46.483 | 0.199 | 12.453 | 5.040 | 1.999 | 1760.4 |
| day-23 | 24 | 85.406 | 46.454 | 0.203 | 12.440 | 5.020 | 2.000 | 1760.4 |
| day-24 | 24 | 85.392 | 46.427 | 0.206 | 12.428 | 5.004 | 2.000 | 1760.4 |
| day-25 | 24 | 85.379 | 46.402 | 0.209 | 12.416 | 4.990 | 2.000 | 1760.4 |
| day-26 | 24 | 85.368 | 46.379 | 0.211 | 12.406 | 4.978 | 2.000 | 1760.4 |
| day-27 | 24 | 85.357 | 46.358 | 0.213 | 12.396 | 4.969 | 2.000 | 1760.4 |
| day-28 | 24 | 85.348 | 46.339 | 0.215 | 12.387 | 4.961 | 2.000 | 1760.4 |
| day-29 | 24 | 85.339 | 46.321 | 0.217 | 12.379 | 4.955 | 2.000 | 1760.4 |
| day-30 | 25 | 85.331 | 46.304 | 0.218 | 12.371 | 4.950 | 2.000 | 1760.4 |

## Weekly averages

| Period | Samples | COD | SS | NH4-N | TN | TP | DO min | Flow |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| week-1 | 168 | 102.183 | 62.334 | 0.263 | 14.022 | 3.518 | 0.243 | 1760.4 |
| week-2 | 168 | 85.763 | 47.109 | 0.120 | 12.733 | 5.113 | 1.999 | 1760.4 |
| week-3 | 168 | 85.504 | 46.641 | 0.178 | 12.522 | 5.184 | 1.999 | 1760.4 |
| week-4 | 168 | 85.382 | 46.406 | 0.208 | 12.418 | 4.995 | 1.999 | 1760.4 |
| week-5 | 49 | 85.335 | 46.312 | 0.217 | 12.375 | 4.953 | 2.000 | 1760.4 |

## Data quality

- Samples: 721; finite: 721; duplicate minutes: 0
- Missing optional fields: `bod, ph, mlss`

## Reproduction

Submit the same `spec` body to `POST /api/v1/experiments` with the same
`Idempotency-Key` to replay this experiment, or omit the key to run it again.

## Request spec

```json
{
  "config": {
    "clarifier": {
      "area_m2": 4800.0,
      "depth_m": 4.5,
      "feed_layer": 5,
      "layers": 10,
      "ras_flow_m3_h": 1440.0,
      "ras_reactor": 0,
      "settling": {
        "a_per_g_per_m3": 0.0005,
        "b_per_g_per_m3": 0.001,
        "v_max_m_per_d": 240.0,
        "x_max_g_per_m3": 10000.0,
        "x_min_g_per_m3": 0.001
      },
      "was_flow_m3_h": 39.6
    },
    "influent": {
      "flow_m3_h": 1800.0,
      "state": {
        "sa": 30.0,
        "salk": 324.2537530814549,
        "sf": 100.0,
        "si": 30.0,
        "sn2": 0.0,
        "snh4": 31.858561581643432,
        "sno3": 0.0,
        "so": 0.0,
        "spo4": 4.874698796093777,
        "xaut": 0.0,
        "xh": 20.0,
        "xi": 50.0,
        "xmeoh": 0.0,
        "xmep": 0.0,
        "xpao": 0.0,
        "xpha": 0.0,
        "xpp": 0.0,
        "xs": 150.0
      }
    },
    "internal_recycles": [
      {
        "flow_m3_h": 3600.0,
        "from": 4,
        "to": 1
      }
    ],
    "name": "cutover-a2o-asm2d-30d",
    "reactors": [
      {
        "do_setpoint": 0.0,
        "id": "anaerobic",
        "initial": {
          "sa": 20.0,
          "salk": 250.0,
          "sf": 20.0,
          "si": 10.0,
          "sn2": 0.0,
          "snh4": 20.0,
          "sno3": 0.0,
          "so": 0.0,
          "spo4": 5.0,
          "xaut": 100.0,
          "xh": 1000.0,
          "xi": 1000.0,
          "xmeoh": 5.0,
          "xmep": 5.0,
          "xpao": 300.0,
          "xpha": 40.0,
          "xpp": 60.0,
          "xs": 200.0
        },
        "kind": "anaerobic",
        "kla_h": 0.0,
        "name": "厌氧池",
        "temperature_c": 20.0,
        "volume_m3": 3000.0
      },
      {
        "do_setpoint": 0.0,
        "id": "anoxic",
        "initial": {
          "sa": 20.0,
          "salk": 250.0,
          "sf": 20.0,
          "si": 10.0,
          "sn2": 0.0,
          "snh4": 20.0,
          "sno3": 3.0,
          "so": 0.1,
          "spo4": 5.0,
          "xaut": 100.0,
          "xh": 1000.0,
          "xi": 1000.0,
          "xmeoh": 5.0,
          "xmep": 5.0,
          "xpao": 300.0,
          "xpha": 40.0,
          "xpp": 60.0,
          "xs": 200.0
        },
        "kind": "anoxic",
        "kla_h": 0.0,
        "name": "缺氧池",
        "temperature_c": 20.0,
        "volume_m3": 4500.0
      },
      {
        "do_setpoint": 2.0,
        "id": "aerobic-1",
        "initial": {
          "sa": 20.0,
          "salk": 250.0,
          "sf": 20.0,
          "si": 10.0,
          "sn2": 0.0,
          "snh4": 20.0,
          "sno3": 2.0,
          "so": 2.0,
          "spo4": 5.0,
          "xaut": 100.0,
          "xh": 1000.0,
          "xi": 1000.0,
          "xmeoh": 5.0,
          "xmep": 5.0,
          "xpao": 300.0,
          "xpha": 40.0,
          "xpp": 60.0,
          "xs": 200.0
        },
        "kind": "aerobic",
        "kla_h": 8.0,
        "name": "好氧池 1",
        "temperature_c": 20.0,
        "volume_m3": 5750.0
      },
      {
        "do_setpoint": 2.0,
        "id": "aerobic-2",
        "initial": {
          "sa": 20.0,
          "salk": 250.0,
          "sf": 20.0,
          "si": 10.0,
          "sn2": 0.0,
          "snh4": 20.0,
          "sno3": 2.0,
          "so": 2.0,
          "spo4": 5.0,
          "xaut": 100.0,
          "xh": 1000.0,
          "xi": 1000.0,
          "xmeoh": 5.0,
          "xmep": 5.0,
          "xpao": 300.0,
          "xpha": 40.0,
          "xpp": 60.0,
          "xs": 200.0
        },
        "kind": "aerobic",
        "kla_h": 8.0,
        "name": "好氧池 2",
        "temperature_c": 20.0,
        "volume_m3": 5750.0
      },
      {
        "do_setpoint": 2.0,
        "id": "aerobic-3",
        "initial": {
          "sa": 20.0,
          "salk": 250.0,
          "sf": 20.0,
          "si": 10.0,
          "sn2": 0.0,
          "snh4": 20.0,
          "sno3": 2.0,
          "so": 2.0,
          "spo4": 5.0,
          "xaut": 100.0,
          "xh": 1000.0,
          "xi": 1000.0,
          "xmeoh": 5.0,
          "xmep": 5.0,
          "xpao": 300.0,
          "xpha": 40.0,
          "xpp": 60.0,
          "xs": 200.0
        },
        "kind": "aerobic",
        "kla_h": 8.0,
        "name": "好氧池 3",
        "temperature_c": 20.0,
        "volume_m3": 5750.0
      }
    ]
  },
  "dt_min": 1.0,
  "duration_min": 43200.0,
  "max_iterations": 0,
  "model": "asm2d",
  "name": "ASM2d 30d cutover inventory/ledger",
  "relaxation": 0.0,
  "sample_every_min": 60.0,
  "sludge_days": 30.0,
  "sludge_dt_days": 0.002
}
```

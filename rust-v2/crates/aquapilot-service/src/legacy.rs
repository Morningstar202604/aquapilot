//! Read-only projections for the old monitoring client.
//!
//! These endpoints intentionally return `compatibility` metadata. They are
//! derived from the newest durable experiment, not from a live tick: a client
//! must not treat them as a control-loop snapshot. Missing engine fields are
//! returned as `null` rather than invented numbers.

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::analysis::analyze;
use crate::error::ApiError;
use crate::store::{to_api_error, ExperimentRecord, Store};

fn legacy_limits() -> Value {
    json!({
        "cod": 50.0, "bod": 10.0, "ss": 10.0, "nh": 5.0, "tn": 15.0, "tp": 0.5,
        "phMin": 6.0, "phMax": 9.0
    })
}

pub fn latest_succeeded(store: &Store) -> Result<Option<ExperimentRecord>, ApiError> {
    let (records, _) = store.list(Some("succeeded"), 1, 0).map_err(to_api_error)?;
    Ok(records.into_iter().next())
}

pub fn latest_any(store: &Store) -> Result<Option<ExperimentRecord>, ApiError> {
    let (records, _) = store.list(None, 1, 0).map_err(to_api_error)?;
    Ok(records.into_iter().next())
}

pub fn snapshot(store: &Store) -> Result<Value, ApiError> {
    let Some(record) = latest_succeeded(store)? else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "NO_BASELINE",
            "No succeeded experiment",
            "run and complete at least one experiment before requesting the legacy snapshot",
        ));
    };
    let request: Value = serde_json::from_str(&record.request_json).unwrap_or(Value::Null);
    let config = request.get("config").cloned().unwrap_or(Value::Null);
    let result: Value = record
        .result_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or(Value::Null);
    let analysis = analyze(&record).and_then(|value| serde_json::to_value(value).ok());
    let influent = influent(&config);
    let effluent = effluent(&result);
    let controls = controls(&config);
    let margins = analysis
        .as_ref()
        .and_then(|value| value.get("scorecard"))
        .and_then(|value| value.get("limits"))
        .and_then(Value::as_array)
        .map(|limits| {
            limits
                .iter()
                .map(|limit| {
                    let key = match limit.get("metric").and_then(Value::as_str).unwrap_or("") {
                        "COD" => "cod",
                        "SS" => "ss",
                        "NH4-N" => "nh",
                        "TN" => "tn",
                        "TP" => "tp",
                        other => other,
                    };
                    let value = limit.get("value").and_then(Value::as_f64);
                    let max = limit.get("limit").and_then(Value::as_f64).unwrap_or(0.0);
                    json!({
                        "key": key,
                        "metric": limit.get("label").cloned().unwrap_or(json!(key)),
                        "ratio": value.map(|v| if max == 0.0 { f64::INFINITY } else { v / max }),
                        "value": value,
                        "limit": max,
                        "finite": value.map(f64::is_finite).unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let alarms = analysis
        .as_ref()
        .and_then(|value| value.get("alarms"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, alarm)| {
            json!({
                "id": format!("V2-{:04}", index + 1),
                "at": 0,
                "severity": alarm.get("severity").cloned().unwrap_or(json!("warning")),
                "code": alarm.get("code").cloned().unwrap_or(json!("V2_ALARM")),
                "message": alarm.get("message").cloned().unwrap_or(json!("")),
                "metric": alarm.get("metric").cloned().unwrap_or(Value::Null),
                "value": alarm.get("value").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    let scorecard = analysis
        .as_ref()
        .and_then(|value| value.get("scorecard"))
        .cloned()
        .unwrap_or(Value::Null);
    let score = scorecard.get("score").and_then(Value::as_f64);
    let grade = scorecard
        .get("grade")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let plants = config.get("trains").and_then(Value::as_array);
    let plant = json!({
        "name": config.get("name").and_then(Value::as_str).unwrap_or(&record.name),
        "model": record.model,
        "trains": plants.map(|trains| trains.len()).unwrap_or(1),
    });
    let tanks = tanks(&config, &result);
    let clarifier = clarifiers(&result);
    let finished_at = record.updated_at;
    Ok(json!({
        "timeMin": result.get("time_min").cloned().unwrap_or(json!(0.0)),
        "influent": influent,
        "effluent": effluent,
        "controls": controls,
        "scenario": null,
        "energy": {
            "blowerKw": Value::Null, "mixerKw": Value::Null, "pumpKw": Value::Null,
            "totalKw": Value::Null, "specificKwhM3": Value::Null
        },
        "srtDays": Value::Null,
        "fmRatio": Value::Null,
        "score": score,
        "margins": margins,
        "alarms": alarms,
        "activeAlarms": alarms,
        "alarmAttribution": {},
        "health": {"score": score, "grade": grade, "parts": []},
        "scorecard": scorecard,
        "massBalance": result.get("mass_balance").cloned().unwrap_or(Value::Null),
        "modelMode": record.model,
        "simulatedAt": crate::study::iso8601(finished_at),
        "speed": 1,
        "paused": false,
        "plant": plant,
        "tanks": tanks,
        "clarifier": clarifier,
        "limits": legacy_limits(),
        "compatibility": {
            "source": "latest-succeeded-experiment",
            "experimentId": record.id,
            "mode": "derived-read-only",
            "liveTick": false,
            "missing": ["energy", "srtDays", "fmRatio"],
            "note": "energy, SRT and F/M are not stored by the V2 engine; they are null rather than fabricated. Use the V2 experiment report for the complete analysis."
        }
    }))
}

pub fn topology(store: &Store) -> Result<Value, ApiError> {
    let Some(record) = latest_any(store)? else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "NO_BASELINE",
            "No experiment",
            "submit an experiment before requesting the translated topology",
        ));
    };
    let request: Value = serde_json::from_str(&record.request_json).unwrap_or(Value::Null);
    let config = request.get("config").cloned().unwrap_or(Value::Null);
    let topology = translate_topology(&record.name, record.model.as_str(), &config);
    Ok(json!({
        "topology": topology,
        "compatibility": {
            "source": "latest-experiment-request",
            "experimentId": record.id,
            "mode": "translated-read-only",
            "note": "This is a projection of the stored V2 config. Ports and meta fields are compatibility decoration; the engine uses the V2 model config directly."
        }
    }))
}

pub fn metrics(store: &Store, version: &str, uptime_seconds: u64) -> String {
    let active = store
        .list(None, 100, 0)
        .map(|(records, _)| {
            records
                .iter()
                .filter(|record| matches!(record.status.as_str(), "queued" | "running"))
                .count()
        })
        .unwrap_or(0);
    let studies = store
        .list_studies(100)
        .map(|items| items.len())
        .unwrap_or(0);
    format!(
        "# HELP aquapilot_v2_info AquaPilot V2 build information
# TYPE aquapilot_v2_info gauge
aquapilot_v2_info{{version=\"{version}\",compatibility=\"legacy-read-projection\"}} 1
# HELP aquapilot_queue_active Queued or running experiments
# TYPE aquapilot_queue_active gauge
aquapilot_queue_active {active}
# HELP aquapilot_queue_capacity Configured experiment queue capacity
# TYPE aquapilot_queue_capacity gauge
aquapilot_queue_capacity {}
# HELP aquapilot_studies Number of durable studies
# TYPE aquapilot_studies gauge
aquapilot_studies {studies}
# HELP aquapilot_uptime_seconds Process uptime
# TYPE aquapilot_uptime_seconds counter
aquapilot_uptime_seconds {uptime_seconds}
# NOTE per-route HTTP counters are not exposed by the V2 service; scrape the process supervisor for transport metrics.
",
        store.capacity()
    )
}

fn influent(config: &Value) -> Value {
    if let Some(unit) = config
        .get("units")
        .and_then(Value::as_array)
        .and_then(|units| {
            units
                .iter()
                .find(|unit| unit.get("type").and_then(Value::as_str) == Some("influent"))
        })
    {
        let water = unit.get("water").cloned().unwrap_or(Value::Null);
        return json!({
            "flow": unit.get("flow_m3_h").cloned().unwrap_or(Value::Null),
            "cod": water.get("cod").cloned().unwrap_or(Value::Null),
            "bod": Value::Null,
            "nh": water.get("nh4_n").cloned().unwrap_or(Value::Null),
            "tn": Value::Null,
            "tp": water.get("tp").cloned().unwrap_or(Value::Null),
            "ss": water.get("ss").cloned().unwrap_or(Value::Null),
            "temperature": water.get("temperature_c").cloned().unwrap_or(Value::Null),
            "alkalinity": water.get("alkalinity").cloned().unwrap_or(Value::Null),
            "ph": Value::Null,
        });
    }
    let state = config.get("influent").and_then(|value| value.get("state"));
    json!({
        "flow": config.pointer("/influent/flow_m3_h").cloned().unwrap_or(Value::Null),
        "cod": Value::Null,
        "bod": Value::Null,
        "nh": state.and_then(|value| value.get("snh4")).cloned().unwrap_or(Value::Null),
        "tn": Value::Null,
        "tp": state.and_then(|value| value.get("spo4")).cloned().unwrap_or(Value::Null),
        "ss": Value::Null,
        "temperature": Value::Null,
        "alkalinity": state.and_then(|value| value.get("salk")).cloned().unwrap_or(Value::Null),
        "ph": Value::Null,
    })
}

fn effluent(result: &Value) -> Value {
    let value = result.get("effluent").cloned().unwrap_or(Value::Null);
    json!({
        "flow": value.get("flow_m3_h").cloned().unwrap_or(Value::Null),
        "cod": value.get("cod").cloned().unwrap_or(Value::Null),
        "bod": value.get("bod").cloned().unwrap_or(Value::Null),
        "ss": value.get("ss").cloned().unwrap_or(Value::Null),
        "nh": value.get("nh4_n").cloned().unwrap_or(Value::Null),
        "tn": value.get("tn").cloned().unwrap_or(Value::Null),
        "tp": value.get("tp").cloned().unwrap_or(Value::Null),
        "ph": value.get("ph").cloned().unwrap_or(Value::Null),
        "temperature": value.get("temperature_c").cloned().unwrap_or(Value::Null),
    })
}

fn controls(config: &Value) -> Value {
    let reactors = config
        .get("reactors")
        .or_else(|| config.pointer("/plant/reactors"))
        .and_then(Value::as_array);
    let do_setpoint = reactors
        .and_then(|items| {
            items
                .iter()
                .find(|reactor| reactor.get("kind").and_then(Value::as_str) == Some("aerobic"))
        })
        .and_then(|reactor| reactor.get("do_setpoint"))
        .cloned()
        .unwrap_or(Value::Null);
    let flow = config
        .pointer("/influent/flow_m3_h")
        .and_then(Value::as_f64)
        .or_else(|| {
            config
                .get("units")
                .and_then(Value::as_array)
                .and_then(|units| {
                    units
                        .iter()
                        .find(|unit| unit.get("type").and_then(Value::as_str) == Some("influent"))
                })
                .and_then(|unit| unit.get("flow_m3_h").and_then(Value::as_f64))
        })
        .unwrap_or(0.0);
    let internal = config
        .get("internal_recycles")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("flow_m3_h").and_then(Value::as_f64))
        .or_else(|| {
            config
                .get("connections")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| {
                            item.get("recycle").and_then(Value::as_str) == Some("internal")
                        })
                        .and_then(|item| item.get("flow_m3_h").and_then(Value::as_f64))
                })
        });
    let ras = config
        .pointer("/clarifier/ras_flow_m3_h")
        .and_then(Value::as_f64)
        .or_else(|| {
            config
                .get("connections")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("recycle").and_then(Value::as_str) == Some("ras"))
                        .and_then(|item| item.get("flow_m3_h").and_then(Value::as_f64))
                })
        });
    let was = config
        .pointer("/clarifier/was_flow_m3_h")
        .and_then(Value::as_f64)
        .or_else(|| {
            config
                .get("connections")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("recycle").and_then(Value::as_str) == Some("was"))
                        .and_then(|item| item.get("flow_m3_h").and_then(Value::as_f64))
                })
        });
    let pac = config
        .pointer("/pac/dose_mg_l")
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "doSetpoint": do_setpoint,
        "internalRecirc": internal.map(|value| if flow > 0.0 { value / flow } else { 0.0 }).map(Value::from).unwrap_or(Value::Null),
        "rasRatio": ras.map(|value| if flow > 0.0 { value / flow } else { 0.0 }).map(Value::from).unwrap_or(Value::Null),
        "wasRatio": was.map(|value| if flow > 0.0 { value / flow } else { 0.0 }).map(Value::from).unwrap_or(Value::Null),
        "pacDose": pac,
        "carbonDose": 0.0, "alkDose": 0.0, "stormStore": 0.0, "stepFeed": 0.0,
        "aiEnabled": false
    })
}

fn tanks(config: &Value, result: &Value) -> Value {
    if let Some(reactors) = result.get("reactors").and_then(Value::as_array) {
        return Value::Array(
            reactors
                .iter()
                .map(|reactor| {
                    json!({
                        "id": reactor.get("id").cloned().unwrap_or(Value::Null),
                        "name": reactor.get("name").cloned().unwrap_or(Value::Null),
                        "kind": reactor.get("kind").cloned().unwrap_or(Value::Null),
                        "volumeM3": reactor.get("volume_m3").cloned().unwrap_or(Value::Null),
                        "flowM3h": reactor.get("flow_in_m3_h").cloned().unwrap_or(Value::Null),
                        "mlss": reactor.get("mlss").cloned().unwrap_or(Value::Null),
                        "do": reactor.get("do").cloned().unwrap_or(Value::Null),
                        "cod": reactor.get("cod").cloned().unwrap_or(Value::Null),
                        "nh": reactor.get("nh4_n").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect(),
        );
    }
    let _ = config;
    json!([])
}

fn clarifiers(result: &Value) -> Value {
    let Some(first) = result
        .get("clarifiers")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return Value::Null;
    };
    json!({
        "id": first.get("id").cloned().unwrap_or(Value::Null),
        "areaM2": first.get("area_m2").cloned().unwrap_or(Value::Null),
        "depthM": first.get("depth_m").cloned().unwrap_or(Value::Null),
        "feedFlowM3h": first.get("feed_flow_m3_h").cloned().unwrap_or(Value::Null),
        "overflowTss": first.get("overflow_tss").cloned().unwrap_or(Value::Null),
        "underflowTss": first.get("underflow_tss").cloned().unwrap_or(Value::Null),
        "rasFlowM3h": first.get("ras_flow_m3_h").cloned().unwrap_or(Value::Null),
        "wasFlowM3h": first.get("was_flow_m3_h").cloned().unwrap_or(Value::Null),
    })
}

pub fn history(store: &Store, limit: usize) -> Result<Value, ApiError> {
    let (records, _) = store
        .list(Some("succeeded"), limit, 0)
        .map_err(to_api_error)?;
    let items = records
        .iter()
        .map(|record| {
            let result: Value = record
                .result_json
                .as_deref()
                .and_then(|json| serde_json::from_str(json).ok())
                .unwrap_or(Value::Null);
            let analysis = analyze(record).and_then(|value| serde_json::to_value(value).ok());
            let score = analysis
                .as_ref()
                .and_then(|value| value.pointer("/scorecard/score"))
                .and_then(Value::as_f64);
            json!({
                "id": record.id,
                "name": record.name,
                "model": record.model,
                "timeMin": result.get("time_min").cloned().unwrap_or(Value::Null),
                "simulatedAt": crate::study::iso8601(record.updated_at),
                "effluent": effluent(&result),
                "score": score,
            })
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"items": items, "compatibility": {"source": "succeeded-experiments", "liveTick": false}}),
    )
}

fn translate_topology(name: &str, model: &str, config: &Value) -> Value {
    let units = if let Some(units) = config.get("units").and_then(Value::as_array) {
        units.clone()
    } else if let Some(reactors) = config
        .get("reactors")
        .or_else(|| config.pointer("/plant/reactors"))
        .and_then(Value::as_array)
    {
        reactors
            .iter()
            .map(|reactor| {
                json!({
                    "id": reactor.get("id").cloned().unwrap_or(Value::Null),
                    "kind": reactor.get("kind").cloned().unwrap_or(json!("reactor")),
                    "name": reactor.get("name").cloned().unwrap_or(Value::Null),
                    "role": "生物反应池",
                    "ports": [{"id":"in","kind":"in","stream":"mixed"},{"id":"out","kind":"out","stream":"mixed"}],
                    "states": ["flow","cod","nh","tp","ss","do","temperature"],
                    "meta": {
                        "volumeM3": reactor.get("volume_m3").cloned().unwrap_or(Value::Null),
                        "doSetpoint": reactor.get("do_setpoint").cloned().unwrap_or(Value::Null),
                        "klaH": reactor.get("kla_h").cloned().unwrap_or(Value::Null),
                    }
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let connections = if let Some(connections) = config.get("connections") {
        connections.clone()
    } else if let Some(reactors) = config
        .get("reactors")
        .or_else(|| config.pointer("/plant/reactors"))
        .and_then(Value::as_array)
    {
        let mut connections = Vec::new();
        for pair in reactors.windows(2) {
            connections.push(json!({
                "id": format!("{}-{}", pair[0].get("id").and_then(Value::as_str).unwrap_or("r"), pair[1].get("id").and_then(Value::as_str).unwrap_or("r")),
                "from": pair[0].get("id").cloned().unwrap_or(Value::Null),
                "to": pair[1].get("id").cloned().unwrap_or(Value::Null),
                "flow_m3_h": pair[0].get("flow_in_m3_h").cloned().unwrap_or(Value::Null),
            }));
        }
        if let Some(recycles) = config.get("internal_recycles").and_then(Value::as_array) {
            for recycle in recycles {
                connections.push(json!({
                    "id": "internal-recycle", "from": recycle.get("from").cloned().unwrap_or(Value::Null),
                    "to": recycle.get("to").cloned().unwrap_or(Value::Null),
                    "flow_m3_h": recycle.get("flow_m3_h").cloned().unwrap_or(Value::Null),
                    "stream": "recycle", "recycle": "internal",
                }));
            }
        }
        Value::Array(connections)
    } else {
        json!([])
    };
    json!({
        "id": format!("v2-{}", name),
        "name": name,
        "model": model,
        "units": units,
        "connections": connections,
        "metadata": {"source": "v2-config", "note": "translated for read-only compatibility"}
    })
}

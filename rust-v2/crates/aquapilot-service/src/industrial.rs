//! Simulated industrial adapter layer (OPC UA / Modbus TCP / MQTT).
//!
//! The V2 service deliberately does not open real fieldbus sockets in tests. This
//! module exposes the same point/write/audit shape an adapter gateway would use:
//! a read-only telemetry mirror, a small writable setpoint surface, adapter
//! health, and a hash-chained write audit persisted in SQLite.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::gateway;
use crate::store::{AuditRecord, Store};

#[derive(Clone)]
pub struct IndustrialHub {
    points: Arc<Mutex<Vec<Point>>>,
    store: Store,
    real: Option<Arc<RealGateway>>,
    last_check: Arc<Mutex<Option<Value>>>,
    mqtt_runtime: Arc<Mutex<Value>>,
}

#[derive(Debug, Clone)]
struct RealGateway {
    config: Value,
    source: String,
    error: Option<String>,
    interval: Duration,
}

#[derive(Debug, Clone, Serialize)]
pub struct Point {
    pub id: String,
    pub label: String,
    pub unit: String,
    pub kind: String,
    pub adapter: String,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub writable: bool,
    pub quality: String,
}

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    pub point_id: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub reason: String,
}

impl IndustrialHub {
    pub fn new(store: Store) -> Self {
        let real = std::env::var("AQUAPILOT_GATEWAY_CONFIG")
            .ok()
            .map(Self::load_real);
        Self::with_real(store, real)
    }

    fn load_real(source: String) -> RealGateway {
        let interval = Duration::from_secs(
            std::env::var("AQUAPILOT_GATEWAY_POLL_SECONDS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(15)
                .clamp(2, 3600),
        );
        match std::fs::read_to_string(&source)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("invalid gateway config JSON: {error}"))
            }) {
            Ok(config) => RealGateway {
                config,
                source,
                error: None,
                interval,
            },
            Err(error) => RealGateway {
                config: Value::Null,
                source,
                error: Some(error),
                interval,
            },
        }
    }

    fn with_real(store: Store, real: Option<RealGateway>) -> Self {
        let mqtt_runtime = real
            .as_ref()
            .map(|gateway| mqtt_runtime_config(&gateway.config))
            .unwrap_or_else(|| json!({"state": "disabled", "connected": false, "messages": 0, "bad_payloads": 0}));
        Self {
            points: Arc::new(Mutex::new(default_points())),
            store,
            real: real.map(Arc::new),
            last_check: Arc::new(Mutex::new(None)),
            mqtt_runtime: Arc::new(Mutex::new(mqtt_runtime)),
        }
    }

    #[cfg(test)]
    fn with_real_config(store: Store, config: Value) -> Self {
        Self::with_real(
            store,
            Some(RealGateway {
                config,
                source: "test-config".to_owned(),
                error: None,
                interval: Duration::from_secs(2),
            }),
        )
    }

    pub fn real_configured(&self) -> bool {
        self.real.is_some()
    }

    pub fn spawn_poller(&self) {
        let Some(real) = &self.real else {
            return;
        };
        if real.error.is_some() {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let hub = self.clone();
        let interval = real.interval;
        tokio::spawn(async move {
            loop {
                let probe = hub.clone();
                let result = tokio::task::spawn_blocking(move || probe.poll_once()).await;
                if let Ok(Err(error)) = result {
                    tracing::warn!("industrial gateway poll failed: {error:?}");
                }
                tokio::time::sleep(interval).await;
            }
        });
        self.spawn_mqtt_consumer();
    }

    pub fn spawn_mqtt_consumer(&self) {
        let Some(real) = &self.real else {
            return;
        };
        if real.error.is_some() {
            return;
        }
        let Some(mqtt) = real.config.get("mqtt").cloned() else {
            return;
        };
        if mqtt_runtime_config(&real.config)["state"] == "disabled" {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let hub = self.clone();
        tokio::task::spawn_blocking(move || hub.mqtt_loop(mqtt));
    }

    fn mqtt_loop(&self, mqtt: Value) {
        loop {
            self.set_mqtt_state(json!({"state": "connecting", "connected": false, "error": null}));
            let result = gateway::mqtt_consume(&mqtt, None, |event| match event {
                gateway::MqttEvent::Connected => self.set_mqtt_state(json!({
                    "state": "connected",
                    "connected": true,
                    "error": null,
                    "connected_at_unix": unix_now(),
                })),
                gateway::MqttEvent::Message { topic, payload } => {
                    self.apply_mqtt_message(&mqtt, &topic, &payload)
                }
            });
            match result {
                Ok(()) => self.set_mqtt_state(json!({"state": "disconnected", "connected": false, "error": "subscriber stopped"})),
                Err(error) => {
                    tracing::warn!("MQTT runtime disconnected: {error}");
                    self.set_mqtt_state(json!({"state": "error", "connected": false, "error": error}));
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    fn set_mqtt_state(&self, patch: Value) {
        let mut runtime = self.mqtt_runtime.lock().expect("mqtt runtime mutex");
        if let (Some(target), Some(source)) = (runtime.as_object_mut(), patch.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        } else {
            *runtime = patch;
        }
    }

    fn apply_mqtt_message(&self, mqtt: &Value, topic: &str, payload: &[u8]) {
        match self.decode_mqtt_reading(mqtt, topic, payload) {
            Ok((point_id, value)) => {
                let updated = {
                    let mut points = self.points.lock().expect("industrial points mutex");
                    if let Some(point) = points.iter_mut().find(|point| point.id == point_id) {
                        point.value = value;
                        point.quality = "good".to_owned();
                        true
                    } else {
                        false
                    }
                };
                if updated {
                    self.set_mqtt_state(json!({
                        "state": "connected",
                        "connected": true,
                        "last_topic": topic,
                        "last_point_id": point_id,
                        "last_value": value,
                        "last_message_at_unix": unix_now(),
                    }));
                    let mut runtime = self.mqtt_runtime.lock().expect("mqtt runtime mutex");
                    let messages = runtime["messages"].as_u64().unwrap_or(0) + 1;
                    runtime["messages"] = json!(messages);
                } else {
                    self.mqtt_bad_payload(
                        topic,
                        format!("point {point_id} is not in the adapter image"),
                    );
                }
            }
            Err(error) => self.mqtt_bad_payload(topic, error),
        }
    }

    fn mqtt_bad_payload(&self, topic: &str, error: String) {
        tracing::warn!("MQTT payload rejected on {topic}: {error}");
        let mut runtime = self.mqtt_runtime.lock().expect("mqtt runtime mutex");
        runtime["bad_payloads"] = json!(runtime["bad_payloads"].as_u64().unwrap_or(0) + 1);
        runtime["last_error"] = json!(error);
        runtime["last_error_topic"] = json!(topic);
        runtime["last_error_at_unix"] = json!(unix_now());
    }

    fn decode_mqtt_reading(
        &self,
        mqtt: &Value,
        topic: &str,
        payload: &[u8],
    ) -> Result<(String, f64), String> {
        let body: Value = serde_json::from_slice(payload)
            .map_err(|error| format!("payload is not JSON: {error}"))?;
        let reads = mqtt
            .get("read")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mapping = body
            .get("point_id")
            .and_then(Value::as_str)
            .and_then(|id| reads.iter().find(|read| read["point_id"] == id))
            .or_else(|| {
                reads
                    .iter()
                    .find(|read| read["topic"].as_str() == Some(topic))
            })
            .or_else(|| {
                reads
                    .iter()
                    .find(|read| topic_matches(read["topic"].as_str().unwrap_or(""), topic))
            });
        let Some(mapping) = mapping else {
            return Err(format!("no mqtt.read mapping for topic {topic}"));
        };
        let point_id = body
            .get("point_id")
            .and_then(Value::as_str)
            .or_else(|| mapping["point_id"].as_str())
            .ok_or("mapping has no point_id")?
            .to_owned();
        let path = mapping
            .get("value_path")
            .or_else(|| mapping.get("path"))
            .and_then(Value::as_str);
        let raw = match path {
            Some(path) => body
                .pointer(&format!("/{}", path.replace('.', "/")))
                .and_then(Value::as_f64),
            None => body
                .get("value")
                .and_then(Value::as_f64)
                .or_else(|| body.as_f64()),
        }
        .ok_or_else(|| {
            format!(
                "payload has no numeric value{}",
                path.map(|path| format!(" at {path}")).unwrap_or_default()
            )
        })?;
        let scale = mapping.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        let offset = mapping.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
        let value = raw * scale + offset;
        if !value.is_finite() {
            return Err("decoded MQTT value is not finite".to_owned());
        }
        Ok((point_id, value))
    }

    pub fn mqtt_runtime(&self) -> Value {
        self.mqtt_runtime
            .lock()
            .expect("mqtt runtime mutex")
            .clone()
    }

    pub fn poll_once(&self) -> Result<Value, ApiError> {
        let real = self.real.as_ref().ok_or_else(|| {
            ApiError::conflict(
                "GATEWAY_NOT_CONFIGURED",
                "no AQUAPILOT_GATEWAY_CONFIG is active",
            )
        })?;
        if let Some(error) = &real.error {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "GATEWAY_CONFIG_ERROR",
                "Gateway config is invalid",
                error.clone(),
            ));
        }
        let check = gateway::check_config(&real.config, &real.source);
        let connected = check["all_connected"].as_bool() == Some(true);
        let mut points = self.points.lock().expect("industrial points mutex");
        for adapter in check["adapters"].as_array().into_iter().flatten() {
            for value in adapter["values"].as_array().into_iter().flatten() {
                let Some(id) = value["point_id"].as_str() else {
                    continue;
                };
                let Some(reading) = value["value"].as_f64() else {
                    continue;
                };
                if let Some(point) = points.iter_mut().find(|point| point.id == id) {
                    point.value = reading;
                    point.quality = if connected { "good" } else { "bad" }.to_owned();
                }
            }
        }
        if !connected {
            for id in configured_points(&real.config) {
                if let Some(point) = points.iter_mut().find(|point| point.id == id) {
                    point.quality = "bad".to_owned();
                }
            }
        }
        drop(points);
        *self.last_check.lock().expect("industrial check mutex") = Some(check.clone());
        Ok(check)
    }

    pub fn last_check(&self) -> Option<Value> {
        self.last_check
            .lock()
            .expect("industrial check mutex")
            .clone()
    }

    pub fn points(&self) -> Vec<Point> {
        self.points.lock().expect("industrial points mutex").clone()
    }

    pub fn adapters(&self) -> Value {
        let points = self.points();
        if let Some(real) = &self.real {
            let check = self.last_check();
            let mqtt_runtime = self.mqtt_runtime();
            let adapters = if let Some(error) = &real.error {
                json!([{
                    "kind": "gateway",
                    "endpoint": real.source,
                    "state": "config_error",
                    "simulated": false,
                    "error": error,
                }])
            } else if let Some(check) = &check {
                let mut merged = check["adapters"].clone();
                if let Some(list) = merged.as_array_mut() {
                    for adapter in list {
                        adapter["points"] = json!(points
                            .iter()
                            .filter(|point| point.adapter == adapter["kind"].as_str().unwrap_or(""))
                            .count());
                        if adapter["kind"] == "mqtt" && mqtt_runtime["state"] != "disabled" {
                            adapter["connected"] =
                                json!(mqtt_runtime["connected"].as_bool() == Some(true));
                            adapter["runtime"] = mqtt_runtime.clone();
                        }
                    }
                }
                merged
            } else {
                let mut list = Vec::new();
                for kind in ["opcua", "modbus", "mqtt"] {
                    if let Some(config) = real.config.get(kind) {
                        list.push(json!({
                            "kind": kind,
                            "endpoint": config.get("endpoint").or_else(|| config.get("broker")).and_then(Value::as_str).unwrap_or(""),
                            "state": "configured",
                            "simulated": false,
                            "points": points.iter().filter(|point| point.adapter == kind).count(),
                        }));
                    }
                }
                Value::Array(list)
            };
            let protocol_connected = check
                .as_ref()
                .and_then(|value| value["all_connected"].as_bool())
                .unwrap_or(false);
            let mqtt_required = mqtt_runtime["state"] != "disabled";
            let mqtt_connected =
                !mqtt_required || mqtt_runtime["connected"].as_bool() == Some(true);
            return json!({
                "adapters": adapters,
                "real": true,
                "source": real.source,
                "all_connected": protocol_connected && mqtt_connected,
                "last_check": check,
                "mqtt_runtime": mqtt_runtime,
                "note": "Real gateway: polling is fail-closed; MQTT telemetry is consumed by the service runtime. Only configured endpoints are contacted. Writes require a modbus.write mapping.",
            });
        }
        let adapters = ["opcua", "modbus", "mqtt"].map(|kind| {
            let count = points.iter().filter(|point| point.adapter == kind).count();
            json!({
                "kind": kind,
                "endpoint": match kind {
                    "opcua" => "opc.tcp://127.0.0.1:4840/aquapilot",
                    "modbus" => "tcp://127.0.0.1:502",
                    _ => "mqtt://127.0.0.1:1883/aquapilot",
                },
                "state": "connected",
                "simulated": true,
                "points": count,
            })
        });
        json!({ "adapters": adapters, "note": "模拟适配层：不连接真实 PLC；写入只更新网关镜像并进入审计链。" })
    }

    pub fn write(&self, request: WriteRequest, actor: &str) -> Result<Value, ApiError> {
        if request.point_id.trim().is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_REQUEST,
                "POINT_REQUIRED",
                "Point is required",
                "point_id must not be empty",
            ));
        }
        if !request.value.is_finite() {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_REQUEST,
                "VALUE_NOT_FINITE",
                "Value must be finite",
                "value must be a finite number",
            ));
        }
        let mut points = self.points.lock().expect("industrial points mutex");
        let point = points
            .iter_mut()
            .find(|point| point.id == request.point_id)
            .ok_or_else(|| {
                ApiError::new(
                    axum::http::StatusCode::NOT_FOUND,
                    "POINT_NOT_FOUND",
                    "Unknown industrial point",
                    "point_id is not present in the adapter image",
                )
            })?;
        if !point.writable {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "POINT_READ_ONLY",
                "Point is read-only",
                "telemetry mirror points cannot be written",
            ));
        }
        if request.value < point.min || request.value > point.max {
            return Err(ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "POINT_RANGE",
                "Value outside point range",
                format!(
                    "{} must be between {} and {}",
                    point.id, point.min, point.max
                ),
            ));
        }
        if let Some(real) = &self.real {
            self.write_real(real, &point.id, request.value)?;
        }
        let old_value = point.value;
        point.value = request.value;
        let reason = if request.reason.trim().is_empty() {
            "operator write".to_owned()
        } else {
            request.reason.trim().to_owned()
        };
        let record = self
            .store
            .append_audit(
                "industrial.write",
                actor,
                &point.id,
                Some(old_value),
                Some(request.value),
                &reason,
            )
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "AUDIT_WRITE_FAILED",
                    "Write audit failed",
                    error.to_string(),
                )
            })?;
        Ok(json!({
            "point": point,
            "previous_value": old_value,
            "audit": record,
        }))
    }

    fn write_real(&self, real: &RealGateway, point_id: &str, value: f64) -> Result<(), ApiError> {
        if let Some(error) = &real.error {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "GATEWAY_CONFIG_ERROR",
                "Gateway config is invalid",
                error.clone(),
            ));
        }
        let modbus = real.config.get("modbus").ok_or_else(|| {
            ApiError::conflict(
                "NO_WRITE_MAPPING",
                "no modbus adapter is configured for this write",
            )
        })?;
        let writes = modbus
            .get("write")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ApiError::conflict(
                    "NO_WRITE_MAPPING",
                    "modbus.write mapping is not configured; refusing to mirror a field write",
                )
            })?;
        let mapping = writes
            .iter()
            .find(|mapping| mapping.get("point_id").and_then(Value::as_str) == Some(point_id))
            .ok_or_else(|| {
                ApiError::conflict(
                    "POINT_NOT_MAPPED",
                    format!("{point_id} has no modbus.write mapping"),
                )
            })?;
        let register = mapping.get("register").and_then(Value::as_u64).unwrap_or(0) as u16;
        let scale = mapping.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        let offset = mapping.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
        if scale == 0.0 || !scale.is_finite() || !offset.is_finite() {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "GATEWAY_WRITE_MAPPING",
                "Invalid modbus.write scale/offset",
                "scale must be finite and non-zero; offset must be finite",
            ));
        }
        let raw = ((value - offset) / scale).round();
        if !(0.0..=65535.0).contains(&raw) {
            return Err(ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "GATEWAY_WRITE_RANGE",
                "Value cannot be encoded as a 16-bit register",
                format!("raw={raw} from value={value}"),
            ));
        }
        let endpoint = modbus.get("endpoint").and_then(Value::as_str).unwrap_or("");
        let unit = modbus.get("unit").and_then(Value::as_u64).unwrap_or(1) as u8;
        let timeout = Duration::from_millis(
            (modbus
                .get("timeout_seconds")
                .and_then(Value::as_f64)
                .unwrap_or(2.0)
                * 1000.0)
                .clamp(200.0, 30_000.0) as u64,
        );
        gateway::modbus_write(endpoint, unit, timeout, register, raw as u16).map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "GATEWAY_WRITE_FAILED",
                "Real Modbus write failed",
                error,
            )
        })
    }

    pub fn audit(&self, limit: usize) -> Result<Vec<AuditRecord>, ApiError> {
        self.store.list_audit(limit).map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "AUDIT_READ_FAILED",
                "Audit read failed",
                error.to_string(),
            )
        })
    }
}

fn mqtt_runtime_config(config: &Value) -> Value {
    let topics = gateway::mqtt_topics(config.get("mqtt").unwrap_or(&Value::Null));
    if topics.is_empty() {
        return json!({"state": "disabled", "connected": false, "messages": 0, "bad_payloads": 0, "topics": []});
    }
    json!({
        "state": "starting",
        "connected": false,
        "messages": 0,
        "bad_payloads": 0,
        "topics": topics,
        "last_topic": Value::Null,
        "last_point_id": Value::Null,
        "last_value": Value::Null,
        "error": Value::Null,
    })
}

fn topic_matches(filter: &str, topic: &str) -> bool {
    if filter == topic {
        return true;
    }
    let filter_parts: Vec<&str> = filter.split('/').collect();
    let topic_parts: Vec<&str> = topic.split('/').collect();
    let mut index = 0;
    for (position, part) in filter_parts.iter().enumerate() {
        if *part == "#" {
            return position == filter_parts.len() - 1;
        }
        if topic_parts.get(index).is_none() {
            return false;
        }
        if *part != "+" && *part != topic_parts[index] {
            return false;
        }
        index += 1;
    }
    index == topic_parts.len()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn configured_points(config: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for adapter in ["modbus", "mqtt"] {
        for read in config
            .get(adapter)
            .and_then(|value| value.get("read"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = read.get("point_id").and_then(Value::as_str) {
                ids.push(id.to_owned());
            }
        }
    }
    ids
}

#[allow(clippy::too_many_arguments)]
fn point(
    id: &str,
    label: &str,
    unit: &str,
    kind: &str,
    adapter: &str,
    value: f64,
    min: f64,
    max: f64,
    writable: bool,
) -> Point {
    Point {
        id: id.to_owned(),
        label: label.to_owned(),
        unit: unit.to_owned(),
        kind: kind.to_owned(),
        adapter: adapter.to_owned(),
        value,
        min,
        max,
        writable,
        quality: "good".to_owned(),
    }
}

fn default_points() -> Vec<Point> {
    vec![
        point(
            "influent.flow",
            "进水流量",
            "m³/h",
            "setpoint",
            "modbus",
            1000.0,
            200.0,
            3000.0,
            true,
        ),
        point(
            "aerobic.do",
            "好氧 DO 设定",
            "mg/L",
            "setpoint",
            "opcua",
            2.0,
            0.0,
            10.0,
            true,
        ),
        point(
            "aerobic.kla",
            "好氧 KLa",
            "1/h",
            "setpoint",
            "opcua",
            8.0,
            0.0,
            600.0,
            true,
        ),
        point(
            "clarifier.ras",
            "RAS 流量",
            "m³/h",
            "setpoint",
            "modbus",
            500.0,
            0.0,
            2000.0,
            true,
        ),
        point(
            "clarifier.was",
            "WAS 流量",
            "m³/h",
            "setpoint",
            "modbus",
            20.0,
            0.0,
            200.0,
            true,
        ),
        point(
            "pac.dose",
            "PAC 剂量",
            "mg/L",
            "setpoint",
            "opcua",
            20.0,
            0.0,
            200.0,
            true,
        ),
        point(
            "reactor.temperature",
            "反应器温度",
            "°C",
            "setpoint",
            "modbus",
            20.0,
            5.0,
            40.0,
            true,
        ),
        point(
            "effluent.cod",
            "出水 COD",
            "mg/L",
            "measurement",
            "mqtt",
            32.5,
            0.0,
            1000.0,
            false,
        ),
        point(
            "effluent.nh4",
            "出水 NH4-N",
            "mg/L",
            "measurement",
            "mqtt",
            0.75,
            0.0,
            100.0,
            false,
        ),
        point(
            "effluent.tp",
            "出水 TP",
            "mg/L",
            "measurement",
            "mqtt",
            0.15,
            0.0,
            50.0,
            false,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn store() -> Store {
        Store::in_memory(4).expect("store")
    }

    #[test]
    fn poll_once_reads_real_modbus_value() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 12];
            stream.read_exact(&mut request).expect("read");
            stream
                .write_all(&[0, 1, 0, 0, 0, 5, 1, 3, 2, 0, 100])
                .expect("write");
        });
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"modbus":{"endpoint":endpoint,"unit":1,"timeout_seconds":2,"read":[{"point_id":"influent.flow","register":0,"scale":10}]}}),
        );
        let check = hub.poll_once().expect("poll");
        assert_eq!(check["all_connected"], true);
        let point = hub
            .points()
            .into_iter()
            .find(|point| point.id == "influent.flow")
            .expect("point");
        assert_eq!(point.value, 1000.0);
        assert_eq!(point.quality, "good");
        server.join().expect("server");
    }

    #[test]
    fn real_modbus_write_is_forwarded_before_audit() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 12];
            stream.read_exact(&mut request).expect("read");
            assert_eq!(&request[7..], &[6, 0, 10, 0, 100]);
            stream
                .write_all(&[0, 1, 0, 0, 0, 6, 1, 6, 0, 10, 0, 100])
                .expect("write");
        });
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"modbus":{"endpoint":endpoint,"unit":1,"timeout_seconds":2,"write":[{"point_id":"influent.flow","register":10,"scale":15}]}}),
        );
        let result = hub
            .write(
                WriteRequest {
                    point_id: "influent.flow".to_owned(),
                    value: 1500.0,
                    client_id: "test".to_owned(),
                    reason: "test write".to_owned(),
                },
                "tester",
            )
            .expect("write");
        assert_eq!(result["point"]["value"], 1500.0);
        assert_eq!(result["audit"]["seq"], 1);
        server.join().expect("server");
    }

    #[test]
    fn runtime_mqtt_message_updates_measurement_point() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut header = [0_u8; 2];
            stream.read_exact(&mut header).expect("connect header");
            let mut body = vec![0_u8; header[1] as usize];
            stream.read_exact(&mut body).expect("connect body");
            stream
                .write_all(&[0x20, 0x02, 0x00, 0x00])
                .expect("connack");
            let mut subscribe = [0_u8; 2];
            stream.read_exact(&mut subscribe).expect("subscribe header");
            let mut remaining = [0_u8; 1];
            stream.read_exact(&mut remaining).expect("subscribe length");
            let mut body = vec![0_u8; remaining[0] as usize];
            stream.read_exact(&mut body).expect("subscribe body");
            stream
                .write_all(&[0x90, 0x03, 0x00, 0x01, 0x00])
                .expect("suback");
            let topic = b"aquapilot/telemetry/effluent/cod";
            let payload = b"{\"value\":42.5}";
            let mut publish = vec![0x30, 0];
            publish[1] = (2 + topic.len() + payload.len()) as u8;
            publish.extend_from_slice(&(topic.len() as u16).to_be_bytes());
            publish.extend_from_slice(topic);
            publish.extend_from_slice(payload);
            stream.write_all(&publish).expect("publish");
            std::thread::sleep(Duration::from_millis(500));
        });
        let config = json!({"mqtt":{"broker":endpoint,"client_id":"aquapilot-test","read":[{"topic":"aquapilot/telemetry/effluent/cod","point_id":"effluent.cod"}]}});
        let hub = IndustrialHub::with_real_config(store(), config.clone());
        gateway::mqtt_consume(&config["mqtt"], Some(1), |event| match event {
            gateway::MqttEvent::Connected => {
                hub.set_mqtt_state(json!({"state":"connected","connected":true}))
            }
            gateway::MqttEvent::Message { topic, payload } => {
                hub.apply_mqtt_message(&config["mqtt"], &topic, &payload)
            }
        })
        .expect("consume");
        let point = hub
            .points()
            .into_iter()
            .find(|point| point.id == "effluent.cod")
            .expect("point");
        assert_eq!(point.value, 42.5);
        assert_eq!(point.quality, "good");
        assert_eq!(hub.mqtt_runtime()["messages"], 1);
        assert_eq!(hub.mqtt_runtime()["last_point_id"], "effluent.cod");
        server.join().expect("server");
    }

    #[test]
    fn mqtt_payload_with_bad_topic_mapping_is_counted_not_written() {
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"mqtt":{"broker":"127.0.0.1:1","read":[{"topic":"expected/topic","point_id":"effluent.cod"}]}}),
        );
        hub.apply_mqtt_message(
            &json!({"read":[{"topic":"expected/topic","point_id":"effluent.cod"}]}),
            "wrong/topic",
            b"{\"value\":1.0}",
        );
        assert_eq!(hub.mqtt_runtime()["bad_payloads"], 1);
        let point = hub
            .points()
            .into_iter()
            .find(|point| point.id == "effluent.cod")
            .expect("point");
        assert_eq!(point.value, 32.5);
    }

    #[test]
    fn adapters_are_not_all_connected_until_mqtt_runtime_is_live() {
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"mqtt":{"broker":"127.0.0.1:1","read":[{"topic":"telemetry/cod","point_id":"effluent.cod"}]}}),
        );
        *hub.last_check.lock().expect("check") = Some(json!({
            "adapters":[{"kind":"mqtt","connected":true}],
            "all_connected": true
        }));
        assert_eq!(hub.adapters()["all_connected"], false);
        hub.set_mqtt_state(json!({"state":"connected","connected":true}));
        assert_eq!(hub.adapters()["all_connected"], true);
    }

    #[test]
    fn unmapped_real_write_fails_closed_without_audit() {
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"modbus":{"endpoint":"127.0.0.1:1","unit":1,"timeout_seconds":0.2,"read":[]}}),
        );
        let error = hub
            .write(
                WriteRequest {
                    point_id: "influent.flow".to_owned(),
                    value: 1500.0,
                    client_id: "test".to_owned(),
                    reason: "test".to_owned(),
                },
                "tester",
            )
            .expect_err("unmapped write");
        assert_eq!(error.code, "NO_WRITE_MAPPING");
        assert_eq!(hub.audit(5).expect("audit").len(), 0);
    }

    #[test]
    fn unreachable_real_write_keeps_value_and_audit_clean() {
        let hub = IndustrialHub::with_real_config(
            store(),
            json!({"modbus":{"endpoint":"127.0.0.1:1","unit":1,"timeout_seconds":0.2,"write":[{"point_id":"influent.flow","register":10}]}}),
        );
        let error = hub
            .write(
                WriteRequest {
                    point_id: "influent.flow".to_owned(),
                    value: 1500.0,
                    client_id: "test".to_owned(),
                    reason: "test".to_owned(),
                },
                "tester",
            )
            .expect_err("unreachable write");
        assert_eq!(error.code, "GATEWAY_WRITE_FAILED");
        assert_eq!(hub.audit(5).expect("audit").len(), 0);
        let point = hub
            .points()
            .into_iter()
            .find(|point| point.id == "influent.flow")
            .expect("point");
        assert_eq!(point.value, 1000.0);
    }
}

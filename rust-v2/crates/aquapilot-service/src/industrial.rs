//! Simulated industrial adapter layer (OPC UA / Modbus TCP / MQTT).
//!
//! The V2 service deliberately does not open real fieldbus sockets in tests. This
//! module exposes the same point/write/audit shape an adapter gateway would use:
//! a read-only telemetry mirror, a small writable setpoint surface, adapter
//! health, and a hash-chained write audit persisted in SQLite.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::store::{AuditRecord, Store};

#[derive(Clone)]
pub struct IndustrialHub {
    points: Arc<Mutex<Vec<Point>>>,
    store: Store,
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
        Self {
            points: Arc::new(Mutex::new(default_points())),
            store,
        }
    }

    pub fn points(&self) -> Vec<Point> {
        self.points.lock().expect("industrial points mutex").clone()
    }

    pub fn adapters(&self) -> Value {
        let points = self.points();
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

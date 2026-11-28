//! Real OPC UA client session for read-only telemetry.
//!
//! This module deliberately uses the OPC UA binary protocol through the
//! `async-opcua` client: GetEndpoints, OpenSecureChannel, CreateSession,
//! ActivateSession and Read. A TCP connect alone is never reported as a
//! session.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use opcua::client::transport::TcpConnector;
use opcua::client::{ClientBuilder, ClientEndpoint, SessionEventLoop};
use opcua::types::{NodeId, ReadValueId, StatusCode, TimestampsToReturn, Variant};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub enum OpcuaEvent {
    Connected,
    Readings(Vec<Value>),
}

struct Connection {
    session: Arc<opcua::client::Session>,
    event_loop: tokio::task::JoinHandle<StatusCode>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.event_loop.abort();
    }
}

#[derive(Debug, Clone)]
struct Mapping {
    point_id: String,
    node_id: NodeId,
    scale: f64,
    offset: f64,
}

pub fn enabled(config: &Value) -> bool {
    config
        .get("read")
        .and_then(Value::as_array)
        .map(|reads| !reads.is_empty())
        .unwrap_or(false)
}

fn timeout(config: &Value) -> Duration {
    Duration::from_millis(
        (config
            .get("timeout_seconds")
            .and_then(Value::as_f64)
            .unwrap_or(5.0)
            * 1000.0)
            .clamp(300.0, 60_000.0) as u64,
    )
}

fn pki_dir(config: &Value) -> PathBuf {
    config
        .get("pki_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("AQUAPILOT_OPCUA_PKI_DIR")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("/tmp/aquapilot-opcua-pki"))
}

fn endpoint(config: &Value) -> Result<String, String> {
    let endpoint = config
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !endpoint.starts_with("opc.tcp://") {
        return Err("opcua.endpoint must start with opc.tcp://".to_owned());
    }
    Ok(endpoint.to_owned())
}

fn mappings(config: &Value) -> Result<Vec<Mapping>, String> {
    let reads = config
        .get("read")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut result = Vec::new();
    for read in reads {
        let point_id = read
            .get("point_id")
            .and_then(Value::as_str)
            .ok_or("opcua.read[].point_id is required")?
            .to_owned();
        let node_text = read
            .get("node_id")
            .and_then(Value::as_str)
            .ok_or("opcua.read[].node_id is required")?;
        let node_id = NodeId::from_str(node_text)
            .map_err(|error| format!("invalid OPC UA node_id {node_text}: {error}"))?;
        let scale = read.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        let offset = read.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
        if !scale.is_finite() || scale == 0.0 || !offset.is_finite() {
            return Err(format!("invalid scale/offset for {point_id}"));
        }
        result.push(Mapping {
            point_id,
            node_id,
            scale,
            offset,
        });
    }
    Ok(result)
}

async fn connect(config: &Value) -> Result<Connection, String> {
    let endpoint = endpoint(config)?;
    let timeout = timeout(config);
    let pki = pki_dir(config);
    let mut client = ClientBuilder::new()
        .application_name("AquaPilot V2")
        .application_uri(format!("urn:aquapilot:v2:{}", std::process::id()))
        .pki_dir(pki)
        .create_sample_keypair(true)
        .trust_server_certs(true)
        .verify_server_certs(false)
        .session_retry_limit(0)
        .endpoint("configured", ClientEndpoint::new(endpoint.clone()))
        .default_endpoint("configured")
        .client()
        .map_err(|errors| format!("OPC UA client config: {errors:?}"))?;
    let (session, event_loop): (Arc<opcua::client::Session>, SessionEventLoop<TcpConnector>) =
        tokio::time::timeout(timeout, client.connect_to_default_endpoint())
            .await
            .map_err(|_| {
                format!(
                    "OPC UA GetEndpoints/SecureChannel timed out after {:?}",
                    timeout
                )
            })?
            .map_err(|error| format!("OPC UA SecureChannel/session failed: {error}"))?;
    let event_loop = event_loop.spawn();
    let connected = tokio::time::timeout(timeout, session.wait_for_connection())
        .await
        .map_err(|_| format!("OPC UA ActivateSession timed out after {:?}", timeout))?;
    if !connected {
        event_loop.abort();
        return Err("OPC UA session did not activate".to_owned());
    }
    Ok(Connection {
        session,
        event_loop,
    })
}

async fn read_once(
    session: &opcua::client::Session,
    mappings: &[Mapping],
    timeout: Duration,
) -> Result<Vec<Value>, String> {
    if mappings.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<ReadValueId> = mappings
        .iter()
        .map(|mapping| ReadValueId::new_value(mapping.node_id.clone()))
        .collect();
    let values = tokio::time::timeout(timeout, session.read(&ids, TimestampsToReturn::Both, 0.0))
        .await
        .map_err(|_| format!("OPC UA Read timed out after {timeout:?}"))?
        .map_err(|error| format!("OPC UA Read failed: {error}"))?;
    if values.len() != mappings.len() {
        return Err("OPC UA Read returned a different number of values".to_owned());
    }
    let mut result = Vec::with_capacity(values.len());
    for (mapping, value) in mappings.iter().zip(values) {
        if let Some(status) = value.status {
            if status != StatusCode::Good {
                return Err(format!(
                    "OPC UA node {} returned status {status}",
                    mapping.point_id
                ));
            }
        }
        let raw = value
            .value
            .as_ref()
            .and_then(Variant::as_f64)
            .ok_or_else(|| format!("OPC UA node {} is not numeric", mapping.point_id))?;
        let converted = raw * mapping.scale + mapping.offset;
        if !converted.is_finite() {
            return Err(format!(
                "OPC UA node {} decoded to a non-finite value",
                mapping.point_id
            ));
        }
        result.push(json!({
            "point_id": mapping.point_id,
            "node_id": format!("{}", mapping.node_id),
            "raw": raw,
            "value": converted,
            "status": "Good",
        }));
    }
    Ok(result)
}

/// One connect/read/disconnect probe for CLI and acceptance checks.
pub async fn check_config(config: &Value) -> Value {
    let endpoint = config.get("endpoint").and_then(Value::as_str).unwrap_or("");
    if !enabled(config) {
        return json!({
            "kind": "opcua",
            "mode": "real-opcua-session",
            "endpoint": endpoint,
            "security_policy": "None",
            "security_mode": "None",
            "connected": false,
            "values": [],
            "error": "opcua.read is empty; no nodes to read",
        });
    }
    match check_inner(config).await {
        Ok(values) => json!({
            "kind": "opcua",
            "mode": "real-opcua-session",
            "endpoint": endpoint,
            "security_policy": "None",
            "security_mode": "None",
            "connected": true,
            "values": values,
            "error": Value::Null,
        }),
        Err(error) => json!({
            "kind": "opcua",
            "mode": "real-opcua-session",
            "endpoint": endpoint,
            "security_policy": "None",
            "security_mode": "None",
            "connected": false,
            "values": [],
            "error": error,
        }),
    }
}

async fn check_inner(config: &Value) -> Result<Vec<Value>, String> {
    let mappings = mappings(config)?;
    let timeout = timeout(config);
    let connection = connect(config).await?;
    let values = read_once(&connection.session, &mappings, timeout).await?;
    let _ = connection.session.disconnect().await;
    Ok(values)
}

/// Run a persistent OPC UA session, read all configured nodes every interval,
/// and reconnect only when the session fails. `max_polls` is for tests.
pub async fn run<F>(
    config: &Value,
    interval: Duration,
    max_polls: Option<usize>,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(OpcuaEvent),
{
    let mappings = mappings(config)?;
    if mappings.is_empty() {
        return Err("opcua.read is empty; runtime polling is disabled".to_owned());
    }
    let timeout = timeout(config);
    let connection = connect(config).await?;
    on_event(OpcuaEvent::Connected);
    let mut polls = 0_usize;
    loop {
        if let Some(limit) = max_polls {
            if polls >= limit {
                break;
            }
        }
        let values = read_once(&connection.session, &mappings, timeout).await?;
        on_event(OpcuaEvent::Readings(values));
        polls += 1;
        if let Some(limit) = max_polls {
            if polls >= limit {
                break;
            }
        }
        tokio::time::sleep(interval).await;
    }
    let _ = connection.session.disconnect().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_and_mapping_parse() {
        let config = json!({"endpoint":"opc.tcp://127.0.0.1:4841","read":[{"point_id":"aerobic.do","node_id":"ns=2;s=DO","scale":1.0}]});
        let mappings = mappings(&config).expect("mappings");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].point_id, "aerobic.do");
        assert!(enabled(&config));
    }

    #[test]
    fn endpoint_requires_opc_tcp_scheme() {
        assert!(endpoint(&json!({"endpoint":"http://127.0.0.1:4841"})).is_err());
        assert!(endpoint(&json!({"endpoint":"opc.tcp://127.0.0.1:4841"})).is_ok());
    }

    #[test]
    fn empty_read_is_not_enabled() {
        assert!(!enabled(
            &json!({"endpoint":"opc.tcp://127.0.0.1:4841","read":[]})
        ));
    }

    #[tokio::test]
    async fn empty_read_is_not_connected() {
        let result = check_config(&json!({
            "endpoint":"opc.tcp://127.0.0.1:4841",
            "read":[]
        }))
        .await;
        assert_eq!(result["connected"], false);
        assert_eq!(result["values"], json!([]));
    }
}

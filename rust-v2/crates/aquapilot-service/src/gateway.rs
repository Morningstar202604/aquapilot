//! Fail-closed real-protocol connection checks.
//!
//! Modbus TCP and MQTT 3.1.1 are implemented directly (no simulator). OPC UA
//! is intentionally reported as unsupported until a real session handshake is
//! implemented; a bare TCP connect is not called an OPC UA connection.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::{json, Value};

pub fn check(config_path: &std::path::Path) -> Result<Value, String> {
    let config: Value = serde_json::from_str(
        &std::fs::read_to_string(config_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("invalid gateway config JSON: {error}"))?;
    Ok(check_config(&config, &config_path.display().to_string()))
}

pub fn check_config(config: &Value, source: &str) -> Value {
    let mut adapters = Vec::new();
    if let Some(modbus) = config.get("modbus") {
        adapters.push(check_modbus(modbus));
    }
    if let Some(mqtt) = config.get("mqtt") {
        adapters.push(check_mqtt(mqtt));
    }
    if let Some(opcua) = config.get("opcua") {
        adapters.push(check_opcua(opcua));
    }
    let all_connected = !adapters.is_empty()
        && adapters
            .iter()
            .all(|adapter| adapter["connected"].as_bool() == Some(true));
    json!({
        "schema": "aquapilot.gateway.check.v1",
        "checked_at_unix": unix_now(),
        "config": source,
        "adapters": adapters,
        "all_connected": all_connected,
        "fail_closed": true,
        "note": "Only a completed protocol handshake is reported as connected. OPC UA TCP reachability is not a session and is reported as unsupported.",
    })
}

fn check_modbus(config: &Value) -> Value {
    let endpoint = config.get("endpoint").and_then(Value::as_str).unwrap_or("");
    let unit = config.get("unit").and_then(Value::as_u64).unwrap_or(1) as u8;
    let timeout = timeout(config);
    let reads = config
        .get("read")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match modbus_read(endpoint, unit, timeout, &reads) {
        Ok(values) => json!({
            "kind": "modbus",
            "mode": "real-tcp",
            "endpoint": endpoint,
            "connected": true,
            "unit": unit,
            "values": values,
            "error": Value::Null,
        }),
        Err(error) => json!({
            "kind": "modbus",
            "mode": "real-tcp",
            "endpoint": endpoint,
            "connected": false,
            "values": [],
            "error": error,
        }),
    }
}

fn check_mqtt(config: &Value) -> Value {
    let broker = config.get("broker").and_then(Value::as_str).unwrap_or("");
    let client_id = config
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or("aquapilot-probe");
    let timeout = timeout(config);
    match mqtt_connect(broker, client_id, timeout) {
        Ok(()) => json!({
            "kind": "mqtt",
            "mode": "real-mqtt-3.1.1",
            "endpoint": broker,
            "connected": true,
            "client_id": client_id,
            "error": Value::Null,
        }),
        Err(error) => json!({
            "kind": "mqtt",
            "mode": "real-mqtt-3.1.1",
            "endpoint": broker,
            "connected": false,
            "client_id": client_id,
            "error": error,
        }),
    }
}

fn check_opcua(config: &Value) -> Value {
    json!({
        "kind": "opcua",
        "mode": "unsupported",
        "endpoint": config.get("endpoint").and_then(Value::as_str).unwrap_or(""),
        "connected": false,
        "error": "OPC UA session handshake is not implemented; a TCP connect would not be an OPC UA connection.",
    })
}

fn timeout(config: &Value) -> Duration {
    Duration::from_millis(
        (config
            .get("timeout_seconds")
            .and_then(Value::as_f64)
            .unwrap_or(2.0)
            * 1000.0)
            .clamp(200.0, 30_000.0) as u64,
    )
}

fn connect(endpoint: &str, timeout: Duration) -> Result<TcpStream, String> {
    let address = endpoint
        .to_socket_addrs()
        .map_err(|error| format!("resolve {endpoint}: {error}"))?
        .next()
        .ok_or_else(|| format!("no address for {endpoint}"))?;
    let stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("connect {endpoint}: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

fn modbus_read(
    endpoint: &str,
    unit: u8,
    timeout: Duration,
    reads: &[Value],
) -> Result<Vec<Value>, String> {
    if reads.is_empty() {
        return Err("modbus.read is empty; nothing to verify".to_owned());
    }
    let mut stream = connect(endpoint, timeout)?;
    let mut values = Vec::new();
    for (index, read) in reads.iter().enumerate() {
        let register = read.get("register").and_then(Value::as_u64).unwrap_or(0) as u16;
        let count = read
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 125) as u16;
        let point = read
            .get("point_id")
            .and_then(Value::as_str)
            .unwrap_or("register");
        let scale = read.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        let offset = read.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
        let transaction = (index + 1) as u16;
        let request = [
            transaction.to_be_bytes()[0],
            transaction.to_be_bytes()[1],
            0,
            0,
            0,
            6,
            unit,
            3,
            register.to_be_bytes()[0],
            register.to_be_bytes()[1],
            count.to_be_bytes()[0],
            count.to_be_bytes()[1],
        ];
        stream
            .write_all(&request)
            .map_err(|error| format!("write modbus read: {error}"))?;
        let mut header = [0_u8; 7];
        stream
            .read_exact(&mut header)
            .map_err(|error| format!("read modbus header: {error}"))?;
        let length = u16::from_be_bytes([header[4], header[5]]) as usize;
        let mut body = vec![0_u8; length.saturating_sub(1)];
        stream
            .read_exact(&mut body)
            .map_err(|error| format!("read modbus body: {error}"))?;
        if body.first() != Some(&3) {
            return Err(format!(
                "modbus exception/function mismatch: {}",
                body.first().copied().unwrap_or(0)
            ));
        }
        let byte_count = *body.get(1).ok_or("modbus response has no byte count")? as usize;
        let registers = body
            .get(2..2 + byte_count)
            .ok_or("modbus response byte count exceeds payload")?;
        if registers.len() < count as usize * 2 {
            return Err("modbus response has fewer registers than requested".to_owned());
        }
        let raw = u16::from_be_bytes([registers[0], registers[1]]);
        values.push(json!({
            "point_id": point,
            "register": register,
            "raw": raw,
            "value": raw as f64 * scale + offset,
        }));
    }
    Ok(values)
}

pub fn modbus_write(
    endpoint: &str,
    unit: u8,
    timeout: Duration,
    register: u16,
    value: u16,
) -> Result<(), String> {
    let mut stream = connect(endpoint, timeout)?;
    let transaction: u16 = 1;
    let request = [
        transaction.to_be_bytes()[0],
        transaction.to_be_bytes()[1],
        0,
        0,
        0,
        6,
        unit,
        6,
        register.to_be_bytes()[0],
        register.to_be_bytes()[1],
        value.to_be_bytes()[0],
        value.to_be_bytes()[1],
    ];
    stream
        .write_all(&request)
        .map_err(|error| format!("write modbus request: {error}"))?;
    let mut header = [0_u8; 7];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("read modbus header: {error}"))?;
    let length = u16::from_be_bytes([header[4], header[5]]) as usize;
    let mut body = vec![0_u8; length.saturating_sub(1)];
    stream
        .read_exact(&mut body)
        .map_err(|error| format!("read modbus body: {error}"))?;
    if body.first() != Some(&6) {
        return Err(format!(
            "modbus write exception/function mismatch: {}",
            body.first().copied().unwrap_or(0)
        ));
    }
    let echoed_register = u16::from_be_bytes([
        *body.get(1).ok_or("modbus write echo missing register")?,
        *body.get(2).ok_or("modbus write echo missing register")?,
    ]);
    let echoed_value = u16::from_be_bytes([
        *body.get(3).ok_or("modbus write echo missing value")?,
        *body.get(4).ok_or("modbus write echo missing value")?,
    ]);
    if echoed_register != register || echoed_value != value {
        return Err("modbus write echo does not match request".to_owned());
    }
    Ok(())
}

fn mqtt_connect(broker: &str, client_id: &str, timeout: Duration) -> Result<(), String> {
    let mut stream = connect(broker, timeout)?;
    let mut payload = Vec::new();
    payload.extend_from_slice(client_id.as_bytes());
    let mut packet = vec![
        0x10, 0, // CONNECT, remaining length placeholder
        0, 4, b'M', b'T', b'T', b'Q', // protocol name
        4,    // MQTT 3.1.1
        0x02, // clean session
        0, 30, // keepalive
    ];
    packet.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    packet.extend_from_slice(&payload);
    let remaining = packet.len() - 2;
    if remaining > 127 {
        return Err("MQTT client id too long for a single-byte remaining length".to_owned());
    }
    packet[1] = remaining as u8;
    stream
        .write_all(&packet)
        .map_err(|error| format!("write MQTT CONNECT: {error}"))?;
    let mut connack = [0_u8; 4];
    stream
        .read_exact(&mut connack)
        .map_err(|error| format!("read MQTT CONNACK: {error}"))?;
    if connack[0] != 0x20 {
        return Err(format!("expected CONNACK 0x20, got 0x{:02x}", connack[0]));
    }
    let code = connack[3];
    if code != 0 {
        return Err(format!("MQTT CONNACK refused with code {code}"));
    }
    Ok(())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn modbus_read_uses_real_function_three_frames() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 12];
            stream.read_exact(&mut request).expect("read request");
            assert_eq!(&request[7..], &[3, 0, 0, 0, 1]);
            let response = [0_u8, 1, 0, 0, 0, 5, 1, 3, 2, 0, 100];
            stream.write_all(&response).expect("write response");
        });
        let values = modbus_read(
            &endpoint,
            1,
            Duration::from_secs(2),
            &[json!({"point_id":"flow","register":0,"scale":0.1})],
        )
        .expect("modbus read");
        assert_eq!(values[0]["value"], 10.0);
        server.join().expect("server");
    }

    #[test]
    fn mqtt_connect_waits_for_connack() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut header = [0_u8; 2];
            stream.read_exact(&mut header).expect("header");
            assert_eq!(header[0], 0x10);
            let mut body = vec![0_u8; header[1] as usize];
            stream.read_exact(&mut body).expect("body");
            stream
                .write_all(&[0x20, 0x02, 0x00, 0x00])
                .expect("connack");
        });
        mqtt_connect(&endpoint, "aquapilot-test", Duration::from_secs(2)).expect("mqtt");
        server.join().expect("server");
    }

    #[test]
    fn opcua_is_never_reported_as_connected() {
        let value = check_opcua(&json!({"endpoint":"opc.tcp://127.0.0.1:4840"}));
        assert_eq!(value["connected"], false);
        assert_eq!(value["mode"], "unsupported");
    }

    #[test]
    fn timeout_is_clamped() {
        assert_eq!(
            timeout(&json!({"timeout_seconds":0.01})),
            Duration::from_millis(200)
        );
        assert_eq!(
            timeout(&json!({"timeout_seconds":99})),
            Duration::from_secs(30)
        );
    }
}

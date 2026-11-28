//! Fail-closed real-protocol connection checks.
//!
//! Modbus TCP and MQTT 3.1.1 are implemented directly (no simulator). OPC UA
//! is intentionally reported as unsupported until a real session handshake is
//! implemented; a bare TCP connect is not called an OPC UA connection.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub enum MqttEvent {
    Connected,
    Message { topic: String, payload: Vec<u8> },
}

pub fn check(config_path: &std::path::Path) -> Result<Value, String> {
    let config: Value = serde_json::from_str(
        &std::fs::read_to_string(config_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("invalid gateway config JSON: {error}"))?;
    Ok(check_config(&config, &config_path.display().to_string()))
}

pub fn check_config(config: &Value, source: &str) -> Value {
    check_config_excluding(config, source, &[])
}

pub fn check_config_excluding(config: &Value, source: &str, skip: &[&str]) -> Value {
    let mut adapters = Vec::new();
    if let Some(modbus) = config.get("modbus") {
        if !skip.contains(&"modbus") {
            adapters.push(check_modbus(modbus));
        }
    }
    if let Some(mqtt) = config.get("mqtt") {
        if !skip.contains(&"mqtt") {
            adapters.push(check_mqtt(mqtt));
        }
    }
    if let Some(opcua) = config.get("opcua") {
        if !skip.contains(&"opcua") {
            adapters.push(check_opcua(opcua));
        }
    }
    let all_connected = !adapters.is_empty()
        && adapters
            .iter()
            .all(|adapter| adapter["connected"].as_bool() == Some(true));
    json!({
        "schema": "aquapilot.gateway.check.v1",
        "service_version": env!("CARGO_PKG_VERSION"),
        "checked_at_unix": unix_now(),
        "config": source,
        "adapters": adapters,
        "all_connected": all_connected,
        "fail_closed": true,
        "excluded": skip,
        "scope": if skip.is_empty() { "all-configured-adapters" } else { "sync-adapters-excluding-async" },
        "note": "Only a completed protocol handshake is reported as connected. Sync checks exclude async OPC UA sessions; use gateway-check or the service runtime for OPC UA.",
    })
}

/// Full gateway check including a real OPC UA SecureChannel/Session/Read probe.
/// Modbus and MQTT remain sync probes; OPC UA is awaited and merged last.
pub async fn check_async(config_path: &std::path::Path) -> Result<Value, String> {
    let config: Value = serde_json::from_str(
        &std::fs::read_to_string(config_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("invalid gateway config JSON: {error}"))?;
    let source = config_path.display().to_string();
    let mut result = check_config_excluding(&config, &source, &["opcua"]);
    if let Some(opcua) = config.get("opcua") {
        let adapter = crate::opcua::check_config(opcua).await;
        if let Some(list) = result["adapters"].as_array_mut() {
            list.push(adapter);
        }
    }
    let all_connected = result["adapters"]
        .as_array()
        .map(|adapters| {
            !adapters.is_empty()
                && adapters
                    .iter()
                    .all(|adapter| adapter["connected"].as_bool() == Some(true))
        })
        .unwrap_or(false);
    result["all_connected"] = json!(all_connected);
    result["excluded"] = json!([]);
    result["scope"] = json!("all-configured-adapters");
    result["checked_at_unix"] = json!(unix_now());
    result["note"] = json!("Only completed protocol handshakes are reported as connected. OPC UA is a real SecureChannel/Session/Read probe.");
    Ok(result)
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
        "error": "OPC UA session is async; use gateway::check_async or the service runtime. A TCP connect would not be an OPC UA connection.",
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
    mqtt_send_connect(&mut stream, client_id, 30)?;
    mqtt_read_connack(&mut stream)
}

fn mqtt_send_connect(
    stream: &mut TcpStream,
    client_id: &str,
    keepalive: u16,
) -> Result<(), String> {
    let mut packet = vec![
        0x10,
        0, // CONNECT, remaining length placeholder
        0,
        4,
        b'M',
        b'T',
        b'T',
        b'Q', // protocol name
        4,    // MQTT 3.1.1
        0x02, // clean session
        keepalive.to_be_bytes()[0],
        keepalive.to_be_bytes()[1],
    ];
    packet.extend_from_slice(&(client_id.len() as u16).to_be_bytes());
    packet.extend_from_slice(client_id.as_bytes());
    let remaining = packet.len() - 2;
    let length = mqtt_length_bytes(remaining)?;
    packet.splice(1..2, length);
    stream
        .write_all(&packet)
        .map_err(|error| format!("write MQTT CONNECT: {error}"))
}

fn mqtt_read_connack(stream: &mut TcpStream) -> Result<(), String> {
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

fn mqtt_length_bytes(value: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(4);
    let mut remaining = value;
    loop {
        let mut byte = (remaining % 128) as u8;
        remaining /= 128;
        if remaining > 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if remaining == 0 {
            break;
        }
        if bytes.len() == 4 {
            return Err("MQTT remaining length exceeds 4 bytes".to_owned());
        }
    }
    Ok(bytes)
}

pub(crate) fn mqtt_topics(config: &Value) -> Vec<String> {
    let mut topics: Vec<String> = Vec::new();
    let mut push = |topic: &str| {
        let topic = topic.trim();
        if !topic.is_empty() && !topics.iter().any(|value| value == topic) {
            topics.push(topic.to_owned());
        }
    };
    if let Some(list) = config.get("topics").and_then(Value::as_array) {
        for topic in list.iter().filter_map(Value::as_str) {
            push(topic);
        }
    }
    if let Some(topic) = config.get("topic").and_then(Value::as_str) {
        push(topic);
    }
    for read in config
        .get("read")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(topic) = read.get("topic").and_then(Value::as_str) {
            push(topic);
        }
    }
    topics
}

fn mqtt_subscribe(stream: &mut TcpStream, topics: &[String]) -> Result<(), String> {
    if topics.is_empty() {
        return Err("mqtt topics/read[].topic is empty; nothing to subscribe".to_owned());
    }
    let mut packet = vec![0x82, 0, 0, 1]; // SUBSCRIBE, packet id 1
    for topic in topics {
        packet.extend_from_slice(&(topic.len() as u16).to_be_bytes());
        packet.extend_from_slice(topic.as_bytes());
        packet.push(0); // QoS 0
    }
    let remaining = packet.len() - 2;
    let length = mqtt_length_bytes(remaining)?;
    packet.splice(1..2, length);
    stream
        .write_all(&packet)
        .map_err(|error| format!("write MQTT SUBSCRIBE: {error}"))?;
    let mut header = [0_u8; 1];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("read MQTT SUBACK header: {error}"))?;
    if header[0] != 0x90 {
        return Err(format!("expected SUBACK 0x90, got 0x{:02x}", header[0]));
    }
    let remaining = mqtt_read_remaining_length(stream)?;
    let mut body = vec![0_u8; remaining];
    stream
        .read_exact(&mut body)
        .map_err(|error| format!("read MQTT SUBACK body: {error}"))?;
    if body.len() < 2 || body[0..2] != [0, 1] {
        return Err("MQTT SUBACK packet id mismatch".to_owned());
    }
    if body.iter().skip(2).any(|code| *code == 0x80) {
        return Err("MQTT broker rejected a subscription".to_owned());
    }
    Ok(())
}

fn mqtt_read_remaining_length(stream: &mut TcpStream) -> Result<usize, String> {
    let mut value = 0_usize;
    let mut multiplier = 1_usize;
    for _ in 0..4 {
        let mut byte = [0_u8; 1];
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("read MQTT remaining length: {error}"))?;
        value += ((byte[0] & 0x7f) as usize) * multiplier;
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
        multiplier *= 128;
    }
    Err("MQTT remaining length exceeds 4 bytes".to_owned())
}

fn mqtt_packet(buffer: &mut Vec<u8>) -> Option<Result<(u8, Vec<u8>), String>> {
    if buffer.len() < 2 {
        return None;
    }
    let mut remaining = 0_usize;
    let mut multiplier = 1_usize;
    let mut length_bytes = 0_usize;
    for (index, byte) in buffer.iter().enumerate().take(5).skip(1) {
        remaining += ((*byte & 0x7f) as usize) * multiplier;
        if *byte & 0x80 == 0 {
            length_bytes = index;
            break;
        }
        multiplier *= 128;
    }
    if length_bytes == 0 {
        if buffer.len() >= 5 {
            return Some(Err("MQTT remaining length exceeds 4 bytes".to_owned()));
        }
        return None;
    }
    let total = 1 + length_bytes + remaining;
    if buffer.len() < total {
        return None;
    }
    let header = buffer[0];
    let payload = buffer[1 + length_bytes..total].to_vec();
    buffer.drain(..total);
    Some(Ok((header, payload)))
}

fn mqtt_publish(header: u8, payload: &[u8]) -> Result<(String, u16, Vec<u8>), String> {
    if payload.len() < 2 {
        return Err("MQTT PUBLISH has no topic length".to_owned());
    }
    let topic_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() < 2 + topic_len {
        return Err("MQTT PUBLISH topic is truncated".to_owned());
    }
    let topic = String::from_utf8(payload[2..2 + topic_len].to_vec())
        .map_err(|error| format!("MQTT PUBLISH topic is not UTF-8: {error}"))?;
    let qos = (header >> 1) & 0x03;
    let mut position = 2 + topic_len;
    let packet_id = if qos > 0 {
        if payload.len() < position + 2 {
            return Err("MQTT PUBLISH packet id is missing".to_owned());
        }
        let id = u16::from_be_bytes([payload[position], payload[position + 1]]);
        position += 2;
        id
    } else {
        0
    };
    if qos == 2 {
        return Err("MQTT QoS 2 PUBLISH is not supported by this subscriber".to_owned());
    }
    Ok((topic, packet_id, payload[position..].to_vec()))
}

/// Open a real MQTT 3.1.1 session, subscribe to the configured topic filters,
/// and forward each PUBLISH payload. `max_messages` exists for deterministic tests;
/// production passes `None` and keeps consuming until the socket fails.
pub fn mqtt_consume<F>(
    config: &Value,
    max_messages: Option<usize>,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(MqttEvent),
{
    let broker = config.get("broker").and_then(Value::as_str).unwrap_or("");
    let base_client_id = config
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or("aquapilot-service");
    let client_id = format!("{base_client_id}-runtime");
    let timeout = timeout(config);
    let topics = mqtt_topics(config);
    let mut stream = connect(broker, timeout)?;
    mqtt_send_connect(&mut stream, &client_id, 30)?;
    mqtt_read_connack(&mut stream)?;
    mqtt_subscribe(&mut stream, &topics)?;
    on_event(MqttEvent::Connected);
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    let mut messages = 0_usize;
    let mut last_ping = std::time::Instant::now();
    loop {
        if let Some(limit) = max_messages {
            if messages >= limit {
                return Ok(());
            }
        }
        let mut chunk = [0_u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => return Err("MQTT broker closed the connection".to_owned()),
            Ok(size) => {
                buffer.extend_from_slice(&chunk[..size]);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                if last_ping.elapsed() >= Duration::from_secs(15) {
                    stream
                        .write_all(&[0xc0, 0x00])
                        .map_err(|error| format!("write MQTT PINGREQ: {error}"))?;
                    last_ping = std::time::Instant::now();
                }
                continue;
            }
            Err(error) => return Err(format!("read MQTT packet: {error}")),
        }
        while let Some(packet) = mqtt_packet(&mut buffer) {
            let (header, payload) = packet?;
            match header >> 4 {
                3 => {
                    let (topic, packet_id, body) = mqtt_publish(header, &payload)?;
                    if (header >> 1) & 0x03 == 1 {
                        let ack = [
                            0x40,
                            0x02,
                            packet_id.to_be_bytes()[0],
                            packet_id.to_be_bytes()[1],
                        ];
                        stream
                            .write_all(&ack)
                            .map_err(|error| format!("write MQTT PUBACK: {error}"))?;
                    }
                    on_event(MqttEvent::Message {
                        topic,
                        payload: body,
                    });
                    messages += 1;
                }
                13 => {}
                14 => return Err("MQTT broker sent DISCONNECT".to_owned()),
                other => {
                    tracing::debug!("ignoring MQTT packet type {other}");
                }
            }
        }
    }
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
    fn mqtt_consume_subscribes_and_forwards_publish() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = listener.local_addr().expect("addr").to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut header = [0_u8; 2];
            stream.read_exact(&mut header).expect("connect header");
            assert_eq!(header[0], 0x10);
            let mut body = vec![0_u8; header[1] as usize];
            stream.read_exact(&mut body).expect("connect body");
            stream
                .write_all(&[0x20, 0x02, 0x00, 0x00])
                .expect("connack");
            let mut subscribe = [0_u8; 2];
            stream.read_exact(&mut subscribe).expect("subscribe header");
            assert_eq!(subscribe[0], 0x82);
            let mut remaining = [0_u8; 1];
            stream.read_exact(&mut remaining).expect("subscribe length");
            let mut body = vec![0_u8; remaining[0] as usize];
            stream.read_exact(&mut body).expect("subscribe body");
            stream
                .write_all(&[0x90, 0x03, 0x00, 0x01, 0x00])
                .expect("suback");
            let payload = b"{\"value\":42.5}";
            let topic = b"aquapilot/telemetry/effluent/cod";
            let mut publish = vec![0x30, 0];
            let remaining = (2 + topic.len() + payload.len()) as u8;
            publish[1] = remaining;
            publish.extend_from_slice(&(topic.len() as u16).to_be_bytes());
            publish.extend_from_slice(topic);
            publish.extend_from_slice(payload);
            stream.write_all(&publish).expect("publish");
            std::thread::sleep(Duration::from_millis(500));
        });
        let mut events = Vec::new();
        let config = json!({"broker": endpoint, "client_id": "aquapilot-test", "read":[{"topic":"aquapilot/telemetry/effluent/cod","point_id":"effluent.cod"}]});
        mqtt_consume(&config, Some(1), |event| events.push(event)).expect("consume");
        assert!(matches!(events.first(), Some(MqttEvent::Connected)));
        assert!(
            matches!(events.get(1), Some(MqttEvent::Message { topic, payload }) if topic == "aquapilot/telemetry/effluent/cod" && payload == b"{\"value\":42.5}")
        );
        server.join().expect("server");
    }

    #[test]
    fn mqtt_topic_filter_matches_wildcards() {
        let config = json!({"topics":["aquapilot/telemetry/#"],"read":[{"topic":"aquapilot/telemetry/effluent/cod","point_id":"effluent.cod"}]});
        assert_eq!(
            mqtt_topics(&config),
            vec![
                "aquapilot/telemetry/#".to_owned(),
                "aquapilot/telemetry/effluent/cod".to_owned()
            ]
        );
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

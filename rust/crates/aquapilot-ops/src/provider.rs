//! Provider layer for OpenAI-compatible, Anthropic Messages and Google Gemini.
//!
//! The TypeScript implementation is the oracle; this port keeps the same
//! trust boundary: user-supplied base URLs are validated before any DNS or
//! socket work, credentials never enter an error string, and a failed call
//! returns a readable error instead of panicking the service loop.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use url::{Host, Url};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Openai,
    Anthropic,
    Google,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmConfig {
    pub protocol: Protocol,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_ms: u64,
    pub max_output: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatReply {
    pub text: String,
    pub model: String,
}

#[derive(Debug, PartialEq)]
pub enum ProviderError {
    InvalidBaseUrl(String),
    Http(String),
    Status { code: u16, body: String },
    Shape(String),
    EmptyReply,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBaseUrl(msg) => write!(f, "invalid base url: {msg}"),
            Self::Http(msg) => write!(f, "provider request failed: {msg}"),
            Self::Status { code, body } => write!(f, "provider returned HTTP {code}: {body}"),
            Self::Shape(msg) => write!(f, "unexpected provider response: {msg}"),
            Self::EmptyReply => write!(f, "provider returned an empty reply"),
        }
    }
}

impl std::error::Error for ProviderError {}

fn blocked_host(host: &str) -> bool {
    matches!(
        host,
        "metadata.google.internal"
            | "metadata.goog"
            | "instance-data"
            | "169.254.169.254"
            | "100.100.100.200"
    )
}

fn embedded_ipv4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let parts = v6.segments();
    let first_five_zero = parts[..5].iter().all(|part| *part == 0);
    if first_five_zero && (parts[5] == 0 || parts[5] == 0xffff) {
        let hi = parts[6];
        let lo = parts[7];
        return Some(Ipv4Addr::new(
            (hi >> 8) as u8,
            (hi & 0xff) as u8,
            (lo >> 8) as u8,
            (lo & 0xff) as u8,
        ));
    }
    if parts[0] == 0x64 && parts[1] == 0xff9b {
        let hi = parts[6];
        let lo = parts[7];
        return Some(Ipv4Addr::new(
            (hi >> 8) as u8,
            (hi & 0xff) as u8,
            (lo >> 8) as u8,
            (lo & 0xff) as u8,
        ));
    }
    if parts[0] == 0x2002 {
        let hi = parts[1];
        let lo = parts[2];
        return Some(Ipv4Addr::new(
            (hi >> 8) as u8,
            (hi & 0xff) as u8,
            (lo >> 8) as u8,
            (lo & 0xff) as u8,
        ));
    }
    None
}

fn dangerous_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            (v4.octets()[0] == 169 && v4.octets()[1] == 254)
                || v4 == Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            // fe80::/10 link local, fc00::/7 unique local, :: unspecified.
            (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xfe00) == 0xfc00
                || v6 == Ipv6Addr::UNSPECIFIED
                || embedded_ipv4(v6).is_some_and(|v4| dangerous_ip(IpAddr::V4(v4)))
        }
    }
}

/// Validate the user-supplied endpoint. Private/loopback endpoints stay
/// allowed because self-hosted Ollama/vLLM are a supported deployment.
pub fn validate_base_url(raw: &str) -> Result<Url, ProviderError> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = Url::parse(trimmed)
        .map_err(|_| ProviderError::InvalidBaseUrl("地址不是合法的 URL".into()))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ProviderError::InvalidBaseUrl(
            "地址必须使用 http 或 https".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ProviderError::InvalidBaseUrl(
            "地址里不允许内嵌账号密码，请把密钥填在 API Key 字段".into(),
        ));
    }
    match url.host() {
        Some(Host::Domain(domain)) => {
            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
            if blocked_host(&normalized) {
                return Err(ProviderError::InvalidBaseUrl(
                    "该地址属于云元数据或链路本地服务，禁止访问".into(),
                ));
            }
        }
        Some(Host::Ipv4(v4)) => {
            if blocked_host(&v4.to_string()) || dangerous_ip(IpAddr::V4(v4)) {
                return Err(ProviderError::InvalidBaseUrl(
                    "该地址属于云元数据或链路本地服务，禁止访问".into(),
                ));
            }
        }
        Some(Host::Ipv6(v6)) => {
            if dangerous_ip(IpAddr::V6(v6)) {
                return Err(ProviderError::InvalidBaseUrl(
                    "该地址属于云元数据或链路本地服务，禁止访问".into(),
                ));
            }
        }
        None => return Err(ProviderError::InvalidBaseUrl("地址缺少主机名".into())),
    }
    Ok(url)
}

/// Resolve once and pin the first safe address on the HTTP client.
///
/// Validating only the URL leaves a DNS-rebinding window: a hostname can
/// resolve to a public address during the check and to 169.254.169.254 during
/// the request. Pinning the checked address closes that window for one hop.
async fn pinned_client(url: &Url, timeout_ms: u64) -> Result<(Client, Url), ProviderError> {
    let host = url
        .host_str()
        .ok_or_else(|| ProviderError::InvalidBaseUrl("地址缺少主机名".into()))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1)))
        .redirect(reqwest::redirect::Policy::none());
    if matches!(url.host(), Some(Host::Domain(_))) {
        let addrs: Vec<_> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|err| ProviderError::Http(format!("DNS lookup failed: {err}")))?
            .collect();
        if addrs.is_empty() {
            return Err(ProviderError::Http("DNS lookup returned no address".into()));
        }
        if addrs.iter().any(|addr| dangerous_ip(addr.ip())) {
            return Err(ProviderError::InvalidBaseUrl(
                "域名解析到云元数据或链路本地地址，禁止访问".into(),
            ));
        }
        builder = builder.resolve(host, addrs[0]);
    }
    let client = builder
        .build()
        .map_err(|err| ProviderError::Http(err.to_string()))?;
    Ok((client, url.clone()))
}

fn join(base: &Url, path: &str) -> Result<Url, ProviderError> {
    let mut url = base.clone();
    let base_path = url.path().trim_end_matches('/');
    let joined = if base_path.is_empty() || base_path == "/" {
        path.to_string()
    } else {
        format!("{base_path}{path}")
    };
    url.set_path(&joined);
    url.set_query(None);
    Ok(url)
}

fn response_text(value: &Value, protocol: Protocol) -> Result<String, ProviderError> {
    match protocol {
        Protocol::Openai => {
            let content = value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/choices/0/text").and_then(Value::as_str))
                .unwrap_or("");
            if content.trim().is_empty() {
                Err(ProviderError::Shape(
                    "choices[0].message.content is empty".into(),
                ))
            } else {
                Ok(content.to_string())
            }
        }
        Protocol::Anthropic => {
            let parts = value
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::Shape("content array missing".into()))?;
            let text: String = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect();
            if text.trim().is_empty() {
                Err(ProviderError::Shape("content has no text part".into()))
            } else {
                Ok(text)
            }
        }
        Protocol::Google => {
            let parts = value
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProviderError::Shape("candidates[0].content.parts missing".into())
                })?;
            let text: String = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect();
            if text.trim().is_empty() {
                Err(ProviderError::Shape("candidate has no text part".into()))
            } else {
                Ok(text)
            }
        }
    }
}

fn model_of(value: &Value, config: &LlmConfig) -> String {
    value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&config.model)
        .to_string()
}

/// Perform one non-streaming chat completion.
pub async fn chat(config: &LlmConfig, request: &ChatRequest) -> Result<ChatReply, ProviderError> {
    let base = validate_base_url(&config.base_url)?;
    let (client, base) = pinned_client(&base, config.timeout_ms).await?;

    let (url, body, auth_header) = match config.protocol {
        Protocol::Openai => {
            let mut messages = Vec::new();
            if let Some(system) = &request.system {
                messages.push(json!({"role": "system", "content": system}));
            }
            messages.extend(
                request
                    .messages
                    .iter()
                    .map(|m| json!({"role": m.role, "content": m.content})),
            );
            let body = json!({
                "model": config.model,
                "messages": messages,
                "max_tokens": config.max_output.max(1),
                "temperature": request.temperature,
            });
            (
                join(&base, "/chat/completions")?,
                body,
                Some(format!("Bearer {}", config.api_key)),
            )
        }
        Protocol::Anthropic => {
            let body = json!({
                "model": config.model,
                "max_tokens": config.max_output.max(1),
                "system": request.system,
                "messages": request.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
                "temperature": request.temperature,
            });
            (join(&base, "/v1/messages")?, body, None)
        }
        Protocol::Google => {
            let path = format!("/models/{}:generateContent", config.model);
            let body = json!({
                "systemInstruction": request.system.as_ref().map(|s| json!({"parts": [{"text": s}]})),
                "contents": request.messages.iter().map(|m| json!({"role": m.role, "parts": [{"text": m.content}]})).collect::<Vec<_>>(),
                "generationConfig": {"maxOutputTokens": config.max_output.max(1)},
            });
            let mut url = join(&base, &path)?;
            if !config.api_key.is_empty() {
                url.query_pairs_mut().append_pair("key", &config.api_key);
            }
            (url, body, None)
        }
    };

    let mut builder = client.post(url).json(&body);
    match config.protocol {
        Protocol::Openai => {
            if let Some(token) = auth_header {
                builder = builder.header("authorization", token);
            }
        }
        Protocol::Anthropic => {
            builder = builder
                .header("x-api-key", &config.api_key)
                .header("anthropic-version", "2023-06-01");
        }
        Protocol::Google => {}
    }
    let response = builder
        .send()
        .await
        .map_err(|err| ProviderError::Http(err.to_string()))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| ProviderError::Http(err.to_string()))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|err| ProviderError::Shape(format!("response is not JSON: {err}")))?;
    if !status.is_success() {
        let body = value.to_string();
        let body = if body.len() > 200 {
            format!("{}…", &body[..200])
        } else {
            body
        };
        return Err(ProviderError::Status {
            code: status.as_u16(),
            body,
        });
    }
    let text = response_text(&value, config.protocol)?;
    Ok(ChatReply {
        text,
        model: model_of(&value, config),
    })
}

/// A masked key is safe to show in the settings panel; the raw key stays in
/// memory and never enters audit payloads.
pub fn mask_api_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 8 {
        return "••••".into();
    }
    format!("{}••••{}", &key[..3], &key[key.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn mock_server(path_fragment: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let n = socket.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..n]);
            if !request.contains(path_fragment) {
                let bad =
                    "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                let _ = socket.write_all(bad.as_bytes()).await;
                return;
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    fn config(protocol: Protocol, base_url: String) -> LlmConfig {
        LlmConfig {
            protocol,
            base_url,
            api_key: "sk-secret".into(),
            model: "test-model".into(),
            timeout_ms: 5_000,
            max_output: 64,
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            system: Some("be brief".into()),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hello".into(),
            }],
            temperature: Some(0.2),
        }
    }

    #[tokio::test]
    async fn openai_compatible_reply_is_parsed() {
        let base = format!(
            "{}/v1",
            mock_server(
                "/v1/chat/completions",
                r#"{"model":"m","choices":[{"message":{"content":"ok"}}]}"#,
            )
            .await
        );
        let reply = chat(&config(Protocol::Openai, base), &request())
            .await
            .unwrap();
        assert_eq!(reply.text, "ok");
        assert_eq!(reply.model, "m");
    }

    #[tokio::test]
    async fn anthropic_and_google_replies_are_parsed() {
        let anthropic = mock_server(
            "/v1/messages",
            r#"{"model":"a","content":[{"type":"text","text":"hi"}]}"#,
        )
        .await;
        let reply = chat(&config(Protocol::Anthropic, anthropic), &request())
            .await
            .unwrap();
        assert_eq!(reply.text, "hi");

        let google = format!(
            "{}/v1beta",
            mock_server(
                "/v1beta/models/test-model:generateContent",
                r#"{"candidates":[{"content":{"parts":[{"text":"ho"}]}}]}"#,
            )
            .await
        );
        let reply = chat(&config(Protocol::Google, google), &request())
            .await
            .unwrap();
        assert_eq!(reply.text, "ho");
    }

    #[test]
    fn metadata_and_link_local_are_rejected_before_network() {
        assert!(validate_base_url("http://169.254.169.254/v1").is_err());
        assert!(validate_base_url("http://[::ffff:169.254.169.254]/v1").is_err());
        assert!(validate_base_url("http://100.100.100.200/v1").is_err());
        assert!(validate_base_url("http://metadata.google.internal./v1").is_err());
        assert!(validate_base_url("https://user%3Apass@example.com/v1").is_err());
    }

    #[test]
    fn loopback_and_private_endpoints_remain_supported() {
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("http://10.0.0.8:8000/v1").is_ok());
        assert_eq!(mask_api_key("sk-1234567890"), "sk-••••7890");
    }
}

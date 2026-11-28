//! Minimal MCP stdio server bridging to the AquaPilot HTTP API.
//!
//! It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, which is the
//! transport used by MCP clients that launch a local stdio server. The server
//! itself is stateless; all state lives in the AquaPilot service database.

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{json, Value};

pub struct McpServer {
    api: String,
    token: Option<String>,
    agent: ureq::Agent,
}

impl McpServer {
    pub fn new(api: String, token: Option<String>) -> Self {
        Self {
            api: api.trim_end_matches('/').to_owned(),
            token,
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(30))
                .build(),
        }
    }

    pub fn run(self) -> Result<(), String> {
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        for line in stdin.lock().lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let request: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    let _ = writeln!(
                        stdout,
                        "{}",
                        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {error}")}})
                    );
                    continue;
                }
            };
            let response = self.handle(&request);
            if let Some(response) = response {
                writeln!(stdout, "{response}").map_err(|error| error.to_string())?;
                stdout.flush().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn handle(&self, request: &Value) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "aquapilot-v2", "version": env!("CARGO_PKG_VERSION")},
            })),
            "notifications/initialized" => return None,
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools()})),
            "tools/call" => self.call_tool(&params),
            _ => Err(format!("method not found: {method}")),
        };
        let id = id?;
        Some(match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(message) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":message}})
            }
        })
    }

    fn call_tool(&self, params: &Value) -> Result<Value, String> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "params.name is required".to_owned())?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let tool_result = match name {
            "aquapilot_list_experiments" => {
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20);
                let status = args.get("status").and_then(Value::as_str).unwrap_or("");
                let mut path = format!("/api/v1/experiments?limit={limit}");
                if !status.is_empty() {
                    path.push_str("&status=");
                    path.push_str(status);
                }
                self.get(&path)
            }
            "aquapilot_get_experiment" => {
                let id = required_id(&args, "experiment_id")?;
                self.get(&format!("/api/v1/experiments/{id}"))
            }
            "aquapilot_get_experiment_report" => {
                let id = required_id(&args, "experiment_id")?;
                self.get_text(&format!("/api/v1/experiments/{id}/report.md"))
            }
            "aquapilot_run_experiment" => {
                let request = args
                    .get("request")
                    .cloned()
                    .ok_or_else(|| "arguments.request is required".to_owned())?;
                let key = args
                    .get("idempotency_key")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("mcp-{}", uuid_like()));
                self.post("/api/v1/experiments", &key, &request)
            }
            "aquapilot_explain_experiment" => {
                let id = required_id(&args, "experiment_id")?;
                let question = args
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                self.post(
                    "/api/v1/ai/explain",
                    &format!("mcp-ai-{}", uuid_like()),
                    &json!({"experiment_id":id,"question":question}),
                )
            }
            "aquapilot_get_study" => {
                let id = required_id(&args, "study_id")?;
                self.get(&format!("/api/v1/studies/{id}"))
            }
            other => Err(format!("unknown tool: {other}")),
        };
        match tool_result {
            Ok(value) => Ok(json!({
                "content": [{"type":"text","text": pretty(&value)}],
                "isError": false,
            })),
            Err(message) => Ok(json!({
                "content": [{"type":"text","text": message}],
                "isError": true,
            })),
        }
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path, None, None)
    }

    fn get_text(&self, path: &str) -> Result<Value, String> {
        let text = self.request_text(path)?;
        Ok(json!({"markdown": text}))
    }

    fn post(&self, path: &str, key: &str, body: &Value) -> Result<Value, String> {
        self.request("POST", path, Some(key), Some(body))
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        idempotency_key: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        let url = format!("{}{}", self.api, path);
        let mut request = self.agent.request(method, &url);
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        if let Some(key) = idempotency_key {
            request = request.set("Idempotency-Key", key);
        }
        let response = if let Some(body) = body {
            request.send_json(body.clone())
        } else {
            request.call()
        };
        match response {
            Ok(response) => response
                .into_json()
                .map_err(|error| format!("invalid JSON response: {error}")),
            Err(ureq::Error::Status(status, response)) => {
                let body = response.into_string().unwrap_or_default();
                Err(format!("HTTP {status}: {body}"))
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn request_text(&self, path: &str) -> Result<String, String> {
        let url = format!("{}{}", self.api, path);
        let mut request = self.agent.get(&url);
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        match request.call() {
            Ok(response) => response.into_string().map_err(|error| error.to_string()),
            Err(ureq::Error::Status(status, response)) => {
                let body = response.into_string().unwrap_or_default();
                Err(format!("HTTP {status}: {body}"))
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

fn required_id(args: &Value, field: &str) -> Result<String, String> {
    args.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("arguments.{field} is required"))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn tools() -> Vec<Value> {
    vec![
        json!({
            "name":"aquapilot_list_experiments",
            "description":"List recent AquaPilot experiments, optionally filtered by status.",
            "inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"status":{"type":"string","enum":["queued","running","succeeded","failed","cancelled"]}}}
        }),
        json!({
            "name":"aquapilot_get_experiment",
            "description":"Get one experiment with its request, status, result, analysis and alarms.",
            "inputSchema":{"type":"object","properties":{"experiment_id":{"type":"string"}},"required":["experiment_id"]}
        }),
        json!({
            "name":"aquapilot_get_experiment_report",
            "description":"Get the Markdown report for a finished experiment.",
            "inputSchema":{"type":"object","properties":{"experiment_id":{"type":"string"}},"required":["experiment_id"]}
        }),
        json!({
            "name":"aquapilot_run_experiment",
            "description":"Submit an experiment to the persistent queue. The request object uses the same schema as POST /api/v1/experiments.",
            "inputSchema":{"type":"object","properties":{"request":{"type":"object"},"idempotency_key":{"type":"string"}},"required":["request"]}
        }),
        json!({
            "name":"aquapilot_explain_experiment",
            "description":"Explain a finished experiment using the configured AI provider (remote OpenAI-compatible or local evidence rules).",
            "inputSchema":{"type":"object","properties":{"experiment_id":{"type":"string"},"question":{"type":"string"}},"required":["experiment_id"]}
        }),
        json!({
            "name":"aquapilot_get_study",
            "description":"Get a batch study by id, including child experiments and aggregate status.",
            "inputSchema":{"type":"object","properties":{"study_id":{"type":"string"}},"required":["study_id"]}
        }),
    ]
}

//! Experiment explanation provider.
//!
//! Default is a deterministic local rule provider. When `AQUAPILOT_AI_BASE_URL`
//! is set, the same evidence is sent to an OpenAI-compatible chat-completions
//! endpoint (DeepSeek, Qwen, vLLM, Ollama, etc.). Remote failures fall back to
//! the local answer with an explicit `degraded` flag; they are never silent.

use std::time::Duration;

use serde_json::{json, Value};

use crate::analysis::{analyze, Alarm};
use crate::error::ApiError;
use crate::store::Store;

#[derive(Clone)]
struct RemoteConfig {
    base_url: String,
    api_key: Option<String>,
    timeout: Duration,
}

#[derive(Clone)]
pub struct AiProvider {
    pub id: String,
    pub model: String,
    remote: Option<RemoteConfig>,
    store: Store,
}

impl AiProvider {
    pub fn new(store: Store) -> Self {
        let base_url = std::env::var("AQUAPILOT_AI_BASE_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty());
        let remote = base_url.map(|base_url| RemoteConfig {
            base_url,
            api_key: std::env::var("AQUAPILOT_AI_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            timeout: Duration::from_secs(
                std::env::var("AQUAPILOT_AI_TIMEOUT_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(20)
                    .clamp(2, 120),
            ),
        });
        Self {
            id: if remote.is_some() {
                "remote-openai-compatible".to_owned()
            } else {
                "local-evidence".to_owned()
            },
            model: std::env::var("AQUAPILOT_AI_MODEL").unwrap_or_else(|_| {
                if remote.is_some() {
                    "gpt-4o-mini".to_owned()
                } else {
                    "rules-v1".to_owned()
                }
            }),
            remote,
            store,
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "provider": self.id,
            "model": self.model,
            "mode": if self.remote.is_some() { "remote" } else { "local" },
            "remote_configured": self.remote.is_some(),
            "fallback": "local-evidence on remote error",
            "note": if self.remote.is_some() {
                "OpenAI-compatible /chat/completions; API key is read from AQUAPILOT_AI_API_KEY and never returned."
            } else {
                "No AQUAPILOT_AI_BASE_URL; explanations are deterministic local rules."
            },
        })
    }

    pub fn explain(
        &self,
        experiment_id: &str,
        question: &str,
        actor: &str,
    ) -> Result<Value, ApiError> {
        let record = self
            .store
            .get(experiment_id)
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "AI_STORE_ERROR",
                    "Could not load experiment",
                    error.to_string(),
                )
            })?
            .ok_or_else(|| {
                ApiError::not_found(format!("experiment {experiment_id} does not exist"))
            })?;
        let analysis = analyze(&record).ok_or_else(|| {
            ApiError::conflict(
                "AI_RESULT_NOT_READY",
                "experiment has no decodable result to explain",
            )
        })?;
        let local_answer = build_answer(&analysis.scorecard, &analysis.alarms, question);
        let mut remote_error = None;
        let answer = if let Some(remote) = &self.remote {
            match call_remote(remote, &analysis.scorecard, &analysis.alarms, question) {
                Ok(answer) => answer,
                Err(error) => {
                    remote_error = Some(error);
                    local_answer
                }
            }
        } else {
            local_answer
        };
        let audit = self
            .store
            .append_audit("ai.explain", actor, experiment_id, None, None, question)
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "AUDIT_WRITE_FAILED",
                    "AI audit failed",
                    error.to_string(),
                )
            })?;
        Ok(json!({
            "provider": self.id,
            "model": self.model,
            "experiment_id": experiment_id,
            "answer": answer,
            "degraded": remote_error.is_some(),
            "provider_error": remote_error,
            "scorecard": analysis.scorecard,
            "alarms": analysis.alarms,
            "audit": audit,
        }))
    }
}

fn call_remote(
    remote: &RemoteConfig,
    score: &crate::analysis::Scorecard,
    alarms: &[Alarm],
    question: &str,
) -> Result<String, String> {
    let evidence = json!({
        "scorecard": score,
        "alarms": alarms.iter().take(8).collect::<Vec<_>>(),
        "question": question,
    });
    let system = "你是污水处理厂的运行分析助手。只依据给出的评分卡与告警证据回答，不编造未给出的指标、BOD、能耗或设备状态。先给结论，再给证据、可能原因和下一步；中文，简洁。";
    let user = format!("实验证据（JSON）：\n{}", evidence);
    let body = json!({
        "model": std::env::var("AQUAPILOT_AI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_owned()),
        "temperature": 0.2,
        "messages": [
            {"role":"system","content":system},
            {"role":"user","content":user},
        ],
    });
    let agent = ureq::AgentBuilder::new().timeout(remote.timeout).build();
    let mut request = agent.post(&format!("{}/chat/completions", remote.base_url));
    if let Some(key) = &remote.api_key {
        request = request.set("Authorization", &format!("Bearer {key}"));
    }
    let response = request.send_json(body).map_err(|error| match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            format!(
                "HTTP {status}: {}",
                body.chars().take(300).collect::<String>()
            )
        }
        other => other.to_string(),
    })?;
    let value: Value = response
        .into_json()
        .map_err(|error| format!("invalid JSON: {error}"))?;
    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "response has no choices[0].message.content".to_owned())?;
    Ok(content.to_owned())
}

fn build_answer(score: &crate::analysis::Scorecard, alarms: &[Alarm], question: &str) -> String {
    let mut lines = vec![format!(
        "评分 {}，{}/{} 项达标；最大三本账残差 {:.2}%。",
        score.grade,
        score.passed,
        score.total,
        score.max_balance_residual_pct.unwrap_or(0.0)
    )];
    if alarms.is_empty() {
        lines.push("没有出水或账本告警。".to_owned());
    } else {
        lines.push(format!("共 {} 条告警：", alarms.len()));
        for alarm in alarms.iter().take(4) {
            lines.push(format!("- {}：{}", alarm.code, alarm.message));
            if let Some(cause) = alarm.possible_causes.first() {
                lines.push(format!("  可能原因：{cause}"));
            }
            if let Some(action) = alarm.recommended_actions.first() {
                lines.push(format!("  建议：{action}"));
            }
        }
    }
    let question = question.trim();
    if question.is_empty() {
        lines.push("建议先处理达标数最少的指标，再看三本账是否在 30 d 闭环。".to_owned());
    } else {
        lines.push(format!(
            "针对“{question}”：上面列出的告警和证据就是当前可复核的答案；短时实验的账本残差先看库存变化，不要当成模型错误。"
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    #[test]
    fn remote_openai_compatible_answer_is_used() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = stream.read(&mut chunk).expect("read");
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buffer);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let header_end = buffer
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|index| index + 4)
                        .unwrap_or(buffer.len());
                    if buffer.len() >= header_end + length {
                        break;
                    }
                }
            }
            let body = r#"{"choices":[{"message":{"content":"远端回答：先处理 TP。"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write");
        });

        let store = Store::in_memory(4).expect("store");
        store
            .create("exp-ai", "remote-ai", "asm2d", "{}", None, "hash")
            .expect("create");
        store.claim_next().expect("claim").expect("queued");
        store
            .finish_success("exp-ai", r#"{"reactors":[]}"#, "[]")
            .expect("finish");
        let provider = AiProvider {
            id: "remote-openai-compatible".to_owned(),
            model: "mock-model".to_owned(),
            remote: Some(RemoteConfig {
                base_url: base,
                api_key: Some("test-key".to_owned()),
                timeout: Duration::from_secs(5),
            }),
            store,
        };
        let result = provider
            .explain("exp-ai", "先看什么？", "tester")
            .expect("explain");
        assert_eq!(result["answer"], "远端回答：先处理 TP。");
        assert_eq!(result["degraded"], false);
        server.join().expect("server");
    }
}

//! Local evidence provider for experiment explanations.
//!
//! This is deliberately a rule-based provider, not a remote LLM. It reads only
//! the stored experiment analysis and returns a deterministic explanation with
//! the same alarm and ledger evidence the UI shows. A future remote provider can
//! reuse this request/response shape without changing the audit contract.

use serde_json::{json, Value};

use crate::analysis::{analyze, Alarm};
use crate::error::ApiError;
use crate::store::Store;

#[derive(Clone)]
pub struct AiProvider {
    pub id: &'static str,
    pub model: &'static str,
    store: Store,
}

impl AiProvider {
    pub fn new(store: Store) -> Self {
        Self {
            id: "local-evidence",
            model: "rules-v1",
            store,
        }
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
        let answer = build_answer(&analysis.scorecard, &analysis.alarms, question);
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
            "scorecard": analysis.scorecard,
            "alarms": analysis.alarms,
            "audit": audit,
        }))
    }
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

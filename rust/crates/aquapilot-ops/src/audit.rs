//! Append-only audit ledger with a SHA-256 hash chain.
//!
//! The TypeScript server records decisions and reviews in SQLite; that
//! provenance is lost once the row is updated. The Rust ledger is additive:
//! every event carries `prev_hash` and `hash`, so deleting or editing an old
//! line is detectable even without an external signature.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub const AUDIT_GENESIS_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditDraft {
    pub at_unix_ms: u64,
    pub kind: String,
    pub actor: String,
    pub subject: String,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEvent {
    pub seq: u64,
    pub at_unix_ms: u64,
    pub kind: String,
    pub actor: String,
    pub subject: String,
    pub detail: Value,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Debug)]
pub enum AuditError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Chain(String),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "audit io: {err}"),
            Self::Json(err) => write!(f, "audit json: {err}"),
            Self::Chain(msg) => write!(f, "audit chain: {msg}"),
        }
    }
}

impl std::error::Error for AuditError {}

impl From<std::io::Error> for AuditError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for AuditError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Canonical digest input. `serde_json` maps are BTreeMap by default, so nested
/// object keys are already deterministic; strings are serialized as JSON so a
/// pipe character inside `subject` cannot collide with the separator.
fn digest_input(seq: u64, draft: &AuditDraft, prev_hash: &str) -> Vec<u8> {
    let payload = serde_json::json!({
        "seq": seq,
        "at_unix_ms": draft.at_unix_ms,
        "kind": draft.kind,
        "actor": draft.actor,
        "subject": draft.subject,
        "detail": draft.detail,
    });
    let canonical = serde_json::to_string(&payload).unwrap_or_default();
    format!("{prev_hash}\n{canonical}").into_bytes()
}

fn hash_event(seq: u64, draft: &AuditDraft, prev_hash: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(digest_input(seq, draft, prev_hash));
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

#[derive(Debug, Clone)]
pub struct AuditLedger {
    path: Option<PathBuf>,
    events: Vec<AuditEvent>,
}

impl AuditLedger {
    /// Open an existing ledger and verify its chain before accepting new writes.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AuditError> {
        let path = path.as_ref().to_path_buf();
        let mut events = Vec::new();
        if path.exists() {
            let file = File::open(&path)?;
            for (index, line) in BufReader::new(file).lines().enumerate() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let event: AuditEvent = serde_json::from_str(&line).map_err(|err| {
                    AuditError::Chain(format!("line {} is not valid JSON: {err}", index + 1))
                })?;
                events.push(event);
            }
        }
        let ledger = Self {
            path: Some(path),
            events,
        };
        ledger.verify()?;
        Ok(ledger)
    }

    /// In-memory ledger used by tests and ephemeral deployments.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            events: Vec::new(),
        }
    }

    pub fn events(&self) -> &[AuditEvent] {
        &self.events
    }

    pub fn append(&mut self, draft: AuditDraft) -> Result<AuditEvent, AuditError> {
        let seq = self.events.last().map(|e| e.seq + 1).unwrap_or(1);
        let prev_hash = self
            .events
            .last()
            .map(|e| e.hash.clone())
            .unwrap_or_else(|| AUDIT_GENESIS_HASH.to_string());
        let hash = hash_event(seq, &draft, &prev_hash);
        let event = AuditEvent {
            seq,
            at_unix_ms: draft.at_unix_ms,
            kind: draft.kind,
            actor: draft.actor,
            subject: draft.subject,
            detail: draft.detail,
            prev_hash,
            hash,
        };
        if let Some(path) = &self.path {
            let mut file = OpenOptions::new().create(true).append(true).open(path)?;
            let line = serde_json::to_string(&event)?;
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
            file.flush()?;
        }
        self.events.push(event.clone());
        Ok(event)
    }

    /// Recompute every hash and check sequence/prev-hash continuity.
    pub fn verify(&self) -> Result<(), AuditError> {
        let mut prev = AUDIT_GENESIS_HASH.to_string();
        for (index, event) in self.events.iter().enumerate() {
            let expected_seq = index as u64 + 1;
            if event.seq != expected_seq {
                return Err(AuditError::Chain(format!(
                    "sequence gap: expected {expected_seq}, got {}",
                    event.seq
                )));
            }
            if event.prev_hash != prev {
                return Err(AuditError::Chain(format!(
                    "prev hash mismatch at seq {}",
                    event.seq
                )));
            }
            let draft = AuditDraft {
                at_unix_ms: event.at_unix_ms,
                kind: event.kind.clone(),
                actor: event.actor.clone(),
                subject: event.subject.clone(),
                detail: event.detail.clone(),
            };
            let recomputed = hash_event(event.seq, &draft, &prev);
            if recomputed != event.hash {
                return Err(AuditError::Chain(format!(
                    "hash mismatch at seq {}",
                    event.seq
                )));
            }
            prev = event.hash.clone();
        }
        Ok(())
    }
}

/// Decision de-duplication, matching the TypeScript `shouldRecordDecision`.
pub const DECISION_AUDIT_WINDOW_MIN: f64 = 60.0;

#[derive(Debug, Clone, PartialEq)]
pub struct DecisionAuditMark {
    pub key: String,
    pub at_min: f64,
}

pub fn decision_fingerprint(action: &str, severity: &str, summary: &str) -> String {
    format!("{action}|{severity}|{summary}")
}

pub fn should_record_decision(
    last: Option<&DecisionAuditMark>,
    fingerprint: &str,
    at_min: f64,
    force: bool,
    window_min: f64,
) -> bool {
    if force {
        return true;
    }
    match last {
        None => true,
        Some(mark) if mark.key != fingerprint => true,
        Some(mark) => at_min - mark.at_min >= window_min,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn draft(at: u64, subject: &str) -> AuditDraft {
        AuditDraft {
            at_unix_ms: at,
            kind: "decision".into(),
            actor: "ai".into(),
            subject: subject.into(),
            detail: json!({"action": "hold", "risk": "critical"}),
        }
    }

    #[test]
    fn chain_is_continuous_and_detects_tampering() {
        let dir = std::env::temp_dir().join(format!("aquapilot-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");
        let mut ledger = AuditLedger::open(&path).unwrap();
        ledger.append(draft(1, "first")).unwrap();
        ledger.append(draft(2, "second")).unwrap();
        assert_eq!(ledger.events().len(), 2);
        assert_eq!(ledger.events()[1].prev_hash, ledger.events()[0].hash);
        assert!(ledger.verify().is_ok());

        let mut line = std::fs::read_to_string(&path).unwrap();
        line = line.replacen("first", "tampered", 1);
        std::fs::write(&path, line).unwrap();
        assert!(matches!(
            AuditLedger::open(&path),
            Err(AuditError::Chain(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedupe_window_matches_ts_contract() {
        let mark = DecisionAuditMark {
            key: "hold|critical|same".into(),
            at_min: 100.0,
        };
        assert!(!should_record_decision(
            Some(&mark),
            "hold|critical|same",
            120.0,
            false,
            60.0
        ));
        assert!(should_record_decision(
            Some(&mark),
            "hold|critical|same",
            160.0,
            false,
            60.0
        ));
        assert!(should_record_decision(
            Some(&mark),
            "hold|critical|same",
            101.0,
            true,
            60.0
        ));
        assert!(should_record_decision(
            Some(&mark),
            "hold|warn|same",
            101.0,
            false,
            60.0
        ));
    }
}

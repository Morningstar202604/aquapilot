//! SQLite-backed experiment queue.
//!
//! The service keeps the queue in a single SQLite file: experiments are
//! addressable resources, and a process restart requeues work that was
//! interrupted while running. Idempotency is stored as hashes of the key and
//! request body; raw idempotency tokens are never persisted.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::ApiError;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("experiment queue is full")]
    QueueFull,
    #[error("idempotency key was reused with a different request")]
    IdempotencyConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentRecord {
    pub id: String,
    pub name: String,
    pub model: String,
    pub status: String,
    pub progress: f64,
    pub cancel_requested: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub request_json: String,
    pub error: Option<String>,
    pub result_json: Option<String>,
    pub samples_json: Option<String>,
    #[serde(skip)]
    pub idempotency_key_hash: Option<String>,
    #[serde(skip)]
    pub request_hash: Option<String>,
}

#[derive(Debug)]
pub struct CreateOutcome {
    pub record: ExperimentRecord,
    /// `true` when this request created a new resource, `false` for a replay.
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    Cancelled,
    CancelRequested,
    NotFound,
    Terminal,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    capacity: usize,
}

impl Store {
    pub fn open(path: impl AsRef<Path>, capacity: usize) -> Result<Self, StoreError> {
        if capacity == 0 {
            return Err(StoreError::QueueFull);
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn, capacity)
    }

    pub fn in_memory(capacity: usize) -> Result<Self, StoreError> {
        if capacity == 0 {
            return Err(StoreError::QueueFull);
        }
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn, capacity)
    }

    fn from_connection(conn: Connection, capacity: usize) -> Result<Self, StoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS experiments (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 model TEXT NOT NULL,
                 status TEXT NOT NULL,
                 progress REAL NOT NULL DEFAULT 0,
                 cancel_requested INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 started_at INTEGER,
                 finished_at INTEGER,
                 error TEXT,
                 result_json TEXT,
                 samples_json TEXT,
                 request_json TEXT NOT NULL,
                 idempotency_key_hash TEXT,
                 request_hash TEXT
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_idempotency
                 ON experiments(idempotency_key_hash)
                 WHERE idempotency_key_hash IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_experiments_status
                 ON experiments(status, created_at);",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            capacity,
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Requeue experiments that were running when the process stopped. A
    /// cancel requested before the crash is honored instead of requeued.
    pub fn recover(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let now = now_unix();
        conn.execute(
            "UPDATE experiments
             SET status = 'cancelled', finished_at = ?1, updated_at = ?1
             WHERE status = 'running' AND cancel_requested = 1",
            params![now],
        )?;
        conn.execute(
            "UPDATE experiments
             SET status = 'queued', progress = 0, started_at = NULL, updated_at = ?1
             WHERE status = 'running' AND cancel_requested = 0",
            params![now],
        )?;
        Ok(())
    }

    pub fn create(
        &self,
        id: &str,
        name: &str,
        model: &str,
        request_json: &str,
        idempotency_key_hash: Option<&str>,
        request_hash: &str,
    ) -> Result<CreateOutcome, StoreError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        let tx = conn.transaction()?;
        if let Some(key_hash) = idempotency_key_hash {
            if let Some(existing) = find_by_idempotency(&tx, key_hash)? {
                if existing.request_hash.as_deref() == Some(request_hash) {
                    return Ok(CreateOutcome {
                        record: existing,
                        created: false,
                    });
                }
                return Err(StoreError::IdempotencyConflict);
            }
        }
        let active: i64 = tx.query_row(
            "SELECT COUNT(*) FROM experiments WHERE status IN ('queued', 'running')",
            [],
            |row| row.get(0),
        )?;
        if active as usize >= self.capacity {
            return Err(StoreError::QueueFull);
        }
        let now = now_unix();
        tx.execute(
            "INSERT INTO experiments
             (id, name, model, status, progress, cancel_requested, created_at, updated_at,
              request_json, idempotency_key_hash, request_hash)
             VALUES (?1, ?2, ?3, 'queued', 0.0, 0, ?4, ?4, ?5, ?6, ?7)",
            params![
                id,
                name,
                model,
                now,
                request_json,
                idempotency_key_hash,
                request_hash
            ],
        )?;
        let record = get_in_tx(&tx, id)?.expect("inserted experiment must exist");
        tx.commit()?;
        Ok(CreateOutcome {
            record,
            created: true,
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<ExperimentRecord>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        get_in_conn(&conn, id)
    }

    pub fn list(
        &self,
        status: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<ExperimentRecord>, Option<String>), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let limit = limit.clamp(1, 100) as i64;
        let mut stmt = if let Some(_status) = status {
            conn.prepare(
                "SELECT id, name, model, status, progress, cancel_requested, created_at,
                        updated_at, request_json, error, result_json, samples_json,
                        idempotency_key_hash, request_hash
                 FROM experiments WHERE status = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3",
            )?
        } else {
            conn.prepare(
                "SELECT id, name, model, status, progress, cancel_requested, created_at,
                        updated_at, request_json, error, result_json, samples_json,
                        idempotency_key_hash, request_hash
                 FROM experiments
                 ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
            )?
        };
        let rows = if let Some(status) = status {
            stmt.query_map(params![status, limit + 1, offset as i64], row_to_record)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map(params![limit + 1, offset as i64], row_to_record)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let has_more = rows.len() > limit as usize;
        let records: Vec<_> = rows.into_iter().take(limit as usize).collect();
        let next = if has_more {
            Some((offset + records.len()).to_string())
        } else {
            None
        };
        Ok((records, next))
    }

    pub fn claim_next(&self) -> Result<Option<ExperimentRecord>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let now = now_unix();
        let candidate: Option<String> = conn
            .query_row(
                "SELECT id FROM experiments WHERE status = 'queued'
                 ORDER BY created_at ASC, id ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = candidate else {
            return Ok(None);
        };
        let changed = conn.execute(
            "UPDATE experiments SET status = 'running', started_at = ?1, updated_at = ?1
             WHERE id = ?2 AND status = 'queued'",
            params![now, id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        get_in_conn(&conn, &id)
    }

    pub fn set_progress(&self, id: &str, progress: f64) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE experiments SET progress = ?1, updated_at = ?2
             WHERE id = ?3 AND status = 'running'",
            params![progress.clamp(0.0, 1.0), now_unix(), id],
        )?;
        Ok(())
    }

    /// Returns `true` when the result was committed. A concurrent cancel
    /// request wins over a late success and leaves the experiment `running`
    /// for `finish_cancelled` to close.
    pub fn finish_success(
        &self,
        id: &str,
        result_json: &str,
        samples_json: &str,
    ) -> Result<bool, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let now = now_unix();
        let changed = conn.execute(
            "UPDATE experiments
             SET status = 'succeeded', progress = 1, updated_at = ?1, finished_at = ?1,
                 result_json = ?2, samples_json = ?3, error = NULL
             WHERE id = ?4 AND status = 'running' AND cancel_requested = 0",
            params![now, result_json, samples_json, id],
        )?;
        Ok(changed != 0)
    }

    pub fn finish_failure(&self, id: &str, error: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let now = now_unix();
        conn.execute(
            "UPDATE experiments
             SET status = 'failed', updated_at = ?1, finished_at = ?1, error = ?2
             WHERE id = ?3 AND status = 'running'",
            params![now, error, id],
        )?;
        Ok(())
    }

    pub fn finish_cancelled(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let now = now_unix();
        conn.execute(
            "UPDATE experiments
             SET status = 'cancelled', updated_at = ?1, finished_at = ?1, error = NULL
             WHERE id = ?2 AND status = 'running'",
            params![now, id],
        )?;
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<CancelOutcome, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM experiments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(status) = status else {
            return Ok(CancelOutcome::NotFound);
        };
        let now = now_unix();
        match status.as_str() {
            "queued" => {
                conn.execute(
                    "UPDATE experiments SET status = 'cancelled', cancel_requested = 1,
                     updated_at = ?1, finished_at = ?1
                     WHERE id = ?2 AND status = 'queued'",
                    params![now, id],
                )?;
                Ok(CancelOutcome::Cancelled)
            }
            "running" => {
                conn.execute(
                    "UPDATE experiments SET cancel_requested = 1, updated_at = ?1
                     WHERE id = ?2 AND status = 'running'",
                    params![now, id],
                )?;
                Ok(CancelOutcome::CancelRequested)
            }
            _ => Ok(CancelOutcome::Terminal),
        }
    }

    pub fn is_cancel_requested(&self, id: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let value: Option<i64> = conn
            .query_row(
                "SELECT cancel_requested FROM experiments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.unwrap_or(0) != 0)
    }

    pub fn active_count(&self) -> Result<usize, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM experiments WHERE status IN ('queued', 'running')",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }
}

fn find_by_idempotency(
    tx: &Transaction<'_>,
    key_hash: &str,
) -> Result<Option<ExperimentRecord>, StoreError> {
    tx.query_row(
        "SELECT id, name, model, status, progress, cancel_requested, created_at,
                updated_at, request_json, error, result_json, samples_json,
                idempotency_key_hash, request_hash
         FROM experiments WHERE idempotency_key_hash = ?1",
        params![key_hash],
        row_to_record,
    )
    .optional()
    .map_err(StoreError::from)
}

fn get_in_conn(conn: &Connection, id: &str) -> Result<Option<ExperimentRecord>, StoreError> {
    conn.query_row(
        "SELECT id, name, model, status, progress, cancel_requested, created_at,
                updated_at, request_json, error, result_json, samples_json,
                idempotency_key_hash, request_hash
         FROM experiments WHERE id = ?1",
        params![id],
        row_to_record,
    )
    .optional()
    .map_err(StoreError::from)
}

fn get_in_tx(tx: &Transaction<'_>, id: &str) -> Result<Option<ExperimentRecord>, StoreError> {
    tx.query_row(
        "SELECT id, name, model, status, progress, cancel_requested, created_at,
                updated_at, request_json, error, result_json, samples_json,
                idempotency_key_hash, request_hash
         FROM experiments WHERE id = ?1",
        params![id],
        row_to_record,
    )
    .optional()
    .map_err(StoreError::from)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExperimentRecord> {
    Ok(ExperimentRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        model: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        cancel_requested: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        request_json: row.get(8)?,
        error: row.get(9)?,
        result_json: row.get(10)?,
        samples_json: row.get(11)?,
        idempotency_key_hash: row.get(12)?,
        request_hash: row.get(13)?,
    })
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

pub fn to_api_error(error: StoreError) -> ApiError {
    match error {
        StoreError::QueueFull => ApiError::queue_full(),
        StoreError::IdempotencyConflict => ApiError::idempotency_conflict(),
        StoreError::Sqlite(err) => {
            tracing::error!(error = %err, "sqlite store failure");
            ApiError::internal("SQLITE_ERROR", "persistence failure")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::in_memory(2).expect("store")
    }

    #[test]
    fn create_and_get_roundtrip() {
        let store = store();
        let outcome = store
            .create(
                "exp-1",
                "run-1",
                "asm1",
                "{\"model\":\"asm1\"}",
                None,
                "body-hash",
            )
            .expect("create");
        assert!(outcome.created);
        let loaded = store.get("exp-1").expect("get").expect("record");
        assert_eq!(loaded.status, "queued");
        assert_eq!(loaded.name, "run-1");
    }

    #[test]
    fn idempotent_replay_and_conflict() {
        let store = store();
        let first = store
            .create(
                "exp-1",
                "run-1",
                "asm1",
                "body-a",
                Some("key-hash"),
                "hash-a",
            )
            .expect("first");
        assert!(first.created);
        let replay = store
            .create(
                "exp-2",
                "run-1",
                "asm1",
                "body-a",
                Some("key-hash"),
                "hash-a",
            )
            .expect("replay");
        assert!(!replay.created);
        assert_eq!(replay.record.id, "exp-1");
        let conflict = store.create(
            "exp-2",
            "run-1",
            "asm1",
            "body-b",
            Some("key-hash"),
            "hash-b",
        );
        assert!(matches!(conflict, Err(StoreError::IdempotencyConflict)));
    }

    #[test]
    fn queue_full_is_explicit() {
        let store = store();
        store
            .create("exp-1", "run-1", "asm1", "body", None, "hash-1")
            .expect("first");
        store
            .create("exp-2", "run-2", "asm1", "body", None, "hash-2")
            .expect("second");
        let full = store.create("exp-3", "run-3", "asm1", "body", None, "hash-3");
        assert!(matches!(full, Err(StoreError::QueueFull)));
    }

    #[test]
    fn queued_cancel_and_claim() {
        let store = store();
        store
            .create("exp-1", "run-1", "asm1", "body", None, "hash-1")
            .expect("create");
        assert_eq!(
            store.cancel("exp-1").expect("cancel"),
            CancelOutcome::Cancelled
        );
        assert!(store.claim_next().expect("claim").is_none());
    }

    #[test]
    fn recover_requeues_interrupted_file_backed_work() {
        let path = std::env::temp_dir().join(format!(
            "aquapilot-store-recovery-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let store = Store::open(&path, 2).expect("open");
            store
                .create("exp-1", "run-1", "asm1", "body", None, "hash-1")
                .expect("create");
            let claimed = store.claim_next().expect("claim").expect("running");
            assert_eq!(claimed.status, "running");
        }
        {
            let store = Store::open(&path, 2).expect("reopen");
            store.recover().expect("recover");
            let loaded = store.get("exp-1").expect("get").expect("record");
            assert_eq!(loaded.status, "queued");
            assert_eq!(loaded.progress, 0.0);
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }

    #[test]
    fn recover_requeues_running_and_honors_cancel() {
        let store = store();
        store
            .create("exp-1", "run-1", "asm1", "body", None, "hash-1")
            .expect("create");
        let _ = store.claim_next().expect("claim");
        store.cancel("exp-1").expect("cancel running");
        store.recover().expect("recover");
        let loaded = store.get("exp-1").expect("get").expect("record");
        assert_eq!(loaded.status, "cancelled");
    }
}

//! Durable single-worker experiment executor.

use std::thread;
use std::time::Duration;

use crate::runner::{run, ExperimentRequest, RunError};
use crate::store::Store;

pub fn spawn_worker(store: Store) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("aquapilot-experiment-worker".to_owned())
        .spawn(move || worker_loop(store))
        .expect("failed to spawn experiment worker")
}

fn worker_loop(store: Store) {
    loop {
        match store.claim_next() {
            Ok(Some(record)) => execute(&store, record),
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                tracing::error!(error = %error, "failed to claim experiment");
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

fn execute(store: &Store, record: crate::store::ExperimentRecord) {
    let id = record.id.clone();
    let request: ExperimentRequest = match serde_json::from_str(&record.request_json) {
        Ok(request) => request,
        Err(error) => {
            let _ = store.finish_failure(&id, &format!("stored request is invalid: {error}"));
            return;
        }
    };
    let cancel = || store.is_cancel_requested(&id).unwrap_or(false);
    let progress = |value: f64| {
        let _ = store.set_progress(&id, value);
    };
    tracing::info!(experiment = %id, model = %record.model, "experiment started");
    match run(&request, &cancel, &progress) {
        Ok(result) => {
            let result_json = match serde_json::to_string(&result.snapshot) {
                Ok(json) => json,
                Err(error) => {
                    let _ =
                        store.finish_failure(&id, &format!("result serialization failed: {error}"));
                    return;
                }
            };
            let samples_json = match serde_json::to_string(&result.samples) {
                Ok(json) => json,
                Err(error) => {
                    let _ =
                        store.finish_failure(&id, &format!("sample serialization failed: {error}"));
                    return;
                }
            };
            if store.is_cancel_requested(&id).unwrap_or(false) {
                let _ = store.finish_cancelled(&id);
                tracing::info!(experiment = %id, "experiment cancelled at end of run");
            } else {
                match store.finish_success(&id, &result_json, &samples_json) {
                    Ok(true) => tracing::info!(experiment = %id, "experiment succeeded"),
                    Ok(false) => {
                        let _ = store.finish_cancelled(&id);
                        tracing::info!(experiment = %id, "experiment cancelled at commit");
                    }
                    Err(error) => {
                        tracing::error!(experiment = %id, error = %error, "failed to persist result");
                    }
                }
            }
        }
        Err(RunError::Cancelled) => {
            let _ = store.finish_cancelled(&id);
            tracing::info!(experiment = %id, "experiment cancelled");
        }
        Err(error) => {
            if store.is_cancel_requested(&id).unwrap_or(false) {
                let _ = store.finish_cancelled(&id);
                tracing::info!(experiment = %id, "experiment cancelled after model error");
            } else {
                let _ = store.finish_failure(&id, &error.to_string());
                tracing::warn!(experiment = %id, error = %error, "experiment failed");
            }
        }
    }
}

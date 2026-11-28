//! Queue watchdog: detects a worker that stopped updating a running experiment.
//!
//! It does not kill or restart work. It makes the condition visible in `/api/health`
//! and keeps a last-check timestamp so an external supervisor can act.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::store::Store;

#[derive(Clone)]
pub struct Watchdog {
    store: Store,
    status: Arc<Mutex<Value>>,
    stale_after_seconds: u64,
}

impl Watchdog {
    pub fn new(store: Store) -> Self {
        let stale_after_seconds = std::env::var("AQUAPILOT_WATCHDOG_STALE_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(300);
        Self {
            store,
            status: Arc::new(Mutex::new(json!({
                "healthy": null,
                "checked_at": null,
                "stale_after_seconds": stale_after_seconds,
                "warning": "watchdog has not run yet"
            }))),
            stale_after_seconds,
        }
    }

    pub fn check(&self) {
        let next = match self.store.oldest_running_age_seconds() {
            Ok(Some(age)) if age > self.stale_after_seconds => json!({
                "healthy": false,
                "checked_at": now_seconds(),
                "stale_after_seconds": self.stale_after_seconds,
                "oldest_running_seconds": age,
                "warning": format!("a running experiment has not updated its checkpoint for {age} s"),
            }),
            Ok(oldest) => json!({
                "healthy": true,
                "checked_at": now_seconds(),
                "stale_after_seconds": self.stale_after_seconds,
                "oldest_running_seconds": oldest,
            }),
            Err(error) => json!({
                "healthy": false,
                "checked_at": now_seconds(),
                "stale_after_seconds": self.stale_after_seconds,
                "warning": format!("queue watch failed: {error}"),
            }),
        };
        *self.status.lock().expect("watchdog mutex") = next;
    }

    pub fn snapshot(&self) -> Value {
        self.status.lock().expect("watchdog mutex").clone()
    }

    pub fn spawn(&self) {
        let watchdog = self.clone();
        thread::Builder::new()
            .name("aquapilot-watchdog".to_owned())
            .spawn(move || loop {
                watchdog.check();
                thread::sleep(Duration::from_secs(5));
            })
            .expect("failed to spawn watchdog");
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

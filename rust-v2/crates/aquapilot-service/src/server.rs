//! Service bootstrap: open the queue, recover interrupted work, start the
//! worker, and serve HTTP.

use std::error::Error;

use tokio::net::TcpListener;

use crate::api::build_router;
use crate::store::Store;
use crate::worker::spawn_worker;

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub bind: String,
    pub db_path: String,
    pub queue_capacity: usize,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:5173".to_owned(),
            db_path: "aquapilot.sqlite".to_owned(),
            queue_capacity: 32,
        }
    }
}

pub fn serve(config: ServiceConfig) -> Result<(), Box<dyn Error + Send + Sync>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let store = Store::open(&config.db_path, config.queue_capacity)?;
        store.recover()?;
        let _worker = spawn_worker(store.clone());
        let listener = TcpListener::bind(&config.bind).await?;
        tracing::info!(bind = %config.bind, db = %config.db_path, "aquapilot service listening");
        axum::serve(listener, build_router(store))
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
        Ok(())
    })
}

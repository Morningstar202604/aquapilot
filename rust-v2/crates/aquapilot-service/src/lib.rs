//! AquaPilot V2 service: persistent experiment queue and HTTP API.
//!
//! The crate is deliberately thin. Model execution is delegated to
//! `aquapilot-model` and `aquapilot-engine`; this layer owns request
//! validation, idempotency, durable status, cancellation flags, and report
//! rendering.

// Axum handlers return this error type directly; keeping the RFC 9457
// problem fields inline is more readable than boxing every handler result.
#![allow(clippy::result_large_err)]
#![recursion_limit = "256"]

pub mod ai;
pub mod analysis;
pub mod api;
pub mod error;
pub mod gateway;
pub mod industrial;
pub mod legacy;
pub mod opcua;
pub mod runner;
pub mod security;
pub mod server;
pub mod store;
pub mod study;
pub mod watchdog;
pub mod worker;

pub use api::{build_router, AppState};
pub use error::{ApiError, FieldError};
pub use runner::{run, ExperimentRequest, ModelKind, Sample};
pub use server::{serve, ServiceConfig};
pub use store::{CancelOutcome, ExperimentRecord, Store};

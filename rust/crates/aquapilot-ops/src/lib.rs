//! M2 operations layer, ported to Rust before the HTTP/WS server swap.
//!
//! The crate is deliberately independent from the core solver: the server can
//! adopt it without changing a single numerical path. Every module is pure
//! except the audit file writer and the provider HTTP client.

#![forbid(unsafe_code)]

pub mod audit;
pub mod provider;
pub mod rate_limit;
pub mod watchdog;

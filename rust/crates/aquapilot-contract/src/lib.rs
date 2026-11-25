//! Frozen HTTP/WS contract for the M2-1 server migration.
//!
//! The JSON is generated from the TypeScript production service by
//! `scripts/gen-http-contract.ts` and checked in CI. This crate deliberately
//! exposes the contract as data; it does **not** pretend to be the migrated
//! Rust server. A route listed here is an obligation, not an implementation.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

pub const HTTP_CONTRACT_JSON: &str = include_str!("../../../golden/http-contract.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub schema_version: u32,
    pub generated_by: String,
    pub oracle: String,
    pub note: String,
    pub sources: BTreeMap<String, String>,
    pub http: HttpContract,
    pub ws: WsContract,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpContract {
    pub methods: Vec<String>,
    pub public: Vec<String>,
    pub legacy: Vec<String>,
    pub legacy_prefixes: Vec<String>,
    pub meta: Vec<String>,
    pub versioned: Vec<String>,
    pub mcp: Vec<String>,
    pub unauthorized_status: u16,
    pub method_not_allowed_status: u16,
    pub unknown_api_status: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsContract {
    pub path: String,
    pub max_payload_bytes: u64,
    pub client_types: Vec<String>,
    pub server_types: Vec<String>,
}

static CONTRACT: OnceLock<Contract> = OnceLock::new();

/// Parse and cache the checked-in contract.
///
/// A malformed golden is a build/test failure, not a recoverable runtime
/// condition: serving a partial route table silently is worse than refusing to
/// start the migration binary.
pub fn contract() -> &'static Contract {
    CONTRACT.get_or_init(|| {
        serde_json::from_str(HTTP_CONTRACT_JSON)
            .expect("rust/golden/http-contract.json must be valid")
    })
}

/// Every HTTP path the Rust server must eventually own, including meta and
/// versioned routes. MCP is a separate protocol surface but is included here so
/// an implementer cannot forget the `/mcp` listener.
pub fn all_http_paths() -> Vec<&'static str> {
    let contract = contract();
    let mut paths: Vec<&str> = contract
        .http
        .legacy
        .iter()
        .chain(contract.http.meta.iter())
        .chain(contract.http.versioned.iter())
        .chain(contract.http.mcp.iter())
        .map(String::as_str)
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

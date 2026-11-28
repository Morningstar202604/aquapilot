//! Optional bearer-token auth, role checks and a tiny per-subject rate limiter.
//!
//! Auth is off by default for a single-user local install. When
//! `AQUAPILOT_TOKENS=token:viewer,...` or `AQUAPILOT_API_TOKEN=...` is set,
//! mutating endpoints require a matching bearer token. A local install can keep
//! the UI tokenless only while auth is disabled; the API and UI use the same
//! process.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::{header, HeaderMap, StatusCode};
use sha2::{Digest, Sha256};

use crate::error::ApiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer = 0,
    Operator = 1,
    Admin = 2,
}

impl Role {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "viewer" | "read" => Some(Self::Viewer),
            "operator" | "write" => Some(Self::Operator),
            "admin" => Some(Self::Admin),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Operator => "operator",
            Self::Admin => "admin",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub subject: String,
    pub role: Role,
}

#[derive(Debug)]
struct RateWindow {
    started: Instant,
    count: u32,
}

#[derive(Clone)]
pub struct Security {
    tokens: Arc<HashMap<String, Role>>,
    rate_limit_per_minute: u32,
    windows: Arc<Mutex<HashMap<String, RateWindow>>>,
}

impl Security {
    pub fn from_env() -> Self {
        let mut tokens = HashMap::new();
        if let Ok(raw) = std::env::var("AQUAPILOT_TOKENS") {
            for entry in raw.split(',').filter(|entry| !entry.trim().is_empty()) {
                let mut parts = entry.splitn(2, ':');
                let token = parts.next().unwrap_or_default().trim();
                let role = parts.next().and_then(Role::parse).unwrap_or(Role::Viewer);
                if !token.is_empty() {
                    tokens.insert(hash_token(token), role);
                }
            }
        }
        if let Ok(token) = std::env::var("AQUAPILOT_API_TOKEN") {
            if !token.trim().is_empty() {
                tokens.insert(hash_token(token.trim()), Role::Admin);
            }
        }
        let rate_limit_per_minute = std::env::var("AQUAPILOT_RATE_LIMIT_PER_MIN")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(30);
        Self {
            tokens: Arc::new(tokens),
            rate_limit_per_minute,
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn with_tokens(tokens: &[(&str, Role)], rate_limit_per_minute: u32) -> Self {
        let tokens = tokens
            .iter()
            .map(|(token, role)| (hash_token(token), *role))
            .collect();
        Self {
            tokens: Arc::new(tokens),
            rate_limit_per_minute,
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.tokens.is_empty()
    }

    pub fn authorize(&self, headers: &HeaderMap, required: Role) -> Result<AuthContext, ApiError> {
        if !self.enabled() {
            return Ok(AuthContext {
                subject: "local-dev".to_owned(),
                role: Role::Admin,
            });
        }
        let header = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| unauthorized("missing bearer token"))?;
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or_else(|| unauthorized("Authorization must be Bearer <token>"))?
            .trim();
        if token.is_empty() {
            return Err(unauthorized("empty bearer token"));
        }
        let role = self
            .tokens
            .get(&hash_token(token))
            .copied()
            .ok_or_else(|| unauthorized("unknown bearer token"))?;
        if role < required {
            let mut error = ApiError::new(
                StatusCode::FORBIDDEN,
                "ROLE_FORBIDDEN",
                "Insufficient role",
                format!(
                    "requires {} role; token has {}",
                    required.as_str(),
                    role.as_str()
                ),
            );
            error.instance = "urn:aquapilot:auth".to_owned();
            return Err(error);
        }
        Ok(AuthContext {
            subject: format!("token:{}", role.as_str()),
            role,
        })
    }

    /// Per-subject fixed-window limiter. A value of 0 disables the limiter.
    pub fn check_rate(&self, subject: &str) -> Result<(), ApiError> {
        if self.rate_limit_per_minute == 0 {
            return Ok(());
        }
        let mut windows = self.windows.lock().expect("rate limiter mutex");
        let now = Instant::now();
        let window = windows.entry(subject.to_owned()).or_insert(RateWindow {
            started: now,
            count: 0,
        });
        if now.duration_since(window.started) >= Duration::from_secs(60) {
            window.started = now;
            window.count = 0;
        }
        if window.count >= self.rate_limit_per_minute {
            let retry_after = 60u64
                .saturating_sub(now.duration_since(window.started).as_secs())
                .max(1);
            let mut error = ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Rate limit exceeded",
                format!(
                    "subject exceeded {} requests per minute; retry after {} s",
                    self.rate_limit_per_minute, retry_after
                ),
            );
            error.retry_after = Some(retry_after);
            return Err(error);
        }
        window.count += 1;
        Ok(())
    }
}

fn unauthorized(detail: &str) -> ApiError {
    let mut error = ApiError::new(
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        "Authentication required",
        detail,
    );
    error.instance = "urn:aquapilot:auth".to_owned();
    error.www_authenticate = Some("Bearer realm=\"aquapilot\"");
    error
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("header"),
        );
        headers
    }

    #[test]
    fn roles_are_enforced_and_missing_token_is_401() {
        let security = Security::with_tokens(
            &[
                ("read", Role::Viewer),
                ("ops", Role::Operator),
                ("root", Role::Admin),
            ],
            0,
        );
        assert_eq!(
            security
                .authorize(&HeaderMap::new(), Role::Viewer)
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            security
                .authorize(&bearer("nope"), Role::Operator)
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            security
                .authorize(&bearer("read"), Role::Operator)
                .unwrap_err()
                .status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            security
                .authorize(&bearer("ops"), Role::Operator)
                .unwrap()
                .role,
            Role::Operator
        );
        assert_eq!(
            security
                .authorize(&bearer("root"), Role::Admin)
                .unwrap()
                .role,
            Role::Admin
        );
    }

    #[test]
    fn rate_limit_is_per_subject_and_has_retry_after() {
        let security = Security::with_tokens(&[("ops", Role::Operator)], 2);
        security.check_rate("ops").expect("first");
        security.check_rate("ops").expect("second");
        let error = security.check_rate("ops").expect_err("third");
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(error.retry_after.is_some());
        assert!(security.check_rate("other").is_ok());
    }
}

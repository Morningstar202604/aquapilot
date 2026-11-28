//! RFC 9457 problem-details responses for the versioned experiment API.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FieldError {
    pub field: String,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
struct ProblemBody {
    #[serde(rename = "type")]
    type_uri: String,
    title: String,
    status: u16,
    detail: String,
    instance: String,
    code: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<FieldError>,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub title: &'static str,
    pub detail: String,
    pub errors: Vec<FieldError>,
    pub retry_after: Option<u64>,
    pub www_authenticate: Option<&'static str>,
    pub instance: String,
}

impl ApiError {
    pub fn new(
        status: StatusCode,
        code: &'static str,
        title: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code,
            title,
            detail: detail.into(),
            errors: Vec::new(),
            retry_after: None,
            www_authenticate: None,
            instance: "urn:aquapilot:request".to_owned(),
        }
    }

    pub fn bad_request(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, "Bad request", detail)
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "EXPERIMENT_NOT_FOUND",
            "Not found",
            detail,
        )
    }

    pub fn conflict(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, "Conflict", detail)
    }

    pub fn queue_full() -> Self {
        let mut error = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "QUEUE_FULL",
            "Experiment queue is full",
            "queued and running experiments exceed the configured capacity",
        );
        error.retry_after = Some(30);
        error
    }

    pub fn idempotency_conflict() -> Self {
        Self::conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "the same Idempotency-Key was used with a different request body",
        )
    }

    pub fn invalid_request(errors: Vec<FieldError>) -> Self {
        let mut error = Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "Request validation failed",
            "one or more fields are outside the supported boundary",
        );
        error.errors = errors;
        error
    }

    pub fn internal(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            code,
            "Internal error",
            detail,
        )
    }

    pub fn with_instance(mut self, instance: impl Into<String>) -> Self {
        self.instance = instance.into();
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        let body = ProblemBody {
            type_uri: format!("urn:aquapilot:problem:{}", self.code),
            title: self.title.to_owned(),
            status: status.as_u16(),
            detail: self.detail,
            instance: self.instance,
            code: self.code.to_owned(),
            errors: self.errors,
        };
        let mut response = (status, Json(body)).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let Some(seconds) = self.retry_after {
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        if let Some(value) = self.www_authenticate {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static(value));
        }
        response
    }
}

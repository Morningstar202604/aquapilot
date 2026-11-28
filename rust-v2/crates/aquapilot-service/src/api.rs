//! HTTP surface for the versioned experiment API.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::runner::{samples_csv, ExperimentRequest, Sample};
use crate::store::{to_api_error, CancelOutcome, ExperimentRecord, Store};

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub started: Arc<Instant>,
}

pub fn build_router(store: Store) -> Router {
    let state = AppState {
        store,
        started: Arc::new(Instant::now()),
    };
    Router::new()
        .route("/api/health", get(health))
        .route("/api/openapi.json", get(openapi))
        .route(
            "/api/v1/experiments",
            post(create_experiment).get(list_experiments),
        )
        .route("/api/v1/experiments/{id}", get(get_experiment))
        .route("/api/v1/experiments/{id}/cancel", post(cancel_experiment))
        .route("/api/v1/experiments/{id}/events", get(stream_experiment))
        .route("/api/v1/experiments/{id}/samples.csv", get(get_samples_csv))
        .route(
            "/api/v1/experiments/{id}/report.md",
            get(get_report_markdown),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::map_response(map_body_limit_error))
        .with_state(state)
}

async fn map_body_limit_error(response: Response) -> Response {
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            "Request body too large",
            "request body exceeds the 64 KiB limit",
        )
        .into_response();
    }
    if response.status() == StatusCode::METHOD_NOT_ALLOWED {
        let allow = response.headers().get(header::ALLOW).cloned();
        let mut problem = ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "Method not allowed",
            "the route exists but does not support this HTTP method",
        )
        .into_response();
        if let Some(value) = allow {
            problem.headers_mut().insert(header::ALLOW, value);
        }
        return problem;
    }
    response
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let active = state.store.active_count().unwrap_or(0);
    Json(json!({
        "ok": true,
        "status": "ok",
        "uptime_seconds": state.started.elapsed().as_secs_f64(),
        "queue": {
            "active": active,
            "capacity": state.store.capacity()
        },
        "persistence": "sqlite",
    }))
}

async fn openapi() -> Json<Value> {
    Json(openapi_document())
}

async fn create_experiment(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    check_json_content_type(&headers)?;
    let request: ExperimentRequest = serde_json::from_slice(&body).map_err(|error| {
        let mut api_error = ApiError::bad_request(
            "MALFORMED_JSON",
            format!("request body is not valid JSON: {error}"),
        );
        api_error.status = StatusCode::BAD_REQUEST;
        api_error
    })?;
    request.validate().map_err(ApiError::invalid_request)?;

    let key = headers
        .get("idempotency-key")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            ApiError::bad_request("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be ASCII")
        })?
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(key) = key {
        if key.len() > 128 || key.chars().any(char::is_control) {
            return Err(ApiError::bad_request(
                "INVALID_IDEMPOTENCY_KEY",
                "Idempotency-Key must be 1 to 128 ASCII characters",
            ));
        }
    }
    let key_hash = key.map(|value| sha256_hex(value.as_bytes()));
    let request_hash = sha256_hex(&body);
    let id = uuid::Uuid::new_v4().to_string();
    let model = request.model.as_str().to_owned();
    let request_json = serde_json::to_string(&request)
        .map_err(|error| ApiError::internal("SERIALIZE_ERROR", error.to_string()))?;

    let outcome = state
        .store
        .create(
            &id,
            request.name.trim(),
            &model,
            &request_json,
            key_hash.as_deref(),
            &request_hash,
        )
        .map_err(to_api_error)?;

    let status = if outcome.created {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    let body = Json(experiment_view(&outcome.record, false, true));
    let mut response = (status, body).into_response();
    let location = format!("/api/v1/experiments/{}", outcome.record.id);
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    status: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn list_experiments(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    if let Some(status) = query.status.as_deref() {
        if !matches!(
            status,
            "queued" | "running" | "succeeded" | "failed" | "cancelled"
        ) {
            return Err(ApiError::bad_request(
                "INVALID_STATUS_FILTER",
                "status must be one of queued, running, succeeded, failed, cancelled",
            ));
        }
    }
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let offset = query
        .cursor
        .as_deref()
        .map(|cursor| {
            cursor.parse::<usize>().map_err(|_| {
                ApiError::bad_request(
                    "INVALID_CURSOR",
                    "cursor must be an opaque pagination token",
                )
            })
        })
        .transpose()?
        .unwrap_or(0);
    let (records, next) = state
        .store
        .list(query.status.as_deref(), limit, offset)
        .map_err(to_api_error)?;
    Ok(Json(json!({
        "items": records.iter().map(|record| experiment_view(record, false, false)).collect::<Vec<_>>(),
        "next_cursor": next,
    })))
}

async fn get_experiment(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let record = state
        .store
        .get(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| ApiError::not_found(format!("experiment {id} does not exist")))?;
    Ok(Json(experiment_view(&record, true, true)))
}

async fn cancel_experiment(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    match state.store.cancel(&id).map_err(to_api_error)? {
        CancelOutcome::NotFound => Err(ApiError::not_found(format!(
            "experiment {id} does not exist"
        ))),
        CancelOutcome::Terminal => Err(ApiError::conflict(
            "EXPERIMENT_TERMINAL",
            "experiment has already reached a terminal status",
        )),
        CancelOutcome::Cancelled | CancelOutcome::CancelRequested => {
            let record =
                state.store.get(&id).map_err(to_api_error)?.ok_or_else(|| {
                    ApiError::not_found(format!("experiment {id} does not exist"))
                })?;
            let view = experiment_view(&record, false, false);
            let mut response = (StatusCode::ACCEPTED, Json(view)).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            Ok(response)
        }
    }
}

async fn stream_experiment(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    if state.store.get(&id).map_err(to_api_error)?.is_none() {
        return Err(ApiError::not_found(format!(
            "experiment {id} does not exist"
        )));
    }
    let stream = stream::unfold((state, id, false), |(state, id, done)| async move {
        if done {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        match state.store.get(&id) {
            Ok(Some(record)) => {
                let terminal =
                    matches!(record.status.as_str(), "succeeded" | "failed" | "cancelled");
                let view = experiment_view(&record, false, false);
                let payload = serde_json::to_string(&view)
                    .unwrap_or_else(|error| json!({"error": error.to_string()}).to_string());
                let event = Event::default().event("experiment").data(payload);
                Some((Ok(event), (state, id, terminal)))
            }
            Ok(None) => {
                let event = Event::default()
                    .event("error")
                    .data(json!({"code": "EXPERIMENT_NOT_FOUND"}).to_string());
                Some((Ok(event), (state, id, true)))
            }
            Err(error) => {
                let event = Event::default()
                    .event("error")
                    .data(json!({"code": "STORE_ERROR", "detail": error.to_string()}).to_string());
                Some((Ok(event), (state, id, true)))
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn get_samples_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let record = state
        .store
        .get(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| ApiError::not_found(format!("experiment {id} does not exist")))?;
    ensure_succeeded(&record)?;
    let samples: Vec<Sample> = record
        .samples_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| ApiError::internal("SAMPLE_DECODE_ERROR", error.to_string()))?
        .unwrap_or_default();
    let csv = samples_csv(&samples);
    let mut response = (StatusCode::OK, csv).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename=\"experiment-{}.csv\"",
        record.id
    )) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn get_report_markdown(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let record = state
        .store
        .get(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| ApiError::not_found(format!("experiment {id} does not exist")))?;
    ensure_succeeded(&record)?;
    let report = report_markdown(&record);
    let mut response = (StatusCode::OK, report).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    if let Ok(value) =
        HeaderValue::from_str(&format!("inline; filename=\"experiment-{}.md\"", record.id))
    {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn not_found() -> ApiError {
    ApiError::not_found("the requested API route does not exist")
        .with_instance("urn:aquapilot:route")
}

fn check_json_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/json" {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
            "Unsupported media type",
            "Content-Type must be application/json",
        ));
    }
    Ok(())
}

fn ensure_succeeded(record: &ExperimentRecord) -> Result<(), ApiError> {
    match record.status.as_str() {
        "succeeded" => Ok(()),
        "failed" => Err(ApiError::conflict(
            "EXPERIMENT_FAILED",
            "experiment failed; no successful output is available",
        )),
        "cancelled" => Err(ApiError::conflict(
            "EXPERIMENT_CANCELLED",
            "experiment was cancelled; no successful output is available",
        )),
        other => Err(ApiError::conflict(
            "EXPERIMENT_NOT_SUCCEEDED",
            format!("experiment is {other}; wait until it succeeds"),
        )),
    }
}

fn experiment_view(record: &ExperimentRecord, include_result: bool, include_spec: bool) -> Value {
    let request: Value = if include_spec {
        serde_json::from_str(&record.request_json).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let status = if record.status == "running" && record.cancel_requested {
        "cancelling"
    } else {
        record.status.as_str()
    };
    let result: Option<Value> = if include_result {
        record
            .result_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
    } else {
        None
    };
    let mut value = json!({
        "id": record.id,
        "name": record.name,
        "model": record.model,
        "status": status,
        "progress": record.progress,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "error": record.error,
        "links": {
            "self": format!("/api/v1/experiments/{}", record.id),
            "cancel": format!("/api/v1/experiments/{}/cancel", record.id),
            "samples": format!("/api/v1/experiments/{}/samples.csv", record.id),
            "report": format!("/api/v1/experiments/{}/report.md", record.id),
        },
    });
    if include_spec {
        value["spec"] = request;
    }
    if let Some(result) = result {
        value["result"] = result;
    }
    value
}

fn report_markdown(record: &ExperimentRecord) -> String {
    let request: Value = serde_json::from_str(&record.request_json).unwrap_or(Value::Null);
    let result: Value = record
        .result_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or(Value::Null);
    let effluent = result
        .get("effluent")
        .or_else(|| result.get("asm2d").and_then(|value| value.get("effluent")))
        .cloned()
        .unwrap_or(Value::Null);
    let mut report = String::new();
    report.push_str(&format!(
        "# Experiment `{}` — {}\n\n",
        record.id, record.name
    ));
    report.push_str(&format!("- Model: `{}`\n", record.model));
    report.push_str(&format!("- Status: `{}`\n", record.status));
    report.push_str(&format!("- Created: `{}`\n", record.created_at));
    report.push_str(&format!("- Updated: `{}`\n", record.updated_at));
    report.push_str(&format!("- Progress: {:.1}%\n\n", record.progress * 100.0));
    report.push_str("## Effluent (final state)\n\n");
    report.push_str("| Metric | Value | Unit |\n|---|---:|---|\n");
    for (key, unit) in [
        ("cod", "mg/L"),
        ("ss", "mg/L"),
        ("nh4_n", "mg/L"),
        ("tn", "mg/L"),
        ("tp", "mg/L"),
        ("po4_p", "mg/L"),
        ("flow_m3_h", "m3/h"),
        ("do", "mg/L"),
    ] {
        if let Some(value) = effluent.get(key).and_then(Value::as_f64) {
            report.push_str(&format!("| {} | {:.4} | {} |\n", key, value, unit));
        }
    }
    report.push_str("\n## Mass balance\n\n");
    let balance = result
        .get("whole_balance")
        .or_else(|| result.get("mass_balance"))
        .cloned()
        .unwrap_or(Value::Null);
    if balance.is_object() {
        report.push_str("```json\n");
        report.push_str(&serde_json::to_string_pretty(&balance).unwrap_or_default());
        report.push_str("\n```\n");
    } else {
        report.push_str("No mass-balance object in the final snapshot.\n");
    }
    report.push_str("\n## Reproduction\n\n");
    report.push_str(
        "Submit the same `spec` body to `POST /api/v1/experiments` with the same\n\
         `Idempotency-Key` to replay this experiment, or omit the key to run it again.\n",
    );
    report.push_str("\n## Request spec\n\n```json\n");
    report.push_str(&serde_json::to_string_pretty(&request).unwrap_or_default());
    report.push_str("\n```\n");
    report
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

fn openapi_document() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "AquaPilot V2 experiment API",
            "version": "0.0.6",
            "description": "Persistent, idempotent wastewater treatment experiments."
        },
        "paths": {
            "/api/health": {"get": {"summary": "Service health", "responses": {"200": {"description": "OK"}}}},
            "/api/openapi.json": {"get": {"summary": "This document", "responses": {"200": {"description": "OpenAPI 3.1 document"}}}},
            "/api/v1/experiments": {
                "post": {
                    "summary": "Queue an experiment",
                    "parameters": [
                        {"name": "Idempotency-Key", "in": "header", "required": false, "schema": {"type": "string", "maxLength": 128}}
                    ],
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/ExperimentRequest"}
                            }
                        }
                    },
                    "responses": {
                        "202": {"description": "Queued"},
                        "200": {"description": "Idempotent replay"},
                        "400": {"description": "Malformed JSON or invalid idempotency key"},
                        "409": {"description": "Idempotency key reused with a different body"},
                        "413": {"description": "Request body exceeds 64 KiB"},
                        "422": {"description": "Validation failed"},
                        "429": {"description": "Queue full; Retry-After is set"}
                    }
                },
                "get": {
                    "summary": "List experiments",
                    "parameters": [
                        {"name": "status", "in": "query", "required": false, "schema": {"type": "string", "enum": ["queued", "running", "succeeded", "failed", "cancelled"]}},
                        {"name": "limit", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 100}},
                        {"name": "cursor", "in": "query", "required": false, "schema": {"type": "string"}}
                    ],
                    "responses": {"200": {"description": "Experiment page"}}
                }
            },
            "/api/v1/experiments/{id}": {
                "get": {
                    "summary": "Experiment detail",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "Experiment"}, "404": {"description": "Not found"}}
                }
            },
            "/api/v1/experiments/{id}/cancel": {
                "post": {
                    "summary": "Cancel or request cancellation",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"202": {"description": "Cancelled or cancellation requested"}, "404": {"description": "Not found"}, "409": {"description": "Already terminal"}}
                }
            },
            "/api/v1/experiments/{id}/events": {
                "get": {
                    "summary": "Server-sent status events",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "text/event-stream of experiment status"}}
                }
            },
            "/api/v1/experiments/{id}/samples.csv": {
                "get": {
                    "summary": "Final/sampled time series as CSV",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "CSV"}, "409": {"description": "Experiment not succeeded"}}
                }
            },
            "/api/v1/experiments/{id}/report.md": {
                "get": {
                    "summary": "Markdown report",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "Markdown report"}, "409": {"description": "Experiment not succeeded"}}
                }
            }
        },
        "components": {
            "schemas": {
                "ExperimentRequest": {
                    "type": "object",
                    "required": ["name", "model", "config"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 128},
                        "model": {"type": "string", "enum": ["asm1", "asm2d", "asm2d-adm1-loop", "adm1", "sludge-line"]},
                        "config": {"type": "object", "description": "Model-specific plant or process configuration"},
                        "duration_min": {"type": "number", "minimum": 1, "maximum": 525600, "default": 1440},
                        "dt_min": {"type": "number", "exclusiveMinimum": 0, "maximum": 1, "default": 1},
                        "sample_every_min": {"type": "number", "exclusiveMinimum": 0, "default": 60},
                        "sludge_days": {"type": "number", "exclusiveMinimum": 0, "maximum": 3650, "default": 30},
                        "sludge_dt_days": {"type": "number", "exclusiveMinimum": 0, "default": 0.002},
                        "max_iterations": {"type": "integer", "minimum": 0, "maximum": 64, "default": 0},
                        "relaxation": {"type": "number", "minimum": 0, "maximum": 1}
                    }
                },
                "Problem": {
                    "type": "object",
                    "required": ["type", "title", "status", "detail", "code"],
                    "properties": {
                        "type": {"type": "string"},
                        "title": {"type": "string"},
                        "status": {"type": "integer"},
                        "detail": {"type": "string"},
                        "instance": {"type": "string"},
                        "code": {"type": "string"},
                        "errors": {"type": "array", "items": {"type": "object"}}
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn request(body: Value) -> Request<Body> {
        request_with_key(body, "test-key")
    }

    fn request_with_key(body: Value, key: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/v1/experiments")
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", key)
            .body(Body::from(serde_json::to_vec(&body).expect("json")))
            .expect("request")
    }

    fn minimal_body(name: &str) -> Value {
        let config: Value = serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d.json"))
            .expect("ASM2d fixture");
        json!({
            "name": name,
            "model": "asm2d",
            "config": config,
            "duration_min": 30.0,
            "dt_min": 1.0
        })
    }

    async fn body_json(response: Response) -> Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("json response")
    }

    #[tokio::test]
    async fn create_replay_conflict_and_validation() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);
        let body = minimal_body("api-test");
        let response = router
            .clone()
            .oneshot(request(body.clone()))
            .await
            .expect("post");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let created = body_json(response).await;
        let id = created["id"].as_str().expect("id").to_owned();
        assert_eq!(created["status"], "queued");

        let replay = router
            .clone()
            .oneshot(request(body.clone()))
            .await
            .expect("replay");
        assert_eq!(replay.status(), StatusCode::OK);
        let replay_body = body_json(replay).await;
        assert_eq!(replay_body["id"], id);

        let mut changed = body;
        changed["name"] = json!("api-test-2");
        let conflict = router
            .clone()
            .oneshot(request(changed))
            .await
            .expect("conflict");
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            conflict
                .headers()
                .get(header::CONTENT_TYPE)
                .expect("content type"),
            "application/problem+json"
        );

        let bad = Request::builder()
            .method("POST")
            .uri("/api/v1/experiments")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"","model":"asm2d","config":{}}"#))
            .expect("bad request");
        let response = router.oneshot(bad).await.expect("validation");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let problem = body_json(response).await;
        assert_eq!(problem["code"], "VALIDATION_FAILED");
        assert!(!problem["errors"].as_array().expect("errors").is_empty());
    }

    #[tokio::test]
    async fn queue_full_and_cancel_queued() {
        let store = Store::in_memory(1).expect("store");
        let router = build_router(store);
        let first = router
            .clone()
            .oneshot(request(minimal_body("first")))
            .await
            .expect("first");
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first_body = body_json(first).await;
        let id = first_body["id"].as_str().expect("id").to_owned();

        let second = router
            .clone()
            .oneshot(request_with_key(minimal_body("second"), "test-key-2"))
            .await
            .expect("second");
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            second.headers().get(header::RETRY_AFTER).expect("retry"),
            "30"
        );
        let full = body_json(second).await;
        assert_eq!(full["code"], "QUEUE_FULL");

        let cancel = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/experiments/{id}/cancel"))
            .body(Body::empty())
            .expect("cancel request");
        let response = router
            .clone()
            .oneshot(cancel)
            .await
            .expect("cancel response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let cancelled = body_json(response).await;
        assert_eq!(cancelled["status"], "cancelled");

        let detail = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/experiments/{id}"))
                    .body(Body::empty())
                    .expect("detail request"),
            )
            .await
            .expect("detail response");
        assert_eq!(detail.status(), StatusCode::OK);
        assert_eq!(body_json(detail).await["status"], "cancelled");
    }

    #[tokio::test]
    async fn content_type_parameters_are_accepted_and_json_suffix_is_not() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);
        let body = minimal_body("content-type");
        let accepted = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/experiments")
                    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                    .header("Idempotency-Key", "charset-key")
                    .body(Body::from(serde_json::to_vec(&body).expect("json")))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);

        let rejected = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/experiments")
                    .header(header::CONTENT_TYPE, "application/jsonx")
                    .header("Idempotency-Key", "suffix-key")
                    .body(Body::from(serde_json::to_vec(&body).expect("json")))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(rejected.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(body_json(rejected).await["code"], "UNSUPPORTED_MEDIA_TYPE");
    }

    #[tokio::test]
    async fn oversized_body_is_problem_json() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);
        let body = format!("{{\"name\":\"big\",\"blob\":\"{}\"}}", "a".repeat(70_000));
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/experiments")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("oversized request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .expect("content type"),
            "application/problem+json"
        );
        assert_eq!(body_json(response).await["code"], "PAYLOAD_TOO_LARGE");
    }

    #[tokio::test]
    async fn openapi_and_health_are_stable() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);
        let openapi = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/openapi.json")
                    .body(Body::empty())
                    .expect("openapi request"),
            )
            .await
            .expect("openapi response");
        assert_eq!(openapi.status(), StatusCode::OK);
        let document = body_json(openapi).await;
        assert_eq!(document["openapi"], "3.1.0");
        assert!(document["paths"]["/api/v1/experiments"].is_object());

        let health = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::OK);

        let method = router
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/experiments")
                    .body(Body::empty())
                    .expect("method request"),
            )
            .await
            .expect("method response");
        assert_eq!(method.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            method
                .headers()
                .get(header::CONTENT_TYPE)
                .expect("content type"),
            "application/problem+json"
        );
        assert_eq!(body_json(method).await["code"], "METHOD_NOT_ALLOWED");
    }
}

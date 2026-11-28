//! HTTP surface for the versioned experiment API.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ai::AiProvider;
use crate::analysis::{analyze, daily_csv, weekly_csv};
use crate::error::{ApiError, FieldError};
use crate::industrial::{IndustrialHub, WriteRequest};
use crate::legacy;
use crate::runner::{samples_csv, ExperimentRequest, Sample};
use crate::security::{Role, Security};
use crate::store::{to_api_error, CancelOutcome, ExperimentRecord, Store, StudyChildSpec};
use crate::study::{study_detail, study_report, study_status, StudyRequest};
use crate::watchdog::Watchdog;
use aquapilot_domain::PlantTopology;
use aquapilot_engine::{CompiledPlant, EngineError};

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub industrial: IndustrialHub,
    pub ai: AiProvider,
    pub security: Security,
    pub watchdog: Watchdog,
    pub started: Arc<Instant>,
}

pub fn build_router(store: Store) -> Router {
    build_router_with(store, Security::from_env(), None)
}

pub fn build_router_with(store: Store, security: Security, watchdog: Option<Watchdog>) -> Router {
    let industrial = IndustrialHub::new(store.clone());
    let ai = AiProvider::new(store.clone());
    let watchdog = watchdog.unwrap_or_else(|| Watchdog::new(store.clone()));
    let state = AppState {
        store,
        industrial,
        ai,
        security,
        watchdog,
        started: Arc::new(Instant::now()),
    };
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route("/api/auth-required", get(auth_required))
        .route("/api/standards", get(legacy_standards))
        .route("/api/limits", get(legacy_limits))
        .route("/api/snapshot", get(legacy_snapshot))
        .route("/api/topology", get(legacy_topology))
        .route("/api/metrics", get(legacy_metrics))
        .route("/api/history/snapshots", get(legacy_history))
        .route("/api/openapi.json", get(openapi))
        .route("/api/v1/presets", get(presets))
        .route("/api/v1/industrial/points", get(industrial_points))
        .route("/api/v1/industrial/adapters", get(industrial_adapters))
        .route("/api/v1/industrial/write", post(industrial_write))
        .route("/api/v1/industrial/audit", get(industrial_audit))
        .route("/api/v1/watchdog", get(watchdog_status))
        .route("/api/v1/ai/explain", post(ai_explain))
        .route("/api/v1/topologies/validate", post(validate_topology))
        .route(
            "/api/v1/experiments",
            post(create_experiment).get(list_experiments),
        )
        .route("/api/v1/experiments/{id}", get(get_experiment))
        .route("/api/v1/experiments/{id}/cancel", post(cancel_experiment))
        .route("/api/v1/experiments/{id}/events", get(stream_experiment))
        .route("/api/v1/experiments/{id}/samples.csv", get(get_samples_csv))
        .route("/api/v1/experiments/{id}/daily.csv", get(get_daily_csv))
        .route("/api/v1/experiments/{id}/weekly.csv", get(get_weekly_csv))
        .route(
            "/api/v1/experiments/{id}/report.md",
            get(get_report_markdown),
        )
        .route("/api/v1/studies", post(create_study).get(list_studies))
        .route("/api/v1/studies/{id}", get(get_study))
        .route("/api/v1/studies/{id}/cancel", post(cancel_study))
        .route("/api/v1/studies/{id}/report.md", get(get_study_report))
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
    let uptime = state.started.elapsed();
    Json(json!({
        "ok": true,
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime.as_secs_f64(),
        "uptimeSeconds": uptime.as_secs(),
        "authRequired": state.security.enabled(),
        "paused": false,
        "tickErrors": 0,
        "lastTickMs": 0.0,
        "simulationMinutes": 0,
        "queue": {
            "active": active,
            "capacity": state.store.capacity()
        },
        "persistence": "sqlite",
        "watchdog": state.watchdog.snapshot(),
        "auth": { "enabled": state.security.enabled(), "mode": if state.security.enabled() { "bearer+rbac" } else { "local-dev" } },
    }))
}

async fn auth_required(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"required": state.security.enabled()}))
}

async fn legacy_standards() -> Json<Value> {
    Json(serde_json::from_str(LEGACY_STANDARDS).expect("valid legacy standards"))
}

async fn legacy_limits() -> Json<Value> {
    Json(serde_json::from_str(LEGACY_LIMITS).expect("valid legacy limits"))
}

async fn openapi() -> Json<Value> {
    Json(openapi_document())
}

const LEGACY_STANDARDS: &str = r#"{"standards":[{"id":"gb18918-1a","label":"GB 18918-2002 一级 A","source":"GB 18918-2002 表 1","limits":{"cod":50,"bod":10,"ss":10,"nh":5,"tn":15,"tp":0.5},"note":"SS ≤ 10 严于 BSM1 基准厂的参考出水（TSS ≈ 11.7），基准厂在该口径下 SS 天然吃紧"},{"id":"gb18918-1b","label":"GB 18918-2002 一级 B","source":"GB 18918-2002 表 1","limits":{"cod":60,"bod":20,"ss":20,"nh":8,"tn":20,"tp":1},"note":"SS ≤ 20 与 BSM1 基准厂的出水水平相容"},{"id":"bsm1-reference","label":"BSM1 benchmark reference","source":"IWA BSM1 Technical Report","limits":{"cod":100,"bod":30,"ss":15,"nh":4,"tn":18,"tp":2},"note":"基准评估口径，非法定标准；用于判断模型复现是否忠实"}],"default":"gb18918-1a"}"#;

const LEGACY_LIMITS: &str = r#"{"limits":{"cod":50,"bod":10,"ss":10,"nh":5,"tn":15,"tp":0.5,"phMin":6,"phMax":9},"bounds":{"doSetpoint":{"min":0.8,"max":4,"step":0.1,"unit":"mg/L","label":"好氧区溶解氧设定","precision":1},"internalRecirc":{"min":0,"max":3.5,"step":0.1,"unit":"×Q","label":"内回流比","precision":1},"rasRatio":{"min":0.3,"max":1.5,"step":0.05,"unit":"×Q","label":"污泥回流比","precision":2},"wasRatio":{"min":0.002,"max":0.03,"step":0.001,"unit":"×Q","label":"剩余污泥排放","precision":3},"pacDose":{"min":0,"max":60,"step":1,"unit":"mg/L","label":"PAC 投加","precision":0},"carbonDose":{"min":0,"max":60,"step":1,"unit":"mg/L","label":"碳源投加","precision":0},"alkDose":{"min":0,"max":120,"step":2,"unit":"mg/L","label":"碱度投加","precision":0},"stormStore":{"min":0,"max":1,"step":0.1,"unit":"","label":"雨水调蓄分流","precision":1},"stepFeed":{"min":0,"max":0.5,"step":0.05,"unit":"×Q","label":"缺氧区多点进水","precision":2}},"plant":{"name":"澄川再生水厂","code":"CC-WWTP-03","capacityM3d":48000,"designFlowM3h":2000,"clarifier":{"area":3600,"depth":4.5},"siteAreaHa":4.2,"dischargeStandard":"GB 18918-2002 一级 A"}}"#;

async fn industrial_points(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "points": state.industrial.points() }))
}

async fn industrial_adapters(State(state): State<AppState>) -> Json<Value> {
    Json(state.industrial.adapters())
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    limit: Option<usize>,
}

async fn industrial_write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WriteRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let auth = state.security.authorize(&headers, Role::Operator)?;
    state.security.check_rate(&auth.subject)?;
    let value = state.industrial.write(request, &auth.subject)?;
    Ok((StatusCode::CREATED, Json(value)))
}

async fn industrial_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Value>, ApiError> {
    state.security.authorize(&headers, Role::Admin)?;
    let limit = query.limit.unwrap_or(20).clamp(1, 200);
    Ok(Json(json!({ "records": state.industrial.audit(limit)? })))
}

async fn watchdog_status(State(state): State<AppState>) -> Json<Value> {
    Json(state.watchdog.snapshot())
}

#[derive(Debug, Deserialize)]
struct AiExplainRequest {
    experiment_id: String,
    #[serde(default)]
    question: String,
}

async fn ai_explain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AiExplainRequest>,
) -> Result<Json<Value>, ApiError> {
    let auth = state.security.authorize(&headers, Role::Viewer)?;
    state.security.check_rate(&auth.subject)?;
    let value = state
        .ai
        .explain(&request.experiment_id, &request.question, &auth.subject)?;
    Ok(Json(value))
}

async fn index() -> Response {
    let mut response = Html(include_str!("../web/index.html")).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn presets() -> Json<Value> {
    Json(json!({
        "default": "a2o-pac-tertiary",
        "presets": [
            {
                "id": "a2o-basic",
                "label": "A2O 基础",
                "model": "asm2d",
                "description": "1000 m3/h，5 池 A2O，无 PAC、无三级过滤。",
                "config": fixture(include_str!("../../../fixtures/a2o-asm2d.json"))
            },
            {
                "id": "a2o-pac-tertiary",
                "label": "PAC + 三级过滤",
                "model": "asm2d",
                "description": "PAC 20 mg/L，90% TSS 捕集，70% PO4 抛光。",
                "config": fixture(include_str!("../../../fixtures/a2o-asm2d-pac-tertiary.json"))
            },
            {
                "id": "a2o-loop",
                "label": "A2O + ADM1 回流闭环",
                "model": "asm2d-adm1-loop",
                "description": "A2O 与 ADM1 泥线回流闭环，默认泥线配置。",
                "config": { "plant": fixture(include_str!("../../../fixtures/a2o-asm2d-pac-tertiary.json")) }
            },
            {
                "id": "a2o-2train",
                "label": "A2O 双系列 2×500",
                "model": "asm2d-parallel",
                "description": "两条并列 A2O 系列，各 500 m³/h，各自二沉池与 RAS/WAS；出水与三本账按流量加权汇总。",
                "config": fixture(include_str!("../../../fixtures/a2o-asm2d-2train.json"))
            },
            {
                "id": "bsm1",
                "label": "BSM1 基准",
                "model": "asm1",
                "description": "官方 BSM1 拓扑，用于基准与回归。",
                "config": fixture(include_str!("../../../fixtures/bsm1-official.json"))
            },
            {
                "id": "asm1-three-stage",
                "label": "ASM1 三池自由拓扑",
                "model": "asm1",
                "description": "厌氧/缺氧/好氧三池，无二沉池；可增删节点和连边。",
                "config": fixture(include_str!("../../../fixtures/three-stage.json"))
            },
            {
                "id": "asm1-single",
                "label": "ASM1 单池",
                "model": "asm1",
                "description": "单好氧池 + 进水/出水，最小自由拓扑画布。",
                "config": fixture(include_str!("../../../fixtures/single-aerobic.json"))
            },
            {
                "id": "adm1",
                "label": "ADM1 消化器",
                "model": "adm1",
                "description": "850 m3 厌氧消化器 CSTR 教程参数。",
                "config": fixture(include_str!("../../../fixtures/adm1-tutorial.json"))
            },
            {
                "id": "sludge-line",
                "label": "完整泥线",
                "model": "sludge-line",
                "description": "浓缩 + ADM1 消化 + 脱水 + 沼气 + 滤液。",
                "config": fixture(include_str!("../../../fixtures/adm1-sludge-line.json"))
            }
        ]
    }))
}

async fn validate_topology(Json(topology): Json<PlantTopology>) -> Result<Json<Value>, ApiError> {
    let compiled = CompiledPlant::compile(&topology).map_err(topology_error)?;
    Ok(Json(json!({
        "valid": true,
        "name": topology.name,
        "units": topology.units.len(),
        "connections": topology.connections.len(),
        "reactors": compiled.reactors.len(),
        "clarifiers": compiled.clarifiers.len(),
        "influent_flow_m3_h": compiled.influent_flow_m3_h,
        "effluent_flow_m3_h": compiled.effluent_flow_m3_h,
    })))
}

fn topology_error(error: EngineError) -> ApiError {
    ApiError::invalid_request(vec![FieldError {
        field: "topology".to_owned(),
        code: "TOPOLOGY_INVALID".to_owned(),
        detail: error.to_string(),
    }])
}

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|error| json!({ "fixture_error": error.to_string() }))
}

async fn create_experiment(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    check_json_content_type(&headers)?;
    let auth = state.security.authorize(&headers, Role::Operator)?;
    state.security.check_rate(&auth.subject)?;
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
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    state.security.authorize(&headers, Role::Operator)?;
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

async fn get_daily_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    get_period_csv(state, id, true).await
}

async fn get_weekly_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    get_period_csv(state, id, false).await
}

async fn get_period_csv(state: AppState, id: String, daily: bool) -> Result<Response, ApiError> {
    let record = state
        .store
        .get(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| ApiError::not_found(format!("experiment {id} does not exist")))?;
    ensure_succeeded(&record)?;
    let analysis = analyze(&record).ok_or_else(|| {
        ApiError::internal("ANALYSIS_DECODE_ERROR", "stored result is not decodable")
    })?;
    let csv = if daily {
        daily_csv(&analysis)
    } else {
        weekly_csv(&analysis)
    };
    let mut response = (StatusCode::OK, csv).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename=\"experiment-{}-{}.csv\"",
        record.id,
        if daily { "daily" } else { "weekly" }
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

async fn legacy_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    state.security.authorize(&headers, Role::Viewer)?;
    Ok(Json(legacy::snapshot(&state.store)?))
}

async fn legacy_topology(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    state.security.authorize(&headers, Role::Viewer)?;
    Ok(Json(legacy::topology(&state.store)?))
}

async fn legacy_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    state.security.authorize(&headers, Role::Viewer)?;
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    Ok(Json(legacy::history(&state.store, limit)?))
}

async fn legacy_metrics(State(state): State<AppState>) -> Response {
    let uptime = state.started.elapsed().as_secs();
    let text = legacy::metrics(&state.store, env!("CARGO_PKG_VERSION"), uptime);
    let mut response = (StatusCode::OK, text).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
}

async fn create_study(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    check_json_content_type(&headers)?;
    let auth = state.security.authorize(&headers, Role::Operator)?;
    state.security.check_rate(&auth.subject)?;
    let request: StudyRequest = serde_json::from_slice(&body).map_err(|error| {
        ApiError::bad_request(
            "MALFORMED_JSON",
            format!("study request body is not valid JSON: {error}"),
        )
    })?;
    let idempotency = parse_idempotency_key(&headers)?;
    let key_hash = idempotency
        .as_deref()
        .map(|value| sha256_hex(value.as_bytes()));
    let request_hash = sha256_hex(&body);
    let ids: Vec<String> = (0..24).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    let expanded = request.expand(&ids).map_err(ApiError::invalid_request)?;
    let spec_json = serde_json::to_string(&request)
        .map_err(|error| ApiError::internal("SERIALIZE_ERROR", error.to_string()))?;
    let child_specs: Vec<StudyChildSpec> = expanded
        .children
        .iter()
        .zip(expanded.assignments.iter())
        .map(|(child, assignment)| {
            Ok(StudyChildSpec {
                id: assignment.id.clone(),
                name: child.name.clone(),
                model: child.model.as_str().to_owned(),
                request_json: serde_json::to_string(child)
                    .map_err(|error| ApiError::internal("SERIALIZE_ERROR", error.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let study_id = uuid::Uuid::new_v4().to_string();
    let outcome = state
        .store
        .create_study(
            &study_id,
            request.name.trim(),
            &spec_json,
            &child_specs,
            key_hash.as_deref(),
            &request_hash,
        )
        .map_err(to_api_error)?;
    let status = if outcome.created {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    let body = Json(study_detail(&outcome.record, &outcome.children));
    let mut response = (status, body).into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&format!("/api/v1/studies/{}", outcome.record.id))
            .expect("study location is ASCII"),
    );
    Ok(response)
}

async fn list_studies(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let records = state.store.list_studies(limit).map_err(to_api_error)?;
    let mut items = Vec::new();
    for record in records {
        let children = state.store.study_children(&record).map_err(to_api_error)?;
        if let Some(status) = query.status.as_deref() {
            if study_status(&children) != status {
                continue;
            }
        }
        items.push(study_detail(&record, &children));
    }
    Ok(Json(json!({"items": items})))
}

async fn get_study(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let record = state
        .store
        .get_study(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| not_found_error("study", &id))?;
    let children = state.store.study_children(&record).map_err(to_api_error)?;
    Ok(Json(study_detail(&record, &children)))
}

async fn cancel_study(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let auth = state.security.authorize(&headers, Role::Operator)?;
    state.security.check_rate(&auth.subject)?;
    let record = state
        .store
        .get_study(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| not_found_error("study", &id))?;
    let children = state.store.study_children(&record).map_err(to_api_error)?;
    let mut cancelled = 0;
    let mut requested = 0;
    let mut terminal = 0;
    for child in &children {
        match state.store.cancel(&child.id).map_err(to_api_error)? {
            CancelOutcome::Cancelled => cancelled += 1,
            CancelOutcome::CancelRequested => requested += 1,
            CancelOutcome::Terminal => terminal += 1,
            CancelOutcome::NotFound => {}
        }
    }
    let children = state.store.study_children(&record).map_err(to_api_error)?;
    let mut detail = study_detail(&record, &children);
    detail["cancel"] = json!({
        "cancelled": cancelled,
        "cancel_requested": requested,
        "already_terminal": terminal,
    });
    Ok(Json(detail))
}

async fn get_study_report(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let record = state
        .store
        .get_study(&id)
        .map_err(to_api_error)?
        .ok_or_else(|| not_found_error("study", &id))?;
    let children = state.store.study_children(&record).map_err(to_api_error)?;
    let mut response = (StatusCode::OK, study_report(&record, &children)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    Ok(response)
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let key = headers
        .get("idempotency-key")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            ApiError::bad_request("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be ASCII")
        })?
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Some(key) = &key {
        if key.len() > 128 || key.chars().any(char::is_control) {
            return Err(ApiError::bad_request(
                "INVALID_IDEMPOTENCY_KEY",
                "Idempotency-Key must be 1 to 128 ASCII characters",
            ));
        }
    }
    Ok(key)
}

fn not_found_error(kind: &str, id: &str) -> ApiError {
    ApiError::not_found(format!("no {kind} exists with id {id}"))
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
            "daily": format!("/api/v1/experiments/{}/daily.csv", record.id),
            "weekly": format!("/api/v1/experiments/{}/weekly.csv", record.id),
            "report": format!("/api/v1/experiments/{}/report.md", record.id),
        },
    });
    if include_spec {
        value["spec"] = request;
    }
    if include_result {
        if let Some(result) = result {
            value["result"] = result;
        }
        if let Some(analysis) =
            analyze(record).and_then(|analysis| serde_json::to_value(analysis).ok())
        {
            value["analysis"] = analysis;
        }
    }
    value
}

fn period_markdown(periods: &[crate::analysis::PeriodSummary]) -> String {
    if periods.is_empty() {
        return "No samples in this period range.\n".to_owned();
    }
    let mut text = String::from(
        "| Period | Samples | COD | SS | NH4-N | TN | TP | DO min | Flow |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n",
    );
    for period in periods {
        text.push_str(&format!(
            "| {} | {} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.1} |\n",
            period.period,
            period.sample_count,
            period.cod_mean,
            period.ss_mean,
            period.nh4_n_mean,
            period.tn_mean,
            period.tp_mean,
            period.do_min,
            period.flow_mean
        ));
    }
    text
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
    if let Some(analysis) = analyze(record) {
        report.push_str("\n## Scorecard\n\n");
        report.push_str(&format!(
            "- Grade: **{}** (effluent score {:.1}/100, {}/{} limits passed)\n",
            analysis.scorecard.grade,
            analysis.scorecard.score,
            analysis.scorecard.passed,
            analysis.scorecard.total
        ));
        if let Some(closed) = analysis.scorecard.mass_balance_closed {
            report.push_str(&format!(
                "- Mass balance closed: `{}`; max residual: {:.2}%\n",
                closed,
                analysis.scorecard.max_balance_residual_pct.unwrap_or(0.0)
            ));
        }
        report.push_str(&format!("- Applicability: `{}`\n", analysis.applicability));
        report.push_str("\n## Alarms\n\n");
        if analysis.alarms.is_empty() {
            report.push_str("No alarms.\n");
        } else {
            report.push_str("| Code | Severity | Scope | Message |\n|---|---|---|---|\n");
            for alarm in &analysis.alarms {
                report.push_str(&format!(
                    "| `{}` | {} | {} | {} |\n",
                    alarm.code, alarm.severity, alarm.scope, alarm.message
                ));
            }
            report.push_str("\n### Alarm explanations\n\n");
            for alarm in &analysis.alarms {
                if alarm.evidence.is_empty()
                    && alarm.possible_causes.is_empty()
                    && alarm.recommended_actions.is_empty()
                {
                    continue;
                }
                report.push_str(&format!("- **`{}`**\n", alarm.code));
                if !alarm.evidence.is_empty() {
                    report.push_str(&format!("  - Evidence: {}\n", alarm.evidence.join("；")));
                }
                if !alarm.possible_causes.is_empty() {
                    report.push_str(&format!(
                        "  - Possible causes: {}\n",
                        alarm.possible_causes.join("；")
                    ));
                }
                if !alarm.recommended_actions.is_empty() {
                    report.push_str(&format!(
                        "  - Recommended actions: {}\n",
                        alarm.recommended_actions.join("；")
                    ));
                }
            }
        }
        report.push_str("\n## Daily averages\n\n");
        report.push_str(&period_markdown(&analysis.daily));
        report.push_str("\n## Weekly averages\n\n");
        report.push_str(&period_markdown(&analysis.weekly));
        report.push_str("\n## Data quality\n\n");
        report.push_str(&format!(
            "- Samples: {}; finite: {}; duplicate minutes: {}\n- Missing optional fields: `{}`\n",
            analysis.data_quality.sample_count,
            analysis.data_quality.finite_sample_count,
            analysis.data_quality.duplicate_minutes,
            analysis.data_quality.missing_optional_fields.join(", ")
        ));
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
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Persistent, idempotent wastewater treatment experiments."
        },
        "paths": {
            "/": {"get": {"summary": "Visual process studio", "responses": {"200": {"description": "HTML console"}}}},
            "/api/health": {"get": {"summary": "Service health", "responses": {"200": {"description": "OK"}}}},
            "/api/auth-required": {"get": {"summary": "Whether bearer auth is required", "responses": {"200": {"description": "Auth requirement"}}}},
            "/api/standards": {"get": {"summary": "Legacy discharge standards envelope", "responses": {"200": {"description": "Standards"}}}},
            "/api/limits": {"get": {"summary": "Legacy discharge limits and control bounds", "responses": {"200": {"description": "Limits"}}}},
            "/api/snapshot": {"get": {"summary": "Legacy read-only snapshot derived from the newest succeeded experiment", "responses": {"200": {"description": "Snapshot with compatibility metadata"}, "503": {"description": "No succeeded experiment yet"}}}},
            "/api/topology": {"get": {"summary": "Legacy read-only topology translated from the newest experiment request", "responses": {"200": {"description": "Topology with compatibility metadata"}, "503": {"description": "No experiment yet"}}}},
            "/api/metrics": {"get": {"summary": "Prometheus text metrics (V2 subset)", "responses": {"200": {"description": "text/plain metrics"}}}},
            "/api/history/snapshots": {"get": {"summary": "Succeeded experiment history projection", "responses": {"200": {"description": "History items"}}}},
            "/api/openapi.json": {"get": {"summary": "This document", "responses": {"200": {"description": "OpenAPI 3.1 document"}}}},
            "/api/v1/presets": {"get": {"summary": "Embedded scenario presets", "responses": {"200": {"description": "Preset list with model configs"}}}},
            "/api/v1/industrial/points": {"get": {"summary": "Simulated industrial point image", "responses": {"200": {"description": "Point list with adapter, range and quality"}}}},
            "/api/v1/industrial/adapters": {"get": {"summary": "Simulated adapter health", "responses": {"200": {"description": "OPC UA / Modbus / MQTT adapter states"}}}},
            "/api/v1/industrial/write": {
                "post": {
                    "summary": "Write a setpoint through the mock adapter and append audit",
                    "requestBody": {"required": true, "content": {"application/json": {"schema": {
                        "type": "object", "required": ["point_id", "value"],
                        "properties": {"point_id": {"type": "string"}, "value": {"type": "number"}, "client_id": {"type": "string"}, "reason": {"type": "string"}}
                    }}}},
                    "responses": {"201": {"description": "Point updated and audit appended"}, "404": {"description": "Unknown point"}, "409": {"description": "Read-only point"}, "422": {"description": "Value outside range"}}
                }
            },
            "/api/v1/industrial/audit": {"get": {"summary": "Hash-chained write audit", "parameters": [{"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 200}}], "responses": {"200": {"description": "Newest audit records first"}}}},
            "/api/v1/watchdog": {"get": {"summary": "Queue watchdog status", "responses": {"200": {"description": "Last watchdog check, stale threshold and warning"}}}},
            "/api/v1/ai/explain": {
                "post": {
                    "summary": "Explain a completed experiment with the local evidence provider",
                    "requestBody": {"required": true, "content": {"application/json": {"schema": {
                        "type": "object", "required": ["experiment_id"],
                        "properties": {"experiment_id": {"type": "string", "format": "uuid"}, "question": {"type": "string", "maxLength": 500}}
                    }}}},
                    "responses": {"200": {"description": "Answer plus scorecard, alarms and audit"}, "404": {"description": "Experiment not found"}, "409": {"description": "Result not ready"}}
                }
            },
            "/api/v1/topologies/validate": {
                "post": {
                    "summary": "Validate and compile an ASM1 PlantTopology without running it",
                    "requestBody": {
                        "required": true,
                        "content": {"application/json": {"schema": {"type": "object"}}}
                    },
                    "responses": {
                        "200": {"description": "Topology compiles"},
                        "422": {"description": "Topology is structurally or hydraulically invalid"}
                    }
                }
            },
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
            "/api/v1/experiments/{id}/daily.csv": {
                "get": {
                    "summary": "Daily averages as CSV",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "CSV"}, "409": {"description": "Experiment not succeeded"}}
                }
            },
            "/api/v1/experiments/{id}/weekly.csv": {
                "get": {
                    "summary": "Weekly averages as CSV",
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
            },
            "/api/v1/studies": {
                "post": {
                    "summary": "Queue a reproducible batch study",
                    "parameters": [{"name": "Idempotency-Key", "in": "header", "required": false, "schema": {"type": "string", "maxLength": 128}}],
                    "requestBody": {"required": true, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/StudyRequest"}}}},
                    "responses": {
                        "202": {"description": "Study and children queued; Location points to the study"},
                        "200": {"description": "Idempotent replay"},
                        "409": {"description": "Idempotency key reused with a different body"},
                        "422": {"description": "Validation failed"},
                        "429": {"description": "Not enough queue capacity for the whole study"}
                    }
                },
                "get": {
                    "summary": "List studies",
                    "parameters": [
                        {"name": "status", "in": "query", "required": false, "schema": {"type": "string", "enum": ["queued", "running", "succeeded", "partial", "failed", "cancelled"]}},
                        {"name": "limit", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 100}}
                    ],
                    "responses": {"200": {"description": "Study summaries"}}
                }
            },
            "/api/v1/studies/{id}": {
                "get": {
                    "summary": "Study detail with variant aggregates and Pareto frontier",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "Study detail"}, "404": {"description": "Not found"}}
                }
            },
            "/api/v1/studies/{id}/cancel": {
                "post": {
                    "summary": "Cancel queued children and request cancellation for running children",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "Cancellation counts and current study detail"}, "404": {"description": "Not found"}}
                }
            },
            "/api/v1/studies/{id}/report.md": {
                "get": {
                    "summary": "Study Markdown report",
                    "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string", "format": "uuid"}}],
                    "responses": {"200": {"description": "Markdown report"}, "404": {"description": "Not found"}}
                }
            }
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "description": "Optional when AQUAPILOT_TOKENS or AQUAPILOT_API_TOKEN is set; roles: viewer, operator, admin."}
            },
            "schemas": {
                "StudyRequest": {
                    "type": "object",
                    "required": ["name", "base"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 128},
                        "base": {
                            "type": "object",
                            "required": ["model"],
                            "properties": {
                                "model": {"type": "string", "enum": ["asm1", "asm2d", "asm2d-parallel", "asm2d-adm1-loop", "adm1", "sludge-line"]},
                                "config": {"type": "object", "description": "Omit to use the bundled default for asm1/asm2d/asm2d-parallel/adm1/sludge-line"},
                                "duration_min": {"type": "number", "minimum": 1, "maximum": 525600, "default": 1440},
                                "dt_min": {"type": "number", "exclusiveMinimum": 0, "maximum": 1, "default": 1},
                                "sample_every_min": {"type": "number", "exclusiveMinimum": 0, "default": 60}
                            }
                        },
                        "variants": {
                            "type": "array", "maxItems": 12,
                            "items": {
                                "type": "object", "required": ["name"],
                                "properties": {
                                    "name": {"type": "string", "maxLength": 64},
                                    "config": {"type": "object"},
                                    "config_patch": {"type": "object", "description": "RFC 7396 merge patch applied to base.config"},
                                    "controls": {
                                        "type": "object",
                                        "properties": {
                                            "do_setpoint": {"type": "number", "minimum": 0, "maximum": 10},
                                            "internal_recirc": {"type": "number", "minimum": 0, "maximum": 5},
                                            "ras_ratio": {"type": "number", "minimum": 0, "maximum": 5},
                                            "was_ratio": {"type": "number", "minimum": 0, "maximum": 0.5},
                                            "pac_dose": {"type": "number", "minimum": 0, "maximum": 200}
                                        }
                                    }
                                }
                            }
                        },
                        "replicates": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1},
                        "objectives": {
                            "type": "array", "maxItems": 4,
                            "items": {
                                "type": "object", "required": ["metric"],
                                "properties": {
                                    "metric": {"type": "string", "enum": ["score", "passed", "max_balance_residual_pct", "effluent.cod", "effluent.ss", "effluent.nh4_n", "effluent.tn", "effluent.tp"]},
                                    "direction": {"type": "string", "enum": ["min", "max"], "default": "min"}
                                }
                            }
                        }
                    }
                },
                "ExperimentRequest": {
                    "type": "object",
                    "required": ["name", "model", "config"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 128},
                        "model": {"type": "string", "enum": ["asm1", "asm2d", "asm2d-parallel", "asm2d-adm1-loop", "adm1", "sludge-line"]},
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
    async fn study_create_detail_report_replay_and_conflict() {
        let store = Store::in_memory(8).expect("store");
        let router = build_router(store);
        let body = json!({
            "name": "study-api",
            "base": {
                "model": "asm2d",
                "config": serde_json::from_str::<Value>(include_str!("../../../fixtures/a2o-asm2d.json")).expect("fixture"),
                "duration_min": 30.0
            },
            "variants": [
                {"name": "do-2", "controls": {"do_setpoint": 2.0}},
                {"name": "do-1", "controls": {"do_setpoint": 1.0}}
            ],
            "objectives": [{"metric": "effluent.cod", "direction": "min"}]
        });
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/studies")
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", "study-key")
            .body(Body::from(serde_json::to_vec(&body).expect("json")))
            .expect("request");
        let response = router.clone().oneshot(request).await.expect("post");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let location = response
            .headers()
            .get(header::LOCATION)
            .expect("location")
            .to_str()
            .expect("location text")
            .to_owned();
        let created = body_json(response).await;
        let id = created["id"].as_str().expect("id").to_owned();
        assert_eq!(location, format!("/api/v1/studies/{id}"));
        assert_eq!(created["children"].as_array().expect("children").len(), 2);
        assert_eq!(created["status"], "queued");

        let same = Request::builder()
            .method("POST")
            .uri("/api/v1/studies")
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", "study-key")
            .body(Body::from(serde_json::to_vec(&body).expect("json")))
            .expect("request");
        let response = router.clone().oneshot(same).await.expect("replay");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["id"], id);

        let detail = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/studies/{id}"))
                    .body(Body::empty())
                    .expect("detail"),
            )
            .await
            .expect("detail");
        assert_eq!(detail.status(), StatusCode::OK);
        assert_eq!(
            body_json(detail).await["aggregate"]["variants"]
                .as_array()
                .expect("variants")
                .len(),
            2
        );

        let report = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/studies/{id}/report.md"))
                    .body(Body::empty())
                    .expect("report"),
            )
            .await
            .expect("report");
        assert_eq!(report.status(), StatusCode::OK);
        assert_eq!(
            report.headers().get(header::CONTENT_TYPE).expect("type"),
            "text/markdown; charset=utf-8"
        );

        let mut changed = body;
        changed["name"] = json!("study-api-2");
        let conflict = Request::builder()
            .method("POST")
            .uri("/api/v1/studies")
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", "study-key")
            .body(Body::from(serde_json::to_vec(&changed).expect("json")))
            .expect("request");
        let response = router.oneshot(conflict).await.expect("conflict");
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn legacy_read_projection_is_explicitly_not_live() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store.clone());
        let response = router
            .clone()
            .oneshot(request(minimal_body("legacy-projection")))
            .await
            .expect("post");
        let created = body_json(response).await;
        let id = created["id"].as_str().expect("id").to_owned();
        let _ = store.claim_next().expect("claim").expect("queued");
        let samples = vec![Sample {
            minute: 1440.0,
            flow_m3_h: 1000.0,
            cod: 30.0,
            bod: Some(8.0),
            ss: 2.0,
            nh4_n: 1.0,
            tn: 8.0,
            tp: 0.1,
            po4_p: Some(0.05),
            ph: Some(7.0),
            temperature_c: Some(20.0),
            do_mg_l: 2.0,
            mlss: Some(3000.0),
            srt_d: Some(15.0),
            energy_kw: Some(100.0),
            score: None,
            blanket_depth_m: Some(0.5),
        }];
        let result = json!({
            "time_min": 1440.0,
            "effluent": {"flow_m3_h": 1000.0, "cod": 30.0, "ss": 2.0, "nh4_n": 1.0, "tn": 8.0, "tp": 0.1},
            "reactors": [{"id": "anaerobic", "name": "厌氧池", "kind": "anaerobic", "volume_m3": 1000.0, "flow_in_m3_h": 1000.0, "mlss": 3000.0, "do": 0.0, "cod": 100.0, "nh4_n": 10.0}]
        });
        store
            .finish_success(
                &id,
                &result.to_string(),
                &serde_json::to_string(&samples).expect("samples"),
            )
            .expect("finish");

        let snapshot = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/snapshot")
                    .body(Body::empty())
                    .expect("snapshot"),
            )
            .await
            .expect("snapshot response");
        assert_eq!(snapshot.status(), StatusCode::OK);
        let snapshot = body_json(snapshot).await;
        assert_eq!(snapshot["compatibility"]["liveTick"], false);
        assert_eq!(snapshot["compatibility"]["experimentId"], id);
        assert_eq!(snapshot["effluent"]["cod"], 30.0);
        assert_eq!(snapshot["energy"]["totalKw"], Value::Null);

        let topology = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/topology")
                    .body(Body::empty())
                    .expect("topology"),
            )
            .await
            .expect("topology response");
        assert_eq!(topology.status(), StatusCode::OK);
        assert_eq!(
            body_json(topology).await["compatibility"]["mode"],
            "translated-read-only"
        );

        let metrics = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/metrics")
                    .body(Body::empty())
                    .expect("metrics"),
            )
            .await
            .expect("metrics response");
        assert_eq!(metrics.status(), StatusCode::OK);
        assert_eq!(
            metrics.headers().get(header::CONTENT_TYPE).expect("type"),
            "text/plain; version=0.0.4; charset=utf-8"
        );

        let history = router
            .oneshot(
                Request::builder()
                    .uri("/api/history/snapshots")
                    .body(Body::empty())
                    .expect("history"),
            )
            .await
            .expect("history response");
        assert_eq!(history.status(), StatusCode::OK);
        assert_eq!(
            body_json(history).await["items"]
                .as_array()
                .expect("items")
                .len(),
            1
        );
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
    async fn detail_analysis_daily_weekly_and_report_routes() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store.clone());
        let response = router
            .clone()
            .oneshot(request(minimal_body("analysis-route")))
            .await
            .expect("post");
        let created = body_json(response).await;
        let id = created["id"].as_str().expect("id").to_owned();
        let record = store.claim_next().expect("claim").expect("queued record");
        assert_eq!(record.id, id);

        let samples = vec![
            Sample {
                minute: 0.0,
                flow_m3_h: 1000.0,
                cod: 30.0,
                bod: Some(8.0),
                ss: 2.0,
                nh4_n: 1.0,
                tn: 8.0,
                tp: 0.1,
                po4_p: Some(0.05),
                ph: Some(7.0),
                temperature_c: Some(20.0),
                do_mg_l: 2.0,
                mlss: Some(3000.0),
                srt_d: Some(15.0),
                energy_kw: Some(100.0),
                score: None,
                blanket_depth_m: Some(0.5),
            },
            Sample {
                minute: 1440.0,
                flow_m3_h: 1000.0,
                cod: 30.0,
                bod: Some(8.0),
                ss: 2.0,
                nh4_n: 1.0,
                tn: 8.0,
                tp: 0.1,
                po4_p: Some(0.05),
                ph: Some(7.0),
                temperature_c: Some(20.0),
                do_mg_l: 2.0,
                mlss: Some(3000.0),
                srt_d: Some(15.0),
                energy_kw: Some(100.0),
                score: None,
                blanket_depth_m: Some(0.5),
            },
        ];
        let result = json!({
            "effluent": {"cod": 30.0, "ss": 2.0, "nh4_n": 1.0, "tn": 8.0, "tp": 0.1, "po4_p": 0.05, "flow_m3_h": 1000.0}
        });
        assert!(store
            .finish_success(
                &id,
                &result.to_string(),
                &serde_json::to_string(&samples).expect("samples")
            )
            .expect("finish"));

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/experiments/{id}"))
                    .body(Body::empty())
                    .expect("detail request"),
            )
            .await
            .expect("detail");
        assert_eq!(response.status(), StatusCode::OK);
        let detail = body_json(response).await;
        assert_eq!(detail["analysis"]["scorecard"]["grade"], "A");
        assert_eq!(detail["analysis"]["scorecard"]["passed"], 6);
        assert_eq!(
            detail["analysis"]["daily"].as_array().expect("daily").len(),
            1
        );

        for suffix in ["daily.csv", "weekly.csv"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/v1/experiments/{id}/{suffix}"))
                        .body(Body::empty())
                        .expect("period csv"),
                )
                .await
                .expect("period csv response");
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = response
                .into_body()
                .collect()
                .await
                .expect("body")
                .to_bytes();
            assert!(bytes.starts_with(b"period,start_minute,end_minute"));
        }

        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/experiments/{id}/report.md"))
                    .body(Body::empty())
                    .expect("report"),
            )
            .await
            .expect("report response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let text = std::str::from_utf8(&bytes).expect("utf8");
        assert!(text.contains("## Scorecard"));
        assert!(text.contains("## Daily averages"));
    }

    #[tokio::test]
    async fn topology_validation_compiles_three_stage() {
        let router = build_router(Store::in_memory(2).expect("store"));
        let topology: PlantTopology =
            serde_json::from_str(include_str!("../../../fixtures/three-stage.json"))
                .expect("three-stage fixture");
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/topologies/validate")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&topology).expect("json")))
            .expect("request");
        let response = router.clone().oneshot(request).await.expect("validate");
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["valid"], true);
        assert_eq!(body["reactors"], 3);

        let mut broken = serde_json::to_value(&topology).expect("topology json");
        broken["connections"] = json!([]);
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/topologies/validate")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&broken).expect("json")))
            .expect("request");
        let response = router.oneshot(request).await.expect("validate");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = body_json(response).await;
        assert_eq!(body["code"], "VALIDATION_FAILED");
        assert_eq!(body["errors"][0]["code"], "TOPOLOGY_INVALID");
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
    async fn web_console_and_presets_are_served() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);

        let page = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("page request"),
            )
            .await
            .expect("page response");
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(
            page.headers()
                .get(header::CONTENT_TYPE)
                .expect("page content type"),
            "text/html; charset=utf-8"
        );
        let body = page
            .into_body()
            .collect()
            .await
            .expect("page body")
            .to_bytes();
        let html = String::from_utf8(body.to_vec()).expect("utf8 page");
        assert!(html.contains("工艺编排台"));
        assert!(html.contains("FREEFORM TOPOLOGY"));
        assert!(html.contains("/api/v1/topologies/validate"));
        assert!(html.contains("/api/v1/presets"));

        let presets = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/presets")
                    .body(Body::empty())
                    .expect("presets request"),
            )
            .await
            .expect("presets response");
        assert_eq!(presets.status(), StatusCode::OK);
        let document = body_json(presets).await;
        let items = document["presets"].as_array().expect("presets");
        assert_eq!(items.len(), 9);
        assert!(items.iter().any(|item| item["label"] == "PAC + 三级过滤"));
        assert!(items
            .iter()
            .all(|item| item["config"].is_object() && item["model"].is_string()));
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
        assert_eq!(document["info"]["version"], "0.0.21");
        assert!(document["paths"]["/api/v1/experiments"].is_object());
        assert!(document["paths"]["/api/v1/presets"].is_object());
        assert!(document["paths"]["/api/v1/topologies/validate"].is_object());
        assert!(document["paths"]["/api/v1/experiments/{id}/daily.csv"].is_object());
        assert!(document["paths"]["/api/v1/experiments/{id}/weekly.csv"].is_object());
        assert!(document["paths"]["/api/v1/studies"].is_object());
        assert!(document["paths"]["/api/v1/studies/{id}/report.md"].is_object());

        let legacy = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/standards")
                    .body(Body::empty())
                    .expect("standards request"),
            )
            .await
            .expect("standards response");
        assert_eq!(legacy.status(), StatusCode::OK);
        let standards = body_json(legacy).await;
        assert_eq!(standards["default"], "gb18918-1a");
        assert_eq!(standards["standards"][0]["limits"]["ss"], 10);

        let auth = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth-required")
                    .body(Body::empty())
                    .expect("auth request"),
            )
            .await
            .expect("auth response");
        assert_eq!(auth.status(), StatusCode::OK);
        assert_eq!(body_json(auth).await["required"], false);

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

    #[tokio::test]
    async fn industrial_write_is_validated_and_audited() {
        let store = Store::in_memory(2).expect("store");
        let router = build_router(store);
        let points = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/industrial/points")
                    .body(Body::empty())
                    .expect("points"),
            )
            .await
            .expect("points response");
        assert_eq!(points.status(), StatusCode::OK);
        let document = body_json(points).await;
        assert_eq!(document["points"].as_array().expect("points").len(), 10);

        let write = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/industrial/write")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"point_id":"influent.flow","value":1500,"client_id":"test-op","reason":"acceptance"}"#))
                    .expect("write"),
            )
            .await
            .expect("write response");
        assert_eq!(write.status(), StatusCode::CREATED);
        let written = body_json(write).await;
        assert_eq!(written["point"]["value"], 1500.0);
        assert_eq!(written["audit"]["seq"], 1);
        assert_eq!(written["audit"]["previous_hash"], "genesis");

        let read_only = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/industrial/write")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"point_id":"effluent.cod","value":10}"#))
                    .expect("read-only"),
            )
            .await
            .expect("read-only response");
        assert_eq!(read_only.status(), StatusCode::CONFLICT);

        let range = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/industrial/write")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"point_id":"aerobic.do","value":99}"#))
                    .expect("range"),
            )
            .await
            .expect("range response");
        assert_eq!(range.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let audit = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/industrial/audit?limit=5")
                    .body(Body::empty())
                    .expect("audit"),
            )
            .await
            .expect("audit response");
        assert_eq!(audit.status(), StatusCode::OK);
        let records = body_json(audit).await;
        let records = records["records"].as_array().expect("records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["actor"], "local-dev");
        assert_eq!(records[0]["new_value"], 1500.0);
        assert_eq!(records[0]["hash"].as_str().expect("hash").len(), 64);
    }

    #[tokio::test]
    async fn bearer_roles_rate_limit_and_audit_access_are_enforced() {
        let store = Store::in_memory(4).expect("store");
        let security = Security::with_tokens(&[("ops", Role::Operator), ("root", Role::Admin)], 1);
        let router = build_router_with(store, security, None);

        let unauthorized = router
            .clone()
            .oneshot(request(
                json!({"name": "no-auth", "model": "asm2d", "config": {}}),
            ))
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert!(unauthorized
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .is_some());

        let mut authorized = request(minimal_body("with-auth"));
        authorized.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer ops"),
        );
        let created = router.clone().oneshot(authorized).await.expect("create");
        assert_eq!(created.status(), StatusCode::ACCEPTED);

        let mut limited = request_with_key(minimal_body("rate-limited"), "test-key-2");
        limited.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer ops"),
        );
        let limited = router.clone().oneshot(limited).await.expect("limited");
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(limited.headers().get(header::RETRY_AFTER).is_some());

        let no_token = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/industrial/audit")
                    .body(Body::empty())
                    .expect("audit"),
            )
            .await
            .expect("audit anon");
        assert_eq!(no_token.status(), StatusCode::UNAUTHORIZED);

        let ops_audit = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/industrial/audit")
                    .header(header::AUTHORIZATION, "Bearer ops")
                    .body(Body::empty())
                    .expect("audit ops"),
            )
            .await
            .expect("audit ops");
        assert_eq!(ops_audit.status(), StatusCode::FORBIDDEN);

        let root_audit = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/industrial/audit")
                    .header(header::AUTHORIZATION, "Bearer root")
                    .body(Body::empty())
                    .expect("audit root"),
            )
            .await
            .expect("audit root");
        assert_eq!(root_audit.status(), StatusCode::OK);
    }
}

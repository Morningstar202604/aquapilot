//! Batch study planning, expansion and reporting.
//!
//! A study is a durable parent row over child experiments. Expansion happens
//! before the queue sees anything, so capacity is checked atomically in
//! `Store::create_study`. Variants are deterministic JSON merge patches, not
//! free-form scripts: a study can be replayed from the stored request.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::analysis::analyze;
use crate::error::FieldError;
use crate::runner::{ExperimentRequest, ModelKind};
use crate::store::{ExperimentRecord, StudyRecord};

const MAX_CHILDREN: usize = 24;
const MAX_VARIANTS: usize = 12;
const MAX_REPLICATES: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyRequest {
    pub name: String,
    pub base: StudyBase,
    #[serde(default)]
    pub variants: Vec<StudyVariant>,
    #[serde(default = "default_replicates")]
    pub replicates: usize,
    #[serde(default)]
    pub objectives: Vec<StudyObjective>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyBase {
    pub model: ModelKind,
    #[serde(default)]
    pub config: Value,
    #[serde(default = "default_duration_min", alias = "durationMin")]
    pub duration_min: f64,
    #[serde(default = "default_dt_min", alias = "dtMin")]
    pub dt_min: f64,
    #[serde(default = "default_sample_every_min", alias = "sampleEveryMin")]
    pub sample_every_min: f64,
    #[serde(default = "default_sludge_days", alias = "sludgeDays")]
    pub sludge_days: f64,
    #[serde(default = "default_sludge_dt_days", alias = "sludgeDtDays")]
    pub sludge_dt_days: f64,
    #[serde(default, alias = "maxIterations")]
    pub max_iterations: usize,
    #[serde(default)]
    pub relaxation: f64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StudyVariant {
    pub name: String,
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(default)]
    pub config_patch: Option<Value>,
    #[serde(default)]
    pub controls: Option<StudyControls>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StudyControls {
    #[serde(default, alias = "doSetpoint")]
    pub do_setpoint: Option<f64>,
    #[serde(default, alias = "internalRecirc")]
    pub internal_recirc: Option<f64>,
    #[serde(default, alias = "rasRatio")]
    pub ras_ratio: Option<f64>,
    #[serde(default, alias = "wasRatio")]
    pub was_ratio: Option<f64>,
    #[serde(default, alias = "pacDose")]
    pub pac_dose: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyObjective {
    pub metric: String,
    #[serde(default = "default_direction")]
    pub direction: String,
}

#[derive(Debug, Clone)]
pub struct ExpandedStudy {
    pub spec: StudyRequest,
    pub children: Vec<ExperimentRequest>,
    pub assignments: Vec<ChildAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildAssignment {
    pub id: String,
    pub variant: String,
    pub replicate: usize,
}

fn default_replicates() -> usize {
    1
}
fn default_duration_min() -> f64 {
    1440.0
}
fn default_dt_min() -> f64 {
    1.0
}
fn default_sample_every_min() -> f64 {
    60.0
}
fn default_sludge_days() -> f64 {
    30.0
}
fn default_sludge_dt_days() -> f64 {
    0.002
}
fn default_direction() -> String {
    "min".to_owned()
}

impl StudyRequest {
    pub fn expand(&self, ids: &[String]) -> Result<ExpandedStudy, Vec<FieldError>> {
        let mut errors = Vec::new();
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 128 {
            errors.push(field(
                "name",
                "LENGTH",
                "study name must contain 1 to 128 non-whitespace characters",
            ));
        }
        if !(1..=MAX_REPLICATES).contains(&self.replicates) {
            errors.push(field(
                "replicates",
                "RANGE",
                "replicates must be between 1 and 3",
            ));
        }
        if self.variants.len() > MAX_VARIANTS {
            errors.push(field(
                "variants",
                "COUNT",
                "a study can contain at most 12 variants",
            ));
        }
        let children_count = self.variants.len().max(1) * self.replicates;
        if children_count > MAX_CHILDREN {
            errors.push(field(
                "variants",
                "COUNT",
                "expanded study must contain at most 24 experiments",
            ));
        }
        if self.objectives.len() > 4 {
            errors.push(field(
                "objectives",
                "COUNT",
                "a study can have at most 4 objectives",
            ));
        }
        for (index, objective) in self.objectives.iter().enumerate() {
            if !matches!(objective.direction.as_str(), "min" | "max") {
                errors.push(field(
                    format!("objectives[{index}].direction"),
                    "ENUM",
                    "direction must be min or max",
                ));
            }
            if metric_path(normalized_metric(objective.metric.trim())).is_none() {
                errors.push(field(
                    format!("objectives[{index}].metric"),
                    "UNKNOWN",
                    "metric must be score, passed, max_balance_residual_pct, or effluent.<cod|ss|nh4_n|tn|tp>",
                ));
            }
        }
        let base_config = if self.base.config.is_null() {
            default_config(self.base.model)
        } else {
            Some(self.base.config.clone())
        };
        if !self.base.extra.is_empty() {
            errors.push(field(
                "base",
                "UNSUPPORTED_FIELD",
                format!(
                    "V2 cannot honor these legacy ExperimentSpec fields: {}",
                    self.base
                        .extra
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        if base_config.is_none() {
            errors.push(field(
                "base.config",
                "REQUIRED",
                "base.config is required for this model (no default preset is bundled)",
            ));
        }
        let mut seen = BTreeMap::new();
        for (index, variant) in self.variants.iter().enumerate() {
            let variant_name = variant.name.trim();
            if variant_name.is_empty() || variant_name.chars().count() > 64 {
                errors.push(field(
                    format!("variants[{index}].name"),
                    "LENGTH",
                    "variant name must contain 1 to 64 non-whitespace characters",
                ));
            }
            if seen.insert(variant_name.to_owned(), index).is_some() {
                errors.push(field(
                    format!("variants[{index}].name"),
                    "DUPLICATE",
                    "variant names must be unique within a study",
                ));
            }
            if !variant.extra.is_empty() {
                errors.push(field(
                    format!("variants[{index}]"),
                    "UNSUPPORTED_FIELD",
                    format!(
                        "V2 cannot honor these legacy variant fields: {}",
                        variant.extra.keys().cloned().collect::<Vec<_>>().join(", ")
                    ),
                ));
            }
            if variant.config.is_some() && variant.config_patch.is_some() {
                errors.push(field(
                    format!("variants[{index}]"),
                    "CONFLICT",
                    "use either config or config_patch for a variant, not both",
                ));
            }
            if let Some(controls) = &variant.controls {
                validate_controls(controls, index, &mut errors);
            }
        }
        if !errors.is_empty() {
            return Err(errors);
        }
        let base_config = base_config.expect("validated config exists");
        let variants: Vec<StudyVariant> = if self.variants.is_empty() {
            vec![StudyVariant {
                name: "base".to_owned(),
                ..StudyVariant::default()
            }]
        } else {
            self.variants.clone()
        };
        let mut children = Vec::with_capacity(children_count);
        let mut assignments = Vec::with_capacity(children_count);
        let mut cursor = 0;
        for variant in &variants {
            for replicate in 1..=self.replicates {
                let mut config = variant
                    .config
                    .clone()
                    .unwrap_or_else(|| base_config.clone());
                if let Some(patch) = &variant.config_patch {
                    merge_patch(&mut config, patch);
                }
                if let Some(controls) = &variant.controls {
                    if !apply_controls(&mut config, controls) {
                        return Err(vec![field(
                            "base.config",
                            "SHAPE",
                            "controls are not supported for this config shape",
                        )]);
                    }
                }
                let child_name = format!("{} / {} / r{}", name, variant.name.trim(), replicate);
                let child = ExperimentRequest {
                    name: child_name,
                    model: self.base.model,
                    config,
                    duration_min: self.base.duration_min,
                    dt_min: self.base.dt_min,
                    sample_every_min: self.base.sample_every_min,
                    sludge_days: self.base.sludge_days,
                    sludge_dt_days: self.base.sludge_dt_days,
                    max_iterations: self.base.max_iterations,
                    relaxation: self.base.relaxation,
                };
                child.validate()?;
                if cursor >= ids.len() {
                    return Err(vec![field(
                        "children",
                        "INTERNAL",
                        "not enough child identifiers allocated",
                    )]);
                }
                assignments.push(ChildAssignment {
                    id: ids[cursor].clone(),
                    variant: variant.name.trim().to_owned(),
                    replicate,
                });
                children.push(child);
                cursor += 1;
            }
        }
        Ok(ExpandedStudy {
            spec: self.clone(),
            children,
            assignments,
        })
    }
}

pub fn default_config(model: ModelKind) -> Option<Value> {
    let raw = match model {
        ModelKind::Asm1 => include_str!("../../../fixtures/bsm1-calibrated.json"),
        ModelKind::Asm2d => include_str!("../../../fixtures/a2o-asm2d.json"),
        ModelKind::Asm2dParallel => include_str!("../../../fixtures/a2o-asm2d-2train.json"),
        ModelKind::Adm1 => include_str!("../../../fixtures/adm1-tutorial.json"),
        ModelKind::SludgeLine => include_str!("../../../fixtures/adm1-sludge-line.json"),
        ModelKind::Asm2dAdm1Loop => return None,
    };
    serde_json::from_str(raw).ok()
}

fn validate_controls(controls: &StudyControls, index: usize, errors: &mut Vec<FieldError>) {
    let checks = [
        ("doSetpoint", controls.do_setpoint, 0.0, 10.0),
        ("internalRecirc", controls.internal_recirc, 0.0, 5.0),
        ("rasRatio", controls.ras_ratio, 0.0, 5.0),
        ("wasRatio", controls.was_ratio, 0.0, 0.5),
        ("pacDose", controls.pac_dose, 0.0, 200.0),
    ];
    for (key, value, min, max) in checks {
        if let Some(value) = value {
            if !value.is_finite() || value < min || value > max {
                errors.push(field(
                    format!("variants[{index}].controls.{key}"),
                    "RANGE",
                    format!("{key} must be between {min} and {max}"),
                ));
            }
        }
    }
}

fn apply_controls(config: &mut Value, controls: &StudyControls) -> bool {
    if let Some(plant) = config.get_mut("plant") {
        return apply_controls(plant, controls);
    }
    if let Some(trains) = config.get_mut("trains").and_then(Value::as_array_mut) {
        let mut applied = false;
        for train in trains {
            applied |= apply_controls(train, controls);
        }
        return applied;
    }
    let flow = config
        .pointer("/influent/flow_m3_h")
        .and_then(Value::as_f64)
        .or_else(|| {
            config
                .get("units")
                .and_then(Value::as_array)
                .and_then(|units| {
                    units
                        .iter()
                        .find(|unit| unit.get("type").and_then(Value::as_str) == Some("influent"))
                })
                .and_then(|unit| unit.get("flow_m3_h").and_then(Value::as_f64))
        })
        .unwrap_or(1000.0);
    if let Some(do_setpoint) = controls.do_setpoint {
        let mut applied = false;
        if let Some(reactors) = config.get_mut("reactors").and_then(Value::as_array_mut) {
            for reactor in reactors {
                if matches!(
                    reactor
                        .get("kind")
                        .or_else(|| reactor.get("type"))
                        .and_then(Value::as_str),
                    Some("aerobic")
                ) {
                    reactor["do_setpoint"] = json!(do_setpoint);
                    applied = true;
                }
            }
        }
        if let Some(units) = config.get_mut("units").and_then(Value::as_array_mut) {
            for unit in units {
                if matches!(
                    unit.get("kind")
                        .or_else(|| unit.get("type"))
                        .and_then(Value::as_str),
                    Some("aerobic")
                ) {
                    unit["do_setpoint"] = json!(do_setpoint);
                    applied = true;
                }
            }
        }
        if !applied {
            return false;
        }
    }
    if let Some(ratio) = controls.internal_recirc {
        if let Some(recycles) = config
            .get_mut("internal_recycles")
            .and_then(Value::as_array_mut)
        {
            if let Some(first) = recycles.first_mut() {
                first["flow_m3_h"] = json!(ratio * flow);
            } else {
                return false;
            }
        } else if let Some(connections) =
            config.get_mut("connections").and_then(Value::as_array_mut)
        {
            let mut found = false;
            for connection in connections {
                if connection.get("kind").and_then(Value::as_str) == Some("internal")
                    || connection.get("recycle").and_then(Value::as_str) == Some("internal")
                {
                    connection["flow_m3_h"] = json!(ratio * flow);
                    found = true;
                }
            }
            if !found {
                return false;
            }
        } else {
            return false;
        }
    }
    if let Some(ratio) = controls.ras_ratio {
        if let Some(clarifier) = config.get_mut("clarifier").and_then(Value::as_object_mut) {
            clarifier.insert("ras_flow_m3_h".to_owned(), json!(ratio * flow));
        } else if let Some(connections) =
            config.get_mut("connections").and_then(Value::as_array_mut)
        {
            let mut found = false;
            for connection in connections {
                if connection.get("recycle").and_then(Value::as_str) == Some("ras") {
                    connection["flow_m3_h"] = json!(ratio * flow);
                    found = true;
                }
            }
            if !found {
                return false;
            }
        } else {
            return false;
        }
    }
    if let Some(ratio) = controls.was_ratio {
        if let Some(clarifier) = config.get_mut("clarifier").and_then(Value::as_object_mut) {
            clarifier.insert("was_flow_m3_h".to_owned(), json!(ratio * flow));
        } else if let Some(connections) =
            config.get_mut("connections").and_then(Value::as_array_mut)
        {
            let mut found = false;
            for connection in connections {
                if connection.get("recycle").and_then(Value::as_str) == Some("was") {
                    connection["flow_m3_h"] = json!(ratio * flow);
                    found = true;
                }
            }
            if !found {
                return false;
            }
        } else {
            return false;
        }
    }
    if let Some(dose) = controls.pac_dose {
        if !config.is_object() {
            return false;
        }
        let pac = config
            .as_object_mut()
            .expect("object checked")
            .entry("pac")
            .or_insert_with(|| json!({"reactor": 0, "dose_mg_l": 0.0, "al2o3_fraction": 0.3, "meoh_per_al": 3.962962962962963}));
        if !pac.is_object() {
            return false;
        }
        pac["dose_mg_l"] = json!(dose);
    }
    true
}

fn merge_patch(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge_patch(
                        target.entry(key.clone()).or_insert_with(|| Value::Null),
                        value,
                    );
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

fn replicate_for(child: &ExperimentRecord) -> i64 {
    child
        .name
        .rsplit_once(" / r")
        .and_then(|(_, value)| value.parse::<i64>().ok())
        .unwrap_or(1)
}

pub(crate) fn iso8601(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let seconds = timestamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

fn field(path: impl Into<String>, code: &str, message: impl Into<String>) -> FieldError {
    FieldError {
        field: path.into(),
        code: code.to_owned(),
        detail: message.into(),
    }
}

fn normalized_metric(metric: &str) -> &str {
    match metric {
        "effluent.nh" => "effluent.nh4_n",
        _ => metric,
    }
}

fn metric_path(metric: &str) -> Option<&'static str> {
    Some(match normalized_metric(metric) {
        "score" => "/scorecard/score",
        "passed" => "/scorecard/passed",
        "max_balance_residual_pct" => "/scorecard/max_balance_residual_pct",
        "effluent.cod" => "/effluent/cod",
        "effluent.ss" => "/effluent/ss",
        "effluent.nh4_n" => "/effluent/nh4_n",
        "effluent.tn" => "/effluent/tn",
        "effluent.tp" => "/effluent/tp",
        "effluent.bod" => "/effluent/bod",
        _ => return None,
    })
}

pub fn study_status(children: &[ExperimentRecord]) -> &'static str {
    if children
        .iter()
        .any(|child| matches!(child.status.as_str(), "queued" | "running"))
    {
        if children.iter().any(|child| child.status == "running") {
            "running"
        } else {
            "queued"
        }
    } else if children.is_empty() {
        "empty"
    } else if children.iter().all(|child| child.status == "succeeded") {
        "succeeded"
    } else if children.iter().all(|child| child.status == "cancelled") {
        "cancelled"
    } else if children.iter().all(|child| child.status == "failed") {
        "failed"
    } else {
        "partial"
    }
}

pub fn study_detail(record: &StudyRecord, children: &[ExperimentRecord]) -> Value {
    let request: Value = serde_json::from_str(&record.spec_json).unwrap_or(Value::Null);
    let mut child_views: Vec<Value> = children.iter().map(child_view).collect();
    if let Some(variants) = request.get("variants").and_then(Value::as_array) {
        for view in &mut child_views {
            let variant = view["name"]
                .as_str()
                .and_then(|name| name.split(" / ").nth(1))
                .unwrap_or("base");
            let index = variants
                .iter()
                .position(|candidate| {
                    candidate.get("name").and_then(Value::as_str) == Some(variant)
                })
                .map(|index| index as i64)
                .unwrap_or(-1);
            view["variantIndex"] = json!(index);
        }
    }
    let variants = aggregate_variants(children, &request);
    let objectives = request
        .get("objectives")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ranking = rank_variants(&variants, &objectives);
    let pareto = pareto_variants(&variants, &objectives);
    let total = children.len();
    let completed = children
        .iter()
        .filter(|child| child.status == "succeeded")
        .count();
    let failed = children
        .iter()
        .filter(|child| child.status == "failed")
        .count();
    let cancelled = children
        .iter()
        .filter(|child| child.status == "cancelled")
        .count();
    let progress_percent = if total == 0 {
        0.0
    } else {
        children.iter().map(|child| child.progress).sum::<f64>() / total as f64 * 100.0
    };
    json!({
        "id": record.id,
        "name": record.name,
        "status": study_status(children),
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "createdAt": iso8601(record.created_at),
        "updatedAt": iso8601(record.updated_at),
        "spec": request,
        "children": child_views,
        "aggregate": {
            "status": study_status(children),
            "progressPercent": progress_percent.round() as i64,
            "total": total,
            "succeeded": completed,
            "completed": completed,
            "failed": failed,
            "cancelled": cancelled,
            "variants": variants,
            "objectives": objectives,
            "ranking": ranking,
            "pareto": pareto,
            "best": ranking.first().cloned(),
        },
        "links": {
            "self": format!("/api/v1/studies/{}", record.id),
            "cancel": format!("/api/v1/studies/{}/cancel", record.id),
            "report": format!("/api/v1/studies/{}/report.md", record.id),
        },
    })
}

#[allow(dead_code)]
pub fn study_summary(record: &StudyRecord, children: &[ExperimentRecord]) -> Value {
    json!({
        "id": record.id,
        "name": record.name,
        "status": study_status(children),
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "child_count": children.len(),
        "completed": children.iter().filter(|child| child.status == "succeeded").count(),
        "failed": children.iter().filter(|child| child.status == "failed").count(),
        "cancelled": children.iter().filter(|child| child.status == "cancelled").count(),
        "links": {
            "self": format!("/api/v1/studies/{}", record.id),
            "cancel": format!("/api/v1/studies/{}/cancel", record.id),
            "report": format!("/api/v1/studies/{}/report.md", record.id),
        },
    })
}

fn child_view(child: &ExperimentRecord) -> Value {
    let analysis = analyze(child).and_then(|value| serde_json::to_value(value).ok());
    let status = if child.status == "running" && child.cancel_requested {
        "cancelling"
    } else {
        child.status.as_str()
    };
    let mut values = Map::new();
    if let Some(analysis) = &analysis {
        for (key, metric) in [
            ("score", "score"),
            ("passed", "passed"),
            ("total", "total"),
            ("max_balance_residual_pct", "max_balance_residual_pct"),
            ("effluent_cod", "cod"),
            ("effluent_bod", "bod"),
            ("effluent_ss", "ss"),
            ("effluent_nh4_n", "nh4_n"),
            ("effluent_tn", "tn"),
            ("effluent_tp", "tp"),
        ] {
            if let Some(value) = analysis_metric(analysis, metric) {
                values.insert(key.to_owned(), json!(value));
            }
        }
    }
    json!({
        "id": child.id,
        "experimentId": child.id,
        "name": child.name,
        "status": status,
        "progress": child.progress,
        "error": child.error,
        "metrics": values,
        "replicate": replicate_for(child),
        "links": {
            "self": format!("/api/v1/experiments/{}", child.id),
            "report": format!("/api/v1/experiments/{}/report.md", child.id),
        },
    })
}

fn aggregate_variants(children: &[ExperimentRecord], request: &Value) -> Vec<Value> {
    let mut groups: BTreeMap<String, Vec<&ExperimentRecord>> = BTreeMap::new();
    for child in children {
        let variant = variant_of(child);
        groups.entry(variant).or_default().push(child);
    }
    let metrics = [
        "score",
        "passed",
        "total",
        "max_balance_residual_pct",
        "effluent_cod",
        "effluent_ss",
        "effluent_nh4_n",
        "effluent_tn",
        "effluent_tp",
    ];
    let mut result = Vec::new();
    for (variant, group) in groups {
        let mut means = Map::new();
        for metric in metrics {
            let values: Vec<f64> = group
                .iter()
                .filter_map(|child| child_metric(child, metric))
                .collect();
            if !values.is_empty() {
                means.insert(
                    metric.to_owned(),
                    json!({"mean": mean(&values), "min": values.iter().copied().fold(f64::INFINITY, f64::min), "max": values.iter().copied().fold(f64::NEG_INFINITY, f64::max), "n": values.len()}),
                );
            }
        }
        let statuses = group
            .iter()
            .map(|child| child.status.clone())
            .collect::<Vec<_>>();
        result.push(json!({
            "variant": variant,
            "children": group.iter().map(|child| child.id.clone()).collect::<Vec<_>>(),
            "status": status_counts(&statuses),
            "metrics": means,
            "replicates": group.len(),
        }));
    }
    let _ = request;
    result
}

fn variant_of(child: &ExperimentRecord) -> String {
    child.name.split(" / ").nth(1).unwrap_or("base").to_owned()
}

fn status_counts(statuses: &[String]) -> Value {
    let mut counts = Map::new();
    for status in statuses {
        let count = counts.entry(status.clone()).or_insert(json!(0));
        if let Some(value) = count.as_i64() {
            *count = json!(value + 1);
        }
    }
    Value::Object(counts)
}

fn child_metric(child: &ExperimentRecord, metric: &str) -> Option<f64> {
    let analysis = analyze(child)?;
    let analysis = serde_json::to_value(analysis).ok()?;
    let metric = metric.strip_prefix("effluent_").unwrap_or(metric);
    analysis_metric(&analysis, metric)
}

fn analysis_metric(analysis: &Value, metric: &str) -> Option<f64> {
    match metric {
        "score" => analysis.pointer("/scorecard/score")?.as_f64(),
        "passed" => analysis.pointer("/scorecard/passed")?.as_f64(),
        "total" => analysis.pointer("/scorecard/total")?.as_f64(),
        "max_balance_residual_pct" => analysis
            .pointer("/scorecard/max_balance_residual_pct")?
            .as_f64(),
        other => analysis
            .pointer("/scorecard/limits")?
            .as_array()?
            .iter()
            .find(|limit| limit.get("metric").and_then(Value::as_str) == Some(other))?
            .get("value")?
            .as_f64(),
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn objective_value(variant: &Value, objective: &Value) -> Option<f64> {
    let metric = objective.get("metric")?.as_str()?;
    let metric = normalized_metric(metric);
    let key = match metric {
        "score" => "score",
        "passed" => "passed",
        "max_balance_residual_pct" => "max_balance_residual_pct",
        "effluent.cod" => "effluent_cod",
        "effluent.ss" => "effluent_ss",
        "effluent.nh4_n" => "effluent_nh4_n",
        "effluent.tn" => "effluent_tn",
        "effluent.tp" => "effluent_tp",
        "effluent.bod" => "effluent_bod",
        _ => return None,
    };
    variant.pointer(&format!("/metrics/{key}/mean"))?.as_f64()
}

fn rank_variants(variants: &[Value], objectives: &[Value]) -> Vec<Value> {
    let Some(first) = objectives.first() else {
        return variants.to_vec();
    };
    let direction = first
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("min");
    let mut ranked = variants.to_vec();
    ranked.sort_by(|a, b| {
        let a = objective_value(a, first).unwrap_or(f64::INFINITY);
        let b = objective_value(b, first).unwrap_or(f64::INFINITY);
        if direction == "max" {
            b.total_cmp(&a)
        } else {
            a.total_cmp(&b)
        }
    });
    ranked
}

fn pareto_variants(variants: &[Value], objectives: &[Value]) -> Vec<Value> {
    if objectives.is_empty() {
        return variants.to_vec();
    }
    let mut frontier = Vec::new();
    for candidate in variants {
        let values: Vec<f64> = objectives
            .iter()
            .filter_map(|objective| objective_value(candidate, objective))
            .collect();
        if values.len() != objectives.len() {
            continue;
        }
        let dominated = variants.iter().any(|other| {
            if other == candidate {
                return false;
            }
            let other_values: Vec<f64> = objectives
                .iter()
                .filter_map(|objective| objective_value(other, objective))
                .collect();
            if other_values.len() != objectives.len() {
                return false;
            }
            let mut at_least_as_good = true;
            let mut strictly_better = false;
            for (index, objective) in objectives.iter().enumerate() {
                let direction = objective
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or("min");
                let better = if direction == "max" {
                    other_values[index] >= values[index]
                } else {
                    other_values[index] <= values[index]
                };
                let strict = if direction == "max" {
                    other_values[index] > values[index]
                } else {
                    other_values[index] < values[index]
                };
                at_least_as_good &= better;
                strictly_better |= strict;
            }
            at_least_as_good && strictly_better
        });
        if !dominated {
            frontier.push(candidate.clone());
        }
    }
    frontier
}

pub fn study_report(record: &StudyRecord, children: &[ExperimentRecord]) -> String {
    let detail = study_detail(record, children);
    let variants = detail
        .pointer("/aggregate/variants")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ranking = detail
        .pointer("/aggregate/ranking")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pareto = detail
        .pointer("/aggregate/pareto")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text = format!(
        "# Study: {}\n\n- ID: `{}`\n- Status: **{}**\n- Children: {} (completed {}, failed {}, cancelled {})\n\n",
        record.name,
        record.id,
        detail["status"].as_str().unwrap_or("unknown"),
        children.len(),
        detail["aggregate"]["completed"].as_u64().unwrap_or(0),
        detail["aggregate"]["failed"].as_u64().unwrap_or(0),
        detail["aggregate"]["cancelled"].as_u64().unwrap_or(0),
    );
    text.push_str("## Variants\n\n| Variant | n | COD | SS | NH4-N | TN | TP | Score | Balance |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n");
    for variant in &variants {
        let metric = |name: &str| {
            variant
                .pointer(&format!("/metrics/{name}/mean"))
                .and_then(Value::as_f64)
                .map(|value| format!("{value:.2}"))
                .unwrap_or_else(|| "-".to_owned())
        };
        text.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
            variant["variant"].as_str().unwrap_or("?"),
            variant["replicates"].as_u64().unwrap_or(0),
            metric("effluent_cod"),
            metric("effluent_ss"),
            metric("effluent_nh4_n"),
            metric("effluent_tn"),
            metric("effluent_tp"),
            metric("score"),
            metric("max_balance_residual_pct"),
        ));
    }
    text.push_str("\n## Ranking\n\n");
    if ranking.is_empty() {
        text.push_str("No metrics are available yet.\n");
    } else {
        for (index, variant) in ranking.iter().enumerate() {
            text.push_str(&format!(
                "{}. {} — candidate\n",
                index + 1,
                variant["variant"].as_str().unwrap_or("?")
            ));
        }
    }
    text.push_str("\n## Pareto frontier\n\n");
    if pareto.is_empty() {
        text.push_str("No frontier can be computed (missing objectives or metrics).\n");
    } else {
        for variant in &pareto {
            text.push_str(&format!(
                "- {}\n",
                variant["variant"].as_str().unwrap_or("?")
            ));
        }
    }
    text.push_str("\n## Evidence\n\n");
    for child in children {
        text.push_str(&format!(
            "- `{}` {} — {}\n",
            child.id, child.name, child.status
        ));
    }
    text.push_str("\n> A study is an offline experiment batch. It does not certify a plant or replace a live control loop.\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> StudyRequest {
        serde_json::from_value(json!({
            "name": "do-scan",
            "base": {
                "model": "asm2d",
                "config": serde_json::from_str::<Value>(include_str!("../../../fixtures/a2o-asm2d.json")).unwrap(),
                "duration_min": 60.0
            },
            "variants": [
                {"name": "do-2", "controls": {"do_setpoint": 2.0}},
                {"name": "do-1", "controls": {"do_setpoint": 1.0, "ras_ratio": 1.0}}
            ],
            "objectives": [{"metric": "effluent.cod", "direction": "min"}]
        }))
        .expect("study")
    }

    #[test]
    fn expands_variants_and_applies_controls() {
        let ids: Vec<String> = (0..24).map(|index| format!("child-{index}")).collect();
        let expanded = request().expand(&ids).expect("expand");
        assert_eq!(expanded.children.len(), 2);
        assert_eq!(expanded.assignments[0].variant, "do-2");
        assert_eq!(
            expanded.children[0].config["reactors"][2]["do_setpoint"],
            2.0
        );
        assert_eq!(
            expanded.children[1].config["reactors"][2]["do_setpoint"],
            1.0
        );
        assert_eq!(
            expanded.children[1].config["clarifier"]["ras_flow_m3_h"],
            1000.0
        );
    }

    #[test]
    fn rejects_duplicate_variant_names_and_bad_metric() {
        let mut request = request();
        request.variants[1].name = "do-2".to_owned();
        request.objectives[0].metric = "not-a-metric".to_owned();
        let ids: Vec<String> = (0..24).map(|index| format!("child-{index}")).collect();
        let errors = request.expand(&ids).expect_err("must reject");
        assert!(errors.iter().any(|error| error.code == "DUPLICATE"));
        assert!(errors.iter().any(|error| error.code == "UNKNOWN"));
    }

    #[test]
    fn merge_patch_is_recursive_and_null_deletes() {
        let mut target = json!({"a": {"b": 1, "c": 2}, "d": 3});
        merge_patch(&mut target, &json!({"a": {"b": 9, "c": null}, "e": 4}));
        assert_eq!(target, json!({"a": {"b": 9}, "d": 3, "e": 4}));
    }
}

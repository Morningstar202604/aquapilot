//! Result analytics for the service layer.
//!
//! The model crates own physics; this module owns the *decision* view: effluent
//! limits, alarms, a transparent scorecard, daily/weekly averages and data-quality
//! evidence. It never mutates the model result, and every number here is derived
//! from the stored samples or the stored mass-balance object.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runner::Sample;
use crate::store::ExperimentRecord;

const EFFLUENT_LIMITS: &[(&str, &str, f64)] = &[
    ("cod", "COD", 50.0),
    ("ss", "SS", 10.0),
    ("nh4_n", "NH4-N", 5.0),
    ("tn", "TN", 15.0),
    ("tp", "TP", 0.5),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LimitCheck {
    pub metric: String,
    pub label: String,
    pub value: Option<f64>,
    pub limit: f64,
    pub unit: String,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Alarm {
    pub code: String,
    pub severity: String,
    pub scope: String,
    pub message: String,
    pub metric: Option<String>,
    pub value: Option<f64>,
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scorecard {
    pub grade: String,
    pub score: f64,
    pub passed: usize,
    pub total: usize,
    pub limits: Vec<LimitCheck>,
    pub mass_balance_closed: Option<bool>,
    pub max_balance_residual_pct: Option<f64>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodSummary {
    pub index: usize,
    pub period: String,
    pub start_minute: f64,
    pub end_minute: f64,
    pub sample_count: usize,
    pub cod_mean: f64,
    pub ss_mean: f64,
    pub nh4_n_mean: f64,
    pub tn_mean: f64,
    pub tp_mean: f64,
    pub po4_p_mean: Option<f64>,
    pub do_min: f64,
    pub do_mean: f64,
    pub flow_mean: f64,
    pub energy_kw_mean: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DataQuality {
    pub sample_count: usize,
    pub finite_sample_count: usize,
    pub duplicate_minutes: usize,
    pub missing_optional_fields: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExperimentAnalysis {
    pub applicability: String,
    pub scorecard: Scorecard,
    pub alarms: Vec<Alarm>,
    pub data_quality: DataQuality,
    pub daily: Vec<PeriodSummary>,
    pub weekly: Vec<PeriodSummary>,
    pub method: String,
}

/// Analyse one stored experiment. Returns `None` only when the stored result
/// cannot be decoded; a succeeded experiment with no samples still returns a
/// data-quality object and an alarm.
pub fn analyze(record: &ExperimentRecord) -> Option<ExperimentAnalysis> {
    let result: Value = record
        .result_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or(Value::Null);
    let samples: Vec<Sample> = record
        .samples_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    Some(analyze_parts(&record.model, &result, &samples))
}

pub fn analyze_parts(model: &str, result: &Value, samples: &[Sample]) -> ExperimentAnalysis {
    let process_model = matches!(model, "adm1" | "sludge-line");
    let final_sample = samples.last();
    let mut alarms = Vec::new();
    let mut limits = Vec::new();

    let check_metrics: &[(&str, &str, f64)] = match model {
        "asm2d" | "asm2d-adm1-loop" => &[
            ("cod", "COD", 50.0),
            ("ss", "SS", 10.0),
            ("nh4_n", "NH4-N", 5.0),
            ("tn", "TN", 15.0),
            ("tp", "TP", 0.5),
            ("po4_p", "PO4-P", 0.5),
        ],
        // ASM1 does not model phosphorus. Scoring TP=0 would be a fake pass.
        "asm1" => &[
            ("cod", "COD", 50.0),
            ("ss", "SS", 10.0),
            ("nh4_n", "NH4-N", 5.0),
            ("tn", "TN", 15.0),
        ],
        _ => EFFLUENT_LIMITS,
    };

    if !process_model {
        for (metric, label, limit) in check_metrics {
            let value = final_sample.and_then(|sample| metric_value(sample, metric));
            let passed = value.is_some_and(|value| value <= *limit);
            if let Some(value) = value {
                if !passed {
                    alarms.push(Alarm {
                        code: format!("EFFLUENT_{}_HIGH", metric.to_ascii_uppercase()),
                        severity: "high".to_owned(),
                        scope: "effluent".to_owned(),
                        message: format!("{label} {value:.3} exceeds {limit:.1} mg/L"),
                        metric: Some((*metric).to_owned()),
                        value: Some(value),
                        limit: Some(*limit),
                    });
                }
            }
            limits.push(LimitCheck {
                metric: (*metric).to_owned(),
                label: (*label).to_owned(),
                value,
                limit: *limit,
                unit: "mg/L".to_owned(),
                passed,
            });
        }
    }

    let do_samples: Vec<&Sample> = samples
        .iter()
        .filter(|sample| sample.minute > 60.0)
        .collect();
    if let Some(min_do) = do_samples
        .iter()
        .map(|sample| sample.do_mg_l)
        .reduce(f64::min)
    {
        if min_do < 1.0 {
            alarms.push(Alarm {
                code: "LOW_DO".to_owned(),
                severity: if min_do < 0.5 { "high" } else { "medium" }.to_owned(),
                scope: "series".to_owned(),
                message: format!("minimum dissolved oxygen {min_do:.2} mg/L is below 1.0 mg/L"),
                metric: Some("do_mg_l".to_owned()),
                value: Some(min_do),
                limit: Some(1.0),
            });
        }
    }

    let balance = balance_view(result);
    if let Some(balance) = &balance {
        if let Some(closed) = balance.closed {
            if !closed {
                alarms.push(Alarm {
                    code: "MASS_BALANCE_OPEN".to_owned(),
                    severity: "medium".to_owned(),
                    scope: "plant".to_owned(),
                    message: format!(
                        "plant COD/N/P mass balance is not closed (max residual {:.2}%)",
                        balance.max_residual_pct.unwrap_or(0.0)
                    ),
                    metric: Some("mass_balance".to_owned()),
                    value: balance.max_residual_pct,
                    limit: Some(5.0),
                });
            }
        }
    }

    let quality = data_quality(samples);
    if samples.is_empty() {
        alarms.push(Alarm {
            code: "NO_SAMPLES".to_owned(),
            severity: "medium".to_owned(),
            scope: "data".to_owned(),
            message: "succeeded experiment contains no samples".to_owned(),
            metric: None,
            value: None,
            limit: None,
        });
    } else if samples.len() < 2 {
        alarms.push(Alarm {
            code: "SPARSE_SAMPLES".to_owned(),
            severity: "low".to_owned(),
            scope: "data".to_owned(),
            message: "only one sample is available; daily/weekly summaries are not meaningful"
                .to_owned(),
            metric: Some("sample_count".to_owned()),
            value: Some(samples.len() as f64),
            limit: Some(2.0),
        });
    }
    if quality.finite_sample_count < quality.sample_count {
        alarms.push(Alarm {
            code: "NONFINITE_SAMPLE".to_owned(),
            severity: "high".to_owned(),
            scope: "data".to_owned(),
            message: format!(
                "{} of {} samples contain non-finite values",
                quality.sample_count - quality.finite_sample_count,
                quality.sample_count
            ),
            metric: Some("finite_sample_count".to_owned()),
            value: Some(quality.finite_sample_count as f64),
            limit: Some(quality.sample_count as f64),
        });
    }

    let passed = limits.iter().filter(|limit| limit.passed).count();
    let total = limits.len();
    let score = if total == 0 {
        0.0
    } else {
        (passed as f64 / total as f64 * 100.0 * 10.0).round() / 10.0
    };
    let grade = if process_model {
        "N/A".to_owned()
    } else if total > 0 && passed == total {
        "A".to_owned()
    } else if total > 0 && passed as f64 / total as f64 >= 0.8 {
        "B".to_owned()
    } else if total > 0 && passed as f64 / total as f64 >= 0.6 {
        "C".to_owned()
    } else {
        "D".to_owned()
    };
    let scorecard = Scorecard {
        grade,
        score,
        passed,
        total,
        limits,
        mass_balance_closed: balance.as_ref().and_then(|balance| balance.closed),
        max_balance_residual_pct: balance
            .as_ref()
            .and_then(|balance| balance.max_residual_pct),
        note: if process_model {
            "Process-only model: no effluent compliance score; data quality and process alarms still apply."
                .to_owned()
        } else {
            "Effluent score = passed limits / checked limits. Missing indicators are excluded, not treated as passed."
                .to_owned()
        },
    };

    ExperimentAnalysis {
        applicability: if process_model {
            "process_only".to_owned()
        } else {
            "effluent_compliance".to_owned()
        },
        scorecard,
        alarms,
        data_quality: quality,
        daily: aggregate(samples, 1440.0, "day"),
        weekly: aggregate(samples, 10080.0, "week"),
        method: "derived from stored samples and mass_balance; no hidden recomputation".to_owned(),
    }
}

struct BalanceView {
    closed: Option<bool>,
    max_residual_pct: Option<f64>,
}

fn balance_view(result: &Value) -> Option<BalanceView> {
    let balance = result
        .get("whole_balance")
        .or_else(|| result.get("mass_balance"))
        .or_else(|| {
            result
                .get("asm2d")
                .and_then(|plant| plant.get("mass_balance"))
        })?;
    let mut closed = None;
    let mut residual_max: Option<f64> = None;
    for key in ["cod", "nitrogen", "phosphorus"] {
        let Some(ledger) = balance.get(key) else {
            continue;
        };
        if let Some(value) = ledger.get("closed").and_then(Value::as_bool) {
            closed = Some(closed.unwrap_or(true) && value);
        }
        let residual = ledger
            .get("residual_fraction")
            .and_then(Value::as_f64)
            .or_else(|| ledger.get("residual").and_then(Value::as_f64));
        if let Some(residual) = residual {
            let pct = residual.abs() * 100.0;
            residual_max = Some(residual_max.map_or(pct, |current| current.max(pct)));
        }
    }
    Some(BalanceView {
        closed,
        max_residual_pct: residual_max,
    })
}

fn metric_value(sample: &Sample, metric: &str) -> Option<f64> {
    match metric {
        "cod" => finite_non_negative(sample.cod),
        "ss" => finite_non_negative(sample.ss),
        "nh4_n" => finite_non_negative(sample.nh4_n),
        "tn" => finite_non_negative(sample.tn),
        "tp" => finite_non_negative(sample.tp),
        "po4_p" => sample.po4_p.and_then(finite_non_negative),
        "do_mg_l" => finite_non_negative(sample.do_mg_l),
        _ => None,
    }
}

fn finite_non_negative(value: f64) -> Option<f64> {
    if value.is_finite() && value >= 0.0 {
        Some(value)
    } else {
        None
    }
}

fn data_quality(samples: &[Sample]) -> DataQuality {
    let mut duplicate_minutes = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for sample in samples {
        if !seen.insert((sample.minute * 1_000.0).round() as i64) {
            duplicate_minutes += 1;
        }
    }
    let finite_sample_count = samples
        .iter()
        .filter(|sample| {
            sample.cod.is_finite()
                && sample.ss.is_finite()
                && sample.nh4_n.is_finite()
                && sample.tn.is_finite()
                && sample.tp.is_finite()
                && sample.do_mg_l.is_finite()
                && sample.flow_m3_h.is_finite()
        })
        .count();
    let mut missing = Vec::new();
    if samples.iter().all(|sample| sample.bod.is_none()) {
        missing.push("bod".to_owned());
    }
    if samples.iter().all(|sample| sample.ph.is_none()) {
        missing.push("ph".to_owned());
    }
    if samples.iter().all(|sample| sample.mlss.is_none()) {
        missing.push("mlss".to_owned());
    }
    if samples.iter().all(|sample| sample.po4_p.is_none()) {
        missing.push("po4_p".to_owned());
    }
    DataQuality {
        sample_count: samples.len(),
        finite_sample_count,
        duplicate_minutes,
        missing_optional_fields: missing,
        note: "Missing optional fields are not treated as zero; duplicate minute keys are counted on read."
            .to_owned(),
    }
}

fn aggregate(samples: &[Sample], period_min: f64, prefix: &str) -> Vec<PeriodSummary> {
    if samples.is_empty() || !period_min.is_finite() || period_min <= 0.0 {
        return Vec::new();
    }
    let mut buckets: std::collections::BTreeMap<i64, Vec<&Sample>> =
        std::collections::BTreeMap::new();
    for sample in samples {
        // A sample exactly on a period boundary belongs to the period that
        // just ended, not to a new one-sample partial bucket.
        let index = if sample.minute > 0.0 && (sample.minute % period_min).abs() < 1.0e-9 {
            ((sample.minute - 1.0e-9) / period_min).floor() as i64
        } else {
            (sample.minute / period_min).floor() as i64
        };
        buckets.entry(index).or_default().push(sample);
    }
    buckets
        .into_iter()
        .map(|(index, rows)| {
            let count = rows.len() as f64;
            let mean = |value: fn(&Sample) -> f64| {
                rows.iter().map(|sample| value(sample)).sum::<f64>() / count
            };
            let mean_opt = |value: fn(&Sample) -> Option<f64>| {
                let values: Vec<f64> = rows
                    .iter()
                    .filter_map(|sample| value(sample))
                    .filter(|v| v.is_finite())
                    .collect();
                if values.is_empty() {
                    None
                } else {
                    Some(values.iter().sum::<f64>() / values.len() as f64)
                }
            };
            PeriodSummary {
                index: (index + 1) as usize,
                period: format!("{prefix}-{}", index + 1),
                start_minute: index as f64 * period_min,
                end_minute: (index + 1) as f64 * period_min,
                sample_count: rows.len(),
                cod_mean: mean(|sample| sample.cod),
                ss_mean: mean(|sample| sample.ss),
                nh4_n_mean: mean(|sample| sample.nh4_n),
                tn_mean: mean(|sample| sample.tn),
                tp_mean: mean(|sample| sample.tp),
                po4_p_mean: mean_opt(|sample| sample.po4_p),
                do_min: rows
                    .iter()
                    .map(|sample| sample.do_mg_l)
                    .reduce(f64::min)
                    .unwrap_or(0.0),
                do_mean: mean(|sample| sample.do_mg_l),
                flow_mean: mean(|sample| sample.flow_m3_h),
                energy_kw_mean: mean_opt(|sample| sample.energy_kw),
            }
        })
        .collect()
}

pub fn daily_csv(analysis: &ExperimentAnalysis) -> String {
    period_csv(&analysis.daily)
}

pub fn weekly_csv(analysis: &ExperimentAnalysis) -> String {
    period_csv(&analysis.weekly)
}

fn period_csv(periods: &[PeriodSummary]) -> String {
    let mut text = String::from(
        "period,start_minute,end_minute,samples,cod_mean,ss_mean,nh4_n_mean,tn_mean,tp_mean,po4_p_mean,do_min,do_mean,flow_mean,energy_kw_mean\n",
    );
    for period in periods {
        text.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            period.period,
            period.start_minute,
            period.end_minute,
            period.sample_count,
            period.cod_mean,
            period.ss_mean,
            period.nh4_n_mean,
            period.tn_mean,
            period.tp_mean,
            period
                .po4_p_mean
                .map_or_else(String::new, |value| value.to_string()),
            period.do_min,
            period.do_mean,
            period.flow_mean,
            period
                .energy_kw_mean
                .map_or_else(String::new, |value| value.to_string()),
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(minute: f64) -> Sample {
        Sample {
            minute,
            flow_m3_h: 1000.0,
            cod: 32.0,
            bod: None,
            ss: 1.0,
            nh4_n: 0.7,
            tn: 9.2,
            tp: 0.15,
            po4_p: Some(0.05),
            ph: None,
            temperature_c: Some(20.0),
            do_mg_l: 2.0,
            mlss: None,
            srt_d: None,
            energy_kw: None,
            score: None,
            blanket_depth_m: None,
        }
    }

    #[test]
    fn scorecard_marks_short_term_open_balance_without_hiding_it() {
        let result = serde_json::json!({
            "whole_balance": {
                "cod": {"residual": 0.021, "closed": true},
                "nitrogen": {"residual": 0.30, "closed": false},
                "phosphorus": {"residual": 0.46, "closed": false}
            }
        });
        let analysis = analyze_parts("asm2d", &result, &[sample(60.0), sample(120.0)]);
        assert_eq!(analysis.scorecard.grade, "A");
        assert_eq!(analysis.scorecard.max_balance_residual_pct, Some(46.0));
        assert!(analysis
            .alarms
            .iter()
            .any(|alarm| alarm.code == "MASS_BALANCE_OPEN"));
        assert!(!analysis
            .alarms
            .iter()
            .any(|alarm| alarm.code == "SPARSE_SAMPLES"));
    }

    #[test]
    fn failed_limit_creates_alarm_and_lowers_grade() {
        let mut high = sample(60.0);
        high.cod = 80.0;
        let analysis = analyze_parts("asm2d", &serde_json::Value::Null, &[sample(0.0), high]);
        assert_eq!(analysis.scorecard.grade, "B");
        assert!(analysis
            .alarms
            .iter()
            .any(|alarm| alarm.code == "EFFLUENT_COD_HIGH"));
        assert_eq!(analysis.data_quality.sample_count, 2);
    }

    #[test]
    fn daily_and_weekly_buckets_are_deterministic() {
        let analysis = analyze_parts(
            "asm2d",
            &serde_json::Value::Null,
            &[sample(60.0), sample(1500.0), sample(2000.0)],
        );
        assert_eq!(analysis.daily.len(), 2);
        assert_eq!(analysis.weekly.len(), 1);
        assert_eq!(analysis.daily[0].period, "day-1");
        assert!(daily_csv(&analysis).contains("day-1"));
        assert!(weekly_csv(&analysis).contains("week-1"));
    }

    #[test]
    fn negative_concentration_is_not_a_pass() {
        let mut negative = sample(60.0);
        negative.cod = -1.0;
        let analysis = analyze_parts("asm2d", &serde_json::Value::Null, &[negative]);
        assert!(!analysis.scorecard.limits[0].passed);
        assert!(analysis.scorecard.limits[0].value.is_none());
    }

    #[test]
    fn asm1_does_not_score_unmodelled_phosphorus() {
        let analysis = analyze_parts("asm1", &serde_json::Value::Null, &[sample(60.0)]);
        assert_eq!(analysis.scorecard.total, 4);
        assert!(!analysis
            .scorecard
            .limits
            .iter()
            .any(|limit| limit.metric == "tp"));
    }

    #[test]
    fn process_models_are_not_given_an_effluent_grade() {
        let analysis = analyze_parts("adm1", &serde_json::Value::Null, &[sample(1440.0)]);
        assert_eq!(analysis.applicability, "process_only");
        assert_eq!(analysis.scorecard.grade, "N/A");
    }
}

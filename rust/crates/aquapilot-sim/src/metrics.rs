//! Pure effluent metrics, ported from `src/sim/metrics.ts`.

use serde::Deserialize;

use crate::output::{Effluent, EffluentLimits};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffluentMetric {
    Cod,
    Bod,
    Ss,
    Nh,
    Tn,
    Tp,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginRow {
    pub key: EffluentMetric,
    pub metric: String,
    pub ratio: f64,
    pub value: f64,
    pub limit: f64,
    pub finite: bool,
}

/// Same clamp as `metrics.ts`: a non-finite control value falls back to min.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    js_min(max, js_max(min, value))
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_round(value: f64) -> f64 {
    // Math.round rounds .5 toward +infinity, unlike f64::round for negatives.
    if value.is_finite() {
        (value + 0.5).floor()
    } else {
        value
    }
}

pub const EFFLUENT_METRICS: [(&str, &str); 6] = [
    ("cod", "COD"),
    ("bod", "BOD₅"),
    ("ss", "SS"),
    ("nh", "NH₃-N"),
    ("tn", "TN"),
    ("tp", "TP"),
];

fn value_of(e: &Effluent, key: &str) -> f64 {
    match key {
        "cod" => e.cod,
        "bod" => e.bod,
        "ss" => e.ss,
        "nh" => e.nh,
        "tn" => e.tn,
        "tp" => e.tp,
        _ => unreachable!("unknown effluent metric"),
    }
}

fn limit_of(limits: &EffluentLimits, key: &str) -> f64 {
    match key {
        "cod" => limits.cod,
        "bod" => limits.bod,
        "ss" => limits.ss,
        "nh" => limits.nh,
        "tn" => limits.tn,
        "tp" => limits.tp,
        _ => unreachable!("unknown effluent metric"),
    }
}

fn metric_of(key: &str) -> EffluentMetric {
    match key {
        "cod" => EffluentMetric::Cod,
        "bod" => EffluentMetric::Bod,
        "ss" => EffluentMetric::Ss,
        "nh" => EffluentMetric::Nh,
        "tn" => EffluentMetric::Tn,
        "tp" => EffluentMetric::Tp,
        _ => unreachable!("unknown effluent metric"),
    }
}

/// `effluentMarginRows`: ratio is +inf for non-finite / negative readings.
pub fn effluent_margin_rows(e: &Effluent, limits: &EffluentLimits) -> Vec<MarginRow> {
    EFFLUENT_METRICS
        .iter()
        .map(|(key, metric)| {
            let value = value_of(e, key);
            let limit = limit_of(limits, key);
            let finite = value.is_finite() && value >= 0.0;
            MarginRow {
                key: metric_of(key),
                metric: (*metric).to_string(),
                ratio: if finite { value / limit } else { f64::INFINITY },
                value: if value.is_finite() { value } else { 0.0 },
                limit,
                finite,
            }
        })
        .collect()
}

pub fn worst_ratio(e: &Effluent, limits: &EffluentLimits) -> f64 {
    effluent_margin_rows(e, limits)
        .iter()
        .map(|row| row.ratio)
        .fold(f64::NEG_INFINITY, |a, b| if b > a { b } else { a })
}

/// `estimateMargin`: sorted by ratio descending, stable for equal ratios.
pub fn estimate_margin(e: &Effluent, limits: &EffluentLimits) -> Vec<MarginRow> {
    let mut rows = effluent_margin_rows(e, limits);
    rows.sort_by(|a, b| b.ratio.total_cmp(&a.ratio));
    rows
}

/// `qualityScore`: 0–100, worst-ratio overage punished hardest.
pub fn quality_score(e: &Effluent, limits: &EffluentLimits) -> u32 {
    let rows = effluent_margin_rows(e, limits);
    let worst = rows
        .iter()
        .map(|row| row.ratio)
        .fold(f64::NEG_INFINITY, |a, b| if b > a { b } else { a });
    let mean = rows.iter().map(|row| row.ratio).sum::<f64>() / rows.len() as f64;
    let raw = 100.0 - js_max(0.0, worst - 0.5) * 100.0 - js_max(0.0, mean - 0.45) * 40.0;
    js_round(clamp(raw, 0.0, 100.0)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effluent(cod: f64, nh: f64) -> Effluent {
        Effluent {
            flow: 2000.0,
            cod,
            bod: 5.0,
            ss: 5.0,
            nh,
            tn: 10.0,
            tp: 0.2,
            ph: 7.0,
            temperature: 20.0,
        }
    }

    #[test]
    fn clamp_non_finite_to_min() {
        assert_eq!(clamp(f64::NAN, 1.0, 2.0), 1.0);
        assert_eq!(clamp(-1.0, 0.0, 2.0), 0.0);
        assert_eq!(clamp(3.0, 0.0, 2.0), 2.0);
    }

    #[test]
    fn score_penalizes_even_a_clean_effluent_worst_margin() {
        assert_eq!(
            quality_score(&effluent(10.0, 1.0), &EffluentLimits::default()),
            83
        );
    }
}

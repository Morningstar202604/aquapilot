use std::collections::BTreeMap;

use aquapilot_sim::{
    Controls, Influent, InfluentContext, ScenarioSpec, aeration_capacity, derive_influent, diurnal,
    mixed, recycle_factors, scenario_envelope, seasonal_temperature, toxic_suppression,
};
use serde::Deserialize;

const GOLDEN: &str = include_str!("../../../golden/sim-forcing.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    schema_version: u32,
    generated_by: String,
    oracle: String,
    note: String,
    sources: BTreeMap<String, String>,
    counts: Counts,
    forcing: Vec<ForcingCase>,
    recycle: Vec<RecycleCase>,
    influent: Vec<InfluentCase>,
}

#[derive(Debug, Deserialize)]
struct Counts {
    forcing: usize,
    recycle: usize,
    influent: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForcingCase {
    time_min: f64,
    scenario: ScenarioSpec,
    diurnal: f64,
    seasonal_temperature: f64,
    scenario_envelope: f64,
    toxic_suppression: f64,
    aeration_capacity: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecycleCase {
    time_min: f64,
    control: Controls,
    scenario: ScenarioSpec,
    expected: RecycleExpected,
}

#[derive(Debug, Deserialize)]
struct RecycleExpected {
    ras: f64,
    ir: f64,
    was: f64,
}

#[derive(Debug, Deserialize)]
struct InfluentCase {
    context: InfluentContext,
    expected: Influent,
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 1e-12,
        "{label}: rust={actual:.17} ts={expected:.17} delta={:.3e}",
        (actual - expected).abs()
    );
}

fn assert_influent_close(actual: &Influent, expected: &Influent, index: usize) {
    let fields = [
        ("flow", actual.flow, expected.flow),
        ("cod", actual.cod, expected.cod),
        ("bod", actual.bod, expected.bod),
        ("nh", actual.nh, expected.nh),
        ("tn", actual.tn, expected.tn),
        ("tp", actual.tp, expected.tp),
        ("ss", actual.ss, expected.ss),
        ("temperature", actual.temperature, expected.temperature),
        ("alkalinity", actual.alkalinity, expected.alkalinity),
    ];
    for (name, got, want) in fields {
        assert_close(got, want, &format!("influent[{index}].{name}"));
    }
}

#[test]
fn golden_header_and_counts_are_frozen() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    assert_eq!(golden.schema_version, 1);
    assert_eq!(golden.generated_by, "scripts/gen-sim-forcing.ts");
    assert!(golden.oracle.contains("forcing.ts"));
    assert!(golden.note.contains("Not a whole-plant step parity"));
    assert_eq!(golden.counts.forcing, 112);
    assert_eq!(golden.counts.recycle, 96);
    assert_eq!(golden.counts.influent, 1098);
    assert_eq!(golden.forcing.len(), 112);
    assert_eq!(golden.recycle.len(), 96);
    assert_eq!(golden.influent.len(), 1098);
    assert_eq!(golden.sources.len(), 7);
    for (path, hash) in &golden.sources {
        assert!(path.starts_with("src/sim/"), "unexpected source {path}");
        assert_eq!(hash.len(), 64, "{path} hash must be sha256");
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }
}

#[test]
fn forcing_matrix_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for case in &golden.forcing {
        let spec = Some(&case.scenario);
        assert_close(diurnal(case.time_min), case.diurnal, "diurnal");
        assert_close(
            seasonal_temperature(case.time_min),
            case.seasonal_temperature,
            "seasonalTemperature",
        );
        assert_close(
            scenario_envelope(spec, case.time_min),
            case.scenario_envelope,
            "scenarioEnvelope",
        );
        assert_close(
            toxic_suppression(spec, case.time_min),
            case.toxic_suppression,
            "toxicSuppression",
        );
        assert_close(
            aeration_capacity(spec, case.time_min),
            case.aeration_capacity,
            "aerationCapacity",
        );
    }
}

#[test]
fn recycle_matrix_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for case in &golden.recycle {
        let got = recycle_factors(&case.control, Some(&case.scenario), case.time_min);
        assert_close(got.ras, case.expected.ras, "recycle.ras");
        assert_close(got.ir, case.expected.ir, "recycle.ir");
        assert_close(got.was, case.expected.was, "recycle.was");
    }
}

#[test]
fn influent_matrix_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (index, case) in golden.influent.iter().enumerate() {
        let got = derive_influent(&case.context);
        assert_influent_close(&got, &case.expected, index);
    }
}

#[test]
fn mixed_uses_left_concentration_when_both_flows_are_zero() {
    assert_eq!(mixed(12.0, 0.0, 30.0, 0.0), 12.0);
    assert_eq!(mixed(12.0, 1.0, 30.0, 1.0), 21.0);
}

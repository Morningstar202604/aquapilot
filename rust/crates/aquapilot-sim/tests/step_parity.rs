//! Phase 1 + alarm-history parity against the TypeScript oracle.

use std::collections::BTreeMap;

use aquapilot_sim::{
    Alarm, AlarmLedger, HydraulicInput, InfluentContext, Severity, derive_influent,
    resolve_hydraulics,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepGolden {
    schema: String,
    generated_by: String,
    oracle: String,
    note: String,
    sources: BTreeMap<String, String>,
    hydraulics: Vec<HydraulicCase>,
    alarms: Vec<AlarmCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HydraulicCase {
    name: String,
    seed: f64,
    rng_count: f64,
    time_min: f64,
    dt_h: f64,
    storm_storage_m3: f64,
    storm_store: f64,
    scenario: Option<aquapilot_sim::ScenarioSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HydraulicOutput {
    influent: aquapilot_sim::Influent,
    q: f64,
    storm_storage_m3: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlarmCase {
    name: String,
    initial_seq: u32,
    pushes: Vec<AlarmPush>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlarmPush {
    at: f64,
    code: String,
    severity: Severity,
    message: String,
    metric: String,
    value: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlarmOutput {
    alarms: Vec<Alarm>,
    alarm_seq: u32,
}

fn golden() -> StepGolden {
    let raw = include_str!("../../../golden/sim-step.json");
    serde_json::from_str(raw).expect("sim-step golden must parse")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * 1f64.max(a.abs()).max(b.abs())
}

#[test]
fn header_and_case_counts_are_locked() {
    let g = golden();
    assert_eq!(g.schema, "aquapilot.sim.step.v1");
    assert_eq!(g.generated_by, "scripts/gen-sim-step.ts");
    assert_eq!(g.oracle, "resolveHydraulics + pushAlarm");
    assert!(!g.note.is_empty());
    assert_eq!(g.hydraulics.len(), 10);
    assert_eq!(g.alarms.len(), 7);
}

#[test]
fn source_hashes_match_the_ts_oracle() {
    let g = golden();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for (path, expected) in &g.sources {
        let actual = sha256_file(&root.join(path));
        assert_eq!(&actual, expected, "source hash drift for {path}");
    }
}

#[test]
fn hydraulics_matches_ts_for_every_case() {
    let g = golden();
    let raw = include_str!("../../../golden/sim-step.json");
    let value: serde_json::Value = serde_json::from_str(raw).unwrap();
    for (case, expected_value) in g
        .hydraulics
        .iter()
        .zip(value["hydraulics"].as_array().unwrap())
    {
        let expected: HydraulicOutput =
            serde_json::from_value(expected_value["output"].clone()).unwrap();
        let ctx = InfluentContext {
            time_min: case.time_min,
            seed: case.seed,
            rng_count: case.rng_count,
            scenario: case.scenario.clone(),
            uncertainty: None,
            influent_series: None,
        };
        let influent = derive_influent(&ctx);
        let input = HydraulicInput {
            influent,
            storm_storage_m3: case.storm_storage_m3,
            storm_store: case.storm_store,
            scenario: case.scenario.clone(),
            time_min: case.time_min,
            dt_h: case.dt_h,
        };
        let actual = resolve_hydraulics(&input);
        assert!(close(actual.q, expected.q), "q drift in {}", case.name);
        assert!(
            close(actual.storm_storage_m3, expected.storm_storage_m3),
            "storage drift in {}",
            case.name
        );
        let fields = [
            ("flow", actual.influent.flow, expected.influent.flow),
            ("cod", actual.influent.cod, expected.influent.cod),
            ("bod", actual.influent.bod, expected.influent.bod),
            ("nh", actual.influent.nh, expected.influent.nh),
            ("tn", actual.influent.tn, expected.influent.tn),
            ("tp", actual.influent.tp, expected.influent.tp),
            ("ss", actual.influent.ss, expected.influent.ss),
            (
                "temperature",
                actual.influent.temperature,
                expected.influent.temperature,
            ),
            (
                "alkalinity",
                actual.influent.alkalinity,
                expected.influent.alkalinity,
            ),
        ];
        for (field, a, b) in fields {
            assert!(close(a, b), "{field} drift in {}", case.name);
        }
    }
}

#[test]
fn alarm_ledger_matches_ts_for_every_case() {
    let g = golden();
    let raw = include_str!("../../../golden/sim-step.json");
    let value: serde_json::Value = serde_json::from_str(raw).unwrap();
    for (case, expected_value) in g.alarms.iter().zip(value["alarms"].as_array().unwrap()) {
        let expected: AlarmOutput =
            serde_json::from_value(expected_value["output"].clone()).unwrap();
        let mut ledger = AlarmLedger {
            alarm_seq: case.initial_seq,
            ..AlarmLedger::default()
        };
        for push in &case.pushes {
            ledger.push(
                push.at,
                push.severity,
                &push.code,
                push.message.clone(),
                push.metric.clone(),
                push.value,
            );
        }
        assert_eq!(
            ledger.alarm_seq, expected.alarm_seq,
            "seq drift in {}",
            case.name
        );
        assert_eq!(
            ledger.alarms.len(),
            expected.alarms.len(),
            "len drift in {}",
            case.name
        );
        for (actual, expected) in ledger.alarms.iter().zip(&expected.alarms) {
            assert_eq!(actual.id, expected.id, "id drift in {}", case.name);
            assert_eq!(actual.at, expected.at, "at drift in {}", case.name);
            assert_eq!(
                actual.severity, expected.severity,
                "severity drift in {}",
                case.name
            );
            assert_eq!(actual.code, expected.code, "code drift in {}", case.name);
            assert_eq!(
                actual.message, expected.message,
                "message drift in {}",
                case.name
            );
            assert_eq!(
                actual.metric, expected.metric,
                "metric drift in {}",
                case.name
            );
            assert!(
                close(actual.value, expected.value),
                "value drift in {}",
                case.name
            );
        }
    }
}

fn sha256_file(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).unwrap());
    format!("{:x}", hasher.finalize())
}

//! Phase 2 slice parity: `aggregateInflow` against the TS oracle.

use std::collections::{BTreeMap, HashMap};

use aquapilot_sim::{IncomingEdge, Influent, ReactorComposition, aggregate_inflow};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InflowGolden {
    schema: String,
    generated_by: String,
    oracle: String,
    note: String,
    sources: BTreeMap<String, String>,
    cases: Vec<InflowCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InflowCase {
    name: String,
    edges: Vec<IncomingEdge>,
    flows: HashMap<String, f64>,
    reactors: HashMap<String, ReactorComposition>,
    last_reactor: Option<ReactorComposition>,
    influent: Influent,
    output: InflowCompositionGolden,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InflowCompositionGolden {
    q_in: f64,
    cod_in: f64,
    nh_in: f64,
    no3_in: f64,
    tp_in: f64,
    alk_in: f64,
}

fn golden() -> InflowGolden {
    let raw = include_str!("../../../golden/sim-inflow.json");
    serde_json::from_str(raw).expect("sim-inflow golden must parse")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * 1f64.max(a.abs()).max(b.abs())
}

#[test]
fn header_and_case_counts_are_locked() {
    let g = golden();
    assert_eq!(g.schema, "aquapilot.sim.inflow.v1");
    assert_eq!(g.generated_by, "scripts/gen-sim-inflow.ts");
    assert_eq!(g.oracle, "aggregateInflow");
    assert!(!g.note.is_empty());
    assert_eq!(g.cases.len(), 12);
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
fn aggregate_inflow_matches_ts_for_every_case() {
    let g = golden();
    for case in &g.cases {
        let actual = aggregate_inflow(
            &case.edges,
            &case.flows,
            &case.reactors,
            case.last_reactor.as_ref(),
            &case.influent,
        );
        assert!(
            close(actual.q_in, case.output.q_in),
            "q_in drift in {}",
            case.name
        );
        assert!(
            close(actual.cod_in, case.output.cod_in),
            "cod drift in {}",
            case.name
        );
        assert!(
            close(actual.nh_in, case.output.nh_in),
            "nh drift in {}",
            case.name
        );
        assert!(
            close(actual.no3_in, case.output.no3_in),
            "no3 drift in {}",
            case.name
        );
        assert!(
            close(actual.tp_in, case.output.tp_in),
            "tp drift in {}",
            case.name
        );
        assert!(
            close(actual.alk_in, case.output.alk_in),
            "alk drift in {}",
            case.name
        );
    }
}

fn sha256_file(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).unwrap());
    format!("{:x}", hasher.finalize())
}

//! Phase 2 ASM1 mixing parity against the TS oracle.

use std::collections::{BTreeMap, HashMap};

use aquapilot_sim::{
    Asm1State, IncomingEdge, Influent, aggregate_asm1_inflow, influent_to_asm1, to_asm1,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    schema: String,
    generated_by: String,
    oracle: String,
    note: String,
    sources: BTreeMap<String, String>,
    mappings: Vec<MappingCase>,
    influent_mappings: Vec<InfluentMappingCase>,
    inflow: Vec<InflowCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MappingCase {
    name: String,
    input: MappingInput,
    output: [f64; 13],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MappingInput {
    cod: f64,
    nh: f64,
    no3: f64,
    do_level: f64,
    alkalinity: f64,
    mlss: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InfluentMappingCase {
    name: String,
    influent: Influent,
    output: [f64; 13],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InflowCase {
    name: String,
    edges: Vec<IncomingEdge>,
    flows: HashMap<String, f64>,
    reactors: HashMap<String, [f64; 13]>,
    last_asm1: Option<[f64; 13]>,
    x_ras: f64,
    influent: Influent,
    output: [f64; 13],
}

fn golden() -> Golden {
    let raw = include_str!("../../../golden/sim-asm1-inflow.json");
    serde_json::from_str(raw).expect("sim-asm1-inflow golden must parse")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * 1f64.max(a.abs()).max(b.abs())
}

fn assert_state(actual: &Asm1State, expected: &[f64; 13], label: &str) {
    for (i, (a, b)) in actual.values.iter().zip(expected).enumerate() {
        assert!(close(*a, *b), "component {i} drift in {label}: {a} != {b}");
    }
}

#[test]
fn header_and_counts_are_locked() {
    let g = golden();
    assert_eq!(g.schema, "aquapilot.sim.asm1-inflow.v1");
    assert_eq!(g.generated_by, "scripts/gen-sim-asm1-inflow.ts");
    assert_eq!(g.oracle, "toAsm1 + influentToAsm1 + aggregateAsm1Inflow");
    assert!(!g.note.is_empty());
    assert_eq!(g.mappings.len(), 8);
    assert_eq!(g.influent_mappings.len(), 2);
    assert_eq!(g.inflow.len(), 12);
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
fn to_asm1_matches_ts_for_every_mapping_case() {
    let g = golden();
    for case in &g.mappings {
        let actual = to_asm1(
            case.input.cod,
            case.input.nh,
            case.input.no3,
            case.input.do_level,
            case.input.alkalinity,
            case.input.mlss,
        );
        assert_state(&actual, &case.output, &case.name);
    }
}

#[test]
fn influent_to_asm1_matches_ts() {
    let g = golden();
    for case in &g.influent_mappings {
        let actual = influent_to_asm1(&case.influent);
        assert_state(&actual, &case.output, &case.name);
    }
}

#[test]
fn aggregate_asm1_inflow_matches_ts_for_every_case() {
    let g = golden();
    for case in &g.inflow {
        let reactors: HashMap<String, Asm1State> = case
            .reactors
            .iter()
            .map(|(id, values)| (id.clone(), Asm1State::from_values(*values)))
            .collect();
        let last = case.last_asm1.map(Asm1State::from_values);
        let actual = aggregate_asm1_inflow(
            &case.edges,
            &case.flows,
            &reactors,
            last.as_ref(),
            case.x_ras,
            &case.influent,
        );
        assert_state(&actual, &case.output, &case.name);
    }
}

fn sha256_file(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).unwrap());
    format!("{:x}", hasher.finalize())
}

//! Phase 2 simple-reactor parity against `solveReactors` (simple branch).

use std::collections::{BTreeMap, HashMap};

use aquapilot_sim::{
    IncomingEdge, Influent, ReactorFlux, ReactorKind, SimpleReactorState, SimpleReactorsInput,
    solve_reactors_simple,
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
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    reactors: Vec<ReactorSpec>,
    order: Vec<String>,
    edges: Vec<EdgeSpec>,
    flows: HashMap<String, f64>,
    influent: Influent,
    bf: f64,
    dt_h: f64,
    carbon_dose: f64,
    alk_dose: f64,
    do_setpoint: f64,
    aeration_capacity: f64,
    suppression: f64,
    output: Output,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactorSpec {
    id: String,
    kind: ReactorKind,
    volume: f64,
    cod: f64,
    nh: f64,
    no3: f64,
    tp: f64,
    do_level: f64,
    alkalinity: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EdgeSpec {
    id: String,
    from: String,
    to: String,
    #[serde(default)]
    recycle_kind: Option<aquapilot_sim::RecycleKind>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    reactors: Vec<OutputReactor>,
    flux: ReactorFlux,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputReactor {
    id: String,
    cod: f64,
    nh: f64,
    no3: f64,
    tp: f64,
    do_level: f64,
    alkalinity: f64,
    temperature: f64,
    o2_demand: f64,
    kla: f64,
    inflow: f64,
}

fn golden() -> Golden {
    let raw = include_str!("../../../golden/sim-react-simple.json");
    serde_json::from_str(raw).expect("sim-react-simple golden must parse")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * 1f64.max(a.abs()).max(b.abs())
}

#[test]
fn header_and_counts_are_locked() {
    let g = golden();
    assert_eq!(g.schema, "aquapilot.sim.react-simple.v1");
    assert_eq!(g.generated_by, "scripts/gen-sim-react-simple.ts");
    assert_eq!(g.oracle, "solveReactors (simple branch)");
    assert!(!g.note.is_empty());
    assert_eq!(g.cases.len(), 13);
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
fn every_simple_reactor_case_matches_ts() {
    let g = golden();
    for case in &g.cases {
        let mut incoming_by_reactor: HashMap<String, Vec<IncomingEdge>> = HashMap::new();
        for edge in &case.edges {
            incoming_by_reactor
                .entry(edge.to.clone())
                .or_default()
                .push(IncomingEdge {
                    id: edge.id.clone(),
                    from: edge.from.clone(),
                    recycle_kind: edge.recycle_kind,
                });
        }
        let reactors: Vec<SimpleReactorState> = case
            .reactors
            .iter()
            .map(|r| SimpleReactorState {
                id: r.id.clone(),
                kind: r.kind,
                volume: r.volume,
                cod: r.cod,
                nh: r.nh,
                no3: r.no3,
                tp: r.tp,
                do_level: r.do_level,
                alkalinity: r.alkalinity,
                temperature: 20.0,
                o2_demand: 0.0,
                kla: 0.0,
                inflow: 0.0,
            })
            .collect();
        let temperature = case.influent.temperature;
        let mut input = SimpleReactorsInput {
            reactors,
            order: case.order.clone(),
            incoming_by_reactor,
            edge_flow: case.flows.clone(),
            influent: case.influent,
            dt_h: case.dt_h,
            bf: case.bf,
            temperature_c: temperature,
            theta_h: 1.045_f64.powf(temperature - 20.0),
            theta_n: 1.08_f64.powf(temperature - 20.0),
            suppression: case.suppression,
            carbon_dose: case.carbon_dose,
            alk_dose: case.alk_dose,
            do_setpoint: case.do_setpoint,
            aeration_capacity: case.aeration_capacity,
        };
        let flux = solve_reactors_simple(&mut input);
        assert_eq!(
            input.reactors.len(),
            case.output.reactors.len(),
            "reactor count {}",
            case.name
        );
        for (actual, expected) in input.reactors.iter().zip(&case.output.reactors) {
            assert_eq!(actual.id, expected.id, "id {}", case.name);
            let fields = [
                ("cod", actual.cod, expected.cod),
                ("nh", actual.nh, expected.nh),
                ("no3", actual.no3, expected.no3),
                ("tp", actual.tp, expected.tp),
                ("doLevel", actual.do_level, expected.do_level),
                ("alkalinity", actual.alkalinity, expected.alkalinity),
                ("temperature", actual.temperature, expected.temperature),
                ("o2Demand", actual.o2_demand, expected.o2_demand),
                ("kla", actual.kla, expected.kla),
                ("inflow", actual.inflow, expected.inflow),
            ];
            for (name, a, b) in fields {
                assert!(close(a, b), "{name} drift in {} / {}", case.name, actual.id);
            }
        }
        let flux_fields = [
            (
                "o2DemandKgH",
                flux.o2_demand_kg_h,
                case.output.flux.o2_demand_kg_h,
            ),
            (
                "codOxidizedKgH",
                flux.cod_oxidized_kg_h,
                case.output.flux.cod_oxidized_kg_h,
            ),
            (
                "balancedOxidizedKgH",
                flux.balanced_oxidized_kg_h,
                case.output.flux.balanced_oxidized_kg_h,
            ),
            (
                "o2TransferredKgH",
                flux.o2_transferred_kg_h,
                case.output.flux.o2_transferred_kg_h,
            ),
            (
                "nhOxidizedKgH",
                flux.nh_oxidized_kg_h,
                case.output.flux.nh_oxidized_kg_h,
            ),
            (
                "denitrifiedNKgH",
                flux.denitrified_n_kg_h,
                case.output.flux.denitrified_n_kg_h,
            ),
        ];
        for (name, a, b) in flux_fields {
            assert!(close(a, b), "{name} drift in {}", case.name);
        }
    }
}

fn sha256_file(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).unwrap());
    format!("{:x}", hasher.finalize())
}

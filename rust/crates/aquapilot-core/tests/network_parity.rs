//! Network-level ASM2d parity against the TypeScript engine.
//!
//! Golden corpus: `rust/golden/asm2d-network-48h.json` — 5 reactors, 48 h,
//! 0.5 h steps, external feed 1546 m3/h, RAS 454 m3/h, 3000/4500/5750 m3.
//! The fixture's edge flow table is explicit; the missing `flow` bug that
//! previously made RAS inert is covered by the X_I trajectory.
use aquapilot_core::asm2d::{Params, State};
use aquapilot_core::network::{
    Edge, Influent, Network, Reactor, ReactorKind, Recycle, StepOptions,
};
use serde_json::Value;
use std::fs;

const COMPONENT_KEYS: [&str; 19] = [
    "S_O", "S_F", "S_A", "S_I", "S_NH4", "S_N2", "S_NO3", "S_PO4", "S_ALK", "X_I", "X_S", "X_H",
    "X_PAO", "X_PP", "X_PHA", "X_AUT", "X_TSS", "X_MEOH", "X_MEP",
];

fn load_matrix(key: &str) -> [[f64; 19]; 5] {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../golden/asm2d-network-48h.json"
    ))
    .expect("network golden");
    let golden: Value = serde_json::from_str(&raw).expect("parse network golden");
    let rows = golden[key].as_array().expect("golden rows");
    let mut out = [[0.0; 19]; 5];
    for (i, row) in rows.iter().enumerate() {
        for (j, name) in COMPONENT_KEYS.iter().enumerate() {
            out[i][j] = row[name].as_f64().expect("component value");
        }
    }
    out
}

fn state(row: [f64; 19]) -> State {
    State { v: row }
}

#[test]
fn network_48h_matches_ts_golden() {
    let initial = load_matrix("initial");
    let expected_final = load_matrix("final");
    let reactors = vec![
        Reactor {
            id: "anaerobic".into(),
            kind: ReactorKind::Anaerobic,
            volume: 3000.0,
            state: state(initial[0]),
            kla: 0.0,
            integral: 0.0,
            o2_demand: 0.0,
        },
        Reactor {
            id: "anoxic".into(),
            kind: ReactorKind::Anoxic,
            volume: 4500.0,
            state: state(initial[1]),
            kla: 0.0,
            integral: 0.0,
            o2_demand: 0.0,
        },
        Reactor {
            id: "aerobic1".into(),
            kind: ReactorKind::Aerobic,
            volume: 5750.0,
            state: state(initial[2]),
            kla: 0.0,
            integral: 0.0,
            o2_demand: 0.0,
        },
        Reactor {
            id: "aerobic2".into(),
            kind: ReactorKind::Aerobic,
            volume: 5750.0,
            state: state(initial[3]),
            kla: 0.0,
            integral: 0.0,
            o2_demand: 0.0,
        },
        Reactor {
            id: "aerobic3".into(),
            kind: ReactorKind::Aerobic,
            volume: 5750.0,
            state: state(initial[4]),
            kla: 0.0,
            integral: 0.0,
            o2_demand: 0.0,
        },
    ];
    let edges = vec![
        Edge {
            from: None,
            to: 0,
            flow: 1546.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(4),
            to: 0,
            flow: 454.0,
            recycle: Recycle::Ras,
        },
        Edge {
            from: Some(0),
            to: 1,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(1),
            to: 2,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(2),
            to: 3,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(3),
            to: 4,
            flow: 2000.0,
            recycle: Recycle::None,
        },
    ];
    let mut net = Network::new(reactors, edges);
    let inf = Influent {
        flow: 1546.0,
        cod: 312.0,
        nh: 31.5,
        tn: 44.0,
        tp: 4.6,
        ss: 184.0,
        alkalinity: 8.0,
    };
    let opts = StepOptions {
        dt_h: 0.5,
        temperature_c: 20.0,
        bio_p: true,
        suppression: 1.0,
        do_setpoint: 2.0,
        aeration_capacity: 0.976,
        ras_p_exact: None,
        carbon_dose: 0.0,
    };
    for _ in 0..48 {
        net.step(inf, 4428.0, &Params::default(), opts);
    }
    for (i, reactor) in net.reactors.iter().enumerate() {
        for (c, (got, want)) in reactor
            .state
            .v
            .iter()
            .zip(expected_final[i].iter())
            .enumerate()
        {
            assert!(
                (got - want).abs() <= 1e-9,
                "reactor {i} component {c}: got {got}, want {want}"
            );
        }
    }
}

use aquapilot_core::asm2d::{Component, CstrOptions, Params, State, step_cstr};
use serde_json::Value;
use std::fs;

fn influent() -> State {
    let mut s = State::zero();
    for (c, v) in [
        (Component::SA, 60.0),
        (Component::SF, 30.0),
        (Component::SPO4, 5.0),
        (Component::SNH4, 30.0),
        (Component::SNO3, 0.1),
        (Component::XH, 2000.0),
        (Component::XPAO, 300.0),
        (Component::XAUT, 80.0),
        (Component::XPP, 300.0),
        (Component::XPHA, 50.0),
        (Component::SAlk, 8.0),
    ] {
        s.set(c, v);
    }
    s
}

fn load_expected(name: &str) -> Vec<f64> {
    let path = format!("{}/../../golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&fs::read_to_string(&path).expect("golden file"))
        .expect("parse golden");
    serde_json::from_value(golden["expected"].clone()).expect("expected array")
}

#[test]
fn cstr_24h_matches_ts_golden_exactly() {
    let inf = influent();
    let mut state = inf;
    state.set(Component::SO, 0.0);
    state.set(Component::SNO3, 0.0);
    for _ in 0..24 {
        state = step_cstr(
            &state,
            &inf,
            &Params::default(),
            CstrOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 1.0,
                temperature_c: 20.0,
            },
        );
    }
    let expected = load_expected("asm2d-cstr-24h.json");
    for (i, want) in expected.iter().enumerate() {
        let got = state.v[i];
        assert!(
            (got - want).abs() <= 1e-12,
            "component {} got {got} want {want}",
            i
        );
    }
}

#[test]
fn cstr_aerobic_30h_matches_ts_golden_exactly() {
    let inf = influent();
    let mut state = inf;
    state.set(Component::SO, 0.0);
    state.set(Component::SNO3, 0.0);
    for _ in 0..24 {
        state = step_cstr(
            &state,
            &inf,
            &Params::default(),
            CstrOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 1.0,
                temperature_c: 20.0,
            },
        );
    }
    state.set(Component::SO, 2.0);
    state.set(Component::SNO3, 0.1);
    for _ in 0..6 {
        state = step_cstr(
            &state,
            &inf,
            &Params::default(),
            CstrOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 1.0,
                temperature_c: 20.0,
            },
        );
    }
    let expected = load_expected("asm2d-cstr-aerobic-30h.json");
    for (i, want) in expected.iter().enumerate() {
        let got = state.v[i];
        assert!(
            (got - want).abs() <= 1e-12 * want.abs().max(1.0),
            "component {} got {got} want {want}",
            i
        );
    }
}

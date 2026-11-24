use aquapilot_core::asm2d::{Component, CstrOptions, Params, State, step_cstr};

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
    let expected = [
        0.0,
        100.34781196291377,
        29.95876104926756,
        0.0,
        87.22956835102949,
        1.2997820456685716,
        0.0,
        75.1124803689188,
        8.8728555361864,
        0.0,
        1781.4131191942022,
        400.00009536743164,
        102.38643844515008,
        9.533663513662287,
        86.9898697902506,
        32.04816278132256,
        0.0,
        0.0,
        236.36737234403864,
    ];
    for (i, want) in expected.iter().enumerate() {
        let got = state.v[i];
        assert!(
            (got - want).abs() <= 1e-12,
            "component {} got {got} want {want}",
            i
        );
    }
}

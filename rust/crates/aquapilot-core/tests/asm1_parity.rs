//! ASM1 reaction-surface parity against the TypeScript oracle.
//!
//! Golden values are generated from `src/sim/asm1.ts::reactionRates` with the
//! same state, at 20 °C and 15 °C. `rust/golden/asm1-reaction.json` keeps the
//! provenance; this test hardcodes the values so it has no JSON dependency.

use aquapilot_core::asm1::{PARAMS, State, reaction_rates};

fn oracle_state() -> State {
    State {
        s_i: 30.0,
        s_s: 80.0,
        x_i: 150.0,
        x_s: 400.0,
        x_b_h: 2500.0,
        x_b_a: 200.0,
        x_p: 100.0,
        s_o: 2.0,
        s_no: 5.0,
        s_nh: 25.0,
        s_nd: 8.0,
        x_nd: 40.0,
        s_alk: 7.0,
    }
}

fn assert_run(temperature_c: f64, expected: [f64; 13]) {
    let d = reaction_rates(&oracle_state(), PARAMS, temperature_c);
    let actual = d.values();
    for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        assert!(
            (a - e).abs() <= 1e-9,
            "component {} at {} C: rust={} ts={} diff={}",
            i,
            temperature_c,
            a,
            e,
            (a - e).abs()
        );
    }
}

#[test]
fn reaction_surface_matches_ts_20c() {
    assert_run(
        20.0,
        [
            0.0,
            -484.7662513876897,
            0.0,
            -187.36721763085393,
            426.3257575757576,
            4.0918803418803416,
            5.266666666666666,
            -320.2570215163498,
            15.995440435738942,
            1.7312483812483777,
            -41.8732782369146,
            -19.447721763085394,
            -1.0188708610350403,
        ],
    );
}

#[test]
fn reaction_surface_matches_ts_15c() {
    assert_run(
        15.0,
        [
            0.0,
            -345.63163751952834,
            0.0,
            -133.75762988143742,
            303.96437310941997,
            2.321842796369909,
            3.7405046129041457,
            -214.31034304643862,
            8.164692589611013,
            4.541061747065669,
            -29.85506867259437,
            -13.880731110885801,
            -0.25883077446752445,
        ],
    );
}

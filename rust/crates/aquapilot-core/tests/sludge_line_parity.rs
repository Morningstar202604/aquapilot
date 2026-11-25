//! Sludge-line parity against the TypeScript oracle.
//!
//! Fixture: `rust/golden/sludge-line-48h.json`, generated from
//! `src/sim/sludgeLine.ts` on 2026-11-25. Constant feed (80 m3/h WAS,
//! 8000 g/m3 SS), enabled line, 48 h at 0.5 h steps.

use aquapilot_core::sludge_line::{SludgeFeed, SludgeLine};

const ADM1_EXPECTED: [f64; 27] = [
    21.8261395770865,
    21.737395212201317,
    21.55990648243096,
    0.0,
    0.0,
    0.0,
    0.1774887297703475,
    0.0,
    0.0,
    5.143672167755502,
    532.4661893110434,
    717.8476952806295,
    5955.689050199433,
    2.118422115284718,
    2.118422115284718,
    2.118422115284718,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    3.730764320761874,
];

fn feed() -> SludgeFeed {
    SludgeFeed {
        was_flow_m3h: 80.0,
        feed_ss_kg_m3: 8000.0,
        feed_cod_kg_m3: 12000.0,
        feed_n_kg_m3: 600.0,
        feed_p_kg_m3: 120.0,
        ambient_temp_c: 18.0,
    }
}

fn assert_close(actual: f64, expected: f64, field: &str) {
    let scale = expected.abs().max(1.0);
    assert!(
        (actual - expected).abs() <= 1e-12 * scale,
        "{field}: rust={actual} ts={expected} diff={}",
        (actual - expected).abs()
    );
}

#[test]
fn sludge_line_48h_matches_ts_golden() {
    let mut line = SludgeLine::new(true);
    let mut last = None;
    for _ in 0..96 {
        last = Some(line.step(&feed(), 0.5));
    }
    let final_filtrate = last.expect("step ran");

    assert_eq!(line.thickener.feed_flow_m3h, 80.0);
    assert_eq!(line.thickener.underflow_flow_m3h, 44.0);
    assert_eq!(line.thickener.supernatant_flow_m3h, 36.0);
    assert_eq!(line.thickener.underflow_ss_kg_m3, 20000.0);
    assert_eq!(line.digester.volume_m3, 968.0);
    assert_eq!(line.digester.srt_days, 22.0);

    for (i, (actual, expected)) in line
        .digester
        .adm1
        .v
        .iter()
        .zip(ADM1_EXPECTED.iter())
        .enumerate()
    {
        assert_close(*actual, *expected, &format!("adm1[{i}]"));
    }

    assert_close(line.digester.gas.methane_m3d, 1219.68, "methane_m3d");
    assert_close(line.digester.gas.co2_m3d, 656.7507692307693, "co2_m3d");
    assert_close(line.digester.gas.total_m3d, 1876.4307692307693, "total_m3d");
    assert_close(line.digester.gas.methane_kg_d, 874.51056, "methane_kg_d");
    assert_close(
        line.digester.gas.vss_destroyed_kg_d,
        3484.8,
        "vss_destroyed",
    );
    assert_close(
        line.digester.gas.heating_kw,
        868.5111111111111,
        "heating_kw",
    );
    assert_close(line.digester.gas.mixing_kw, 48.400000000000006, "mixing_kw");

    assert_close(line.dewatering.cake_dry_solids_kg_d, 4963.2, "cake_dry");
    assert_close(
        line.dewatering.cake_wet_kg_d,
        24815.999999999993,
        "cake_wet",
    );
    assert_close(final_filtrate.flow_m3h, 78.966, "filtrate_flow");
    assert_close(
        final_filtrate.nh4_n_kg_m3,
        505.9392650001267,
        "filtrate_nh4",
    );
    assert_close(final_filtrate.cod_kg_m3, 668.6422004406961, "filtrate_cod");
    assert_close(final_filtrate.tp_kg_m3, 33.432110022034806, "filtrate_tp");

    assert_close(line.cumulative.raw_sludge_kg_d, 16896.0, "cum_raw");
    assert_close(line.cumulative.cake_kg_d, 49631.99999999999, "cum_cake");
    assert_close(
        line.cumulative.methane_m3,
        2439.3600000000006,
        "cum_methane",
    );
    assert_close(
        line.cumulative.filtrate_nh4_kg,
        1917.696000000005,
        "cum_nh4",
    );
    assert_close(
        line.cumulative.filtrate_cod_kg,
        2534.4000000000046,
        "cum_cod",
    );
    assert_close(line.cumulative.filtrate_tp_kg, 126.71999999999969, "cum_tp");
}

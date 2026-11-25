//! Plant-boundary mass-book parity against the TypeScript oracle.
//!
//! The fixture replays 96 half-hour steps with alternating component-load and
//! scalar-load paths, dynamic sludge feed, inventory changes and explicit
//! clamp losses. Every row field, inventory field and diagnostic must match.

use aquapilot_core::plant_boundary::{
    BalanceInput, ComponentLoads, InventoryInput, PlantBoundaryState, WaterQuality,
};
use aquapilot_core::sludge_line::SludgeFeed;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../golden/plant-boundary-96step.json");

fn close(actual: f64, expected: f64, label: &str) {
    if actual == expected {
        return;
    }
    let scale = actual.abs().max(expected.abs()).max(1.0);
    let rel = (actual - expected).abs() / scale;
    assert!(
        rel <= 1e-12,
        "{label}: actual={actual:.17e} expected={expected:.17e} rel={rel:.3e}"
    );
}

fn f(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("missing numeric {key} in {v}"))
}

fn typical(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("missing typical {key}"))
}

fn water(v: &Value) -> WaterQuality {
    WaterQuality {
        flow: f(v, "flow"),
        cod: f(v, "cod"),
        nh: f(v, "nh"),
        tn: f(v, "tn"),
        tp: f(v, "tp"),
    }
}

fn compare_row(actual: &aquapilot_core::plant_boundary::BalanceRow, expected: &Value, label: &str) {
    for (field, value) in [
        ("inflowKg", actual.inflow_kg),
        ("effluentKg", actual.effluent_kg),
        ("wastedKg", actual.wasted_kg),
        ("methaneCodKg", actual.methane_cod_kg),
        ("oxidizedKg", actual.oxidized_kg),
        ("denitrifiedKg", actual.denitrified_kg),
        ("inventoryChangeKg", actual.inventory_change_kg),
        ("recycleKg", actual.recycle_kg),
        ("residualKg", actual.residual_kg),
        ("residualPct", actual.residual_pct),
    ] {
        close(value, f(expected, field), &format!("{label}.{field}"));
    }
    assert_eq!(
        actual.closed,
        expected["closed"].as_bool().unwrap(),
        "{label}.closed"
    );
}

#[test]
fn plant_boundary_96_steps_match_typescript() {
    let doc: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let dt_h = typical(&doc, "dtH");
    let cases = doc["cases"].as_array().expect("cases");
    let mut boundary = PlantBoundaryState::new(true);

    for (i, case) in cases.iter().enumerate() {
        let feed_json = &case["sludgeFeed"];
        let feed = SludgeFeed {
            was_flow_m3h: f(feed_json, "wasFlowM3h"),
            feed_ss_kg_m3: f(feed_json, "feedSsKgM3"),
            feed_cod_kg_m3: f(feed_json, "feedCodKgM3"),
            feed_n_kg_m3: f(feed_json, "feedNKgM3"),
            feed_p_kg_m3: f(feed_json, "feedPKgM3"),
            ambient_temp_c: f(feed_json, "ambientTempC"),
        };
        boundary.sludge_line.step(&feed, dt_h);

        let input_json = &case["balanceInput"];
        let inv_json = &input_json["inventory"];
        let component = if input_json["component"].is_null() {
            None
        } else {
            let c = &input_json["component"];
            Some(ComponentLoads {
                cod_in_kg: f(c, "codInKg"),
                cod_eff_kg: f(c, "codEffKg"),
                n_in_kg: f(c, "nInKg"),
                n_eff_kg: f(c, "nEffKg"),
                p_in_kg: f(c, "pInKg"),
                p_eff_kg: f(c, "pEffKg"),
                waste_cod_kg: f(c, "wasteCodKg"),
                waste_n_kg: f(c, "wasteNKg"),
                waste_p_kg: f(c, "wastePKg"),
            })
        };
        let input = BalanceInput {
            influent: water(&input_json["influent"]),
            effluent: water(&input_json["effluent"]),
            dt_h,
            biomass_kg: f(input_json, "biomassKg"),
            inventory: Some(InventoryInput {
                cod_kg: f(inv_json, "codKg"),
                n_kg: f(inv_json, "nKg"),
                p_kg: f(inv_json, "pKg"),
            }),
            oxidized_cod_kg_h: f(input_json, "oxidizedCodKgH"),
            denitrified_n_kg_h: input_json
                .get("denitrifiedNKgH")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            clamp_cod_kg_h: input_json
                .get("clampCodKgH")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            clamp_n_kg_h: input_json
                .get("clampNKgH")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            clamp_p_kg_h: input_json
                .get("clampPKgH")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            wasted_dry_kg: f(input_json, "wastedDryKg"),
            component,
        };
        boundary.update(&input);

        let expected = &case["expected"];
        compare_row(&boundary.cod, &expected["cod"], "step.cod");
        compare_row(&boundary.n, &expected["n"], "step.n");
        compare_row(&boundary.p, &expected["p"], "step.p");
        let inv = &expected["inventory"];
        for (field, value) in [
            ("biomassKg", boundary.inventory.biomass_kg),
            ("codKg", boundary.inventory.cod_kg),
            ("nKg", boundary.inventory.n_kg),
            ("pKg", boundary.inventory.p_kg),
            ("previousCodKg", boundary.inventory.previous_cod_kg),
            ("previousNKg", boundary.inventory.previous_n_kg),
            ("previousPKg", boundary.inventory.previous_p_kg),
        ] {
            close(value, f(inv, field), &format!("step{i}.inventory.{field}"));
        }
        assert_eq!(
            boundary.inventory.seeded,
            inv["seeded"].as_bool().unwrap(),
            "step{i}.inventory.seeded"
        );
        let expected_errors = expected["errors"].as_array().unwrap();
        assert_eq!(
            boundary.errors.len(),
            expected_errors.len(),
            "step{i}.errors.len"
        );
        for (actual, want) in boundary.errors.iter().zip(expected_errors) {
            assert_eq!(
                actual.code,
                want["code"].as_str().unwrap(),
                "step{i}.error.code"
            );
            assert_eq!(
                actual.message,
                want["message"].as_str().unwrap(),
                "step{i}.error.message"
            );
        }
    }
}

fn row_residual(a: &aquapilot_core::plant_boundary::BalanceRow) -> f64 {
    a.inflow_kg + a.recycle_kg
        - a.effluent_kg
        - a.wasted_kg
        - a.methane_cod_kg
        - a.oxidized_kg
        - a.denitrified_kg
        - a.inventory_change_kg
}

#[test]
fn plant_boundary_residuals_and_flags_are_consistent() {
    let mut state = PlantBoundaryState::new(true);
    let mut seed = 20261125u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 11) as f64) / ((1u64 << 53) as f64)
    };
    for i in 0..500 {
        let feed = SludgeFeed {
            was_flow_m3h: 40.0 + next() * 80.0,
            feed_ss_kg_m3: 5000.0 + next() * 5000.0,
            feed_cod_kg_m3: 4000.0 + next() * 4000.0,
            feed_n_kg_m3: 200.0 + next() * 300.0,
            feed_p_kg_m3: 50.0 + next() * 100.0,
            ambient_temp_c: 10.0 + next() * 20.0,
        };
        state.sludge_line.step(&feed, 0.25);
        let biomass = 8000.0 + next() * 8000.0;
        let input = BalanceInput {
            influent: WaterQuality {
                flow: 900.0 + next() * 1200.0,
                cod: 180.0 + next() * 300.0,
                nh: 15.0 + next() * 30.0,
                tn: 30.0 + next() * 30.0,
                tp: 2.0 + next() * 5.0,
            },
            effluent: WaterQuality {
                flow: 800.0 + next() * 1000.0,
                cod: 10.0 + next() * 40.0,
                nh: 0.5 + next() * 3.0,
                tn: 5.0 + next() * 10.0,
                tp: 0.1 + next() * 0.6,
            },
            dt_h: 0.25,
            biomass_kg: biomass,
            inventory: Some(InventoryInput {
                cod_kg: (biomass * 1.42) + next() * 200.0,
                n_kg: (biomass * 0.07) + next() * 20.0,
                p_kg: (biomass * 0.032) + next() * 8.0,
            }),
            oxidized_cod_kg_h: next() * 1200.0,
            denitrified_n_kg_h: next() * 150.0,
            clamp_cod_kg_h: if i % 7 == 0 { next() * 5.0 } else { 0.0 },
            clamp_n_kg_h: if i % 11 == 0 { next() * 1.0 } else { 0.0 },
            clamp_p_kg_h: if i % 13 == 0 { next() * 0.2 } else { 0.0 },
            wasted_dry_kg: 100.0 + next() * 400.0,
            component: None,
        };
        state.update(&input);
        for (label, row) in [("cod", &state.cod), ("n", &state.n), ("p", &state.p)] {
            close(
                row.residual_kg,
                row_residual(row),
                &format!("prop{i}.{label}.residual"),
            );
            let supply = row.inflow_kg + row.recycle_kg;
            let pct = if supply > 1e-9 {
                row.residual_kg.abs() / supply
            } else {
                0.0
            };
            close(row.residual_pct, pct, &format!("prop{i}.{label}.pct"));
            assert_eq!(row.closed, pct <= 0.05, "prop{i}.{label}.closed");
            for (name, value) in [
                ("inflow", row.inflow_kg),
                ("effluent", row.effluent_kg),
                ("wasted", row.wasted_kg),
                ("recycle", row.recycle_kg),
            ] {
                assert!(
                    value >= 0.0 && value.is_finite(),
                    "prop{i}.{label}.{name}={value}"
                );
            }
        }
    }
}

#[test]
fn disabled_sludge_line_never_recycles_or_charges_methane() {
    let mut state = PlantBoundaryState::new(false);
    for _ in 0..32 {
        state.sludge_line.step(
            &SludgeFeed {
                was_flow_m3h: 80.0,
                feed_ss_kg_m3: 8000.0,
                feed_cod_kg_m3: 7000.0,
                feed_n_kg_m3: 400.0,
                feed_p_kg_m3: 120.0,
                ambient_temp_c: 25.0,
            },
            0.5,
        );
        state.update(&BalanceInput {
            influent: WaterQuality {
                flow: 1546.0,
                cod: 312.0,
                nh: 31.5,
                tn: 44.0,
                tp: 4.6,
            },
            effluent: WaterQuality {
                flow: 1533.0,
                cod: 30.0,
                nh: 1.6,
                tn: 10.5,
                tp: 0.34,
            },
            dt_h: 0.5,
            biomass_kg: 12000.0,
            inventory: Some(InventoryInput {
                cod_kg: 17040.0,
                n_kg: 840.0,
                p_kg: 384.0,
            }),
            oxidized_cod_kg_h: 900.0,
            denitrified_n_kg_h: 0.0,
            clamp_cod_kg_h: 0.0,
            clamp_n_kg_h: 0.0,
            clamp_p_kg_h: 0.0,
            wasted_dry_kg: 0.0,
            component: None,
        });
    }
    assert!(state.cod.recycle_kg == 0.0 && state.n.recycle_kg == 0.0 && state.p.recycle_kg == 0.0);
    assert_eq!(state.cod.methane_cod_kg, 0.0);
    assert!(
        state
            .errors
            .iter()
            .all(|e| e.code == "PLANT_BALANCE_UNCLOSED")
    );

    state.reset();
    assert_eq!(state.inventory, Default::default());
    assert!(state.cod.inflow_kg == 0.0 && state.cod.residual_kg == 0.0);
}

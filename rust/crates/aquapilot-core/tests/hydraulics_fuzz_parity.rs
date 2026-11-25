//! Randomized differential corpus for the hydraulics / transport layer.
//!
//! `rust/golden/hydraulics-fuzz.json` is generated from `src/sim/hydraulics.ts`
//! with a deterministic Mulberry32 seed. It contains 64 full state scenarios
//! (191 edges), 64 resistance-split cases and 64 geometry-derivation cases.
//! The Rust implementation must match every finite field at 1e-12 relative
//! tolerance; no tolerance relaxation is allowed.

use std::collections::HashMap;

use aquapilot_core::hydraulics::{
    DeviceKind, EdgeGeometry, HydraulicEdgeSpec, HydraulicsStepInput, RecycleKind, SplitBranch,
    StreamKind, TRANSPORT_COMPONENT_COUNT, WeirType, branch_hydraulics, create_hydraulics,
    derive_edge_geometry, inject_tracer, refresh_rtd_metrics, segment_count, split_by_resistance,
    step_hydraulics,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../golden/hydraulics-fuzz.json");

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

fn opt_f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn stream(s: &str) -> StreamKind {
    match s {
        "influent" => StreamKind::Influent,
        "mixed_liquor" => StreamKind::MixedLiquor,
        "return_activated_sludge" => StreamKind::ReturnActivatedSludge,
        "waste_sludge" => StreamKind::WasteSludge,
        "internal_recycle" => StreamKind::InternalRecycle,
        "effluent" => StreamKind::Effluent,
        "air" => StreamKind::Air,
        "chemical" => StreamKind::Chemical,
        "sludge_cake" => StreamKind::SludgeCake,
        other => panic!("unknown stream {other}"),
    }
}

fn geometry(v: &Value) -> EdgeGeometry {
    let device = match v["deviceKind"].as_str().expect("deviceKind") {
        "none" => DeviceKind::None,
        "valve" => DeviceKind::Valve,
        "pump" => DeviceKind::Pump,
        "weir" => DeviceKind::Weir,
        other => panic!("unknown device {other}"),
    };
    let weir_type = match v["weirType"].as_str().expect("weirType") {
        "rectangular" => WeirType::Rectangular,
        "v-notch" => WeirType::VNotch,
        other => panic!("unknown weir type {other}"),
    };
    EdgeGeometry {
        length_m: f(v, "lengthM"),
        diameter_mm: f(v, "diameterMm"),
        roughness_mm: f(v, "roughnessMm"),
        target_velocity_mps: f(v, "targetVelocityMps"),
        device_kind: device,
        valve_open: f(v, "valveOpen"),
        valve_cv: f(v, "valveCv"),
        pump_rpm: f(v, "pumpRpm"),
        pump_head0_m: f(v, "pumpHead0M"),
        pump_k: f(v, "pumpK"),
        weir_width_m: f(v, "weirWidthM"),
        weir_type,
    }
}

fn meta_map(v: &Value) -> Option<HashMap<String, String>> {
    if v.is_null() {
        return None;
    }
    let obj = v.as_object()?;
    Some(
        obj.iter()
            .map(|(k, val)| {
                let s = match val {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    other => panic!("unsupported meta value {other}"),
                };
                (k.clone(), s)
            })
            .collect(),
    )
}

fn compare_edge(edge: &aquapilot_core::hydraulics::HydraulicEdgeState, expected: &Value) {
    let label = edge.id.clone();
    assert_eq!(edge.id, expected["id"].as_str().unwrap());
    assert_eq!(edge.from, expected["from"].as_str().unwrap());
    assert_eq!(edge.to, expected["to"].as_str().unwrap());
    close(
        edge.flow_m3h,
        f(expected, "flowM3h"),
        &format!("{label} flow"),
    );
    close(
        edge.volume_m3,
        f(expected, "volumeM3"),
        &format!("{label} volume"),
    );
    close(
        edge.residence_min,
        f(expected, "residenceMin"),
        &format!("{label} residence"),
    );
    close(
        edge.velocity_mps,
        f(expected, "velocityMps"),
        &format!("{label} velocity"),
    );
    if let Some(v) = opt_f(expected, "resistance") {
        close(edge.resistance, v, &format!("{label} resistance"));
    } else {
        assert!(
            edge.resistance.is_infinite(),
            "{label} resistance should be inf"
        );
    }
    close(
        edge.head_loss_m,
        f(expected, "headLossM"),
        &format!("{label} head loss"),
    );
    if let Some(v) = opt_f(expected, "capacityM3h") {
        close(edge.capacity_m3h, v, &format!("{label} capacity"));
    } else {
        assert!(
            edge.capacity_m3h.is_infinite(),
            "{label} capacity should be inf"
        );
    }
    let segments = expected["tracerSegments"].as_array().unwrap();
    assert_eq!(
        edge.tracer_segments.len(),
        segments.len(),
        "{label} segment count"
    );
    for (i, &c) in edge.tracer_segments.iter().enumerate() {
        close(
            c,
            segments[i].as_f64().unwrap(),
            &format!("{label} tracer seg {i}"),
        );
    }
    let components = expected["componentSegments"].as_array().unwrap();
    for (i, comp) in edge.component_segments.iter().enumerate() {
        let row = components[i].as_array().unwrap();
        for k in 0..TRANSPORT_COMPONENT_COUNT {
            close(
                comp[k],
                row[k].as_f64().unwrap(),
                &format!("{label} comp {i}/{k}"),
            );
        }
    }
    close(
        edge.tracer_outlet,
        f(expected, "tracerOutlet"),
        &format!("{label} tracer outlet"),
    );
}

#[test]
fn hydraulics_random_corpus_matches_typescript() {
    let root: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let cases = root["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 64);

    for case in cases {
        let id = case["id"].as_str().unwrap();
        let specs: Vec<HydraulicEdgeSpec> = case["specs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| HydraulicEdgeSpec {
                id: s["id"].as_str().unwrap().to_string(),
                from: s["from"].as_str().unwrap().to_string(),
                to: s["to"].as_str().unwrap().to_string(),
                stream: stream(s["stream"].as_str().unwrap()),
                train_id: s.get("trainId").and_then(Value::as_str).map(str::to_string),
                recycle_kind: match s.get("recycleKind").and_then(Value::as_str) {
                    Some("ras") => Some(RecycleKind::Ras),
                    Some("internal") => Some(RecycleKind::Internal),
                    Some("was") => Some(RecycleKind::Was),
                    None => None,
                    other => panic!("unknown recycle {other:?}"),
                },
                geometry: geometry(&s["geometry"]),
            })
            .collect();
        let design = f(case, "designFlowM3h");
        let mut h = create_hydraulics(&specs, design);
        inject_tracer(&mut h, &specs[0].id, f(case, "tracerMassKg"), design);

        let dt = f(case, "dtMin");
        let steps = case["steps"].as_u64().unwrap() as usize;
        let flows = case["flows"].as_array().unwrap();
        let feed = case["componentFeed"].as_array().unwrap();
        let outlet = case["outletEdgeId"].as_str().unwrap().to_string();
        for (s, step_flows) in flows.iter().take(steps).enumerate() {
            let mut flow_map = HashMap::new();
            let mut tracer_map = HashMap::new();
            let mut component_map = HashMap::new();
            for (i, spec) in specs.iter().enumerate() {
                flow_map.insert(spec.id.clone(), step_flows[i].as_f64().unwrap());
                tracer_map.insert(spec.id.clone(), 0.0);
                let row = feed[i].as_array().unwrap();
                let mut values = [0.0; TRANSPORT_COMPONENT_COUNT];
                for k in 0..TRANSPORT_COMPONENT_COUNT {
                    values[k] = row[k].as_f64().unwrap();
                }
                component_map.insert(spec.id.clone(), values);
            }
            let outlets = [outlet.clone()];
            let input = HydraulicsStepInput {
                flows: &flow_map,
                dt_min: dt,
                time_min: (s + 1) as f64 * dt,
                tracer_feed: Some(&tracer_map),
                component_feed: Some(&component_map),
                outlet_edge_ids: Some(&outlets),
            };
            step_hydraulics(&mut h, &input);
            refresh_rtd_metrics(&mut h, dt);
        }

        let expected = &case["expected"];
        let expected_edges = expected["edges"].as_array().unwrap();
        assert_eq!(h.edges.len(), expected_edges.len(), "{id} edge count");
        for (i, edge) in h.edges.iter().enumerate() {
            compare_edge(edge, &expected_edges[i]);
        }
        let tracer = &expected["tracer"];
        close(
            h.tracer.injected_mass_kg,
            f(tracer, "injectedMassKg"),
            &format!("{id} injected"),
        );
        close(
            h.tracer.retained_mass_kg,
            f(tracer, "retainedMassKg"),
            &format!("{id} retained"),
        );
        close(
            h.tracer.discharged_mass_kg,
            f(tracer, "dischargedMassKg"),
            &format!("{id} discharged"),
        );
        close(h.tracer.peak_c, f(tracer, "peakC"), &format!("{id} peak"));
        close(
            h.tracer.peak_min,
            f(tracer, "peakMin"),
            &format!("{id} peak time"),
        );
        close(
            h.tracer.mean_residence_min,
            f(tracer, "meanResidenceMin"),
            &format!("{id} mean"),
        );
        close(
            h.tracer.variance_min2,
            f(tracer, "varianceMin2"),
            &format!("{id} variance"),
        );
        assert_eq!(
            h.tracer.history.len(),
            tracer["historyLength"].as_u64().unwrap() as usize,
            "{id} history"
        );
        let expected_errors = expected["errors"].as_array().unwrap();
        assert_eq!(h.errors.len(), expected_errors.len(), "{id} error count");
        for (i, err) in h.errors.iter().enumerate() {
            assert_eq!(
                err.code,
                expected_errors[i]["code"].as_str().unwrap(),
                "{id} error code"
            );
        }
    }
}

#[test]
fn hydraulics_random_splits_and_geometry_match_typescript() {
    let root: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    for case in root["splitCases"].as_array().unwrap() {
        let branches: Vec<SplitBranch> = case["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| SplitBranch {
                edge_id: b["edgeId"].as_str().unwrap().to_string(),
                resistance: opt_f(b, "resistance").unwrap_or(f64::INFINITY),
                closed: b["closed"].as_bool().unwrap(),
                capacity_m3h: opt_f(b, "capacityM3h").unwrap_or(f64::INFINITY),
            })
            .collect();
        let out = split_by_resistance(f(case, "totalQ"), &branches);
        let expected = &case["expected"];
        let flows = expected["flows"].as_array().unwrap();
        assert_eq!(out.flows.len(), flows.len());
        for (i, &q) in out.flows.iter().enumerate() {
            close(
                q,
                flows[i].as_f64().unwrap(),
                &format!("{} flow {i}", case["id"].as_str().unwrap()),
            );
        }
        let status = expected["status"].as_str().unwrap();
        assert_eq!(
            status == "ok",
            out.status == aquapilot_core::hydraulics::SplitStatus::Ok
        );
        assert_eq!(
            expected["errorCode"].as_str(),
            out.error_code,
            "{} error code",
            case["id"].as_str().unwrap()
        );
    }

    for case in root["geometryCases"].as_array().unwrap() {
        let from = meta_map(&case["from"]);
        let to = meta_map(&case["to"]);
        let actual = derive_edge_geometry(from.as_ref(), to.as_ref());
        let expected = &case["expected"];
        close(actual.length_m, f(expected, "lengthM"), "geometry length");
        close(
            actual.diameter_mm,
            f(expected, "diameterMm"),
            "geometry diameter",
        );
        close(
            actual.roughness_mm,
            f(expected, "roughnessMm"),
            "geometry roughness",
        );
        close(
            actual.target_velocity_mps,
            f(expected, "targetVelocityMps"),
            "geometry velocity",
        );
        let device = match expected["deviceKind"].as_str().unwrap() {
            "none" => DeviceKind::None,
            "valve" => DeviceKind::Valve,
            "pump" => DeviceKind::Pump,
            "weir" => DeviceKind::Weir,
            other => panic!("unknown device {other}"),
        };
        assert_eq!(actual.device_kind, device);
        close(
            actual.valve_open,
            f(expected, "valveOpen"),
            "geometry valve open",
        );
        close(actual.valve_cv, f(expected, "valveCv"), "geometry valve Cv");
        close(actual.pump_rpm, f(expected, "pumpRpm"), "geometry pump rpm");
        close(
            actual.pump_head0_m,
            f(expected, "pumpHead0M"),
            "geometry pump head",
        );
        close(actual.pump_k, f(expected, "pumpK"), "geometry pump K");
        close(
            actual.weir_width_m,
            f(expected, "weirWidthM"),
            "geometry weir width",
        );
        let weir_type = match expected["weirType"].as_str().unwrap() {
            "rectangular" => WeirType::Rectangular,
            "v-notch" => WeirType::VNotch,
            other => panic!("unknown weir type {other}"),
        };
        assert_eq!(actual.weir_type, weir_type);
    }
}

#[test]
fn hydraulics_property_invariants_hold() {
    let mut seed = 0x5eed_2026_u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 11) as f64) / ((1u64 << 53) as f64)
    };
    for _ in 0..1000 {
        let total = next() * 1600.0;
        let n = 1 + (next() * 6.0) as usize;
        let branches: Vec<SplitBranch> = (0..n)
            .map(|i| SplitBranch {
                edge_id: format!("b{i}"),
                resistance: if next() < 0.1 {
                    f64::INFINITY
                } else {
                    10f64.powf(next() * 4.0 - 2.0)
                },
                closed: next() < 0.2,
                capacity_m3h: if next() < 0.3 {
                    20.0 + next() * 600.0
                } else {
                    f64::INFINITY
                },
            })
            .collect();
        let out = split_by_resistance(total, &branches);
        assert_eq!(out.flows.len(), n);
        for (i, &q) in out.flows.iter().enumerate() {
            assert!(q.is_finite() && q >= 0.0, "negative/non-finite split flow");
            if branches[i].closed {
                assert_eq!(q, 0.0, "closed branch got flow");
            }
            if branches[i].capacity_m3h.is_finite() {
                assert!(q <= branches[i].capacity_m3h + 1e-9, "capacity exceeded");
            }
        }
        if out.status == aquapilot_core::hydraulics::SplitStatus::Ok {
            let active_capacity: f64 = branches
                .iter()
                .filter(|b| !b.closed)
                .map(|b| b.capacity_m3h)
                .sum();
            if active_capacity >= total {
                let sum: f64 = out.flows.iter().sum();
                assert!(
                    (sum - total).abs() <= total.max(1.0) * 1e-9,
                    "split mass not conserved"
                );
            }
        }
    }

    for _ in 0..1000 {
        let mut geo = EdgeGeometry {
            length_m: 0.5 + next() * 80.0,
            diameter_mm: if next() < 0.3 {
                0.0
            } else {
                100.0 + next() * 1800.0
            },
            roughness_mm: 0.05 + next() * 1.0,
            target_velocity_mps: 1.0 + next() * 0.5,
            device_kind: DeviceKind::None,
            valve_open: next(),
            valve_cv: 20.0 + next() * 200.0,
            pump_rpm: 700.0 + next() * 1000.0,
            pump_head0_m: 4.0 + next() * 28.0,
            pump_k: 3e-6 + next() * 6e-5,
            weir_width_m: 0.4 + next() * 2.0,
            weir_type: if next() < 0.5 {
                WeirType::Rectangular
            } else {
                WeirType::VNotch
            },
        };
        geo.device_kind = match (next() * 4.0) as usize {
            0 => DeviceKind::None,
            1 => DeviceKind::Valve,
            2 => DeviceKind::Pump,
            _ => DeviceKind::Weir,
        };
        let flow = next() * 1500.0;
        let br = branch_hydraulics(&geo, flow, 100.0 + next() * 1200.0);
        assert!(br.volume_m3.is_finite() && br.volume_m3 >= 0.0);
        assert!(br.velocity_mps.is_finite() && br.velocity_mps >= 0.0);
        assert!(br.residence_min.is_finite() && br.residence_min >= 0.0);
        assert!(br.head_loss_m.is_finite() && br.head_loss_m >= 0.0);
        assert!(
            br.resistance > 0.0,
            "resistance must be positive or infinite"
        );
        assert!((1..=4).contains(&segment_count(br.residence_min)));
    }
}

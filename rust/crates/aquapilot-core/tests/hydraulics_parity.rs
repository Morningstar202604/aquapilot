//! Hydraulics parity against the TypeScript oracle.
//!
//! Fixture: `rust/golden/hydraulics-48h.json`, generated from
//! `src/sim/hydraulics.ts`. Six edges (feed, aeration→clarifier, RAS pump,
//! WAS valve, air, weir outlet), 48 one-minute steps with a flow transient and
//! a 60 kg tracer pulse on the feed line.

use std::collections::HashMap;

use aquapilot_core::hydraulics::{
    DeviceKind, EdgeGeometry, HydraulicEdgeSpec, HydraulicsStepInput, PumpCurve, RecycleKind,
    SplitBranch, StreamKind, TRANSPORT_COMPONENT_COUNT, WeirType, branch_hydraulics,
    create_hydraulics, derive_edge_geometry, diameter_for_flow, hydraulic_train_view,
    inject_tracer, pump_head, refresh_rtd_metrics, segment_count, split_by_resistance,
    step_hydraulics, valve_flow, weir_flow,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../golden/hydraulics-48h.json");

fn close(actual: f64, expected: f64, tol: f64, label: &str) {
    if actual == expected {
        return;
    }
    let scale = actual.abs().max(expected.abs()).max(1.0);
    let rel = (actual - expected).abs() / scale;
    assert!(
        rel <= tol,
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

fn parse_stream(v: &Value) -> StreamKind {
    match v.as_str().expect("stream string") {
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

fn parse_geometry(v: &Value) -> EdgeGeometry {
    let device = match v
        .get("deviceKind")
        .and_then(Value::as_str)
        .expect("deviceKind")
    {
        "none" => DeviceKind::None,
        "valve" => DeviceKind::Valve,
        "pump" => DeviceKind::Pump,
        "weir" => DeviceKind::Weir,
        other => panic!("unknown device {other}"),
    };
    let weir_type = match v.get("weirType").and_then(Value::as_str).expect("weirType") {
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

fn parse_specs(root: &Value) -> Vec<HydraulicEdgeSpec> {
    root["specs"]
        .as_array()
        .expect("specs")
        .iter()
        .map(|s| HydraulicEdgeSpec {
            id: s["id"].as_str().unwrap().to_string(),
            from: s["from"].as_str().unwrap().to_string(),
            to: s["to"].as_str().unwrap().to_string(),
            stream: parse_stream(&s["stream"]),
            train_id: s.get("trainId").and_then(Value::as_str).map(str::to_string),
            recycle_kind: match s.get("recycleKind").and_then(Value::as_str) {
                Some("ras") => Some(RecycleKind::Ras),
                Some("internal") => Some(RecycleKind::Internal),
                Some("was") => Some(RecycleKind::Was),
                None => None,
                other => panic!("unknown recycle kind {other:?}"),
            },
            geometry: parse_geometry(&s["geometry"]),
        })
        .collect()
}

fn meta(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

fn step_hydraulics_once(h: &mut aquapilot_core::hydraulics::HydraulicState, step: usize) {
    let base = if step <= 16 {
        900.0
    } else if step <= 32 {
        850.0
    } else {
        1000.0
    };
    let mut flows = HashMap::new();
    flows.insert("feed".to_string(), base);
    flows.insert("a-clar".to_string(), base * 0.978);
    flows.insert("ras".to_string(), 180.0);
    flows.insert("was".to_string(), 42.0);
    flows.insert("air".to_string(), 0.0);
    flows.insert("out".to_string(), base * 0.93);

    let mut tracer_feed = HashMap::new();
    tracer_feed.insert("feed".to_string(), 0.0);
    tracer_feed.insert("a-clar".to_string(), h.edges[0].tracer_outlet);
    tracer_feed.insert("ras".to_string(), 0.0);
    tracer_feed.insert("was".to_string(), 0.0);
    tracer_feed.insert("air".to_string(), 0.0);
    tracer_feed.insert("out".to_string(), h.edges[1].tracer_outlet);

    let zero = [0.0; TRANSPORT_COMPONENT_COUNT];
    let mut component_feed = HashMap::new();
    component_feed.insert("feed".to_string(), [420.0, 35.0, 8.0, 6.0, 180.0]);
    component_feed.insert(
        "a-clar".to_string(),
        *h.edges[0].component_segments.last().unwrap(),
    );
    component_feed.insert("ras".to_string(), zero);
    component_feed.insert("was".to_string(), zero);
    component_feed.insert("air".to_string(), zero);
    component_feed.insert(
        "out".to_string(),
        *h.edges[1].component_segments.last().unwrap(),
    );

    let outlets = ["out".to_string()];
    let input = HydraulicsStepInput {
        flows: &flows,
        dt_min: 1.0,
        time_min: step as f64,
        tracer_feed: Some(&tracer_feed),
        component_feed: Some(&component_feed),
        outlet_edge_ids: Some(&outlets),
    };
    step_hydraulics(h, &input);
    refresh_rtd_metrics(h, 1.0);
}

#[test]
fn hydraulics_pure_functions_match_typescript() {
    let root: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let pure = &root["pure"];

    let default_geo = derive_edge_geometry(None, None);
    let expected = &pure["defaultGeo"];
    close(
        default_geo.length_m,
        f(expected, "lengthM"),
        1e-12,
        "default length",
    );
    close(
        default_geo.diameter_mm,
        f(expected, "diameterMm"),
        1e-12,
        "default diameter",
    );
    close(
        default_geo.roughness_mm,
        f(expected, "roughnessMm"),
        1e-12,
        "default roughness",
    );
    close(
        default_geo.target_velocity_mps,
        f(expected, "targetVelocityMps"),
        1e-12,
        "default velocity",
    );
    assert_eq!(default_geo.weir_type, WeirType::Rectangular);
    assert_eq!(default_geo.device_kind, DeviceKind::None);

    close(
        diameter_for_flow(2000.0, 1.2),
        f(pure, "diameter2000"),
        1e-12,
        "diameter 2000",
    );
    close(
        diameter_for_flow(0.0, 1.2),
        f(pure, "diameterZero"),
        1e-12,
        "diameter 0",
    );

    let v30 = derive_edge_geometry(Some(&meta(&[("valveOpen", "0.3")])), None);
    let v80 = derive_edge_geometry(Some(&meta(&[("valveOpen", "0.8")])), None);
    let b30 = branch_hydraulics(&v30, 1000.0, 1000.0);
    let b80 = branch_hydraulics(&v80, 1000.0, 1000.0);
    close(
        b30.resistance,
        f(&pure["valve30"], "resistance"),
        1e-12,
        "valve30 resistance",
    );
    close(
        b80.resistance,
        f(&pure["valve80"], "resistance"),
        1e-12,
        "valve80 resistance",
    );
    close(b30.zeta, f(&pure["valve30"], "zeta"), 1e-12, "valve30 zeta");
    close(b80.zeta, f(&pure["valve80"], "zeta"), 1e-12, "valve80 zeta");
    assert!(!b30.closed && !b80.closed);
    assert!(b30.resistance > b80.resistance);

    let curve = PumpCurve {
        head0_m: 18.0,
        k: 2.4e-5,
        rpm: 1450.0,
        rated_rpm: 1450.0,
    };
    let pump_ok = pump_head(&curve, 500.0);
    close(
        pump_ok.head_m,
        f(&pure["pump500"], "headM"),
        1e-12,
        "pump head",
    );
    close(
        pump_ok.max_flow_m3h,
        f(&pure["pump500"], "maxFlowM3h"),
        1e-12,
        "pump max flow",
    );
    assert!(!pump_ok.over_curve);
    assert!(pump_head(&curve, pump_ok.max_flow_m3h * 1.5).over_curve);

    let split = split_by_resistance(
        1000.0,
        &[
            SplitBranch {
                edge_id: "narrow".into(),
                resistance: b30.resistance,
                closed: false,
                capacity_m3h: f64::INFINITY,
            },
            SplitBranch {
                edge_id: "wide".into(),
                resistance: b80.resistance,
                closed: false,
                capacity_m3h: f64::INFINITY,
            },
        ],
    );
    let expected_flows = pure["split"]["flows"].as_array().expect("flows");
    close(
        split.flows[0],
        expected_flows[0].as_f64().unwrap(),
        1e-12,
        "split narrow",
    );
    close(
        split.flows[1],
        expected_flows[1].as_f64().unwrap(),
        1e-12,
        "split wide",
    );

    let expected_segments = pure["segments"].as_array().expect("segments");
    for (i, r) in [0.0, 3.0, 12.0, 30.0].iter().enumerate() {
        assert_eq!(
            segment_count(*r),
            expected_segments[i].as_u64().unwrap() as usize,
            "segment count {r}"
        );
    }

    let rect = weir_flow(1.0, WeirType::Rectangular, 0.2);
    let vnotch = weir_flow(1.0, WeirType::VNotch, 0.2);
    let high = weir_flow(1.0, WeirType::Rectangular, 0.6);
    close(
        rect.flow_m3h,
        f(&pure["weirRect"], "flowM3h"),
        1e-12,
        "rect weir",
    );
    close(
        vnotch.flow_m3h,
        f(&pure["weirV"], "flowM3h"),
        1e-12,
        "v weir",
    );
    assert!(!rect.overflow && !vnotch.overflow);
    close(
        high.flow_m3h,
        f(&pure["weirHigh"], "flowM3h"),
        1e-12,
        "high weir",
    );
    assert!(high.overflow);

    let valve = valve_flow(120.0, 0.01, 2.0);
    assert!(valve.closed && valve.flow_m3h == 0.0);
}

#[test]
fn hydraulics_state_matches_typescript_48_step_fixture() {
    let root: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let specs = parse_specs(&root);
    let design = f(&root, "designFlowM3h");
    let mut h = create_hydraulics(&specs, design);
    assert_eq!(h.edges.len(), specs.len());

    inject_tracer(&mut h, "feed", 60.0, design);
    for step in 1..=48 {
        step_hydraulics_once(&mut h, step);
    }

    let final_state = &root["final"];
    let expected_edges = final_state["edges"].as_array().expect("edges");
    assert_eq!(h.edges.len(), expected_edges.len());
    for (i, edge) in h.edges.iter().enumerate() {
        let e = &expected_edges[i];
        let label = |name: &str| format!("{} {name}", edge.id);
        assert_eq!(edge.id, e["id"].as_str().unwrap());
        assert_eq!(edge.from, e["from"].as_str().unwrap());
        assert_eq!(edge.to, e["to"].as_str().unwrap());
        close(edge.flow_m3h, f(e, "flowM3h"), 1e-12, &label("flow"));
        close(edge.volume_m3, f(e, "volumeM3"), 1e-12, &label("volume"));
        close(
            edge.residence_min,
            f(e, "residenceMin"),
            1e-12,
            &label("residence"),
        );
        close(
            edge.velocity_mps,
            f(e, "velocityMps"),
            1e-12,
            &label("velocity"),
        );
        if let Some(expected) = opt_f(e, "resistance") {
            close(edge.resistance, expected, 1e-12, &label("resistance"));
        }
        close(
            edge.head_loss_m,
            f(e, "headLossM"),
            1e-12,
            &label("head loss"),
        );
        if let Some(expected) = opt_f(e, "capacityM3h") {
            close(edge.capacity_m3h, expected, 1e-12, &label("capacity"));
        } else {
            assert!(
                edge.capacity_m3h.is_infinite(),
                "{} capacity should be inf",
                edge.id
            );
        }
        assert_eq!(
            edge.tracer_segments.len(),
            e["segmentCount"].as_u64().unwrap() as usize,
            "{} segments",
            edge.id
        );
        let expected_segments = e["tracerSegments"].as_array().unwrap();
        for (j, c) in edge.tracer_segments.iter().enumerate() {
            close(
                *c,
                expected_segments[j].as_f64().unwrap(),
                1e-12,
                &format!("{} tracer seg {j}", edge.id),
            );
        }
        let expected_components = e["componentSegments"].as_array().unwrap();
        for (j, comp) in edge.component_segments.iter().enumerate() {
            let row = expected_components[j].as_array().unwrap();
            for k in 0..TRANSPORT_COMPONENT_COUNT {
                close(
                    comp[k],
                    row[k].as_f64().unwrap(),
                    1e-12,
                    &format!("{} comp {j}/{k}", edge.id),
                );
            }
        }
        close(
            edge.tracer_outlet,
            f(e, "tracerOutlet"),
            1e-12,
            &label("tracer outlet"),
        );
    }

    let tracer = &final_state["tracer"];
    close(
        h.tracer.retained_mass_kg,
        f(tracer, "retainedMassKg"),
        1e-12,
        "retained",
    );
    close(
        h.tracer.discharged_mass_kg,
        f(tracer, "dischargedMassKg"),
        1e-12,
        "discharged",
    );
    close(
        h.tracer.injected_mass_kg,
        f(tracer, "injectedMassKg"),
        1e-12,
        "injected",
    );
    close(h.tracer.peak_c, f(tracer, "peakC"), 1e-12, "peak C");
    close(h.tracer.peak_min, f(tracer, "peakMin"), 1e-12, "peak time");
    close(
        h.tracer.mean_residence_min,
        f(tracer, "meanResidenceMin"),
        1e-12,
        "mean RTD",
    );
    close(
        h.tracer.variance_min2,
        f(tracer, "varianceMin2"),
        1e-12,
        "variance RTD",
    );
    assert_eq!(
        h.tracer.history.len(),
        tracer["historyLength"].as_u64().unwrap() as usize
    );
    assert!(h.errors.is_empty());

    let trains = hydraulic_train_view(&h);
    let expected_trains = final_state["trains"].as_array().unwrap();
    assert_eq!(trains.len(), expected_trains.len());
    close(
        trains[0].feed_flow_m3h,
        f(&expected_trains[0], "feedFlowM3h"),
        1e-12,
        "train feed",
    );
    close(
        trains[0].ras_flow_m3h,
        f(&expected_trains[0], "rasFlowM3h"),
        1e-12,
        "train RAS",
    );
    close(
        trains[0].was_flow_m3h,
        f(&expected_trains[0], "wasFlowM3h"),
        1e-12,
        "train WAS",
    );
    assert_eq!(
        trains[0].clarifier_id,
        expected_trains[0]["clarifierId"].as_str().unwrap()
    );
}

#[test]
fn hydraulics_tracer_history_matches_typescript() {
    let root: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let specs = parse_specs(&root);
    let mut h = create_hydraulics(&specs, f(&root, "designFlowM3h"));
    inject_tracer(&mut h, "feed", 60.0, f(&root, "designFlowM3h"));
    for step in 1..=48 {
        step_hydraulics_once(&mut h, step);
    }
    let expected = root["final"]["tracer"]["history"].as_array().unwrap();
    assert_eq!(h.tracer.history.len(), expected.len());
    for (i, point) in h.tracer.history.iter().enumerate() {
        close(point.t_min, f(&expected[i], "tMin"), 1e-12, "history t");
        close(
            point.outlet_c,
            f(&expected[i], "outletC"),
            1e-12,
            "history C",
        );
    }
}

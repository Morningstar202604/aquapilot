//! Hydraulics / transport smoke example.
//!
//! Run: `cargo run -p aquapilot-core --example hydraulics`

use std::collections::HashMap;

use aquapilot_core::hydraulics::{
    DeviceKind, EdgeGeometry, EdgeStatus, HydraulicEdgeSpec, HydraulicsStepInput, StreamKind,
    WeirType, create_hydraulics, inject_tracer, refresh_rtd_metrics, step_hydraulics,
};

fn main() {
    let geometry = EdgeGeometry {
        length_m: 40.0,
        diameter_mm: 500.0,
        roughness_mm: 0.5,
        target_velocity_mps: 1.2,
        device_kind: DeviceKind::None,
        valve_open: 1.0,
        valve_cv: 120.0,
        pump_rpm: 1450.0,
        pump_head0_m: 18.0,
        pump_k: 2.4e-5,
        weir_width_m: 1.0,
        weir_type: WeirType::Rectangular,
    };
    let spec = HydraulicEdgeSpec {
        id: "a-clar".into(),
        from: "a".into(),
        to: "clar".into(),
        stream: StreamKind::MixedLiquor,
        train_id: Some("A".into()),
        recycle_kind: None,
        geometry,
    };
    let mut state = create_hydraulics(&[spec], 600.0);
    inject_tracer(&mut state, "a-clar", 30.0, 600.0);

    let mut flows = HashMap::new();
    flows.insert("a-clar".to_string(), 600.0);
    let outlets = ["a-clar".to_string()];
    for step in 1..=40 {
        let input = HydraulicsStepInput {
            flows: &flows,
            dt_min: 1.0,
            time_min: step as f64,
            tracer_feed: None,
            component_feed: None,
            outlet_edge_ids: Some(&outlets),
        };
        step_hydraulics(&mut state, &input);
        refresh_rtd_metrics(&mut state, 1.0);
    }

    let edge = &state.edges[0];
    assert_eq!(edge.status, EdgeStatus::Ok);
    println!(
        "edge={} flow={:.3} m3/h volume={:.3} m3 residence={:.3} min peak={:.3} mg/L mean={:.3} min",
        edge.id,
        edge.flow_m3h,
        edge.volume_m3,
        edge.residence_min,
        state.tracer.peak_c,
        state.tracer.mean_residence_min
    );
}

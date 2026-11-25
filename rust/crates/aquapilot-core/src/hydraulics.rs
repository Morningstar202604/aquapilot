//! Hydraulics layer (WP3): resistance-based branching, conduit volume and
//! transport delay, pump/valve/weir characteristics, and tracer RTD.
//!
//! Ported from `src/sim/hydraulics.ts`; the TypeScript implementation remains
//! the oracle. Units match the contract: m³/h, m³, min, m, mm, m/s, mg/L, kg.

use std::collections::HashMap;

pub const HYDRAULICS_ERRORS: HydraulicsErrors = HydraulicsErrors {
    invalid_geometry: "HYDRAULICS_INVALID_GEOMETRY",
    unsolvable_split: "HYDRAULICS_UNSOLVABLE_SPLIT",
    tracer_overflow: "HYDRAULICS_TRACER_OVERFLOW",
};

#[derive(Clone, Copy, Debug)]
pub struct HydraulicsErrors {
    pub invalid_geometry: &'static str,
    pub unsolvable_split: &'static str,
    pub tracer_overflow: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct HydraulicsDefaults {
    pub target_velocity_mps: f64,
    pub length_m: f64,
    pub roughness_mm: f64,
    pub water_viscosity_m2s: f64,
    pub gravity: f64,
    pub min_diameter_mm: f64,
    pub max_diameter_mm: f64,
    pub segment_target_min: f64,
    pub min_segments: usize,
    pub max_segments: usize,
    pub valve_full_open_zeta: f64,
    pub valve_closed_alpha: f64,
    pub weir_cd: f64,
    pub tracer_max_mg_l: f64,
    pub pump_rated_rpm: f64,
    pub pump_head0_m: f64,
    pub pump_k: f64,
}

pub const HYDRAULICS_DEFAULTS: HydraulicsDefaults = HydraulicsDefaults {
    target_velocity_mps: 1.2,
    length_m: 6.0,
    roughness_mm: 0.5,
    water_viscosity_m2s: 1.004e-6,
    gravity: 9.81,
    min_diameter_mm: 100.0,
    max_diameter_mm: 2000.0,
    segment_target_min: 5.0,
    min_segments: 1,
    max_segments: 4,
    valve_full_open_zeta: 2.5,
    valve_closed_alpha: 0.02,
    weir_cd: 0.62,
    tracer_max_mg_l: 100_000.0,
    pump_rated_rpm: 1450.0,
    pump_head0_m: 18.0,
    pump_k: 2.4e-5,
};

/// Stream kinds mirror `src/model/topology.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Influent,
    MixedLiquor,
    ReturnActivatedSludge,
    WasteSludge,
    InternalRecycle,
    Effluent,
    Air,
    Chemical,
    SludgeCake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    None,
    Valve,
    Pump,
    Weir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeStatus {
    Ok,
    Closed,
    PumpOverCurve,
    WeirOverflow,
    NoFlow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecycleKind {
    Ras,
    Internal,
    Was,
}

#[derive(Clone, Debug)]
pub struct EdgeGeometry {
    pub length_m: f64,
    /// mm; 0 means derive from design velocity.
    pub diameter_mm: f64,
    pub roughness_mm: f64,
    pub target_velocity_mps: f64,
    pub device_kind: DeviceKind,
    pub valve_open: f64,
    pub valve_cv: f64,
    pub pump_rpm: f64,
    pub pump_head0_m: f64,
    pub pump_k: f64,
    pub weir_width_m: f64,
    pub weir_type: WeirType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeirType {
    Rectangular,
    VNotch,
}

fn num(meta: Option<&HashMap<String, String>>, key: &str) -> Option<f64> {
    let raw = meta?.get(key)?;
    if raw.is_empty() {
        return None;
    }
    raw.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Read edge geometry from unit metadata; source unit wins, then target unit.
pub fn derive_edge_geometry(
    from_meta: Option<&HashMap<String, String>>,
    to_meta: Option<&HashMap<String, String>>,
) -> EdgeGeometry {
    let pick = |key: &str| num(from_meta, key).or_else(|| num(to_meta, key));
    let length_m = pick("lengthM")
        .unwrap_or(HYDRAULICS_DEFAULTS.length_m)
        .max(0.5);
    let diameter_mm = pick("diameterMm").unwrap_or(0.0).max(0.0);
    let roughness_mm = pick("roughnessMm")
        .unwrap_or(HYDRAULICS_DEFAULTS.roughness_mm)
        .max(0.05);
    let target_velocity_mps = pick("targetVelocity")
        .unwrap_or(HYDRAULICS_DEFAULTS.target_velocity_mps)
        .clamp(1.0, 1.5);

    let valve_open = pick("valveOpen");
    let pump_rpm = pick("pumpRpm");
    let weir_width = pick("weirWidthM");

    let device_kind = if weir_width.is_some() {
        DeviceKind::Weir
    } else if pump_rpm.is_some() || pick("pumpHead0").is_some() {
        DeviceKind::Pump
    } else if valve_open.is_some() {
        DeviceKind::Valve
    } else {
        DeviceKind::None
    };

    let weir_type = match to_meta
        .and_then(|m| m.get("weirType"))
        .or_else(|| from_meta.and_then(|m| m.get("weirType")))
        .map(String::as_str)
    {
        Some("v-notch") => WeirType::VNotch,
        _ => WeirType::Rectangular,
    };

    EdgeGeometry {
        length_m,
        diameter_mm,
        roughness_mm,
        target_velocity_mps,
        device_kind,
        valve_open: valve_open.map_or(1.0, |v| v.clamp(0.0, 1.0)),
        valve_cv: pick("valveCv").unwrap_or(120.0).max(0.0),
        pump_rpm: pump_rpm
            .unwrap_or(HYDRAULICS_DEFAULTS.pump_rated_rpm)
            .max(0.0),
        pump_head0_m: pick("pumpHead0")
            .unwrap_or(HYDRAULICS_DEFAULTS.pump_head0_m)
            .max(0.0),
        pump_k: pick("pumpK")
            .unwrap_or(HYDRAULICS_DEFAULTS.pump_k)
            .max(1e-7),
        weir_width_m: weir_width.unwrap_or(1.0).max(0.1),
        weir_type,
    }
}

/// Derive pipe diameter from target velocity, clamped to 100–2000 mm.
pub fn diameter_for_flow(flow_m3h: f64, target_velocity_mps: f64) -> f64 {
    let q_m3s = flow_m3h.max(0.0) / 3600.0;
    if q_m3s <= 0.0 {
        return HYDRAULICS_DEFAULTS.min_diameter_mm;
    }
    let d_m = ((4.0 * q_m3s) / (std::f64::consts::PI * target_velocity_mps)).sqrt();
    (d_m * 1000.0).clamp(
        HYDRAULICS_DEFAULTS.min_diameter_mm,
        HYDRAULICS_DEFAULTS.max_diameter_mm,
    )
}

pub fn conduit_area_m2(diameter_mm: f64) -> f64 {
    let d_m = diameter_mm / 1000.0;
    (std::f64::consts::PI * d_m * d_m) / 4.0
}

/// Darcy friction factor via Swamee-Jain, laminar 64/Re fallback.
pub fn friction_factor(diameter_mm: f64, roughness_mm: f64, velocity_mps: f64) -> f64 {
    let d_m = diameter_mm / 1000.0;
    if d_m <= 0.0 || velocity_mps <= 0.0 {
        return 0.022;
    }
    let re = (velocity_mps * d_m) / HYDRAULICS_DEFAULTS.water_viscosity_m2s;
    if re < 2000.0 {
        return (64.0 / re.max(1.0)).min(0.5);
    }
    let eps = roughness_mm / 1000.0 / d_m;
    let denom = (eps / 3.7 + 5.74 / re.powf(0.9)).log10();
    if denom <= 0.0 {
        return 0.022;
    }
    (0.25 / (denom * denom)).min(0.5)
}

pub struct PumpCurve {
    pub head0_m: f64,
    pub k: f64,
    pub rpm: f64,
    pub rated_rpm: f64,
}

pub struct PumpHead {
    pub head_m: f64,
    pub max_flow_m3h: f64,
    pub over_curve: bool,
}

pub fn pump_head(curve: &PumpCurve, flow_m3h: f64) -> PumpHead {
    let ratio = if curve.rated_rpm > 0.0 {
        curve.rpm / curve.rated_rpm
    } else {
        0.0
    };
    let head_at_zero = curve.head0_m.max(0.0) * ratio * ratio;
    let max_flow = if curve.k > 0.0 {
        (head_at_zero / curve.k).sqrt()
    } else {
        f64::INFINITY
    };
    let head_m = (head_at_zero - curve.k * flow_m3h * flow_m3h).max(0.0);
    PumpHead {
        head_m,
        max_flow_m3h: max_flow,
        over_curve: flow_m3h > max_flow + 1e-6,
    }
}

pub struct ValveFlow {
    pub flow_m3h: f64,
    pub closed: bool,
    pub zeta: f64,
}

pub fn valve_flow(cv_max: f64, open: f64, head_loss_m: f64) -> ValveFlow {
    let alpha = open.clamp(0.0, 1.0);
    if alpha <= HYDRAULICS_DEFAULTS.valve_closed_alpha {
        return ValveFlow {
            flow_m3h: 0.0,
            closed: true,
            zeta: f64::INFINITY,
        };
    }
    let zeta = HYDRAULICS_DEFAULTS.valve_full_open_zeta / (alpha * alpha);
    let delta_bar = (1000.0 * HYDRAULICS_DEFAULTS.gravity * head_loss_m.max(0.0)) / 1e5;
    let cv = cv_max * alpha;
    ValveFlow {
        flow_m3h: cv * delta_bar.max(0.0).sqrt(),
        closed: false,
        zeta,
    }
}

pub struct WeirFlow {
    pub flow_m3h: f64,
    pub overflow: bool,
}

pub fn weir_flow(width_m: f64, weir_type: WeirType, head_above_crest_m: f64) -> WeirFlow {
    let h = head_above_crest_m.max(0.0);
    let g = HYDRAULICS_DEFAULTS.gravity;
    let q_m3s = match weir_type {
        WeirType::VNotch => {
            HYDRAULICS_DEFAULTS.weir_cd * (8.0 / 15.0) * (2.0 * g).sqrt() * h.powf(2.5)
        }
        WeirType::Rectangular => {
            HYDRAULICS_DEFAULTS.weir_cd * width_m * (2.0 * g).sqrt() * h.powf(1.5)
        }
    };
    WeirFlow {
        flow_m3h: q_m3s * 3600.0,
        overflow: h > 0.5,
    }
}

#[derive(Clone, Debug)]
pub struct BranchHydraulics {
    pub area_m2: f64,
    pub diameter_mm: f64,
    pub velocity_mps: f64,
    pub volume_m3: f64,
    pub residence_min: f64,
    pub friction: f64,
    /// h = R·Q² with Q in m³/s.
    pub resistance: f64,
    pub head_loss_m: f64,
    pub closed: bool,
    pub capacity_m3h: f64,
    pub status: EdgeStatus,
    pub pump_head_m: f64,
    pub zeta: f64,
}

pub fn branch_hydraulics(
    geo: &EdgeGeometry,
    flow_m3h: f64,
    design_flow_m3h: f64,
) -> BranchHydraulics {
    let diameter_mm = if geo.diameter_mm > 0.0 {
        geo.diameter_mm
    } else {
        diameter_for_flow(design_flow_m3h, geo.target_velocity_mps)
    };
    let area_m2 = conduit_area_m2(diameter_mm);
    let q_m3s = flow_m3h.max(0.0) / 3600.0;
    let velocity_mps = if area_m2 > 0.0 { q_m3s / area_m2 } else { 0.0 };
    let friction = friction_factor(diameter_mm, geo.roughness_mm, velocity_mps);
    let volume_m3 = area_m2 * geo.length_m;
    let residence_raw = if flow_m3h > 1e-6 {
        (volume_m3 / flow_m3h) * 60.0
    } else {
        f64::INFINITY
    };

    let mut zeta = 0.0;
    let mut closed = false;
    let mut capacity_m3h = f64::INFINITY;
    let mut status = if flow_m3h <= 1e-6 {
        EdgeStatus::NoFlow
    } else {
        EdgeStatus::Ok
    };
    let mut pump_head_m = 0.0;

    match geo.device_kind {
        DeviceKind::Valve => {
            let v = valve_flow(geo.valve_cv, geo.valve_open, 1.0);
            zeta = v.zeta;
            closed = v.closed;
            if closed {
                status = EdgeStatus::Closed;
            }
        }
        DeviceKind::Pump => {
            let pump = pump_head(
                &PumpCurve {
                    head0_m: geo.pump_head0_m,
                    k: geo.pump_k,
                    rpm: geo.pump_rpm,
                    rated_rpm: HYDRAULICS_DEFAULTS.pump_rated_rpm,
                },
                flow_m3h,
            );
            pump_head_m = pump.head_m;
            capacity_m3h = pump.max_flow_m3h;
            if pump.over_curve {
                status = EdgeStatus::PumpOverCurve;
            }
        }
        DeviceKind::Weir => {
            let head = (flow_m3h
                / 3600.0
                / (HYDRAULICS_DEFAULTS.weir_cd
                    * geo.weir_width_m
                    * (2.0 * HYDRAULICS_DEFAULTS.gravity).sqrt()))
            .powf(2.0 / 3.0);
            let w = weir_flow(geo.weir_width_m, geo.weir_type, head);
            if w.overflow {
                status = EdgeStatus::WeirOverflow;
            }
        }
        DeviceKind::None => {}
    }

    let d_m = diameter_mm / 1000.0;
    let pipe_term = if d_m > 0.0 {
        (friction * geo.length_m) / d_m + zeta
    } else {
        f64::INFINITY
    };
    let resistance = if closed {
        f64::INFINITY
    } else {
        (8.0 * pipe_term)
            / (HYDRAULICS_DEFAULTS.gravity
                * std::f64::consts::PI
                * std::f64::consts::PI
                * d_m.powi(4))
    };
    let head_loss_m = if resistance.is_finite() && q_m3s > 0.0 {
        resistance * q_m3s * q_m3s
    } else {
        0.0
    };

    BranchHydraulics {
        area_m2,
        diameter_mm,
        velocity_mps,
        volume_m3,
        residence_min: if residence_raw.is_finite() {
            residence_raw
        } else {
            0.0
        },
        friction,
        resistance,
        head_loss_m,
        closed,
        capacity_m3h,
        status,
        pump_head_m,
        zeta,
    }
}

#[derive(Clone, Debug)]
pub struct SplitBranch {
    pub edge_id: String,
    pub resistance: f64,
    pub closed: bool,
    pub capacity_m3h: f64,
}

#[derive(Clone, Debug)]
pub struct SplitOutcome {
    pub flows: Vec<f64>,
    pub status: SplitStatus,
    pub error_code: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitStatus {
    Ok,
    Unsolvable,
}

/// Resistance split: h = RᵢQᵢ² at a shared node, so Qᵢ ∝ 1/√Rᵢ, total conserved.
pub fn split_by_resistance(total_q: f64, branches: &[SplitBranch]) -> SplitOutcome {
    let active: Vec<usize> = branches
        .iter()
        .enumerate()
        .filter(|(_, b)| !b.closed && b.resistance.is_finite() && b.resistance > 0.0)
        .map(|(i, _)| i)
        .collect();

    if active.is_empty() {
        if total_q > 1e-6 {
            return SplitOutcome {
                flows: vec![0.0; branches.len()],
                status: SplitStatus::Unsolvable,
                error_code: Some(HYDRAULICS_ERRORS.unsolvable_split),
            };
        }
        return SplitOutcome {
            flows: vec![0.0; branches.len()],
            status: SplitStatus::Ok,
            error_code: None,
        };
    }

    let weights: Vec<f64> = active
        .iter()
        .map(|&i| 1.0 / branches[i].resistance.sqrt())
        .collect();
    let mut flows = vec![0.0; branches.len()];
    let mut remaining = total_q;
    let mut capped: Vec<usize> = Vec::new();

    for _pass in 0..2 {
        if remaining <= 1e-9 {
            break;
        }
        let round: Vec<(usize, f64)> = active
            .iter()
            .zip(weights.iter())
            .filter(|(i, _)| !capped.contains(i))
            .map(|(&i, &w)| (i, w))
            .collect();
        if round.is_empty() {
            break;
        }
        let round_weight_sum: f64 = round.iter().map(|(_, w)| *w).sum();
        for &(i, w) in &round {
            let cap = branches[i].capacity_m3h;
            let mut q = (remaining * w) / round_weight_sum;
            if cap.is_finite() && q > cap {
                q = cap;
                capped.push(i);
            }
            flows[i] = q;
        }
        remaining = total_q - flows.iter().sum::<f64>();
    }

    SplitOutcome {
        flows,
        status: SplitStatus::Ok,
        error_code: None,
    }
}

pub fn segment_count(residence_min: f64) -> usize {
    if !residence_min.is_finite() || residence_min <= 0.0 {
        return HYDRAULICS_DEFAULTS.min_segments;
    }
    let n = (residence_min / HYDRAULICS_DEFAULTS.segment_target_min).round() as isize;
    (n.max(HYDRAULICS_DEFAULTS.min_segments as isize) as usize)
        .min(HYDRAULICS_DEFAULTS.max_segments)
}

/// Conserved component order: COD / NH / NO3 / TP / SS.
pub const TRANSPORT_COMPONENTS: [&str; 5] = ["cod", "nh", "no3", "tp", "ss"];
pub const TRANSPORT_COMPONENT_COUNT: usize = 5;

#[derive(Clone, Debug)]
pub struct HydraulicEdgeState {
    pub id: String,
    pub from: String,
    pub to: String,
    pub stream: StreamKind,
    pub train_id: Option<String>,
    pub recycle_kind: Option<RecycleKind>,
    pub flow_m3h: f64,
    pub volume_m3: f64,
    pub residence_min: f64,
    pub velocity_mps: f64,
    pub resistance: f64,
    pub head_loss_m: f64,
    pub capacity_m3h: f64,
    pub device_kind: DeviceKind,
    pub status: EdgeStatus,
    pub valve_open: Option<f64>,
    pub pump_head_m: Option<f64>,
    pub pump_rpm: Option<f64>,
    pub geometry: EdgeGeometry,
    pub tracer_segments: Vec<f64>,
    pub component_segments: Vec<[f64; TRANSPORT_COMPONENT_COUNT]>,
    pub tracer_outlet: f64,
}

/// Specification used to initialise a hydraulic edge. Mirrors the subset of a
/// compiled network edge that the hydraulic layer consumes.
#[derive(Clone, Debug)]
pub struct HydraulicEdgeSpec {
    pub id: String,
    pub from: String,
    pub to: String,
    pub stream: StreamKind,
    pub train_id: Option<String>,
    pub recycle_kind: Option<RecycleKind>,
    pub geometry: EdgeGeometry,
}

#[derive(Clone, Debug)]
pub struct TracerHistoryPoint {
    pub t_min: f64,
    pub outlet_c: f64,
}

#[derive(Clone, Debug)]
pub struct TracerRtd {
    pub active: bool,
    pub injected_mass_kg: f64,
    pub history: Vec<TracerHistoryPoint>,
    pub mean_residence_min: f64,
    pub variance_min2: f64,
    pub peak_min: f64,
    pub peak_c: f64,
    pub retained_mass_kg: f64,
    pub discharged_mass_kg: f64,
}

#[derive(Clone, Debug)]
pub struct HydraulicError {
    pub code: String,
    pub message: String,
    pub edge_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct HydraulicState {
    pub edges: Vec<HydraulicEdgeState>,
    pub errors: Vec<HydraulicError>,
    pub tracer: TracerRtd,
}

/// Initialise hydraulic state from edge specifications at a design flow.
pub fn create_hydraulics(specs: &[HydraulicEdgeSpec], design_flow_m3h: f64) -> HydraulicState {
    let edges = specs
        .iter()
        .map(|spec| {
            let geo = spec.geometry.clone();
            let br = branch_hydraulics(&geo, design_flow_m3h, design_flow_m3h);
            let n = segment_count(br.residence_min);
            HydraulicEdgeState {
                id: spec.id.clone(),
                from: spec.from.clone(),
                to: spec.to.clone(),
                stream: spec.stream,
                train_id: spec.train_id.clone(),
                recycle_kind: spec.recycle_kind,
                flow_m3h: 0.0,
                volume_m3: br.volume_m3,
                residence_min: br.residence_min,
                velocity_mps: 0.0,
                resistance: br.resistance,
                head_loss_m: 0.0,
                capacity_m3h: br.capacity_m3h,
                device_kind: geo.device_kind,
                status: EdgeStatus::NoFlow,
                valve_open: (geo.device_kind == DeviceKind::Valve).then_some(geo.valve_open),
                pump_head_m: (geo.device_kind == DeviceKind::Pump).then_some(br.pump_head_m),
                pump_rpm: (geo.device_kind == DeviceKind::Pump).then_some(geo.pump_rpm),
                geometry: geo,
                tracer_segments: vec![0.0; n],
                component_segments: vec![[0.0; TRANSPORT_COMPONENT_COUNT]; n],
                tracer_outlet: 0.0,
            }
        })
        .collect();

    HydraulicState {
        edges,
        errors: Vec::new(),
        tracer: TracerRtd {
            active: false,
            injected_mass_kg: 0.0,
            history: Vec::new(),
            mean_residence_min: 0.0,
            variance_min2: 0.0,
            peak_min: 0.0,
            peak_c: 0.0,
            retained_mass_kg: 0.0,
            discharged_mass_kg: 0.0,
        },
    }
}

/// Pulse-inject tracer into the first segment of an edge.
pub fn inject_tracer(state: &mut HydraulicState, edge_id: &str, mass_kg: f64, _volume_m3h: f64) {
    let Some(i) = state.edges.iter().position(|e| e.id == edge_id) else {
        state.errors.push(HydraulicError {
            code: HYDRAULICS_ERRORS.invalid_geometry.to_string(),
            message: format!("示踪剂注入未知边 {edge_id}"),
            edge_id: None,
        });
        return;
    };
    if !mass_kg.is_finite() || mass_kg <= 0.0 {
        state.errors.push(HydraulicError {
            code: HYDRAULICS_ERRORS.invalid_geometry.to_string(),
            message: "示踪剂注入质量必须为正数".to_string(),
            edge_id: Some(edge_id.to_string()),
        });
        return;
    }
    let edge = &mut state.edges[i];
    let volume = edge.volume_m3.max(1.0);
    let c_mg_l = (mass_kg * 1000.0) / volume;
    if c_mg_l > HYDRAULICS_DEFAULTS.tracer_max_mg_l {
        state.errors.push(HydraulicError {
            code: HYDRAULICS_ERRORS.tracer_overflow.to_string(),
            message: "示踪剂浓度超出数值上限".to_string(),
            edge_id: Some(edge_id.to_string()),
        });
        return;
    }
    edge.tracer_segments[0] = c_mg_l;
    state.tracer.active = true;
    state.tracer.injected_mass_kg += mass_kg;
}

struct EdgeOutlet {
    tracer_outlet: f64,
    components_outlet: [f64; TRANSPORT_COMPONENT_COUNT],
}

fn advance_edge(
    edge: &mut HydraulicEdgeState,
    dt_min: f64,
    feed_tracer: f64,
    feed_components: Option<&[f64; TRANSPORT_COMPONENT_COUNT]>,
) -> EdgeOutlet {
    let q_m3h = edge.flow_m3h.max(0.0);
    let volume = edge.volume_m3.max(1e-3);
    let n = edge.tracer_segments.len();
    let seg_volume = volume / n as f64;
    let dt_h = dt_min / 60.0;
    let inflow_vol = q_m3h * dt_h;

    if inflow_vol <= 1e-9 {
        return EdgeOutlet {
            tracer_outlet: edge.tracer_segments[n - 1],
            components_outlet: edge.component_segments[n - 1],
        };
    }

    let tau = seg_volume / inflow_vol;
    for j in 0..n {
        let upstream_tracer = if j == 0 {
            feed_tracer
        } else {
            edge.tracer_segments[j - 1]
        };
        edge.tracer_segments[j] =
            (edge.tracer_segments[j] + upstream_tracer / tau) / (1.0 + 1.0 / tau);
        let upstream_comp = if j == 0 {
            feed_components
                .copied()
                .unwrap_or([0.0; TRANSPORT_COMPONENT_COUNT])
        } else {
            edge.component_segments[j - 1]
        };
        let cur_comp = &mut edge.component_segments[j];
        for k in 0..TRANSPORT_COMPONENT_COUNT {
            cur_comp[k] = (cur_comp[k] + upstream_comp[k] / tau) / (1.0 + 1.0 / tau);
        }
    }

    EdgeOutlet {
        tracer_outlet: edge.tracer_segments[n - 1],
        components_outlet: edge.component_segments[n - 1],
    }
}

pub struct HydraulicsStepInput<'a> {
    pub flows: &'a HashMap<String, f64>,
    pub dt_min: f64,
    pub time_min: f64,
    pub tracer_feed: Option<&'a HashMap<String, f64>>,
    pub component_feed: Option<&'a HashMap<String, [f64; TRANSPORT_COMPONENT_COUNT]>>,
    pub outlet_edge_ids: Option<&'a [String]>,
}

/// Update branch state, advance segment CSTRs, and record tracer history.
pub fn step_hydraulics(state: &mut HydraulicState, input: &HydraulicsStepInput<'_>) {
    state.errors.clear();
    let mut errors: Vec<HydraulicError> = Vec::new();

    for edge in state.edges.iter_mut() {
        let flow = input.flows.get(&edge.id).copied().unwrap_or(0.0).max(0.0);
        edge.flow_m3h = flow;
        let geo = edge.geometry.clone();
        let br = branch_hydraulics(&geo, flow, flow.max(1.0));
        edge.volume_m3 = br.volume_m3;
        edge.residence_min = br.residence_min;
        edge.velocity_mps = br.velocity_mps;
        edge.resistance = br.resistance;
        edge.head_loss_m = br.head_loss_m;
        edge.status = br.status;
        edge.pump_head_m = Some(br.pump_head_m);
        edge.capacity_m3h = br.capacity_m3h;

        if br.status == EdgeStatus::PumpOverCurve {
            errors.push(HydraulicError {
                code: HYDRAULICS_ERRORS.unsolvable_split.to_string(),
                message: format!("泵 {} 超出 H-Q 曲线能力", edge.id),
                edge_id: Some(edge.id.clone()),
            });
        }
        if matches!(edge.stream, StreamKind::Air | StreamKind::Chemical) {
            edge.flow_m3h = 0.0;
            edge.status = EdgeStatus::NoFlow;
        }

        let feed_tracer = input
            .tracer_feed
            .and_then(|m| m.get(&edge.id))
            .copied()
            .unwrap_or(0.0);
        let feed_comp = input.component_feed.and_then(|m| m.get(&edge.id)).copied();
        let out = advance_edge(edge, input.dt_min, feed_tracer, feed_comp.as_ref());
        edge.tracer_outlet = out.tracer_outlet;
        let _ = out.components_outlet;
    }
    state.errors.extend(errors);

    if state.tracer.active {
        let outlets: Vec<&HydraulicEdgeState> = input
            .outlet_edge_ids
            .unwrap_or(&[])
            .iter()
            .filter_map(|id| state.edges.iter().find(|e| &e.id == id))
            .collect();
        let outlet_c = outlets
            .iter()
            .map(|e| e.tracer_outlet)
            .fold(0.0_f64, f64::max);
        let outlet_flow: f64 = outlets.iter().map(|e| e.flow_m3h).sum();
        state.tracer.history.push(TracerHistoryPoint {
            t_min: input.time_min,
            outlet_c,
        });
        if outlet_c > state.tracer.peak_c {
            state.tracer.peak_c = outlet_c;
            state.tracer.peak_min = input.time_min;
        }
        state.tracer.discharged_mass_kg +=
            (outlet_c * outlet_flow * (input.dt_min / 60.0)) / 1000.0;
    }

    let mut retained = 0.0;
    for edge in &state.edges {
        let seg_vol = edge.volume_m3.max(1e-3) / edge.tracer_segments.len().max(1) as f64;
        for &c in &edge.tracer_segments {
            retained += (c.max(0.0) * seg_vol) / 1000.0;
        }
    }
    state.tracer.retained_mass_kg = retained;
}

pub struct RtdMetrics {
    pub mean_residence_min: f64,
    pub variance_min2: f64,
}

/// Compute RTD moments from tracer history.
pub fn rtd_metrics(tracer: &TracerRtd, dt_min: f64) -> RtdMetrics {
    if tracer.history.len() < 2 {
        return RtdMetrics {
            mean_residence_min: 0.0,
            variance_min2: 0.0,
        };
    }
    let mut m0 = 0.0;
    let mut m1 = 0.0;
    let mut m2 = 0.0;
    for point in &tracer.history {
        let t = (point.t_min + 0.5) * dt_min;
        let c = point.outlet_c.max(0.0);
        m0 += c * dt_min;
        m1 += c * t * dt_min;
        m2 += c * t * t * dt_min;
    }
    if m0 <= 1e-9 {
        return RtdMetrics {
            mean_residence_min: 0.0,
            variance_min2: 0.0,
        };
    }
    let mean = m1 / m0;
    let variance = m2 / m0 - mean * mean;
    RtdMetrics {
        mean_residence_min: mean,
        variance_min2: variance.max(0.0),
    }
}

pub struct TracerMassBalance {
    pub retained_kg: f64,
    pub discharged_kg: f64,
    pub injected_kg: f64,
    pub balance_residual_kg: f64,
}

/// Tracer mass balance: retained + discharged = injected.
pub fn tracer_mass_balance(state: &HydraulicState) -> TracerMassBalance {
    let retained = state.tracer.retained_mass_kg;
    let discharged = state.tracer.discharged_mass_kg;
    let injected = state.tracer.injected_mass_kg;
    TracerMassBalance {
        retained_kg: retained,
        discharged_kg: discharged,
        injected_kg: injected,
        balance_residual_kg: injected - retained - discharged,
    }
}

pub fn refresh_rtd_metrics(state: &mut HydraulicState, dt_min: f64) {
    let metrics = rtd_metrics(&state.tracer, dt_min);
    state.tracer.mean_residence_min = metrics.mean_residence_min;
    state.tracer.variance_min2 = metrics.variance_min2;
}

#[derive(Clone, Debug)]
pub struct HydraulicEdgeSnapshot {
    pub id: String,
    pub from: String,
    pub to: String,
    pub stream: StreamKind,
    pub flow_m3h: f64,
    pub volume_m3: f64,
    pub residence_min: f64,
    pub velocity_mps: f64,
    pub head_loss_m: f64,
    pub device_kind: DeviceKind,
    pub status: EdgeStatus,
    pub valve_open: Option<f64>,
    pub pump_head_m: Option<f64>,
    pub tracer_outlet: f64,
}

#[derive(Clone, Debug)]
pub struct HydraulicTrainSnapshot {
    pub id: String,
    pub clarifier_id: String,
    pub feed_flow_m3h: f64,
    pub ras_flow_m3h: f64,
    pub was_flow_m3h: f64,
}

#[derive(Clone, Debug)]
pub struct HydraulicTracerSnapshot {
    pub active: bool,
    pub mean_residence_min: f64,
    pub variance_min2: f64,
    pub peak_min: f64,
    pub peak_c: f64,
    pub injected_mass_kg: f64,
    pub retained_mass_kg: f64,
}

#[derive(Clone, Debug)]
pub struct HydraulicSnapshot {
    pub edge_count: usize,
    pub edges: Vec<HydraulicEdgeSnapshot>,
    pub trains: Vec<HydraulicTrainSnapshot>,
    pub tracer: HydraulicTracerSnapshot,
    pub errors: Vec<HydraulicError>,
}

struct TrainEntry {
    clarifier_id: String,
    feed: f64,
    ras: f64,
    was: f64,
}

/// Per-train feed/RAS/WAS aggregation by edge `train_id`.
pub fn hydraulic_train_view(state: &HydraulicState) -> Vec<HydraulicTrainSnapshot> {
    let mut trains: Vec<(String, TrainEntry)> = Vec::new();
    for edge in &state.edges {
        let Some(train_id) = edge.train_id.as_deref() else {
            continue;
        };
        let entry = if let Some(pos) = trains.iter().position(|(id, _)| id == train_id) {
            &mut trains[pos].1
        } else {
            trains.push((
                train_id.to_string(),
                TrainEntry {
                    clarifier_id: String::new(),
                    feed: 0.0,
                    ras: 0.0,
                    was: 0.0,
                },
            ));
            &mut trains.last_mut().expect("just pushed").1
        };
        match edge.recycle_kind {
            Some(RecycleKind::Ras) => {
                entry.ras += edge.flow_m3h;
                entry.clarifier_id = edge.from.clone();
            }
            Some(RecycleKind::Was) => entry.was += edge.flow_m3h,
            _ => entry.feed += edge.flow_m3h,
        }
    }
    trains
        .into_iter()
        .map(|(id, v)| HydraulicTrainSnapshot {
            id,
            clarifier_id: v.clarifier_id,
            feed_flow_m3h: round3(v.feed),
            ras_flow_m3h: round3(v.ras),
            was_flow_m3h: round3(v.was),
        })
        .collect()
}

pub fn hydraulic_view(
    state: Option<&HydraulicState>,
    trains: Option<Vec<HydraulicTrainSnapshot>>,
) -> Option<HydraulicSnapshot> {
    let state = state?;
    let edges: Vec<HydraulicEdgeSnapshot> = state
        .edges
        .iter()
        .map(|e| HydraulicEdgeSnapshot {
            id: e.id.clone(),
            from: e.from.clone(),
            to: e.to.clone(),
            stream: e.stream,
            flow_m3h: round3(e.flow_m3h),
            volume_m3: round3(e.volume_m3),
            residence_min: round3(e.residence_min),
            velocity_mps: round3(e.velocity_mps),
            head_loss_m: round3(e.head_loss_m),
            device_kind: e.device_kind,
            status: e.status,
            valve_open: e.valve_open,
            pump_head_m: e.pump_head_m.map(round3),
            tracer_outlet: round3(e.tracer_outlet),
        })
        .collect();
    Some(HydraulicSnapshot {
        edge_count: edges.len(),
        edges,
        trains: trains.unwrap_or_else(|| hydraulic_train_view(state)),
        tracer: HydraulicTracerSnapshot {
            active: state.tracer.active,
            mean_residence_min: round3(state.tracer.mean_residence_min),
            variance_min2: round3(state.tracer.variance_min2),
            peak_min: round3(state.tracer.peak_min),
            peak_c: round3(state.tracer.peak_c),
            injected_mass_kg: round3(state.tracer.injected_mass_kg),
            retained_mass_kg: round3(state.tracer.retained_mass_kg),
        },
        errors: state.errors.clone(),
    })
}

fn round3(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(device: DeviceKind, diameter_mm: f64, length_m: f64) -> EdgeGeometry {
        EdgeGeometry {
            length_m,
            diameter_mm,
            roughness_mm: 0.5,
            target_velocity_mps: 1.2,
            device_kind: device,
            valve_open: 1.0,
            valve_cv: 120.0,
            pump_rpm: 1450.0,
            pump_head0_m: 18.0,
            pump_k: 2.4e-5,
            weir_width_m: 1.0,
            weir_type: WeirType::Rectangular,
        }
    }

    #[test]
    fn equal_resistance_splits_evenly() {
        let out = split_by_resistance(
            100.0,
            &[
                SplitBranch {
                    edge_id: "a".into(),
                    resistance: 1.0,
                    closed: false,
                    capacity_m3h: f64::INFINITY,
                },
                SplitBranch {
                    edge_id: "b".into(),
                    resistance: 1.0,
                    closed: false,
                    capacity_m3h: f64::INFINITY,
                },
            ],
        );
        assert_eq!(out.status, SplitStatus::Ok);
        assert!((out.flows[0] - 50.0).abs() < 1e-9);
        assert!((out.flows[1] - 50.0).abs() < 1e-9);
    }

    #[test]
    fn lower_valve_opening_gets_less_flow() {
        let mut narrow = geo(DeviceKind::Valve, 0.0, 6.0);
        narrow.valve_open = 0.3;
        let mut wide = geo(DeviceKind::Valve, 0.0, 6.0);
        wide.valve_open = 0.7;
        let b30 = branch_hydraulics(&narrow, 1000.0, 1000.0);
        let b70 = branch_hydraulics(&wide, 1000.0, 1000.0);
        assert!(b30.resistance > b70.resistance);
        let out = split_by_resistance(
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
                    resistance: b70.resistance,
                    closed: false,
                    capacity_m3h: f64::INFINITY,
                },
            ],
        );
        assert!(out.flows[0] < out.flows[1]);
        assert!((out.flows.iter().sum::<f64>() - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn pump_curve_and_closed_branches_are_explicit() {
        let curve = PumpCurve {
            head0_m: 18.0,
            k: 2.4e-5,
            rpm: 1450.0,
            rated_rpm: 1450.0,
        };
        let ok = pump_head(&curve, 500.0);
        let over = pump_head(&curve, ok.max_flow_m3h * 1.5);
        assert!(!ok.over_curve);
        assert!(over.over_curve);

        let closed = split_by_resistance(
            80.0,
            &[
                SplitBranch {
                    edge_id: "a".into(),
                    resistance: f64::INFINITY,
                    closed: true,
                    capacity_m3h: f64::INFINITY,
                },
                SplitBranch {
                    edge_id: "b".into(),
                    resistance: f64::INFINITY,
                    closed: true,
                    capacity_m3h: f64::INFINITY,
                },
            ],
        );
        assert_eq!(closed.status, SplitStatus::Unsolvable);
        assert_eq!(closed.error_code, Some(HYDRAULICS_ERRORS.unsolvable_split));
    }

    #[test]
    fn tracer_mass_balance_closes_on_single_edge() {
        let spec = HydraulicEdgeSpec {
            id: "pipe".into(),
            from: "a".into(),
            to: "b".into(),
            stream: StreamKind::MixedLiquor,
            train_id: Some("A".into()),
            recycle_kind: None,
            geometry: geo(DeviceKind::None, 500.0, 40.0),
        };
        let mut h = create_hydraulics(&[spec], 600.0);
        h.edges[0].tracer_segments = vec![0.0; h.edges[0].tracer_segments.len()];
        inject_tracer(&mut h, "pipe", 30.0, 600.0);
        let mut flows = HashMap::new();
        flows.insert("pipe".to_string(), 600.0);
        let outlets = ["pipe".to_string()];
        for i in 1..=40 {
            let input = HydraulicsStepInput {
                flows: &flows,
                dt_min: 1.0,
                time_min: i as f64,
                tracer_feed: None,
                component_feed: None,
                outlet_edge_ids: Some(&outlets),
            };
            step_hydraulics(&mut h, &input);
            refresh_rtd_metrics(&mut h, 1.0);
        }
        assert!(h.tracer.peak_c > 0.0);
        assert!(h.tracer.mean_residence_min > 0.0);
        let balance = tracer_mass_balance(&h);
        assert!((balance.injected_kg - 30.0).abs() < 1e-9);
        assert!(balance.balance_residual_kg.abs() < 30.0 * 0.1);
    }
}

//! M1b phase 2, ASM1 reactor reaction integration.
//!
//! Ports the `asm1` branch of `solveReactors`: 13-component CSTR integration,
//! temperature/pH/free-ammonia/toxicity suppression, KLa DO control and the
//! aggregate-to-ASM1 round trip. ASM2d remains out of scope for this slice.

use std::collections::HashMap;

use aquapilot_core::asm1::{self as core_asm1, State};

use crate::asm1mix::{Asm1State, COMPONENTS, SALK, SNH, SNO, SO, SS, to_asm1};
use crate::inflow::{IncomingEdge, ReactorComposition, aggregate_inflow};
use crate::influent::Influent;
use crate::reactors::{ReactorFlux, ReactorKind};

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_nan() || min.is_nan() || max.is_nan() {
        return f64::NAN;
    }
    value.max(min).min(max)
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

pub fn ph_from_alkalinity(s_alk_mol: f64) -> f64 {
    let alkalinity_mg_l = js_max(0.0, s_alk_mol) * 50.0;
    clamp(6.6 + 0.004 * (alkalinity_mg_l - 40.0), 5.8, 8.7)
}

fn free_ammonia_mg_l(nh_mg_l: f64, ph: f64, temperature_c: f64) -> f64 {
    let pka = 9.25 - 0.03 * (temperature_c - 25.0);
    let fraction = 1.0 / (1.0 + 10f64.powf(pka - ph));
    js_max(0.0, nh_mg_l) * fraction
}

fn process_inhibition(process: usize, s_nh: f64, ph: f64, temperature_c: f64) -> f64 {
    // Process order: 0 aerobic heterotrophs, 1 anoxic heterotrophs,
    // 2 autotrophs, 3 decay heterotrophs, 4 decay autotrophs,
    // 5 ammonification, 6 hydrolysis organics, 7 hydrolysis organic N.
    if process == 3 || process == 4 {
        return 1.0;
    }
    let is_autotroph = process == 2;
    let threshold = if is_autotroph { 7.2 } else { 6.2 };
    let width = if is_autotroph { 0.45 } else { 0.4 };
    let stress = js_max(0.0, threshold - ph);
    let ph_factor = 1.0 / (1.0 + (stress / width).powi(2));
    if process != 0 && process != 1 && process != 2 {
        return ph_factor;
    }
    let nh3 = free_ammonia_mg_l(s_nh, ph, temperature_c);
    let ammonia_factor = 1.0 / (1.0 + nh3 / if is_autotroph { 40.0 } else { 120.0 });
    ph_factor * ammonia_factor
}

fn toxic_factor(process: usize, suppression: f64) -> f64 {
    if suppression >= 0.999 {
        1.0
    } else if process == 2 || process == 4 {
        js_max(0.0, suppression).powi(2)
    } else {
        js_max(0.0, suppression).sqrt()
    }
}

/// Temperature is bucketed at 0.1 °C, matching the TS `rateFunctionsAt` cache
/// key. Without this the Rust port would silently evaluate a slightly different
/// Arrhenius factor for temperatures such as 19.97 °C.
fn bucket_temperature(temperature_c: f64) -> f64 {
    (temperature_c * 10.0).round() / 10.0
}

fn to_core_state(state: &Asm1State) -> State {
    State {
        s_i: state.get(crate::asm1mix::SI),
        s_s: state.get(SS),
        x_i: state.get(crate::asm1mix::XI),
        x_s: state.get(crate::asm1mix::XS),
        x_b_h: state.get(crate::asm1mix::XBH),
        x_b_a: state.get(crate::asm1mix::XBA),
        x_p: state.get(crate::asm1mix::XP),
        s_o: state.get(SO),
        s_no: state.get(SNO),
        s_nh: state.get(SNH),
        s_nd: state.get(crate::asm1mix::SND),
        x_nd: state.get(crate::asm1mix::XND),
        s_alk: state.get(SALK),
    }
}

/// `reactionRatesWithSuppression`: base ASM1 rates × 1/24 × toxicity × pH/NH₃.
fn reaction_rates_with_suppression(
    state: &Asm1State,
    suppression: f64,
    temperature_c: f64,
    ph: f64,
) -> Asm1State {
    let core_state = to_core_state(state);
    let bucketed = bucket_temperature(temperature_c);
    let base = core_asm1::rates(&core_state, core_asm1::PARAMS, bucketed);
    let stoich = core_asm1::stoichiometry(core_asm1::PARAMS);
    let mut out = Asm1State::from_values([0.0; COMPONENTS]);
    for process in 0..8 {
        let toxic = toxic_factor(process, suppression);
        let inhibition = process_inhibition(process, state.get(SNH), ph, temperature_c);
        let rho = base[process] * (1.0 / 24.0) * toxic * inhibition;
        if !rho.is_finite() || rho <= 0.0 {
            continue;
        }
        for (component, coef) in stoich[process].iter().enumerate().take(COMPONENTS) {
            if *coef == 0.0 {
                continue;
            }
            let index = component_index(component);
            out.set(index, out.get(index) + coef * rho);
        }
    }
    out
}

fn component_index(component: usize) -> usize {
    match component {
        0 => crate::asm1mix::SI,
        1 => SS,
        2 => crate::asm1mix::XI,
        3 => crate::asm1mix::XS,
        4 => crate::asm1mix::XBH,
        5 => crate::asm1mix::XBA,
        6 => crate::asm1mix::XP,
        7 => SO,
        8 => SNO,
        9 => SNH,
        10 => crate::asm1mix::SND,
        11 => crate::asm1mix::XND,
        12 => SALK,
        _ => unreachable!("ASM1 has 13 components"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Asm1Aggregate {
    pub cod: f64,
    pub nh: f64,
    pub no3: f64,
    pub tp: f64,
    pub ss: f64,
    pub do_level: f64,
    pub alkalinity: f64,
}

/// `fromAsm1`: 13 components back to the aggregate values the UI and alarms use.
pub fn from_asm1(state: &Asm1State) -> Asm1Aggregate {
    let particulate = state.particulate_sum();
    Asm1Aggregate {
        cod: state.get(crate::asm1mix::SI) + state.get(SS) + particulate,
        nh: state.get(SNH),
        no3: state.get(SNO),
        tp: 0.0,
        ss: particulate / 1.42,
        do_level: state.get(SO),
        alkalinity: state.get(SALK) * 50.0,
    }
}

#[derive(Debug, Clone)]
pub struct Asm1ReactorState {
    pub id: String,
    pub kind: ReactorKind,
    pub volume: f64,
    pub cod: f64,
    pub nh: f64,
    pub no3: f64,
    pub tp: f64,
    pub do_level: f64,
    pub alkalinity: f64,
    pub temperature: f64,
    pub asm1: Option<Asm1State>,
    pub o2_demand: f64,
    pub kla: f64,
    pub do_integral: f64,
    pub inflow: f64,
}

#[derive(Debug, Clone)]
pub struct Asm1ReactorsInput {
    pub reactors: Vec<Asm1ReactorState>,
    pub order: Vec<String>,
    pub incoming_by_reactor: HashMap<String, Vec<IncomingEdge>>,
    pub edge_flow: HashMap<String, f64>,
    pub influent: Influent,
    pub dt_h: f64,
    pub x_biomass: f64,
    pub x_ras: f64,
    pub temperature_c: f64,
    pub suppression: f64,
    pub carbon_dose: f64,
    pub do_setpoint: f64,
    pub aeration_capacity: f64,
}

fn composition(reactor: &Asm1ReactorState) -> ReactorComposition {
    ReactorComposition {
        cod: reactor.cod,
        nh: reactor.nh,
        no3: reactor.no3,
        tp: reactor.tp,
        alkalinity: reactor.alkalinity,
    }
}

fn composition_map(reactors: &[Asm1ReactorState]) -> HashMap<String, ReactorComposition> {
    reactors
        .iter()
        .map(|reactor| (reactor.id.clone(), composition(reactor)))
        .collect()
}

fn terminal_composition(input: &Asm1ReactorsInput) -> ReactorComposition {
    input
        .order
        .last()
        .and_then(|id| input.reactors.iter().find(|r| &r.id == id))
        .or_else(|| input.reactors.first())
        .map(composition)
        .unwrap_or_default()
}

fn asm1_map(reactors: &[Asm1ReactorState]) -> HashMap<String, Asm1State> {
    reactors
        .iter()
        .filter_map(|reactor| reactor.asm1.map(|state| (reactor.id.clone(), state)))
        .collect()
}

fn terminal_asm1(input: &Asm1ReactorsInput) -> Option<Asm1State> {
    input
        .order
        .last()
        .and_then(|id| input.reactors.iter().find(|r| &r.id == id))
        .or_else(|| input.reactors.first())
        .and_then(|reactor| reactor.asm1)
}

/// Integrate the ASM1 reactors in topological order. Mirrors the TS branch
/// including the initialization rule (`max(cod, 150)` and current MLSS) and the
/// TP inert-tracer update.
pub fn solve_reactors_asm1(input: &mut Asm1ReactorsInput) -> ReactorFlux {
    let mut flux = ReactorFlux::default();

    for id in input.order.clone() {
        let Some(index) = input.reactors.iter().position(|reactor| reactor.id == id) else {
            continue;
        };
        let incoming = input
            .incoming_by_reactor
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let terminal = terminal_composition(input);
        let by_id = composition_map(&input.reactors);
        let mixed = aggregate_inflow(
            &incoming,
            &input.edge_flow,
            &by_id,
            Some(&terminal),
            &input.influent,
        );
        if mixed.q_in <= 0.0 {
            input.reactors[index].inflow = 0.0;
            continue;
        }

        if input.reactors[index].asm1.is_none() {
            let reactor = &input.reactors[index];
            input.reactors[index].asm1 = Some(to_asm1(
                js_max(reactor.cod, 150.0),
                reactor.nh,
                reactor.no3,
                reactor.do_level,
                reactor.alkalinity,
                input.x_biomass,
            ));
        }
        input.reactors[index].inflow = mixed.q_in;
        input.reactors[index].temperature = input.temperature_c;

        let reactor = input.reactors[index].clone();
        let current = reactor.asm1.expect("initialized above");
        let q_over_v = mixed.q_in / js_max(1.0, reactor.volume);
        let asm_map = asm1_map(&input.reactors);
        let last_asm1 = terminal_asm1(input);
        let asm_in = crate::asm1mix::aggregate_asm1_inflow(
            &incoming,
            &input.edge_flow,
            &asm_map,
            last_asm1.as_ref(),
            input.x_ras,
            &input.influent,
        );

        let ph = ph_from_alkalinity(current.get(SALK));
        let rates =
            reaction_rates_with_suppression(&current, input.suppression, input.temperature_c, ph);
        let mut next = current;

        // Dissolved and particulate components share the same CSTR form:
        // dC/dt = (Q/V)(C_in − C) + r. The inflow already includes RAS and
        // internal recycle, which is what keeps biomass from being washed out.
        for component in 0..COMPONENTS {
            if component == SALK {
                continue;
            }
            let value = current.get(component)
                + input.dt_h
                    * (q_over_v * (asm_in.get(component) - current.get(component))
                        + rates.get(component));
            next.set(component, js_max(0.0, value));
        }

        let external_carbon = if reactor.kind == ReactorKind::Anoxic {
            input.carbon_dose
        } else {
            0.0
        };
        if external_carbon > 0.0 {
            next.set(
                SS,
                js_max(0.0, next.get(SS) + input.dt_h * q_over_v * external_carbon),
            );
        }
        next.set(
            SALK,
            js_max(
                0.0,
                current.get(SALK) + input.dt_h * q_over_v * (asm_in.get(SALK) - current.get(SALK)),
            ),
        );

        let our = js_max(0.0, -rates.get(SO));
        if reactor.kind == ReactorKind::Aerobic && input.aeration_capacity > 0.02 {
            let aeration =
                aquapilot_core::aeration::step_aeration(aquapilot_core::aeration::AerationInput {
                    volume: reactor.volume,
                    temperature_c: input.temperature_c,
                    do_level: current.get(SO),
                    o2_demand: our,
                    do_setpoint: input.do_setpoint,
                    capacity: input.aeration_capacity,
                    previous_kla: reactor.kla,
                    previous_integral: reactor.do_integral,
                    dt_h: input.dt_h,
                });
            next.set(SO, aeration.do_level);
            input.reactors[index].kla = aeration.kla;
            input.reactors[index].do_integral = aeration.integral;
            flux.o2_transferred_kg_h += aeration.o2_transferred_kg_h;
        } else {
            input.reactors[index].kla = 0.0;
            input.reactors[index].do_integral = 0.0;
            next.set(SO, js_max(0.0, next.get(SO) - input.dt_h * 0.5));
        }

        input.reactors[index].asm1 = Some(next);
        let aggregate = from_asm1(&next);
        let target = &mut input.reactors[index];
        target.cod = js_max(2.0, aggregate.cod);
        target.nh = js_max(0.01, aggregate.nh);
        target.no3 = js_max(0.01, aggregate.no3);
        target.do_level = aggregate.do_level;
        target.alkalinity = aggregate.alkalinity;
        target.o2_demand = our;
        flux.o2_demand_kg_h += our * reactor.volume / 1000.0;
        flux.cod_oxidized_kg_h += js_max(0.0, -rates.get(SS)) * reactor.volume / 1000.0;
        flux.nh_oxidized_kg_h += js_max(0.0, -rates.get(SNH)) * reactor.volume / 1000.0;

        // ASM1 has no phosphorus state; TP is a conservative hydraulic tracer.
        target.tp = js_max(
            0.005,
            (reactor.tp + input.dt_h * q_over_v * mixed.tp_in) / (1.0 + input.dt_h * q_over_v),
        );
    }

    flux.balanced_oxidized_kg_h = js_max(
        0.0,
        (flux.o2_demand_kg_h - flux.nh_oxidized_kg_h * 4.57) / 0.9,
    );
    flux
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm1mix::{SALK, SNH, SS, XBH};

    #[test]
    fn ph_proxy_is_bounded_and_monotonic() {
        assert!((ph_from_alkalinity(0.0) - 6.44).abs() < 1e-12);
        assert_eq!(ph_from_alkalinity(100.0), 8.7);
        assert!(ph_from_alkalinity(4.0) < ph_from_alkalinity(7.0));
    }

    #[test]
    fn aggregate_round_trip_keeps_cod_and_nitrogen() {
        let state = to_asm1(600.0, 30.0, 3.0, 2.0, 200.0, 3400.0);
        let aggregate = from_asm1(&state);
        assert!((aggregate.cod - state.values.iter().take(7).sum::<f64>()).abs() < 1e-9);
        assert_eq!(aggregate.nh, state.get(SNH));
        assert_eq!(aggregate.alkalinity, state.get(SALK) * 50.0);
        assert_eq!(aggregate.tp, 0.0);
    }

    #[test]
    fn toxicity_hits_autotrophs_harder_than_heterotrophs() {
        let mut state = Asm1State::empty();
        state.set(XBH, 2000.0);
        state.set(crate::asm1mix::XBA, 500.0);
        state.set(SS, 80.0);
        state.set(SNH, 30.0);
        state.set(SALK, 7.0);
        state.set(SO, 2.0);
        let clean = reaction_rates_with_suppression(&state, 1.0, 20.0, 7.2);
        let toxic = reaction_rates_with_suppression(&state, 0.2, 20.0, 7.2);
        let clean_autotroph = clean.get(crate::asm1mix::XBA).max(0.0);
        let toxic_autotroph = toxic.get(crate::asm1mix::XBA).max(0.0);
        let clean_hetero = (-clean.get(SS)).max(0.0);
        let toxic_hetero = (-toxic.get(SS)).max(0.0);
        assert!(toxic_autotroph < clean_autotroph * 0.1);
        assert!(toxic_hetero < clean_hetero);
        assert!(toxic_hetero / clean_hetero > toxic_autotroph / clean_autotroph.max(1e-12));
    }
}

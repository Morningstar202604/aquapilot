//! M1b phase 2, simple-model reactor integration.
//!
//! Ports the `simple` branch of `solveReactors` for one or more reactors in
//! topological order. ASM1 reaction integration and the ASM2d network branch
//! remain out of scope for this slice.

use std::collections::HashMap;

use serde::Deserialize;

use crate::inflow::{IncomingEdge, ReactorComposition, aggregate_inflow};
use crate::influent::Influent;
use crate::kinetics::{
    ALK_PER_NH, ALK_PER_NO3, DO_SAT_20, K_COD_AEROBIC, K_COD_ANAEROBIC, K_COD_ANOXIC, K_DEN, K_NIT,
    K_P_REL, K_P_UP, KS_COD, KS_NH, KS_O2, KS_O2_NIT, NITRATE_YIELD_PER_NITRIFIED_N, O2_PER_COD,
    O2_PER_NH,
};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReactorKind {
    Anaerobic,
    Anoxic,
    Aerobic,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleReactorState {
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
    pub o2_demand: f64,
    pub kla: f64,
    pub inflow: f64,
}

#[derive(Debug, Clone)]
pub struct SimpleReactorsInput {
    pub reactors: Vec<SimpleReactorState>,
    pub order: Vec<String>,
    pub incoming_by_reactor: HashMap<String, Vec<IncomingEdge>>,
    pub edge_flow: HashMap<String, f64>,
    pub influent: Influent,
    pub dt_h: f64,
    pub bf: f64,
    pub temperature_c: f64,
    pub theta_h: f64,
    pub theta_n: f64,
    pub suppression: f64,
    pub carbon_dose: f64,
    pub alk_dose: f64,
    pub do_setpoint: f64,
    pub aeration_capacity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactorFlux {
    pub o2_demand_kg_h: f64,
    pub cod_oxidized_kg_h: f64,
    pub balanced_oxidized_kg_h: f64,
    pub o2_transferred_kg_h: f64,
    pub nh_oxidized_kg_h: f64,
    pub denitrified_n_kg_h: f64,
    pub clamp_cod_kg_h: f64,
    pub clamp_n_kg_h: f64,
    pub clamp_p_kg_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SimpleReactorRates {
    pub cod_rate: f64,
    pub nh_rate: f64,
    pub no3_rate: f64,
    pub tp_rate: f64,
    pub o2_rate: f64,
}

fn composition(reactor: &SimpleReactorState) -> ReactorComposition {
    ReactorComposition {
        cod: reactor.cod,
        nh: reactor.nh,
        no3: reactor.no3,
        tp: reactor.tp,
        alkalinity: reactor.alkalinity,
    }
}

fn composition_map(reactors: &[SimpleReactorState]) -> HashMap<String, ReactorComposition> {
    reactors
        .iter()
        .map(|r| (r.id.clone(), composition(r)))
        .collect()
}

fn terminal_composition(input: &SimpleReactorsInput) -> ReactorComposition {
    input
        .order
        .last()
        .and_then(|id| input.reactors.iter().find(|r| &r.id == id))
        .or_else(|| input.reactors.first())
        .map(composition)
        .unwrap_or_default()
}

fn rates(reactor: &SimpleReactorState, input: &SimpleReactorsInput) -> SimpleReactorRates {
    let f_cod = reactor.cod / (KS_COD + reactor.cod);
    let f_nh = reactor.nh / (KS_NH + reactor.nh);
    let f_o2 = reactor.do_level / (KS_O2 + reactor.do_level);
    let f_o2_nit = reactor.do_level / (KS_O2_NIT + reactor.do_level);

    match reactor.kind {
        ReactorKind::Anaerobic => SimpleReactorRates {
            cod_rate: -K_COD_ANAEROBIC * f_cod * input.bf * input.suppression * reactor.cod,
            nh_rate: 0.0,
            no3_rate: 0.0,
            tp_rate: K_P_REL * f_cod * input.bf * input.suppression,
            o2_rate: 0.0,
        },
        ReactorKind::Anoxic => {
            let f_no3 = reactor.no3 / (1.0 + reactor.no3);
            let hetero = K_COD_ANOXIC * f_cod * input.bf * input.suppression * reactor.cod;
            let denit = K_DEN * f_no3 * f_cod * input.bf * input.suppression * 3.5;
            SimpleReactorRates {
                cod_rate: -hetero,
                nh_rate: 0.0,
                no3_rate: -denit,
                tp_rate: K_P_REL * 0.1 * f_cod * input.bf,
                o2_rate: 0.0,
            }
        }
        ReactorKind::Aerobic => {
            let hetero = K_COD_AEROBIC
                * f_cod
                * f_o2
                * input.theta_h
                * input.bf
                * input.suppression
                * reactor.cod;
            let nh_rate = -K_NIT
                * f_nh
                * f_o2_nit
                * input.theta_n
                * input.bf
                * input.suppression
                * if reactor.alkalinity > 30.0 {
                    1.0
                } else {
                    reactor.alkalinity / 30.0
                };
            let tp_rate =
                -K_P_UP * (reactor.tp / (0.25 + reactor.tp)) * f_o2 * input.bf * input.suppression;
            SimpleReactorRates {
                cod_rate: -hetero,
                nh_rate,
                no3_rate: 0.0,
                tp_rate,
                o2_rate: hetero * O2_PER_COD + -nh_rate * O2_PER_NH,
            }
        }
    }
}

/// Integrate the simple-model reactors in place. Returns the same flux fields
/// that `solveReactors` returns for the simple branch.
pub fn solve_reactors_simple(input: &mut SimpleReactorsInput) -> ReactorFlux {
    let mut flux = ReactorFlux::default();

    for id in input.order.clone() {
        let Some(index) = input.reactors.iter().position(|r| r.id == id) else {
            continue;
        };
        let incoming = input
            .incoming_by_reactor
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let by_id = composition_map(&input.reactors);
        let terminal = terminal_composition(input);
        let inflow = aggregate_inflow(
            &incoming,
            &input.edge_flow,
            &by_id,
            Some(&terminal),
            &input.influent,
        );
        if inflow.q_in <= 0.0 {
            input.reactors[index].inflow = 0.0;
            continue;
        }

        let reactor = input.reactors[index].clone();
        input.reactors[index].inflow = inflow.q_in;
        input.reactors[index].temperature = input.temperature_c;
        let q_over_v = inflow.q_in / js_max(1.0, reactor.volume);
        let r = rates(&reactor, input);
        let external_carbon = if reactor.kind == ReactorKind::Anoxic {
            input.carbon_dose
        } else {
            0.0
        };

        let cod = js_max(
            2.0,
            (reactor.cod
                + input.dt_h * (q_over_v * (inflow.cod_in + external_carbon) + r.cod_rate))
                / (1.0 + input.dt_h * q_over_v),
        );
        let nh = js_max(
            0.01,
            (reactor.nh + input.dt_h * (q_over_v * inflow.nh_in + r.nh_rate))
                / (1.0 + input.dt_h * q_over_v),
        );
        let n_oxidized = js_max(0.0, -r.nh_rate) * input.dt_h;
        let dn = js_max(0.0, -r.no3_rate) * input.dt_h;
        let no3 = js_max(
            0.01,
            (reactor.no3
                + input.dt_h * q_over_v * inflow.no3_in
                + n_oxidized * NITRATE_YIELD_PER_NITRIFIED_N
                - dn)
                / (1.0 + input.dt_h * q_over_v),
        );
        let tp = js_max(
            0.005,
            (reactor.tp + input.dt_h * (q_over_v * inflow.tp_in + r.tp_rate))
                / (1.0 + input.dt_h * q_over_v),
        );
        let alk_consumed = n_oxidized * ALK_PER_NH - dn * ALK_PER_NO3;
        let alkalinity = js_max(
            10.0,
            (reactor.alkalinity + input.dt_h * q_over_v * (inflow.alk_in + input.alk_dose)
                - alk_consumed)
                / (1.0 + input.dt_h * q_over_v),
        );

        let (do_level, o2_demand, kla) = if reactor.kind == ReactorKind::Aerobic {
            let our = js_max(0.0, r.o2_rate);
            let capacity = input.aeration_capacity;
            let dsat = DO_SAT_20 - 0.11 * (input.temperature_c - 20.0);
            let kla_need = if capacity > 0.02 {
                our / js_max(0.35, dsat - input.do_setpoint)
            } else {
                0.0
            };
            let kla = clamp(kla_need, if capacity > 0.02 { 0.8 } else { 0.0 }, 165.0);
            let effective = kla * capacity;
            let do_target = if effective > 0.02 {
                dsat - our / effective
            } else {
                0.02
            };
            let tau = clamp(1.4 / js_max(0.2, effective), 0.02, 0.45);
            let do_level = clamp(
                reactor.do_level
                    + (clamp(do_target, 0.02, dsat) - reactor.do_level)
                        * clamp(input.dt_h / tau, 0.0, 1.0),
                0.02,
                dsat,
            );
            (do_level, our, effective)
        } else {
            (
                clamp((-3.0 * input.dt_h).exp() * reactor.do_level, 0.02, 0.9),
                0.0,
                0.0,
            )
        };

        input.reactors[index].cod = cod;
        input.reactors[index].nh = nh;
        input.reactors[index].no3 = no3;
        input.reactors[index].tp = tp;
        input.reactors[index].alkalinity = alkalinity;
        input.reactors[index].do_level = do_level;
        input.reactors[index].o2_demand = o2_demand;
        input.reactors[index].kla = kla;

        flux.o2_demand_kg_h += (o2_demand * reactor.volume) / 1000.0;
        flux.cod_oxidized_kg_h += (js_max(0.0, -r.cod_rate) * reactor.volume) / 1000.0;
        flux.nh_oxidized_kg_h += (js_max(0.0, -r.nh_rate) * reactor.volume) / 1000.0;
        flux.denitrified_n_kg_h += (js_max(0.0, -r.no3_rate) * reactor.volume) / 1000.0;
    }

    flux.balanced_oxidized_kg_h = js_max(
        0.0,
        (flux.o2_demand_kg_h - flux.nh_oxidized_kg_h * O2_PER_NH) / O2_PER_COD,
    );
    flux
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(id: &str, kind: ReactorKind) -> SimpleReactorState {
        SimpleReactorState {
            id: id.to_string(),
            kind,
            volume: 1000.0,
            cod: 200.0,
            nh: 20.0,
            no3: 5.0,
            tp: 3.0,
            do_level: 2.0,
            alkalinity: 200.0,
            temperature: 20.0,
            o2_demand: 0.0,
            kla: 0.0,
            inflow: 0.0,
        }
    }

    #[test]
    fn aerobic_reactor_consumes_cod_and_ammonia() {
        let mut aerobic = state("a", ReactorKind::Aerobic);
        aerobic.cod = 500.0;
        aerobic.nh = 60.0;
        let mut input = SimpleReactorsInput {
            reactors: vec![aerobic],
            order: vec!["a".to_string()],
            incoming_by_reactor: HashMap::from([(
                "a".to_string(),
                vec![IncomingEdge {
                    id: "feed".to_string(),
                    from: "plant".to_string(),
                    recycle_kind: None,
                }],
            )]),
            edge_flow: HashMap::from([("feed".to_string(), 1000.0)]),
            influent: Influent::default(),
            dt_h: 1.0 / 60.0,
            bf: 1.0,
            temperature_c: 20.0,
            theta_h: 1.0,
            theta_n: 1.0,
            suppression: 1.0,
            carbon_dose: 0.0,
            alk_dose: 0.0,
            do_setpoint: 2.0,
            aeration_capacity: 1.0,
        };
        let flux = solve_reactors_simple(&mut input);
        assert!(input.reactors[0].cod < 500.0);
        assert!(input.reactors[0].nh < 60.0);
        assert!(flux.cod_oxidized_kg_h > 0.0);
    }

    #[test]
    fn zero_inflow_does_not_update_reactor() {
        let mut input = SimpleReactorsInput {
            reactors: vec![state("a", ReactorKind::Aerobic)],
            order: vec!["a".to_string()],
            incoming_by_reactor: HashMap::new(),
            edge_flow: HashMap::new(),
            influent: Influent::default(),
            dt_h: 1.0 / 60.0,
            bf: 1.0,
            temperature_c: 20.0,
            theta_h: 1.0,
            theta_n: 1.0,
            suppression: 1.0,
            carbon_dose: 0.0,
            alk_dose: 0.0,
            do_setpoint: 2.0,
            aeration_capacity: 1.0,
        };
        let flux = solve_reactors_simple(&mut input);
        assert_eq!(input.reactors[0].cod, 200.0);
        assert_eq!(input.reactors[0].inflow, 0.0);
        assert_eq!(flux.o2_demand_kg_h, 0.0);
    }
}

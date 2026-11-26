//! M1b phase 2, ASM1 mixing slice.
//!
//! Ports `aggregateAsm1Inflow` plus the two mappings it needs from
//! `asm1Mapping.ts`: `toAsm1` / `influentToAsm1`. State is stored as the same
//! 13-component order as `ASM1_COMPONENTS`, so the loop order matches TS.

use std::collections::HashMap;

use crate::inflow::IncomingEdge;
use crate::influent::Influent;

pub const COMPONENTS: usize = 13;
pub const SI: usize = 0;
pub const SS: usize = 1;
pub const XI: usize = 2;
pub const XS: usize = 3;
pub const XBH: usize = 4;
pub const XBA: usize = 5;
pub const XP: usize = 6;
pub const SO: usize = 7;
pub const SNO: usize = 8;
pub const SNH: usize = 9;
pub const SND: usize = 10;
pub const XND: usize = 11;
pub const SALK: usize = 12;

const COD_PER_VSS: f64 = 1.42;

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Asm1State {
    pub values: [f64; COMPONENTS],
}

impl Asm1State {
    pub fn empty() -> Self {
        let mut values = [0.0; COMPONENTS];
        values[SALK] = 7.0;
        Self { values }
    }

    pub fn from_values(values: [f64; COMPONENTS]) -> Self {
        Self { values }
    }

    pub fn get(&self, index: usize) -> f64 {
        self.values[index]
    }

    pub fn set(&mut self, index: usize, value: f64) {
        self.values[index] = value;
    }

    pub fn particulate_sum(&self) -> f64 {
        self.values[XI] + self.values[XS] + self.values[XBH] + self.values[XBA] + self.values[XP]
    }

    fn ras_scaled(&self, ratio: f64) -> Self {
        let mut out = *self;
        for index in [XI, XS, XBH, XBA, XP] {
            out.values[index] = self.values[index] * ratio;
        }
        out
    }
}

/// `toAsm1`: aggregate COD/NH/NO3/DO/alkalinity/MLSS to 13 components.
#[allow(clippy::too_many_arguments)]
pub fn to_asm1(
    cod: f64,
    nh: f64,
    no3: f64,
    do_level: f64,
    alkalinity: f64,
    mlss: f64,
) -> Asm1State {
    let total_cod = js_max(1.0, cod);
    let inert_soluble = total_cod * 0.08;
    let soluble_readily = total_cod * 0.18;
    let inert_particulate = total_cod * 0.2;
    let remaining = total_cod * 0.54;
    let biomass_from_mlss = if mlss > 0.0 {
        mlss * 0.75 * COD_PER_VSS
    } else {
        0.0
    };
    let biomass = if biomass_from_mlss > 0.0 {
        biomass_from_mlss
    } else {
        0.0
    };
    let slowly_biodegradable = js_max(0.0, remaining - js_min(remaining, biomass));

    let mut state = Asm1State::empty();
    state.set(SI, inert_soluble);
    state.set(SS, soluble_readily);
    state.set(XI, inert_particulate);
    state.set(XS, slowly_biodegradable);
    state.set(XBH, biomass * 0.8);
    state.set(XBA, biomass * 0.2);
    state.set(XP, 0.0);
    state.set(SO, do_level);
    state.set(SNO, no3);
    state.set(SNH, nh);
    state.set(SND, nh * 0.1);
    state.set(XND, nh * 0.15);
    state.set(SALK, alkalinity / 50.0);
    state
}

/// `influentToAsm1`: raw influent has no active biomass and no nitrate.
pub fn influent_to_asm1(influent: &Influent) -> Asm1State {
    to_asm1(
        influent.cod,
        influent.nh,
        0.0,
        0.0,
        influent.alkalinity,
        0.0,
    )
}

/// `aggregateAsm1Inflow`: 13-component flow-weighted mix, including RAS
/// particulate thickening by the settler concentration ratio.
pub fn aggregate_asm1_inflow(
    incoming: &[IncomingEdge],
    edge_flow: &HashMap<String, f64>,
    by_asm1: &HashMap<String, Asm1State>,
    last_asm1: Option<&Asm1State>,
    x_ras: f64,
    influent: &Influent,
) -> Asm1State {
    let ratio = match last_asm1 {
        Some(last) => {
            let feed_ss = last.particulate_sum();
            if feed_ss <= 1.0 {
                1.0
            } else {
                js_max(1.0, js_min(6.0, x_ras / feed_ss))
            }
        }
        None => 1.0,
    };

    let mut asm_in = Asm1State::empty();
    let mut q_acc = 0.0;
    for edge in incoming {
        let flow = edge_flow.get(&edge.id).copied().unwrap_or(0.0);
        if flow <= 0.0 {
            continue;
        }
        let src = match (edge.recycle_kind, last_asm1) {
            (Some(crate::inflow::RecycleKind::Ras), Some(last)) => last.ras_scaled(ratio),
            (Some(crate::inflow::RecycleKind::Internal), Some(last)) => *last,
            _ => by_asm1
                .get(&edge.from)
                .copied()
                .unwrap_or_else(|| influent_to_asm1(influent)),
        };

        if q_acc == 0.0 {
            asm_in = src;
        } else {
            for i in 0..COMPONENTS {
                asm_in.values[i] =
                    (asm_in.values[i] * q_acc + src.values[i] * flow) / (q_acc + flow);
            }
        }
        q_acc += flow;
    }
    asm_in
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(id: &str, from: &str, kind: Option<crate::inflow::RecycleKind>) -> IncomingEdge {
        IncomingEdge {
            id: id.to_string(),
            from: from.to_string(),
            recycle_kind: kind,
        }
    }

    #[test]
    fn influent_mapping_has_no_biomass() {
        let influent = Influent {
            cod: 400.0,
            nh: 35.0,
            alkalinity: 320.0,
            ..Influent::default()
        };
        let asm = influent_to_asm1(&influent);
        assert_eq!(asm.get(XBH), 0.0);
        assert_eq!(asm.get(XBA), 0.0);
        assert_eq!(asm.get(SI), 32.0);
        assert_eq!(asm.get(SS), 72.0);
        assert_eq!(asm.get(XI), 80.0);
        assert_eq!(asm.get(SALK), 6.4);
    }

    #[test]
    fn ras_scales_particulates_only() {
        let mut flows = HashMap::new();
        flows.insert("ras".to_string(), 100.0);
        let mut last = Asm1State::empty();
        last.set(XBH, 1000.0);
        last.set(SNH, 2.0);
        let mut by = HashMap::new();
        by.insert("a".to_string(), last);
        let out = aggregate_asm1_inflow(
            &[edge("ras", "a", Some(crate::inflow::RecycleKind::Ras))],
            &flows,
            &by,
            Some(&last),
            3000.0,
            &Influent::default(),
        );
        assert!((out.get(XBH) - 3000.0).abs() < 1e-12);
        assert_eq!(out.get(SNH), 2.0);
    }
}

//! Whole-plant step projections used by the production trace replay.
//!
//! These functions deliberately mirror the *production* `stepNetwork` formulas for
//! effluent, inventory and biomass/SRT, not the older single-reactor helpers. They
//! take already-updated reactor states and return the same scalar outputs the
//! TypeScript engine publishes, so a trace can compare the two kernels without
//! re-running the control layer.

use crate::asm2d::{COD_PER_VSS, Component, Params, State, n_concentration, p_concentration};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EffluentInput {
    pub flow: f64,
    pub last_nh: f64,
    pub last_no3: f64,
    pub last_tp: f64,
    pub last_alkalinity: f64,
    pub soluble_cod: f64,
    pub x_eff: f64,
    pub temperature_c: f64,
    pub pac_dose: f64,
    pub pac_p_per_mg: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ProductionEffluent {
    pub flow: f64,
    pub cod: f64,
    pub bod: f64,
    pub ss: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
    pub ph: f64,
    pub temperature: f64,
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if !v.is_finite() {
        return lo;
    }
    v.clamp(lo, hi)
}

/// `solveEffluent` in `networkEngine.ts`, including its clamps.
pub fn production_effluent(input: &EffluentInput) -> ProductionEffluent {
    let suspend = input.x_eff;
    ProductionEffluent {
        flow: input.flow,
        cod: clamp(input.soluble_cod + suspend * 1.3, 4.0, 900.0),
        bod: clamp(
            ((input.soluble_cod - 12.0) * 0.32 + suspend * 0.5).max(1.2),
            1.0,
            400.0,
        ),
        ss: clamp(suspend, 0.5, 150.0),
        nh: clamp(input.last_nh + suspend * 0.014, 0.02, 100.0),
        tn: clamp(input.last_nh + input.last_no3 + suspend * 0.025, 0.3, 120.0),
        tp: clamp(
            (input.last_tp + suspend * 0.014 - input.pac_dose * input.pac_p_per_mg).max(0.01),
            0.01,
            20.0,
        ),
        ph: clamp(6.6 + 0.004 * (input.last_alkalinity - 40.0), 5.8, 8.7),
        temperature: input.temperature_c,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReactorInventory {
    pub volume: f64,
    pub state: State,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PlantInventory {
    pub cod_kg: f64,
    pub n_kg: f64,
    pub p_kg: f64,
    pub pp_p_kg: f64,
}

/// Inventory rows exactly as `stepNetwork` assembles them before `updatePlantBalance`.
pub fn asm2d_inventory(
    reactors: &[ReactorInventory],
    clarifier_sludge_kg: f64,
    clarifier_feed: Option<&State>,
    params: &Params,
) -> PlantInventory {
    let mut cod = 0.0;
    let mut n = 0.0;
    let mut p = 0.0;
    let mut pp = 0.0;
    for reactor in reactors {
        let s = &reactor.state;
        let v = reactor.volume;
        cod += ((s.get(Component::SI)
            + s.get(Component::SF)
            + s.get(Component::SA)
            + s.get(Component::XI)
            + s.get(Component::XS)
            + s.get(Component::XH)
            + s.get(Component::XPAO)
            + s.get(Component::XAUT)
            + s.get(Component::XPHA) * 1.0)
            * v)
            / 1000.0;
        n += ((s.get(Component::SNH4)
            + s.get(Component::SNO3)
            + s.get(Component::SN2)
            + s.get(Component::SF) * params.i_n_si)
            * v)
            / 1000.0;
        n += ((s.get(Component::XH) + s.get(Component::XPAO) + s.get(Component::XAUT))
            * params.i_n_bm
            * v)
            / 1000.0;
        n += ((s.get(Component::XS) + s.get(Component::XI)) * params.i_n_xs * v) / 1000.0;
        let pp_kg = (s.get(Component::XPP) * params.i_p_pp * v) / 1000.0;
        pp += pp_kg;
        p += (s.get(Component::SPO4) * v) / 1000.0;
        p += ((s.get(Component::XS) + s.get(Component::XI)) * params.i_p_xs * v) / 1000.0;
        p += (s.get(Component::XMEP) * v) / 1000.0;
        p += ((s.get(Component::XH) + s.get(Component::XPAO) + s.get(Component::XAUT))
            * params.i_p_bm
            * v)
            / 1000.0;
        p += pp_kg;
    }

    if let Some(feed) = clarifier_feed {
        let solids = (feed.get(Component::XI)
            + feed.get(Component::XS)
            + feed.get(Component::XH)
            + feed.get(Component::XPAO)
            + feed.get(Component::XAUT))
            / COD_PER_VSS;
        let p_content = if solids > 1.0 {
            p_concentration(feed, params) / solids
        } else {
            params.i_p_bm
        };
        let n_content = if solids > 1.0 {
            n_concentration(feed, params) / solids
        } else {
            0.07
        };
        n += clarifier_sludge_kg * n_content;
        p += clarifier_sludge_kg * p_content;
    }

    PlantInventory {
        cod_kg: cod,
        n_kg: n,
        p_kg: p,
        pp_p_kg: pp,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BiomassInput {
    pub q_m3h: f64,
    pub qw_m3h: f64,
    pub x_ras: f64,
    pub volume_bio: f64,
    pub influent_bod: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BiomassResult {
    pub biomass_kg: f64,
    pub srt_days: f64,
    pub fm_ratio: f64,
}

/// ASM2d branch of `solveBiomass`: MLSS from particulate COD, SRT from active biomass.
pub fn asm2d_biomass(reactors: &[ReactorInventory], input: &BiomassInput) -> BiomassResult {
    let mut total_part_cod = 0.0;
    let mut active_cod = 0.0;
    let mut weighted_active = 0.0;
    for reactor in reactors {
        let s = &reactor.state;
        let part = s.get(Component::XI)
            + s.get(Component::XS)
            + s.get(Component::XH)
            + s.get(Component::XPAO)
            + s.get(Component::XAUT)
            + s.get(Component::XPP)
            + s.get(Component::XPHA);
        let active = s.get(Component::XH) + s.get(Component::XPAO) + s.get(Component::XAUT);
        total_part_cod += (part * reactor.volume) / 1000.0;
        active_cod += (active * reactor.volume) / 1000.0;
        weighted_active += active * reactor.volume;
    }
    let biomass_kg = clamp(total_part_cod / COD_PER_VSS, 1000.0, 400_000.0);
    let active_mean = weighted_active / input.volume_bio.max(1.0) / COD_PER_VSS;
    let was_kg_day = (input.qw_m3h * 24.0 * active_mean.max(input.x_ras * 0.5)) / 1000.0;
    let srt_days = if was_kg_day > 5.0 {
        clamp(active_cod / COD_PER_VSS / was_kg_day, 2.0, 60.0)
    } else {
        60.0
    };
    let bod_load_kg_day = (input.q_m3h * 24.0 * input.influent_bod) / 1000.0;
    BiomassResult {
        biomass_kg,
        srt_days,
        fm_ratio: bod_load_kg_day / biomass_kg.max(1.0),
    }
}

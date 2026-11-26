//! M1b phase 4/5: biomass and effluent, ported from `networkEngine.ts`.
//!
//! These are pure with respect to the surrounding plant: callers pass the
//! needed pre-state and receive the updated scalars. `stepNetwork` orchestration
//! remains TS-only until the remaining phases are ported.

use serde::Deserialize;

use crate::forcing::{ScenarioSpec, ScenarioType, scenario_envelope};
use crate::output::Effluent;

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_nan() || min.is_nan() || max.is_nan() {
        return f64::NAN;
    }
    value.max(min).min(max)
}

fn max_js(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asm1Soluble {
    pub s_i: f64,
    pub s_s: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asm2dSoluble {
    pub s_i: f64,
    pub s_f: f64,
    pub s_a: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffluentInput {
    pub qe: f64,
    pub temperature: f64,
    pub x_eff: f64,
    pub pac_dose: f64,
    #[serde(default)]
    pub scenario: Option<ScenarioSpec>,
    pub time_min: f64,
    pub last_cod: f64,
    pub last_nh: f64,
    pub last_no3: f64,
    pub last_tp: f64,
    pub last_alkalinity: f64,
    #[serde(default)]
    pub asm1: Option<Asm1Soluble>,
    #[serde(default)]
    pub asm2d: Option<Asm2dSoluble>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffluentSolution {
    pub effluent: Effluent,
    pub pac_dose: f64,
}

/// `solveEffluent`: phase 5, including chemical-shortage PAC cut-off.
pub fn solve_effluent(input: &EffluentInput) -> EffluentSolution {
    let pac_allowed = !(input.scenario.as_ref().is_some_and(|s| {
        s.kind == ScenarioType::ChemicalShortage && scenario_envelope(Some(s), input.time_min) > 0.3
    }));
    let pac_dose = if pac_allowed { input.pac_dose } else { 0.0 };

    let soluble = if let Some(asm1) = input.asm1 {
        asm1.s_i + asm1.s_s
    } else if let Some(asm2d) = input.asm2d {
        asm2d.s_i + asm2d.s_f + asm2d.s_a
    } else {
        input.last_cod
    };
    let suspend = input.x_eff;
    let cod = clamp(soluble + suspend * 1.3, 4.0, 900.0);
    let bod = clamp(
        max_js(1.2, (soluble - 12.0) * 0.32 + suspend * 0.5),
        1.0,
        400.0,
    );
    let ss = clamp(suspend, 0.5, 150.0);
    let nh = clamp(input.last_nh + suspend * 0.014, 0.02, 100.0);
    let tn = clamp(input.last_nh + input.last_no3 + suspend * 0.025, 0.3, 120.0);
    let tp = clamp(
        max_js(0.01, input.last_tp + suspend * 0.014 - pac_dose * 0.06),
        0.01,
        20.0,
    );
    let ph = clamp(6.6 + 0.004 * (input.last_alkalinity - 40.0), 5.8, 8.7);
    EffluentSolution {
        effluent: Effluent {
            flow: input.qe,
            cod,
            bod,
            ss,
            nh,
            tn,
            tp,
            ph,
            temperature: input.temperature,
        },
        pac_dose,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelMode {
    Simple,
    Asm1,
    Asm2d,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asm1Biomass {
    #[serde(alias = "X_B_H")]
    pub x_b_h: f64,
    #[serde(alias = "X_B_A")]
    pub x_b_a: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asm2dBiomass {
    #[serde(alias = "X_I")]
    pub x_i: f64,
    #[serde(alias = "X_S")]
    pub x_s: f64,
    #[serde(alias = "X_H")]
    pub x_h: f64,
    #[serde(alias = "X_PAO")]
    pub x_pao: f64,
    #[serde(alias = "X_AUT")]
    pub x_aut: f64,
    #[serde(alias = "X_PP")]
    pub x_pp: f64,
    #[serde(alias = "X_PHA")]
    pub x_pha: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiomassReactor {
    pub volume: f64,
    #[serde(default)]
    pub asm1: Option<Asm1Biomass>,
    #[serde(default)]
    pub asm2d: Option<Asm2dBiomass>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiomassInput {
    pub model_mode: ModelMode,
    pub biomass_kg: f64,
    pub reactors: Vec<BiomassReactor>,
    pub volume_bio: f64,
    pub clar_x_ras: f64,
    pub dt_h: f64,
    pub wasted_kg: f64,
    pub qw: f64,
    pub q: f64,
    pub influent_bod: f64,
    pub oxidized_cod_kg_h: f64,
    pub oxidized_nh_kg_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BiomassOutput {
    pub biomass_kg: f64,
    pub srt_days: f64,
    pub fm_ratio: f64,
}

const COD_PER_VSS: f64 = 1.42;

/// `solveBiomass`: phase 4, all three model modes.
pub fn solve_biomass(input: &BiomassInput) -> BiomassOutput {
    let mut biomass_kg = input.biomass_kg;
    let growth = 0.48 * input.oxidized_cod_kg_h + 0.11 * input.oxidized_nh_kg_h;
    let decay = (0.025 / 24.0) * input.biomass_kg;

    let srt_days = match input.model_mode {
        ModelMode::Asm1 => {
            let mut total = 0.0;
            let mut weighted = 0.0;
            for reactor in &input.reactors {
                let Some(asm1) = reactor.asm1 else { continue };
                let bio = asm1.x_b_h + asm1.x_b_a;
                total += (bio * reactor.volume) / 1000.0;
                weighted += bio * reactor.volume;
            }
            biomass_kg = clamp(total, 1000.0, 400_000.0);
            let mean_conc = weighted / input.volume_bio.max(1.0);
            let was_kg_day = (input.qw * 24.0 * mean_conc) / 1000.0;
            if was_kg_day > 1.0 {
                clamp(biomass_kg / was_kg_day, 0.5, 60.0)
            } else {
                60.0
            }
        }
        ModelMode::Asm2d => {
            let mut total_part_cod = 0.0;
            let mut active_cod = 0.0;
            let mut weighted_active = 0.0;
            for reactor in &input.reactors {
                let Some(a) = reactor.asm2d else { continue };
                let part = a.x_i + a.x_s + a.x_h + a.x_pao + a.x_aut + a.x_pp + a.x_pha;
                let active = a.x_h + a.x_pao + a.x_aut;
                total_part_cod += (part * reactor.volume) / 1000.0;
                active_cod += (active * reactor.volume) / 1000.0;
                weighted_active += active * reactor.volume;
            }
            biomass_kg = clamp(total_part_cod / COD_PER_VSS, 1000.0, 400_000.0);
            let active_mean = weighted_active / input.volume_bio.max(1.0) / COD_PER_VSS;
            let was_kg_day =
                (input.qw * 24.0 * max_js(active_mean, input.clar_x_ras * 0.5)) / 1000.0;
            if was_kg_day > 5.0 {
                clamp(active_cod / COD_PER_VSS / was_kg_day, 2.0, 60.0)
            } else {
                60.0
            }
        }
        ModelMode::Simple => {
            biomass_kg = clamp(
                biomass_kg + (growth - decay) * input.dt_h - input.wasted_kg,
                5000.0,
                400_000.0,
            );
            let was_kg_day = (input.qw * 24.0 * input.clar_x_ras) / 1000.0;
            if was_kg_day > 5.0 {
                clamp(biomass_kg / was_kg_day, 2.0, 60.0)
            } else {
                60.0
            }
        }
    };

    let bod_load_kg_day = (input.q * 24.0 * input.influent_bod) / 1000.0;
    let fm_ratio = bod_load_kg_day / biomass_kg.max(1.0);
    BiomassOutput {
        biomass_kg,
        srt_days,
        fm_ratio,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub energy: f64,
    pub chemical: f64,
    pub sludge: f64,
    pub total: f64,
}

impl Default for Cost {
    fn default() -> Self {
        Self {
            energy: 0.0,
            chemical: 0.0,
            sludge: 0.0,
            total: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub inflow_m3: f64,
    pub energy_kwh: f64,
    pub waste_sludge_kg: f64,
    pub influent_cod_kg: f64,
    pub oxidized_cod_kg: f64,
}

impl Default for Totals {
    fn default() -> Self {
        Self {
            inflow_m3: 0.0,
            energy_kwh: 0.0,
            waste_sludge_kg: 0.0,
            influent_cod_kg: 0.0,
            oxidized_cod_kg: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Energy {
    pub blower_kw: f64,
    pub mixer_kw: f64,
    pub pump_kw: f64,
    pub total_kw: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyInput {
    pub dt_h: f64,
    pub q: f64,
    pub qr: f64,
    pub ir: f64,
    pub aeration_capacity: f64,
    pub o2_transferred_kg_h: f64,
    pub wasted_kg: f64,
    pub pac_dose: f64,
    pub cod_oxidized_kg_h: f64,
    pub volume_anoxic: f64,
    pub volume_anaerobic: f64,
    pub carbon_dose: f64,
    pub alk_dose: f64,
    pub time_min: f64,
    pub last_day: f64,
    #[serde(default)]
    pub cost: Cost,
    #[serde(default)]
    pub cost_today: Cost,
    #[serde(default)]
    pub totals: Totals,
    pub influent_cod: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnergyOutput {
    pub energy: Energy,
    pub cost: Cost,
    pub cost_today: Cost,
    pub totals: Totals,
    pub last_day: f64,
}

/// `totalBlowerPower`: 0 when the blower is off, otherwise clamp 5–900 kW.
pub fn total_blower_power(o2_transferred_kgh: f64, capacity: f64) -> f64 {
    if capacity <= 0.02 {
        return 0.0;
    }
    clamp(o2_transferred_kgh / 3.4 / 0.7, 5.0, 900.0)
}

/// `solveEnergyAndCost`: phase 6, including day rollover and cumulative totals.
pub fn solve_energy_and_cost(input: &EnergyInput) -> EnergyOutput {
    let blower_kw = total_blower_power(input.o2_transferred_kg_h, input.aeration_capacity);
    let anoxic_vol = input.volume_anoxic + input.volume_anaerobic;
    let mixer_kw = (anoxic_vol * 3.4) / 1000.0;
    let pump_kw = (input.q + input.qr + input.q * input.ir) * 0.008;
    let total_kw = blower_kw + mixer_kw + pump_kw;

    let pac_kg = (input.q * input.pac_dose * input.dt_h) / 1000.0;
    let carbon_kg = (input.q * input.carbon_dose * input.dt_h) / 1000.0;
    let alk_kg = (input.q * input.alk_dose * input.dt_h) / 1000.0;
    let energy_cost = total_kw * input.dt_h * 0.68;
    let chem_cost = pac_kg * 2.2 + carbon_kg * 3.6 + alk_kg * 1.4;
    let sludge_cost = input.wasted_kg * 0.36;

    let sim_day = (input.time_min / 1440.0).floor();
    let mut last_day = input.last_day;
    let mut cost_today = input.cost_today;
    if sim_day > last_day {
        last_day = sim_day;
        cost_today = Cost::default();
    }

    let mut cost = input.cost;
    cost.energy += energy_cost;
    cost.chemical += chem_cost;
    cost.sludge += sludge_cost;
    cost.total += energy_cost + chem_cost + sludge_cost;
    cost_today.energy += energy_cost;
    cost_today.chemical += chem_cost;
    cost_today.sludge += sludge_cost;
    cost_today.total += energy_cost + chem_cost + sludge_cost;

    let mut totals = input.totals;
    totals.inflow_m3 += input.q * input.dt_h;
    totals.influent_cod_kg += (input.q * input.influent_cod * input.dt_h) / 1000.0;
    totals.energy_kwh += total_kw * input.dt_h;
    totals.waste_sludge_kg += input.wasted_kg;
    totals.oxidized_cod_kg += input.cod_oxidized_kg_h.max(0.0) * input.dt_h;

    EnergyOutput {
        energy: Energy {
            blower_kw,
            mixer_kw,
            pump_kw,
            total_kw,
        },
        cost,
        cost_today,
        totals,
        last_day,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_biomass_respects_floor() {
        let input = BiomassInput {
            model_mode: ModelMode::Simple,
            biomass_kg: 100.0,
            reactors: vec![],
            volume_bio: 5000.0,
            clar_x_ras: 8000.0,
            dt_h: 0.25,
            wasted_kg: 0.0,
            qw: 0.0,
            q: 2000.0,
            influent_bod: 150.0,
            oxidized_cod_kg_h: 100.0,
            oxidized_nh_kg_h: 0.0,
        };
        let out = solve_biomass(&input);
        assert_eq!(out.biomass_kg, 5000.0);
        assert_eq!(out.srt_days, 60.0);
    }

    #[test]
    fn pac_is_cut_off_only_during_chemical_shortage() {
        let input = EffluentInput {
            qe: 1900.0,
            temperature: 20.0,
            x_eff: 8.0,
            pac_dose: 2.0,
            scenario: None,
            time_min: 100.0,
            last_cod: 40.0,
            last_nh: 2.0,
            last_no3: 8.0,
            last_tp: 0.4,
            last_alkalinity: 220.0,
            asm1: None,
            asm2d: None,
        };
        assert_eq!(solve_effluent(&input).pac_dose, 2.0);
    }
}

//! Successive-substitution loop that returns ADM1 filtrate to the A2O influent.
//!
//! At convergence the filtrate is internal, so the whole-plant ledger uses only
//! the external ASM2d influent as input and the A2O effluent + sludge cake +
//! gas as outputs. The loop does not hide a non-converged recycle as a closure
//! term; `converged` must be true before claiming a whole-plant result.

use serde::{Deserialize, Serialize};

use crate::adm1_sludge::{merge_sludge_streams, SludgeLineError};
use crate::asm2d::{Asm2dParams, Asm2dState};
use crate::asm2d_plant::{
    simulate_asm2d, Asm2dInfluentConfig, Asm2dPlantConfig, Asm2dPlantError, Asm2dPlantSnapshot,
    Asm2dSimulationConfig,
};
use crate::asm2d_sludge::{
    asm2d_state_from_adm1, simulate_asm2d_sludge, Asm2dSludgeConfig, Asm2dSludgeSnapshot,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dAdm1LoopConfig {
    pub plant: Asm2dPlantConfig,
    pub sludge: Asm2dSludgeConfig,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    #[serde(default = "default_relaxation")]
    pub relaxation: f64,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
}

fn default_max_iterations() -> usize {
    6
}

fn default_relaxation() -> f64 {
    0.5
}

fn default_tolerance() -> f64 {
    1.0e-3
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WholePlantLedger {
    pub input_kg: f64,
    pub effluent_kg: f64,
    pub cake_kg: f64,
    pub gas_kg: f64,
    pub inventory_kg: f64,
    pub residual: f64,
    pub closed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WholePlantLedgers {
    pub cod: WholePlantLedger,
    pub nitrogen: WholePlantLedger,
    pub phosphorus: WholePlantLedger,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dAdm1LoopSnapshot {
    pub iterations: usize,
    pub converged: bool,
    pub recycle_flow_m3_h: f64,
    pub recycle_state: Asm2dState,
    pub recycle_cod_mg_l: f64,
    pub recycle_nitrogen_mg_l: f64,
    pub recycle_phosphorus_mg_l: f64,
    pub asm2d: Asm2dPlantSnapshot,
    pub sludge: Asm2dSludgeSnapshot,
    pub whole_balance: WholePlantLedgers,
}

#[derive(Debug, thiserror::Error)]
pub enum Asm2dAdm1LoopError {
    #[error(transparent)]
    Plant(#[from] Asm2dPlantError),
    #[error(transparent)]
    Sludge(#[from] SludgeLineError),
    #[error("coupled-loop configuration is invalid")]
    InvalidConfig,
}

pub fn simulate_asm2d_adm1_loop(
    config: &Asm2dAdm1LoopConfig,
    simulation: Asm2dSimulationConfig,
    sludge_days: f64,
    sludge_dt_days: f64,
) -> Result<Asm2dAdm1LoopSnapshot, Asm2dAdm1LoopError> {
    if config.max_iterations == 0
        || !(0.0..=1.0).contains(&config.relaxation)
        || config.tolerance <= 0.0
        || simulation.duration_min <= 0.0
        || simulation.dt_min <= 0.0
        || sludge_days <= 0.0
        || sludge_dt_days <= 0.0
    {
        return Err(Asm2dAdm1LoopError::InvalidConfig);
    }

    let base_influent = config.plant.influent.clone();
    let mut recycle = Asm2dState::zeros();
    let mut recycle_flow = 0.0;
    let mut last_asm2d: Option<Asm2dPlantSnapshot> = None;
    let mut last_sludge: Option<Asm2dSludgeSnapshot> = None;
    let mut converged = false;
    let mut iterations = 0;

    for iteration in 0..config.max_iterations {
        iterations = iteration + 1;
        let mixed = mix_influent(base_influent.clone(), recycle, recycle_flow);
        let mut plant = config.plant.clone();
        plant.influent = mixed;
        let asm2d = simulate_asm2d(plant, simulation, Asm2dParams::default())?;
        let sludge = simulate_asm2d_sludge(
            &asm2d.waste.state,
            asm2d.waste.flow_m3_h,
            &config.sludge,
            sludge_days,
            sludge_dt_days,
        )?;

        let return_stream =
            merge_sludge_streams(sludge.line.thickener_overflow, sludge.line.filtrate);
        let target_flow = return_stream.flow_m3_per_d / 24.0;
        let target_state =
            asm2d_state_from_adm1(&return_stream.state, return_stream.phosphorus_kg_per_m3);

        if iteration > 0
            && change_norm(recycle, target_state, recycle_flow, target_flow) <= config.tolerance
        {
            recycle = target_state;
            recycle_flow = target_flow;
            converged = true;
            last_asm2d = Some(asm2d);
            last_sludge = Some(sludge);
            break;
        }

        recycle = blend_state(recycle, target_state, config.relaxation);
        recycle_flow = recycle_flow + config.relaxation * (target_flow - recycle_flow);
        last_asm2d = Some(asm2d);
        last_sludge = Some(sludge);
    }

    let asm2d = last_asm2d.ok_or(Asm2dAdm1LoopError::InvalidConfig)?;
    let sludge = last_sludge.ok_or(Asm2dAdm1LoopError::InvalidConfig)?;
    let whole_balance = whole_plant_ledgers(
        base_influent,
        &asm2d,
        &sludge,
        recycle,
        recycle_flow,
        simulation,
        sludge_days,
    );

    Ok(Asm2dAdm1LoopSnapshot {
        iterations,
        converged,
        recycle_flow_m3_h: recycle_flow,
        recycle_state: recycle,
        recycle_cod_mg_l: recycle.total_cod(),
        recycle_nitrogen_mg_l: recycle.total_nitrogen(),
        recycle_phosphorus_mg_l: recycle.total_phosphorus(),
        asm2d,
        sludge,
        whole_balance,
    })
}

fn mix_influent(
    base: Asm2dInfluentConfig,
    recycle: Asm2dState,
    recycle_flow: f64,
) -> Asm2dInfluentConfig {
    if recycle_flow <= 0.0 {
        return base;
    }
    let total_flow = base.flow_m3_h + recycle_flow;
    let base_values = base.state.values();
    let recycle_values = recycle.values();
    let mut values = [0.0; 18];
    for i in 0..18 {
        values[i] =
            (base_values[i] * base.flow_m3_h + recycle_values[i] * recycle_flow) / total_flow;
    }
    Asm2dInfluentConfig {
        flow_m3_h: total_flow,
        state: Asm2dState::from_values(values),
    }
}

fn blend_state(old: Asm2dState, target: Asm2dState, relaxation: f64) -> Asm2dState {
    let old_values = old.values();
    let target_values = target.values();
    let mut values = [0.0; 18];
    for i in 0..18 {
        values[i] = old_values[i] + relaxation * (target_values[i] - old_values[i]);
    }
    Asm2dState::from_values(values)
}

fn change_norm(old: Asm2dState, target: Asm2dState, old_flow: f64, target_flow: f64) -> f64 {
    let mut max_change = ((target_flow - old_flow).abs() / target_flow.max(1.0)).min(1.0);
    let old_values = old.values();
    let target_values = target.values();
    for i in 0..18 {
        let change = (target_values[i] - old_values[i]).abs() / target_values[i].abs().max(1.0);
        if change > max_change {
            max_change = change;
        }
    }
    max_change
}

fn whole_plant_ledgers(
    base: Asm2dInfluentConfig,
    asm2d: &Asm2dPlantSnapshot,
    sludge: &Asm2dSludgeSnapshot,
    recycle: Asm2dState,
    recycle_flow_m3_h: f64,
    simulation: Asm2dSimulationConfig,
    sludge_days: f64,
) -> WholePlantLedgers {
    let hours = simulation.duration_min / 60.0;
    let a2o_days = simulation.duration_min / 1440.0;
    let period_scale = a2o_days / sludge_days;
    let cod_input = base.state.total_cod() * base.flow_m3_h * hours / 1000.0;
    let n_input = base.state.total_nitrogen() * base.flow_m3_h * hours / 1000.0;
    let p_input = base.state.total_phosphorus() * base.flow_m3_h * hours / 1000.0;

    // Use the A2O time-integrated effluent, not the final concentration times
    // the full period. The latter is a final-rate estimate and overstates the
    // load whenever the plant is still changing inventory.
    let cod_effluent = asm2d.mass_balance.cod.effluent_kg;
    let n_effluent = asm2d.mass_balance.nitrogen.effluent_kg;
    let p_effluent = asm2d.mass_balance.phosphorus.effluent_kg;

    // The A2O waste ledger is time-integrated. Subtract the internal return
    // load to get the cake that actually leaves the whole plant. Using the
    // final-state dewatering cake here would mix a final rate with an integral
    // and overstate the cake during a transient.
    let recycle_cod = recycle.total_cod() * recycle_flow_m3_h * hours / 1000.0;
    let recycle_n = recycle.total_nitrogen() * recycle_flow_m3_h * hours / 1000.0;
    let recycle_p = recycle.total_phosphorus() * recycle_flow_m3_h * hours / 1000.0;
    let cod_cake = asm2d.mass_balance.cod.waste_kg
        - recycle_cod
        - sludge.line.digester.cod_balance.gas_kg * period_scale;
    let n_cake = asm2d.mass_balance.nitrogen.waste_kg
        - recycle_n
        - sludge.line.digester.nitrogen_balance.gas_kg * period_scale;
    let p_cake = asm2d.mass_balance.phosphorus.waste_kg - recycle_p;

    let cod_inventory =
        asm2d.mass_balance.cod.inventory_change_kg + sludge.line.cod_balance.inventory_kg;
    let n_inventory =
        asm2d.mass_balance.nitrogen.inventory_change_kg + sludge.line.nitrogen_balance.inventory_kg;

    WholePlantLedgers {
        cod: ledger(
            cod_input,
            cod_effluent,
            cod_cake,
            asm2d.mass_balance.cod.gas_kg
                + asm2d.mass_balance.cod.oxidized_kg
                + sludge.line.digester.cod_balance.gas_kg * period_scale,
            cod_inventory,
        ),
        nitrogen: ledger(
            n_input,
            n_effluent,
            n_cake,
            asm2d.mass_balance.nitrogen.gas_kg
                + sludge.line.digester.nitrogen_balance.gas_kg * period_scale,
            n_inventory,
        ),
        phosphorus: ledger(
            p_input,
            p_effluent,
            p_cake,
            0.0,
            asm2d.mass_balance.phosphorus.inventory_change_kg,
        ),
    }
}

fn ledger(input: f64, effluent: f64, cake: f64, gas: f64, inventory: f64) -> WholePlantLedger {
    let accounted = effluent + cake + gas + inventory;
    let residual = if input.abs() > 1.0e-12 {
        (input - accounted) / input
    } else {
        accounted.abs()
    };
    WholePlantLedger {
        input_kg: input,
        effluent_kg: effluent,
        cake_kg: cake,
        gas_kg: gas,
        inventory_kg: inventory,
        residual,
        closed: residual.abs() <= 0.05,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_returns_the_sludge_side_streams() {
        let plant: Asm2dPlantConfig =
            serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d.json"))
                .expect("fixture");
        let config = Asm2dAdm1LoopConfig {
            plant,
            sludge: Asm2dSludgeConfig::default(),
            max_iterations: 2,
            relaxation: 1.0,
            tolerance: 1.0e-3,
        };
        let simulation = Asm2dSimulationConfig {
            dt_min: 1.0,
            duration_min: 120.0,
        };
        let snapshot = simulate_asm2d_adm1_loop(&config, simulation, 2.0, 0.01).expect("loop");
        assert!(snapshot.recycle_flow_m3_h > 0.0);
        let expected = snapshot.sludge.line.thickener_overflow.flow_m3_per_d / 24.0
            + snapshot.sludge.line.filtrate.flow_m3_per_d / 24.0;
        assert!((snapshot.recycle_flow_m3_h - expected).abs() < 1.0e-9);
        assert!(snapshot.whole_balance.cod.input_kg > 0.0);
        assert!(snapshot.whole_balance.phosphorus.input_kg > 0.0);
    }
}

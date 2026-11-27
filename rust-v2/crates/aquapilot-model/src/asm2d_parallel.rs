//! Parallel-train ASM2d plant wrapper. Each train owns its own reactors,
//! clarifier, RAS/WAS and mass ledger; the wrapper only splits the influent by
//! the configured train flows and recombines the train effluents. This keeps
//! the single-train runtime unchanged and makes multi-series plants auditable
//! per train.

use serde::{Deserialize, Serialize};

use crate::asm2d::Asm2dParams;
use crate::asm2d_plant::{
    simulate_asm2d, Asm2dEffluentSnapshot, Asm2dMassBalance, Asm2dPlantConfig, Asm2dPlantSnapshot,
    Asm2dSimulationConfig, Asm2dWasteSnapshot, MassLedger,
};

#[derive(Debug, thiserror::Error)]
pub enum Asm2dParallelError {
    #[error("parallel ASM2d plant has no trains")]
    NoTrains,
    #[error("parallel ASM2d train {index} failed: {source}")]
    Train {
        index: usize,
        #[source]
        source: crate::asm2d_plant::Asm2dPlantError,
    },
    #[error("parallel ASM2d train {index} has zero influent flow")]
    ZeroFlow { index: usize },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dParallelConfig {
    pub name: String,
    pub trains: Vec<Asm2dPlantConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dParallelSnapshot {
    pub plant_name: String,
    pub time_min: f64,
    pub step_count: u64,
    pub train_count: usize,
    pub total_influent_flow_m3_h: f64,
    pub trains: Vec<Asm2dPlantSnapshot>,
    pub effluent: Asm2dEffluentSnapshot,
    pub waste: Asm2dWasteSnapshot,
    pub mass_balance: Asm2dMassBalance,
}

pub fn simulate_asm2d_parallel(
    config: Asm2dParallelConfig,
    simulation: Asm2dSimulationConfig,
    params: Asm2dParams,
) -> Result<Asm2dParallelSnapshot, Asm2dParallelError> {
    if config.trains.is_empty() {
        return Err(Asm2dParallelError::NoTrains);
    }
    let mut trains = Vec::with_capacity(config.trains.len());
    for (index, train) in config.trains.into_iter().enumerate() {
        if train.influent.flow_m3_h <= 0.0 {
            return Err(Asm2dParallelError::ZeroFlow { index });
        }
        trains.push(
            simulate_asm2d(train, simulation, params)
                .map_err(|source| Asm2dParallelError::Train { index, source })?,
        );
    }
    Ok(aggregate(config.name, trains))
}

fn aggregate(name: String, trains: Vec<Asm2dPlantSnapshot>) -> Asm2dParallelSnapshot {
    let total_influent_flow_m3_h: f64 = trains
        .iter()
        .map(|t| t.effluent.flow_m3_h + t.waste.flow_m3_h)
        .sum();
    let total_flow: f64 = trains.iter().map(|t| t.effluent.flow_m3_h).sum();
    let effluent = aggregate_effluent(&trains, total_flow);
    let waste = aggregate_waste(&trains);
    let cod = sum_ledger(trains.iter().map(|t| &t.mass_balance.cod));
    let nitrogen = sum_ledger(trains.iter().map(|t| &t.mass_balance.nitrogen));
    let phosphorus = sum_ledger(trains.iter().map(|t| &t.mass_balance.phosphorus));
    let all_closed = cod.closed && nitrogen.closed && phosphorus.closed;
    let note = if all_closed {
        "parallel ASM2d trains meet the 5% COD/N/P ledger threshold".to_owned()
    } else {
        "parallel ASM2d aggregate ledger exceeds 5%; inspect train-level residuals".to_owned()
    };
    Asm2dParallelSnapshot {
        plant_name: name,
        time_min: trains.first().map_or(0.0, |t| t.time_min),
        step_count: trains.iter().map(|t| t.step_count).max().unwrap_or(0),
        train_count: trains.len(),
        total_influent_flow_m3_h,
        trains,
        effluent,
        waste,
        mass_balance: Asm2dMassBalance {
            cod,
            nitrogen,
            phosphorus,
            note,
        },
    }
}

fn aggregate_effluent(trains: &[Asm2dPlantSnapshot], total_flow: f64) -> Asm2dEffluentSnapshot {
    let mut result = Asm2dEffluentSnapshot {
        flow_m3_h: total_flow,
        cod: 0.0,
        s_s: 0.0,
        nh4_n: 0.0,
        no3_n: 0.0,
        tn: 0.0,
        tp: 0.0,
        po4_p: 0.0,
        ss: 0.0,
        dissolved_oxygen: 0.0,
        alkalinity: 0.0,
    };
    if total_flow <= 0.0 {
        return result;
    }
    for train in trains {
        let weight = train.effluent.flow_m3_h / total_flow;
        result.cod += train.effluent.cod * weight;
        result.s_s += train.effluent.s_s * weight;
        result.nh4_n += train.effluent.nh4_n * weight;
        result.no3_n += train.effluent.no3_n * weight;
        result.tn += train.effluent.tn * weight;
        result.tp += train.effluent.tp * weight;
        result.po4_p += train.effluent.po4_p * weight;
        result.ss += train.effluent.ss * weight;
        result.dissolved_oxygen += train.effluent.dissolved_oxygen * weight;
        result.alkalinity += train.effluent.alkalinity * weight;
    }
    result
}

fn aggregate_waste(trains: &[Asm2dPlantSnapshot]) -> Asm2dWasteSnapshot {
    let total_flow: f64 = trains.iter().map(|t| t.waste.flow_m3_h).sum();
    let mut result = Asm2dWasteSnapshot {
        flow_m3_h: total_flow,
        cod: 0.0,
        tn: 0.0,
        tp: 0.0,
        ss: 0.0,
    };
    if total_flow <= 0.0 {
        return result;
    }
    for train in trains {
        let weight = train.waste.flow_m3_h / total_flow;
        result.cod += train.waste.cod * weight;
        result.tn += train.waste.tn * weight;
        result.tp += train.waste.tp * weight;
        result.ss += train.waste.ss * weight;
    }
    result
}

fn sum_ledger<'a>(parts: impl Iterator<Item = &'a MassLedger>) -> MassLedger {
    let mut inflow = 0.0;
    let mut effluent = 0.0;
    let mut waste = 0.0;
    let mut inventory = 0.0;
    let mut oxidized = 0.0;
    let mut gas = 0.0;
    for part in parts {
        inflow += part.inflow_kg;
        effluent += part.effluent_kg;
        waste += part.waste_kg;
        inventory += part.inventory_change_kg;
        oxidized += part.oxidized_kg;
        gas += part.gas_kg;
    }
    let unaccounted = inflow - effluent - waste - inventory - oxidized - gas;
    let residual_fraction = if inflow.abs() > 1e-9 {
        unaccounted.abs() / inflow.abs()
    } else {
        0.0
    };
    MassLedger {
        inflow_kg: inflow,
        effluent_kg: effluent,
        waste_kg: waste,
        inventory_change_kg: inventory,
        oxidized_kg: oxidized,
        gas_kg: gas,
        unaccounted_kg: unaccounted,
        residual_fraction,
        closed: residual_fraction <= 0.05,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn train() -> Asm2dPlantConfig {
        serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d.json")).expect("A2O fixture")
    }

    #[test]
    fn two_parallel_trains_aggregate_flow_and_ledgers() {
        let config = Asm2dParallelConfig {
            name: "2 x A2O".to_owned(),
            trains: vec![train(), train()],
        };
        let snapshot = simulate_asm2d_parallel(
            config,
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 43_200.0,
            },
            Asm2dParams::default(),
        )
        .expect("parallel plant");
        assert_eq!(snapshot.train_count, 2);
        assert!((snapshot.total_influent_flow_m3_h - 2000.0).abs() < 1e-6);
        assert!((snapshot.effluent.flow_m3_h - 1960.0).abs() < 1e-6);
        assert!((snapshot.waste.flow_m3_h - 40.0).abs() < 1e-6);
        assert!(snapshot.effluent.cod < 60.0);
        assert!(snapshot.effluent.tp < 2.0);
        for ledger in [
            &snapshot.mass_balance.cod,
            &snapshot.mass_balance.nitrogen,
            &snapshot.mass_balance.phosphorus,
        ] {
            assert!(ledger.closed);
            assert!(ledger.residual_fraction < 0.05);
        }
        assert!(snapshot
            .trains
            .iter()
            .all(|train| train.mass_balance.cod.closed));
    }
}

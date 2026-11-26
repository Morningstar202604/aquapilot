//! AquaPilot whole-plant runtime, M1b.
//!
//! Owned layers: pure forcing/influent, phases 4–7 (biomass/effluent/energy/cost),
//! and effluent metrics/alarms. This is not a whole-plant engine yet: `createNetworkState`,
//! `stepNetwork` orchestration and `PlantSnapshot` remain TS-only.

#![forbid(unsafe_code)]

pub mod alarm_ledger;
pub mod alarms;
pub mod asm1mix;
pub mod forcing;
pub mod hydraulics;
pub mod inflow;
pub mod influent;
pub mod metrics;
pub mod output;
pub mod phases;

pub use alarm_ledger::{ALARM_DEDUP_WINDOW_MIN, ALARM_HISTORY_LIMIT, AlarmLedger};
pub use alarms::{Alarm, AlarmRuleInput, Severity, evaluate_alarms};
pub use asm1mix::{Asm1State, aggregate_asm1_inflow, influent_to_asm1, to_asm1};
pub use forcing::{
    Controls, Recycle, ScenarioSpec, ScenarioType, aeration_capacity, diurnal, mixed,
    recycle_factors, scenario_envelope, seasonal_temperature, toxic_suppression,
};
pub use hydraulics::{HydraulicInput, HydraulicOutput, resolve_hydraulics};
pub use inflow::{
    IncomingEdge, InflowComposition, ReactorComposition, RecycleKind, aggregate_inflow,
};
pub use influent::{
    Influent, InfluentContext, InfluentSeries, SeriesSample, Uncertainty, derive_influent,
    sample_at,
};
pub use metrics::{
    EffluentMetric, MarginRow, clamp, effluent_margin_rows, estimate_margin, quality_score,
    worst_ratio,
};
pub use output::{DischargeStandard, Effluent, EffluentLimits};
pub use phases::{
    Asm1Biomass, Asm1Soluble, Asm2dBiomass, Asm2dSoluble, BiomassInput, BiomassOutput,
    BiomassReactor, Cost, EffluentInput, EffluentSolution, Energy, EnergyInput, EnergyOutput,
    ModelMode, Totals, solve_biomass, solve_effluent, solve_energy_and_cost, total_blower_power,
};

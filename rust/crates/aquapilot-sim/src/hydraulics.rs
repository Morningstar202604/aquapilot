//! M1b phase 1: influent storage / storm diversion, ported from
//! `resolveHydraulics` in `networkEngine.ts`.
//!
//! The influent itself is produced by `derive_influent`; this module owns only
//! the storage tank and the flow actually entering the plant.

use serde::Deserialize;

use crate::forcing::{ScenarioSpec, ScenarioType, scenario_envelope};
use crate::influent::Influent;

const STORM_STORAGE_CAP_M3: f64 = 16_000.0;
const STORM_RETURN_MAX_M3_H: f64 = 320.0;
const STORM_ACTIVE_THRESHOLD: f64 = 0.05;
const MIN_PLANT_FLOW_M3_H: f64 = 200.0;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydraulicInput {
    /// Influent produced by `derive_influent` for this step.
    pub influent: Influent,
    pub storm_storage_m3: f64,
    /// `controls.stormStore`: fraction of raw flow diverted during a storm.
    pub storm_store: f64,
    #[serde(default)]
    pub scenario: Option<ScenarioSpec>,
    pub time_min: f64,
    pub dt_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HydraulicOutput {
    pub influent: Influent,
    pub q: f64,
    pub storm_storage_m3: f64,
}

/// Phase 1: storm storage, release, and the flow that reaches the plant.
pub fn resolve_hydraulics(input: &HydraulicInput) -> HydraulicOutput {
    let storm_active = input.scenario.as_ref().is_some_and(|s| {
        s.kind == ScenarioType::Storm
            && scenario_envelope(Some(s), input.time_min) > STORM_ACTIVE_THRESHOLD
    });
    let store_frac = if storm_active { input.storm_store } else { 0.0 };
    let diverted_raw = input.influent.flow * store_frac;
    let room = js_max(0.0, STORM_STORAGE_CAP_M3 - input.storm_storage_m3);
    let diverted = js_min(diverted_raw, room);
    let mut storm_storage_m3 = input.storm_storage_m3 + diverted * input.dt_h;

    let return_flow = if !storm_active && storm_storage_m3 > 0.0 {
        js_min(STORM_RETURN_MAX_M3_H, storm_storage_m3 / input.dt_h)
    } else {
        0.0
    };
    storm_storage_m3 = js_max(0.0, storm_storage_m3 - return_flow * input.dt_h);
    let q = js_max(
        MIN_PLANT_FLOW_M3_H,
        input.influent.flow - diverted + return_flow,
    );

    let mut influent = input.influent;
    influent.flow = q;
    HydraulicOutput {
        influent,
        q,
        storm_storage_m3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HydraulicInput {
        HydraulicInput {
            influent: Influent {
                flow: 2000.0,
                ..Influent::default()
            },
            storm_storage_m3: 0.0,
            storm_store: 0.2,
            scenario: None,
            time_min: 0.0,
            dt_h: 1.0,
        }
    }

    #[test]
    fn dry_weather_passes_full_flow() {
        let out = resolve_hydraulics(&base());
        assert_eq!(out.q, 2000.0);
        assert_eq!(out.storm_storage_m3, 0.0);
    }

    #[test]
    fn storm_fills_storage_up_to_capacity() {
        let mut input = base();
        input.storm_storage_m3 = 15_800.0;
        input.scenario = Some(ScenarioSpec {
            kind: ScenarioType::Storm,
            duration_min: 240.0,
            started_at: 0.0,
            magnitude: 1.0,
        });
        input.time_min = 60.0;
        let out = resolve_hydraulics(&input);
        assert_eq!(out.storm_storage_m3, 16_000.0);
        assert_eq!(out.q, input.influent.flow - 200.0);
    }

    #[test]
    fn stored_water_returns_after_storm() {
        let mut input = base();
        input.influent.flow = 1000.0;
        input.storm_storage_m3 = 320.0;
        input.dt_h = 1.0;
        let out = resolve_hydraulics(&input);
        assert_eq!(out.storm_storage_m3, 0.0);
        assert_eq!(out.q, 1320.0);
    }
}

//! Pure external forcing functions, ported from `src/sim/forcing.ts`.
//!
//! These functions are shared by the production engine and forecast clones.
//! Any drift here makes "forecast says safe, plant trips" possible, so the
//! Rust copy is compared against the TS oracle over the full scenario matrix.

use std::f64::consts::PI;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioType {
    Storm,
    ShockLoad,
    Toxic,
    BlowerFailure,
    RasFailure,
    PowerOutage,
    Winter,
    ChemicalShortage,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSpec {
    #[serde(rename = "type")]
    pub kind: ScenarioType,
    pub duration_min: f64,
    pub started_at: f64,
    pub magnitude: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub ras_ratio: f64,
    pub internal_recirc: f64,
    pub was_ratio: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Recycle {
    pub ras: f64,
    pub ir: f64,
    pub was: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AerationCapacity(pub f64);

/// `diurnal(timeMin)` in `src/sim/forcing.ts`.
pub fn diurnal(time_min: f64) -> f64 {
    let h = (time_min / 60.0) % 24.0;
    0.78 + 0.3 * (-((h - 10.0) / 3.6).powi(2)).exp() + 0.26 * (-((h - 20.0) / 3.2).powi(2)).exp()
}

/// `seasonalTemperature(timeMin)`: annual sine, January lowest, July highest.
pub fn seasonal_temperature(time_min: f64) -> f64 {
    19.5 + 3.6 * ((2.0 * PI * (time_min / 1440.0 - 60.0)) / 365.0).sin()
}

/// `scenarioEnvelope(spec, timeMin)`: ramp-in / hold / ramp-out intensity.
pub fn scenario_envelope(spec: Option<&ScenarioSpec>, time_min: f64) -> f64 {
    let Some(spec) = spec else {
        return 0.0;
    };
    let elapsed = time_min - spec.started_at;
    if elapsed < 0.0 || elapsed > spec.duration_min {
        return 0.0;
    }
    let ramp_in = match spec.kind {
        ScenarioType::Storm => 20.0,
        ScenarioType::PowerOutage => 1.0,
        _ => 8.0,
    };
    let ramp_out = match spec.kind {
        ScenarioType::Storm => 80.0,
        ScenarioType::PowerOutage => 2.0,
        _ => 30.0,
    };
    if elapsed < ramp_in {
        return elapsed / ramp_in;
    }
    if spec.duration_min - elapsed < ramp_out {
        return ((spec.duration_min - elapsed) / ramp_out).max(0.0);
    }
    1.0
}

/// `toxicSuppression(spec, timeMin)`: 1 = no suppression.
pub fn toxic_suppression(spec: Option<&ScenarioSpec>, time_min: f64) -> f64 {
    let Some(spec) = spec else {
        return 1.0;
    };
    if spec.kind != ScenarioType::Toxic {
        return 1.0;
    }
    let env = scenario_envelope(Some(spec), time_min);
    1.0 - env * (0.45 + 0.3 * spec.magnitude).clamp(0.0, 0.85)
}

/// `aerationCapacityOf(spec, timeMin)`: remaining blower capacity, 0–1.
pub fn aeration_capacity(spec: Option<&ScenarioSpec>, time_min: f64) -> f64 {
    let Some(spec) = spec else {
        return 1.0;
    };
    let env = scenario_envelope(Some(spec), time_min);
    match spec.kind {
        ScenarioType::BlowerFailure => {
            let raw = if spec.magnitude.is_finite() {
                spec.magnitude
            } else {
                0.5
            };
            let remaining = raw.clamp(0.0, 1.0);
            (1.0 - env * (1.0 - remaining)).clamp(0.0, 1.0)
        }
        ScenarioType::PowerOutage => (1.0 - env).clamp(0.0, 1.0),
        _ => 1.0,
    }
}

/// `recycleFactors(controls, spec, timeMin)`.
pub fn recycle_factors(controls: &Controls, spec: Option<&ScenarioSpec>, time_min: f64) -> Recycle {
    let mut ras = controls.ras_ratio;
    let mut ir = controls.internal_recirc;
    let mut was = controls.was_ratio;
    if let Some(spec) = spec {
        let env = scenario_envelope(Some(spec), time_min);
        if spec.kind == ScenarioType::RasFailure {
            ras *= 1.0 - env;
        }
        if spec.kind == ScenarioType::PowerOutage {
            ir = 0.0;
            ras *= 1.0 - env;
            was *= 1.0 - env;
        }
    }
    Recycle { ras, ir, was }
}

/// Flow-weighted mixing; if both flows are zero, keep the left concentration.
pub fn mixed(c_a: f64, q_a: f64, c_b: f64, q_b: f64) -> f64 {
    let q = q_a + q_b;
    if q > 0.0 {
        (c_a * q_a + c_b * q_b) / q
    } else {
        c_a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        kind: ScenarioType,
        started_at: f64,
        duration_min: f64,
        magnitude: f64,
    ) -> ScenarioSpec {
        ScenarioSpec {
            kind,
            duration_min,
            started_at,
            magnitude,
        }
    }

    #[test]
    fn envelope_respects_ramps_and_window() {
        let s = spec(ScenarioType::Storm, 0.0, 360.0, 1.0);
        assert_eq!(scenario_envelope(None, 0.0), 0.0);
        assert_eq!(scenario_envelope(Some(&s), -1.0), 0.0);
        assert_eq!(scenario_envelope(Some(&s), 0.0), 0.0);
        assert_eq!(scenario_envelope(Some(&s), 10.0), 0.5);
        assert_eq!(scenario_envelope(Some(&s), 100.0), 1.0);
        assert_eq!(scenario_envelope(Some(&s), 360.0), 0.0);
        assert_eq!(scenario_envelope(Some(&s), 361.0), 0.0);
    }

    #[test]
    fn power_outage_drops_all_recycles() {
        let c = Controls {
            ras_ratio: 3.0,
            internal_recirc: 4.0,
            was_ratio: 0.5,
        };
        let s = spec(ScenarioType::PowerOutage, 0.0, 45.0, 0.0);
        let mid = recycle_factors(&c, Some(&s), 20.0);
        assert_eq!(mid.ir, 0.0);
        assert!(mid.ras >= 0.0 && mid.ras < 3.0);
        assert!(mid.was >= 0.0 && mid.was < 0.5);
        assert_eq!(aeration_capacity(Some(&s), 20.0), 0.0);
    }

    #[test]
    fn blower_failure_clamps_magnitude() {
        let s = spec(ScenarioType::BlowerFailure, 0.0, 180.0, 30.0);
        assert_eq!(aeration_capacity(Some(&s), 100.0), 1.0);
        let s = spec(ScenarioType::BlowerFailure, 0.0, 180.0, -5.0);
        assert_eq!(aeration_capacity(Some(&s), 100.0), 0.0);
        let s = spec(ScenarioType::BlowerFailure, 0.0, 180.0, f64::NAN);
        assert_eq!(aeration_capacity(Some(&s), 100.0), 0.5);
    }
}

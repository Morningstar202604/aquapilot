//! Takács-style ten-layer clarifier.
//!
//! The settler is a finite-volume column with a feed layer, upward overflow
//! flow, downward underflow flow and a hindered settling flux between layers.
//! The velocity law is `v_max * (exp(-a X) - exp(-b X))`, with `a < b` so the
//! flux is positive for positive solids. This is a documented engineering
//! approximation, not a site-calibrated Takács parameter set.

use aquapilot_domain::SettlerParams;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SettlerError {
    #[error("clarifier needs at least two layers")]
    TooFewLayers,
    #[error("feed layer {feed_layer} is outside 1..{layers}")]
    InvalidFeedLayer { feed_layer: usize, layers: usize },
    #[error("clarifier flows do not balance: feed={feed:.6}, overflow={overflow:.6}, underflow={underflow:.6}")]
    FlowImbalance {
        feed: f64,
        overflow: f64,
        underflow: f64,
    },
    #[error("clarifier state became non-finite")]
    NonFinite,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClarifierState {
    /// Layer 0 is the bottom (underflow) layer; the last layer is the top
    /// (overflow) layer. Values are g TSS/m3.
    pub layers: Vec<f64>,
    pub feed_layer: usize,
}

impl ClarifierState {
    pub fn new(layers: usize, feed_layer: usize, initial_tss: f64) -> Result<Self, SettlerError> {
        if layers < 2 {
            return Err(SettlerError::TooFewLayers);
        }
        if feed_layer == 0 || feed_layer >= layers - 1 {
            return Err(SettlerError::InvalidFeedLayer { feed_layer, layers });
        }
        Ok(Self {
            layers: vec![initial_tss.max(0.0); layers],
            feed_layer,
        })
    }

    pub fn layer_count(&self) -> usize {
        self.layers.len()
    }

    pub fn layer_volume_m3(&self, area_m2: f64, depth_m: f64) -> f64 {
        area_m2 * depth_m / self.layers.len() as f64
    }

    pub fn stored_solids_kg(&self, area_m2: f64, depth_m: f64) -> f64 {
        let volume = self.layer_volume_m3(area_m2, depth_m);
        self.layers.iter().sum::<f64>() * volume / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClarifierOutput {
    pub overflow_tss: f64,
    pub underflow_tss: f64,
    pub overflow_flow_m3_h: f64,
    pub underflow_flow_m3_h: f64,
    /// Integrated solids mass over the step, kg.
    pub overflow_mass_kg: f64,
    pub underflow_mass_kg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClarifierStepInput {
    pub feed_tss: f64,
    pub feed_flow_m3_h: f64,
    pub overflow_flow_m3_h: f64,
    pub underflow_flow_m3_h: f64,
    pub area_m2: f64,
    pub depth_m: f64,
    pub dt_h: f64,
}

/// Advance the ten-layer settler by `input.dt_h` hours.
///
/// The function is explicit in time and substeps at roughly 0.02 h to keep the
/// settling CFL bounded. Negative layer concentrations are clamped at zero;
/// non-finite states return an error instead of being silently projected.
pub fn step_clarifier(
    state: &mut ClarifierState,
    input: &ClarifierStepInput,
    params: &SettlerParams,
) -> Result<ClarifierOutput, SettlerError> {
    let ClarifierStepInput {
        feed_tss,
        feed_flow_m3_h,
        overflow_flow_m3_h,
        underflow_flow_m3_h,
        area_m2,
        depth_m,
        dt_h,
    } = *input;
    let layers = state.layers.len();
    if layers < 2 {
        return Err(SettlerError::TooFewLayers);
    }
    if state.feed_layer == 0 || state.feed_layer >= layers - 1 {
        return Err(SettlerError::InvalidFeedLayer {
            feed_layer: state.feed_layer,
            layers,
        });
    }
    if !feed_tss.is_finite()
        || !feed_flow_m3_h.is_finite()
        || !overflow_flow_m3_h.is_finite()
        || !underflow_flow_m3_h.is_finite()
        || !area_m2.is_finite()
        || area_m2 <= 0.0
        || !depth_m.is_finite()
        || depth_m <= 0.0
        || !dt_h.is_finite()
        || dt_h <= 0.0
    {
        return Err(SettlerError::NonFinite);
    }

    let tolerance = 1e-6 * feed_flow_m3_h.max(1.0);
    if (overflow_flow_m3_h + underflow_flow_m3_h - feed_flow_m3_h).abs() > tolerance {
        return Err(SettlerError::FlowImbalance {
            feed: feed_flow_m3_h,
            overflow: overflow_flow_m3_h,
            underflow: underflow_flow_m3_h,
        });
    }

    let layer_volume = area_m2 * depth_m / layers as f64;
    if layer_volume <= 0.0 {
        return Err(SettlerError::NonFinite);
    }

    let substeps = (dt_h / 0.02).ceil().clamp(1.0, 200.0) as usize;
    let sub_dt = dt_h / substeps as f64;
    let mut overflow_mass_kg = 0.0;
    let mut underflow_mass_kg = 0.0;

    for _ in 0..substeps {
        let old = state.layers.clone();
        let settling_flux: Vec<f64> = (0..layers)
            .map(|index| {
                if index == 0 {
                    // The bottom layer is emptied by the underflow stream;
                    // adding a separate settling sink here would create mass.
                    return 0.0;
                }
                let lower = old[index - 1];
                let representative = old[index].min(lower).max(0.0);
                let velocity_m_per_h = settling_velocity(representative, params) / 24.0;
                let flux = velocity_m_per_h * area_m2 * old[index];
                // A layer cannot lose more solids than it contains in one
                // substep. This is a numerical CFL guard, not a model change.
                let cap = 0.5 * old[index] * layer_volume / sub_dt;
                flux.min(cap).max(0.0)
            })
            .collect();

        let mut next = vec![0.0; layers];
        for index in 0..layers {
            let bulk_in = if index == state.feed_layer {
                feed_flow_m3_h * feed_tss
            } else if index > state.feed_layer {
                overflow_flow_m3_h * old[index - 1]
            } else {
                underflow_flow_m3_h * old[index + 1]
            };
            let bulk_out = if index == state.feed_layer {
                (overflow_flow_m3_h + underflow_flow_m3_h) * old[index]
            } else if index > state.feed_layer {
                overflow_flow_m3_h * old[index]
            } else {
                underflow_flow_m3_h * old[index]
            };
            let settling_in = if index + 1 < layers {
                settling_flux[index + 1]
            } else {
                0.0
            };
            let settling_out = settling_flux[index];
            let derivative = (bulk_in - bulk_out + settling_in - settling_out) / layer_volume;
            next[index] = (old[index] + sub_dt * derivative).max(0.0);
        }
        if next.iter().any(|value| !value.is_finite()) {
            return Err(SettlerError::NonFinite);
        }
        overflow_mass_kg += overflow_flow_m3_h * old[layers - 1] * sub_dt / 1000.0;
        underflow_mass_kg += underflow_flow_m3_h * old[0] * sub_dt / 1000.0;
        state.layers = next;
    }

    Ok(ClarifierOutput {
        overflow_tss: state.layers[layers - 1],
        underflow_tss: state.layers[0],
        overflow_flow_m3_h,
        underflow_flow_m3_h,
        overflow_mass_kg,
        underflow_mass_kg,
    })
}

/// Takács hindered settling velocity in m/d.
pub fn settling_velocity(x_g_per_m3: f64, params: &SettlerParams) -> f64 {
    if x_g_per_m3 <= 0.0 {
        return 0.0;
    }
    let x = x_g_per_m3.clamp(params.x_min_g_per_m3, params.x_max_g_per_m3);
    let raw = params.v_max_m_per_d
        * ((-params.a_per_g_per_m3 * x).exp() - (-params.b_per_g_per_m3 * x).exp());
    raw.max(0.0).min(params.v_max_m_per_d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> SettlerParams {
        SettlerParams::default()
    }

    #[test]
    fn settling_velocity_is_positive_and_decreases_with_solids() {
        let p = params();
        let dilute = settling_velocity(500.0, &p);
        let thick = settling_velocity(5000.0, &p);
        assert!(dilute > thick);
        assert!(thick > 0.0);
        assert_eq!(settling_velocity(0.0, &p), 0.0);
    }

    #[test]
    fn layer_mass_balance_closes_over_one_hour() {
        let area = 1500.0;
        let depth = 4.0;
        let mut state = ClarifierState::new(10, 5, 2500.0).expect("valid state");
        let initial = state.stored_solids_kg(area, depth);
        let feed_tss = 2500.0;
        let feed_flow = 2000.0;
        let overflow_flow = 990.0;
        let underflow_flow = 1010.0;
        let output = step_clarifier(
            &mut state,
            &ClarifierStepInput {
                feed_tss,
                feed_flow_m3_h: feed_flow,
                overflow_flow_m3_h: overflow_flow,
                underflow_flow_m3_h: underflow_flow,
                area_m2: area,
                depth_m: depth,
                dt_h: 1.0,
            },
            &params(),
        )
        .expect("settler step");
        let final_stored = state.stored_solids_kg(area, depth);
        let fed = feed_tss * feed_flow * 1.0 / 1000.0;
        let removed = output.overflow_mass_kg + output.underflow_mass_kg;
        let balance = fed - removed - (final_stored - initial);
        assert!(balance.abs() / fed < 1e-8, "balance={balance}");
    }

    #[test]
    fn flow_imbalance_is_rejected() {
        let mut state = ClarifierState::new(10, 5, 1000.0).expect("valid state");
        let error = step_clarifier(
            &mut state,
            &ClarifierStepInput {
                feed_tss: 1000.0,
                feed_flow_m3_h: 1000.0,
                overflow_flow_m3_h: 900.0,
                underflow_flow_m3_h: 50.0,
                area_m2: 1000.0,
                depth_m: 4.0,
                dt_h: 0.1,
            },
            &params(),
        )
        .expect_err("imbalance");
        assert!(matches!(error, SettlerError::FlowImbalance { .. }));
    }

    #[test]
    fn feed_layer_must_not_be_boundary_layer() {
        let error = ClarifierState::new(10, 0, 1000.0).expect_err("feed layer 0");
        assert!(matches!(error, SettlerError::InvalidFeedLayer { .. }));
    }
}

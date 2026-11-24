//! Takács ten-layer secondary clarifier (BSM1 slice).
//!
//! Ported from the TypeScript oracle `src/sim/takacs.ts`. The 10-layer
//! finite-volume flux form is kept byte-for-byte in operation order so the
//! golden profile can be compared at `<= 1e-12`; no extra dispersion, no
//! implicit solver and no alternative compression law is introduced here.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SettlerConfig {
    pub area: f64,
    pub depth: f64,
    pub layers: usize,
    pub feed_layer: usize,
    pub v0_max: f64,
    pub v0: f64,
    pub rh: f64,
    pub rp: f64,
    pub f_ns: f64,
    pub x_threshold: f64,
    pub x_max: f64,
}

pub const BSM1_SETTLER: SettlerConfig = SettlerConfig {
    area: 1500.0,
    depth: 4.0,
    layers: 10,
    feed_layer: 5,
    v0_max: 250.0,
    v0: 474.0,
    rh: 0.000576,
    rp: 0.00286,
    f_ns: 0.0022,
    x_threshold: 3000.0,
    x_max: 20_000.0,
};

#[derive(Debug, Clone, PartialEq)]
pub struct SettlerState {
    /// Layer concentrations, index 0 is the top layer.
    pub x: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
pub struct SettlerFeed {
    pub flow: f64,
    pub concentration: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct SettlerUnderflow {
    pub flow: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettlerResult {
    pub state: SettlerState,
    pub x_effluent: f64,
    pub x_underflow: f64,
    pub solids_loading: f64,
}

/// Takács double-exponential settling velocity, m/d.
pub fn settling_velocity(x: f64, cfg: &SettlerConfig, x_feed: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let effective = (x - cfg.f_ns * x_feed).max(0.0);
    let raw = cfg.v0 * ((-cfg.rh * effective).exp() - (-cfg.rp * effective).exp());
    raw.clamp(0.0, cfg.v0_max)
}

pub fn create_settler(cfg: &SettlerConfig, initial_x: f64) -> SettlerState {
    SettlerState {
        x: vec![initial_x; cfg.layers],
    }
}

fn compression_flux(x: f64) -> f64 {
    const COMPRESSION_X: f64 = 1200.0;
    const COMPRESSION_K: f64 = 0.012;
    const COMPRESSION_XMAX: f64 = 12_000.0;
    if x > COMPRESSION_X {
        COMPRESSION_K * (x - COMPRESSION_X) * (x / COMPRESSION_XMAX)
    } else {
        0.0
    }
}

fn flux_at(
    j: usize,
    xs: &[f64],
    cfg: &SettlerConfig,
    feed_idx: usize,
    v_up: f64,
    v_dn: f64,
    feed_concentration: f64,
) -> f64 {
    let n = xs.len();
    if j == 0 {
        return -v_up * xs[0];
    }
    if j >= n {
        return v_dn * xs[n - 1];
    }
    let x_up = xs[j - 1];
    let x_dn = xs[j];
    let x_lim = x_up.min(x_dn);
    let in_clarification = j <= feed_idx;
    let j_flux = if in_clarification && x_dn <= cfg.x_threshold {
        settling_velocity(x_up, cfg, feed_concentration) * x_up
    } else {
        settling_velocity(x_lim, cfg, feed_concentration) * x_lim
    };
    if j > feed_idx {
        j_flux + v_dn * x_up + compression_flux(x_dn)
    } else {
        j_flux - v_up * x_dn
    }
}

/// Advance one time step. `dt_days` is in days; CFL sub-stepping is internal.
pub fn step_settler(
    state: &SettlerState,
    cfg: &SettlerConfig,
    feed: SettlerFeed,
    underflow: SettlerUnderflow,
    dt_days: f64,
) -> SettlerResult {
    let n = cfg.layers;
    if !cfg.area.is_finite() || cfg.area <= 0.0 || !cfg.depth.is_finite() || cfg.depth <= 0.0 {
        return SettlerResult {
            state: state.clone(),
            x_effluent: state.x.first().copied().unwrap_or(0.0),
            x_underflow: state.x.last().copied().unwrap_or(0.0),
            solids_loading: 0.0,
        };
    }
    if n == 0 || state.x.len() < n {
        return SettlerResult {
            state: state.clone(),
            x_effluent: 0.0,
            x_underflow: 0.0,
            solids_loading: 0.0,
        };
    }

    let z = cfg.depth / n as f64;
    let feed_layer = cfg.feed_layer.clamp(1, n);
    let feed_idx = feed_layer - 1;
    let qf = feed.flow.max(1e-6);
    let qu = (qf * 0.95).min(underflow.flow.max(0.0));
    let qe = (qf - qu).max(1e-6);
    let v_up = qe / cfg.area;
    let v_dn = qu / cfg.area;

    let safe_z = z.max(1e-3);
    let max_dt = (0.4 * safe_z) / cfg.v0_max.max(1e-6);
    let raw_sub_steps = dt_days / max_dt.max(1e-9);
    let sub_steps = if raw_sub_steps.is_finite() {
        (raw_sub_steps.ceil() as usize).clamp(1, 2000)
    } else {
        2000
    };
    let dt = dt_days / sub_steps as f64;

    let mut xs = state.x[..n].to_vec();
    for _ in 0..sub_steps {
        let mut next = vec![0.0; n];
        let mut fluxes = vec![0.0; n + 1];
        for (j, flux) in fluxes.iter_mut().enumerate() {
            *flux = flux_at(j, &xs, cfg, feed_idx, v_up, v_dn, feed.concentration);
        }
        for i in 0..n {
            let mut mass = fluxes[i] - fluxes[i + 1];
            if i == feed_idx {
                mass += qf * feed.concentration / cfg.area;
            }
            next[i] = (xs[i] + (mass / z) * dt).clamp(0.0, cfg.x_max);
        }
        xs = next;
    }

    let x_effluent = xs[0];
    let x_underflow = xs[n - 1];
    let solids_loading = ((qf / 24.0) * (feed.concentration / 1000.0)) / cfg.area;
    SettlerResult {
        state: SettlerState { x: xs },
        x_effluent,
        x_underflow,
        solids_loading,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settling_velocity_has_expected_shape() {
        let cfg = BSM1_SETTLER;
        assert_eq!(settling_velocity(0.0, &cfg, 0.0), 0.0);
        let low = settling_velocity(100.0, &cfg, 0.0);
        let high = settling_velocity(1000.0, &cfg, 0.0);
        assert!(high > low);
        assert!(high >= 0.0);
        assert!(low <= cfg.v0_max);
    }

    #[test]
    fn invalid_geometry_is_a_noop() {
        let cfg = SettlerConfig {
            area: 0.0,
            ..BSM1_SETTLER
        };
        let state = create_settler(&BSM1_SETTLER, 3000.0);
        let out = step_settler(
            &state,
            &cfg,
            SettlerFeed {
                flow: 10.0,
                concentration: 3000.0,
            },
            SettlerUnderflow { flow: 1.0 },
            1.0,
        );
        assert_eq!(out.state, state);
        assert_eq!(out.solids_loading, 0.0);
    }
}

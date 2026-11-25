//! Sludge line: waste activated sludge -> thickener -> ADM1 digester ->
//! dewatering -> cake + filtrate recycle.
//!
//! Ported from the TypeScript oracle `src/sim/sludgeLine.ts`. The model is a
//! deliberately auditable plant-boundary slice: gravity thickening is a fixed
//! split, the digester is one ADM1 CSTR, and dewatering uses a fixed cake
//! solids fraction. It is not a layered thickener or a two-phase digester.

use crate::adm1::{self, Component};
use crate::network::Influent;

/// Process constants, kept identical to `SLUDGE_LINE_DEFAULTS` in TypeScript.
pub const SUPERNATANT_FRACTION: f64 = 0.45;
pub const THICKENING_FACTOR: f64 = 2.5;
pub const SUPERNATANT_SS_FRACTION: f64 = 0.15;
pub const DIGESTER_SRT_DAYS: f64 = 22.0;
pub const DIGESTER_TEMP_C: f64 = 35.0;
pub const VSS_FRACTION: f64 = 0.75;
pub const VS_DESTRUCTION: f64 = 0.55;
pub const CH4_M3_PER_VS_KG: f64 = 0.35;
pub const CH4_FRACTION: f64 = 0.65;
pub const CH4_DENSITY_KG_M3: f64 = 0.717;
pub const CAKE_SOLIDS_FRACTION: f64 = 0.2;
pub const FILTRATE_N_FRACTION: f64 = 0.6;
pub const FILTRATE_COD_FRACTION: f64 = 0.1;
pub const FILTRATE_TP_FRACTION: f64 = 0.5;
pub const MIXING_KW_PER_M3: f64 = 0.05;
pub const WATER_CP_KJ_PER_KG_C: f64 = 4.18;
pub const NITROGEN_PER_DRY_SOLIDS: f64 = 0.07;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SludgeFeed {
    pub was_flow_m3h: f64,
    pub feed_ss_kg_m3: f64,
    pub feed_cod_kg_m3: f64,
    pub feed_n_kg_m3: f64,
    pub feed_p_kg_m3: f64,
    pub ambient_temp_c: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Filtrate {
    pub flow_m3h: f64,
    pub nh4_n_kg_m3: f64,
    pub cod_kg_m3: f64,
    pub tp_kg_m3: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Thickener {
    pub feed_flow_m3h: f64,
    pub feed_ss_kg_m3: f64,
    pub underflow_flow_m3h: f64,
    pub underflow_ss_kg_m3: f64,
    pub supernatant_flow_m3h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DigesterGas {
    pub methane_m3d: f64,
    pub co2_m3d: f64,
    pub h2_m3d: f64,
    pub total_m3d: f64,
    pub ch4_fraction: f64,
    pub methane_kg_d: f64,
    pub vss_destroyed_kg_d: f64,
    pub heating_kw: f64,
    pub mixing_kw: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Digester {
    pub volume_m3: f64,
    pub temperature_c: f64,
    pub srt_days: f64,
    pub adm1: adm1::State,
    pub gas: DigesterGas,
}

impl Default for Digester {
    fn default() -> Self {
        Self {
            volume_m3: 0.0,
            temperature_c: DIGESTER_TEMP_C,
            srt_days: DIGESTER_SRT_DAYS,
            adm1: adm1::empty_state(),
            gas: DigesterGas::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Dewatering {
    pub cake_dry_solids_kg_d: f64,
    pub cake_wet_kg_d: f64,
    pub filtrate: Filtrate,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Cumulative {
    pub raw_sludge_kg_d: f64,
    pub cake_kg_d: f64,
    pub methane_m3: f64,
    pub filtrate_nh4_kg: f64,
    pub filtrate_cod_kg: f64,
    pub filtrate_tp_kg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SludgeError {
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SludgeLine {
    pub enabled: bool,
    pub thickener: Thickener,
    pub digester: Digester,
    pub dewatering: Dewatering,
    pub cumulative: Cumulative,
    pub errors: Vec<SludgeError>,
}

fn clamp_non_finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        fallback
    }
}

fn sludge_to_adm1_in(feed: &SludgeFeed) -> adm1::State {
    let solids = clamp_non_finite(feed.feed_ss_kg_m3, 0.0);
    let mut state = adm1::empty_state();
    state.set(Component::Xc, solids * 0.85);
    state.set(Component::SIN, clamp_non_finite(feed.feed_n_kg_m3, 0.0));
    state.set(Component::SIC, 10.0);
    state.set(Component::SI, solids * 0.1);
    state.set(Component::SAc, 0.2);
    state.set(Component::SSu, 0.3);
    state.set(Component::SAa, 0.2);
    state
}

/// Apply a filtrate recycle load to the plant influent, using the same
/// flow-weighted mixing rule as `NetworkEngine` in TypeScript.
///
/// This is the coupling point between the sludge line and the water line. It
/// deliberately takes the plant flow explicitly instead of hiding it in a
/// global, so a caller cannot silently apply a load without a flow basis.
pub fn apply_filtrate_to_influent(
    influent: &mut Influent,
    filtrate: Filtrate,
    plant_flow_m3h: f64,
) {
    if filtrate.flow_m3h <= 1e-6 || plant_flow_m3h <= 1e-6 {
        return;
    }
    let nh_load = filtrate.nh4_n_kg_m3 * filtrate.flow_m3h / plant_flow_m3h;
    influent.nh += nh_load;
    influent.tn += nh_load;
    influent.cod += filtrate.cod_kg_m3 * filtrate.flow_m3h / plant_flow_m3h;
    influent.tp += filtrate.tp_kg_m3 * filtrate.flow_m3h / plant_flow_m3h;
}

impl SludgeLine {
    /// Create a disabled or enabled line. Disabled lines stay all-zero and are
    /// never allowed to leak a filtrate load into the water line.
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            thickener: Thickener::default(),
            digester: Digester::default(),
            dewatering: Dewatering::default(),
            cumulative: Cumulative::default(),
            errors: Vec::new(),
        }
    }

    /// Advance one time step and return this step's filtrate recycle load.
    pub fn step(&mut self, feed: &SludgeFeed, dt_hours: f64) -> Filtrate {
        self.errors.clear();
        if !self.enabled {
            return Filtrate::default();
        }

        let was_flow = clamp_non_finite(feed.was_flow_m3h, 0.0);
        let feed_ss = clamp_non_finite(feed.feed_ss_kg_m3, 0.0);
        let feed_cod = clamp_non_finite(feed.feed_cod_kg_m3, 0.0);
        let feed_n = clamp_non_finite(feed.feed_n_kg_m3, 0.0);
        let feed_p = clamp_non_finite(feed.feed_p_kg_m3, 0.0);
        let ambient = if feed.ambient_temp_c.is_finite() {
            feed.ambient_temp_c
        } else {
            20.0
        };

        if was_flow <= 1e-6 {
            return Filtrate::default();
        }

        // Thickener: fixed split and concentration factor.
        let supernatant_flow = was_flow * SUPERNATANT_FRACTION;
        let underflow_flow = was_flow - supernatant_flow;
        let underflow_ss = (feed_ss * THICKENING_FACTOR).min(feed_ss * 3.0);
        self.thickener = Thickener {
            feed_flow_m3h: was_flow,
            feed_ss_kg_m3: feed_ss,
            underflow_flow_m3h: underflow_flow,
            underflow_ss_kg_m3: underflow_ss,
            supernatant_flow_m3h: supernatant_flow,
        };

        // Digester: ADM1 CSTR. Volume is derived from the feed flow and SRT.
        let digester_volume = (underflow_flow * DIGESTER_SRT_DAYS * 24.0 / 24.0).max(1.0);
        let adm1_in = sludge_to_adm1_in(feed);
        let adm1_out = adm1::step_adm1(
            &self.digester.adm1,
            &adm1_in,
            &adm1::PARAMS,
            adm1::StepOptions {
                volume: digester_volume,
                flow: underflow_flow,
                dt_hours,
            },
        );
        self.digester.adm1 = adm1_out.state;
        self.digester.volume_m3 = digester_volume;
        self.digester.srt_days = DIGESTER_SRT_DAYS;

        // Gas accounting is deliberately independent of the ADM1 gas-phase
        // scale so the plant report can audit VS destruction directly.
        let vss_in_kg_h = feed_ss * VSS_FRACTION * underflow_flow / 1000.0;
        let vss_destroyed_kg_h = vss_in_kg_h * VS_DESTRUCTION;
        let vss_destroyed_kg_d = vss_destroyed_kg_h * 24.0;
        let methane_m3d = vss_destroyed_kg_d * CH4_M3_PER_VS_KG;
        let co2_m3d = methane_m3d * ((1.0 - CH4_FRACTION) / CH4_FRACTION);
        let total_m3d = methane_m3d + co2_m3d;
        let methane_kg_d = methane_m3d * CH4_DENSITY_KG_M3;

        let feed_mass_kg_h = underflow_flow * 1000.0;
        let heating_kw =
            feed_mass_kg_h * WATER_CP_KJ_PER_KG_C * (DIGESTER_TEMP_C - ambient).max(0.0) / 3600.0;
        let mixing_kw = digester_volume * MIXING_KW_PER_M3;

        self.digester.gas = DigesterGas {
            methane_m3d,
            co2_m3d,
            h2_m3d: 0.0,
            total_m3d,
            ch4_fraction: if total_m3d > 1e-9 { CH4_FRACTION } else { 0.0 },
            methane_kg_d,
            vss_destroyed_kg_d,
            heating_kw,
            mixing_kw,
        };

        // Dewatering: mass balance on this step, not a daily-flow shortcut.
        let solids_in_kg_h = feed_ss * underflow_flow / 1000.0;
        let dry_cake_kg_h = (solids_in_kg_h - vss_destroyed_kg_h).max(0.0);
        let cake_wet_kg_h = dry_cake_kg_h / CAKE_SOLIDS_FRACTION;
        let sludge_bound_n = solids_in_kg_h * NITROGEN_PER_DRY_SOLIDS;
        let mineralized_n = sludge_bound_n * VS_DESTRUCTION;
        let feed_n_kg_h = feed_n * underflow_flow / 1000.0;
        let filtrate_n_kg_h = (feed_n_kg_h + mineralized_n).max(0.0);
        let filtrate_cod_kg_h = (feed_cod * underflow_flow / 1000.0) * FILTRATE_COD_FRACTION;
        let filtrate_p_kg_h = (feed_p * underflow_flow / 1000.0) * FILTRATE_TP_FRACTION;
        let filtrate_flow = (underflow_flow + supernatant_flow - cake_wet_kg_h / 1000.0).max(0.0);

        self.dewatering = Dewatering {
            cake_dry_solids_kg_d: dry_cake_kg_h * 24.0,
            cake_wet_kg_d: cake_wet_kg_h * 24.0,
            filtrate: Filtrate {
                flow_m3h: filtrate_flow,
                nh4_n_kg_m3: filtrate_n_kg_h * 1000.0 / filtrate_flow.max(1e-3),
                cod_kg_m3: filtrate_cod_kg_h * 1000.0 / filtrate_flow.max(1e-3),
                tp_kg_m3: filtrate_p_kg_h * 1000.0 / filtrate_flow.max(1e-3),
            },
        };

        // Cumulative loads since the end of warm-up.
        self.cumulative.raw_sludge_kg_d += solids_in_kg_h * dt_hours;
        self.cumulative.cake_kg_d += cake_wet_kg_h * dt_hours;
        self.cumulative.methane_m3 += methane_m3d * (dt_hours / 24.0);
        self.cumulative.filtrate_nh4_kg += filtrate_n_kg_h * dt_hours;
        self.cumulative.filtrate_cod_kg += filtrate_cod_kg_h * dt_hours;
        self.cumulative.filtrate_tp_kg += filtrate_p_kg_h * dt_hours;

        self.dewatering.filtrate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed() -> SludgeFeed {
        SludgeFeed {
            was_flow_m3h: 80.0,
            feed_ss_kg_m3: 8000.0,
            feed_cod_kg_m3: 12000.0,
            feed_n_kg_m3: 600.0,
            feed_p_kg_m3: 120.0,
            ambient_temp_c: 18.0,
        }
    }

    #[test]
    fn disabled_line_is_zero_and_does_not_touch_state() {
        let mut line = SludgeLine::new(false);
        let out = line.step(&feed(), 0.5);
        assert_eq!(out, Filtrate::default());
        assert_eq!(line.thickener, Thickener::default());
        assert_eq!(line.digester.adm1, adm1::empty_state());
        assert_eq!(line.cumulative, Cumulative::default());
    }

    #[test]
    fn zero_was_flow_returns_zero_filtrate() {
        let mut line = SludgeLine::new(true);
        let mut f = feed();
        f.was_flow_m3h = 0.0;
        assert_eq!(line.step(&f, 0.5), Filtrate::default());
    }

    #[test]
    fn filtrate_recycle_is_flow_weighted() {
        let mut influent = Influent {
            flow: 2000.0,
            cod: 300.0,
            nh: 30.0,
            tn: 40.0,
            tp: 4.0,
            ss: 150.0,
            alkalinity: 300.0,
        };
        let filtrate = Filtrate {
            flow_m3h: 50.0,
            nh4_n_kg_m3: 500.0,
            cod_kg_m3: 600.0,
            tp_kg_m3: 30.0,
        };
        apply_filtrate_to_influent(&mut influent, filtrate, 2000.0);
        assert!((influent.nh - (30.0 + 12.5)).abs() < 1e-12);
        assert!((influent.tn - (40.0 + 12.5)).abs() < 1e-12);
        assert!((influent.cod - (300.0 + 15.0)).abs() < 1e-12);
        assert!((influent.tp - (4.0 + 0.75)).abs() < 1e-12);
    }

    #[test]
    fn step_is_finite_and_mass_bounded() {
        let mut line = SludgeLine::new(true);
        let mut last = Filtrate::default();
        for _ in 0..96 {
            last = line.step(&feed(), 0.5);
            assert!(last.flow_m3h.is_finite() && last.flow_m3h >= 0.0);
            assert!(last.nh4_n_kg_m3.is_finite() && last.nh4_n_kg_m3 >= 0.0);
            assert!(line.digester.gas.methane_m3d.is_finite());
        }
        assert!(line.dewatering.cake_wet_kg_d > 0.0);
        assert!(line.cumulative.raw_sludge_kg_d > 0.0);
        assert!(last.flow_m3h > 0.0);
    }
}

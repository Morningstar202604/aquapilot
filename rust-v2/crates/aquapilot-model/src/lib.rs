//! ASM1 (Henze et al., 1987) activated sludge model.
//!
//! This is a clean-room implementation from the published model structure.
//! All concentrations are mg/L (= g/m3); rates are g/m3/h. Parameter values
//! are stored per day and converted inside `reaction_rates`.

pub mod asm2d;
pub mod asm2d_plant;
pub mod settler;

use serde::{Deserialize, Serialize};

/// The 13 ASM1 state variables.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm1State {
    /// Soluble inert organic matter, g COD/m3
    pub si: f64,
    /// Readily biodegradable substrate, g COD/m3
    pub ss: f64,
    /// Particulate inert organic matter, g COD/m3
    pub xi: f64,
    /// Slowly biodegradable substrate, g COD/m3
    pub xs: f64,
    /// Heterotrophic biomass, g COD/m3
    pub xbh: f64,
    /// Autotrophic biomass, g COD/m3
    pub xba: f64,
    /// Particulate products from biomass decay, g COD/m3
    pub xp: f64,
    /// Dissolved oxygen, g O2/m3
    pub so: f64,
    /// Nitrate/nitrite nitrogen, g N/m3
    pub sno: f64,
    /// Ammonium nitrogen, g N/m3
    pub snh: f64,
    /// Soluble biodegradable organic nitrogen, g N/m3
    pub snd: f64,
    /// Particulate biodegradable organic nitrogen, g N/m3
    pub xnd: f64,
    /// Alkalinity, mg/L as CaCO3
    pub salk: f64,
}

impl Asm1State {
    pub fn zeros() -> Self {
        Self {
            si: 0.0,
            ss: 0.0,
            xi: 0.0,
            xs: 0.0,
            xbh: 0.0,
            xba: 0.0,
            xp: 0.0,
            so: 0.0,
            sno: 0.0,
            snh: 0.0,
            snd: 0.0,
            xnd: 0.0,
            salk: 0.0,
        }
    }

    pub fn values(&self) -> [f64; 13] {
        [
            self.si, self.ss, self.xi, self.xs, self.xbh, self.xba, self.xp, self.so, self.sno,
            self.snh, self.snd, self.xnd, self.salk,
        ]
    }

    /// Construct from the canonical 13-value order used by fixtures:
    /// `[S_I, S_S, X_I, X_S, X_BH, X_BA, X_P, S_O, S_NO, S_NH, S_ND, X_ND, S_ALK]`.
    pub fn from_values(values: [f64; 13]) -> Self {
        Self {
            si: values[0],
            ss: values[1],
            xi: values[2],
            xs: values[3],
            xbh: values[4],
            xba: values[5],
            xp: values[6],
            so: values[7],
            sno: values[8],
            snh: values[9],
            snd: values[10],
            xnd: values[11],
            salk: values[12],
        }
    }

    pub fn is_finite_non_negative(&self) -> bool {
        self.values()
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
    }

    /// `self += other * weight`, used by flow-weighted mixers.
    pub fn add_weighted(&mut self, other: &Self, weight: f64) {
        self.si += other.si * weight;
        self.ss += other.ss * weight;
        self.xi += other.xi * weight;
        self.xs += other.xs * weight;
        self.xbh += other.xbh * weight;
        self.xba += other.xba * weight;
        self.xp += other.xp * weight;
        self.so += other.so * weight;
        self.sno += other.sno * weight;
        self.snh += other.snh * weight;
        self.snd += other.snd * weight;
        self.xnd += other.xnd * weight;
        self.salk += other.salk * weight;
    }

    /// Clamp every component into `[0, +inf)`. Returns true if any value
    /// actually changed, so the engine can emit a diagnostic.
    pub fn clamp_non_negative(&mut self) -> bool {
        let mut changed = false;
        for value in [
            &mut self.si,
            &mut self.ss,
            &mut self.xi,
            &mut self.xs,
            &mut self.xbh,
            &mut self.xba,
            &mut self.xp,
            &mut self.so,
            &mut self.sno,
            &mut self.snh,
            &mut self.snd,
            &mut self.xnd,
            &mut self.salk,
        ] {
            if !value.is_finite() || *value < 0.0 {
                *value = 0.0;
                changed = true;
            }
        }
        changed
    }

    /// Aggregate COD used by the product snapshot.
    pub fn total_cod(&self) -> f64 {
        self.si + self.ss + self.xi + self.xs + self.xbh + self.xba + self.xp
    }

    /// Particulate COD that can be captured by a clarifier.
    pub fn particulate_cod(&self) -> f64 {
        self.xi + self.xs + self.xbh + self.xba + self.xp
    }

    /// Suspended solids at the conventional 1.42 g COD/g VSS conversion.
    pub fn suspended_solids(&self) -> f64 {
        self.particulate_cod() / 1.42
    }

    /// Return a copy with the particulate fraction scaled to a target TSS.
    /// Soluble components are untouched; this is how a clarifier overflow or
    /// underflow stream is reconstructed from its layer TSS.
    pub fn with_particulate_tss(&self, target_tss: f64) -> Self {
        let current = self.suspended_solids();
        let factor = if current > 1e-12 {
            (target_tss.max(0.0) / current).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let mut next = *self;
        next.xi *= factor;
        next.xs *= factor;
        next.xbh *= factor;
        next.xba *= factor;
        next.xp *= factor;
        next
    }

    pub fn total_nitrogen(&self) -> f64 {
        self.snh + self.sno + self.snd + self.xnd + 0.086 * (self.xbh + self.xba)
    }

    /// Map a product-level aggregate characterization onto the 13 ASM1
    /// components. This is an initialization aid, not a calibrated
    /// fractionation: it preserves COD, NH4-N, NO3-N and DO, and places the
    /// remaining particulate COD into the biomass/inert/slow fractions.
    pub fn from_aggregates(
        cod: f64,
        nh4_n: f64,
        no3_n: f64,
        dissolved_oxygen: f64,
        alkalinity: f64,
        mlss: f64,
        _temperature_c: f64,
    ) -> Self {
        let particulate_cod = (mlss * 1.42).min(cod);
        let soluble_cod = (cod - particulate_cod).max(0.0);

        let xs = 0.20 * particulate_cod;
        let xi = 0.10 * particulate_cod;
        let xbh = 0.60 * particulate_cod;
        let xba = 0.05 * particulate_cod;
        let xp = 0.05 * particulate_cod;
        let si = 0.40 * soluble_cod;
        let ss = 0.60 * soluble_cod;
        let snd = 0.02 * cod;
        let xnd = 0.03 * particulate_cod;

        Self {
            si,
            ss,
            xi,
            xs,
            xbh,
            xba,
            xp,
            so: dissolved_oxygen,
            sno: no3_n,
            snh: nh4_n,
            snd,
            xnd,
            salk: alkalinity,
        }
    }

    /// Influent mapping: no biomass is seeded in the raw water; the reactor
    /// carries the initial biomass inventory.
    pub fn from_raw_water(
        cod: f64,
        nh4_n: f64,
        no3_n: f64,
        dissolved_oxygen: f64,
        alkalinity: f64,
    ) -> Self {
        Self {
            si: 0.10 * cod,
            ss: 0.90 * cod,
            xi: 0.0,
            xs: 0.0,
            xbh: 0.0,
            xba: 0.0,
            xp: 0.0,
            so: dissolved_oxygen,
            sno: no3_n,
            snh: nh4_n,
            snd: 0.02 * cod,
            xnd: 0.0,
            salk: alkalinity,
        }
    }
}

fn default_reference_temperature_c() -> f64 {
    20.0
}

/// ASM1 kinetic and stoichiometric parameters, per day at their reference
/// temperature. `Default` is the 20 degC set; `bsm1_15c()` is the public BSM1
/// 15 degC set.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm1Params {
    pub y_h: f64,
    pub f_p: f64,
    pub y_a: f64,
    pub i_xb: f64,
    pub i_xp: f64,
    pub mu_h_per_d: f64,
    pub k_s: f64,
    pub k_o_h: f64,
    pub k_no: f64,
    pub b_h_per_d: f64,
    pub eta_g: f64,
    pub eta_h: f64,
    pub mu_a_per_d: f64,
    pub k_nh: f64,
    pub k_o_a: f64,
    pub b_a_per_d: f64,
    pub k_a_per_d: f64,
    pub k_h_per_d: f64,
    pub k_x: f64,
    pub theta_h: f64,
    pub theta_a: f64,
    /// g COD reduced per g NO3-N denitrified.
    pub cod_per_no3_n: f64,
    /// g O2 consumed per g NH4-N nitrified.
    pub o2_per_nh_n: f64,
    /// mg CaCO3 alkalinity consumed per mg NH4-N nitrified.
    pub alk_per_nh_n: f64,
    /// Temperature at which the kinetic parameters are quoted. The engine
    /// applies `theta^(T - reference_temperature_c)`.
    #[serde(default = "default_reference_temperature_c")]
    pub reference_temperature_c: f64,
    /// Optional fixed saturation DO, mg/L. Zero uses the temperature
    /// correlation; BSM1 uses a fixed 8.0 mg/L at 15 degC.
    #[serde(default)]
    pub so_sat_mg_l: f64,
}

impl Default for Asm1Params {
    fn default() -> Self {
        Self {
            y_h: 0.67,
            f_p: 0.08,
            y_a: 0.24,
            i_xb: 0.086,
            i_xp: 0.06,
            mu_h_per_d: 6.0,
            k_s: 20.0,
            k_o_h: 2.0,
            k_no: 0.5,
            b_h_per_d: 0.62,
            eta_g: 0.8,
            eta_h: 0.8,
            mu_a_per_d: 1.0,
            k_nh: 1.0,
            k_o_a: 0.4,
            b_a_per_d: 0.15,
            k_a_per_d: 0.08,
            k_h_per_d: 0.15,
            k_x: 0.03,
            theta_h: 1.04,
            theta_a: 1.07,
            cod_per_no3_n: 2.86,
            o2_per_nh_n: 4.57,
            alk_per_nh_n: 7.14,
            reference_temperature_c: 20.0,
            so_sat_mg_l: 0.0,
        }
    }
}

impl Asm1Params {
    /// BSM1 open-loop parameter set quoted at 15 degC (Henze et al. / BSM1
    /// technical report, Tables 2-3). This is a public benchmark set, not a
    /// site calibration.
    pub fn bsm1_15c() -> Self {
        Self {
            y_h: 0.67,
            f_p: 0.08,
            y_a: 0.24,
            i_xb: 0.08,
            i_xp: 0.06,
            mu_h_per_d: 4.0,
            k_s: 10.0,
            k_o_h: 0.2,
            k_no: 0.5,
            b_h_per_d: 0.3,
            eta_g: 0.8,
            eta_h: 0.8,
            mu_a_per_d: 0.5,
            k_nh: 1.0,
            k_o_a: 0.4,
            b_a_per_d: 0.05,
            k_a_per_d: 0.05,
            k_h_per_d: 3.0,
            k_x: 0.1,
            theta_h: 1.04,
            theta_a: 1.07,
            cod_per_no3_n: 2.86,
            o2_per_nh_n: 4.57,
            alk_per_nh_n: 7.14,
            reference_temperature_c: 15.0,
            so_sat_mg_l: 8.0,
        }
    }

    /// BSM1 15 degC calibration candidate used for the `bsm1-calibrated`
    /// fixture. It keeps the published set and only lowers the anoxic
    /// hydrolysis correction from 0.8 to 0.6, which is the single parameter
    /// that brings the coupled settler/recycle steady state back to Table 6.
    /// This is a site-calibration candidate, not a published parameter set.
    pub fn bsm1_calibrated() -> Self {
        let mut params = Self::bsm1_15c();
        params.eta_h = 0.6;
        params
    }
}

/// Time derivatives for the 13 ASM1 components.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Asm1Rates {
    pub si: f64,
    pub ss: f64,
    pub xi: f64,
    pub xs: f64,
    pub xbh: f64,
    pub xba: f64,
    pub xp: f64,
    pub so: f64,
    pub sno: f64,
    pub snh: f64,
    pub snd: f64,
    pub xnd: f64,
    pub salk: f64,
}

impl Asm1Rates {
    pub fn values(&self) -> [f64; 13] {
        [
            self.si, self.ss, self.xi, self.xs, self.xbh, self.xba, self.xp, self.so, self.sno,
            self.snh, self.snd, self.xnd, self.salk,
        ]
    }

    /// Construct from the canonical 13-value order used by fixtures:
    /// `[S_I, S_S, X_I, X_S, X_BH, X_BA, X_P, S_O, S_NO, S_NH, S_ND, X_ND, S_ALK]`.
    pub fn from_values(values: [f64; 13]) -> Self {
        Self {
            si: values[0],
            ss: values[1],
            xi: values[2],
            xs: values[3],
            xbh: values[4],
            xba: values[5],
            xp: values[6],
            so: values[7],
            sno: values[8],
            snh: values[9],
            snd: values[10],
            xnd: values[11],
            salk: values[12],
        }
    }
}

/// Rate structure exposed for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ProcessRates {
    pub aerobic_growth_h: f64,
    pub anoxic_growth_h: f64,
    pub hetero_decay: f64,
    pub hydrolysis: f64,
    pub ammonification: f64,
    pub autotrophic_growth: f64,
    pub autotrophic_decay: f64,
}

pub fn process_rates(state: &Asm1State, params: &Asm1Params, temperature_c: f64) -> ProcessRates {
    let t = temperature_c.max(0.0);
    let theta_h = params.theta_h.powf(t - params.reference_temperature_c);
    let theta_a = params.theta_a.powf(t - params.reference_temperature_c);

    let mu_h = params.mu_h_per_d / 24.0 * theta_h;
    let mu_a = params.mu_a_per_d / 24.0 * theta_a;
    let b_h = params.b_h_per_d / 24.0 * theta_h;
    let b_a = params.b_a_per_d / 24.0 * theta_a;
    let k_h = params.k_h_per_d / 24.0 * theta_h;
    let k_a = params.k_a_per_d / 24.0 * theta_h;

    let ss = state.ss.max(0.0);
    let so = state.so.max(0.0);
    let sno = state.sno.max(0.0);
    let snh = state.snh.max(0.0);
    let xbh = state.xbh.max(0.0);
    let xba = state.xba.max(0.0);
    let xs = state.xs.max(0.0);
    let snd = state.snd.max(0.0);

    let aerobic_growth_h = mu_h * (ss / (params.k_s + ss)) * (so / (params.k_o_h + so)) * xbh;
    let anoxic_growth_h = mu_h
        * params.eta_g
        * (ss / (params.k_s + ss))
        * (params.k_o_h / (params.k_o_h + so))
        * (sno / (params.k_no + sno))
        * xbh;
    let hetero_decay = b_h * xbh;
    // Hydrolysis is carried out by heterotrophs and depends on the electron
    // acceptor: oxygen first, then nitrate with the anoxic correction `eta_h`.
    // Anaerobic zones therefore do not keep producing readily biodegradable
    // substrate, which is essential for a realistic anoxic S_S profile.
    let hydrolysis_factor = so / (params.k_o_h + so)
        + params.eta_h * params.k_o_h / (params.k_o_h + so) * sno / (params.k_no + sno);
    let hydrolysis = if xbh > 0.0 {
        k_h * (xs / (params.k_x * xbh + xs)) * xbh * hydrolysis_factor.max(0.0)
    } else {
        0.0
    };
    let ammonification = k_a * snd * xbh;
    let autotrophic_growth = mu_a * (snh / (params.k_nh + snh)) * (so / (params.k_o_a + so)) * xba;
    let autotrophic_decay = b_a * xba;

    ProcessRates {
        aerobic_growth_h,
        anoxic_growth_h,
        hetero_decay,
        hydrolysis,
        ammonification,
        autotrophic_growth,
        autotrophic_decay,
    }
}

pub fn reaction_rates(state: &Asm1State, params: &Asm1Params, temperature_c: f64) -> Asm1Rates {
    let p = process_rates(state, params, temperature_c);

    let aerobic = p.aerobic_growth_h;
    let anoxic = p.anoxic_growth_h;
    let decay_h = p.hetero_decay;
    let hydrolysis = p.hydrolysis;
    let ammonification = p.ammonification;
    let autotrophic = p.autotrophic_growth;
    let decay_a = p.autotrophic_decay;

    // ASM1 observed rates. Units are mg/L/h except alkalinity, which is
    // tracked as mg/L as CaCO3. The stoichiometric coefficients follow the
    // published ASM1 matrix: growth consumes one mole of alkalinity per mole
    // of biomass N assimilated, denitrification credits half of that, and
    // nitrification consumes two moles per mole of NH4-N.
    let oxygen_for_aerobic = (1.0 - params.y_h) / params.y_h * aerobic;
    let oxygen_for_nitrification = (params.o2_per_nh_n - params.y_a) / params.y_a * autotrophic;
    let nitrate_removed = (1.0 - params.y_h) / (params.cod_per_no3_n * params.y_h) * anoxic;
    // Nitrification consumes 1/Y_A g NH4-N per g biomass COD produced; the
    // biomass itself carries i_XB g N, so the nitrate released is the rest.
    let nitrate_produced = (1.0 - params.y_a * params.i_xb) / params.y_a * autotrophic;
    let ammonia_for_nitrification = autotrophic / params.y_a;
    let xs = state.xs.max(0.0);
    let xnd = state.xnd.max(0.0);
    let xnd_hydrolysis = if xs > 1e-12 {
        hydrolysis * (xnd / xs)
    } else {
        0.0
    };
    let alkalinity_for_growth = 0.5 * params.alk_per_nh_n * params.i_xb * (aerobic + anoxic);
    let alkalinity_for_denitrification = 0.5 * params.alk_per_nh_n * nitrate_removed;
    let alkalinity_for_nitrification = params.alk_per_nh_n * nitrate_produced;
    let alkalinity_for_ammonification = 0.5 * params.alk_per_nh_n * ammonification;

    Asm1Rates {
        si: 0.0,
        ss: -aerobic / params.y_h - anoxic / params.y_h + hydrolysis,
        xi: 0.0,
        xs: -hydrolysis + (1.0 - params.f_p) * (decay_h + decay_a),
        xbh: aerobic + anoxic - decay_h,
        xba: autotrophic - decay_a,
        xp: params.f_p * (decay_h + decay_a),
        so: -oxygen_for_aerobic - oxygen_for_nitrification,
        sno: -nitrate_removed + nitrate_produced,
        snh: -params.i_xb * (aerobic + anoxic) + ammonification - ammonia_for_nitrification,
        snd: -ammonification + xnd_hydrolysis,
        xnd: (params.i_xb - params.f_p * params.i_xp) * (decay_h + decay_a) - xnd_hydrolysis,
        salk: -alkalinity_for_growth + alkalinity_for_denitrification
            - alkalinity_for_nitrification
            + alkalinity_for_ammonification,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aerobic_state() -> Asm1State {
        Asm1State {
            ss: 100.0,
            xbh: 1000.0,
            xba: 200.0,
            so: 2.0,
            sno: 1.0,
            snh: 20.0,
            salk: 200.0,
            ..Asm1State::zeros()
        }
    }

    #[test]
    fn aerobic_growth_consumes_substrate_and_oxygen() {
        let rates = reaction_rates(&aerobic_state(), &Asm1Params::default(), 20.0);
        assert!(rates.ss < 0.0);
        assert!(rates.so < 0.0);
        assert!(rates.xbh > 0.0);
        assert!(rates.snh < 0.0);
    }

    #[test]
    fn anoxic_growth_denitrifies_without_oxygen() {
        let mut state = aerobic_state();
        state.so = 0.0;
        state.sno = 10.0;
        let rates = reaction_rates(&state, &Asm1Params::default(), 20.0);
        assert!(rates.sno < 0.0);
        assert!(rates.xbh > 0.0);
        assert!(rates.so <= 0.0);
    }

    #[test]
    fn autotrophic_growth_consumes_ammonia_and_oxygen() {
        let mut state = aerobic_state();
        state.xbh = 0.0;
        state.ss = 0.0;
        state.snh = 20.0;
        state.xba = 200.0;
        let rates = reaction_rates(&state, &Asm1Params::default(), 20.0);
        assert!(rates.snh < 0.0);
        assert!(rates.so < 0.0);
        assert!(rates.xba > 0.0);
    }

    #[test]
    fn autotrophic_growth_produces_nitrate() {
        let state = Asm1State {
            xba: 200.0,
            so: 2.0,
            snh: 20.0,
            salk: 350.0,
            ..Asm1State::zeros()
        };
        let rates = reaction_rates(&state, &Asm1Params::bsm1_15c(), 15.0);
        assert!(rates.sno > 0.0, "nitrification must produce nitrate");
        assert!(rates.snh < 0.0);
        assert!(rates.so < 0.0);
    }

    #[test]
    fn hydrolysis_releases_particulate_organic_nitrogen() {
        let state = Asm1State {
            xs: 100.0,
            xnd: 10.0,
            xbh: 1000.0,
            so: 2.0,
            ..Asm1State::zeros()
        };
        let rates = reaction_rates(&state, &Asm1Params::bsm1_15c(), 15.0);
        assert!(rates.xnd < 0.0, "X_ND must be hydrolysed");
        assert!(rates.snd > 0.0, "hydrolysis must release S_ND");
    }

    #[test]
    fn decay_splits_into_inert_products_and_slow_substrate() {
        let state = Asm1State {
            xbh: 1000.0,
            ..Asm1State::zeros()
        };
        let rates = reaction_rates(&state, &Asm1Params::bsm1_15c(), 15.0);
        assert!(rates.xp > 0.0, "decay must produce X_P");
        assert!(rates.xs > 0.0, "decay must produce X_S");
        assert!(rates.xp < rates.xs, "f_P is the smaller decay fraction");
    }

    #[test]
    fn zero_biomass_has_zero_growth() {
        let state = Asm1State {
            ss: 100.0,
            so: 2.0,
            snh: 20.0,
            ..Asm1State::zeros()
        };
        let rates = reaction_rates(&state, &Asm1Params::default(), 20.0);
        assert_eq!(rates.ss, 0.0);
        assert_eq!(rates.xbh, 0.0);
        assert_eq!(rates.xba, 0.0);
    }

    #[test]
    fn explicit_values_roundtrip() {
        let values = [
            30.0, 69.5, 51.2, 202.32, 28.17, 0.0, 0.0, 0.0, 0.0, 31.56, 6.95, 10.59, 350.0,
        ];
        let state = Asm1State::from_values(values);
        assert_eq!(state.values(), values);
        assert!(state.is_finite_non_negative());
    }

    #[test]
    fn aggregates_roundtrip_preserves_cod_and_nitrogen() {
        let state = Asm1State::from_aggregates(400.0, 30.0, 2.0, 1.5, 150.0, 2000.0, 20.0);
        assert!((state.total_cod() - 400.0).abs() < 1e-9);
        assert!((state.snh - 30.0).abs() < 1e-9);
        assert!((state.sno - 2.0).abs() < 1e-9);
        assert!((state.so - 1.5).abs() < 1e-9);
    }

    #[test]
    fn rates_are_finite_for_typical_state() {
        let rates = reaction_rates(&aerobic_state(), &Asm1Params::default(), 25.0);
        assert!(rates.values().iter().all(|value| value.is_finite()));
    }
}

//! ASM2d (Henze et al., 1999) activated sludge model with biological
//! phosphorus removal and denitrifying PAO.
//!
//! This is a clean-room implementation from the published Petersen matrix and
//! rate equations. State variables are in mg/L (g/m3); the 19th component
//! `X_TSS` is derived from the particulate fractions instead of being an
//! independent kinetic state, matching the convention used by the published
//! component set where TSS is redundant with COD fractions.

use serde::{Deserialize, Serialize};

/// The 18 independent ASM2d state variables. `X_TSS` is derived by
/// [`Asm2dState::suspended_solids`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm2dState {
    /// Dissolved oxygen, g O2/m3.
    pub so: f64,
    /// Dinitrogen, g N/m3.
    pub sn2: f64,
    /// Ammonium plus ammonia nitrogen, g N/m3.
    pub snh4: f64,
    /// Nitrate plus nitrite nitrogen, g N/m3.
    pub sno3: f64,
    /// Ortho-phosphate phosphorus, g P/m3.
    pub spo4: f64,
    /// Fermentable readily biodegradable substrate, g COD/m3.
    pub sf: f64,
    /// Fermentation products (acetate), g COD/m3.
    pub sa: f64,
    /// Soluble inert organic matter, g COD/m3.
    pub si: f64,
    /// Alkalinity, mg/L as CaCO3.
    pub salk: f64,
    /// Particulate inert organic matter, g COD/m3.
    pub xi: f64,
    /// Slowly biodegradable substrate, g COD/m3.
    pub xs: f64,
    /// Heterotrophic biomass, g COD/m3.
    pub xh: f64,
    /// Phosphate-accumulating organisms, g COD/m3.
    pub xpao: f64,
    /// Poly-phosphate, g P/m3.
    pub xpp: f64,
    /// PHA storage product, g COD/m3.
    pub xpha: f64,
    /// Autotrophic nitrifying biomass, g COD/m3.
    pub xaut: f64,
    /// Metal-hydroxides, g/m3.
    pub xmeoh: f64,
    /// Metal-phosphate, g P/m3 (expressed as the precipitated metal-phosphate).
    pub xmep: f64,
}

impl Asm2dState {
    pub fn zeros() -> Self {
        Self {
            so: 0.0,
            sn2: 0.0,
            snh4: 0.0,
            sno3: 0.0,
            spo4: 0.0,
            sf: 0.0,
            sa: 0.0,
            si: 0.0,
            salk: 0.0,
            xi: 0.0,
            xs: 0.0,
            xh: 0.0,
            xpao: 0.0,
            xpp: 0.0,
            xpha: 0.0,
            xaut: 0.0,
            xmeoh: 0.0,
            xmep: 0.0,
        }
    }

    /// Canonical order:
    /// `[S_O2, S_N2, S_NH4, S_NO3, S_PO4, S_F, S_A, S_I, S_ALK,
    ///  X_I, X_S, X_H, X_PAO, X_PP, X_PHA, X_AUT, X_MeOH, X_MeP]`.
    pub fn values(&self) -> [f64; 18] {
        [
            self.so, self.sn2, self.snh4, self.sno3, self.spo4, self.sf, self.sa, self.si,
            self.salk, self.xi, self.xs, self.xh, self.xpao, self.xpp, self.xpha, self.xaut,
            self.xmeoh, self.xmep,
        ]
    }

    pub fn from_values(values: [f64; 18]) -> Self {
        Self {
            so: values[0],
            sn2: values[1],
            snh4: values[2],
            sno3: values[3],
            spo4: values[4],
            sf: values[5],
            sa: values[6],
            si: values[7],
            salk: values[8],
            xi: values[9],
            xs: values[10],
            xh: values[11],
            xpao: values[12],
            xpp: values[13],
            xpha: values[14],
            xaut: values[15],
            xmeoh: values[16],
            xmep: values[17],
        }
    }

    pub fn is_finite_non_negative(&self) -> bool {
        self.values()
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
    }

    pub fn add_weighted(&mut self, other: &Self, weight: f64) {
        let mut next = *self;
        let incoming = *other;
        for (target, source) in next.values_mut().iter_mut().zip(incoming.values().iter()) {
            **target += source * weight;
        }
        *self = next;
    }

    pub fn clamp_non_negative(&mut self) -> bool {
        let mut changed = false;
        for value in self.values_mut() {
            if !value.is_finite() || *value < 0.0 {
                *value = 0.0;
                changed = true;
            }
        }
        changed
    }

    fn values_mut(&mut self) -> [&mut f64; 18] {
        [
            &mut self.so,
            &mut self.sn2,
            &mut self.snh4,
            &mut self.sno3,
            &mut self.spo4,
            &mut self.sf,
            &mut self.sa,
            &mut self.si,
            &mut self.salk,
            &mut self.xi,
            &mut self.xs,
            &mut self.xh,
            &mut self.xpao,
            &mut self.xpp,
            &mut self.xpha,
            &mut self.xaut,
            &mut self.xmeoh,
            &mut self.xmep,
        ]
    }

    /// COD carried by the organic fractions. `X_PP` is a phosphorus storage
    /// compound, not COD; `X_MeOH`/`X_MeP` are inorganic.
    pub fn total_cod(&self) -> f64 {
        self.si + self.sf + self.sa + self.xi + self.xs + self.xh + self.xpao + self.xpha
    }

    /// Total nitrogen bound in the state. Uses the default ASM2d N contents
    /// for the aggregate snapshot; reaction rates use the parameter-specific
    /// values.
    pub fn total_nitrogen(&self) -> f64 {
        self.sn2
            + self.snh4
            + self.sno3
            + 0.01 * self.si
            + 0.03 * self.sf
            + 0.02 * self.xi
            + 0.04 * self.xs
            + 0.07 * (self.xh + self.xpao + self.xaut)
    }

    /// Total phosphorus bound in the state. Uses the default ASM2d P contents.
    pub fn total_phosphorus(&self) -> f64 {
        self.spo4
            + 0.01 * self.sf
            + 0.01 * self.xi
            + 0.01 * self.xs
            + 0.02 * (self.xh + self.xpao + self.xaut)
            + self.xpp
            + self.xmep / 4.87
    }

    /// TSS conversion used by the settler. The coefficients follow the
    /// published TSS/COD ratios for the particulate fractions; the storage
    /// and metal fractions are carried as solids directly.
    pub fn suspended_solids(&self) -> f64 {
        0.75 * (self.xi + self.xs)
            + 0.90 * (self.xh + self.xpao + self.xaut)
            + self.xpp
            + self.xpha
            + self.xmeoh
            + self.xmep
    }

    pub fn with_particulate_tss(&self, target_tss: f64) -> Self {
        let current = self.suspended_solids();
        if current <= 1e-12 {
            return *self;
        }
        let factor = (target_tss.max(0.0) / current).clamp(0.0, 100.0);
        let mut next = *self;
        next.xi *= factor;
        next.xs *= factor;
        next.xh *= factor;
        next.xpao *= factor;
        next.xpp *= factor;
        next.xpha *= factor;
        next.xaut *= factor;
        next.xmeoh *= factor;
        next.xmep *= factor;
        next
    }
}

/// ASM2d stoichiometric and kinetic parameters at 20 degC.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm2dParams {
    pub f_si: f64,
    pub y_h: f64,
    pub f_xi_h: f64,
    pub y_pao: f64,
    pub y_po4: f64,
    pub y_pha: f64,
    pub f_xi_pao: f64,
    pub y_a: f64,
    pub f_xi_aut: f64,

    pub i_n_si: f64,
    pub i_n_sf: f64,
    pub i_n_xi: f64,
    pub i_n_xs: f64,
    pub i_n_bm: f64,
    pub i_p_si: f64,
    pub i_p_sf: f64,
    pub i_p_xi: f64,
    pub i_p_xs: f64,
    pub i_p_bm: f64,
    pub i_tss_xi: f64,
    pub i_tss_xs: f64,
    pub i_tss_bm: f64,

    pub k_h: f64,
    pub eta_no3: f64,
    pub eta_fe: f64,
    pub k_o2: f64,
    pub k_no3: f64,
    pub k_x: f64,
    pub mu_h: f64,
    pub q_fe: f64,
    pub eta_no3_h: f64,
    pub b_h: f64,
    pub k_o2_h: f64,
    pub k_f: f64,
    pub k_fe: f64,
    pub k_a_h: f64,
    pub k_no3_h: f64,
    pub k_nh4_h: f64,
    pub k_p_h: f64,
    pub k_alk_h: f64,

    pub q_pha: f64,
    pub q_pp: f64,
    pub mu_pao: f64,
    pub eta_no3_pao: f64,
    pub b_pao: f64,
    pub b_pp: f64,
    pub b_pha: f64,
    pub k_o2_pao: f64,
    pub k_no3_pao: f64,
    pub k_a_pao: f64,
    pub k_nh4_pao: f64,
    pub k_ps: f64,
    pub k_p_pao: f64,
    pub k_alk_pao: f64,
    pub k_pp: f64,
    pub k_max: f64,
    pub k_ipp: f64,
    pub k_pha: f64,

    pub mu_aut: f64,
    pub b_aut: f64,
    pub k_o2_aut: f64,
    pub k_nh4_aut: f64,
    pub k_alk_aut: f64,
    pub k_p_aut: f64,

    pub k_pre: f64,
    pub k_red: f64,
    pub k_alk_pre: f64,
    pub cod_den: f64,
}

impl Default for Asm2dParams {
    fn default() -> Self {
        Self {
            f_si: 0.0,
            y_h: 0.625,
            f_xi_h: 0.1,
            y_pao: 0.625,
            y_po4: 0.4,
            y_pha: 0.2,
            f_xi_pao: 0.1,
            y_a: 0.24,
            f_xi_aut: 0.1,

            i_n_si: 0.01,
            i_n_sf: 0.03,
            i_n_xi: 0.02,
            i_n_xs: 0.08,
            i_n_bm: 0.07,
            i_p_si: 0.0,
            i_p_sf: 0.01,
            i_p_xi: 0.01,
            i_p_xs: 0.01,
            i_p_bm: 0.02,
            i_tss_xi: 0.75,
            i_tss_xs: 0.75,
            i_tss_bm: 0.9,

            k_h: 3.0,
            eta_no3: 0.6,
            eta_fe: 0.4,
            k_o2: 0.2,
            k_no3: 0.5,
            k_x: 0.1,
            mu_h: 6.0,
            q_fe: 3.0,
            eta_no3_h: 0.8,
            b_h: 0.4,
            k_o2_h: 0.2,
            k_f: 4.0,
            k_fe: 4.0,
            k_a_h: 4.0,
            k_no3_h: 0.5,
            k_nh4_h: 0.05,
            k_p_h: 0.01,
            k_alk_h: 1.2,

            q_pha: 3.0,
            q_pp: 1.5,
            mu_pao: 1.0,
            eta_no3_pao: 0.6,
            b_pao: 0.2,
            b_pp: 0.2,
            b_pha: 0.2,
            k_o2_pao: 0.2,
            k_no3_pao: 0.5,
            k_a_pao: 4.0,
            k_nh4_pao: 0.05,
            k_ps: 0.2,
            k_p_pao: 0.01,
            k_alk_pao: 1.2,
            k_pp: 0.01,
            k_max: 0.34,
            k_ipp: 0.02,
            k_pha: 0.01,

            mu_aut: 1.0,
            b_aut: 0.15,
            k_o2_aut: 0.5,
            k_nh4_aut: 1.0,
            k_alk_aut: 6.0,
            k_p_aut: 0.01,

            k_pre: 1.0,
            k_red: 0.6,
            k_alk_pre: 6.0,
            cod_den: 2.86,
        }
    }
}

/// ASM2d process rates. All rates are g/m3/h; parameters are quoted per day
/// and converted inside [`process_rates`].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Asm2dProcessRates {
    pub aero_hydrolysis: f64,
    pub anox_hydrolysis: f64,
    pub anae_hydrolysis: f64,
    pub hetero_growth_sf: f64,
    pub hetero_growth_sa: f64,
    pub denitri_sf: f64,
    pub denitri_sa: f64,
    pub fermentation: f64,
    pub hetero_lysis: f64,
    pub pao_storage_pha: f64,
    pub aero_storage_pp: f64,
    pub anox_storage_pp: f64,
    pub pao_aero_growth: f64,
    pub pao_anox_growth: f64,
    pub pao_lysis: f64,
    pub pp_lysis: f64,
    pub pha_lysis: f64,
    pub auto_aero_growth: f64,
    pub auto_lysis: f64,
    pub precipitation: f64,
    pub redissolution: f64,
}

fn monod(value: f64, half: f64) -> f64 {
    if value <= 0.0 {
        0.0
    } else {
        value / (half + value)
    }
}

fn inhibition(value: f64, half: f64) -> f64 {
    if half <= 0.0 {
        0.0
    } else {
        half / (half + value.max(0.0))
    }
}

pub fn process_rates(
    state: &Asm2dState,
    params: &Asm2dParams,
    temperature_c: f64,
) -> Asm2dProcessRates {
    // The published ASM2d set is quoted at 20 degC. Keep an explicit
    // temperature hook; the first implementation uses the 20 degC values.
    let _ = temperature_c;
    let so2 = state.so.max(0.0);
    let sno3 = state.sno3.max(0.0);
    let snh4 = state.snh4.max(0.0);
    let spo4 = state.spo4.max(0.0);
    let sf = state.sf.max(0.0);
    let sa = state.sa.max(0.0);
    let salk = state.salk.max(0.0);
    let xs = state.xs.max(0.0);
    let xh = state.xh.max(0.0);
    let xpao = state.xpao.max(0.0);
    let xpp = state.xpp.max(0.0);
    let xpha = state.xpha.max(0.0);
    let xaut = state.xaut.max(0.0);

    let k_h = params.k_h / 24.0;
    let mu_h = params.mu_h / 24.0;
    let q_fe = params.q_fe / 24.0;
    let b_h = params.b_h / 24.0;
    let q_pha = params.q_pha / 24.0;
    let q_pp = params.q_pp / 24.0;
    let mu_pao = params.mu_pao / 24.0;
    let b_pao = params.b_pao / 24.0;
    let b_pp = params.b_pp / 24.0;
    let b_pha = params.b_pha / 24.0;
    let mu_aut = params.mu_aut / 24.0;
    let b_aut = params.b_aut / 24.0;
    let k_pre = params.k_pre / 24.0;
    let k_red = params.k_red / 24.0;

    let xs_over_xh = if xh > 0.0 { xs / xh } else { 0.0 };
    let hydrolysis_factor = xs_over_xh / (params.k_x + xs_over_xh);

    let aero_hydrolysis = k_h * monod(so2, params.k_o2) * hydrolysis_factor * xh;
    let anox_hydrolysis = k_h
        * params.eta_no3
        * inhibition(so2, params.k_o2)
        * monod(sno3, params.k_no3)
        * hydrolysis_factor
        * xh;
    let anae_hydrolysis = k_h
        * params.eta_fe
        * inhibition(so2, params.k_o2)
        * inhibition(sno3, params.k_no3)
        * hydrolysis_factor
        * xh;

    let nutrient_factor_h =
        monod(snh4, params.k_nh4_h) * monod(spo4, params.k_p_h) * monod(salk, params.k_alk_h);
    let substrate_sf = monod(sf, params.k_f) * monod(sf, sf + sa);
    let substrate_sa = monod(sa, params.k_a_h) * monod(sa, sf + sa);
    let aerobic_h = monod(so2, params.k_o2_h);
    let anoxic_h = inhibition(so2, params.k_o2_h) * monod(sno3, params.k_no3_h);

    let hetero_growth_sf = mu_h * aerobic_h * substrate_sf * nutrient_factor_h * xh;
    let hetero_growth_sa = mu_h * aerobic_h * substrate_sa * nutrient_factor_h * xh;
    let denitri_sf = mu_h * params.eta_no3_h * anoxic_h * substrate_sf * nutrient_factor_h * xh;
    let denitri_sa = mu_h * params.eta_no3_h * anoxic_h * substrate_sa * nutrient_factor_h * xh;
    let fermentation = q_fe
        * inhibition(so2, params.k_o2)
        * inhibition(sno3, params.k_no3)
        * monod(sf, params.k_fe)
        * monod(salk, params.k_alk_h)
        * xh;

    let hetero_lysis = b_h * xh;

    let pha_ratio = if xpao > 0.0 { xpha / xpao } else { 0.0 };
    let pp_ratio = if xpao > 0.0 { xpp / xpao } else { 0.0 };
    let pao_storage_pha = (q_pha
        * monod(sa, params.k_a_pao)
        * monod(salk, params.k_alk_pao)
        * monod(pp_ratio, params.k_pp)
        * xpao)
        .min(xpp / params.y_po4.max(1e-9));

    let pp_headroom = (params.k_max - pp_ratio).max(0.0);
    let pp_storage_common = monod(spo4, params.k_ps)
        * monod(salk, params.k_alk_pao)
        * monod(pha_ratio, params.k_pha)
        * (pp_headroom / (params.k_ipp + pp_headroom))
        * xpao;
    let aero_storage_pp = q_pp * monod(so2, params.k_o2_pao) * pp_storage_common;
    let anox_storage_pp = q_pp
        * params.eta_no3_pao
        * inhibition(so2, params.k_o2_pao)
        * monod(sno3, params.k_no3_pao)
        * pp_storage_common;

    let pao_growth_common = monod(snh4, params.k_nh4_pao)
        * monod(spo4, params.k_p_pao)
        * monod(salk, params.k_alk_pao)
        * monod(pha_ratio, params.k_pha)
        * xpao;
    let pao_aero_growth = mu_pao * monod(so2, params.k_o2_pao) * pao_growth_common;
    let pao_anox_growth = mu_pao
        * params.eta_no3_pao
        * inhibition(so2, params.k_o2_pao)
        * monod(sno3, params.k_no3_pao)
        * pao_growth_common;

    let pao_lysis = (b_pao * xpao * monod(salk, params.k_alk_pao)).min(xpao);
    let pp_lysis = (b_pp * xpp * monod(salk, params.k_alk_pao)).min(xpp);
    let pha_lysis = (b_pha * xpha * monod(salk, params.k_alk_pao)).min(xpha);

    let auto_aero_growth = mu_aut
        * monod(so2, params.k_o2_aut)
        * monod(snh4, params.k_nh4_aut)
        * monod(spo4, params.k_p_aut)
        * monod(salk, params.k_alk_aut)
        * xaut;
    let auto_lysis = b_aut * xaut;

    let precipitation = (k_pre * monod(spo4, 1.0) * state.xmeoh.max(0.0)).min(spo4);
    let redissolution = (k_red * state.xmep.max(0.0) * monod(salk, params.k_alk_pre))
        .min(state.xmep.max(0.0) / 4.87);

    Asm2dProcessRates {
        aero_hydrolysis,
        anox_hydrolysis,
        anae_hydrolysis,
        hetero_growth_sf,
        hetero_growth_sa,
        denitri_sf,
        denitri_sa,
        fermentation,
        hetero_lysis,
        pao_storage_pha,
        aero_storage_pp,
        anox_storage_pp,
        pao_aero_growth,
        pao_anox_growth,
        pao_lysis,
        pp_lysis,
        pha_lysis,
        auto_aero_growth,
        auto_lysis,
        precipitation,
        redissolution,
    }
}

/// Time derivatives for the 18 independent ASM2d components.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Asm2dRates {
    pub so: f64,
    pub sn2: f64,
    pub snh4: f64,
    pub sno3: f64,
    pub spo4: f64,
    pub sf: f64,
    pub sa: f64,
    pub si: f64,
    pub salk: f64,
    pub xi: f64,
    pub xs: f64,
    pub xh: f64,
    pub xpao: f64,
    pub xpp: f64,
    pub xpha: f64,
    pub xaut: f64,
    pub xmeoh: f64,
    pub xmep: f64,
}

pub fn reaction_rates(state: &Asm2dState, params: &Asm2dParams, temperature_c: f64) -> Asm2dRates {
    let p = process_rates(state, params, temperature_c);
    let h = p.aero_hydrolysis + p.anox_hydrolysis + p.anae_hydrolysis;
    let hetero_growth = p.hetero_growth_sf + p.hetero_growth_sa;
    let denitri = p.denitri_sf + p.denitri_sa;
    let lysis_h = p.hetero_lysis;
    let lysis_pao = p.pao_lysis;
    let lysis_aut = p.auto_lysis;

    Asm2dRates {
        so: -0.6 * (hetero_growth + p.pao_aero_growth)
            - 0.2 * p.aero_storage_pp
            - 18.0 * p.auto_aero_growth,
        sn2: 0.21 * (denitri + p.pao_anox_growth) + 0.07 * p.anox_storage_pp,
        snh4: 0.01 * h
            - 0.022 * (p.hetero_growth_sf + p.denitri_sf)
            - 0.07 * (p.hetero_growth_sa + p.denitri_sa + p.pao_aero_growth + p.pao_anox_growth)
            + 0.03 * p.fermentation
            + 0.032 * (lysis_h + lysis_pao + lysis_aut)
            - 4.24 * p.auto_aero_growth,
        sno3: -0.21 * (denitri + p.pao_anox_growth) - 0.07 * p.anox_storage_pp
            + 4.17 * p.auto_aero_growth,
        spo4: -0.004 * (p.hetero_growth_sf + p.denitri_sf)
            - 0.02 * (p.hetero_growth_sa + p.denitri_sa + p.pao_aero_growth + p.pao_anox_growth)
            + 0.01 * p.fermentation
            + 0.4 * p.pao_storage_pha
            - p.aero_storage_pp
            - p.anox_storage_pp
            + 0.01 * (lysis_h + lysis_pao + lysis_aut)
            + p.pp_lysis
            - p.precipitation
            + p.redissolution
            - 0.02 * p.auto_aero_growth,
        sf: h - 1.6 * (p.hetero_growth_sf + p.denitri_sf) - p.fermentation,
        sa: p.fermentation - 1.6 * (p.hetero_growth_sa + p.denitri_sa) - p.pao_storage_pha
            + p.pha_lysis,
        si: 0.0,
        salk: 0.00857 * h - 0.0165 * p.hetero_growth_sf
            + 0.252 * p.hetero_growth_sa
            + 0.164 * p.denitri_sf
            + 0.432 * p.denitri_sa
            - 0.168 * p.fermentation
            + 0.0216 * (lysis_h + lysis_pao + lysis_aut)
            + 0.11 * p.pao_storage_pha
            + 0.194 * p.aero_storage_pp
            + 0.254 * p.anox_storage_pp
            - 0.0484 * p.pao_aero_growth
            + 0.132 * p.pao_anox_growth
            - 0.194 * p.pp_lysis
            - 0.188 * p.pha_lysis
            - 7.19 * p.auto_aero_growth
            + 0.582 * p.precipitation
            - 0.582 * p.redissolution,
        xi: 0.1 * (lysis_h + lysis_pao + lysis_aut),
        xs: 0.9 * (lysis_h + lysis_pao + lysis_aut) - h,
        xh: p.hetero_growth_sf + p.hetero_growth_sa + p.denitri_sf + p.denitri_sa - lysis_h,
        xpao: p.pao_aero_growth + p.pao_anox_growth - lysis_pao,
        xpp: -0.4 * p.pao_storage_pha + p.aero_storage_pp + p.anox_storage_pp - p.pp_lysis,
        xpha: p.pao_storage_pha
            - 0.2 * p.aero_storage_pp
            - 0.2 * p.anox_storage_pp
            - 1.6 * (p.pao_aero_growth + p.pao_anox_growth)
            - p.pha_lysis,
        xaut: p.auto_aero_growth - lysis_aut,
        xmeoh: -3.45 * p.precipitation + 3.45 * p.redissolution,
        xmep: 4.87 * p.precipitation - 4.87 * p.redissolution,
    }
}

impl Asm2dRates {
    pub fn values(&self) -> [f64; 18] {
        [
            self.so, self.sn2, self.snh4, self.sno3, self.spo4, self.sf, self.sa, self.si,
            self.salk, self.xi, self.xs, self.xh, self.xpao, self.xpp, self.xpha, self.xaut,
            self.xmeoh, self.xmep,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typical() -> Asm2dState {
        Asm2dState {
            so: 2.0,
            sn2: 1.0,
            snh4: 20.0,
            sno3: 1.0,
            spo4: 2.0,
            sf: 20.0,
            sa: 20.0,
            si: 10.0,
            salk: 200.0,
            xi: 1000.0,
            xs: 100.0,
            xh: 1000.0,
            xpao: 200.0,
            xpp: 50.0,
            xpha: 20.0,
            xaut: 100.0,
            xmeoh: 10.0,
            xmep: 5.0,
        }
    }

    #[test]
    fn explicit_values_roundtrip() {
        let state = typical();
        assert_eq!(Asm2dState::from_values(state.values()), state);
        assert!(state.is_finite_non_negative());
    }

    #[test]
    fn aerobic_growth_consumes_substrate_and_oxygen() {
        let rates = reaction_rates(&typical(), &Asm2dParams::default(), 20.0);
        assert!(rates.sf < 0.0, "S_F should be consumed");
        assert!(rates.so < 0.0, "oxygen should be consumed");
        assert!(rates.xh > 0.0, "heterotrophs should grow");
    }

    #[test]
    fn anoxic_growth_denitrifies_without_oxygen() {
        let mut state = typical();
        state.so = 0.0;
        state.sno3 = 10.0;
        let rates = reaction_rates(&state, &Asm2dParams::default(), 20.0);
        assert!(rates.sno3 < 0.0, "nitrate should be reduced");
        assert!(rates.sn2 > 0.0, "N2 should be produced");
        assert!(rates.xh > 0.0);
    }

    #[test]
    fn pao_storage_releases_phosphate_and_consumes_acetate() {
        let mut state = typical();
        state.so = 0.0;
        state.sno3 = 0.0;
        state.sf = 0.0;
        let rates = reaction_rates(&state, &Asm2dParams::default(), 20.0);
        let processes = process_rates(&state, &Asm2dParams::default(), 20.0);
        assert!(processes.pao_storage_pha > 0.0, "PHA storage should run");
        assert!(rates.spo4 > 0.0, "phosphate should be released");
        assert!(rates.sa < 0.0, "acetate should be consumed");
        assert!(rates.xpp < 0.0 || rates.xpha > 0.0);
    }

    #[test]
    fn autotrophic_growth_produces_nitrate() {
        let mut state = typical();
        state.sf = 0.0;
        state.sa = 0.0;
        state.xh = 0.0;
        state.xpao = 0.0;
        state.xpp = 0.0;
        state.xpha = 0.0;
        state.xaut = 100.0;
        state.snh4 = 20.0;
        state.so = 2.0;
        let rates = reaction_rates(&state, &Asm2dParams::default(), 20.0);
        assert!(rates.sno3 > 0.0, "nitrification must produce nitrate");
        assert!(rates.snh4 < 0.0);
        assert!(rates.so < 0.0);
        assert!(rates.xaut > 0.0);
    }

    #[test]
    fn precipitation_consumes_phosphate_and_metal_hydroxide() {
        let mut state = typical();
        state.so = 0.0;
        state.sno3 = 0.0;
        state.sf = 0.0;
        state.sa = 0.0;
        state.xh = 0.0;
        state.xpao = 0.0;
        state.xpp = 0.0;
        state.xpha = 0.0;
        state.xaut = 0.0;
        state.spo4 = 5.0;
        state.xmeoh = 10.0;
        let rates = reaction_rates(&state, &Asm2dParams::default(), 20.0);
        assert!(rates.spo4 < 0.0, "phosphate should precipitate");
        assert!(rates.xmeoh < 0.0, "metal hydroxide should be consumed");
        assert!(rates.xmep > 0.0, "metal phosphate should form");
    }

    #[test]
    fn rates_are_finite_for_typical_state() {
        let rates = reaction_rates(&typical(), &Asm2dParams::default(), 20.0);
        assert!(rates.values().iter().all(|value| value.is_finite()));
    }
}

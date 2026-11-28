//! Anaerobic Digestion Model No. 1 (ADM1).
//!
//! Clean-room implementation from the published IWA model structure and the
//! public QSDsan default parameter set. Concentrations are kg/m3. Organic
//! components are measured as COD, `S_IC` as kg C/m3 and `S_IN` as kg N/m3.
//! The stoichiometric matrix is the default IWA/QSDsan matrix; its rows close
//! exactly on COD and nitrogen, which is asserted by unit tests.

use serde::{Deserialize, Serialize};

pub const ADM1_COMPONENTS: usize = 24;
pub const ADM1_PROCESSES: usize = 22;

/// Kinetic component indices. Two additional strong-ion states (`S_cat`,
/// `S_an`) are kept in `Adm1State` for the charge balance but do not react.
pub const S_SU: usize = 0;
pub const S_AA: usize = 1;
pub const S_FA: usize = 2;
pub const S_VA: usize = 3;
pub const S_BU: usize = 4;
pub const S_PRO: usize = 5;
pub const S_AC: usize = 6;
pub const S_H2: usize = 7;
pub const S_CH4: usize = 8;
pub const S_IC: usize = 9;
pub const S_IN: usize = 10;
pub const S_I: usize = 11;
pub const X_C: usize = 12;
pub const X_CH: usize = 13;
pub const X_PR: usize = 14;
pub const X_LI: usize = 15;
pub const X_SU: usize = 16;
pub const X_AA: usize = 17;
pub const X_FA: usize = 18;
pub const X_C4: usize = 19;
pub const X_PRO: usize = 20;
pub const X_AC: usize = 21;
pub const X_H2: usize = 22;
pub const X_I: usize = 23;
pub const S_CAT: usize = 24;
pub const S_AN: usize = 25;
pub const ADM1_STATE_COMPONENTS: usize = 26;

/// Default ADM1 stoichiometry (22 processes x 24 kinetic components).
/// Columns follow the `S_*`/`X_*` order above. Values are from the IWA ADM1
/// default parameter set as published by QSDsan (`_adm1.tsv`).
pub const ADM1_STOICH: [[f64; ADM1_COMPONENTS]; ADM1_PROCESSES] = [
    [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        3.8843767e-05,
        -5.69544412e-18,
        0.1,
        -1.0,
        0.2,
        0.2,
        0.3,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.2,
    ],
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.05,
        0.0,
        0.95,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.00278556946,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        -1.0,
        0.0,
        0.0,
        0.0,
        0.117,
        0.243,
        0.369,
        0.171,
        0.0,
        0.0859725372,
        -0.008,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.1,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        -1.0,
        0.0,
        0.2116,
        0.2392,
        0.046,
        0.368,
        0.0552,
        0.0,
        0.0441024589,
        0.0916,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.08,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        -1.0,
        0.0,
        0.0,
        0.0,
        0.658,
        0.282,
        0.0,
        -0.00840331486,
        -0.0048,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.06,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        0.0,
        -1.0,
        0.0,
        0.5076,
        0.2914,
        0.141,
        0.0,
        -0.00649170986,
        -0.0048,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.06,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0,
        0.0,
        0.752,
        0.188,
        0.0,
        -0.00451927437,
        -0.0048,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.06,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0,
        0.5472,
        0.4128,
        0.0,
        0.101312571,
        -0.0032,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.04,
        0.0,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0,
        0.0,
        0.95,
        0.178277937,
        -0.004,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.05,
        0.0,
        0.0,
    ],
    [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0,
        0.94,
        -0.198949772,
        -0.0048,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.06,
        0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0,
        -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04128, 0.0424, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
];

const COD_INDEX_EXCLUDED: [usize; 4] = [S_IC, S_IN, S_CAT, S_AN];

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Adm1State {
    pub values: [f64; ADM1_STATE_COMPONENTS],
}

impl Default for Adm1State {
    fn default() -> Self {
        Self {
            values: [0.0; ADM1_STATE_COMPONENTS],
        }
    }
}

impl Adm1State {
    pub fn new(values: [f64; ADM1_STATE_COMPONENTS]) -> Self {
        Self { values }
    }

    pub fn get(&self, index: usize) -> f64 {
        self.values[index]
    }

    pub fn set(&mut self, index: usize, value: f64) {
        self.values[index] = value.max(0.0);
    }

    /// Total organic COD, kg COD/m3. Strong ions and inorganic carbon /
    /// nitrogen are excluded.
    pub fn cod(&self) -> f64 {
        self.values
            .iter()
            .enumerate()
            .filter(|(i, _)| !COD_INDEX_EXCLUDED.contains(i))
            .map(|(_, v)| v)
            .sum()
    }

    /// Total nitrogen, kg N/m3.
    pub fn nitrogen(&self) -> f64 {
        let n_aa = 0.098;
        let n_i = 0.06;
        let n_xc = 0.0376;
        let n_pr = 0.098;
        let n_bio = 0.08;
        self.values[S_IN]
            + n_aa * self.values[S_AA]
            + n_i * self.values[S_I]
            + n_xc * self.values[X_C]
            + n_pr * self.values[X_PR]
            + n_i * self.values[X_I]
            + n_bio
                * (self.values[X_SU]
                    + self.values[X_AA]
                    + self.values[X_FA]
                    + self.values[X_C4]
                    + self.values[X_PRO]
                    + self.values[X_AC]
                    + self.values[X_H2])
    }

    /// Carbon mass, kg C/m3, including inorganic carbon.
    pub fn carbon(&self) -> f64 {
        let c_su = 0.375;
        let c_aa = 0.36;
        let c_fa = 0.77;
        let c_va = 0.64;
        let c_bu = 0.55;
        let c_pro = 0.49;
        let c_ac = 0.375;
        let c_ch4 = 0.75;
        let c_i = 0.36;
        let c_xc = 0.44;
        let c_ch = 0.44;
        let c_pr = 0.36;
        let c_li = 0.77;
        let c_bio = 0.375;
        self.values[S_IC]
            + c_su * self.values[S_SU]
            + c_aa * self.values[S_AA]
            + c_fa * self.values[S_FA]
            + c_va * self.values[S_VA]
            + c_bu * self.values[S_BU]
            + c_pro * self.values[S_PRO]
            + c_ac * self.values[S_AC]
            + c_ch4 * self.values[S_CH4]
            + c_i * self.values[S_I]
            + c_xc * self.values[X_C]
            + c_ch * self.values[X_CH]
            + c_pr * self.values[X_PR]
            + c_li * self.values[X_LI]
            + c_bio
                * (self.values[X_SU]
                    + self.values[X_AA]
                    + self.values[X_FA]
                    + self.values[X_C4]
                    + self.values[X_PRO]
                    + self.values[X_AC]
                    + self.values[X_H2]
                    + self.values[X_I])
    }

    /// Total suspended solids, kg/m3, using the ADM1 COD-to-TSS factors.
    pub fn suspended_solids(&self) -> f64 {
        let x_c = 0.7766;
        let x_ch = 0.868;
        let x_pr = 0.5556;
        let x_li = 0.348;
        let x_bio = 0.7766;
        let x_i = 0.5556;
        x_c * self.values[X_C]
            + x_ch * self.values[X_CH]
            + x_pr * self.values[X_PR]
            + x_li * self.values[X_LI]
            + x_bio
                * (self.values[X_SU]
                    + self.values[X_AA]
                    + self.values[X_FA]
                    + self.values[X_C4]
                    + self.values[X_PRO]
                    + self.values[X_AC]
                    + self.values[X_H2])
            + x_i * self.values[X_I]
    }

    /// pH from the ADM1 charge balance. Strong-ion states are interpreted as
    /// monovalent mass concentrations with apparent molar masses 23/35 kg/kmol.
    pub fn ph(&self, params: &Adm1Params, temperature_k: f64) -> f64 {
        let ka = params.ka(temperature_k);
        let h = solve_h_ion(self, &ka);
        -h.log10()
    }
}

fn solve_h_ion(state: &Adm1State, ka: &[f64; 7]) -> f64 {
    let kw = ka[0];
    let ka_nh = ka[1];
    let ka_co2 = ka[2];
    let ka_ac = ka[3];
    let ka_pro = ka[4];
    let ka_bu = ka[5];
    let ka_va = ka[6];

    let s_in = state.values[S_IN] / 14.0;
    let s_ic = state.values[S_IC] / 12.0;
    let ac = state.values[S_AC] / 64.0;
    let pro = state.values[S_PRO] / 112.0;
    let bu = state.values[S_BU] / 160.0;
    let va = state.values[S_VA] / 208.0;
    let cat = state.values[S_CAT];
    let an = state.values[S_AN];

    let charge = |h: f64| -> f64 {
        let nh3 = s_in * ka_nh / (ka_nh + h);
        let hco3 = s_ic * ka_co2 / (ka_co2 + h);
        let ac_ion = ac * ka_ac / (ka_ac + h);
        let pro_ion = pro * ka_pro / (ka_pro + h);
        let bu_ion = bu * ka_bu / (ka_bu + h);
        let va_ion = va * ka_va / (ka_va + h);
        cat + h + (s_in - nh3) - an - kw / h - hco3 - ac_ion - pro_ion - bu_ion - va_ion
    };

    let mut low = 1.0e-14_f64;
    let mut high = 1.0_f64;
    for _ in 0..80 {
        let mid = (low * high).sqrt();
        if charge(mid) > 0.0 {
            high = mid;
        } else {
            low = mid;
        }
    }
    (low * high).sqrt()
}

/// Kinetic and physico-chemical parameters. Defaults are the IWA ADM1 values.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Adm1Params {
    pub k_dis: f64,
    pub k_hyd_ch: f64,
    pub k_hyd_pr: f64,
    pub k_hyd_li: f64,
    pub k_m_su: f64,
    pub k_m_aa: f64,
    pub k_m_fa: f64,
    pub k_m_c4: f64,
    pub k_m_pro: f64,
    pub k_m_ac: f64,
    pub k_m_h2: f64,
    pub k_dec: f64,
    pub k_s_su: f64,
    pub k_s_aa: f64,
    pub k_s_fa: f64,
    pub k_s_c4: f64,
    pub k_s_pro: f64,
    pub k_s_ac: f64,
    pub k_s_h2: f64,
    pub ki_h2_fa: f64,
    pub ki_h2_c4: f64,
    pub ki_h2_pro: f64,
    pub ki_nh3: f64,
    pub ks_in: f64,
    pub ph_ul_aa: f64,
    pub ph_ll_aa: f64,
    pub ph_ul_ac: f64,
    pub ph_ll_ac: f64,
    pub ph_ul_h2: f64,
    pub ph_ll_h2: f64,
    pub kla: f64,
    pub kh_h2: f64,
    pub kh_ch4: f64,
    pub kh_co2: f64,
    pub t_base: f64,
    pub pka_base: [f64; 7],
    pub d_h_base: [f64; 7],
}

impl Default for Adm1Params {
    fn default() -> Self {
        Self {
            k_dis: 0.5,
            k_hyd_ch: 10.0,
            k_hyd_pr: 10.0,
            k_hyd_li: 10.0,
            k_m_su: 30.0,
            k_m_aa: 50.0,
            k_m_fa: 6.0,
            k_m_c4: 20.0,
            k_m_pro: 13.0,
            k_m_ac: 8.0,
            k_m_h2: 35.0,
            k_dec: 0.02,
            k_s_su: 0.5,
            k_s_aa: 0.3,
            k_s_fa: 0.4,
            k_s_c4: 0.2,
            k_s_pro: 0.1,
            k_s_ac: 0.15,
            k_s_h2: 7.0e-6,
            ki_h2_fa: 5.0e-6,
            ki_h2_c4: 1.0e-5,
            ki_h2_pro: 3.5e-6,
            ki_nh3: 1.8e-3,
            ks_in: 0.0014,
            ph_ul_aa: 5.5,
            ph_ll_aa: 4.0,
            ph_ul_ac: 7.0,
            ph_ll_ac: 6.0,
            ph_ul_h2: 6.0,
            ph_ll_h2: 5.0,
            kla: 200.0,
            kh_h2: 0.001,
            kh_ch4: 0.001,
            kh_co2: 0.035,
            t_base: 298.15,
            pka_base: [14.0, 9.25, 6.35, 4.76, 4.88, 4.82, 4.86],
            d_h_base: [55900.0, 51965.0, 7646.0, 0.0, 0.0, 0.0, 0.0],
        }
    }
}

impl Adm1Params {
    fn ka(&self, temperature_k: f64) -> [f64; 7] {
        let mut ka = [0.0; 7];
        for i in 0..7 {
            let k_base = 10.0_f64.powf(-self.pka_base[i]);
            let exponent = -self.d_h_base[i] / 8.314 * (1.0 / temperature_k - 1.0 / self.t_base);
            ka[i] = k_base * exponent.exp();
        }
        ka
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Adm1Gas {
    /// kmol per m3 liquid reactor volume.
    pub h2: f64,
    pub ch4: f64,
    pub ic: f64,
}

impl Default for Adm1Gas {
    fn default() -> Self {
        Self {
            h2: 0.0,
            ch4: 0.0,
            ic: 0.0,
        }
    }
}

impl Adm1Gas {
    pub fn total(&self) -> f64 {
        self.h2 + self.ch4 + self.ic
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Adm1Rates {
    pub processes: [f64; ADM1_PROCESSES],
    pub ph: f64,
}

impl Default for Adm1Rates {
    fn default() -> Self {
        Self {
            processes: [0.0; ADM1_PROCESSES],
            ph: 7.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Adm1MassBalance {
    pub input_kg: f64,
    pub output_kg: f64,
    pub gas_kg: f64,
    pub inventory_kg: f64,
    pub residual: f64,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Adm1Snapshot {
    pub days: f64,
    pub steps: usize,
    pub effluent: Adm1State,
    pub gas: Adm1Gas,
    pub ph: f64,
    pub biogas_m3_per_d: f64,
    pub methane_m3_per_d: f64,
    pub methane_fraction: f64,
    pub co2_fraction: f64,
    pub h2_fraction: f64,
    pub cod_balance: Adm1MassBalance,
    pub nitrogen_balance: Adm1MassBalance,
    pub gas_ch4_kmol: f64,
    pub gas_h2_kmol: f64,
    pub gas_ic_kmol: f64,
    pub rates: Adm1Rates,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Adm1Config {
    pub volume_m3: f64,
    pub flow_m3_per_d: f64,
    pub temperature_k: f64,
    pub gas_volume_ratio: f64,
    pub feed: Adm1State,
    pub initial: Adm1State,
    pub initial_gas: Adm1Gas,
    pub params: Adm1Params,
}

#[derive(Debug, thiserror::Error)]
pub enum Adm1Error {
    #[error("volume and flow must be positive")]
    InvalidConfig,
}

pub fn simulate_adm1(
    config: &Adm1Config,
    days: f64,
    dt_days: f64,
) -> Result<Adm1Snapshot, Adm1Error> {
    if config.volume_m3 <= 0.0
        || config.flow_m3_per_d <= 0.0
        || !days.is_finite()
        || days <= 0.0
        || !dt_days.is_finite()
        || dt_days <= 0.0
    {
        return Err(Adm1Error::InvalidConfig);
    }
    let mut state = config.initial;
    let mut gas = config.initial_gas;
    let mut time = 0.0;
    let mut steps = 0usize;
    let initial_cod = state.cod();
    let initial_n = state.nitrogen();
    let mut gas_ch4_kmol = 0.0;
    let mut gas_h2_kmol = 0.0;
    let mut gas_ic_kmol = 0.0;
    let mut last_rates = Adm1Rates::default();
    let mut cod_out_kg = 0.0;
    let mut n_out_kg = 0.0;

    while time < days - 1e-12 {
        let remaining = days - time;
        let mut step = dt_days.min(remaining);
        loop {
            let rates = reaction_rates(&state, &gas, config);
            let derivatives = derivatives(&state, &config.feed, &rates, config);
            let new_state = integrate_state(&state, &derivatives, step);
            if new_state
                .values
                .iter()
                .any(|v| !v.is_finite() || *v < -1e-9)
                && step > 1e-6
            {
                step *= 0.5;
                continue;
            }
            let new_gas = integrate_gas(&gas, &rates, &state, config, step);
            if (!new_gas.h2.is_finite() || !new_gas.ch4.is_finite() || !new_gas.ic.is_finite())
                && step > 1e-6
            {
                step *= 0.5;
                continue;
            }
            state = clamp_state(new_state);
            gas = clamp_gas(new_gas);
            cod_out_kg += state.cod() * config.flow_m3_per_d * step;
            n_out_kg += state.nitrogen() * config.flow_m3_per_d * step;
            let h2_mol = rates.processes[19] / 16.0;
            let ch4_mol = rates.processes[20] / 64.0;
            let ic_mol = rates.processes[21] / 12.0;
            gas_h2_kmol += h2_mol * step * config.volume_m3;
            gas_ch4_kmol += ch4_mol * step * config.volume_m3;
            gas_ic_kmol += ic_mol * step * config.volume_m3;
            time += step;
            steps += 1;
            last_rates = rates;
            break;
        }
    }

    let effluent = state;
    let ph = effluent.ph(&config.params, config.temperature_k);
    let final_cod = effluent.cod();
    let final_n = effluent.nitrogen();
    let cod_input = config.feed.cod() * config.flow_m3_per_d * days;
    let cod_output = cod_out_kg;
    let cod_gas = gas_ch4_kmol * 64.0 + gas_h2_kmol * 16.0;
    let cod_inventory = (final_cod - initial_cod) * config.volume_m3;
    let cod_residual = relative_residual(cod_input, cod_output + cod_gas + cod_inventory);
    let n_input = config.feed.nitrogen() * config.flow_m3_per_d * days;
    let n_output = n_out_kg;
    let n_inventory = (final_n - initial_n) * config.volume_m3;
    let n_residual = relative_residual(n_input, n_output + n_inventory);

    let total_gas_kmol = gas_ch4_kmol + gas_h2_kmol + gas_ic_kmol;
    let methane_fraction = if total_gas_kmol > 0.0 {
        gas_ch4_kmol / total_gas_kmol
    } else {
        0.0
    };
    let co2_fraction = if total_gas_kmol > 0.0 {
        gas_ic_kmol / total_gas_kmol
    } else {
        0.0
    };
    let h2_fraction = if total_gas_kmol > 0.0 {
        gas_h2_kmol / total_gas_kmol
    } else {
        0.0
    };
    let gas_m3_per_d = total_gas_kmol * 22.414 / days;
    let methane_m3_per_d = gas_ch4_kmol * 22.414 / days;

    Ok(Adm1Snapshot {
        days,
        steps,
        effluent,
        gas,
        ph,
        biogas_m3_per_d: gas_m3_per_d,
        methane_m3_per_d,
        methane_fraction,
        co2_fraction,
        h2_fraction,
        cod_balance: Adm1MassBalance {
            input_kg: cod_input,
            output_kg: cod_output,
            gas_kg: cod_gas,
            inventory_kg: cod_inventory,
            residual: cod_residual,
            closed: cod_residual.abs() <= 0.02,
        },
        nitrogen_balance: Adm1MassBalance {
            input_kg: n_input,
            output_kg: n_output,
            gas_kg: 0.0,
            inventory_kg: n_inventory,
            residual: n_residual,
            closed: n_residual.abs() <= 0.02,
        },
        gas_ch4_kmol,
        gas_h2_kmol,
        gas_ic_kmol,
        rates: last_rates,
    })
}

fn relative_residual(input: f64, accounted: f64) -> f64 {
    if input.abs() > 1e-12 {
        (input - accounted) / input
    } else {
        accounted.abs()
    }
}

fn integrate_state(
    state: &Adm1State,
    derivatives: &[f64; ADM1_STATE_COMPONENTS],
    step: f64,
) -> Adm1State {
    let mut values = [0.0; ADM1_STATE_COMPONENTS];
    for i in 0..ADM1_STATE_COMPONENTS {
        values[i] = state.values[i] + derivatives[i] * step;
    }
    Adm1State { values }
}

fn clamp_state(mut state: Adm1State) -> Adm1State {
    for value in &mut state.values {
        if *value < 0.0 {
            *value = 0.0;
        }
    }
    state
}

fn integrate_gas(
    gas: &Adm1Gas,
    rates: &Adm1Rates,
    _state: &Adm1State,
    _config: &Adm1Config,
    step: f64,
) -> Adm1Gas {
    let h2_mol = rates.processes[19] / 16.0;
    let ch4_mol = rates.processes[20] / 64.0;
    let ic_mol = rates.processes[21] / 12.0;
    let production = (h2_mol + ch4_mol + ic_mol).max(0.0);
    let total = gas.total();
    let mut new_gas = *gas;
    if total > 1e-15 {
        new_gas.h2 += (h2_mol - production * gas.h2 / total) * step;
        new_gas.ch4 += (ch4_mol - production * gas.ch4 / total) * step;
        new_gas.ic += (ic_mol - production * gas.ic / total) * step;
    } else {
        new_gas.h2 += h2_mol * step;
        new_gas.ch4 += ch4_mol * step;
        new_gas.ic += ic_mol * step;
    }
    new_gas
}

fn clamp_gas(mut gas: Adm1Gas) -> Adm1Gas {
    gas.h2 = gas.h2.max(0.0);
    gas.ch4 = gas.ch4.max(0.0);
    gas.ic = gas.ic.max(0.0);
    gas
}

/// Compute all 22 process rates. Gas transfer rates are returned in kg COD
/// (H2, CH4) or kg C (IC) per m3 per day.
pub fn reaction_rates(state: &Adm1State, gas: &Adm1Gas, config: &Adm1Config) -> Adm1Rates {
    let p = &config.params;
    let ph = state.ph(p, config.temperature_k);
    let h = 10.0_f64.powf(-ph);
    let ka = p.ka(config.temperature_k);

    let i_ph_aa = ph_inhibit(ph, p.ph_ul_aa, p.ph_ll_aa);
    let i_ph_ac = ph_inhibit(ph, p.ph_ul_ac, p.ph_ll_ac);
    let i_ph_h2 = ph_inhibit(ph, p.ph_ul_h2, p.ph_ll_h2);

    let s_in = state.values[S_IN] / 14.0;
    let nh3 = s_in * ka[1] / (ka[1] + h);
    let i_in = monod(state.values[S_IN], p.ks_in);
    let i_nh3 = p.ki_nh3 / (p.ki_nh3 + nh3);
    let i_h2_fa = p.ki_h2_fa / (p.ki_h2_fa + state.values[S_H2]);
    let i_h2_c4 = p.ki_h2_c4 / (p.ki_h2_c4 + state.values[S_H2]);
    let i_h2_pro = p.ki_h2_pro / (p.ki_h2_pro + state.values[S_H2]);

    let mut r = [0.0; ADM1_PROCESSES];
    r[0] = p.k_dis * state.values[X_C];
    r[1] = p.k_hyd_ch * state.values[X_CH];
    r[2] = p.k_hyd_pr * state.values[X_PR];
    r[3] = p.k_hyd_li * state.values[X_LI];
    r[4] = p.k_m_su * monod(state.values[S_SU], p.k_s_su) * state.values[X_SU] * i_ph_aa * i_in;
    r[5] = p.k_m_aa * monod(state.values[S_AA], p.k_s_aa) * state.values[X_AA] * i_ph_aa * i_in;
    r[6] = p.k_m_fa
        * monod(state.values[S_FA], p.k_s_fa)
        * state.values[X_FA]
        * i_ph_aa
        * i_in
        * i_h2_fa;
    let va_share = if state.values[S_VA] + state.values[S_BU] > 0.0 {
        state.values[S_VA] / (state.values[S_VA] + state.values[S_BU])
    } else {
        0.0
    };
    let bu_share = if state.values[S_VA] + state.values[S_BU] > 0.0 {
        state.values[S_BU] / (state.values[S_VA] + state.values[S_BU])
    } else {
        0.0
    };
    r[7] = p.k_m_c4
        * monod(state.values[S_VA], p.k_s_c4)
        * state.values[X_C4]
        * va_share
        * i_ph_aa
        * i_in
        * i_h2_c4;
    r[8] = p.k_m_c4
        * monod(state.values[S_BU], p.k_s_c4)
        * state.values[X_C4]
        * bu_share
        * i_ph_aa
        * i_in
        * i_h2_c4;
    r[9] = p.k_m_pro
        * monod(state.values[S_PRO], p.k_s_pro)
        * state.values[X_PRO]
        * i_ph_aa
        * i_in
        * i_h2_pro;
    r[10] = p.k_m_ac
        * monod(state.values[S_AC], p.k_s_ac)
        * state.values[X_AC]
        * i_ph_ac
        * i_in
        * i_nh3;
    r[11] = p.k_m_h2 * monod(state.values[S_H2], p.k_s_h2) * state.values[X_H2] * i_ph_h2 * i_in;
    let decay_indices = [X_SU, X_AA, X_FA, X_C4, X_PRO, X_AC, X_H2];
    for (offset, index) in decay_indices.into_iter().enumerate() {
        r[12 + offset] = p.k_dec * state.values[index];
    }

    let rt = 0.08314 * config.temperature_k;
    let p_h2 = gas.h2 / config.gas_volume_ratio * rt;
    let p_ch4 = gas.ch4 / config.gas_volume_ratio * rt;
    let p_co2 = gas.ic / config.gas_volume_ratio * rt;
    let co2 = state.values[S_IC] * h / (ka[2] + h);
    r[19] = p.kla * (state.values[S_H2] - p.kh_h2 * p_h2);
    r[20] = p.kla * (state.values[S_CH4] - p.kh_ch4 * p_ch4);
    r[21] = p.kla * (co2 - p.kh_co2 * p_co2);

    Adm1Rates { processes: r, ph }
}

fn monod(substrate: f64, half_saturation: f64) -> f64 {
    if substrate <= 0.0 {
        0.0
    } else {
        substrate / (half_saturation + substrate)
    }
}

fn ph_inhibit(ph: f64, upper: f64, lower: f64) -> f64 {
    if ph >= upper {
        1.0
    } else {
        let low_by = ph - upper;
        let width = upper - lower;
        (-3.0 * (low_by / width).powi(2)).exp()
    }
}

fn derivatives(
    state: &Adm1State,
    feed: &Adm1State,
    rates: &Adm1Rates,
    config: &Adm1Config,
) -> [f64; ADM1_STATE_COMPONENTS] {
    let dilution = config.flow_m3_per_d / config.volume_m3;
    let mut d = [0.0; ADM1_STATE_COMPONENTS];
    for i in 0..ADM1_STATE_COMPONENTS {
        d[i] = dilution * (feed.values[i] - state.values[i]);
    }
    for process in 0..ADM1_PROCESSES {
        let rho = rates.processes[process];
        for component in 0..ADM1_COMPONENTS {
            d[component] += ADM1_STOICH[process][component] * rho;
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_stoichiometry_closes_cod_and_nitrogen() {
        let n_factors = [
            0.0, 0.098, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.06, 0.0376, 0.0, 0.098, 0.0,
            0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.06, 0.0, 0.0,
        ];
        for (row_index, row) in ADM1_STOICH.iter().enumerate() {
            if row_index >= 19 {
                continue;
            }
            let cod_sum: f64 = row
                .iter()
                .enumerate()
                .filter(|(i, _)| ![S_IC, S_IN].contains(i))
                .map(|(_, v)| *v)
                .sum();
            let n_sum: f64 = row.iter().enumerate().map(|(i, v)| n_factors[i] * v).sum();
            assert!(cod_sum.abs() < 1.0e-12, "COD row {row_index} sum {cod_sum}");
            assert!(n_sum.abs() < 1.0e-12, "N row {row_index} sum {n_sum}");
        }
    }

    fn tutorial_config() -> Adm1Config {
        let mut feed = Adm1State::default();
        for (i, value) in [
            0.01, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 1.0e-8, 1.0e-5, 0.48, 0.14, 0.02, 2.0,
            5.0, 20.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 25.0,
        ]
        .iter()
        .enumerate()
        {
            feed.values[i] = *value;
        }
        feed.values[S_CAT] = 0.04;
        feed.values[S_AN] = 0.02;

        let mut initial = Adm1State::default();
        for (i, value) in [
            0.0124, 0.0055, 0.1074, 0.0123, 0.0140, 0.0176, 0.0893, 2.5055e-7, 0.0555, 1.1412,
            1.323, 0.1309, 0.0, 0.0205, 0.0842, 0.0436, 0.3122, 0.9317, 0.3384, 0.3258, 0.1011,
            0.6772, 0.2848, 17.2162,
        ]
        .iter()
        .enumerate()
        {
            initial.values[i] = *value;
        }
        initial.values[S_CAT] = 0.04;
        initial.values[S_AN] = 0.02;

        Adm1Config {
            volume_m3: 850.0,
            flow_m3_per_d: 170.0,
            temperature_k: 308.15,
            gas_volume_ratio: 0.1,
            feed,
            initial,
            initial_gas: Adm1Gas {
                h2: 3.9e-9,
                ch4: 0.00254,
                ic: 0.00137,
            },
            params: Adm1Params::default(),
        }
    }

    #[test]
    fn rejects_zero_or_negative_time_step() {
        let config = tutorial_config();
        assert!(simulate_adm1(&config, 10.0, 0.0).is_err());
        assert!(simulate_adm1(&config, 10.0, -0.002).is_err());
        assert!(simulate_adm1(&config, f64::NAN, 0.002).is_err());
    }

    #[test]
    fn tutorial_cstr_closes_cod_and_nitrogen() {
        let config = tutorial_config();
        let snapshot = simulate_adm1(&config, 10.0, 0.002).expect("simulation");
        assert!(snapshot.ph > 6.8 && snapshot.ph < 7.8, "pH {}", snapshot.ph);
        assert!(snapshot.gas_ch4_kmol > 0.0);
        assert!(
            snapshot.cod_balance.residual.abs() < 0.05,
            "COD residual {}",
            snapshot.cod_balance.residual
        );
        assert!(
            snapshot.nitrogen_balance.residual.abs() < 0.05,
            "N residual {}",
            snapshot.nitrogen_balance.residual
        );
        assert!(snapshot.effluent.cod() > 0.0);
        assert!(
            snapshot.effluent.values[S_AC] > 3.0 && snapshot.effluent.values[S_AC] < 10.0,
            "acetate {}",
            snapshot.effluent.values[S_AC]
        );
        assert!(
            snapshot.effluent.values[S_IN] > 1.0 && snapshot.effluent.values[S_IN] < 2.5,
            "S_IN {}",
            snapshot.effluent.values[S_IN]
        );
        assert!(
            snapshot.methane_fraction > 0.40 && snapshot.methane_fraction < 0.65,
            "CH4 fraction {}",
            snapshot.methane_fraction
        );
        assert!(
            snapshot.co2_fraction > 0.25 && snapshot.co2_fraction < 0.60,
            "CO2 fraction {}",
            snapshot.co2_fraction
        );
    }
}

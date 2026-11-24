//! ASM2d: 19 components, 19 processes, stoichiometry and rate surface.
//!
//! Ported from the TypeScript reference `src/sim/asm2d.ts`. The reference remains
//! the oracle until golden parity is signed off.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Component {
    SO = 0,
    SF = 1,
    SA = 2,
    SI = 3,
    SNH4 = 4,
    SN2 = 5,
    SNO3 = 6,
    SPO4 = 7,
    SAlk = 8,
    XI = 9,
    XS = 10,
    XH = 11,
    XPAO = 12,
    XPP = 13,
    XPHA = 14,
    XAUT = 15,
    XTSS = 16,
    XMEOH = 17,
    XMEP = 18,
}

pub const COMPONENTS: [Component; 19] = [
    Component::SO,
    Component::SF,
    Component::SA,
    Component::SI,
    Component::SNH4,
    Component::SN2,
    Component::SNO3,
    Component::SPO4,
    Component::SAlk,
    Component::XI,
    Component::XS,
    Component::XH,
    Component::XPAO,
    Component::XPP,
    Component::XPHA,
    Component::XAUT,
    Component::XTSS,
    Component::XMEOH,
    Component::XMEP,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Process {
    AerobicGrowthXH = 0,
    AnoxicGrowthXH = 1,
    AerobicGrowthPAO = 2,
    AnoxicGrowthPAO = 3,
    AerobicGrowthAUT = 4,
    HydrolysisXS = 5,
    Ammonification = 6,
    StoragePHAAerobic = 7,
    StoragePHAAnoxic = 8,
    StoragePHAAerobic2 = 9,
    LysisXH = 10,
    LysisPAO = 11,
    LysisAUT = 12,
    HydrolysisPP = 13,
    HydrolysisPHA = 14,
    PrecipitationPO4 = 15,
    RedissolutionPO4 = 16,
    AerobicGrowthMEOH = 17,
    AnoxicGrowthMEOH = 18,
}

pub const PROCESSES: [Process; 19] = [
    Process::AerobicGrowthXH,
    Process::AnoxicGrowthXH,
    Process::AerobicGrowthPAO,
    Process::AnoxicGrowthPAO,
    Process::AerobicGrowthAUT,
    Process::HydrolysisXS,
    Process::Ammonification,
    Process::StoragePHAAerobic,
    Process::StoragePHAAnoxic,
    Process::StoragePHAAerobic2,
    Process::LysisXH,
    Process::LysisPAO,
    Process::LysisAUT,
    Process::HydrolysisPP,
    Process::HydrolysisPHA,
    Process::PrecipitationPO4,
    Process::RedissolutionPO4,
    Process::AerobicGrowthMEOH,
    Process::AnoxicGrowthMEOH,
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct State {
    pub v: [f64; 19],
}

impl State {
    pub const fn zero() -> Self {
        Self { v: [0.0; 19] }
    }

    pub fn from_values(v: [f64; 19]) -> Self {
        Self { v }
    }

    pub fn get(&self, c: Component) -> f64 {
        self.v[c as usize]
    }

    pub fn set(&mut self, c: Component, value: f64) {
        self.v[c as usize] = value;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    pub y_h: f64,
    pub y_pao: f64,
    pub y_po4: f64,
    pub y_pha: f64,
    pub y_a: f64,
    pub f_si: f64,
    pub i_n_si: f64,
    pub i_n_xs: f64,
    pub i_n_bm: f64,
    pub i_p_si: f64,
    pub i_p_xs: f64,
    pub i_p_bm: f64,
    pub i_p_pp: f64,
    pub i_tss_bm: f64,
    pub i_tss_xp: f64,
    pub mu_h: f64,
    pub q_fe: f64,
    pub eta_no3: f64,
    pub b_h: f64,
    pub mu_pao: f64,
    pub q_pha: f64,
    pub q_pp: f64,
    pub q_pp_hydrolysis: f64,
    pub eta_no3_pao: f64,
    pub b_pao: f64,
    pub b_pp: f64,
    pub b_pha: f64,
    pub mu_aut: f64,
    pub b_aut: f64,
    pub k_h: f64,
    pub eta_no3_h: f64,
    pub k_o2: f64,
    pub k_no3: f64,
    pub k_a: f64,
    pub k_f: f64,
    pub k_nh4: f64,
    pub k_nh4_pao: f64,
    pub k_nh4_aut: f64,
    pub k_p: f64,
    pub k_alk: f64,
    pub k_s: f64,
    pub k_x: f64,
    pub k_h_sat: f64,
    pub k_pp: f64,
    pub k_pha: f64,
    pub k_pre: f64,
    pub k_red: f64,
    pub k_amm: f64,
    pub theta: f64,
    pub t_ref: f64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            y_h: 0.625,
            y_pao: 0.625,
            y_po4: 0.4,
            y_pha: 1.0,
            y_a: 0.24,
            f_si: 0.0,
            i_n_si: 0.01,
            i_n_xs: 0.04,
            i_n_bm: 0.07,
            i_p_si: 0.0,
            i_p_xs: 0.01,
            i_p_bm: 0.02,
            i_p_pp: 0.19,
            i_tss_bm: 0.9,
            i_tss_xp: 0.6,
            mu_h: 6.0,
            q_fe: 3.0,
            eta_no3: 0.8,
            b_h: 0.01,
            mu_pao: 2.5,
            q_pha: 20.0,
            q_pp: 5.0,
            q_pp_hydrolysis: 0.02,
            eta_no3_pao: 0.6,
            b_pao: 0.02,
            b_pp: 0.2,
            b_pha: 0.2,
            mu_aut: 1.0,
            b_aut: 0.15,
            k_h: 3.0,
            eta_no3_h: 0.6,
            k_o2: 0.2,
            k_no3: 0.5,
            k_a: 4.0,
            k_f: 4.0,
            k_nh4: 0.01,
            k_nh4_pao: 0.001,
            k_nh4_aut: 0.15,
            k_p: 0.02,
            k_alk: 0.1,
            k_s: 10.0,
            k_x: 0.1,
            k_h_sat: 0.1,
            k_pp: 0.1,
            k_pha: 0.1,
            k_pre: 1.0,
            k_red: 0.6,
            k_amm: 0.08,
            theta: 1.06,
            t_ref: 20.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Stoichiometry {
    /// rows are processes, columns are components
    pub a: [[f64; 19]; 19],
}

impl Stoichiometry {
    pub fn new(p: &Params) -> Self {
        let mut a = [[0.0; 19]; 19];
        let mut set = |proc: Process, comp: Component, value: f64| {
            a[proc as usize][comp as usize] = value;
        };

        // aerobic_growth_XH
        set(Process::AerobicGrowthXH, Component::SA, -1.0 / p.y_h);
        set(
            Process::AerobicGrowthXH,
            Component::SO,
            -(1.0 - p.y_h) / p.y_h,
        );
        set(Process::AerobicGrowthXH, Component::SNH4, -p.i_n_bm);
        set(Process::AerobicGrowthXH, Component::SPO4, -p.i_p_bm);
        set(Process::AerobicGrowthXH, Component::XH, 1.0);
        set(Process::AerobicGrowthXH, Component::SAlk, -p.i_n_bm / 14.0);

        // anoxic_growth_XH
        set(Process::AnoxicGrowthXH, Component::SA, -1.0 / p.y_h);
        set(
            Process::AnoxicGrowthXH,
            Component::SNO3,
            -(1.0 - p.y_h) / (2.86 * p.y_h),
        );
        set(Process::AnoxicGrowthXH, Component::SNH4, -p.i_n_bm);
        set(Process::AnoxicGrowthXH, Component::SPO4, -p.i_p_bm);
        set(Process::AnoxicGrowthXH, Component::XH, 1.0);
        set(
            Process::AnoxicGrowthXH,
            Component::SN2,
            (1.0 - p.y_h) / (2.86 * p.y_h),
        );
        set(
            Process::AnoxicGrowthXH,
            Component::SAlk,
            -(p.i_n_bm - (1.0 - p.y_h) / (2.86 * p.y_h)) / 14.0,
        );

        // aerobic_growth_PAO
        set(Process::AerobicGrowthPAO, Component::XPHA, -1.0 / p.y_pao);
        set(Process::AerobicGrowthPAO, Component::XPAO, 1.0);
        set(
            Process::AerobicGrowthPAO,
            Component::XPP,
            -p.i_p_bm / p.i_p_pp,
        );
        set(
            Process::AerobicGrowthPAO,
            Component::SO,
            -(1.0 - p.y_pao) / p.y_pao,
        );
        set(Process::AerobicGrowthPAO, Component::SNH4, -p.i_n_bm);
        set(Process::AerobicGrowthPAO, Component::SAlk, -p.i_n_bm / 14.0);

        // anoxic_growth_PAO
        set(Process::AnoxicGrowthPAO, Component::XPHA, -1.0 / p.y_pao);
        set(Process::AnoxicGrowthPAO, Component::XPAO, 1.0);
        set(
            Process::AnoxicGrowthPAO,
            Component::XPP,
            -p.i_p_bm / p.i_p_pp,
        );
        set(
            Process::AnoxicGrowthPAO,
            Component::SNO3,
            -(1.0 - p.y_pao) / (2.86 * p.y_pao),
        );
        set(
            Process::AnoxicGrowthPAO,
            Component::SN2,
            (1.0 - p.y_pao) / (2.86 * p.y_pao),
        );
        set(Process::AnoxicGrowthPAO, Component::SNH4, -p.i_n_bm);
        set(
            Process::AnoxicGrowthPAO,
            Component::SAlk,
            -(p.i_n_bm - (1.0 - p.y_pao) / (2.86 * p.y_pao)) / 14.0,
        );

        // aerobic_growth_AUT
        set(Process::AerobicGrowthAUT, Component::XAUT, 1.0);
        set(
            Process::AerobicGrowthAUT,
            Component::SNH4,
            -(1.0 / p.y_a + p.i_n_bm),
        );
        set(Process::AerobicGrowthAUT, Component::SNO3, 1.0 / p.y_a);
        set(
            Process::AerobicGrowthAUT,
            Component::SO,
            -(4.57 - p.y_a) / p.y_a,
        );
        set(Process::AerobicGrowthAUT, Component::SPO4, -p.i_p_bm);
        set(
            Process::AerobicGrowthAUT,
            Component::SAlk,
            -(2.0 / p.y_a + p.i_n_bm) / 14.0,
        );

        // hydrolysis_XS
        set(Process::HydrolysisXS, Component::XS, -1.0);
        set(Process::HydrolysisXS, Component::SF, 1.0);
        set(Process::HydrolysisXS, Component::SNH4, p.i_n_xs - p.i_n_si);
        set(Process::HydrolysisXS, Component::SPO4, p.i_p_xs);

        // ammonification intentionally empty (reference is empty as well)
        // storage_PHA_anaerobic
        set(Process::StoragePHAAerobic, Component::SA, -1.0);
        set(Process::StoragePHAAerobic, Component::XPHA, p.y_pha);
        set(Process::StoragePHAAerobic, Component::XPP, -1.0);
        set(Process::StoragePHAAerobic, Component::SPO4, p.i_p_pp);
        set(Process::StoragePHAAerobic, Component::SAlk, p.i_p_pp / 14.0);

        // storage_PHA_anoxic
        set(Process::StoragePHAAnoxic, Component::SA, -1.0);
        set(Process::StoragePHAAnoxic, Component::XPHA, p.y_pha);
        set(Process::StoragePHAAnoxic, Component::XPP, -1.0);
        set(Process::StoragePHAAnoxic, Component::SPO4, p.i_p_pp);
        set(
            Process::StoragePHAAnoxic,
            Component::SNO3,
            -(1.0 - p.y_pha) / 2.86,
        );
        set(
            Process::StoragePHAAnoxic,
            Component::SN2,
            (1.0 - p.y_pha) / 2.86,
        );
        set(Process::StoragePHAAnoxic, Component::SAlk, p.i_p_pp / 14.0);

        // storage_PHA_aerobic
        set(Process::StoragePHAAerobic2, Component::SA, -1.0);
        set(Process::StoragePHAAerobic2, Component::XPHA, p.y_pha);
        set(Process::StoragePHAAerobic2, Component::XPP, -1.0);
        set(Process::StoragePHAAerobic2, Component::SPO4, p.i_p_pp);
        set(Process::StoragePHAAerobic2, Component::SO, -(1.0 - p.y_pha));
        set(
            Process::StoragePHAAerobic2,
            Component::SAlk,
            p.i_p_pp / 14.0,
        );

        // lysis_XH
        set(Process::LysisXH, Component::XH, -1.0);
        set(Process::LysisXH, Component::XS, 1.0);
        set(Process::LysisXH, Component::SNH4, p.i_n_bm - p.i_n_xs);
        set(Process::LysisXH, Component::SPO4, p.i_p_bm - p.i_p_xs);

        // lysis_PAO
        set(Process::LysisPAO, Component::XPAO, -1.0);
        set(Process::LysisPAO, Component::XS, 1.0);
        set(Process::LysisPAO, Component::XPP, -1.0);
        set(
            Process::LysisPAO,
            Component::SPO4,
            p.i_p_pp + (p.i_p_bm - p.i_p_xs),
        );
        set(Process::LysisPAO, Component::SNH4, p.i_n_bm - p.i_n_xs);

        // lysis_AUT
        set(Process::LysisAUT, Component::XAUT, -1.0);
        set(Process::LysisAUT, Component::XS, 1.0);
        set(Process::LysisAUT, Component::SNH4, p.i_n_bm - p.i_n_xs);
        set(Process::LysisAUT, Component::SPO4, p.i_p_bm - p.i_p_xs);

        // hydrolysis_PP
        set(Process::HydrolysisPP, Component::XPP, -1.0);
        set(Process::HydrolysisPP, Component::SPO4, p.i_p_pp);
        set(Process::HydrolysisPP, Component::SAlk, 0.0);

        // hydrolysis_PHA
        set(Process::HydrolysisPHA, Component::XPHA, -1.0);
        set(Process::HydrolysisPHA, Component::SA, 1.0);

        // precipitation / redissolution
        set(Process::PrecipitationPO4, Component::SPO4, -1.0);
        set(Process::PrecipitationPO4, Component::XMEP, 1.0);
        set(Process::PrecipitationPO4, Component::SAlk, -1.0 / 14.0);
        set(Process::RedissolutionPO4, Component::XMEP, -1.0);
        set(Process::RedissolutionPO4, Component::SPO4, 1.0);
        set(Process::RedissolutionPO4, Component::SAlk, 1.0 / 14.0);

        Self { a }
    }
}

fn monod(s: f64, k: f64) -> f64 {
    s / (k + s + 1e-6)
}

fn switch_off(s: f64, k: f64) -> f64 {
    k / (k + s + 1e-6)
}

fn oxidant(s: &State) -> f64 {
    (s.get(Component::SO) - 0.1).max(0.0)
}

#[derive(Debug, Clone)]
pub struct Rates {
    pub r: [f64; 19],
}

pub fn rates(p: &Params, s: &State, temperature_c: f64) -> Rates {
    let f = p.theta.powf(temperature_c - p.t_ref);
    let s_oa = oxidant(s);
    let x_s_ratio = s.get(Component::XS) / s.get(Component::XH).max(1e-6);
    let x_pp_ratio = s.get(Component::XPP) / s.get(Component::XPAO).max(1e-6);

    let mut r = [0.0; 19];
    r[Process::AerobicGrowthXH as usize] = p.mu_h
        * f
        * monod(s.get(Component::SA), p.k_a)
        * monod(s_oa, p.k_o2)
        * monod(s.get(Component::SNH4), p.k_nh4)
        * monod(s.get(Component::SPO4), p.k_p)
        * s.get(Component::XH);

    r[Process::AnoxicGrowthXH as usize] = p.mu_h
        * f
        * p.eta_no3
        * monod(s.get(Component::SA), p.k_a)
        * switch_off(s.get(Component::SO), p.k_o2)
        * monod(s.get(Component::SNO3), p.k_no3)
        * monod(s.get(Component::SNH4), p.k_nh4)
        * monod(s.get(Component::SPO4), p.k_p)
        * s.get(Component::XH);

    r[Process::AerobicGrowthPAO as usize] = p.mu_pao
        * f
        * monod(s.get(Component::XPHA).max(0.05), p.k_pha)
        * monod(s_oa, p.k_o2)
        * monod(s.get(Component::SNH4), p.k_nh4_pao)
        * monod(s.get(Component::SPO4), p.k_p)
        * s.get(Component::XPAO);

    r[Process::AnoxicGrowthPAO as usize] = p.mu_pao
        * f
        * p.eta_no3_pao
        * monod(s.get(Component::XPHA).max(0.05), p.k_pha)
        * switch_off(s.get(Component::SO), p.k_o2)
        * monod(s.get(Component::SNO3), p.k_no3)
        * monod(s.get(Component::SNH4), p.k_nh4_pao)
        * monod(s.get(Component::SPO4), p.k_p)
        * s.get(Component::XPAO);

    r[Process::AerobicGrowthAUT as usize] = p.mu_aut
        * f
        * monod(s.get(Component::SNH4), p.k_nh4_aut)
        * monod(s_oa, p.k_o2)
        * s.get(Component::XAUT);

    r[Process::HydrolysisXS as usize] = (p.k_h * f * x_s_ratio / (p.k_x + x_s_ratio))
        * (monod(s.get(Component::SO), p.k_o2)
            + p.eta_no3_h
                * switch_off(s.get(Component::SO), p.k_o2)
                * monod(s.get(Component::SNO3), p.k_no3))
        * s.get(Component::XH);

    r[Process::Ammonification as usize] = p.k_amm * f * s.get(Component::XH) * s.get(Component::SF);

    r[Process::StoragePHAAerobic as usize] = p.q_pha
        * f
        * monod(s.get(Component::SA), p.k_a)
        * monod(s.get(Component::SAlk), p.k_alk)
        * switch_off(s.get(Component::SO), p.k_o2)
        * switch_off(s.get(Component::SNO3), p.k_no3)
        * s.get(Component::XPAO);

    r[Process::StoragePHAAnoxic as usize] = p.q_pha
        * f
        * monod(s.get(Component::SA), p.k_a)
        * switch_off(s.get(Component::SO), p.k_o2)
        * monod(s.get(Component::SNO3), p.k_no3)
        * s.get(Component::XPAO);

    r[Process::StoragePHAAerobic2 as usize] = p.q_pha
        * f
        * monod(s.get(Component::SA), p.k_a)
        * monod(s_oa, p.k_o2)
        * s.get(Component::XPAO);

    r[Process::LysisXH as usize] = p.b_h * f * s.get(Component::XH);
    r[Process::LysisPAO as usize] = p.b_pao * f * s.get(Component::XPAO);
    r[Process::LysisAUT as usize] = p.b_aut * f * s.get(Component::XAUT);

    r[Process::HydrolysisPP as usize] =
        p.q_pp_hydrolysis * f * (x_pp_ratio / (p.k_pp + x_pp_ratio)) * s.get(Component::XPAO);

    r[Process::HydrolysisPHA as usize] = p.b_pha * f * (s.get(Component::XPHA) - 0.05).max(0.0);

    r[Process::PrecipitationPO4 as usize] = p.k_pre * s.get(Component::SPO4);
    r[Process::RedissolutionPO4 as usize] = p.k_red * s.get(Component::XMEP);
    r[Process::AerobicGrowthMEOH as usize] = 0.0;
    r[Process::AnoxicGrowthMEOH as usize] = 0.0;

    Rates { r }
}

impl Params {
    fn cstr_overrides(&self) -> Self {
        let mut p = *self;
        p.y_pha = 0.2;
        p.q_pha = 3.0;
        p.q_pp = 1.5;
        p.mu_pao = 1.0;
        p.b_pao = 0.2;
        p.b_h = 0.4;
        p.k_nh4 = 0.05;
        p.k_p = 0.2;
        p
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CstrOptions {
    pub volume: f64,
    pub flow: f64,
    pub dt_hours: f64,
    pub temperature_c: f64,
}

/// One CSTR step: dilution + reaction, then non-negative clamp.
pub fn step_cstr(state: &State, influent: &State, params: &Params, opts: CstrOptions) -> State {
    let p = params.cstr_overrides();
    let rates = rates(&p, state, opts.temperature_c);
    let stoich = Stoichiometry::new(&p);
    let dilution = (opts.flow / opts.volume.max(1e-9)) * opts.dt_hours;

    let mut next = State::zero();
    for c in COMPONENTS {
        let mut reaction = 0.0;
        for proc in PROCESSES {
            reaction += stoich.a[proc as usize][c as usize] * rates.r[proc as usize];
        }
        let value = state.get(c)
            + (influent.get(c) - state.get(c)) * dilution.min(1.0)
            + reaction * opts.dt_hours;
        next.set(c, value.max(0.0));
    }
    next
}

pub fn cod_concentration(s: &State) -> f64 {
    s.get(Component::SI)
        + s.get(Component::SF)
        + s.get(Component::SA)
        + s.get(Component::XI)
        + s.get(Component::XS)
        + s.get(Component::XH)
        + s.get(Component::XPAO)
        + s.get(Component::XPHA)
        + s.get(Component::XAUT)
}

pub fn n_concentration(s: &State, p: &Params) -> f64 {
    s.get(Component::SNH4)
        + s.get(Component::SNO3)
        + s.get(Component::SN2)
        + s.get(Component::SF) * p.i_n_si
        + s.get(Component::XS) * p.i_n_xs
        + (s.get(Component::XH) + s.get(Component::XPAO) + s.get(Component::XAUT)) * p.i_n_bm
}

pub fn p_concentration(s: &State, p: &Params) -> f64 {
    s.get(Component::SPO4)
        + s.get(Component::XPP) * p.i_p_pp
        + s.get(Component::XS) * p.i_p_xs
        + (s.get(Component::XH) + s.get(Component::XPAO) + s.get(Component::XAUT)) * p.i_p_bm
        + s.get(Component::XMEP)
}

pub const COD_PER_VSS: f64 = 1.42;

/// Aggregate influent to ASM2d. This is the standard BSM2 urban split used by the
/// TypeScript reference; it is an initial-condition mapping, not calibration.
pub fn influent_to_asm2d(cod_in: f64, nh: f64, no3: f64, tp: f64, alkalinity: f64) -> State {
    let cod = cod_in.max(1.0);
    let mut s = State::zero();
    s.set(Component::SA, cod * 0.085);
    s.set(Component::SF, cod * 0.085);
    s.set(Component::SI, cod * 0.09);
    s.set(Component::XS, cod * 0.4);
    s.set(Component::XI, cod * 0.07);
    s.set(Component::XH, cod * 0.02);
    s.set(Component::SNH4, nh.max(0.0));
    s.set(Component::SNO3, no3.max(0.0));
    s.set(Component::SPO4, tp.max(0.0));
    s.set(Component::SAlk, (alkalinity / 50.0).max(0.0));
    s
}

/// Aggregate reactor initialization (MLSS seeding), matching `toAsm2d`.
pub fn to_asm2d(
    cod_in: f64,
    nh: f64,
    no3: f64,
    tp: f64,
    do_level: f64,
    alkalinity: f64,
    mlss: f64,
) -> State {
    let total_cod = cod_in.max(1.0);
    let inert_soluble = total_cod * 0.08;
    let soluble_readily = total_cod * 0.18;
    let inert_particulate = total_cod * 0.2;
    let remaining = total_cod * 0.54;
    let biomass_from_mlss = if mlss > 0.0 {
        mlss * 0.75 * COD_PER_VSS
    } else {
        0.0
    };
    let biomass = remaining.min(biomass_from_mlss);
    let slowly = (remaining - biomass).max(0.0);

    let mut s = State::zero();
    s.set(Component::SI, inert_soluble);
    s.set(Component::SF, soluble_readily * 0.45);
    s.set(Component::SA, soluble_readily * 0.55);
    s.set(Component::XI, inert_particulate);
    s.set(Component::XS, slowly);
    s.set(Component::XH, biomass * 0.7);
    s.set(Component::XPAO, biomass * 0.15);
    s.set(Component::XAUT, biomass * 0.15);
    s.set(Component::XPP, biomass * 0.15 * 0.25);
    s.set(Component::XPHA, biomass * 0.15 * 0.15);
    s.set(Component::SNH4, nh.max(0.0));
    s.set(Component::SNO3, no3.max(0.0));
    s.set(Component::SPO4, tp.max(0.0));
    s.set(Component::SO, do_level.max(0.0));
    s.set(Component::SAlk, (alkalinity / 50.0).max(0.0));
    s
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aggregate {
    pub cod: f64,
    pub nh: f64,
    pub no3: f64,
    pub tp: f64,
    pub ss: f64,
    pub do_level: f64,
    pub alkalinity: f64,
}

pub fn from_asm2d(s: &State) -> Aggregate {
    let particulate = s.get(Component::XI)
        + s.get(Component::XS)
        + s.get(Component::XH)
        + s.get(Component::XPAO)
        + s.get(Component::XPP)
        + s.get(Component::XPHA)
        + s.get(Component::XAUT);
    Aggregate {
        cod: s.get(Component::SI) + s.get(Component::SF) + s.get(Component::SA) + particulate,
        nh: s.get(Component::SNH4),
        no3: s.get(Component::SNO3),
        tp: s.get(Component::SPO4),
        ss: particulate / COD_PER_VSS,
        do_level: s.get(Component::SO),
        alkalinity: s.get(Component::SAlk) * 50.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn influent() -> State {
        let mut s = State::zero();
        s.set(Component::SA, 60.0);
        s.set(Component::SF, 30.0);
        s.set(Component::SPO4, 5.0);
        s.set(Component::SNH4, 30.0);
        s.set(Component::SNO3, 0.1);
        s.set(Component::XH, 2000.0);
        s.set(Component::XPAO, 300.0);
        s.set(Component::XAUT, 80.0);
        s.set(Component::XPP, 300.0);
        s.set(Component::XPHA, 50.0);
        s.set(Component::SAlk, 8.0);
        s
    }

    #[test]
    fn anaerobic_releases_phosphate_and_builds_pha() {
        let inf = influent();
        let mut state = inf;
        state.set(Component::SO, 0.0);
        state.set(Component::SNO3, 0.0);
        for _ in 0..24 {
            state = step_cstr(
                &state,
                &inf,
                &Params::default(),
                CstrOptions {
                    volume: 1000.0,
                    flow: 100.0,
                    dt_hours: 1.0,
                    temperature_c: 20.0,
                },
            );
        }
        assert!(state.get(Component::SPO4) > inf.get(Component::SPO4));
        assert!(state.get(Component::XPHA) > inf.get(Component::XPHA));
    }

    #[test]
    fn aerobic_consumes_phosphate_relative_to_anaerobic() {
        let inf = influent();
        let mut anaerobic = inf;
        anaerobic.set(Component::SO, 0.0);
        anaerobic.set(Component::SNO3, 0.0);
        for _ in 0..24 {
            anaerobic = step_cstr(
                &anaerobic,
                &inf,
                &Params::default(),
                CstrOptions {
                    volume: 1000.0,
                    flow: 100.0,
                    dt_hours: 1.0,
                    temperature_c: 20.0,
                },
            );
        }
        let mut aerobic = anaerobic;
        aerobic.set(Component::SO, 2.0);
        aerobic.set(Component::SNO3, 0.1);
        for _ in 0..48 {
            aerobic = step_cstr(
                &aerobic,
                &inf,
                &Params::default(),
                CstrOptions {
                    volume: 1000.0,
                    flow: 100.0,
                    dt_hours: 1.0,
                    temperature_c: 20.0,
                },
            );
        }
        assert!(aerobic.get(Component::SPO4) < anaerobic.get(Component::SPO4));
    }

    #[test]
    fn no_negative_or_non_finite_values() {
        let inf = influent();
        let mut state = inf;
        state.set(Component::SO, 2.0);
        state.set(Component::SNO3, 5.0);
        for _ in 0..240 {
            state = step_cstr(
                &state,
                &inf,
                &Params::default(),
                CstrOptions {
                    volume: 1000.0,
                    flow: 100.0,
                    dt_hours: 1.0,
                    temperature_c: 20.0,
                },
            );
            for c in COMPONENTS {
                assert!(state.get(c).is_finite(), "{c:?}");
                assert!(state.get(c) >= 0.0, "{c:?}");
            }
        }
    }
}

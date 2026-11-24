//! ASM1: 13 components, 8 processes.
//!
//! Ported from the TypeScript reference `src/sim/asm1.ts`. The TypeScript
//! implementation remains the oracle until golden parity is signed off.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(usize)]
pub enum Component {
    SI = 0,
    SS = 1,
    XI = 2,
    XS = 3,
    XBH = 4,
    XBA = 5,
    XP = 6,
    SO = 7,
    SNO = 8,
    SNH = 9,
    SND = 10,
    XND = 11,
    SAlk = 12,
}

pub const COMPONENTS: [Component; 13] = [
    Component::SI,
    Component::SS,
    Component::XI,
    Component::XS,
    Component::XBH,
    Component::XBA,
    Component::XP,
    Component::SO,
    Component::SNO,
    Component::SNH,
    Component::SND,
    Component::XND,
    Component::SAlk,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Process {
    AerobicGrowthHeterotrophs = 0,
    AnoxicGrowthHeterotrophs = 1,
    AerobicGrowthAutotrophs = 2,
    DecayHeterotrophs = 3,
    DecayAutotrophs = 4,
    Ammonification = 5,
    HydrolysisOrganics = 6,
    HydrolysisOrganicN = 7,
}

pub const PROCESSES: [Process; 8] = [
    Process::AerobicGrowthHeterotrophs,
    Process::AnoxicGrowthHeterotrophs,
    Process::AerobicGrowthAutotrophs,
    Process::DecayHeterotrophs,
    Process::DecayAutotrophs,
    Process::Ammonification,
    Process::HydrolysisOrganics,
    Process::HydrolysisOrganicN,
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    pub y_h: f64,
    pub f_p: f64,
    pub y_a: f64,
    pub i_xb: f64,
    pub i_xp: f64,
    pub mu_h: f64,
    pub k_s: f64,
    pub k_o_h: f64,
    pub k_no: f64,
    pub b_h: f64,
    pub eta_g: f64,
    pub eta_h: f64,
    pub mu_a: f64,
    pub k_nh: f64,
    pub k_o_a: f64,
    pub b_a: f64,
    pub k_a: f64,
    pub k_h: f64,
    pub k_x: f64,
    pub anoxic_no3_exponent: f64,
    pub cod_per_no3_n: f64,
    pub o2_per_nh_n: f64,
    pub alk_per_n: f64,
    pub theta_mu_h: f64,
    pub theta_b_h: f64,
    pub theta_mu_a: f64,
    pub theta_b_a: f64,
    pub theta_k_h: f64,
    pub theta_k_a: f64,
    pub t_ref: f64,
    pub per_day_to_per_hour: f64,
}

pub const PARAMS: Params = Params {
    y_h: 0.67,
    f_p: 0.08,
    y_a: 0.24,
    i_xb: 0.086,
    i_xp: 0.06,
    mu_h: 6.0,
    k_s: 20.0,
    k_o_h: 0.2,
    k_no: 0.5,
    b_h: 0.62,
    eta_g: 0.8,
    eta_h: 0.4,
    mu_a: 0.8,
    k_nh: 1.0,
    k_o_a: 0.4,
    b_a: 0.15,
    k_a: 0.08,
    k_h: 3.0,
    k_x: 0.03,
    anoxic_no3_exponent: 2.0,
    cod_per_no3_n: 2.86,
    o2_per_nh_n: 4.57,
    alk_per_n: 1.0 / 14.0,
    theta_mu_h: 1.07,
    theta_b_h: 1.07,
    theta_mu_a: 1.12,
    theta_b_a: 1.12,
    theta_k_h: 1.07,
    theta_k_a: 1.07,
    t_ref: 20.0,
    per_day_to_per_hour: 1.0 / 24.0,
};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct State {
    pub s_i: f64,
    pub s_s: f64,
    pub x_i: f64,
    pub x_s: f64,
    pub x_b_h: f64,
    pub x_b_a: f64,
    pub x_p: f64,
    pub s_o: f64,
    pub s_no: f64,
    pub s_nh: f64,
    pub s_nd: f64,
    pub x_nd: f64,
    pub s_alk: f64,
}

impl State {
    pub fn new() -> Self {
        Self {
            s_alk: 7.0,
            ..Self::default()
        }
    }

    pub fn get(&self, c: Component) -> f64 {
        match c {
            Component::SI => self.s_i,
            Component::SS => self.s_s,
            Component::XI => self.x_i,
            Component::XS => self.x_s,
            Component::XBH => self.x_b_h,
            Component::XBA => self.x_b_a,
            Component::XP => self.x_p,
            Component::SO => self.s_o,
            Component::SNO => self.s_no,
            Component::SNH => self.s_nh,
            Component::SND => self.s_nd,
            Component::XND => self.x_nd,
            Component::SAlk => self.s_alk,
        }
    }

    pub fn set(&mut self, c: Component, v: f64) {
        match c {
            Component::SI => self.s_i = v,
            Component::SS => self.s_s = v,
            Component::XI => self.x_i = v,
            Component::XS => self.x_s = v,
            Component::XBH => self.x_b_h = v,
            Component::XBA => self.x_b_a = v,
            Component::XP => self.x_p = v,
            Component::SO => self.s_o = v,
            Component::SNO => self.s_no = v,
            Component::SNH => self.s_nh = v,
            Component::SND => self.s_nd = v,
            Component::XND => self.x_nd = v,
            Component::SAlk => self.s_alk = v,
        }
    }

    pub fn add(&mut self, c: Component, v: f64) {
        self.set(c, self.get(c) + v);
    }

    pub fn values(&self) -> [f64; 13] {
        let mut out = [0.0; 13];
        for (i, c) in COMPONENTS.iter().enumerate() {
            out[i] = self.get(*c);
        }
        out
    }
}

/// Stoichiometric matrix, indexed by process then component.
pub fn stoichiometry(p: Params) -> [[f64; 13]; 8] {
    let mut m = [[0.0; 13]; 8];
    let ss = Component::SS as usize;
    let xs = Component::XS as usize;
    let xbh = Component::XBH as usize;
    let xba = Component::XBA as usize;
    let xp = Component::XP as usize;
    let so = Component::SO as usize;
    let sno = Component::SNO as usize;
    let snh = Component::SNH as usize;
    let snd = Component::SND as usize;
    let xnd = Component::XND as usize;
    let alk = Component::SAlk as usize;

    // 0 aerobic heterotrophs
    m[0][ss] = -1.0 / p.y_h;
    m[0][so] = -(1.0 - p.y_h) / p.y_h;
    m[0][snh] = -p.i_xb;
    m[0][alk] = -p.i_xb * p.alk_per_n;
    m[0][xbh] = 1.0;

    // 1 anoxic heterotrophs
    m[1][ss] = -1.0 / p.y_h;
    m[1][sno] = -(1.0 - p.y_h) / (p.cod_per_no3_n * p.y_h);
    m[1][snh] = -p.i_xb;
    m[1][alk] = -(p.i_xb - (1.0 - p.y_h) / (p.cod_per_no3_n * p.y_h)) * p.alk_per_n;
    m[1][xbh] = 1.0;

    // 2 aerobic autotrophs
    m[2][xba] = 1.0;
    m[2][snh] = -(1.0 / p.y_a + p.i_xb);
    m[2][sno] = 1.0 / p.y_a;
    m[2][so] = -(p.o2_per_nh_n - p.y_a) / p.y_a;
    m[2][alk] = -(2.0 / p.y_a + p.i_xb) * p.alk_per_n;

    // 3 decay heterotrophs
    m[3][xbh] = -1.0;
    m[3][xs] = 1.0 - p.f_p;
    m[3][xp] = p.f_p;
    m[3][xnd] = p.i_xb - p.f_p * p.i_xp;

    // 4 decay autotrophs
    m[4][xba] = -1.0;
    m[4][xs] = 1.0 - p.f_p;
    m[4][xp] = p.f_p;
    m[4][xnd] = p.i_xb - p.f_p * p.i_xp;

    // 5 ammonification
    m[5][snd] = -1.0;
    m[5][snh] = 1.0;
    m[5][alk] = p.alk_per_n;

    // 6 hydrolysis organics
    m[6][xs] = -1.0;
    m[6][ss] = 1.0;

    // 7 hydrolysis organic N
    m[7][xnd] = -1.0;
    m[7][snd] = 1.0;

    m
}

pub fn rates(s: &State, p: Params, temperature_c: f64) -> [f64; 8] {
    let dt = temperature_c - p.t_ref;
    let f_mu_h = p.theta_mu_h.powf(dt);
    let f_b_h = p.theta_b_h.powf(dt);
    let f_mu_a = p.theta_mu_a.powf(dt);
    let f_b_a = p.theta_b_a.powf(dt);
    let f_k_h = p.theta_k_h.powf(dt);
    let f_k_a = p.theta_k_a.powf(dt);
    let eps = 1e-6;

    let aerobic_h =
        p.mu_h * f_mu_h * (s.s_s / (p.k_s + s.s_s)) * (s.s_o / (p.k_o_h + s.s_o)) * s.x_b_h;

    let o2_inhibition = p.k_o_h / (p.k_o_h + s.s_o);
    let no3_availability = (s.s_no / (p.k_no + s.s_no)).powf(p.anoxic_no3_exponent);
    let window = o2_inhibition.min(no3_availability);
    let anoxic_h = p.mu_h * f_mu_h * p.eta_g * (s.s_s / (p.k_s + s.s_s)) * window * s.x_b_h;

    let aerobic_a =
        p.mu_a * f_mu_a * (s.s_nh / (p.k_nh + s.s_nh)) * (s.s_o / (p.k_o_a + s.s_o)) * s.x_b_a;

    let decay_h = p.b_h * f_b_h * s.x_b_h;
    let decay_a = p.b_a * f_b_a * s.x_b_a;
    let ammonification = p.k_a * f_k_a * s.s_nd * s.x_b_h;

    let ratio = s.x_s / s.x_b_h.max(eps);
    let sat = ratio / (p.k_x + ratio);
    let acceptor = s.s_o / (p.k_o_h + s.s_o)
        + p.eta_h * (p.k_o_h / (p.k_o_h + s.s_o)) * (s.s_no / (p.k_no + s.s_no));
    let hydrolysis_org = p.k_h * f_k_h * sat * acceptor * s.x_b_h;
    let nd_ratio = s.x_nd / s.x_s.max(eps);
    let hydrolysis_n = p.k_h * f_k_h * sat * acceptor * s.x_b_h * nd_ratio;

    [
        aerobic_h,
        anoxic_h,
        aerobic_a,
        decay_h,
        decay_a,
        ammonification,
        hydrolysis_org,
        hydrolysis_n,
    ]
}

/// Reaction rates including unit conversion from d⁻¹ to h⁻¹.
pub fn reaction_rates(s: &State, p: Params, temperature_c: f64) -> State {
    let m = stoichiometry(p);
    let r = rates(s, p, temperature_c);
    let mut out = State::default();
    for proc in 0..8 {
        let rho = r[proc] * p.per_day_to_per_hour;
        if !rho.is_finite() || rho <= 0.0 {
            continue;
        }
        for comp in 0..13 {
            let coef = m[proc][comp];
            if coef != 0.0 {
                out.add(COMPONENTS[comp], coef * rho);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stoichiometry_and_rates_smoke() {
        let s = State {
            s_i: 30.0,
            s_s: 80.0,
            x_i: 150.0,
            x_s: 400.0,
            x_b_h: 2500.0,
            x_b_a: 200.0,
            x_p: 100.0,
            s_o: 2.0,
            s_no: 5.0,
            s_nh: 25.0,
            s_nd: 8.0,
            x_nd: 40.0,
            s_alk: 7.0,
        };
        let r = rates(&s, PARAMS, 20.0);
        assert!(r.iter().all(|v| v.is_finite() && *v >= 0.0));
        let d = reaction_rates(&s, PARAMS, 20.0);
        assert!(d.values().iter().all(|v| v.is_finite()));
        assert!(d.s_o < 0.0);
        assert!(d.s_s < 0.0);
    }
}

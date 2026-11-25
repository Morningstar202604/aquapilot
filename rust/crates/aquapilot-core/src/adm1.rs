//! ADM1 CSTR slice (M1 parity scaffold).
//!
//! Ported from the TypeScript oracle `src/sim/adm1.ts`. This is the transparent
//! ADM1 CSTR used by the digester prototype, not a claim that the full BSM2
//! plant is ported. The public step splits any dt into <=0.05 h explicit-Euler
//! substeps; operation order is kept identical for golden comparison.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Component {
    SSu = 0,
    SAa = 1,
    SFa = 2,
    SVa = 3,
    SBu = 4,
    SPro = 5,
    SAc = 6,
    SH2 = 7,
    SCh4 = 8,
    SIC = 9,
    SIN = 10,
    SI = 11,
    Xc = 12,
    Xch = 13,
    Xpr = 14,
    Xli = 15,
    Xsu = 16,
    Xaa = 17,
    Xfa = 18,
    Xc4 = 19,
    Xpro = 20,
    Xac = 21,
    Xh2 = 22,
    XI = 23,
    GH2 = 24,
    GCh4 = 25,
    GCo2 = 26,
}

pub const COMPONENTS: [Component; 27] = [
    Component::SSu,
    Component::SAa,
    Component::SFa,
    Component::SVa,
    Component::SBu,
    Component::SPro,
    Component::SAc,
    Component::SH2,
    Component::SCh4,
    Component::SIC,
    Component::SIN,
    Component::SI,
    Component::Xc,
    Component::Xch,
    Component::Xpr,
    Component::Xli,
    Component::Xsu,
    Component::Xaa,
    Component::Xfa,
    Component::Xc4,
    Component::Xpro,
    Component::Xac,
    Component::Xh2,
    Component::XI,
    Component::GH2,
    Component::GCh4,
    Component::GCo2,
];

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct State {
    pub v: [f64; 27],
}

impl State {
    pub fn get(&self, c: Component) -> f64 {
        self.v[c as usize]
    }

    pub fn set(&mut self, c: Component, value: f64) {
        self.v[c as usize] = value;
    }

    pub fn add(&mut self, c: Component, delta: f64) {
        let current = self.v[c as usize];
        self.v[c as usize] = (current + delta).max(0.0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
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
    pub k_su: f64,
    pub k_aa: f64,
    pub k_fa: f64,
    pub k_va: f64,
    pub k_bu: f64,
    pub k_pro: f64,
    pub k_ac: f64,
    pub k_h2: f64,
    pub y_su: f64,
    pub y_aa: f64,
    pub y_fa: f64,
    pub y_c4: f64,
    pub y_pro: f64,
    pub y_ac: f64,
    pub y_h2: f64,
    pub k_dec: f64,
    pub k_la: f64,
    pub r: f64,
    pub t_k: f64,
    pub p_atm: f64,
    pub ch4_per_ac: f64,
    pub ch4_per_h2: f64,
}

pub const PARAMS: Params = Params {
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
    k_su: 0.5,
    k_aa: 0.3,
    k_fa: 0.4,
    k_va: 0.1,
    k_bu: 0.1,
    k_pro: 0.15,
    k_ac: 0.15,
    k_h2: 7e-6,
    y_su: 0.1,
    y_aa: 0.08,
    y_fa: 0.06,
    y_c4: 0.06,
    y_pro: 0.04,
    y_ac: 0.05,
    y_h2: 0.06,
    k_dec: 0.02,
    k_la: 200.0,
    r: 0.08314,
    t_k: 308.15,
    p_atm: 1.0,
    ch4_per_ac: 0.35,
    ch4_per_h2: 0.25,
};

#[derive(Debug, Clone, Copy)]
pub struct StepOptions {
    pub volume: f64,
    pub flow: f64,
    pub dt_hours: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Output {
    pub state: State,
    pub methane_rate: f64,
    pub methane_fraction: f64,
    pub ph: f64,
    pub inhibited: bool,
}

fn monod(s: f64, k: f64) -> f64 {
    let s = s.max(0.0);
    s / (k + s + 1e-12)
}

pub fn adm1_ph(state: &State) -> f64 {
    let acid = state.get(Component::SVa)
        + state.get(Component::SBu)
        + state.get(Component::SPro)
        + state.get(Component::SAc);
    let alkalinity = state.get(Component::SIC).max(0.01);
    let ph = 7.2 + (alkalinity / acid.max(0.01)).log10();
    ph.clamp(5.5, 8.5)
}

fn clamp_state(s: State) -> State {
    let mut out = s;
    for c in COMPONENTS {
        let value = out.get(c);
        out.set(
            c,
            if value.is_finite() {
                value.max(0.0)
            } else {
                0.0
            },
        );
    }
    out
}

/// Stable public step: split any dt into <= 0.05 h explicit-Euler substeps.
/// The equations and operation order are unchanged; only the step size shrinks.
pub fn step_adm1(state: &State, influent: &State, params: &Params, options: StepOptions) -> Output {
    let dt = options.dt_hours.max(1e-9);
    let substeps = ((dt / 0.05).ceil() as usize).max(1);
    let sub_dt = dt / substeps as f64;
    let mut current = *state;
    let mut out = step_adm1_once(
        &current,
        influent,
        params,
        StepOptions {
            dt_hours: sub_dt,
            ..options
        },
    );
    for _ in 1..substeps {
        current = out.state;
        out = step_adm1_once(
            &current,
            influent,
            params,
            StepOptions {
                dt_hours: sub_dt,
                ..options
            },
        );
    }
    out
}

pub fn empty_state() -> State {
    State::default()
}

/// One explicit-Euler CSTR step. The operation order mirrors TypeScript:
/// reaction increments, gas transfer, then hydraulic mixing.
fn step_adm1_once(
    state: &State,
    influent: &State,
    params: &Params,
    options: StepOptions,
) -> Output {
    let dt_d = options.dt_hours / 24.0;
    let tau = (options.volume / options.flow.max(1e-9)).max(1e-9);
    let dilution = (options.dt_hours / tau.max(1e-9)).min(1.0);
    let mut rates = [0.0f64; 11];

    rates[0] = params.k_dec * state.get(Component::Xc);
    rates[1] = params.k_hyd_ch * state.get(Component::Xch);
    rates[2] = params.k_hyd_pr * state.get(Component::Xpr);
    rates[3] = params.k_hyd_li * state.get(Component::Xli);

    let ph = adm1_ph(state);
    let ph_factor = if ph < 6.5 {
        ((ph - 5.5) / 1.0).max(0.0)
    } else {
        1.0
    };
    let h2_inhibition = 1.0 / (1.0 + state.get(Component::SH2) / params.k_h2.max(1e-9));
    rates[4] = params.k_m_su
        * monod(state.get(Component::SSu), params.k_su)
        * state.get(Component::Xsu)
        * ph_factor;
    rates[5] = params.k_m_aa
        * monod(state.get(Component::SAa), params.k_aa)
        * state.get(Component::Xaa)
        * ph_factor;
    rates[6] = params.k_m_fa
        * monod(state.get(Component::SFa), params.k_fa)
        * state.get(Component::Xfa)
        * h2_inhibition
        * ph_factor;
    rates[7] = params.k_m_c4
        * monod(
            state.get(Component::SVa) + state.get(Component::SBu),
            params.k_va,
        )
        * state.get(Component::Xc4)
        * h2_inhibition
        * ph_factor;
    rates[8] = params.k_m_pro
        * monod(state.get(Component::SPro), params.k_pro)
        * state.get(Component::Xpro)
        * h2_inhibition
        * ph_factor;
    rates[9] = params.k_m_ac
        * monod(state.get(Component::SAc), params.k_ac)
        * state.get(Component::Xac)
        * h2_inhibition
        * ph_factor;
    rates[10] = params.k_m_h2
        * monod(state.get(Component::SH2), params.k_h2)
        * state.get(Component::Xh2)
        * ph_factor;

    let mut next = *state;

    // 3) hydrolysis: particulate -> soluble substrate
    next.add(Component::Xc, -rates[0] * dt_d);
    next.add(Component::Xch, rates[0] * 0.2 * dt_d - rates[1] * dt_d);
    next.add(Component::Xpr, rates[0] * 0.2 * dt_d - rates[2] * dt_d);
    next.add(Component::Xli, rates[0] * 0.2 * dt_d - rates[3] * dt_d);
    next.add(Component::SSu, rates[1] * dt_d + rates[0] * 0.1 * dt_d);
    next.add(Component::SAa, rates[2] * dt_d + rates[0] * 0.1 * dt_d);
    next.add(Component::SFa, rates[3] * dt_d + rates[0] * 0.1 * dt_d);
    next.add(Component::SI, rates[0] * 0.1 * dt_d);

    // 4) sugars / amino acids / LCFA -> VFAs / methane + biomass
    next.add(Component::SSu, -rates[4] * dt_d);
    next.add(Component::SAa, -rates[5] * dt_d);
    next.add(Component::SFa, -rates[6] * dt_d);
    next.add(
        Component::SAc,
        (rates[4] * 0.3 + rates[5] * 0.2 + rates[6] * 0.2) * dt_d,
    );
    next.add(Component::SPro, (rates[4] * 0.2 + rates[5] * 0.3) * dt_d);
    next.add(
        Component::SH2,
        (rates[4] * 0.1 + rates[5] * 0.1 + rates[6] * 0.2) * dt_d,
    );
    next.add(Component::Xsu, rates[4] * params.y_su * dt_d);
    next.add(Component::Xaa, rates[5] * params.y_aa * dt_d);
    next.add(Component::Xfa, rates[6] * params.y_fa * dt_d);

    // 5) C4 / propionate / acetate / hydrogen methanogenesis
    next.add(Component::SVa, -rates[7] * 0.5 * dt_d);
    next.add(Component::SBu, -rates[7] * 0.5 * dt_d);
    next.add(Component::SPro, -rates[8] * dt_d);
    next.add(Component::SAc, -rates[9] * dt_d);
    next.add(Component::SH2, -rates[10] * dt_d);
    next.add(
        Component::SCh4,
        (rates[9] * params.ch4_per_ac + rates[10] * params.ch4_per_h2) * dt_d,
    );
    next.add(Component::Xc4, rates[7] * params.y_c4 * dt_d);
    next.add(Component::Xpro, rates[8] * params.y_pro * dt_d);
    next.add(Component::Xac, rates[9] * params.y_ac * dt_d);
    next.add(Component::Xh2, rates[10] * params.y_h2 * dt_d);

    // 6) decay: cells -> particulate inert (re-enters hydrolysis)
    for biomass in [
        Component::Xsu,
        Component::Xaa,
        Component::Xfa,
        Component::Xc4,
        Component::Xpro,
        Component::Xac,
        Component::Xh2,
    ] {
        let decay = params.k_dec * state.get(biomass) * dt_d;
        next.add(biomass, -decay);
        next.add(Component::Xc, decay * 0.8);
        next.add(Component::SI, decay * 0.2);
    }

    // 7) gas transfer: dissolved gas -> gas phase (simplified Henry)
    let gas_h2 = (params.k_la * state.get(Component::SH2) * dt_d * 0.01).max(0.0);
    let gas_ch4 = (params.k_la * state.get(Component::SCh4) * dt_d * 0.01).max(0.0);
    let gas_co2 = (params.k_la * state.get(Component::SIC) * dt_d * 0.005).max(0.0);
    next.add(Component::SH2, -gas_h2);
    next.add(Component::SCh4, -gas_ch4);
    next.add(Component::SIC, -gas_co2);
    next.add(Component::GH2, gas_h2);
    next.add(Component::GCh4, gas_ch4);
    next.add(Component::GCo2, gas_co2);

    // 8) hydraulic mixing after reaction / gas transfer
    for c in COMPONENTS {
        let mixed = next.get(c) + (influent.get(c) - next.get(c)) * dilution;
        next.set(
            c,
            if mixed.is_finite() {
                mixed.max(0.0)
            } else {
                0.0
            },
        );
    }

    let state_out = clamp_state(next);
    let methane_rate = (gas_ch4 / options.dt_hours.max(1e-9)).max(0.0);
    let gas_total = state_out.get(Component::GH2)
        + state_out.get(Component::GCh4)
        + state_out.get(Component::GCo2);
    Output {
        state: state_out,
        methane_rate,
        methane_fraction: if gas_total > 1e-12 {
            state_out.get(Component::GCh4) / gas_total
        } else {
            0.0
        },
        ph: adm1_ph(&state_out),
        inhibited: ph_factor < 0.9 || h2_inhibition < 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed() -> State {
        let mut s = empty_state();
        for (c, v) in [
            (Component::SSu, 20.0),
            (Component::SAa, 10.0),
            (Component::SFa, 5.0),
            (Component::SVa, 5.0),
            (Component::SBu, 5.0),
            (Component::SPro, 5.0),
            (Component::SAc, 20.0),
            (Component::SH2, 0.01),
            (Component::SCh4, 0.1),
            (Component::SIC, 100.0),
            (Component::SIN, 50.0),
            (Component::SI, 20.0),
            (Component::Xc, 100.0),
            (Component::Xch, 50.0),
            (Component::Xpr, 50.0),
            (Component::Xli, 30.0),
            (Component::Xsu, 10.0),
            (Component::Xaa, 10.0),
            (Component::Xfa, 5.0),
            (Component::Xc4, 5.0),
            (Component::Xpro, 5.0),
            (Component::Xac, 10.0),
            (Component::Xh2, 5.0),
            (Component::XI, 50.0),
        ] {
            s.set(c, v);
        }
        s
    }

    #[test]
    fn cstr_step_is_finite_and_non_negative() {
        let out = step_adm1(
            &feed(),
            &feed(),
            &PARAMS,
            StepOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 0.5,
            },
        );
        assert!(out.state.v.iter().all(|v| v.is_finite() && *v >= 0.0));
        assert!(out.methane_rate >= 0.0);
        assert!((5.5..=8.5).contains(&out.ph));
    }
}

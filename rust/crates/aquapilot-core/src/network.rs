//! Network-level ASM2d CSTR solver (M1 core).
//!
//! Scope: multi-reactor advection + ASM2d reaction + RAS particulate scaling +
//! supplemental fermentation / aerobic P uptake. It does not include Takacs,
//! aeration PI, ADM1 or plant mass balance yet; those are separate M1 modules.

use crate::asm2d::{
    COMPONENTS, Component, PROCESSES, Params, Process, State, Stoichiometry, cod_concentration,
    influent_to_asm2d, n_concentration, p_concentration, rates,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactorKind {
    Anaerobic,
    Anoxic,
    Aerobic,
}

#[derive(Debug, Clone)]
pub struct Reactor {
    pub id: String,
    pub kind: ReactorKind,
    pub volume: f64,
    pub state: State,
    pub kla: f64,
    pub integral: f64,
    pub o2_demand: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recycle {
    None,
    Ras,
    Internal,
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub from: Option<usize>,
    pub to: usize,
    pub flow: f64,
    pub recycle: Recycle,
}

#[derive(Debug, Clone)]
pub struct Network {
    pub reactors: Vec<Reactor>,
    pub edges: Vec<Edge>,
    pub order: Vec<usize>,
}

#[derive(Debug, Clone, Copy)]
pub struct Influent {
    pub flow: f64,
    pub cod: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
    pub ss: f64,
    pub alkalinity: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Flux {
    pub o2_demand_kg_h: f64,
    pub o2_hetero_kg_h: f64,
    pub o2_nitro_kg_h: f64,
    pub o2_transferred_kg_h: f64,
    pub nh_oxidized_kg_h: f64,
    pub denitrified_n_kg_h: f64,
    pub clamp_cod_kg_h: f64,
    pub clamp_n_kg_h: f64,
    pub clamp_p_kg_h: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct StepOptions {
    pub dt_h: f64,
    pub temperature_c: f64,
    pub bio_p: bool,
    pub suppression: f64,
    pub do_setpoint: f64,
    pub aeration_capacity: f64,
}

const BOUNDS: [f64; 19] = [
    10.0, 500.0, 300.0, 500.0, 120.0, 200.0, 120.0, 30.0, 200.0, 20_000.0, 20_000.0, 15_000.0,
    15_000.0, 5_000.0, 5_000.0, 15_000.0, 20_000.0, 1_000.0, 5_000.0,
];

fn substrate_proxy(s: &State) -> State {
    let mut p = *s;
    p.set(Component::SA, s.get(Component::SA) + s.get(Component::SF));
    p
}

fn clamp(c: Component, v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    v.clamp(0.0, BOUNDS[c as usize])
}

fn reaction_vector(
    s: &State,
    params: &Params,
    stoich: &Stoichiometry,
    kind: ReactorKind,
    opts: StepOptions,
) -> ([f64; 19], Flux) {
    let mut v = [0.0; 19];
    let mut flux = Flux::default();
    let mut xh_sa_uptake = 0.0;
    let proxy = substrate_proxy(s);

    for proc in PROCESSES {
        if !opts.bio_p
            && matches!(
                proc,
                Process::AerobicGrowthPAO
                    | Process::AnoxicGrowthPAO
                    | Process::StoragePHAAerobic
                    | Process::StoragePHAAnoxic
                    | Process::StoragePHAAerobic2
                    | Process::LysisPAO
                    | Process::HydrolysisPP
            )
        {
            continue;
        }
        let src = if matches!(proc, Process::AerobicGrowthXH | Process::AnoxicGrowthXH) {
            &proxy
        } else {
            s
        };
        let rate_day = rates(params, src, opts.temperature_c).r[proc as usize];
        if !rate_day.is_finite() || rate_day <= 0.0 {
            continue;
        }
        let toxic = if matches!(proc, Process::AerobicGrowthAUT | Process::AerobicGrowthPAO) {
            opts.suppression.max(0.0).powi(2)
        } else {
            opts.suppression.max(0.0).sqrt()
        };
        let rate = rate_day * toxic;
        for c in COMPONENTS {
            let k = stoich.a[proc as usize][c as usize];
            if k != 0.0 {
                v[c as usize] += k * rate;
            }
        }
        if matches!(proc, Process::AerobicGrowthXH | Process::AnoxicGrowthXH) {
            xh_sa_uptake += -stoich.a[proc as usize][Component::SA as usize] * rate;
        }
        let so = stoich.a[proc as usize][Component::SO as usize];
        if so < 0.0 {
            if matches!(proc, Process::AerobicGrowthAUT) {
                flux.o2_nitro_kg_h += -so * rate;
            } else {
                flux.o2_hetero_kg_h += -so * rate;
            }
        }
        if matches!(proc, Process::AerobicGrowthAUT) {
            flux.nh_oxidized_kg_h += -stoich.a[proc as usize][Component::SNH4 as usize] * rate;
        }
        let sno3 = stoich.a[proc as usize][Component::SNO3 as usize];
        if sno3 < 0.0 {
            flux.denitrified_n_kg_h += -sno3 * rate;
        }
    }

    // Supplemental fermentation: S_F -> S_A, N released as NH4.
    if s.get(Component::SO) < params.k_o2 {
        let ferm = params.q_fe
            * (s.get(Component::SF) / (params.k_f + s.get(Component::SF) + 1e-6))
            * (params.k_o2 / (params.k_o2 + s.get(Component::SO) + 1e-6));
        v[Component::SF as usize] -= ferm;
        v[Component::SA as usize] += ferm;
        v[Component::SNH4 as usize] += ferm * params.i_n_si;
    }

    // Supplemental aerobic P uptake.
    if kind == ReactorKind::Aerobic && opts.bio_p && s.get(Component::XPAO) > 1e-6 {
        let pha = s.get(Component::XPHA).max(0.0);
        let pha_lim =
            0.1 + 0.9 * ((pha - 0.01).max(0.0) / (params.k_pha + (pha - 0.01).max(0.0) + 1e-6));
        let po4_lim = s.get(Component::SPO4) / (params.k_p + s.get(Component::SPO4) + 1e-6);
        let uptake = params.q_pp * s.get(Component::XPAO) * pha_lim * po4_lim;
        if uptake > 1e-6 {
            v[Component::XPP as usize] += uptake;
            v[Component::XPHA as usize] -= uptake / params.y_pao;
            v[Component::SPO4 as usize] -= uptake * params.i_p_pp;
            let o2 = uptake / params.y_pao;
            v[Component::SO as usize] -= o2;
            flux.o2_hetero_kg_h += o2;
        }
    }

    // S_F share of XH uptake: keep C and N conserved.
    if xh_sa_uptake > 1e-6 {
        let total = s.get(Component::SA) + s.get(Component::SF);
        let sf_fraction = if total > 1e-6 {
            s.get(Component::SF) / total
        } else {
            0.5
        };
        let shift = xh_sa_uptake * sf_fraction;
        v[Component::SA as usize] += shift;
        v[Component::SF as usize] -= shift;
        v[Component::SNH4 as usize] += shift * params.i_n_si;
    }

    flux.o2_demand_kg_h = flux.o2_hetero_kg_h + flux.o2_nitro_kg_h;
    (v, flux)
}

impl Network {
    pub fn new(reactors: Vec<Reactor>, edges: Vec<Edge>) -> Self {
        let order = (0..reactors.len()).collect();
        Self {
            reactors,
            edges,
            order,
        }
    }

    pub fn step(
        &mut self,
        influent: Influent,
        x_ras: f64,
        params: &Params,
        opts: StepOptions,
    ) -> Flux {
        let stoich = Stoichiometry::new(params);
        let sub_h: f64 = (1.0f64 / 120.0).min(opts.dt_h);
        let n_sub = ((opts.dt_h / sub_h).ceil() as usize).clamp(1, 120);
        let sub_dt = opts.dt_h / n_sub as f64;
        let sub_days = sub_dt / 24.0;
        let mut total_mass = Flux::default();

        let last_state = self
            .reactors
            .last()
            .map(|r| r.state)
            .unwrap_or_else(State::zero);
        let feed_particulate = [
            Component::XI,
            Component::XS,
            Component::XH,
            Component::XPAO,
            Component::XAUT,
            Component::XPP,
            Component::XPHA,
            Component::XMEP,
        ]
        .iter()
        .map(|c| last_state.get(*c))
        .sum::<f64>();
        let ras_ratio = if feed_particulate > 1.0 {
            ((x_ras * crate::asm2d::COD_PER_VSS) / feed_particulate).clamp(2.15, 6.0)
        } else {
            2.15
        };

        for idx in self.order.clone() {
            let mut q_in = 0.0;
            let mut asm_in = State::zero();
            for e in self.edges.iter().filter(|e| e.to == idx) {
                let flow = e.flow.max(0.0);
                if flow <= 0.0 {
                    continue;
                }
                let mut src = match (e.recycle, e.from) {
                    (Recycle::Ras, _) => {
                        let mut s = last_state;
                        for c in [
                            Component::XI,
                            Component::XS,
                            Component::XH,
                            Component::XPAO,
                            Component::XAUT,
                            Component::XPP,
                            Component::XPHA,
                            Component::XMEP,
                        ] {
                            s.set(c, s.get(c) * ras_ratio);
                        }
                        s.set(Component::SNO3, 0.0);
                        s.set(Component::SO, 0.0);
                        s
                    }
                    (Recycle::Internal, _) => last_state,
                    (_, Some(from)) => self.reactors[from].state,
                    (_, None) => influent_to_asm2d(
                        influent.cod,
                        if influent.tn > 0.0 {
                            influent.tn
                        } else {
                            influent.nh
                        },
                        0.0,
                        influent.tp,
                        influent.alkalinity,
                    ),
                };
                if src.get(Component::SO) > 10.0 {
                    src.set(Component::SO, 10.0);
                }
                if q_in <= 0.0 {
                    asm_in = src;
                } else {
                    for c in COMPONENTS {
                        asm_in.set(
                            c,
                            (asm_in.get(c) * q_in + src.get(c) * flow) / (q_in + flow),
                        );
                    }
                }
                q_in += flow;
            }

            if q_in <= 0.0 {
                continue;
            }

            let reactor = &mut self.reactors[idx];
            let q_over_v = q_in / reactor.volume.max(1e-9);
            let mut o2_hetero_mass = 0.0;
            let mut o2_nitro_mass = 0.0;
            let mut nh_mass = 0.0;
            let mut no3_mass = 0.0;
            let mut clamp_cod_mass = 0.0;
            let mut clamp_n_mass = 0.0;
            let mut clamp_p_mass = 0.0;

            for _ in 0..n_sub {
                if reactor.kind == ReactorKind::Aerobic && opts.aeration_capacity > 0.02 {
                    reactor.state.set(Component::SO, opts.do_setpoint);
                }
                let (vector, local_flux) =
                    reaction_vector(&reactor.state, params, &stoich, reactor.kind, opts);
                let mut next = State::zero();
                for c in COMPONENTS {
                    let advect = q_over_v * sub_dt * (asm_in.get(c) - reactor.state.get(c));
                    let react = vector[c as usize] * sub_days;
                    let mut value = clamp(c, reactor.state.get(c) + advect + react);
                    if opts.bio_p && c == Component::XPHA {
                        value = value.max(0.05);
                    }
                    if opts.bio_p && c == Component::XPP {
                        value = value.max(0.1);
                    }
                    let raw = reactor.state.get(c) + advect + react;
                    let loss = raw - value;
                    if loss < -1e-12 {
                        let lost = -loss;
                        let n_weight = match c {
                            Component::SNH4 | Component::SNO3 | Component::SN2 => 1.0,
                            Component::SF => params.i_n_si,
                            Component::XS | Component::XI => params.i_n_xs,
                            Component::XH | Component::XPAO | Component::XAUT => params.i_n_bm,
                            _ => 0.0,
                        };
                        let p_weight = match c {
                            Component::SPO4 | Component::XMEP => 1.0,
                            Component::XPP => params.i_p_pp,
                            Component::XS | Component::XI => params.i_p_xs,
                            Component::XH | Component::XPAO | Component::XAUT => params.i_p_bm,
                            _ => 0.0,
                        };
                        if n_weight > 0.0 {
                            clamp_n_mass += lost * n_weight * reactor.volume * sub_days / 1000.0;
                        }
                        if p_weight > 0.0 {
                            clamp_p_mass += lost * p_weight * reactor.volume * sub_days / 1000.0;
                        }
                        if matches!(
                            c,
                            Component::SI
                                | Component::SF
                                | Component::SA
                                | Component::XI
                                | Component::XS
                                | Component::XH
                                | Component::XPAO
                                | Component::XAUT
                                | Component::XPHA
                        ) {
                            clamp_cod_mass += lost * reactor.volume * sub_days / 1000.0;
                        }
                    }
                    next.set(c, value);
                }
                reactor.state = next;
                o2_hetero_mass += local_flux.o2_hetero_kg_h * reactor.volume * sub_days / 1000.0;
                o2_nitro_mass += local_flux.o2_nitro_kg_h * reactor.volume * sub_days / 1000.0;
                nh_mass += local_flux.nh_oxidized_kg_h * reactor.volume * sub_days / 1000.0;
                no3_mass += local_flux.denitrified_n_kg_h * reactor.volume * sub_days / 1000.0;
            }

            let our_h = ((o2_hetero_mass + o2_nitro_mass) * 1000.0)
                / reactor.volume.max(1e-9)
                / opts.dt_h.max(1e-9);
            let aeration = if reactor.kind == ReactorKind::Aerobic && opts.aeration_capacity > 0.02
            {
                let a = crate::aeration::step_aeration(crate::aeration::AerationInput {
                    volume: reactor.volume,
                    temperature_c: opts.temperature_c,
                    do_level: reactor.state.get(Component::SO),
                    o2_demand: our_h.max(0.0),
                    do_setpoint: opts.do_setpoint,
                    capacity: opts.aeration_capacity,
                    previous_kla: reactor.kla,
                    previous_integral: reactor.integral,
                    dt_h: opts.dt_h,
                });
                reactor.kla = a.kla;
                reactor.integral = a.integral;
                reactor.state.set(Component::SO, a.do_level);
                Some(a)
            } else {
                reactor.kla = 0.0;
                reactor.integral = 0.0;
                reactor.state.set(
                    Component::SO,
                    (reactor.state.get(Component::SO) - opts.dt_h * 0.5).max(0.02),
                );
                None
            };
            reactor.o2_demand = our_h.max(0.0);

            total_mass.o2_hetero_kg_h += o2_hetero_mass;
            total_mass.o2_nitro_kg_h += o2_nitro_mass;
            total_mass.nh_oxidized_kg_h += nh_mass;
            total_mass.denitrified_n_kg_h += no3_mass;
            total_mass.clamp_cod_kg_h += clamp_cod_mass;
            total_mass.clamp_n_kg_h += clamp_n_mass;
            total_mass.clamp_p_kg_h += clamp_p_mass;
            if let Some(a) = aeration {
                total_mass.o2_transferred_kg_h += a.o2_transferred_kg_h / opts.dt_h.max(1e-9);
            }
        }

        let dt = opts.dt_h.max(1e-9);
        total_mass.o2_hetero_kg_h /= dt;
        total_mass.o2_nitro_kg_h /= dt;
        total_mass.nh_oxidized_kg_h /= dt;
        total_mass.denitrified_n_kg_h /= dt;
        total_mass.clamp_cod_kg_h /= dt;
        total_mass.clamp_n_kg_h /= dt;
        total_mass.clamp_p_kg_h /= dt;
        total_mass.o2_demand_kg_h = total_mass.o2_hetero_kg_h + total_mass.o2_nitro_kg_h;
        total_mass
    }
}

pub fn effluent(net: &Network, params: &Params) -> (f64, f64, f64) {
    let s = net
        .reactors
        .last()
        .map(|r| r.state)
        .unwrap_or_else(State::zero);
    (
        cod_concentration(&s),
        n_concentration(&s, params),
        p_concentration(&s, params),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn five_tank() -> Network {
        let reactors = vec![
            Reactor {
                id: "anaerobic".into(),
                kind: ReactorKind::Anaerobic,
                volume: 3000.0,
                state: State::zero(),
                kla: 0.0,
                integral: 0.0,
                o2_demand: 0.0,
            },
            Reactor {
                id: "anoxic".into(),
                kind: ReactorKind::Anoxic,
                volume: 4500.0,
                state: State::zero(),
                kla: 0.0,
                integral: 0.0,
                o2_demand: 0.0,
            },
            Reactor {
                id: "aerobic1".into(),
                kind: ReactorKind::Aerobic,
                volume: 5750.0,
                state: State::zero(),
                kla: 0.0,
                integral: 0.0,
                o2_demand: 0.0,
            },
            Reactor {
                id: "aerobic2".into(),
                kind: ReactorKind::Aerobic,
                volume: 5750.0,
                state: State::zero(),
                kla: 0.0,
                integral: 0.0,
                o2_demand: 0.0,
            },
            Reactor {
                id: "aerobic3".into(),
                kind: ReactorKind::Aerobic,
                volume: 5750.0,
                state: State::zero(),
                kla: 0.0,
                integral: 0.0,
                o2_demand: 0.0,
            },
        ];
        let edges = vec![
            Edge {
                from: None,
                to: 0,
                flow: 1546.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(0),
                to: 1,
                flow: 1546.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(1),
                to: 2,
                flow: 1546.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(2),
                to: 3,
                flow: 1546.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(3),
                to: 4,
                flow: 1546.0,
                recycle: Recycle::None,
            },
        ];
        Network::new(reactors, edges)
    }

    #[test]
    fn network_produces_finite_nonnegative_effluent() {
        let mut net = five_tank();
        let params = Params::default();
        let inf = Influent {
            flow: 1546.0,
            cod: 312.0,
            nh: 31.5,
            tn: 44.0,
            tp: 4.6,
            ss: 184.0,
            alkalinity: 8.0,
        };
        for _ in 0..48 {
            net.step(
                inf,
                4428.0,
                &params,
                StepOptions {
                    dt_h: 0.5,
                    temperature_c: 20.0,
                    bio_p: true,
                    suppression: 1.0,
                    do_setpoint: 2.0,
                    aeration_capacity: 0.976,
                },
            );
        }
        let (cod, n, p) = effluent(&net, &params);
        assert!(cod.is_finite() && n.is_finite() && p.is_finite());
        assert!(cod >= 0.0 && n >= 0.0 && p >= 0.0);
        assert!(
            net.reactors
                .iter()
                .all(|r| r.state.v.iter().all(|v| v.is_finite() && *v >= 0.0))
        );
    }
}

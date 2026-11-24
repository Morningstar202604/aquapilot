//! ASM1 CSTR and small network slice (M1 parity scaffold).
//!
//! The TypeScript oracle lives in `src/sim/asm1Network.ts`. This module is a
//! deliberately narrow control volume: advection + ASM1 reaction + optional
//! RAS thickening. It does not claim Takács, aeration control or ADM1 parity.

use crate::asm1::{COMPONENTS, Component, Params, State, reaction_rates};

pub const COD_PER_VSS: f64 = 1.42;

pub const PARTICULATE: [Component; 6] = [
    Component::XI,
    Component::XS,
    Component::XBH,
    Component::XBA,
    Component::XP,
    Component::XND,
];

#[derive(Debug, Clone)]
pub struct Reactor {
    pub id: String,
    pub volume: f64,
    pub state: State,
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

#[derive(Debug, Clone, Copy)]
pub struct CstrOptions {
    pub volume: f64,
    pub flow: f64,
    pub dt_hours: f64,
    pub temperature_c: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct NetworkOptions {
    pub dt_hours: f64,
    pub temperature_c: f64,
    pub x_ras: f64,
}

fn clamp_state(s: &State) -> State {
    let mut out = *s;
    for c in COMPONENTS {
        let v = out.get(c);
        out.set(c, if v.is_finite() { v.max(0.0) } else { 0.0 });
    }
    out
}

fn particulate(s: &State) -> f64 {
    PARTICULATE
        .iter()
        .map(|c| s.get(*c).max(0.0))
        .sum::<f64>()
        .max(1.0)
}

/// One completely mixed tank with constant-volume feed and outflow.
pub fn step_cstr(state: &State, influent: &State, params: &Params, opts: CstrOptions) -> State {
    let dt = opts.dt_hours.max(0.0);
    let dilution = (opts.flow.max(0.0) * dt / opts.volume.max(1e-9)).clamp(0.0, 1.0);
    let reaction = reaction_rates(state, *params, opts.temperature_c);
    let mut next = *state;
    for c in COMPONENTS {
        next.set(
            c,
            state.get(c) + (influent.get(c) - state.get(c)) * dilution + reaction.get(c) * dt,
        );
    }
    clamp_state(&next)
}

/// Ordered multi-reactor slice. `from: None` is the external feed; only
/// `Recycle::Ras` is thickened. `x_ras` is an input, not a settler output.
pub fn step_network(
    reactors: &mut [Reactor],
    edges: &[Edge],
    influent: &State,
    params: &Params,
    opts: NetworkOptions,
) {
    let dt = opts.dt_hours.max(0.0);
    let sub_h = (1.0f64 / 120.0).min(dt);
    let n_sub = ((dt / sub_h.max(1e-9)).ceil() as usize).max(1);
    let sub_dt = dt / n_sub as f64;
    let last_state = reactors.last().map(|r| r.state).unwrap_or_default();
    let feed_particulate = particulate(&last_state);
    let ras_ratio = if opts.x_ras > 0.0 {
        ((opts.x_ras * COD_PER_VSS) / feed_particulate).clamp(2.15, 6.0)
    } else {
        2.15
    };

    for idx in 0..reactors.len() {
        let mut q_in = 0.0;
        let mut asm_in: Option<State> = None;
        for edge in edges.iter().filter(|e| e.to == idx) {
            let flow = edge.flow.max(0.0);
            if flow <= 0.0 {
                continue;
            }
            let mut src = match (edge.recycle, edge.from) {
                (Recycle::Ras, _) => {
                    let mut s = last_state;
                    for c in PARTICULATE {
                        s.set(c, s.get(c) * ras_ratio);
                    }
                    s.set(Component::SO, 0.0);
                    s.set(Component::SNO, 0.0);
                    s
                }
                (Recycle::Internal, _) => last_state,
                (_, Some(from)) => reactors[from].state,
                (_, None) => *influent,
            };
            if src.get(Component::SO) > 10.0 {
                src.set(Component::SO, 10.0);
            }
            if let Some(current) = asm_in.as_mut() {
                for c in COMPONENTS {
                    current.set(
                        c,
                        (current.get(c) * q_in + src.get(c) * flow) / (q_in + flow),
                    );
                }
            } else {
                asm_in = Some(src);
            }
            q_in += flow;
        }

        let Some(asm_in) = asm_in else { continue };
        if q_in <= 0.0 {
            continue;
        }
        let q_over_v = q_in / reactors[idx].volume.max(1e-9);
        for _ in 0..n_sub {
            let reaction = reaction_rates(&reactors[idx].state, *params, opts.temperature_c);
            let mut next = reactors[idx].state;
            for c in COMPONENTS {
                next.set(
                    c,
                    reactors[idx].state.get(c)
                        + q_over_v * sub_dt * (asm_in.get(c) - reactors[idx].state.get(c))
                        + reaction.get(c) * sub_dt,
                );
            }
            reactors[idx].state = clamp_state(&next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm1::PARAMS;

    fn feed() -> State {
        State {
            s_i: 30.0,
            s_s: 80.0,
            x_i: 150.0,
            x_s: 250.0,
            x_b_h: 120.0,
            x_b_a: 20.0,
            x_p: 40.0,
            s_o: 2.0,
            s_no: 0.5,
            s_nh: 28.0,
            s_nd: 5.0,
            x_nd: 12.0,
            s_alk: 8.0,
        }
    }

    #[test]
    fn cstr_smoke_is_finite_and_non_negative() {
        let mut state = feed();
        state.s_o = 0.0;
        let next = step_cstr(
            &state,
            &feed(),
            &PARAMS,
            CstrOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 1.0,
                temperature_c: 20.0,
            },
        );
        assert!(next.values().iter().all(|v| v.is_finite() && *v >= 0.0));
        assert!(next.s_s < state.s_s);
        assert!(next.s_o >= 0.0);
    }

    #[test]
    fn network_smoke_runs_five_tanks() {
        let mut reactors = vec![
            Reactor {
                id: "anaerobic".into(),
                volume: 3000.0,
                state: feed(),
            },
            Reactor {
                id: "anoxic".into(),
                volume: 4500.0,
                state: feed(),
            },
            Reactor {
                id: "aerobic1".into(),
                volume: 5750.0,
                state: feed(),
            },
            Reactor {
                id: "aerobic2".into(),
                volume: 5750.0,
                state: feed(),
            },
            Reactor {
                id: "aerobic3".into(),
                volume: 5750.0,
                state: feed(),
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
                from: Some(4),
                to: 0,
                flow: 454.0,
                recycle: Recycle::Ras,
            },
            Edge {
                from: Some(0),
                to: 1,
                flow: 2000.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(1),
                to: 2,
                flow: 2000.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(2),
                to: 3,
                flow: 2000.0,
                recycle: Recycle::None,
            },
            Edge {
                from: Some(3),
                to: 4,
                flow: 2000.0,
                recycle: Recycle::None,
            },
        ];
        for _ in 0..48 {
            step_network(
                &mut reactors,
                &edges,
                &feed(),
                &PARAMS,
                NetworkOptions {
                    dt_hours: 0.5,
                    temperature_c: 20.0,
                    x_ras: 4500.0,
                },
            );
        }
        assert!(
            reactors
                .iter()
                .all(|r| r.state.values().iter().all(|v| v.is_finite() && *v >= 0.0))
        );
    }
}

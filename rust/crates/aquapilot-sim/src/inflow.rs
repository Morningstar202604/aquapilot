//! M1b phase 2, first slice: flow-weighted reactor inflow composition.
//!
//! Ports `aggregateInflow` from `networkEngine.ts`. This is the simple-model
//! aggregate view; the full 13-component ASM1 mixing and reactor integration
//! remain in `solveReactors`.

use std::collections::HashMap;

use serde::Deserialize;

use crate::forcing::mixed;
use crate::influent::Influent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecycleKind {
    Ras,
    Internal,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingEdge {
    pub id: String,
    pub from: String,
    #[serde(default)]
    pub recycle_kind: Option<RecycleKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactorComposition {
    pub cod: f64,
    pub nh: f64,
    pub no3: f64,
    pub tp: f64,
    pub alkalinity: f64,
}

impl Default for ReactorComposition {
    fn default() -> Self {
        Self {
            cod: 20.0,
            nh: 1.0,
            no3: 8.0,
            tp: 0.2,
            alkalinity: 180.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InflowComposition {
    pub q_in: f64,
    pub cod_in: f64,
    pub nh_in: f64,
    pub no3_in: f64,
    pub tp_in: f64,
    pub alk_in: f64,
}

/// Mix all incoming streams by flow, preserving edge order.
pub fn aggregate_inflow(
    incoming: &[IncomingEdge],
    edge_flow: &HashMap<String, f64>,
    by_id: &HashMap<String, ReactorComposition>,
    last_reactor: Option<&ReactorComposition>,
    influent: &Influent,
) -> InflowComposition {
    let last = last_reactor.copied().unwrap_or_default();
    let mut out = InflowComposition {
        q_in: 0.0,
        cod_in: 0.0,
        nh_in: 0.0,
        no3_in: 0.0,
        tp_in: 0.0,
        alk_in: 0.0,
    };

    for edge in incoming {
        let flow = edge_flow.get(&edge.id).copied().unwrap_or(0.0);
        if flow <= 0.0 {
            continue;
        }
        let source = by_id.get(&edge.from);
        let c = if matches!(
            edge.recycle_kind,
            Some(RecycleKind::Ras | RecycleKind::Internal)
        ) {
            last
        } else if let Some(source) = source {
            *source
        } else {
            ReactorComposition {
                cod: influent.cod,
                nh: influent.nh,
                no3: 0.3,
                tp: influent.tp,
                alkalinity: influent.alkalinity,
            }
        };

        out.cod_in = if out.q_in == 0.0 {
            c.cod
        } else {
            mixed(out.cod_in, out.q_in, c.cod, flow)
        };
        out.nh_in = if out.q_in == 0.0 {
            c.nh
        } else {
            mixed(out.nh_in, out.q_in, c.nh, flow)
        };
        out.no3_in = if out.q_in == 0.0 {
            c.no3
        } else {
            mixed(out.no3_in, out.q_in, c.no3, flow)
        };
        out.tp_in = if out.q_in == 0.0 {
            c.tp
        } else {
            mixed(out.tp_in, out.q_in, c.tp, flow)
        };
        out.alk_in = if out.q_in == 0.0 {
            c.alkalinity
        } else {
            mixed(out.alk_in, out.q_in, c.alkalinity, flow)
        };
        out.q_in += flow;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(id: &str, from: &str, kind: Option<RecycleKind>) -> IncomingEdge {
        IncomingEdge {
            id: id.to_string(),
            from: from.to_string(),
            recycle_kind: kind,
        }
    }

    #[test]
    fn external_feed_uses_influent_and_background_nitrate() {
        let mut flows = HashMap::new();
        flows.insert("e1".to_string(), 1000.0);
        let out = aggregate_inflow(
            &[edge("e1", "plant", None)],
            &flows,
            &HashMap::new(),
            None,
            &Influent {
                cod: 400.0,
                nh: 35.0,
                tp: 4.8,
                alkalinity: 320.0,
                ..Influent::default()
            },
        );
        assert_eq!(out.q_in, 1000.0);
        assert_eq!(out.cod_in, 400.0);
        assert_eq!(out.no3_in, 0.3);
    }

    #[test]
    fn two_reactors_mix_by_flow() {
        let mut flows = HashMap::new();
        flows.insert("e1".to_string(), 300.0);
        flows.insert("e2".to_string(), 700.0);
        let mut reactors = HashMap::new();
        reactors.insert(
            "a".to_string(),
            ReactorComposition {
                cod: 100.0,
                ..ReactorComposition::default()
            },
        );
        reactors.insert(
            "b".to_string(),
            ReactorComposition {
                cod: 300.0,
                ..ReactorComposition::default()
            },
        );
        let out = aggregate_inflow(
            &[edge("e1", "a", None), edge("e2", "b", None)],
            &flows,
            &reactors,
            None,
            &Influent::default(),
        );
        assert_eq!(out.q_in, 1000.0);
        assert_eq!(out.cod_in, 240.0);
    }

    #[test]
    fn ras_uses_terminal_reactor_not_source() {
        let mut flows = HashMap::new();
        flows.insert("ras".to_string(), 800.0);
        let mut reactors = HashMap::new();
        reactors.insert(
            "first".to_string(),
            ReactorComposition {
                cod: 10.0,
                ..ReactorComposition::default()
            },
        );
        let last = ReactorComposition {
            cod: 900.0,
            ..ReactorComposition::default()
        };
        let out = aggregate_inflow(
            &[edge("ras", "first", Some(RecycleKind::Ras))],
            &flows,
            &reactors,
            Some(&last),
            &Influent::default(),
        );
        assert_eq!(out.q_in, 800.0);
        assert_eq!(out.cod_in, 900.0);
    }
}

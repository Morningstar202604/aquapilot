use std::collections::BTreeMap;

use aquapilot_domain::{PlantTopology, ReactorKind, RecycleKind, SettlerParams, UnitId, UnitKind};
use aquapilot_model::Asm1State;

use crate::error::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InflowSource {
    Influent,
    Reactor(usize),
    ClarifierUnderflow(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    pub source: InflowSource,
    pub flow_m3_h: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledReactor {
    pub id: UnitId,
    pub name: String,
    pub kind: ReactorKind,
    pub volume_m3: f64,
    pub kla_h: f64,
    pub do_setpoint: f64,
    pub temperature_c: f64,
    pub initial: Asm1State,
    pub incoming: Vec<Incoming>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledClarifier {
    pub id: UnitId,
    pub name: String,
    pub area_m2: f64,
    pub depth_m: f64,
    pub layers: usize,
    pub feed_layer: usize,
    pub settling: SettlerParams,
    pub feed_reactor: usize,
    pub feed_flow_m3_h: f64,
    pub overflow_flow_m3_h: f64,
    pub underflow_flow_m3_h: f64,
    pub ras_reactor: Option<usize>,
    pub ras_flow_m3_h: f64,
    pub was_flow_m3_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EffluentSource {
    Reactor { reactor: usize, flow_m3_h: f64 },
    Clarifier { clarifier: usize, flow_m3_h: f64 },
}

#[derive(Debug, Clone)]
pub struct CompiledPlant {
    pub name: String,
    pub reactors: Vec<CompiledReactor>,
    pub clarifiers: Vec<CompiledClarifier>,
    pub influent_water: Asm1State,
    pub influent_flow_m3_h: f64,
    pub effluent_source: EffluentSource,
    pub effluent_flow_m3_h: f64,
    pub was_flow_m3_h: f64,
    pub raw_water: aquapilot_domain::RawWater,
}

impl CompiledPlant {
    pub fn compile(topology: &PlantTopology) -> Result<Self, EngineError> {
        topology.validate()?;

        let influents: Vec<&aquapilot_domain::Unit> = topology
            .units
            .iter()
            .filter(|unit| unit.kind.is_influent())
            .collect();
        let effluents: Vec<&aquapilot_domain::Unit> = topology
            .units
            .iter()
            .filter(|unit| unit.kind.is_effluent())
            .collect();
        let waste_units: Vec<&aquapilot_domain::Unit> = topology
            .units
            .iter()
            .filter(|unit| unit.kind.is_waste())
            .collect();
        if influents.len() != 1 || effluents.len() != 1 || waste_units.len() > 1 {
            return Err(EngineError::MultipleBoundaryUnits);
        }

        for connection in &topology.connections {
            if connection.flow().is_none() {
                return Err(EngineError::MissingFlow(connection.id.to_string()));
            }
        }

        let order = topology.forward_order()?;
        let mut reactors = Vec::new();
        let mut reactor_index: BTreeMap<UnitId, usize> = BTreeMap::new();
        let mut clarifiers = Vec::new();
        let mut clarifier_index: BTreeMap<UnitId, usize> = BTreeMap::new();

        for unit_id in &order {
            let unit = topology
                .unit(unit_id)
                .expect("forward_order only returns known units");
            if let Some(kind) = unit.kind.reactor_kind() {
                let volume_m3 = unit.kind.volume_m3().expect("reactor kind carries volume");
                let initial = unit
                    .kind
                    .initial()
                    .expect("reactor kind carries initial state");
                let initial_state = initial.composition.map_or_else(
                    || {
                        Asm1State::from_aggregates(
                            initial.cod,
                            initial.nh4_n,
                            initial.no3_n,
                            initial.dissolved_oxygen,
                            initial.alkalinity,
                            initial.mlss,
                            initial.temperature_c,
                        )
                    },
                    Asm1State::from_values,
                );
                reactor_index.insert(unit.id.clone(), reactors.len());
                reactors.push(CompiledReactor {
                    id: unit.id.clone(),
                    name: unit.name.clone(),
                    kind,
                    volume_m3,
                    kla_h: unit.kind.kla_h(),
                    do_setpoint: unit.kind.do_setpoint(),
                    temperature_c: initial.temperature_c,
                    initial: initial_state,
                    incoming: Vec::new(),
                });
            }

            if let Some(spec) = unit.kind.clarifier_spec() {
                clarifier_index.insert(unit.id.clone(), clarifiers.len());
                clarifiers.push(CompiledClarifier {
                    id: unit.id.clone(),
                    name: unit.name.clone(),
                    area_m2: spec.area_m2,
                    depth_m: spec.depth_m,
                    layers: spec.layers,
                    feed_layer: spec.feed_layer,
                    settling: spec.settling,
                    feed_reactor: usize::MAX,
                    feed_flow_m3_h: 0.0,
                    overflow_flow_m3_h: 0.0,
                    underflow_flow_m3_h: 0.0,
                    ras_reactor: None,
                    ras_flow_m3_h: 0.0,
                    was_flow_m3_h: 0.0,
                });
            }
        }

        if reactors.is_empty() {
            return Err(EngineError::NoReactor);
        }

        // Wire reactor inflows: forward streams, internal recycle and RAS.
        for connection in &topology.connections {
            let Some(&to_index) = reactor_index.get(&connection.to) else {
                continue;
            };
            let flow = connection
                .flow()
                .ok_or_else(|| EngineError::MissingFlow(connection.id.to_string()))?;
            let source_unit = topology
                .unit(&connection.from)
                .expect("topology.validate checked references");
            let source = if source_unit.kind.is_influent() {
                if connection.recycle != RecycleKind::None {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                InflowSource::Influent
            } else if let Some(&from_index) = reactor_index.get(&connection.from) {
                if connection.recycle == RecycleKind::Ras {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                InflowSource::Reactor(from_index)
            } else if let Some(&from_index) = clarifier_index.get(&connection.from) {
                if connection.recycle != RecycleKind::Ras {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                InflowSource::ClarifierUnderflow(from_index)
            } else {
                return Err(EngineError::InvalidRecycle(connection.id.to_string()));
            };
            reactors[to_index].incoming.push(Incoming {
                source,
                flow_m3_h: flow,
            });
        }

        for reactor in &reactors {
            if reactor.incoming.is_empty() {
                return Err(EngineError::DisconnectedReactor(reactor.id.to_string()));
            }
        }

        // Wire clarifier feed and outputs.
        for connection in &topology.connections {
            if let Some(&to_index) = clarifier_index.get(&connection.to) {
                let flow = connection
                    .flow()
                    .ok_or_else(|| EngineError::MissingFlow(connection.id.to_string()))?;
                if reactor_index.contains_key(&connection.from) {
                    if clarifiers[to_index].feed_reactor != usize::MAX {
                        return Err(EngineError::ClarifierFeed(
                            clarifiers[to_index].id.to_string(),
                        ));
                    }
                    if connection.recycle != RecycleKind::None {
                        return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                    }
                    clarifiers[to_index].feed_reactor = reactor_index[&connection.from];
                    clarifiers[to_index].feed_flow_m3_h = flow;
                } else {
                    return Err(EngineError::ClarifierFeed(
                        clarifiers[to_index].id.to_string(),
                    ));
                }
            }
        }

        for connection in &topology.connections {
            let Some(&from_index) = clarifier_index.get(&connection.from) else {
                continue;
            };
            let flow = connection
                .flow()
                .ok_or_else(|| EngineError::MissingFlow(connection.id.to_string()))?;
            let target_unit = topology
                .unit(&connection.to)
                .expect("topology.validate checked references");

            if target_unit.kind.is_effluent() {
                if connection.recycle != RecycleKind::None {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                clarifiers[from_index].overflow_flow_m3_h += flow;
            } else if target_unit.kind.is_waste() {
                if connection.recycle != RecycleKind::Was && connection.recycle != RecycleKind::None
                {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                clarifiers[from_index].was_flow_m3_h += flow;
            } else if let Some(&to_reactor) = reactor_index.get(&connection.to) {
                if connection.recycle != RecycleKind::Ras {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                if clarifiers[from_index].ras_reactor.is_some() {
                    return Err(EngineError::InvalidRecycle(connection.id.to_string()));
                }
                clarifiers[from_index].ras_reactor = Some(to_reactor);
                clarifiers[from_index].ras_flow_m3_h += flow;
            } else {
                return Err(EngineError::ClarifierRoute(
                    clarifiers[from_index].id.to_string(),
                ));
            }
        }

        for clarifier in &mut clarifiers {
            if clarifier.feed_reactor == usize::MAX {
                return Err(EngineError::ClarifierFeed(clarifier.id.to_string()));
            }
            if clarifier.overflow_flow_m3_h <= 0.0 {
                return Err(EngineError::ClarifierRoute(clarifier.id.to_string()));
            }
            clarifier.underflow_flow_m3_h = clarifier.ras_flow_m3_h + clarifier.was_flow_m3_h;
            if clarifier.underflow_flow_m3_h <= 0.0 {
                return Err(EngineError::ClarifierRoute(clarifier.id.to_string()));
            }
            let imbalance = (clarifier.feed_flow_m3_h
                - clarifier.overflow_flow_m3_h
                - clarifier.underflow_flow_m3_h)
                .abs();
            if imbalance > 1e-6 * clarifier.feed_flow_m3_h.max(1.0) {
                return Err(EngineError::ClarifierFlow {
                    unit: clarifier.id.to_string(),
                    feed: clarifier.feed_flow_m3_h,
                    overflow: clarifier.overflow_flow_m3_h,
                    underflow: clarifier.underflow_flow_m3_h,
                });
            }
        }

        let influent = influents[0];
        let (influent_flow_m3_h, raw_water, influent_composition) = match &influent.kind {
            UnitKind::Influent {
                flow_m3_h,
                water,
                composition,
            } => (*flow_m3_h, water.clone(), *composition),
            _ => unreachable!("influent filter guarantees kind"),
        };
        let influent_water = influent_composition.map_or_else(
            || {
                Asm1State::from_raw_water(
                    raw_water.cod,
                    raw_water.nh4_n,
                    raw_water.no3_n,
                    raw_water.dissolved_oxygen,
                    raw_water.alkalinity,
                )
            },
            Asm1State::from_values,
        );

        let effluent = effluents[0];
        let effluent_edges: Vec<_> = topology
            .connections
            .iter()
            .filter(|connection| connection.to == effluent.id)
            .collect();
        if effluent_edges.len() != 1 {
            return Err(EngineError::NoEffluentStream(effluent.id.to_string()));
        }
        let edge = effluent_edges[0];
        let effluent_source = if let Some(&clarifier) = clarifier_index.get(&edge.from) {
            if edge.recycle != RecycleKind::None {
                return Err(EngineError::InvalidRecycle(edge.id.to_string()));
            }
            EffluentSource::Clarifier {
                clarifier,
                flow_m3_h: edge
                    .flow()
                    .ok_or_else(|| EngineError::MissingFlow(edge.id.to_string()))?,
            }
        } else if let Some(&reactor) = reactor_index.get(&edge.from) {
            if edge.recycle != RecycleKind::None {
                return Err(EngineError::InvalidRecycle(edge.id.to_string()));
            }
            EffluentSource::Reactor {
                reactor,
                flow_m3_h: edge
                    .flow()
                    .ok_or_else(|| EngineError::MissingFlow(edge.id.to_string()))?,
            }
        } else {
            return Err(EngineError::Unsupported(format!(
                "effluent {} can only receive reactor or clarifier flow, not {}",
                effluent.id, edge.from
            )));
        };

        let effluent_flow_m3_h = match effluent_source {
            EffluentSource::Reactor { flow_m3_h, .. } => flow_m3_h,
            EffluentSource::Clarifier { flow_m3_h, .. } => flow_m3_h,
        };
        let was_flow_m3_h: f64 = topology
            .connections
            .iter()
            .filter(|connection| {
                topology
                    .unit(&connection.to)
                    .is_some_and(|unit| unit.kind.is_waste())
            })
            .map(|connection| connection.flow().unwrap_or(0.0))
            .sum();

        check_flow_balance(topology, influent_flow_m3_h)?;

        if (effluent_flow_m3_h + was_flow_m3_h - influent_flow_m3_h).abs()
            > 1e-6 * influent_flow_m3_h.max(1.0)
        {
            return Err(EngineError::GlobalFlow {
                influent: influent_flow_m3_h,
                effluent: effluent_flow_m3_h,
                was: was_flow_m3_h,
            });
        }

        Ok(Self {
            name: topology.name.clone(),
            reactors,
            clarifiers,
            influent_water,
            influent_flow_m3_h,
            effluent_source,
            effluent_flow_m3_h,
            was_flow_m3_h,
            raw_water,
        })
    }
}

fn check_flow_balance(topology: &PlantTopology, influent_flow: f64) -> Result<(), EngineError> {
    for unit in &topology.units {
        let incoming: f64 = topology
            .connections
            .iter()
            .filter(|connection| connection.to == unit.id)
            .map(|connection| connection.flow().unwrap_or(0.0))
            .sum();
        let outgoing: f64 = topology
            .connections
            .iter()
            .filter(|connection| connection.from == unit.id)
            .map(|connection| connection.flow().unwrap_or(0.0))
            .sum();

        let imbalance = if unit.kind.is_influent() {
            (outgoing - influent_flow).abs()
        } else if unit.kind.is_reactor() || unit.kind.is_clarifier() {
            (incoming - outgoing).abs()
        } else {
            0.0
        };

        if !outgoing.is_finite() || !incoming.is_finite() || imbalance > 1e-6 {
            return Err(EngineError::FlowImbalance {
                unit: unit.id.to_string(),
                incoming,
                outgoing,
            });
        }
    }
    Ok(())
}

/// Re-exported for tests and future unit types.
pub fn is_recycle(kind: RecycleKind) -> bool {
    !kind.is_none()
}

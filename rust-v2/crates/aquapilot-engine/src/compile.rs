use std::collections::BTreeMap;

use aquapilot_domain::{PlantTopology, ReactorKind, RecycleKind, UnitId, UnitKind};
use aquapilot_model::Asm1State;

use crate::error::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InflowSource {
    Influent,
    Reactor(usize),
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
    pub temperature_c: f64,
    pub initial: Asm1State,
    pub incoming: Vec<Incoming>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffluentSource {
    pub reactor: usize,
    pub flow_m3_h: f64,
}

#[derive(Debug, Clone)]
pub struct CompiledPlant {
    pub name: String,
    pub reactors: Vec<CompiledReactor>,
    pub influent_water: Asm1State,
    pub influent_flow_m3_h: f64,
    pub effluent_sources: Vec<EffluentSource>,
    pub effluent_flow_m3_h: f64,
    /// Raw influent characterization retained for reports and snapshots.
    pub raw_water: aquapilot_domain::RawWater,
}

impl CompiledPlant {
    pub fn compile(topology: &PlantTopology) -> Result<Self, EngineError> {
        topology.validate()?;

        if topology
            .units
            .iter()
            .any(|unit| matches!(unit.kind, UnitKind::Clarifier { .. }))
        {
            return Err(EngineError::Unsupported(
                "clarifier is a V2-1 unit operation; V2-0 supports reactors only".to_owned(),
            ));
        }
        if topology
            .connections
            .iter()
            .any(|connection| !connection.recycle.is_none())
        {
            return Err(EngineError::Unsupported(
                "recycle streams are resolved by the V2-1 mixer; V2-0 is forward-only".to_owned(),
            ));
        }

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
        if influents.len() != 1 || effluents.len() != 1 {
            return Err(EngineError::MultipleBoundaryUnits);
        }

        for connection in &topology.connections {
            if connection.flow().is_none() {
                return Err(EngineError::MissingFlow(connection.id.to_string()));
            }
        }

        check_flow_balance(topology)?;

        let influent = influents[0];
        let (influent_flow_m3_h, raw_water) = match &influent.kind {
            UnitKind::Influent { flow_m3_h, water } => (*flow_m3_h, water.clone()),
            _ => unreachable!("influent filter guarantees kind"),
        };
        let influent_water = Asm1State::from_raw_water(
            raw_water.cod,
            raw_water.nh4_n,
            raw_water.no3_n,
            raw_water.dissolved_oxygen,
            raw_water.alkalinity,
        );

        let order = topology.forward_order()?;
        let mut reactors = Vec::new();
        let mut reactor_index: BTreeMap<UnitId, usize> = BTreeMap::new();

        for unit_id in order {
            let unit = topology
                .unit(&unit_id)
                .expect("forward_order only returns known units");
            let Some(kind) = unit.kind.reactor_kind() else {
                continue;
            };
            let volume_m3 = unit.kind.volume_m3().expect("reactor kind carries volume");
            let initial = unit
                .kind
                .initial()
                .expect("reactor kind carries initial state");
            let incoming_edges: Vec<_> = topology
                .connections
                .iter()
                .filter(|connection| connection.to == unit.id)
                .collect();
            if incoming_edges.is_empty() {
                return Err(EngineError::DisconnectedReactor(unit.id.to_string()));
            }

            let mut incoming = Vec::with_capacity(incoming_edges.len());
            for connection in incoming_edges {
                let flow = connection
                    .flow()
                    .ok_or_else(|| EngineError::MissingFlow(connection.id.to_string()))?;
                let source_unit = topology
                    .unit(&connection.from)
                    .expect("topology.validate checked references");
                let source = if source_unit.kind.is_influent() {
                    InflowSource::Influent
                } else if source_unit.kind.is_reactor() {
                    InflowSource::Reactor(*reactor_index.get(&connection.from).ok_or_else(
                        || {
                            EngineError::Unsupported(format!(
                                "reactor {} is not upstream of {} in the forward order",
                                connection.from, unit.id
                            ))
                        },
                    )?)
                } else {
                    return Err(EngineError::Unsupported(format!(
                        "V2-0 cannot route flow from {} to reactor {}",
                        source_unit.id, unit.id
                    )));
                };
                incoming.push(Incoming {
                    source,
                    flow_m3_h: flow,
                });
            }

            let initial_state = Asm1State::from_aggregates(
                initial.cod,
                initial.nh4_n,
                initial.no3_n,
                initial.dissolved_oxygen,
                initial.alkalinity,
                initial.mlss,
                initial.temperature_c,
            );

            reactor_index.insert(unit.id.clone(), reactors.len());
            reactors.push(CompiledReactor {
                id: unit.id.clone(),
                name: unit.name.clone(),
                kind,
                volume_m3,
                kla_h: unit.kind.kla_h(),
                temperature_c: initial.temperature_c,
                initial: initial_state,
                incoming,
            });
        }

        if reactors.is_empty() {
            return Err(EngineError::NoReactor);
        }

        let effluent = effluents[0];
        let effluent_edges: Vec<_> = topology
            .connections
            .iter()
            .filter(|connection| connection.to == effluent.id)
            .collect();
        if effluent_edges.is_empty() {
            return Err(EngineError::NoEffluentStream(effluent.id.to_string()));
        }

        let mut effluent_sources = Vec::with_capacity(effluent_edges.len());
        let mut effluent_flow_m3_h = 0.0;
        for connection in effluent_edges {
            let flow = connection
                .flow()
                .ok_or_else(|| EngineError::MissingFlow(connection.id.to_string()))?;
            let source = *reactor_index.get(&connection.from).ok_or_else(|| {
                EngineError::Unsupported(format!(
                    "effluent {} can only receive reactor effluent in V2-0",
                    effluent.id
                ))
            })?;
            effluent_flow_m3_h += flow;
            effluent_sources.push(EffluentSource {
                reactor: source,
                flow_m3_h: flow,
            });
        }

        if (effluent_flow_m3_h - influent_flow_m3_h).abs() > 1e-6 {
            return Err(EngineError::FlowImbalance {
                unit: effluent.id.to_string(),
                incoming: effluent_flow_m3_h,
                outgoing: 0.0,
            });
        }

        Ok(Self {
            name: topology.name.clone(),
            reactors,
            influent_water,
            influent_flow_m3_h,
            effluent_sources,
            effluent_flow_m3_h,
            raw_water,
        })
    }
}

fn check_flow_balance(topology: &PlantTopology) -> Result<(), EngineError> {
    let influent_flow: f64 = topology
        .units
        .iter()
        .filter_map(|unit| match &unit.kind {
            UnitKind::Influent { flow_m3_h, .. } => Some(*flow_m3_h),
            _ => None,
        })
        .sum();

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
        } else if unit.kind.is_effluent() {
            (incoming - influent_flow).abs()
        } else {
            (incoming - outgoing).abs()
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

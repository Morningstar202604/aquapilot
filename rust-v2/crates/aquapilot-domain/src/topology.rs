use std::collections::{BTreeMap, BTreeSet};

use crate::ids::{ConnectionId, UnitId};
use crate::units::{Connection, Unit, UnitKind};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TopologyError {
    #[error("topology has no units")]
    Empty,
    #[error("duplicate unit id: {0}")]
    DuplicateUnit(String),
    #[error("duplicate connection id: {0}")]
    DuplicateConnection(String),
    #[error("connection {connection} references unknown unit {unit}")]
    UnknownUnit { connection: String, unit: String },
    #[error("connection {0} is a self-loop")]
    SelfLoop(String),
    #[error("unit {0} has a non-positive volume")]
    InvalidVolume(String),
    #[error("connection {0} has a non-positive or non-finite flow")]
    InvalidFlow(String),
    #[error("unit {0} contains a negative or non-finite concentration")]
    InvalidConcentration(String),
    #[error("clarifier {0} has invalid geometry or settler parameters")]
    InvalidClarifier(String),
    #[error("topology has no influent unit")]
    NoInfluent,
    #[error("topology has no effluent unit")]
    NoEffluent,
    #[error("forward process graph contains a cycle through: {0}")]
    ForwardCycle(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PlantTopology {
    pub name: String,
    pub units: Vec<Unit>,
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl PlantTopology {
    pub fn unit(&self, id: &UnitId) -> Option<&Unit> {
        self.units.iter().find(|unit| &unit.id == id)
    }

    pub fn influent(&self) -> Option<&Unit> {
        self.units.iter().find(|unit| unit.kind.is_influent())
    }

    pub fn effluent(&self) -> Option<&Unit> {
        self.units.iter().find(|unit| unit.kind.is_effluent())
    }

    /// Structural validation shared by every engine version.
    pub fn validate(&self) -> Result<(), TopologyError> {
        if self.units.is_empty() {
            return Err(TopologyError::Empty);
        }

        let mut unit_ids = BTreeSet::new();
        for unit in &self.units {
            if !unit_ids.insert(unit.id.clone()) {
                return Err(TopologyError::DuplicateUnit(unit.id.to_string()));
            }
            unit.kind
                .volume_m3()
                .map(|volume| {
                    if !volume.is_finite() || volume <= 0.0 {
                        Err(TopologyError::InvalidVolume(unit.id.to_string()))
                    } else {
                        Ok(())
                    }
                })
                .transpose()?;
            if let UnitKind::Influent { flow_m3_h, water } = &unit.kind {
                if !flow_m3_h.is_finite() || *flow_m3_h <= 0.0 {
                    return Err(TopologyError::InvalidFlow(format!(
                        "{} (influent flow)",
                        unit.id
                    )));
                }
                if !water.is_valid() {
                    return Err(TopologyError::InvalidConcentration(unit.id.to_string()));
                }
            }
            if let Some(initial) = unit.kind.initial() {
                if !initial.is_valid() {
                    return Err(TopologyError::InvalidConcentration(unit.id.to_string()));
                }
            }
            if let Some(spec) = unit.kind.clarifier_spec() {
                let layers_ok = (2..=100).contains(&spec.layers);
                let feed_ok = spec.feed_layer > 0 && spec.feed_layer < spec.layers;
                let geometry_ok = spec.area_m2.is_finite()
                    && spec.area_m2 > 0.0
                    && spec.depth_m.is_finite()
                    && spec.depth_m > 0.0;
                let settling_ok = spec.settling.v_max_m_per_d.is_finite()
                    && spec.settling.v_max_m_per_d > 0.0
                    && spec.settling.x_max_g_per_m3.is_finite()
                    && spec.settling.x_max_g_per_m3 > spec.settling.x_min_g_per_m3
                    && spec.settling.x_min_g_per_m3 >= 0.0
                    && spec.settling.a_per_g_per_m3.is_finite()
                    && spec.settling.b_per_g_per_m3.is_finite()
                    && spec.settling.a_per_g_per_m3 > 0.0
                    && spec.settling.a_per_g_per_m3 < spec.settling.b_per_g_per_m3;
                if !(layers_ok && feed_ok && geometry_ok && settling_ok) {
                    return Err(TopologyError::InvalidClarifier(unit.id.to_string()));
                }
            }
        }

        let mut connection_ids = BTreeSet::new();
        for connection in &self.connections {
            if !connection_ids.insert(connection.id.clone()) {
                return Err(TopologyError::DuplicateConnection(
                    connection.id.to_string(),
                ));
            }
            if !unit_ids.contains(&connection.from) {
                return Err(TopologyError::UnknownUnit {
                    connection: connection.id.to_string(),
                    unit: connection.from.to_string(),
                });
            }
            if !unit_ids.contains(&connection.to) {
                return Err(TopologyError::UnknownUnit {
                    connection: connection.id.to_string(),
                    unit: connection.to.to_string(),
                });
            }
            if connection.from == connection.to {
                return Err(TopologyError::SelfLoop(connection.id.to_string()));
            }
            if let Some(flow) = connection.flow() {
                if !flow.is_finite() || flow <= 0.0 {
                    return Err(TopologyError::InvalidFlow(connection.id.to_string()));
                }
            }
        }

        if self.influent().is_none() {
            return Err(TopologyError::NoInfluent);
        }
        if self.effluent().is_none() {
            return Err(TopologyError::NoEffluent);
        }

        Ok(())
    }

    /// Topological order over forward process edges. Recycle edges are
    /// intentionally excluded: they are back-edges and are resolved by the
    /// engine's recycle mixer, not by the forward sort.
    pub fn forward_order(&self) -> Result<Vec<UnitId>, TopologyError> {
        self.validate()?;

        let mut in_degree: BTreeMap<UnitId, usize> =
            self.units.iter().map(|unit| (unit.id.clone(), 0)).collect();
        let mut adjacency: BTreeMap<UnitId, Vec<UnitId>> = BTreeMap::new();

        for connection in &self.connections {
            if connection.recycle.is_back_edge() {
                continue;
            }
            adjacency
                .entry(connection.from.clone())
                .or_default()
                .push(connection.to.clone());
            *in_degree
                .get_mut(&connection.to)
                .expect("validated unit is present") += 1;
        }

        let mut ready: BTreeSet<UnitId> = in_degree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(id, _)| id.clone())
            .collect();
        let mut order = Vec::with_capacity(self.units.len());

        while let Some(id) = ready.pop_first() {
            order.push(id.clone());
            if let Some(next) = adjacency.get(&id) {
                for target in next {
                    let degree = in_degree
                        .get_mut(target)
                        .expect("validated unit is present");
                    *degree -= 1;
                    if *degree == 0 {
                        ready.insert(target.clone());
                    }
                }
            }
        }

        if order.len() != self.units.len() {
            let stuck: Vec<String> = in_degree
                .iter()
                .filter(|(_, degree)| **degree > 0)
                .map(|(id, _)| id.to_string())
                .collect();
            return Err(TopologyError::ForwardCycle(stuck.join(", ")));
        }

        Ok(order)
    }

    pub fn connection(&self, id: &ConnectionId) -> Option<&Connection> {
        self.connections
            .iter()
            .find(|connection| &connection.id == id)
    }
}

impl RawWaterValidation for crate::units::RawWater {
    fn is_valid(&self) -> bool {
        finite_non_negative(&[
            self.cod,
            self.nh4_n,
            self.no3_n,
            self.tp,
            self.ss,
            self.alkalinity,
            self.dissolved_oxygen,
        ]) && self.temperature_c.is_finite()
            && (-5.0..=60.0).contains(&self.temperature_c)
    }
}

impl RawWaterValidation for crate::units::ReactorInitial {
    fn is_valid(&self) -> bool {
        finite_non_negative(&[
            self.cod,
            self.nh4_n,
            self.no3_n,
            self.tp,
            self.dissolved_oxygen,
            self.alkalinity,
            self.mlss,
        ]) && self.temperature_c.is_finite()
            && (-5.0..=60.0).contains(&self.temperature_c)
    }
}

trait RawWaterValidation {
    fn is_valid(&self) -> bool;
}

fn finite_non_negative(values: &[f64]) -> bool {
    values
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
}

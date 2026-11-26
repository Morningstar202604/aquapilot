use aquapilot_domain::{PlantTopology, ReactorKind, UnitId};
use aquapilot_model::{reaction_rates, Asm1Params, Asm1State};
use serde::Serialize;

use crate::compile::{CompiledPlant, InflowSource};
use crate::error::EngineError;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SimulationConfig {
    pub dt_min: f64,
    pub duration_min: f64,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            dt_min: 1.0,
            duration_min: 1440.0,
        }
    }
}

impl SimulationConfig {
    fn validate(&self) -> Result<(), EngineError> {
        if !self.dt_min.is_finite() || self.dt_min <= 0.0 || self.dt_min > 1.0 {
            return Err(EngineError::InvalidConfig(
                "dt_min must be finite and in (0, 1] min".to_owned(),
            ));
        }
        if !self.duration_min.is_finite() || self.duration_min <= 0.0 {
            return Err(EngineError::InvalidConfig(
                "duration_min must be finite and positive".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub unit: Option<UnitId>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReactorSnapshot {
    pub id: UnitId,
    pub name: String,
    pub kind: ReactorKind,
    pub volume_m3: f64,
    pub flow_in_m3_h: f64,
    pub hrt_h: f64,
    pub temperature_c: f64,
    pub cod: f64,
    pub nh4_n: f64,
    pub no3_n: f64,
    pub tp: f64,
    pub ss: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub alkalinity: f64,
    pub mlss: f64,
    pub asm1: Asm1State,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EffluentSnapshot {
    pub flow_m3_h: f64,
    pub cod: f64,
    pub nh4_n: f64,
    pub no3_n: f64,
    pub tn: f64,
    pub tp: f64,
    pub ss: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub alkalinity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MassBalance {
    pub inflow_cod_kg: f64,
    pub effluent_cod_kg: f64,
    pub inventory_change_kg: f64,
    pub unaccounted_cod_kg: f64,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub plant_name: String,
    pub time_min: f64,
    pub step_count: u64,
    pub reactors: Vec<ReactorSnapshot>,
    pub effluent: EffluentSnapshot,
    pub mass_balance: MassBalance,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug)]
pub struct Simulator {
    pub plant: CompiledPlant,
    pub config: SimulationConfig,
    pub params: Asm1Params,
    state: Vec<Asm1State>,
    time_min: f64,
    step_count: u64,
    initial_inventory_cod_kg: f64,
    inflow_cod_kg: f64,
    effluent_cod_kg: f64,
    last_diagnostics: Vec<Diagnostic>,
}

impl Simulator {
    pub fn new(
        topology: &PlantTopology,
        config: SimulationConfig,
        params: Asm1Params,
    ) -> Result<Self, EngineError> {
        config.validate()?;
        let plant = CompiledPlant::compile(topology)?;
        let state: Vec<Asm1State> = plant
            .reactors
            .iter()
            .map(|reactor| reactor.initial)
            .collect();
        let initial_inventory_cod_kg = inventory_cod_kg(&plant, &state);

        Ok(Self {
            plant,
            config,
            params,
            state,
            time_min: 0.0,
            step_count: 0,
            initial_inventory_cod_kg,
            inflow_cod_kg: 0.0,
            effluent_cod_kg: 0.0,
            last_diagnostics: Vec::new(),
        })
    }

    pub fn new_default(topology: &PlantTopology) -> Result<Self, EngineError> {
        Self::new(topology, SimulationConfig::default(), Asm1Params::default())
    }

    pub fn time_min(&self) -> f64 {
        self.time_min
    }

    pub fn step(&mut self) -> Result<(), EngineError> {
        let dt_h = self.config.dt_min / 60.0;
        let previous = self.state.clone();
        self.last_diagnostics.clear();

        for index in 0..self.plant.reactors.len() {
            let reactor = &self.plant.reactors[index];
            let mut mixed = Asm1State::zeros();
            let mut total_flow = 0.0;
            for incoming in &reactor.incoming {
                let source = match incoming.source {
                    InflowSource::Influent => &self.plant.influent_water,
                    InflowSource::Reactor(source_index) => &previous[source_index],
                };
                mixed.add_weighted(source, incoming.flow_m3_h);
                total_flow += incoming.flow_m3_h;
            }
            if !total_flow.is_finite() || total_flow <= 0.0 {
                return Err(EngineError::Simulation {
                    time_min: self.time_min,
                    message: format!("reactor {} has no positive inflow", reactor.id),
                });
            }
            scale_state(&mut mixed, 1.0 / total_flow);

            let dilution_per_h = total_flow / reactor.volume_m3;
            let rates = reaction_rates(&previous[index], &self.params, reactor.temperature_c);

            let mut next = previous[index];
            let mut clamp_changed = false;
            for (field, rate) in [
                (0usize, rates.si),
                (1, rates.ss),
                (2, rates.xi),
                (3, rates.xs),
                (4, rates.xbh),
                (5, rates.xba),
                (6, rates.xp),
                (7, rates.so),
                (8, rates.sno),
                (9, rates.snh),
                (10, rates.snd),
                (11, rates.xnd),
                (12, rates.salk),
            ] {
                let mixed_value = component(&mixed, field);
                let previous_value = component(&previous[index], field);
                let value = previous_value
                    + dt_h * (dilution_per_h * (mixed_value - previous_value) + rate);
                set_component(&mut next, field, value);
            }

            if reactor.kind.is_aerobic() && reactor.kla_h > 0.0 {
                let saturation = saturation_do(reactor.temperature_c);
                let oxygen = next.so + reactor.kla_h * dt_h * (saturation - next.so);
                next.so = oxygen.clamp(0.0, saturation);
            }

            clamp_changed |= next.clamp_non_negative();
            if clamp_changed {
                self.last_diagnostics.push(Diagnostic {
                    code: "ASM1_STATE_CLAMPED".to_owned(),
                    unit: Some(reactor.id.clone()),
                    message: "one or more ASM1 components were clamped to the physical lower bound"
                        .to_owned(),
                });
            }
            if !next.values().iter().all(|value| value.is_finite()) {
                return Err(EngineError::Simulation {
                    time_min: self.time_min,
                    message: format!("non-finite state in reactor {}", reactor.id),
                });
            }

            self.state[index] = next;
        }

        self.time_min += self.config.dt_min;
        self.step_count += 1;

        self.inflow_cod_kg += mass_rate_kg_per_step(
            self.plant.influent_flow_m3_h,
            self.plant.influent_water.total_cod(),
            dt_h,
        );
        let effluent = self.effluent_state();
        self.effluent_cod_kg +=
            mass_rate_kg_per_step(self.plant.effluent_flow_m3_h, effluent.total_cod(), dt_h);

        Ok(())
    }

    pub fn run(&mut self) -> Result<(), EngineError> {
        while self.time_min + 1e-9 < self.config.duration_min {
            self.step()?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let reactors = self
            .plant
            .reactors
            .iter()
            .enumerate()
            .map(|(index, reactor)| {
                let state = self.state[index];
                let flow_in_m3_h: f64 = reactor.incoming.iter().map(|item| item.flow_m3_h).sum();
                ReactorSnapshot {
                    id: reactor.id.clone(),
                    name: reactor.name.clone(),
                    kind: reactor.kind,
                    volume_m3: reactor.volume_m3,
                    flow_in_m3_h,
                    hrt_h: reactor.volume_m3 / flow_in_m3_h,
                    temperature_c: reactor.temperature_c,
                    cod: state.total_cod(),
                    nh4_n: state.snh,
                    no3_n: state.sno,
                    tp: 0.0,
                    ss: state.suspended_solids(),
                    dissolved_oxygen: state.so,
                    alkalinity: state.salk,
                    mlss: state.suspended_solids(),
                    asm1: state,
                }
            })
            .collect();

        let effluent = self.effluent_state();
        let inventory = inventory_cod_kg(&self.plant, &self.state);
        Snapshot {
            plant_name: self.plant.name.clone(),
            time_min: self.time_min,
            step_count: self.step_count,
            reactors,
            effluent: EffluentSnapshot {
                flow_m3_h: self.plant.effluent_flow_m3_h,
                cod: effluent.total_cod(),
                nh4_n: effluent.snh,
                no3_n: effluent.sno,
                tn: effluent.total_nitrogen(),
                tp: 0.0,
                ss: effluent.suspended_solids(),
                dissolved_oxygen: effluent.so,
                alkalinity: effluent.salk,
            },
            mass_balance: MassBalance {
                inflow_cod_kg: self.inflow_cod_kg,
                effluent_cod_kg: self.effluent_cod_kg,
                inventory_change_kg: inventory - self.initial_inventory_cod_kg,
                unaccounted_cod_kg: self.inflow_cod_kg
                    - self.effluent_cod_kg
                    - (inventory - self.initial_inventory_cod_kg),
                note: "V2-0 COD ledger: unaccounted includes oxidation and is not a closed plant ledger; V2-1 adds the oxidation row.".to_owned(),
            },
            diagnostics: self.last_diagnostics.clone(),
        }
    }

    fn effluent_state(&self) -> Asm1State {
        let mut mixed = Asm1State::zeros();
        let mut flow = 0.0;
        for source in &self.plant.effluent_sources {
            mixed.add_weighted(&self.state[source.reactor], source.flow_m3_h);
            flow += source.flow_m3_h;
        }
        if flow > 0.0 {
            scale_state(&mut mixed, 1.0 / flow);
        }
        mixed
    }
}

pub fn simulate(
    topology: &PlantTopology,
    config: SimulationConfig,
    params: Asm1Params,
) -> Result<Snapshot, EngineError> {
    let mut simulator = Simulator::new(topology, config, params)?;
    simulator.run()?;
    Ok(simulator.snapshot())
}

fn component(state: &Asm1State, index: usize) -> f64 {
    state.values()[index]
}

fn set_component(state: &mut Asm1State, index: usize, value: f64) {
    match index {
        0 => state.si = value,
        1 => state.ss = value,
        2 => state.xi = value,
        3 => state.xs = value,
        4 => state.xbh = value,
        5 => state.xba = value,
        6 => state.xp = value,
        7 => state.so = value,
        8 => state.sno = value,
        9 => state.snh = value,
        10 => state.snd = value,
        11 => state.xnd = value,
        12 => state.salk = value,
        _ => unreachable!("ASM1 has 13 components"),
    }
}

fn scale_state(state: &mut Asm1State, factor: f64) {
    for index in 0..13 {
        set_component(state, index, component(state, index) * factor);
    }
}

fn mass_rate_kg_per_step(flow_m3_h: f64, concentration_mg_l: f64, dt_h: f64) -> f64 {
    flow_m3_h * concentration_mg_l * dt_h / 1000.0
}

fn inventory_cod_kg(plant: &CompiledPlant, state: &[Asm1State]) -> f64 {
    plant
        .reactors
        .iter()
        .zip(state)
        .map(|(reactor, state)| reactor.volume_m3 * state.total_cod() / 1000.0)
        .sum()
}

fn saturation_do(temperature_c: f64) -> f64 {
    (9.1 - 0.2 * (temperature_c - 20.0)).clamp(6.0, 12.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aquapilot_domain::{
        Connection, ConnectionId, PlantTopology, RawWater, ReactorInitial, Unit, UnitKind,
    };

    fn water() -> RawWater {
        RawWater {
            cod: 400.0,
            nh4_n: 30.0,
            no3_n: 2.0,
            tp: 4.0,
            ss: 200.0,
            alkalinity: 200.0,
            dissolved_oxygen: 1.0,
            temperature_c: 20.0,
        }
    }

    fn initial() -> ReactorInitial {
        ReactorInitial {
            cod: 3500.0,
            nh4_n: 30.0,
            no3_n: 2.0,
            tp: 4.0,
            dissolved_oxygen: 2.0,
            alkalinity: 200.0,
            mlss: 2500.0,
            temperature_c: 20.0,
        }
    }

    fn single_reactor_topology() -> PlantTopology {
        PlantTopology {
            name: "single-aerobic".to_owned(),
            units: vec![
                Unit {
                    id: "in".into(),
                    name: "influent".to_owned(),
                    kind: UnitKind::Influent {
                        flow_m3_h: 1000.0,
                        water: water(),
                    },
                },
                Unit {
                    id: "a".into(),
                    name: "aerobic".to_owned(),
                    kind: UnitKind::Aerobic {
                        volume_m3: 36_000.0,
                        initial: initial(),
                        kla_h: 100.0,
                    },
                },
                Unit {
                    id: "out".into(),
                    name: "effluent".to_owned(),
                    kind: UnitKind::Effluent,
                },
            ],
            connections: vec![
                Connection {
                    id: ConnectionId::new("in-a"),
                    from: "in".into(),
                    to: "a".into(),
                    flow_m3_h: Some(1000.0),
                    stream: Default::default(),
                    recycle: Default::default(),
                },
                Connection {
                    id: ConnectionId::new("a-out"),
                    from: "a".into(),
                    to: "out".into(),
                    flow_m3_h: Some(1000.0),
                    stream: Default::default(),
                    recycle: Default::default(),
                },
            ],
            metadata: Default::default(),
        }
    }

    #[test]
    fn single_aerobic_reactor_nitrifies_for_24h() {
        let topology = single_reactor_topology();
        let snapshot = simulate(
            &topology,
            SimulationConfig {
                dt_min: 1.0,
                duration_min: 1440.0,
            },
            Asm1Params::default(),
        )
        .expect("simulation should run");
        assert_eq!(snapshot.step_count, 1440);
        assert!(snapshot.effluent.nh4_n < 30.0, "NH should decrease");
        assert!(
            snapshot.reactors[0].cod < 3500.0,
            "reactor COD should decrease from its initial inventory"
        );
        assert!(
            snapshot.effluent.cod < 3500.0,
            "effluent COD should be below the initial reactor inventory"
        );
        assert!(snapshot.effluent.dissolved_oxygen.is_finite());
        assert!(snapshot.effluent.dissolved_oxygen >= 0.0);
        assert!(snapshot
            .reactors
            .iter()
            .all(|reactor| reactor.cod.is_finite()));
    }

    #[test]
    fn three_stage_series_runs_and_keeps_order() {
        let topology: PlantTopology =
            serde_json::from_str(include_str!("../../../fixtures/three-stage.json"))
                .expect("fixture should parse");
        let snapshot = simulate(
            &topology,
            SimulationConfig {
                dt_min: 1.0,
                duration_min: 1440.0,
            },
            Asm1Params::default(),
        )
        .expect("three-stage series should run");
        assert_eq!(snapshot.reactors.len(), 3);
        assert_eq!(snapshot.reactors[0].kind, ReactorKind::Anaerobic);
        assert_eq!(snapshot.reactors[1].kind, ReactorKind::Anoxic);
        assert_eq!(snapshot.reactors[2].kind, ReactorKind::Aerobic);
        assert!(snapshot.effluent.nh4_n < 30.0);
        assert!(snapshot.effluent.cod.is_finite());
    }

    #[test]
    fn flow_imbalance_is_rejected() {
        let mut topology = single_reactor_topology();
        topology.connections[1].flow_m3_h = Some(900.0);
        let error = CompiledPlant::compile(&topology).expect_err("imbalance should fail");
        assert!(matches!(error, EngineError::FlowImbalance { .. }));
    }

    #[test]
    fn recycle_is_rejected_in_v2_0() {
        let mut topology = single_reactor_topology();
        topology.connections[0].recycle = aquapilot_domain::RecycleKind::Ras;
        let error = CompiledPlant::compile(&topology).expect_err("recycle should fail");
        assert!(matches!(error, EngineError::Unsupported(_)));
    }

    #[test]
    fn config_rejects_large_dt() {
        let topology = single_reactor_topology();
        let error = Simulator::new(
            &topology,
            SimulationConfig {
                dt_min: 2.0,
                duration_min: 60.0,
            },
            Asm1Params::default(),
        )
        .expect_err("dt > 1 should fail");
        assert!(matches!(error, EngineError::InvalidConfig(_)));
    }
}

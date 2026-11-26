use aquapilot_domain::{PlantTopology, ReactorKind, UnitId};
use aquapilot_model::settler::{
    step_clarifier, ClarifierOutput, ClarifierState, ClarifierStepInput,
};
use aquapilot_model::{reaction_rates, Asm1Params, Asm1State};
use serde::Serialize;

use crate::compile::{CompiledPlant, EffluentSource, InflowSource};
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
    pub kla_h: f64,
    pub do_setpoint: f64,
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
pub struct ClarifierSnapshot {
    pub id: UnitId,
    pub name: String,
    pub feed_reactor: UnitId,
    pub area_m2: f64,
    pub depth_m: f64,
    pub layers: usize,
    pub feed_flow_m3_h: f64,
    pub overflow_flow_m3_h: f64,
    pub underflow_flow_m3_h: f64,
    pub ras_flow_m3_h: f64,
    pub was_flow_m3_h: f64,
    pub feed_tss: f64,
    pub overflow_tss: f64,
    pub underflow_tss: f64,
    pub layer_tss: Vec<f64>,
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
pub struct WasteSnapshot {
    pub flow_m3_h: f64,
    pub cod: f64,
    pub ss: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MassBalance {
    pub inflow_cod_kg: f64,
    pub effluent_cod_kg: f64,
    pub waste_cod_kg: f64,
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
    pub clarifiers: Vec<ClarifierSnapshot>,
    pub effluent: EffluentSnapshot,
    pub waste: Option<WasteSnapshot>,
    pub mass_balance: MassBalance,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
struct ClarifierFlow {
    feed: Asm1State,
    overflow: Asm1State,
    underflow: Asm1State,
    output: ClarifierOutput,
}

#[derive(Debug, Clone)]
struct AerationController {
    setpoint: f64,
    max_kla: f64,
    integral: f64,
}

#[derive(Debug)]
pub struct Simulator {
    pub plant: CompiledPlant,
    pub config: SimulationConfig,
    pub params: Asm1Params,
    state: Vec<Asm1State>,
    clarifier_states: Vec<ClarifierState>,
    clarifier_flows: Vec<ClarifierFlow>,
    controllers: Vec<Option<AerationController>>,
    last_kla: Vec<f64>,
    time_min: f64,
    step_count: u64,
    initial_inventory_cod_kg: f64,
    inflow_cod_kg: f64,
    effluent_cod_kg: f64,
    waste_cod_kg: f64,
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

        let mut clarifier_states = Vec::with_capacity(plant.clarifiers.len());
        let mut clarifier_flows = Vec::with_capacity(plant.clarifiers.len());
        for clarifier in &plant.clarifiers {
            let feed = state[clarifier.feed_reactor];
            let feed_tss = feed.suspended_solids();
            let state = ClarifierState::new(clarifier.layers, clarifier.feed_layer, feed_tss)?;
            let mut underflow = feed;
            underflow.so = 0.0;
            clarifier_states.push(state);
            clarifier_flows.push(ClarifierFlow {
                feed,
                overflow: feed,
                underflow,
                output: ClarifierOutput {
                    overflow_tss: feed_tss,
                    underflow_tss: feed_tss,
                    overflow_flow_m3_h: clarifier.overflow_flow_m3_h,
                    underflow_flow_m3_h: clarifier.underflow_flow_m3_h,
                    overflow_mass_kg: 0.0,
                    underflow_mass_kg: 0.0,
                },
            });
        }

        let controllers = plant
            .reactors
            .iter()
            .map(|reactor| {
                if reactor.kind.is_aerobic() && reactor.kla_h > 0.0 && reactor.do_setpoint > 0.0 {
                    Some(AerationController {
                        setpoint: reactor.do_setpoint,
                        max_kla: reactor.kla_h,
                        integral: 0.0,
                    })
                } else {
                    None
                }
            })
            .collect();
        let last_kla = plant
            .reactors
            .iter()
            .map(|reactor| {
                if reactor.kind.is_aerobic() && reactor.do_setpoint > 0.0 {
                    0.2 * reactor.kla_h
                } else {
                    reactor.kla_h
                }
            })
            .collect();

        let mut simulator = Self {
            plant,
            config,
            params,
            state,
            clarifier_states,
            clarifier_flows,
            controllers,
            last_kla,
            time_min: 0.0,
            step_count: 0,
            initial_inventory_cod_kg: 0.0,
            inflow_cod_kg: 0.0,
            effluent_cod_kg: 0.0,
            waste_cod_kg: 0.0,
            last_diagnostics: Vec::new(),
        };
        simulator.initial_inventory_cod_kg = simulator.inventory_cod_kg();
        Ok(simulator)
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

        // Reactors first. Recycle streams use the previous step's clarifier
        // underflow and previous reactor states; this is an explicit operator
        // split, not a hidden simultaneous solve.
        for index in 0..self.plant.reactors.len() {
            let reactor = &self.plant.reactors[index];
            let mut mixed = Asm1State::zeros();
            let mut total_flow = 0.0;
            for incoming in &reactor.incoming {
                let source = match incoming.source {
                    InflowSource::Influent => &self.plant.influent_water,
                    InflowSource::Reactor(source_index) => &previous[source_index],
                    InflowSource::ClarifierUnderflow(clarifier_index) => {
                        &self.clarifier_flows[clarifier_index].underflow
                    }
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
                let kla = if let Some(controller) = self.controllers[index].as_mut() {
                    let error = controller.setpoint - previous[index].so;
                    controller.integral += error * dt_h;
                    let raw = 0.2 * controller.max_kla + 8.0 * error + 0.5 * controller.integral;
                    raw.clamp(0.0, controller.max_kla)
                } else {
                    reactor.kla_h
                };
                self.last_kla[index] = kla;
                let oxygen = next.so + kla * dt_h * (saturation - next.so);
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

        // Clarifiers receive the freshly updated reactor feed. Their outputs
        // become available to the next reactor step.
        for index in 0..self.plant.clarifiers.len() {
            let clarifier = &self.plant.clarifiers[index];
            let feed = self.state[clarifier.feed_reactor];
            let feed_tss = feed.suspended_solids();
            let input = ClarifierStepInput {
                feed_tss,
                feed_flow_m3_h: clarifier.feed_flow_m3_h,
                overflow_flow_m3_h: clarifier.overflow_flow_m3_h,
                underflow_flow_m3_h: clarifier.underflow_flow_m3_h,
                area_m2: clarifier.area_m2,
                depth_m: clarifier.depth_m,
                dt_h,
            };
            let output = step_clarifier(
                &mut self.clarifier_states[index],
                &input,
                &clarifier.settling,
            )?;
            let overflow = feed.with_particulate_tss(output.overflow_tss);
            let mut underflow = feed.with_particulate_tss(output.underflow_tss);
            // RAS is returned anoxic; the settler underflow is not aerated.
            underflow.so = 0.0;
            self.clarifier_flows[index] = ClarifierFlow {
                feed,
                overflow,
                underflow,
                output,
            };
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
        for (clarifier, flow) in self.plant.clarifiers.iter().zip(&self.clarifier_flows) {
            self.waste_cod_kg +=
                mass_rate_kg_per_step(clarifier.was_flow_m3_h, flow.underflow.total_cod(), dt_h);
        }

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
                    kla_h: self.last_kla[index],
                    do_setpoint: reactor.do_setpoint,
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

        let clarifiers = self
            .plant
            .clarifiers
            .iter()
            .enumerate()
            .map(|(index, clarifier)| {
                let flow = &self.clarifier_flows[index];
                ClarifierSnapshot {
                    id: clarifier.id.clone(),
                    name: clarifier.name.clone(),
                    feed_reactor: self.plant.reactors[clarifier.feed_reactor].id.clone(),
                    area_m2: clarifier.area_m2,
                    depth_m: clarifier.depth_m,
                    layers: clarifier.layers,
                    feed_flow_m3_h: clarifier.feed_flow_m3_h,
                    overflow_flow_m3_h: clarifier.overflow_flow_m3_h,
                    underflow_flow_m3_h: clarifier.underflow_flow_m3_h,
                    ras_flow_m3_h: clarifier.ras_flow_m3_h,
                    was_flow_m3_h: clarifier.was_flow_m3_h,
                    feed_tss: flow.feed.suspended_solids(),
                    overflow_tss: flow.output.overflow_tss,
                    underflow_tss: flow.output.underflow_tss,
                    layer_tss: self.clarifier_states[index].layers.clone(),
                }
            })
            .collect();

        let effluent = self.effluent_state();
        let waste = if self.plant.was_flow_m3_h > 0.0 {
            let state = self.waste_state();
            Some(WasteSnapshot {
                flow_m3_h: self.plant.was_flow_m3_h,
                cod: state.total_cod(),
                ss: state.suspended_solids(),
            })
        } else {
            None
        };
        let inventory = self.inventory_cod_kg();
        Snapshot {
            plant_name: self.plant.name.clone(),
            time_min: self.time_min,
            step_count: self.step_count,
            reactors,
            clarifiers,
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
            waste,
            mass_balance: MassBalance {
                inflow_cod_kg: self.inflow_cod_kg,
                effluent_cod_kg: self.effluent_cod_kg,
                waste_cod_kg: self.waste_cod_kg,
                inventory_change_kg: inventory - self.initial_inventory_cod_kg,
                unaccounted_cod_kg: self.inflow_cod_kg
                    - self.effluent_cod_kg
                    - self.waste_cod_kg
                    - (inventory - self.initial_inventory_cod_kg),
                note: "V2-1 COD ledger: unaccounted includes oxidation and is not a closed plant ledger; V2-2 adds the oxidation row.".to_owned(),
            },
            diagnostics: self.last_diagnostics.clone(),
        }
    }

    fn effluent_state(&self) -> Asm1State {
        match self.plant.effluent_source {
            EffluentSource::Reactor { reactor, .. } => self.state[reactor],
            EffluentSource::Clarifier { clarifier, .. } => self.clarifier_flows[clarifier].overflow,
        }
    }

    fn waste_state(&self) -> Asm1State {
        let mut mixed = Asm1State::zeros();
        let mut flow = 0.0;
        for (clarifier, state) in self.plant.clarifiers.iter().zip(&self.clarifier_flows) {
            if clarifier.was_flow_m3_h > 0.0 {
                mixed.add_weighted(&state.underflow, clarifier.was_flow_m3_h);
                flow += clarifier.was_flow_m3_h;
            }
        }
        if flow > 0.0 {
            scale_state(&mut mixed, 1.0 / flow);
        }
        mixed
    }

    fn inventory_cod_kg(&self) -> f64 {
        let reactor_inventory: f64 = self
            .plant
            .reactors
            .iter()
            .zip(&self.state)
            .map(|(reactor, state)| reactor.volume_m3 * state.total_cod() / 1000.0)
            .sum();
        let clarifier_inventory: f64 = self
            .plant
            .clarifiers
            .iter()
            .enumerate()
            .map(|(index, clarifier)| {
                let volume_m3 = clarifier.area_m2 * clarifier.depth_m;
                let layer_volume_m3 = volume_m3 / clarifier.layers as f64;
                let solids_cod_kg = self.clarifier_states[index].layers.iter().sum::<f64>()
                    * layer_volume_m3
                    * 1.42
                    / 1000.0;
                let soluble_cod_kg = (self.clarifier_flows[index].feed.si
                    + self.clarifier_flows[index].feed.ss)
                    * volume_m3
                    / 1000.0;
                solids_cod_kg + soluble_cod_kg
            })
            .sum();
        reactor_inventory + clarifier_inventory
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
                        do_setpoint: 0.0,
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
    fn recycle_from_non_clarifier_is_rejected() {
        let mut topology = single_reactor_topology();
        topology.connections[0].recycle = aquapilot_domain::RecycleKind::Ras;
        let error = CompiledPlant::compile(&topology).expect_err("invalid RAS source");
        assert!(matches!(error, EngineError::InvalidRecycle(_)));
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

    #[test]
    fn bsm1_like_plant_runs_for_thirty_days() {
        let topology: PlantTopology =
            serde_json::from_str(include_str!("../../../fixtures/bsm1-like.json"))
                .expect("fixture should parse");
        let snapshot = simulate(
            &topology,
            SimulationConfig {
                dt_min: 1.0,
                duration_min: 30.0 * 1440.0,
            },
            Asm1Params::default(),
        )
        .expect("BSM1-like plant should run");
        assert_eq!(snapshot.step_count, 30 * 1440);
        assert_eq!(snapshot.reactors.len(), 5);
        assert_eq!(snapshot.clarifiers.len(), 1);
        assert!(snapshot.effluent.cod < 60.0, "effluent COD gate");
        assert!(snapshot.effluent.ss < 20.0, "effluent SS gate");
        assert!(snapshot.effluent.nh4_n < 5.0, "effluent NH4-N gate");
        assert!(snapshot.clarifiers[0].underflow_tss > snapshot.clarifiers[0].overflow_tss);
        assert!(snapshot
            .reactors
            .iter()
            .all(|reactor| (2000.0..=4000.0).contains(&reactor.mlss)));
    }
}

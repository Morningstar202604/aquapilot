//! Whole-plant ASM2d simulation for the A2O / BNR flowsheet shape used by
//! V2-2. This module deliberately owns its own plant configuration instead of
//! overloading the ASM1 `CompiledPlant`: the two models have different state
//! widths and different mass-ledger closures, and forcing them into one
//! generic runtime would make the clean-room boundary harder to audit.

use aquapilot_domain::{ReactorKind, SettlerParams};
use serde::{Deserialize, Serialize};

use crate::asm2d::{process_rates, reaction_rates, Asm2dParams, Asm2dState};
use crate::settler::{step_clarifier, ClarifierOutput, ClarifierState, ClarifierStepInput};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Asm2dPlantError {
    #[error("ASM2d plant has no reactors")]
    NoReactors,
    #[error("ASM2d plant configuration is invalid: {0}")]
    InvalidConfig(String),
    #[error("ASM2d plant flow does not balance: {0}")]
    Flow(String),
    #[error("ASM2d plant state became non-finite at {0} min")]
    NonFinite(f64),
    #[error("ASM2d settler error: {0}")]
    Settler(#[from] crate::settler::SettlerError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dInfluentConfig {
    pub flow_m3_h: f64,
    pub state: Asm2dState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dReactorConfig {
    pub id: String,
    pub name: String,
    pub kind: ReactorKind,
    pub volume_m3: f64,
    pub temperature_c: f64,
    #[serde(default)]
    pub kla_h: f64,
    #[serde(default)]
    pub do_setpoint: f64,
    pub initial: Asm2dState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dRecycleConfig {
    /// Internal recycle source. V2-2 requires this to be the final reactor.
    pub from: usize,
    pub to: usize,
    pub flow_m3_h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dClarifierConfig {
    pub area_m2: f64,
    pub depth_m: f64,
    pub layers: usize,
    pub feed_layer: usize,
    #[serde(default)]
    pub settling: SettlerParams,
    pub ras_reactor: usize,
    pub ras_flow_m3_h: f64,
    pub was_flow_m3_h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dPlantConfig {
    pub name: String,
    pub influent: Asm2dInfluentConfig,
    pub reactors: Vec<Asm2dReactorConfig>,
    pub clarifier: Asm2dClarifierConfig,
    #[serde(default)]
    pub internal_recycles: Vec<Asm2dRecycleConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Asm2dSimulationConfig {
    pub dt_min: f64,
    pub duration_min: f64,
}

impl Default for Asm2dSimulationConfig {
    fn default() -> Self {
        Self {
            dt_min: 1.0,
            duration_min: 1440.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InflowSource {
    Influent,
    Reactor(usize),
    ClarifierUnderflow,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Incoming {
    source: InflowSource,
    flow_m3_h: f64,
}

#[derive(Debug, Clone)]
struct PlantFlows {
    reactor_incoming: Vec<Vec<Incoming>>,
    reactor_outflow: Vec<f64>,
    clarifier_feed_flow_m3_h: f64,
    clarifier_overflow_flow_m3_h: f64,
    clarifier_underflow_flow_m3_h: f64,
}

fn compile_flows(config: &Asm2dPlantConfig) -> Result<PlantFlows, Asm2dPlantError> {
    let n = config.reactors.len();
    if n == 0 {
        return Err(Asm2dPlantError::NoReactors);
    }
    let clarifier = &config.clarifier;
    if config.influent.flow_m3_h <= 0.0 {
        return Err(Asm2dPlantError::InvalidConfig(
            "influent flow must be positive".to_owned(),
        ));
    }
    if clarifier.ras_reactor >= n {
        return Err(Asm2dPlantError::InvalidConfig(
            "RAS reactor index is out of range".to_owned(),
        ));
    }
    if clarifier.ras_flow_m3_h < 0.0 || clarifier.was_flow_m3_h <= 0.0 {
        return Err(Asm2dPlantError::InvalidConfig(
            "RAS must be non-negative and WAS must be positive".to_owned(),
        ));
    }
    for recycle in &config.internal_recycles {
        if recycle.from >= n || recycle.to >= n || recycle.flow_m3_h <= 0.0 {
            return Err(Asm2dPlantError::InvalidConfig(
                "internal recycle index or flow is invalid".to_owned(),
            ));
        }
        if recycle.from != n - 1 {
            return Err(Asm2dPlantError::InvalidConfig(
                "V2-2 internal recycle must originate from the final reactor".to_owned(),
            ));
        }
    }

    let ras = clarifier.ras_flow_m3_h;
    let was = clarifier.was_flow_m3_h;
    let underflow = ras + was;
    let overflow = config.influent.flow_m3_h - was;
    if overflow <= 0.0 {
        return Err(Asm2dPlantError::Flow(
            "effluent flow must be positive".to_owned(),
        ));
    }

    let mut incoming = vec![Vec::new(); n];
    incoming[0].push(Incoming {
        source: InflowSource::Influent,
        flow_m3_h: config.influent.flow_m3_h,
    });
    incoming[clarifier.ras_reactor].push(Incoming {
        source: InflowSource::ClarifierUnderflow,
        flow_m3_h: ras,
    });
    for recycle in &config.internal_recycles {
        incoming[recycle.to].push(Incoming {
            source: InflowSource::Reactor(recycle.from),
            flow_m3_h: recycle.flow_m3_h,
        });
    }

    let mut outflow = vec![0.0; n];
    for index in 0..n {
        let total: f64 = incoming[index].iter().map(|item| item.flow_m3_h).sum();
        if total <= 0.0 {
            return Err(Asm2dPlantError::Flow(format!(
                "reactor {} has no inflow",
                index
            )));
        }
        outflow[index] = total;
        if index + 1 < n {
            incoming[index + 1].push(Incoming {
                source: InflowSource::Reactor(index),
                flow_m3_h: total,
            });
        }
    }

    let internal_from_last: f64 = config
        .internal_recycles
        .iter()
        .filter(|recycle| recycle.from == n - 1)
        .map(|recycle| recycle.flow_m3_h)
        .sum();
    let clarifier_feed = outflow[n - 1] - internal_from_last;
    if (clarifier_feed - (config.influent.flow_m3_h + ras)).abs() > 1e-6 * clarifier_feed.max(1.0) {
        return Err(Asm2dPlantError::Flow(format!(
            "clarifier feed {clarifier_feed:.3} m3/h does not equal influent + RAS"
        )));
    }
    if (overflow + underflow - clarifier_feed).abs() > 1e-6 * clarifier_feed.max(1.0) {
        return Err(Asm2dPlantError::Flow(
            "clarifier overflow + underflow does not equal feed".to_owned(),
        ));
    }
    if (config.influent.flow_m3_h - overflow - was).abs()
        > 1e-6 * config.influent.flow_m3_h.max(1.0)
    {
        return Err(Asm2dPlantError::Flow(
            "global influent = effluent + WAS balance failed".to_owned(),
        ));
    }

    Ok(PlantFlows {
        reactor_incoming: incoming,
        reactor_outflow: outflow,
        clarifier_feed_flow_m3_h: clarifier_feed,
        clarifier_overflow_flow_m3_h: overflow,
        clarifier_underflow_flow_m3_h: underflow,
    })
}

#[derive(Debug, Clone)]
struct ClarifierFlow {
    feed: Asm2dState,
    overflow: Asm2dState,
    underflow: Asm2dState,
    output: ClarifierOutput,
}

#[derive(Debug, Clone)]
struct AerationController {
    setpoint: f64,
    max_kla: f64,
    integral: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dReactorSnapshot {
    pub id: String,
    pub name: String,
    pub kind: ReactorKind,
    pub volume_m3: f64,
    pub flow_m3_h: f64,
    pub hrt_h: f64,
    pub temperature_c: f64,
    pub kla_h: f64,
    pub cod: f64,
    pub tn: f64,
    pub tp: f64,
    pub ss: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub state: Asm2dState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dClarifierSnapshot {
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
pub struct Asm2dEffluentSnapshot {
    pub flow_m3_h: f64,
    pub cod: f64,
    pub s_s: f64,
    pub nh4_n: f64,
    pub no3_n: f64,
    pub tn: f64,
    pub tp: f64,
    pub po4_p: f64,
    pub ss: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub alkalinity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dWasteSnapshot {
    pub flow_m3_h: f64,
    pub cod: f64,
    pub tn: f64,
    pub tp: f64,
    pub ss: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MassLedger {
    pub inflow_kg: f64,
    pub effluent_kg: f64,
    pub waste_kg: f64,
    pub inventory_change_kg: f64,
    pub oxidized_kg: f64,
    pub gas_kg: f64,
    pub unaccounted_kg: f64,
    pub residual_fraction: f64,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dMassBalance {
    pub cod: MassLedger,
    pub nitrogen: MassLedger,
    pub phosphorus: MassLedger,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dPlantSnapshot {
    pub plant_name: String,
    pub time_min: f64,
    pub step_count: u64,
    pub reactors: Vec<Asm2dReactorSnapshot>,
    pub clarifier: Asm2dClarifierSnapshot,
    pub effluent: Asm2dEffluentSnapshot,
    pub waste: Asm2dWasteSnapshot,
    pub mass_balance: Asm2dMassBalance,
}

#[derive(Debug)]
pub struct Asm2dSimulator {
    pub config: Asm2dPlantConfig,
    pub simulation: Asm2dSimulationConfig,
    pub params: Asm2dParams,
    flows: PlantFlows,
    state: Vec<Asm2dState>,
    clarifier_state: ClarifierState,
    clarifier_flow: ClarifierFlow,
    controllers: Vec<Option<AerationController>>,
    last_kla: Vec<f64>,
    time_min: f64,
    step_count: u64,
    initial_inventory: [f64; 3],
    inflow: [f64; 3],
    effluent: [f64; 3],
    waste: [f64; 3],
    oxygen_consumed_kg: f64,
    denitrified_n_kg: f64,
}

impl Asm2dSimulator {
    pub fn new(
        config: Asm2dPlantConfig,
        simulation: Asm2dSimulationConfig,
        params: Asm2dParams,
    ) -> Result<Self, Asm2dPlantError> {
        if !simulation.dt_min.is_finite()
            || simulation.dt_min <= 0.0
            || simulation.dt_min > 1.0
            || !simulation.duration_min.is_finite()
            || simulation.duration_min <= 0.0
        {
            return Err(Asm2dPlantError::InvalidConfig(
                "dt_min must be in (0,1] and duration_min positive".to_owned(),
            ));
        }
        for reactor in &config.reactors {
            if reactor.volume_m3 <= 0.0
                || !reactor.temperature_c.is_finite()
                || reactor.kla_h < 0.0
                || reactor.do_setpoint < 0.0
                || !reactor.initial.is_finite_non_negative()
            {
                return Err(Asm2dPlantError::InvalidConfig(format!(
                    "reactor {} has invalid geometry or initial state",
                    reactor.id
                )));
            }
        }
        if !config.influent.state.is_finite_non_negative() {
            return Err(Asm2dPlantError::InvalidConfig(
                "influent state must be finite and non-negative".to_owned(),
            ));
        }
        let flows = compile_flows(&config)?;
        let state: Vec<Asm2dState> = config.reactors.iter().map(|r| r.initial).collect();
        let feed = state[config.reactors.len() - 1];
        let clarifier_state = ClarifierState::new(
            config.clarifier.layers,
            config.clarifier.feed_layer,
            feed.suspended_solids(),
        )?;
        let clarifier_flow = ClarifierFlow {
            feed,
            overflow: feed,
            underflow: feed.with_particulate_tss(config.clarifier.ras_flow_m3_h.max(1.0)),
            output: ClarifierOutput {
                overflow_tss: feed.suspended_solids(),
                underflow_tss: feed.suspended_solids(),
                overflow_flow_m3_h: flows.clarifier_overflow_flow_m3_h,
                underflow_flow_m3_h: flows.clarifier_underflow_flow_m3_h,
                overflow_mass_kg: 0.0,
                underflow_mass_kg: 0.0,
            },
        };
        let controllers = config
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
        let last_kla = config
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
            config,
            simulation,
            params,
            flows,
            state,
            clarifier_state,
            clarifier_flow,
            controllers,
            last_kla,
            time_min: 0.0,
            step_count: 0,
            initial_inventory: [0.0; 3],
            inflow: [0.0; 3],
            effluent: [0.0; 3],
            waste: [0.0; 3],
            oxygen_consumed_kg: 0.0,
            denitrified_n_kg: 0.0,
        };
        simulator.initial_inventory = simulator.inventory();
        Ok(simulator)
    }

    pub fn time_min(&self) -> f64 {
        self.time_min
    }

    pub fn step(&mut self) -> Result<(), Asm2dPlantError> {
        let dt_h = self.simulation.dt_min / 60.0;
        let previous = self.state.clone();
        let temperature_c = self
            .config
            .reactors
            .first()
            .map_or(20.0, |reactor| reactor.temperature_c);

        for index in 0..self.config.reactors.len() {
            let reactor = &self.config.reactors[index];
            let mut mixed = Asm2dState::zeros();
            let mut total_flow = 0.0;
            for incoming in &self.flows.reactor_incoming[index] {
                let source = match incoming.source {
                    InflowSource::Influent => &self.config.influent.state,
                    InflowSource::Reactor(source_index) => &previous[source_index],
                    InflowSource::ClarifierUnderflow => &self.clarifier_flow.underflow,
                };
                mixed.add_weighted(source, incoming.flow_m3_h);
                total_flow += incoming.flow_m3_h;
            }
            if total_flow <= 0.0 {
                return Err(Asm2dPlantError::Flow(format!(
                    "reactor {} has no positive inflow",
                    reactor.id
                )));
            }
            scale_state(&mut mixed, 1.0 / total_flow);

            let dilution_per_h = total_flow / reactor.volume_m3;
            let rates = reaction_rates(&previous[index], &self.params, temperature_c);
            let processes = process_rates(&previous[index], &self.params, temperature_c);
            let mut next = previous[index];
            for field in 0..18 {
                let mixed_value = component(&mixed, field);
                let previous_value = component(&previous[index], field);
                let rate = component_rate(&rates, field);
                set_component(
                    &mut next,
                    field,
                    previous_value
                        + dt_h * (dilution_per_h * (mixed_value - previous_value) + rate),
                );
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

            next.clamp_non_negative();
            if !next.is_finite_non_negative() {
                return Err(Asm2dPlantError::NonFinite(self.time_min));
            }
            // COD oxidation is the heterotrophic / PAO oxygen demand. The
            // autotrophic oxygen demand belongs to nitrification and must not
            // be booked as organic COD oxidation.
            let cod_oxygen = 0.6
                * (processes.hetero_growth_sf
                    + processes.hetero_growth_sa
                    + processes.pao_aero_growth)
                + 0.2 * processes.aero_storage_pp;
            self.oxygen_consumed_kg += cod_oxygen.max(0.0) * reactor.volume_m3 * dt_h / 1000.0;
            // Dinitrogen strips to the gas phase. Booking the reaction
            // production (rather than the small residual S_N2 left after the
            // explicit step) avoids double-counting the same nitrogen in the
            // liquid and gas ledgers.
            self.denitrified_n_kg += rates.sn2.max(0.0) * reactor.volume_m3 * dt_h / 1000.0;
            next.sn2 = 0.0;
            self.state[index] = next;
        }

        let feed = self.state[self.config.reactors.len() - 1];
        let feed_tss = feed.suspended_solids();
        let output = step_clarifier(
            &mut self.clarifier_state,
            &ClarifierStepInput {
                feed_tss,
                feed_flow_m3_h: self.flows.clarifier_feed_flow_m3_h,
                overflow_flow_m3_h: self.flows.clarifier_overflow_flow_m3_h,
                underflow_flow_m3_h: self.flows.clarifier_underflow_flow_m3_h,
                area_m2: self.config.clarifier.area_m2,
                depth_m: self.config.clarifier.depth_m,
                dt_h,
            },
            &self.config.clarifier.settling,
        )?;
        let overflow = feed.with_particulate_tss(output.overflow_tss);
        let mut underflow = feed.with_particulate_tss(output.underflow_tss);
        underflow.so = 0.0;
        self.clarifier_flow = ClarifierFlow {
            feed,
            overflow,
            underflow,
            output,
        };

        self.time_min += self.simulation.dt_min;
        self.step_count += 1;
        self.inflow[0] += mass_rate_kg_per_step(
            self.config.influent.flow_m3_h,
            self.config.influent.state.total_cod(),
            dt_h,
        );
        self.inflow[1] += mass_rate_kg_per_step(
            self.config.influent.flow_m3_h,
            self.config.influent.state.total_nitrogen(),
            dt_h,
        );
        self.inflow[2] += mass_rate_kg_per_step(
            self.config.influent.flow_m3_h,
            self.config.influent.state.total_phosphorus(),
            dt_h,
        );
        let effluent = self.clarifier_flow.overflow;
        self.effluent[0] += mass_rate_kg_per_step(
            self.flows.clarifier_overflow_flow_m3_h,
            effluent.total_cod(),
            dt_h,
        );
        self.effluent[1] += mass_rate_kg_per_step(
            self.flows.clarifier_overflow_flow_m3_h,
            effluent.total_nitrogen(),
            dt_h,
        );
        self.effluent[2] += mass_rate_kg_per_step(
            self.flows.clarifier_overflow_flow_m3_h,
            effluent.total_phosphorus(),
            dt_h,
        );
        let waste = self.clarifier_flow.underflow;
        self.waste[0] +=
            mass_rate_kg_per_step(self.config.clarifier.was_flow_m3_h, waste.total_cod(), dt_h);
        self.waste[1] += mass_rate_kg_per_step(
            self.config.clarifier.was_flow_m3_h,
            waste.total_nitrogen(),
            dt_h,
        );
        self.waste[2] += mass_rate_kg_per_step(
            self.config.clarifier.was_flow_m3_h,
            waste.total_phosphorus(),
            dt_h,
        );

        Ok(())
    }

    pub fn run(&mut self) -> Result<(), Asm2dPlantError> {
        while self.time_min + 1e-9 < self.simulation.duration_min {
            self.step()?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Asm2dPlantSnapshot {
        let reactors = self
            .config
            .reactors
            .iter()
            .enumerate()
            .map(|(index, reactor)| {
                let state = self.state[index];
                Asm2dReactorSnapshot {
                    id: reactor.id.clone(),
                    name: reactor.name.clone(),
                    kind: reactor.kind,
                    volume_m3: reactor.volume_m3,
                    flow_m3_h: self.flows.reactor_outflow[index],
                    hrt_h: reactor.volume_m3 / self.flows.reactor_outflow[index],
                    temperature_c: reactor.temperature_c,
                    kla_h: self.last_kla[index],
                    cod: state.total_cod(),
                    tn: state.total_nitrogen(),
                    tp: state.total_phosphorus(),
                    ss: state.suspended_solids(),
                    dissolved_oxygen: state.so,
                    state,
                }
            })
            .collect();
        let effluent = self.clarifier_flow.overflow;
        let waste = self.clarifier_flow.underflow;
        let inventory = self.inventory();
        let cod = ledger(
            self.inflow[0],
            self.effluent[0],
            self.waste[0],
            inventory[0] - self.initial_inventory[0],
            self.oxygen_consumed_kg + self.params.cod_den * self.denitrified_n_kg,
            0.0,
        );
        let nitrogen = ledger(
            self.inflow[1],
            self.effluent[1],
            self.waste[1],
            inventory[1] - self.initial_inventory[1],
            0.0,
            self.denitrified_n_kg,
        );
        let phosphorus = ledger(
            self.inflow[2],
            self.effluent[2],
            self.waste[2],
            inventory[2] - self.initial_inventory[2],
            0.0,
            0.0,
        );
        let closed = cod.closed && nitrogen.closed && phosphorus.closed;
        Asm2dPlantSnapshot {
            plant_name: self.config.name.clone(),
            time_min: self.time_min,
            step_count: self.step_count,
            reactors,
            clarifier: Asm2dClarifierSnapshot {
                feed_flow_m3_h: self.flows.clarifier_feed_flow_m3_h,
                overflow_flow_m3_h: self.flows.clarifier_overflow_flow_m3_h,
                underflow_flow_m3_h: self.flows.clarifier_underflow_flow_m3_h,
                ras_flow_m3_h: self.config.clarifier.ras_flow_m3_h,
                was_flow_m3_h: self.config.clarifier.was_flow_m3_h,
                feed_tss: self.clarifier_flow.feed.suspended_solids(),
                overflow_tss: self.clarifier_flow.output.overflow_tss,
                underflow_tss: self.clarifier_flow.output.underflow_tss,
                layer_tss: self.clarifier_state.layers.clone(),
            },
            effluent: Asm2dEffluentSnapshot {
                flow_m3_h: self.flows.clarifier_overflow_flow_m3_h,
                cod: effluent.total_cod(),
                s_s: effluent.sf + effluent.sa,
                nh4_n: effluent.snh4,
                no3_n: effluent.sno3,
                tn: effluent.total_nitrogen(),
                tp: effluent.total_phosphorus(),
                po4_p: effluent.spo4,
                ss: effluent.suspended_solids(),
                dissolved_oxygen: effluent.so,
                alkalinity: effluent.salk,
            },
            waste: Asm2dWasteSnapshot {
                flow_m3_h: self.config.clarifier.was_flow_m3_h,
                cod: waste.total_cod(),
                tn: waste.total_nitrogen(),
                tp: waste.total_phosphorus(),
                ss: waste.suspended_solids(),
            },
            mass_balance: Asm2dMassBalance {
                cod,
                nitrogen,
                phosphorus,
                note: if closed {
                    "ASM2d COD/N/P ledger closed at the 5% threshold".to_owned()
                } else {
                    "ASM2d COD/N/P ledger residual exceeds 5%; inspect oxidation, storage and settler inventory terms".to_owned()
                },
            },
        }
    }

    fn inventory(&self) -> [f64; 3] {
        let mut inventory = [0.0; 3];
        for (reactor, state) in self.config.reactors.iter().zip(&self.state) {
            inventory[0] += reactor.volume_m3 * state.total_cod() / 1000.0;
            inventory[1] += reactor.volume_m3 * state.total_nitrogen() / 1000.0;
            inventory[2] += reactor.volume_m3 * state.total_phosphorus() / 1000.0;
        }
        let volume = self.config.clarifier.area_m2 * self.config.clarifier.depth_m;
        let avg_tss = self.clarifier_state.layers.iter().sum::<f64>()
            / self.clarifier_state.layers.len() as f64;
        let state = self.clarifier_flow.feed.with_particulate_tss(avg_tss);
        inventory[0] += volume * state.total_cod() / 1000.0;
        inventory[1] += volume * state.total_nitrogen() / 1000.0;
        inventory[2] += volume * state.total_phosphorus() / 1000.0;
        inventory
    }
}

fn ledger(
    inflow_kg: f64,
    effluent_kg: f64,
    waste_kg: f64,
    inventory_change_kg: f64,
    oxidized_kg: f64,
    gas_kg: f64,
) -> MassLedger {
    let unaccounted =
        inflow_kg - effluent_kg - waste_kg - inventory_change_kg - oxidized_kg - gas_kg;
    let residual_fraction = if inflow_kg.abs() > 1e-9 {
        unaccounted.abs() / inflow_kg.abs()
    } else {
        0.0
    };
    MassLedger {
        inflow_kg,
        effluent_kg,
        waste_kg,
        inventory_change_kg,
        oxidized_kg,
        gas_kg,
        unaccounted_kg: unaccounted,
        residual_fraction,
        closed: residual_fraction <= 0.05,
    }
}

fn component(state: &Asm2dState, index: usize) -> f64 {
    state.values()[index]
}

fn component_rate(rates: &crate::asm2d::Asm2dRates, index: usize) -> f64 {
    rates.values()[index]
}

fn set_component(state: &mut Asm2dState, index: usize, value: f64) {
    match index {
        0 => state.so = value,
        1 => state.sn2 = value,
        2 => state.snh4 = value,
        3 => state.sno3 = value,
        4 => state.spo4 = value,
        5 => state.sf = value,
        6 => state.sa = value,
        7 => state.si = value,
        8 => state.salk = value,
        9 => state.xi = value,
        10 => state.xs = value,
        11 => state.xh = value,
        12 => state.xpao = value,
        13 => state.xpp = value,
        14 => state.xpha = value,
        15 => state.xaut = value,
        16 => state.xmeoh = value,
        17 => state.xmep = value,
        _ => unreachable!("ASM2d has 18 independent components"),
    }
}

fn scale_state(state: &mut Asm2dState, factor: f64) {
    for index in 0..18 {
        set_component(state, index, component(state, index) * factor);
    }
}

fn mass_rate_kg_per_step(flow_m3_h: f64, concentration_mg_l: f64, dt_h: f64) -> f64 {
    flow_m3_h * concentration_mg_l * dt_h / 1000.0
}

fn saturation_do(temperature_c: f64) -> f64 {
    (9.1 - 0.2 * (temperature_c - 20.0)).clamp(6.0, 12.0)
}

/// Convenience for callers that only need the final snapshot.
pub fn simulate_asm2d(
    config: Asm2dPlantConfig,
    simulation: Asm2dSimulationConfig,
    params: Asm2dParams,
) -> Result<Asm2dPlantSnapshot, Asm2dPlantError> {
    let mut simulator = Asm2dSimulator::new(config, simulation, params)?;
    simulator.run()?;
    Ok(simulator.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initial() -> Asm2dState {
        Asm2dState {
            so: 0.0,
            sn2: 0.0,
            snh4: 20.0,
            sno3: 0.5,
            spo4: 5.0,
            sf: 20.0,
            sa: 20.0,
            si: 10.0,
            salk: 250.0,
            xi: 1000.0,
            xs: 200.0,
            xh: 1000.0,
            xpao: 300.0,
            xpp: 60.0,
            xpha: 40.0,
            xaut: 100.0,
            xmeoh: 5.0,
            xmep: 5.0,
        }
    }

    fn aerobic_initial() -> Asm2dState {
        let mut state = initial();
        state.so = 2.0;
        state.sno3 = 2.0;
        state
    }

    fn plant_config() -> Asm2dPlantConfig {
        let mut anaerobic = initial();
        anaerobic.so = 0.0;
        anaerobic.sno3 = 0.0;
        let mut anoxic = initial();
        anoxic.so = 0.1;
        anoxic.sno3 = 3.0;
        let mut aerobic = aerobic_initial();
        aerobic.so = 2.0;

        Asm2dPlantConfig {
            name: "A2O ASM2d test".to_owned(),
            influent: Asm2dInfluentConfig {
                flow_m3_h: 1000.0,
                state: Asm2dState {
                    so: 0.0,
                    sn2: 0.0,
                    snh4: 30.0,
                    sno3: 0.0,
                    spo4: 8.0,
                    sf: 100.0,
                    sa: 30.0,
                    si: 30.0,
                    salk: 300.0,
                    xi: 50.0,
                    xs: 150.0,
                    xh: 20.0,
                    xpao: 0.0,
                    xpp: 0.0,
                    xpha: 0.0,
                    xaut: 0.0,
                    xmeoh: 0.0,
                    xmep: 0.0,
                },
            },
            reactors: vec![
                Asm2dReactorConfig {
                    id: "anaerobic".to_owned(),
                    name: "Anaerobic".to_owned(),
                    kind: ReactorKind::Anaerobic,
                    volume_m3: 1000.0,
                    temperature_c: 20.0,
                    kla_h: 0.0,
                    do_setpoint: 0.0,
                    initial: anaerobic,
                },
                Asm2dReactorConfig {
                    id: "anoxic".to_owned(),
                    name: "Anoxic".to_owned(),
                    kind: ReactorKind::Anoxic,
                    volume_m3: 1000.0,
                    temperature_c: 20.0,
                    kla_h: 0.0,
                    do_setpoint: 0.0,
                    initial: anoxic,
                },
                Asm2dReactorConfig {
                    id: "aerobic-1".to_owned(),
                    name: "Aerobic 1".to_owned(),
                    kind: ReactorKind::Aerobic,
                    volume_m3: 2000.0,
                    temperature_c: 20.0,
                    kla_h: 4.0,
                    do_setpoint: 2.0,
                    initial: aerobic,
                },
                Asm2dReactorConfig {
                    id: "aerobic-2".to_owned(),
                    name: "Aerobic 2".to_owned(),
                    kind: ReactorKind::Aerobic,
                    volume_m3: 2000.0,
                    temperature_c: 20.0,
                    kla_h: 4.0,
                    do_setpoint: 2.0,
                    initial: aerobic,
                },
                Asm2dReactorConfig {
                    id: "aerobic-3".to_owned(),
                    name: "Aerobic 3".to_owned(),
                    kind: ReactorKind::Aerobic,
                    volume_m3: 2000.0,
                    temperature_c: 20.0,
                    kla_h: 4.0,
                    do_setpoint: 2.0,
                    initial: aerobic,
                },
            ],
            clarifier: Asm2dClarifierConfig {
                area_m2: 1500.0,
                depth_m: 4.0,
                layers: 10,
                feed_layer: 5,
                settling: SettlerParams::default(),
                ras_reactor: 0,
                ras_flow_m3_h: 1000.0,
                was_flow_m3_h: 20.0,
            },
            internal_recycles: vec![Asm2dRecycleConfig {
                from: 4,
                to: 1,
                flow_m3_h: 2000.0,
            }],
        }
    }

    #[test]
    fn a2o_flow_compilation_matches_train() {
        let flows = compile_flows(&plant_config()).expect("flows compile");
        assert!((flows.reactor_outflow[0] - 2000.0).abs() < 1e-9);
        assert!((flows.reactor_outflow[1] - 4000.0).abs() < 1e-9);
        assert!((flows.reactor_outflow[4] - 4000.0).abs() < 1e-9);
        assert!((flows.clarifier_feed_flow_m3_h - 2000.0).abs() < 1e-9);
        assert!((flows.clarifier_overflow_flow_m3_h - 980.0).abs() < 1e-9);
        assert!((flows.clarifier_underflow_flow_m3_h - 1020.0).abs() < 1e-9);
    }

    #[test]
    fn a2o_plant_runs_one_day_without_non_finite_state() {
        let mut simulator = Asm2dSimulator::new(
            plant_config(),
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 1440.0,
            },
            Asm2dParams::default(),
        )
        .expect("simulator");
        simulator.run().expect("one day");
        let snapshot = simulator.snapshot();
        assert_eq!(snapshot.step_count, 1440);
        assert!(snapshot
            .reactors
            .iter()
            .all(|reactor| reactor.state.is_finite_non_negative()));
        assert!(snapshot.effluent.cod.is_finite());
        assert!(snapshot.effluent.tp.is_finite());
    }

    #[test]
    fn anaerobic_zone_releases_phosphate() {
        let mut simulator = Asm2dSimulator::new(
            plant_config(),
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 360.0,
            },
            Asm2dParams::default(),
        )
        .expect("simulator");
        simulator.run().expect("six hours");
        let snapshot = simulator.snapshot();
        assert!(
            snapshot.reactors[0].state.spo4 > 5.0,
            "anaerobic PO4 release should raise S_PO4, got {}",
            snapshot.reactors[0].state.spo4
        );
        assert!(snapshot.reactors[0].state.xpha > 40.0);
    }

    #[test]
    fn mass_ledgers_are_finite_and_report_residual() {
        let mut simulator = Asm2dSimulator::new(
            plant_config(),
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 1440.0,
            },
            Asm2dParams::default(),
        )
        .expect("simulator");
        simulator.run().expect("one day");
        let snapshot = simulator.snapshot();
        let ledgers = [
            &snapshot.mass_balance.cod,
            &snapshot.mass_balance.nitrogen,
            &snapshot.mass_balance.phosphorus,
        ];
        for ledger in ledgers {
            assert!(ledger.inflow_kg.is_finite());
            assert!(ledger.residual_fraction.is_finite());
            assert!(ledger.unaccounted_kg.is_finite());
        }
    }
}

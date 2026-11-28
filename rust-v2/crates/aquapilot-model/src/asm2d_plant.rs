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

/// PAC (polyaluminium chloride) dosing into one reactor.
///
/// ASM2d already carries chemical precipitation through `X_MeOH` (metal
/// hydroxide) and `X_MeP` (metal phosphate). PAC is dosed as a product stream,
/// converted to an Al mass, and then represented as the model's trivalent
/// metal hydroxide equivalent. The ASM2d default Fe(OH)3/FePO4 coefficients
/// are kept: one mole of Al is treated as one mole of the model metal. This is
/// a deliberate simplification, not a claim that the model distinguishes Al
/// from Fe speciation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm2dPacConfig {
    /// Reactor receiving the PAC dose.
    pub reactor: usize,
    /// PAC product dose, mg/L of influent flow.
    #[serde(default)]
    pub dose_mg_l: f64,
    /// Al2O3 mass fraction of the PAC product (30% is a common liquid PAC).
    #[serde(default = "default_pac_al2o3_fraction")]
    pub al2o3_fraction: f64,
    /// Grams of model `X_MeOH` equivalent per gram of Al.
    #[serde(default = "default_pac_meoh_per_al")]
    pub meoh_per_al: f64,
}

fn default_pac_al2o3_fraction() -> f64 {
    0.30
}

fn default_pac_meoh_per_al() -> f64 {
    107.0 / 27.0
}

impl Asm2dPacConfig {
    fn product_kg_h(&self, influent_flow_m3_h: f64) -> f64 {
        self.dose_mg_l * influent_flow_m3_h / 1000.0
    }

    fn aluminum_kg_h(&self, influent_flow_m3_h: f64) -> f64 {
        self.product_kg_h(influent_flow_m3_h) * self.al2o3_fraction * 54.0 / 102.0
    }

    fn meoh_kg_h(&self, influent_flow_m3_h: f64) -> f64 {
        self.aluminum_kg_h(influent_flow_m3_h) * self.meoh_per_al
    }

    fn validate(&self, reactor_count: usize) -> Result<(), Asm2dPlantError> {
        if self.reactor >= reactor_count {
            return Err(Asm2dPlantError::InvalidConfig(
                "PAC reactor index is out of range".to_owned(),
            ));
        }
        if !self.dose_mg_l.is_finite() || self.dose_mg_l < 0.0 {
            return Err(Asm2dPlantError::InvalidConfig(
                "PAC dose must be finite and non-negative".to_owned(),
            ));
        }
        if !self.al2o3_fraction.is_finite() || !(0.0..=1.0).contains(&self.al2o3_fraction) {
            return Err(Asm2dPlantError::InvalidConfig(
                "PAC Al2O3 fraction must be in [0,1]".to_owned(),
            ));
        }
        if !self.meoh_per_al.is_finite() || self.meoh_per_al <= 0.0 {
            return Err(Asm2dPlantError::InvalidConfig(
                "PAC metal-hydroxide equivalent must be positive".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Idealized tertiary solids-contact filtration after the secondary clarifier.
///
/// The filter captures a fixed fraction of every particulate ASM2d component
/// while leaving dissolved species unchanged. Captured solids leave as a
/// separate cake stream; the filter does not model backwash water, media
/// head-loss or filtration kinetics. This is a boundary unit for effluent
/// polishing, not a full granular-filter model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Asm2dTertiaryConfig {
    /// Fraction of particulate ASM2d solids captured by the filter.
    #[serde(default = "default_tertiary_tss_removal")]
    pub tss_removal_fraction: f64,
    /// Fraction of dissolved S_PO4 removed by tertiary chemical polishing.
    ///
    /// This is an empirical boundary efficiency, not a stoichiometric Al/Fe
    /// precipitation model; the removed P is booked to the filter cake.
    #[serde(default)]
    pub po4_removal_fraction: f64,
}

fn default_tertiary_tss_removal() -> f64 {
    0.90
}

impl Asm2dTertiaryConfig {
    fn validate(&self) -> Result<(), Asm2dPlantError> {
        if !self.tss_removal_fraction.is_finite()
            || !(0.0..=1.0).contains(&self.tss_removal_fraction)
        {
            return Err(Asm2dPlantError::InvalidConfig(
                "tertiary TSS removal fraction must be in [0,1]".to_owned(),
            ));
        }
        if !self.po4_removal_fraction.is_finite()
            || !(0.0..=1.0).contains(&self.po4_removal_fraction)
        {
            return Err(Asm2dPlantError::InvalidConfig(
                "tertiary PO4 removal fraction must be in [0,1]".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dPlantConfig {
    pub name: String,
    pub influent: Asm2dInfluentConfig,
    pub reactors: Vec<Asm2dReactorConfig>,
    pub clarifier: Asm2dClarifierConfig,
    #[serde(default)]
    pub internal_recycles: Vec<Asm2dRecycleConfig>,
    #[serde(default)]
    pub pac: Option<Asm2dPacConfig>,
    #[serde(default)]
    pub tertiary: Option<Asm2dTertiaryConfig>,
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

/// Particulate component masses held in the settler, in kg. The settler's
/// TSS profile is computed by the Takacs layer model; this pool carries the
/// component composition so overflow/underflow and the plant ledger do not
/// revalue stored sludge at the current feed composition.
#[derive(Debug, Clone)]
struct SettlerSolids {
    masses: [f64; 9],
}

const SETTLER_PARTICULATE_FIELDS: [usize; 9] = [9, 10, 11, 12, 13, 14, 15, 16, 17];

impl SettlerSolids {
    fn from_state(state: &Asm2dState, volume_m3: f64) -> Self {
        let mut masses = [0.0; 9];
        for (slot, field) in SETTLER_PARTICULATE_FIELDS.iter().enumerate() {
            masses[slot] = component(state, *field) * volume_m3 / 1000.0;
        }
        Self { masses }
    }

    fn tss_kg(&self) -> f64 {
        0.75 * (self.masses[0] + self.masses[1])
            + 0.90 * (self.masses[2] + self.masses[3] + self.masses[6])
            + self.masses[4]
            + self.masses[5]
            + self.masses[7]
            + self.masses[8]
    }

    fn fractions(&self) -> [f64; 9] {
        let total = self.tss_kg();
        if total <= 1e-12 {
            return [0.0; 9];
        }
        let mut fractions = [0.0; 9];
        for (slot, mass) in self.masses.iter().enumerate() {
            fractions[slot] = (*mass / total).clamp(0.0, 1.0);
        }
        fractions
    }

    fn output_state(&self, feed: &Asm2dState, target_tss: f64) -> Asm2dState {
        let mut state = *feed;
        let fractions = self.fractions();
        for (slot, field) in SETTLER_PARTICULATE_FIELDS.iter().enumerate() {
            set_component(&mut state, *field, fractions[slot] * target_tss);
        }
        state
    }

    fn update(
        &mut self,
        feed: &Asm2dState,
        feed_flow_m3_h: f64,
        dt_h: f64,
        overflow_kg: f64,
        underflow_kg: f64,
        output_fractions: [f64; 9],
    ) {
        let feed_factor = feed_flow_m3_h * dt_h / 1000.0;
        for (slot, field) in SETTLER_PARTICULATE_FIELDS.iter().enumerate() {
            self.masses[slot] += component(feed, *field) * feed_factor;
            self.masses[slot] -= output_fractions[slot] * (overflow_kg + underflow_kg);
            self.masses[slot] = self.masses[slot].max(0.0);
        }
    }
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
    /// Full underflow state, used by the ASM2d -> ADM1 interface.
    pub state: Asm2dState,
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
pub struct Asm2dPacSnapshot {
    pub reactor: String,
    pub dose_mg_l: f64,
    pub basis_flow_m3_h: f64,
    pub al2o3_fraction: f64,
    pub meoh_per_al: f64,
    pub product_kg_d: f64,
    pub aluminum_kg_d: f64,
    pub meoh_kg_d: f64,
    pub total_product_kg: f64,
    pub total_meoh_kg: f64,
    pub net_chemical_p_removed_kg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Asm2dTertiarySnapshot {
    pub capture_fraction: f64,
    pub po4_removal_fraction: f64,
    pub inlet_tss: f64,
    pub outlet_tss: f64,
    pub removed_tss: f64,
    pub captured_solids_kg: f64,
    pub captured_cod_kg: f64,
    pub captured_nitrogen_kg: f64,
    pub captured_phosphorus_kg: f64,
    pub polishing_po4_removed_kg: f64,
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
    pub pac: Option<Asm2dPacSnapshot>,
    pub tertiary: Option<Asm2dTertiarySnapshot>,
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
    settler_solids: SettlerSolids,
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
    pac_product_kg: f64,
    pac_aluminum_kg: f64,
    pac_meoh_kg: f64,
    chemical_p_removed_kg: f64,
    tertiary_effluent: Asm2dState,
    tertiary_inlet_tss: f64,
    tertiary_outlet_tss: f64,
    tertiary_removed_tss: f64,
    tertiary_cake_solids_kg: f64,
    tertiary_chemical_p_kg: f64,
    tertiary_cake: [f64; 3],
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
        if let Some(pac) = &config.pac {
            pac.validate(config.reactors.len())?;
        }
        if let Some(tertiary) = &config.tertiary {
            tertiary.validate()?;
        }
        let flows = compile_flows(&config)?;
        let state: Vec<Asm2dState> = config.reactors.iter().map(|r| r.initial).collect();
        let feed = state[config.reactors.len() - 1];
        let clarifier_state = ClarifierState::new(
            config.clarifier.layers,
            config.clarifier.feed_layer,
            feed.suspended_solids(),
        )?;
        let settler_volume = config.clarifier.area_m2 * config.clarifier.depth_m;
        let settler_solids = SettlerSolids::from_state(&feed, settler_volume);
        let initial_tss = feed.suspended_solids();
        let settler_overflow = settler_solids.output_state(&feed, initial_tss);
        let mut settler_underflow = settler_solids.output_state(&feed, initial_tss);
        settler_underflow.so = 0.0;
        let clarifier_flow = ClarifierFlow {
            feed,
            overflow: settler_overflow,
            underflow: settler_underflow,
            output: ClarifierOutput {
                overflow_tss: initial_tss,
                underflow_tss: initial_tss,
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
            settler_solids,
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
            pac_product_kg: 0.0,
            pac_aluminum_kg: 0.0,
            pac_meoh_kg: 0.0,
            chemical_p_removed_kg: 0.0,
            tertiary_effluent: settler_overflow,
            tertiary_inlet_tss: 0.0,
            tertiary_outlet_tss: 0.0,
            tertiary_removed_tss: 0.0,
            tertiary_cake_solids_kg: 0.0,
            tertiary_chemical_p_kg: 0.0,
            tertiary_cake: [0.0; 3],
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
        let pac = self.config.pac;
        let influent_flow_m3_h = self.config.influent.flow_m3_h;

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
            let mut next = previous[index];
            if let Some(pac) = pac {
                if index == pac.reactor && pac.dose_mg_l > 0.0 {
                    let meoh_kg_h = pac.meoh_kg_h(influent_flow_m3_h);
                    next.xmeoh += meoh_kg_h * dt_h / reactor.volume_m3 * 1000.0;
                    self.pac_product_kg += pac.product_kg_h(influent_flow_m3_h) * dt_h;
                    self.pac_aluminum_kg += pac.aluminum_kg_h(influent_flow_m3_h) * dt_h;
                    self.pac_meoh_kg += meoh_kg_h * dt_h;
                }
            }
            let mut remaining_h = dt_h;
            let mut oxygen_step_kg = 0.0;
            let mut gas_step_kg = 0.0;
            // Positivity-preserving sub-stepping: explicit Euler can otherwise
            // drive S_PO4 below zero when PAO storage consumes the last
            // phosphate in a step, and clamping that back to zero would create
            // phosphorus in the ledger. Halving the reaction step keeps all
            // stoichiometric couplings intact.
            while remaining_h > 1e-12 {
                let mut h = remaining_h;
                let mut accepted = false;
                for _ in 0..24 {
                    let rates = reaction_rates(&next, &self.params, temperature_c);
                    let processes = process_rates(&next, &self.params, temperature_c);
                    let mut candidate = next;
                    for field in 0..18 {
                        let mixed_value = component(&mixed, field);
                        let previous_value = component(&next, field);
                        let rate = component_rate(&rates, field);
                        set_component(
                            &mut candidate,
                            field,
                            previous_value
                                + h * (dilution_per_h * (mixed_value - previous_value) + rate),
                        );
                    }
                    if candidate.spo4 < -1e-9 && h > 1e-9 {
                        h *= 0.5;
                        continue;
                    }
                    candidate.clamp_non_negative();
                    // COD oxidation is the heterotrophic / PAO oxygen demand.
                    // Autotrophic oxygen demand belongs to nitrification and
                    // must not be booked as organic COD oxidation.
                    let cod_oxygen = 0.6
                        * (processes.hetero_growth_sf
                            + processes.hetero_growth_sa
                            + processes.pao_aero_growth)
                        + 0.2 * processes.aero_storage_pp;
                    oxygen_step_kg += cod_oxygen.max(0.0) * reactor.volume_m3 * h / 1000.0;
                    // Chemical precipitation moves phosphate from the liquid
                    // into X_MeP. Track the net transfer separately so a PAC
                    // run can report how much P was chemically removed, while
                    // the COD/N/P ledger still sees the state transfer.
                    self.chemical_p_removed_kg +=
                        (processes.precipitation - processes.redissolution) * reactor.volume_m3 * h
                            / 1000.0;
                    // Dinitrogen strips immediately; book reaction production
                    // and zero the liquid pool to avoid double counting.
                    gas_step_kg += rates.sn2.max(0.0) * reactor.volume_m3 * h / 1000.0;
                    candidate.sn2 = 0.0;
                    next = candidate;
                    remaining_h -= h;
                    accepted = true;
                    break;
                }
                if !accepted {
                    return Err(Asm2dPlantError::NonFinite(self.time_min));
                }
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
            self.oxygen_consumed_kg += oxygen_step_kg;
            self.denitrified_n_kg += gas_step_kg;
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
        let output_fractions = self.settler_solids.fractions();
        // Use the solids mass integrated by the Takacs sub-stepping for the
        // stream composition. The instantaneous layer TSS can differ from the
        // step-average, and using it here would make the component pool and
        // the effluent/waste ledger debit different masses.
        let overflow_tss = if self.flows.clarifier_overflow_flow_m3_h * dt_h > 0.0 {
            output.overflow_mass_kg / (self.flows.clarifier_overflow_flow_m3_h * dt_h) * 1000.0
        } else {
            0.0
        };
        let underflow_tss = if self.flows.clarifier_underflow_flow_m3_h * dt_h > 0.0 {
            output.underflow_mass_kg / (self.flows.clarifier_underflow_flow_m3_h * dt_h) * 1000.0
        } else {
            0.0
        };
        let overflow = self.settler_solids.output_state(&feed, overflow_tss);
        let mut underflow = self.settler_solids.output_state(&feed, underflow_tss);
        underflow.so = 0.0;
        self.settler_solids.update(
            &feed,
            self.flows.clarifier_feed_flow_m3_h,
            dt_h,
            output.overflow_mass_kg,
            output.underflow_mass_kg,
            output_fractions,
        );
        self.clarifier_flow = ClarifierFlow {
            feed,
            overflow,
            underflow,
            output,
        };

        let mut effluent = self.clarifier_flow.overflow;
        let mut tertiary_cake = [0.0; 3];
        if let Some(tertiary) = self.config.tertiary {
            let capture = tertiary.tss_removal_fraction;
            self.tertiary_inlet_tss = effluent.suspended_solids();
            let mut filtered = effluent;
            let mut removed = Asm2dState::zeros();
            for field in SETTLER_PARTICULATE_FIELDS {
                let value = component(&effluent, field);
                let captured = value * capture;
                set_component(&mut filtered, field, value - captured);
                set_component(&mut removed, field, captured);
            }
            let polishing_po4 = filtered.spo4 * tertiary.po4_removal_fraction;
            filtered.spo4 -= polishing_po4;
            self.tertiary_outlet_tss = filtered.suspended_solids();
            self.tertiary_removed_tss = removed.suspended_solids();
            let overflow_flow = self.flows.clarifier_overflow_flow_m3_h;
            tertiary_cake[0] = mass_rate_kg_per_step(overflow_flow, removed.total_cod(), dt_h);
            tertiary_cake[1] = mass_rate_kg_per_step(overflow_flow, removed.total_nitrogen(), dt_h);
            tertiary_cake[2] =
                mass_rate_kg_per_step(overflow_flow, removed.total_phosphorus(), dt_h)
                    + mass_rate_kg_per_step(overflow_flow, polishing_po4, dt_h);
            self.tertiary_chemical_p_kg +=
                mass_rate_kg_per_step(overflow_flow, polishing_po4, dt_h);
            self.tertiary_cake_solids_kg +=
                mass_rate_kg_per_step(overflow_flow, removed.suspended_solids(), dt_h);
            self.tertiary_cake[0] += tertiary_cake[0];
            self.tertiary_cake[1] += tertiary_cake[1];
            self.tertiary_cake[2] += tertiary_cake[2];
            self.tertiary_effluent = filtered;
            effluent = filtered;
        } else {
            self.tertiary_effluent = effluent;
        }

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
        let waste = self.clarifier_flow.underflow;
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
        self.waste[0] +=
            mass_rate_kg_per_step(self.config.clarifier.was_flow_m3_h, waste.total_cod(), dt_h)
                + tertiary_cake[0];
        self.waste[1] += mass_rate_kg_per_step(
            self.config.clarifier.was_flow_m3_h,
            waste.total_nitrogen(),
            dt_h,
        ) + tertiary_cake[1];
        self.waste[2] += mass_rate_kg_per_step(
            self.config.clarifier.was_flow_m3_h,
            waste.total_phosphorus(),
            dt_h,
        ) + tertiary_cake[2];

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
        let effluent = self.tertiary_effluent;
        let waste = self.clarifier_flow.underflow;
        let tertiary_snapshot = self.config.tertiary.map(|tertiary| Asm2dTertiarySnapshot {
            capture_fraction: tertiary.tss_removal_fraction,
            po4_removal_fraction: tertiary.po4_removal_fraction,
            inlet_tss: self.tertiary_inlet_tss,
            outlet_tss: self.tertiary_outlet_tss,
            removed_tss: self.tertiary_removed_tss,
            captured_solids_kg: self.tertiary_cake_solids_kg,
            captured_cod_kg: self.tertiary_cake[0],
            captured_nitrogen_kg: self.tertiary_cake[1],
            captured_phosphorus_kg: self.tertiary_cake[2],
            polishing_po4_removed_kg: self.tertiary_chemical_p_kg,
        });
        let pac_snapshot = self.config.pac.map(|pac| {
            let influent_flow = self.config.influent.flow_m3_h;
            Asm2dPacSnapshot {
                reactor: self.config.reactors[pac.reactor].id.clone(),
                dose_mg_l: pac.dose_mg_l,
                basis_flow_m3_h: influent_flow,
                al2o3_fraction: pac.al2o3_fraction,
                meoh_per_al: pac.meoh_per_al,
                product_kg_d: pac.product_kg_h(influent_flow) * 24.0,
                aluminum_kg_d: pac.aluminum_kg_h(influent_flow) * 24.0,
                meoh_kg_d: pac.meoh_kg_h(influent_flow) * 24.0,
                total_product_kg: self.pac_product_kg,
                total_meoh_kg: self.pac_meoh_kg,
                net_chemical_p_removed_kg: self.chemical_p_removed_kg,
            }
        });
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
                state: waste,
            },
            pac: pac_snapshot,
            tertiary: tertiary_snapshot,
            mass_balance: Asm2dMassBalance {
                cod,
                nitrogen,
                phosphorus,
                note: if closed && self.config.tertiary.is_some() {
                    "ASM2d COD/N/P ledger closed at the 5% threshold; tertiary filter solids are included in waste_kg".to_owned()
                } else if closed {
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
        let mut state = self.clarifier_flow.feed;
        for (slot, field) in SETTLER_PARTICULATE_FIELDS.iter().enumerate() {
            set_component(
                &mut state,
                *field,
                self.settler_solids.masses[slot] / volume * 1000.0,
            );
        }
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
            pac: None,
            tertiary: None,
        }
    }

    #[test]
    fn tertiary_configuration_rejects_invalid_fraction() {
        assert!(Asm2dTertiaryConfig {
            tss_removal_fraction: -0.1,
            po4_removal_fraction: 0.0,
        }
        .validate()
        .is_err());
        assert!(Asm2dTertiaryConfig {
            tss_removal_fraction: 1.1,
            po4_removal_fraction: 0.0,
        }
        .validate()
        .is_err());
        assert!(Asm2dTertiaryConfig {
            tss_removal_fraction: 0.9,
            po4_removal_fraction: 1.1,
        }
        .validate()
        .is_err());
        assert!(Asm2dTertiaryConfig {
            tss_removal_fraction: 0.9,
            po4_removal_fraction: 0.7,
        }
        .validate()
        .is_ok());
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
    fn pac_configuration_rejects_invalid_reactor_and_dose() {
        let mut pac = Asm2dPacConfig {
            reactor: 5,
            dose_mg_l: 40.0,
            al2o3_fraction: 0.30,
            meoh_per_al: 107.0 / 27.0,
        };
        assert!(pac.validate(5).is_err());
        pac.reactor = 4;
        pac.dose_mg_l = -1.0;
        assert!(pac.validate(5).is_err());
        pac.dose_mg_l = 40.0;
        pac.al2o3_fraction = 1.1;
        assert!(pac.validate(5).is_err());
    }

    #[test]
    fn a2o_fixture_closes_three_ledgers() {
        let config: Asm2dPlantConfig =
            serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d.json"))
                .expect("A2O fixture");
        let snapshot = simulate_asm2d(
            config,
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 43_200.0,
            },
            Asm2dParams::default(),
        )
        .expect("30 day A2O run");
        assert!(snapshot.mass_balance.cod.closed);
        assert!(snapshot.mass_balance.nitrogen.closed);
        assert!(snapshot.mass_balance.phosphorus.closed);
        for ledger in [
            &snapshot.mass_balance.cod,
            &snapshot.mass_balance.nitrogen,
            &snapshot.mass_balance.phosphorus,
        ] {
            assert!(
                ledger.residual_fraction < 0.05,
                "ledger residual {} exceeds 5%",
                ledger.residual_fraction
            );
        }
        assert!(snapshot.effluent.cod < 60.0);
        assert!(snapshot.effluent.tp < 2.0);
        assert!(snapshot.effluent.nh4_n < 2.0);
    }

    #[test]
    fn pac_fixture_reduces_phosphate_and_keeps_ledger_closed() {
        let config: Asm2dPlantConfig =
            serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d-pac.json"))
                .expect("PAC fixture");
        let snapshot = simulate_asm2d(
            config,
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 43_200.0,
            },
            Asm2dParams::default(),
        )
        .expect("30 day PAC run");
        let pac = snapshot.pac.as_ref().expect("PAC snapshot");
        assert_eq!(pac.reactor, "aerobic-3");
        assert!(pac.product_kg_d > 0.0);
        assert!(pac.total_meoh_kg > 0.0);
        assert!(pac.net_chemical_p_removed_kg > 0.0);
        assert!(snapshot.effluent.po4_p < 0.5);
        assert!(snapshot.effluent.tp < 1.3);
        assert!(snapshot.mass_balance.phosphorus.closed);
    }

    #[test]
    fn tertiary_filter_polishes_pac_effluent_and_keeps_ledger_closed() {
        let mut config: Asm2dPlantConfig =
            serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d-pac.json"))
                .expect("PAC fixture");
        config.pac.as_mut().expect("PAC config").dose_mg_l = 20.0;
        config.tertiary = Some(Asm2dTertiaryConfig {
            tss_removal_fraction: 0.90,
            po4_removal_fraction: 0.70,
        });
        let snapshot = simulate_asm2d(
            config,
            Asm2dSimulationConfig {
                dt_min: 1.0,
                duration_min: 43_200.0,
            },
            Asm2dParams::default(),
        )
        .expect("30 day tertiary run");
        let tertiary = snapshot.tertiary.as_ref().expect("tertiary snapshot");
        assert!((tertiary.capture_fraction - 0.90).abs() < 1e-12);
        assert!(tertiary.captured_solids_kg > 0.0);
        assert!(tertiary.captured_phosphorus_kg > 0.0);
        assert!(tertiary.polishing_po4_removed_kg > 0.0);
        assert!(snapshot.effluent.ss < 3.0);
        assert!(snapshot.effluent.tp < 0.3);
        assert!(snapshot.effluent.po4_p < 0.1);
        assert!(snapshot.mass_balance.phosphorus.closed);
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

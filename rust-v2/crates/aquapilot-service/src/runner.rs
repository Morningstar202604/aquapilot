//! Experiment request validation and model execution.
//!
//! The runner deliberately calls the same public model functions as the CLI.
//! ASM1 and ASM2d are stepped one integration step at a time so a running
//! experiment can honor a cancel request; the coupled ASM2d/ADM1 loop is a
//! whole-plant function and is checked before and after the call.

use aquapilot_domain::PlantTopology;
use aquapilot_engine::{SimulationConfig, Simulator, Snapshot};
use aquapilot_model::adm1::{simulate_adm1, Adm1Config, Adm1Snapshot};
use aquapilot_model::adm1_sludge::{simulate_sludge_line, SludgeLineConfig};
use aquapilot_model::asm2d::Asm2dParams;
use aquapilot_model::asm2d_adm1_loop::{simulate_asm2d_adm1_loop, Asm2dAdm1LoopConfig};
use aquapilot_model::asm2d_parallel::{
    Asm2dParallelConfig, Asm2dParallelSimulator, Asm2dParallelSnapshot,
};
use aquapilot_model::asm2d_plant::{
    Asm2dPlantConfig, Asm2dPlantSnapshot, Asm2dSimulationConfig, Asm2dSimulator,
};
use aquapilot_model::asm2d_sludge::Asm2dSludgeConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::FieldError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelKind {
    Asm1,
    Asm2d,
    Asm2dParallel,
    Asm2dAdm1Loop,
    Adm1,
    SludgeLine,
}

impl ModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asm1 => "asm1",
            Self::Asm2d => "asm2d",
            Self::Asm2dParallel => "asm2d-parallel",
            Self::Asm2dAdm1Loop => "asm2d-adm1-loop",
            Self::Adm1 => "adm1",
            Self::SludgeLine => "sludge-line",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentRequest {
    pub name: String,
    pub model: ModelKind,
    /// Model-specific configuration. For `asm2d-adm1-loop` this is an
    /// `Asm2dAdm1LoopConfig` object (`plant`, `sludge`, ...).
    pub config: Value,
    #[serde(default = "default_duration_min")]
    pub duration_min: f64,
    #[serde(default = "default_dt_min")]
    pub dt_min: f64,
    #[serde(default = "default_sample_every_min")]
    pub sample_every_min: f64,
    #[serde(default = "default_sludge_days")]
    pub sludge_days: f64,
    #[serde(default = "default_sludge_dt_days")]
    pub sludge_dt_days: f64,
    #[serde(default)]
    pub max_iterations: usize,
    #[serde(default)]
    pub relaxation: f64,
}

fn default_duration_min() -> f64 {
    1440.0
}
fn default_dt_min() -> f64 {
    1.0
}
fn default_sample_every_min() -> f64 {
    60.0
}
fn default_sludge_days() -> f64 {
    30.0
}
fn default_sludge_dt_days() -> f64 {
    0.002
}

/// Upper bound for a single experiment's integration loop. The service is
/// single-worker, so an unbounded request would monopolize the queue.
const MAX_INTEGRATION_STEPS: f64 = 5_000_000.0;
const MAX_SAMPLES: f64 = 1_000_000.0;
const MAX_SLUDGE_DAYS: f64 = 3_650.0;
const MAX_ITERATIONS: usize = 64;

impl ExperimentRequest {
    pub fn validate(&self) -> Result<(), Vec<FieldError>> {
        let mut errors = Vec::new();
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 128 {
            errors.push(field(
                "name",
                "LENGTH",
                "name must contain 1 to 128 non-whitespace characters",
            ));
        }
        if !self.duration_min.is_finite() || !(1.0..=525_600.0).contains(&self.duration_min) {
            errors.push(field(
                "duration_min",
                "RANGE",
                "duration_min must be between 1 and 525600 minutes",
            ));
        }
        if !self.dt_min.is_finite() || !(0.0..=1.0).contains(&self.dt_min) || self.dt_min == 0.0 {
            errors.push(field(
                "dt_min",
                "RANGE",
                "dt_min must be greater than 0 and at most 1 minute",
            ));
        }
        if !self.sample_every_min.is_finite() || self.sample_every_min <= 0.0 {
            errors.push(field(
                "sample_every_min",
                "RANGE",
                "sample_every_min must be positive",
            ));
        }
        let integration_steps = self.duration_min / self.dt_min;
        if !integration_steps.is_finite() || integration_steps > MAX_INTEGRATION_STEPS {
            errors.push(field(
                "duration_min",
                "STEP_BUDGET",
                format!(
                    "duration_min / dt_min must be at most {MAX_INTEGRATION_STEPS:.0} integration steps"
                ),
            ));
        }
        let sample_count = self.duration_min / self.sample_every_min;
        if !sample_count.is_finite() || sample_count > MAX_SAMPLES {
            errors.push(field(
                "sample_every_min",
                "SAMPLE_BUDGET",
                format!("duration_min / sample_every_min must be at most {MAX_SAMPLES:.0} samples"),
            ));
        }
        if !self.sludge_days.is_finite()
            || self.sludge_days <= 0.0
            || self.sludge_days > MAX_SLUDGE_DAYS
        {
            errors.push(field(
                "sludge_days",
                "RANGE",
                format!("sludge_days must be positive and at most {MAX_SLUDGE_DAYS:.0} days"),
            ));
        }
        if !self.sludge_dt_days.is_finite() || self.sludge_dt_days <= 0.0 {
            errors.push(field(
                "sludge_dt_days",
                "RANGE",
                "sludge_dt_days must be positive",
            ));
        } else {
            let sludge_steps =
                self.sludge_days.max(self.duration_min / 1440.0) / self.sludge_dt_days;
            if !sludge_steps.is_finite() || sludge_steps > MAX_INTEGRATION_STEPS {
                errors.push(field(
                    "sludge_dt_days",
                    "STEP_BUDGET",
                    format!(
                        "max(sludge_days, duration_min / 1440) / sludge_dt_days must be at most {MAX_INTEGRATION_STEPS:.0} steps"
                    ),
                ));
            }
        }
        if self.max_iterations > MAX_ITERATIONS {
            errors.push(field(
                "max_iterations",
                "RANGE",
                format!("max_iterations must be 0 (default) or at most {MAX_ITERATIONS}"),
            ));
        }
        if self.relaxation != 0.0
            && (!self.relaxation.is_finite() || !(0.0..=1.0).contains(&self.relaxation))
        {
            errors.push(field(
                "relaxation",
                "RANGE",
                "relaxation must be 0 (default) or within [0, 1]",
            ));
        }
        if !self.config.is_object() {
            errors.push(field(
                "config",
                "TYPE",
                "config must be a JSON object for the selected model",
            ));
            return Err(errors);
        }
        if let Err(message) = self.validate_config() {
            errors.push(field("config", "MODEL_CONFIG", message));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    fn validate_config(&self) -> Result<(), String> {
        match self.model {
            ModelKind::Asm1 => serde_json::from_value::<PlantTopology>(self.config.clone())
                .map(|_| ())
                .map_err(|error| format!("invalid ASM1 plant topology: {error}")),
            ModelKind::Asm2d => serde_json::from_value::<Asm2dPlantConfig>(self.config.clone())
                .map(|_| ())
                .map_err(|error| format!("invalid ASM2d plant config: {error}")),
            ModelKind::Asm2dParallel => {
                serde_json::from_value::<Asm2dParallelConfig>(self.config.clone())
                    .map(|_| ())
                    .map_err(|error| format!("invalid ASM2d parallel config: {error}"))
            }
            ModelKind::Asm2dAdm1Loop => {
                serde_json::from_value::<LoopConfigInput>(self.config.clone())
                    .map(|_| ())
                    .map_err(|error| format!("invalid ASM2d/ADM1 loop config: {error}"))
            }
            ModelKind::Adm1 => serde_json::from_value::<Adm1Config>(self.config.clone())
                .map(|_| ())
                .map_err(|error| format!("invalid ADM1 config: {error}")),
            ModelKind::SludgeLine => {
                serde_json::from_value::<SludgeLineConfig>(self.config.clone())
                    .map(|_| ())
                    .map_err(|error| format!("invalid sludge-line config: {error}"))
            }
        }
    }
}

fn field(field: &str, code: &str, detail: impl Into<String>) -> FieldError {
    FieldError {
        field: field.to_owned(),
        code: code.to_owned(),
        detail: detail.into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sample {
    pub minute: f64,
    pub flow_m3_h: f64,
    pub cod: f64,
    pub bod: Option<f64>,
    pub ss: f64,
    pub nh4_n: f64,
    pub tn: f64,
    pub tp: f64,
    pub po4_p: Option<f64>,
    pub ph: Option<f64>,
    pub temperature_c: Option<f64>,
    pub do_mg_l: f64,
    pub mlss: Option<f64>,
    pub srt_d: Option<f64>,
    pub energy_kw: Option<f64>,
    pub score: Option<f64>,
    pub blanket_depth_m: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub snapshot: Value,
    pub samples: Vec<Sample>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("experiment was cancelled")]
    Cancelled,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("simulation failed: {0}")]
    Simulation(String),
}

pub fn run(
    request: &ExperimentRequest,
    cancel: &dyn Fn() -> bool,
    progress: &dyn Fn(f64),
) -> Result<RunResult, RunError> {
    match request.model {
        ModelKind::Asm1 => run_asm1(request, cancel, progress),
        ModelKind::Asm2d => run_asm2d(request, cancel, progress),
        ModelKind::Asm2dParallel => run_asm2d_parallel(request, cancel, progress),
        ModelKind::Asm2dAdm1Loop => run_loop(request, cancel, progress),
        ModelKind::Adm1 => run_adm1(request),
        ModelKind::SludgeLine => run_sludge_line(request),
    }
}

fn run_asm1(
    request: &ExperimentRequest,
    cancel: &dyn Fn() -> bool,
    progress: &dyn Fn(f64),
) -> Result<RunResult, RunError> {
    let topology: PlantTopology = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid ASM1 topology: {error}")))?;
    let simulation = SimulationConfig {
        dt_min: request.dt_min,
        duration_min: request.duration_min,
    };
    let mut simulator = Simulator::new(&topology, simulation, Default::default())
        .map_err(|error| RunError::Simulation(error.to_string()))?;
    let steps = (request.duration_min / request.dt_min).round().max(1.0) as u64;
    let interval = (request.sample_every_min / request.dt_min).round().max(1.0) as u64;
    let mut samples = Vec::new();
    for step in 0..steps {
        if cancel() {
            return Err(RunError::Cancelled);
        }
        simulator
            .step()
            .map_err(|error| RunError::Simulation(error.to_string()))?;
        if step % interval == 0 || step + 1 == steps {
            samples.push(sample_from_asm1(&simulator.snapshot()));
        }
        if step % 60 == 0 {
            progress((step + 1) as f64 / steps as f64);
        }
    }
    progress(1.0);
    let snapshot = snapshot_from_asm1(&simulator.snapshot());
    let final_sample = sample_from_asm1(&simulator.snapshot());
    push_final_sample(&mut samples, final_sample);
    Ok(RunResult { snapshot, samples })
}

fn run_asm2d(
    request: &ExperimentRequest,
    cancel: &dyn Fn() -> bool,
    progress: &dyn Fn(f64),
) -> Result<RunResult, RunError> {
    let config: Asm2dPlantConfig = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid ASM2d config: {error}")))?;
    let simulation = Asm2dSimulationConfig {
        dt_min: request.dt_min,
        duration_min: request.duration_min,
    };
    let mut simulator = Asm2dSimulator::new(config, simulation, Asm2dParams::default())
        .map_err(|error| RunError::Simulation(error.to_string()))?;
    let steps = (request.duration_min / request.dt_min).round().max(1.0) as u64;
    let interval = (request.sample_every_min / request.dt_min).round().max(1.0) as u64;
    let mut samples = Vec::new();
    for step in 0..steps {
        if cancel() {
            return Err(RunError::Cancelled);
        }
        simulator
            .step()
            .map_err(|error| RunError::Simulation(error.to_string()))?;
        if step % interval == 0 || step + 1 == steps {
            samples.push(sample_from_asm2d(&simulator.snapshot()));
        }
        if step % 60 == 0 {
            progress((step + 1) as f64 / steps as f64);
        }
    }
    progress(1.0);
    let snapshot = snapshot_from_asm2d(&simulator.snapshot());
    let final_sample = sample_from_asm2d(&simulator.snapshot());
    push_final_sample(&mut samples, final_sample);
    Ok(RunResult { snapshot, samples })
}

fn run_asm2d_parallel(
    request: &ExperimentRequest,
    cancel: &dyn Fn() -> bool,
    progress: &dyn Fn(f64),
) -> Result<RunResult, RunError> {
    let config: Asm2dParallelConfig = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid ASM2d parallel config: {error}")))?;
    let simulation = Asm2dSimulationConfig {
        dt_min: request.dt_min,
        duration_min: request.duration_min,
    };
    let mut simulator = Asm2dParallelSimulator::new(config, simulation, Asm2dParams::default())
        .map_err(|error| RunError::Simulation(error.to_string()))?;
    let steps = (request.duration_min / request.dt_min).round().max(1.0) as u64;
    let interval = (request.sample_every_min / request.dt_min).round().max(1.0) as u64;
    let mut samples = Vec::new();
    for step in 0..steps {
        if cancel() {
            return Err(RunError::Cancelled);
        }
        simulator
            .step()
            .map_err(|error| RunError::Simulation(error.to_string()))?;
        if step % interval == 0 || step + 1 == steps {
            samples.push(sample_from_asm2d_parallel(&simulator.snapshot()));
        }
        if step % 60 == 0 {
            progress((step + 1) as f64 / steps as f64);
        }
    }
    progress(1.0);
    let snapshot = simulator.snapshot();
    let final_sample = sample_from_asm2d_parallel(&snapshot);
    let serialized = serde_json::to_value(&snapshot).unwrap_or_else(|error| {
        serde_json::json!({"error": format!("failed to serialize ASM2d parallel snapshot: {error}")})
    });
    push_final_sample(&mut samples, final_sample);
    Ok(RunResult {
        snapshot: serialized,
        samples,
    })
}

#[derive(Debug, Clone, Deserialize)]
struct LoopConfigInput {
    plant: Asm2dPlantConfig,
    #[serde(default)]
    sludge: Option<Asm2dSludgeConfig>,
    #[serde(default)]
    max_iterations: Option<usize>,
    #[serde(default)]
    relaxation: Option<f64>,
    #[serde(default)]
    tolerance: Option<f64>,
}

fn run_loop(
    request: &ExperimentRequest,
    cancel: &dyn Fn() -> bool,
    progress: &dyn Fn(f64),
) -> Result<RunResult, RunError> {
    let input: LoopConfigInput = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid ASM2d/ADM1 loop config: {error}")))?;
    let mut config = Asm2dAdm1LoopConfig {
        plant: input.plant,
        sludge: input.sludge.unwrap_or_default(),
        max_iterations: input.max_iterations.unwrap_or(6),
        relaxation: input.relaxation.unwrap_or(0.5),
        tolerance: input.tolerance.unwrap_or(1.0e-3),
    };
    if request.max_iterations > 0 {
        config.max_iterations = request.max_iterations;
    }
    if request.relaxation > 0.0 {
        config.relaxation = request.relaxation;
    }
    let simulation = Asm2dSimulationConfig {
        dt_min: request.dt_min,
        duration_min: request.duration_min,
    };
    if cancel() {
        return Err(RunError::Cancelled);
    }
    progress(0.05);
    let snapshot = simulate_asm2d_adm1_loop(
        &config,
        simulation,
        request.sludge_days,
        request.sludge_dt_days,
    )
    .map_err(|error| RunError::Simulation(error.to_string()))?;
    if cancel() {
        return Err(RunError::Cancelled);
    }
    progress(0.95);
    let sample = sample_from_asm2d(&snapshot.asm2d);
    Ok(RunResult {
        snapshot: serde_json::to_value(&snapshot)
            .map_err(|error| RunError::Simulation(error.to_string()))?,
        samples: vec![sample],
    })
}

fn run_adm1(request: &ExperimentRequest) -> Result<RunResult, RunError> {
    let config: Adm1Config = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid ADM1 config: {error}")))?;
    let days = request.duration_min / 1440.0;
    let snapshot = simulate_adm1(&config, days, request.sludge_dt_days)
        .map_err(|error| RunError::Simulation(error.to_string()))?;
    let sample = sample_from_adm1(&snapshot, config.flow_m3_per_d / 24.0);
    Ok(RunResult {
        snapshot: serde_json::to_value(&snapshot)
            .map_err(|error| RunError::Simulation(error.to_string()))?,
        samples: vec![sample],
    })
}

fn run_sludge_line(request: &ExperimentRequest) -> Result<RunResult, RunError> {
    let config: SludgeLineConfig = serde_json::from_value(request.config.clone())
        .map_err(|error| RunError::Invalid(format!("invalid sludge-line config: {error}")))?;
    let days = request.duration_min / 1440.0;
    let snapshot = simulate_sludge_line(&config, days, request.sludge_dt_days)
        .map_err(|error| RunError::Simulation(error.to_string()))?;
    let sample = sample_from_adm1(&snapshot.digester, config.feed.flow_m3_per_d / 24.0);
    Ok(RunResult {
        snapshot: serde_json::to_value(&snapshot)
            .map_err(|error| RunError::Simulation(error.to_string()))?,
        samples: vec![sample],
    })
}

fn snapshot_from_asm1(snapshot: &Snapshot) -> Value {
    serde_json::to_value(snapshot).unwrap_or_else(|error| {
        serde_json::json!({
            "error": format!("failed to serialize ASM1 snapshot: {error}")
        })
    })
}

fn snapshot_from_asm2d(snapshot: &Asm2dPlantSnapshot) -> Value {
    serde_json::to_value(snapshot).unwrap_or_else(|error| {
        serde_json::json!({
            "error": format!("failed to serialize ASM2d snapshot: {error}")
        })
    })
}

fn sample_from_asm1(snapshot: &Snapshot) -> Sample {
    let effluent = &snapshot.effluent;
    Sample {
        minute: snapshot.time_min,
        flow_m3_h: effluent.flow_m3_h,
        cod: effluent.cod,
        bod: None,
        ss: effluent.ss,
        nh4_n: effluent.nh4_n,
        tn: effluent.tn,
        tp: effluent.tp,
        po4_p: None,
        ph: None,
        temperature_c: None,
        do_mg_l: effluent.dissolved_oxygen,
        mlss: None,
        srt_d: None,
        energy_kw: None,
        score: None,
        blanket_depth_m: None,
    }
}

fn sample_from_asm2d(snapshot: &Asm2dPlantSnapshot) -> Sample {
    let effluent = &snapshot.effluent;
    Sample {
        minute: snapshot.time_min,
        flow_m3_h: effluent.flow_m3_h,
        cod: effluent.cod,
        bod: None,
        ss: effluent.ss,
        nh4_n: effluent.nh4_n,
        tn: effluent.tn,
        tp: effluent.tp,
        po4_p: Some(effluent.po4_p),
        ph: None,
        temperature_c: None,
        do_mg_l: effluent.dissolved_oxygen,
        mlss: None,
        srt_d: None,
        energy_kw: None,
        score: None,
        blanket_depth_m: None,
    }
}

fn sample_from_asm2d_parallel(snapshot: &Asm2dParallelSnapshot) -> Sample {
    let effluent = &snapshot.effluent;
    Sample {
        minute: snapshot.time_min,
        flow_m3_h: effluent.flow_m3_h,
        cod: effluent.cod,
        bod: None,
        ss: effluent.ss,
        nh4_n: effluent.nh4_n,
        tn: effluent.tn,
        tp: effluent.tp,
        po4_p: Some(effluent.po4_p),
        ph: None,
        temperature_c: None,
        do_mg_l: effluent.dissolved_oxygen,
        mlss: None,
        srt_d: None,
        energy_kw: None,
        score: None,
        blanket_depth_m: None,
    }
}

fn sample_from_adm1(snapshot: &Adm1Snapshot, flow_m3_h: f64) -> Sample {
    Sample {
        minute: snapshot.days * 1440.0,
        flow_m3_h,
        cod: snapshot.effluent.cod() * 1000.0,
        bod: None,
        ss: snapshot.effluent.suspended_solids() * 1000.0,
        nh4_n: snapshot.effluent.nitrogen() * 1000.0,
        tn: snapshot.effluent.nitrogen() * 1000.0,
        tp: 0.0,
        po4_p: None,
        ph: Some(snapshot.ph),
        temperature_c: None,
        do_mg_l: 0.0,
        mlss: None,
        srt_d: None,
        energy_kw: Some(snapshot.biogas_m3_per_d),
        score: None,
        blanket_depth_m: None,
    }
}

fn push_final_sample(samples: &mut Vec<Sample>, final_sample: Sample) {
    if let Some(last) = samples.last() {
        if (last.minute - final_sample.minute).abs() < 1e-9 {
            *samples.last_mut().expect("sample exists") = final_sample;
            return;
        }
    }
    samples.push(final_sample);
}

/// Render a RFC 4180-ish CSV with a stable column order.
pub fn samples_csv(samples: &[Sample]) -> String {
    let mut text = String::from(
        "minute,flow_m3_h,cod_mg_l,bod_mg_l,ss_mg_l,nh4_n_mg_l,tn_mg_l,tp_mg_l,po4_p_mg_l,ph,temperature_c,do_mg_l,mlss_mg_l,srt_d,energy_kw,score,blanket_depth_m\n",
    );
    for sample in samples {
        text.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            sample.minute,
            sample.flow_m3_h,
            sample.cod,
            option_number(sample.bod),
            sample.ss,
            sample.nh4_n,
            sample.tn,
            sample.tp,
            option_number(sample.po4_p),
            option_number(sample.ph),
            option_number(sample.temperature_c),
            sample.do_mg_l,
            option_number(sample.mlss),
            option_number(sample.srt_d),
            option_number(sample.energy_kw),
            option_number(sample.score),
            option_number(sample.blanket_depth_m),
        ));
    }
    text
}

fn option_number(value: Option<f64>) -> String {
    value.map_or_else(String::new, |number| number.to_string())
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    fn valid_request() -> ExperimentRequest {
        let config: Value =
            serde_json::from_str(include_str!("../../../fixtures/adm1-tutorial.json"))
                .expect("ADM1 fixture");
        ExperimentRequest {
            name: "validation".to_owned(),
            model: ModelKind::Adm1,
            config,
            duration_min: 1440.0,
            dt_min: 1.0,
            sample_every_min: 60.0,
            sludge_days: 30.0,
            sludge_dt_days: 0.002,
            max_iterations: 0,
            relaxation: 0.0,
        }
    }

    #[test]
    fn accepts_default_request() {
        valid_request().validate().expect("default request");
    }

    #[test]
    fn parallel_model_runs_stepwise_and_aggregates() {
        let config: Value =
            serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d-2train.json"))
                .expect("2-train fixture");
        let request = ExperimentRequest {
            name: "parallel".to_owned(),
            model: ModelKind::Asm2dParallel,
            config,
            duration_min: 120.0,
            dt_min: 1.0,
            sample_every_min: 60.0,
            sludge_days: 30.0,
            sludge_dt_days: 0.002,
            max_iterations: 0,
            relaxation: 0.0,
        };
        request.validate().expect("parallel request");
        let result = run(&request, &|| false, &|_| {}).expect("parallel run");
        assert_eq!(result.snapshot["train_count"], 2);
        assert!(result.snapshot["effluent"]["flow_m3_h"].as_f64().unwrap() > 0.0);
        assert_eq!(result.samples.len(), 3);
    }

    #[test]
    fn rejects_unbounded_integration_and_sampling() {
        let mut request = valid_request();
        request.duration_min = 525_600.0;
        request.dt_min = 1.0e-9;
        let errors = request.validate().expect_err("step budget");
        assert!(errors.iter().any(|error| error.code == "STEP_BUDGET"));

        let mut request = valid_request();
        request.sample_every_min = 1.0e-6;
        let errors = request.validate().expect_err("sample budget");
        assert!(errors.iter().any(|error| error.code == "SAMPLE_BUDGET"));
    }

    #[test]
    fn rejects_zero_or_negative_sludge_dt() {
        let mut request = valid_request();
        request.sludge_dt_days = 0.0;
        let errors = request.validate().expect_err("zero dt");
        assert!(errors.iter().any(|error| error.field == "sludge_dt_days"));

        request.sludge_dt_days = -0.002;
        let errors = request.validate().expect_err("negative dt");
        assert!(errors.iter().any(|error| error.field == "sludge_dt_days"));
    }

    #[test]
    fn rejects_unbounded_iterations_and_relaxation() {
        let mut request = valid_request();
        request.max_iterations = 65;
        let errors = request.validate().expect_err("iterations");
        assert!(errors.iter().any(|error| error.field == "max_iterations"));

        let mut request = valid_request();
        request.relaxation = 1.5;
        let errors = request.validate().expect_err("relaxation");
        assert!(errors.iter().any(|error| error.field == "relaxation"));
    }

    #[test]
    fn rejects_invalid_sludge_days() {
        let mut request = valid_request();
        request.sludge_days = 0.0;
        let errors = request.validate().expect_err("days");
        assert!(errors.iter().any(|error| error.field == "sludge_days"));
    }
}

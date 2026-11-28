use std::path::PathBuf;

use aquapilot_domain::PlantTopology;
use aquapilot_engine::{simulate, CompiledPlant, SimulationConfig, Simulator};
use aquapilot_model::adm1::{simulate_adm1, Adm1Config};
use aquapilot_model::adm1_sludge::{simulate_sludge_line, SludgeLineConfig};
use aquapilot_model::asm2d::Asm2dParams;
use aquapilot_model::asm2d_adm1_loop::{simulate_asm2d_adm1_loop, Asm2dAdm1LoopConfig};
use aquapilot_model::asm2d_parallel::{simulate_asm2d_parallel, Asm2dParallelConfig};
use aquapilot_model::asm2d_plant::{
    simulate_asm2d, Asm2dPacConfig, Asm2dPlantConfig, Asm2dSimulationConfig, Asm2dTertiaryConfig,
};
use aquapilot_model::asm2d_sludge::{simulate_asm2d_sludge, Asm2dSludgeConfig};
use aquapilot_model::Asm1Params;
use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "aquapilot-v2",
    about = "AquaPilot clean-room simulation engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ParamSet {
    /// ASM1 20 degC reference set.
    Default,
    /// Public BSM1 open-loop set quoted at 15 degC.
    Bsm1,
    /// BSM1-calibrated candidate (eta_h = 0.6); pair with bsm1-calibrated fixture.
    Bsm1Cal,
}

impl ParamSet {
    fn params(self) -> Asm1Params {
        match self {
            Self::Default => Asm1Params::default(),
            Self::Bsm1 => Asm1Params::bsm1_15c(),
            Self::Bsm1Cal => Asm1Params::bsm1_calibrated(),
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the persistent experiment API.
    Serve {
        /// Bind address for the HTTP API.
        #[arg(long, default_value = "127.0.0.1:5173")]
        bind: String,
        /// SQLite database path.
        #[arg(long, default_value = "aquapilot.sqlite")]
        db: PathBuf,
        /// Maximum queued + running experiments.
        #[arg(long, default_value_t = 32)]
        queue_capacity: usize,
    },
    /// Write a consistent SQLite backup of the experiment database.
    Backup {
        /// Source SQLite database path.
        #[arg(long, default_value = "aquapilot.sqlite")]
        db: PathBuf,
        /// Destination file path.
        #[arg(long)]
        out: PathBuf,
        /// Replace an existing destination file.
        #[arg(long)]
        force: bool,
    },
    /// Validate and compile a topology file without running it.
    Validate {
        /// Path to the topology JSON file.
        topology: PathBuf,
    },
    /// Run an ASM1 simulation and write a snapshot.
    Simulate {
        /// Path to the topology JSON file.
        topology: PathBuf,
        /// Simulated duration in minutes.
        #[arg(long, default_value_t = 1440.0)]
        minutes: f64,
        /// Time step in minutes, at most 1.0.
        #[arg(long, default_value_t = 1.0)]
        dt: f64,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
        /// Kinetic parameter set.
        #[arg(long, value_enum, default_value_t = ParamSet::Default)]
        params: ParamSet,
    },
    /// Run the ADM1 anaerobic digester CSTR from a JSON configuration.
    Adm1 {
        /// Path to the ADM1 configuration JSON file.
        config: PathBuf,
        /// Simulated duration in days.
        #[arg(long, default_value_t = 10.0)]
        days: f64,
        /// Time step in days.
        #[arg(long, default_value_t = 0.002)]
        dt: f64,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
    /// Run the ADM1 sludge line (thickener, digester, dewatering).
    SludgeLine {
        /// Path to the sludge-line JSON file.
        config: PathBuf,
        /// Simulated duration in days.
        #[arg(long, default_value_t = 20.0)]
        days: f64,
        /// Time step in days.
        #[arg(long, default_value_t = 0.002)]
        dt: f64,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
    /// Run A2O, then route its waste state through the ADM1 sludge line.
    Asm2dSludge {
        /// Path to the ASM2d plant JSON file.
        config: PathBuf,
        /// A2O duration in minutes.
        #[arg(long, default_value_t = 43200.0)]
        minutes: f64,
        /// A2O time step in minutes, at most 1.0.
        #[arg(long, default_value_t = 1.0)]
        dt: f64,
        /// Sludge-line duration in days.
        #[arg(long, default_value_t = 20.0)]
        sludge_days: f64,
        /// Sludge-line time step in days.
        #[arg(long, default_value_t = 0.002)]
        sludge_dt: f64,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
    /// Run A2O + ADM1 sludge line with filtrate returned to the A2O influent.
    Asm2dLoop {
        /// Path to the ASM2d plant JSON file.
        config: PathBuf,
        /// A2O duration in minutes.
        #[arg(long, default_value_t = 43200.0)]
        minutes: f64,
        /// A2O time step in minutes, at most 1.0.
        #[arg(long, default_value_t = 1.0)]
        dt: f64,
        /// Sludge-line duration in days.
        #[arg(long, default_value_t = 20.0)]
        sludge_days: f64,
        /// Sludge-line time step in days.
        #[arg(long, default_value_t = 0.002)]
        sludge_dt: f64,
        /// Maximum successive-substitution iterations.
        #[arg(long, default_value_t = 4)]
        max_iterations: usize,
        /// Successive-substitution relaxation (0-1].
        #[arg(long, default_value_t = 0.5)]
        relaxation: f64,
        /// PAC product dose in mg/L of influent; overrides the fixture.
        #[arg(long)]
        pac_dose: Option<f64>,
        /// Reactor index receiving PAC; defaults to the final reactor.
        #[arg(long)]
        pac_reactor: Option<usize>,
        /// Al2O3 mass fraction of the PAC product.
        #[arg(long)]
        pac_al2o3_fraction: Option<f64>,
        /// Tertiary filter TSS capture fraction; overrides the fixture.
        #[arg(long)]
        tertiary_tss_removal: Option<f64>,
        /// Tertiary dissolved-PO4 polishing removal fraction; overrides the fixture.
        #[arg(long)]
        tertiary_po4_removal: Option<f64>,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
    /// Run parallel ASM2d trains (multi-series clarifiers) and aggregate the plant.
    Asm2dParallel {
        /// Path to the parallel ASM2d plant JSON file.
        config: PathBuf,
        /// Simulated duration in minutes.
        #[arg(long, default_value_t = 43200.0)]
        minutes: f64,
        /// Time step in minutes, at most 1.0.
        #[arg(long, default_value_t = 1.0)]
        dt: f64,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
    /// Run an ASM2d whole-plant simulation from an A2O-style configuration.
    Asm2d {
        /// Path to the ASM2d plant JSON file.
        config: PathBuf,
        /// Simulated duration in minutes.
        #[arg(long, default_value_t = 43200.0)]
        minutes: f64,
        /// Time step in minutes, at most 1.0.
        #[arg(long, default_value_t = 1.0)]
        dt: f64,
        /// PAC product dose in mg/L of influent; overrides the fixture.
        #[arg(long)]
        pac_dose: Option<f64>,
        /// Reactor index receiving PAC; defaults to the final reactor.
        #[arg(long)]
        pac_reactor: Option<usize>,
        /// Al2O3 mass fraction of the PAC product.
        #[arg(long)]
        pac_al2o3_fraction: Option<f64>,
        /// Tertiary filter TSS capture fraction; overrides the fixture.
        #[arg(long)]
        tertiary_tss_removal: Option<f64>,
        /// Tertiary dissolved-PO4 polishing removal fraction; overrides the fixture.
        #[arg(long)]
        tertiary_po4_removal: Option<f64>,
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
}

fn apply_pac_override(
    plant: &mut Asm2dPlantConfig,
    dose: Option<f64>,
    reactor: Option<usize>,
    al2o3_fraction: Option<f64>,
) {
    if dose.is_none() && reactor.is_none() && al2o3_fraction.is_none() {
        return;
    }
    let existing = plant.pac;
    plant.pac = Some(Asm2dPacConfig {
        reactor: reactor
            .or_else(|| existing.map(|pac| pac.reactor))
            .unwrap_or_else(|| plant.reactors.len().saturating_sub(1)),
        dose_mg_l: dose
            .or_else(|| existing.map(|pac| pac.dose_mg_l))
            .unwrap_or(0.0),
        al2o3_fraction: al2o3_fraction
            .or_else(|| existing.map(|pac| pac.al2o3_fraction))
            .unwrap_or(0.30),
        meoh_per_al: existing.map_or(107.0 / 27.0, |pac| pac.meoh_per_al),
    });
}

fn apply_tertiary_override(
    plant: &mut Asm2dPlantConfig,
    tss_removal: Option<f64>,
    po4_removal: Option<f64>,
) {
    if tss_removal.is_none() && po4_removal.is_none() {
        return;
    }
    let existing = plant.tertiary;
    plant.tertiary = Some(Asm2dTertiaryConfig {
        tss_removal_fraction: tss_removal
            .or_else(|| existing.map(|tertiary| tertiary.tss_removal_fraction))
            .unwrap_or(0.90),
        po4_removal_fraction: po4_removal
            .or_else(|| existing.map(|tertiary| tertiary.po4_removal_fraction))
            .unwrap_or(0.0),
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            bind,
            db,
            queue_capacity,
        } => {
            if let Err(error) = aquapilot_service::serve(aquapilot_service::ServiceConfig {
                bind,
                db_path: db.display().to_string(),
                queue_capacity,
            }) {
                return Err(std::io::Error::other(error.to_string()).into());
            }
        }
        Command::Backup { db, out, force } => {
            let store = aquapilot_service::Store::open(&db, 1)?;
            store.backup_to(&out, force)?;
            println!("backup written to {}", out.display());
        }
        Command::Validate { topology } => {
            let plant = load_topology(&topology)?;
            let compiled = CompiledPlant::compile(&plant)?;
            println!(
                "ok: {} reactors, influent {:.1} m3/h, effluent {:.1} m3/h",
                compiled.reactors.len(),
                compiled.influent_flow_m3_h,
                compiled.effluent_flow_m3_h
            );
            for reactor in &compiled.reactors {
                println!(
                    "  {} [{}] V={:.1} m3, HRT={:.2} h, KLa={:.1} 1/h, DO setpoint={:.2}",
                    reactor.id,
                    reactor.kind.label(),
                    reactor.volume_m3,
                    reactor.volume_m3
                        / reactor
                            .incoming
                            .iter()
                            .map(|item| item.flow_m3_h)
                            .sum::<f64>(),
                    reactor.kla_h,
                    reactor.do_setpoint
                );
            }
            for clarifier in &compiled.clarifiers {
                println!(
                    "  {} [clarifier] A={:.1} m2, depth={:.1} m, feed={:.1} m3/h, RAS={:.1}, WAS={:.1}",
                    clarifier.id,
                    clarifier.area_m2,
                    clarifier.depth_m,
                    clarifier.feed_flow_m3_h,
                    clarifier.ras_flow_m3_h,
                    clarifier.was_flow_m3_h
                );
            }
        }
        Command::Simulate {
            topology,
            minutes,
            dt,
            out,
            json,
            params,
        } => {
            let plant = load_topology(&topology)?;
            let config = SimulationConfig {
                dt_min: dt,
                duration_min: minutes,
            };
            let mut simulator = Simulator::new(&plant, config, params.params())?;
            simulator.run()?;
            let snapshot = simulator.snapshot();
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!("plant: {} (params: {:?})", snapshot.plant_name, params);
                println!(
                    "t={:.0} min, steps={}, effluent={:.1} m3/h",
                    snapshot.time_min, snapshot.step_count, snapshot.effluent.flow_m3_h
                );
                println!(
                    "effluent: COD={:.2} S_S={:.3} NH4-N={:.3} NO3-N={:.3} TN={:.3} TP={:.3} SS={:.2} DO={:.3} mg/L",
                    snapshot.effluent.cod,
                    snapshot.effluent.s_s,
                    snapshot.effluent.nh4_n,
                    snapshot.effluent.no3_n,
                    snapshot.effluent.tn,
                    snapshot.effluent.tp,
                    snapshot.effluent.ss,
                    snapshot.effluent.dissolved_oxygen
                );
                for clarifier in &snapshot.clarifiers {
                    println!(
                        "clarifier {}: feed TSS={:.1}, underflow TSS={:.1}, overflow TSS={:.1} mg/L",
                        clarifier.id, clarifier.feed_tss, clarifier.underflow_tss, clarifier.overflow_tss
                    );
                }
                if let Some(waste) = &snapshot.waste {
                    println!(
                        "waste: flow={:.1} m3/h, COD={:.1} mg/L, SS={:.1} mg/L",
                        waste.flow_m3_h, waste.cod, waste.ss
                    );
                }
                println!(
                    "COD ledger: in={:.1} kg, out={:.1} kg, waste={:.1} kg, inventory change={:.1} kg, unaccounted={:.1} kg",
                    snapshot.mass_balance.inflow_cod_kg,
                    snapshot.mass_balance.effluent_cod_kg,
                    snapshot.mass_balance.waste_cod_kg,
                    snapshot.mass_balance.inventory_change_kg,
                    snapshot.mass_balance.unaccounted_cod_kg
                );
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::Adm1 {
            config,
            days,
            dt,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let plant: Adm1Config = serde_json::from_str(&text)?;
            let snapshot = simulate_adm1(&plant, days, dt)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!(
                    "ADM1 CSTR: {:.0} m3, {:.0} m3/d, {:.1} K",
                    plant.volume_m3, plant.flow_m3_per_d, plant.temperature_k
                );
                println!(
                    "t={:.1} d, steps={}, pH={:.3}, effluent COD={:.2} kg/m3, N={:.3} kg N/m3, SS={:.2} kg/m3",
                    snapshot.days, snapshot.steps, snapshot.ph,
                    snapshot.effluent.cod(), snapshot.effluent.nitrogen(), snapshot.effluent.suspended_solids()
                );
                println!(
                    "biogas={:.1} m3/d, CH4={:.1} m3/d ({:.1}%), CO2={:.2}%, H2={:.3}%",
                    snapshot.biogas_m3_per_d,
                    snapshot.methane_m3_per_d,
                    snapshot.methane_fraction * 100.0,
                    snapshot.co2_fraction * 100.0,
                    snapshot.h2_fraction * 100.0
                );
                for (name, ledger) in [
                    ("COD", &snapshot.cod_balance),
                    ("N", &snapshot.nitrogen_balance),
                ] {
                    println!(
                        "{} ledger: in={:.1} kg, out={:.1} kg, gas={:.1} kg, inventory={:.1} kg, residual={:.2}%, closed={}",
                        name, ledger.input_kg, ledger.output_kg, ledger.gas_kg, ledger.inventory_kg,
                        ledger.residual * 100.0, ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::Asm2dLoop {
            config,
            minutes,
            dt,
            sludge_days,
            sludge_dt,
            max_iterations,
            relaxation,
            pac_dose,
            pac_reactor,
            pac_al2o3_fraction,
            tertiary_tss_removal,
            tertiary_po4_removal,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let mut plant: Asm2dPlantConfig = serde_json::from_str(&text)?;
            apply_pac_override(&mut plant, pac_dose, pac_reactor, pac_al2o3_fraction);
            apply_tertiary_override(&mut plant, tertiary_tss_removal, tertiary_po4_removal);
            let loop_config = Asm2dAdm1LoopConfig {
                plant,
                sludge: Asm2dSludgeConfig::default(),
                max_iterations,
                relaxation,
                tolerance: 1.0e-3,
            };
            let snapshot = simulate_asm2d_adm1_loop(
                &loop_config,
                Asm2dSimulationConfig {
                    dt_min: dt,
                    duration_min: minutes,
                },
                sludge_days,
                sludge_dt,
            )?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!(
                    "loop: {} iterations, converged={}, recycle={:.3} m3/h",
                    snapshot.iterations, snapshot.converged, snapshot.recycle_flow_m3_h
                );
                println!(
                    "recycle: COD={:.1} mg/L, N={:.3}, P={:.3}",
                    snapshot.recycle_cod_mg_l,
                    snapshot.recycle_nitrogen_mg_l,
                    snapshot.recycle_phosphorus_mg_l
                );
                println!(
                    "A2O: effluent COD={:.2} NH4-N={:.3} TN={:.3} TP={:.3} SS={:.2} mg/L, flow={:.1} m3/h",
                    snapshot.asm2d.effluent.cod,
                    snapshot.asm2d.effluent.nh4_n,
                    snapshot.asm2d.effluent.tn,
                    snapshot.asm2d.effluent.tp,
                    snapshot.asm2d.effluent.ss,
                    snapshot.asm2d.effluent.flow_m3_h
                );
                println!(
                    "digester: pH={:.3}, biogas={:.1} m3/d, CH4={:.1}%, cake={:.2} m3/d, filtrate={:.2} m3/d",
                    snapshot.sludge.line.digester.ph,
                    snapshot.sludge.line.digester.biogas_m3_per_d,
                    snapshot.sludge.line.digester.methane_fraction * 100.0,
                    snapshot.sludge.line.cake.flow_m3_per_d,
                    snapshot.sludge.line.filtrate.flow_m3_per_d
                );
                for (name, ledger) in [
                    ("COD", &snapshot.whole_balance.cod),
                    ("N", &snapshot.whole_balance.nitrogen),
                    ("P", &snapshot.whole_balance.phosphorus),
                ] {
                    println!(
                        "whole {} ledger: in={:.1}, effluent={:.1}, cake={:.1}, gas={:.1}, inventory={:.1}, residual={:.2}%, closed={}",
                        name,
                        ledger.input_kg,
                        ledger.effluent_kg,
                        ledger.cake_kg,
                        ledger.gas_kg,
                        ledger.inventory_kg,
                        ledger.residual * 100.0,
                        ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::Asm2dSludge {
            config,
            minutes,
            dt,
            sludge_days,
            sludge_dt,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let plant: Asm2dPlantConfig = serde_json::from_str(&text)?;
            let snapshot = simulate_asm2d(
                plant,
                Asm2dSimulationConfig {
                    dt_min: dt,
                    duration_min: minutes,
                },
                Asm2dParams::default(),
            )?;
            let coupled = simulate_asm2d_sludge(
                &snapshot.waste.state,
                snapshot.waste.flow_m3_h,
                &Asm2dSludgeConfig::default(),
                sludge_days,
                sludge_dt,
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "asm2d": snapshot,
                        "sludge": coupled,
                    }))?
                );
            } else {
                println!(
                    "A2O: {} (ASM2d, {:.0} min)",
                    snapshot.plant_name, snapshot.time_min
                );
                println!(
                    "effluent: COD={:.2} NH4-N={:.3} TN={:.3} TP={:.3} SS={:.2} mg/L",
                    snapshot.effluent.cod,
                    snapshot.effluent.nh4_n,
                    snapshot.effluent.tn,
                    snapshot.effluent.tp,
                    snapshot.effluent.ss
                );
                println!(
                    "waste: flow={:.1} m3/h, COD={:.1} mg/L, TN={:.2}, TP={:.2}, state COD={:.2} kg/m3",
                    snapshot.waste.flow_m3_h,
                    snapshot.waste.cod,
                    snapshot.waste.tn,
                    snapshot.waste.tp,
                    coupled.asm2d_cod_kg_per_m3 / 1000.0
                );
                println!(
                    "interface: ADM1 feed COD={:.3} N={:.3} P={:.3} kg/m3 (one-way, no filtrate return)",
                    coupled.adm1_feed.state.cod(),
                    coupled.adm1_feed.state.nitrogen(),
                    coupled.adm1_feed.phosphorus_kg_per_m3
                );
                println!(
                    "digester: pH={:.3}, biogas={:.1} m3/d, CH4={:.1}%, COD residual={:.2}%, N residual={:.2}%",
                    coupled.line.digester.ph,
                    coupled.line.digester.biogas_m3_per_d,
                    coupled.line.digester.methane_fraction * 100.0,
                    coupled.line.digester.cod_balance.residual * 100.0,
                    coupled.line.digester.nitrogen_balance.residual * 100.0
                );
                println!(
                    "cake: flow={:.2} m3/d, TS={:.1} kg/m3, P={:.3} kg/m3; filtrate: flow={:.2} m3/d, P={:.3} kg/m3",
                    coupled.line.cake.flow_m3_per_d,
                    coupled.line.cake.state.suspended_solids(),
                    coupled.line.cake.phosphorus_kg_per_m3,
                    coupled.line.filtrate.flow_m3_per_d,
                    coupled.line.filtrate.phosphorus_kg_per_m3
                );
                for (name, ledger) in [
                    ("COD", &coupled.line.cod_balance),
                    ("N", &coupled.line.nitrogen_balance),
                    ("P", &coupled.line.phosphorus_balance),
                ] {
                    println!(
                        "{} line ledger: in={:.1}, overflow={:.1}, digester_out={:.1}, gas={:.1}, inventory={:.1}, accounted={:.1}, residual={:.2}%, closed={}",
                        name,
                        ledger.input_kg,
                        ledger.overflow_kg,
                        ledger.digester_output_kg,
                        ledger.gas_kg,
                        ledger.inventory_kg,
                        ledger.accounted_kg,
                        ledger.residual * 100.0,
                        ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(
                    &path,
                    serde_json::to_string_pretty(&serde_json::json!({
                        "asm2d": snapshot,
                        "sludge": coupled,
                    }))?,
                )?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::SludgeLine {
            config,
            days,
            dt,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let line: SludgeLineConfig = serde_json::from_str(&text)?;
            let snapshot = simulate_sludge_line(&line, days, dt)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!(
                    "sludge line: feed {:.0} m3/d -> thickener underflow {:.0} m3/d -> digester {:.0} m3",
                    line.feed.flow_m3_per_d,
                    snapshot.thickened.flow_m3_per_d,
                    line.digester_volume_m3
                );
                println!(
                    "thickened: COD={:.1} kg/m3, N={:.3}, P={:.3}, SS={:.2} kg/m3",
                    snapshot.thickened.state.cod(),
                    snapshot.thickened.state.nitrogen(),
                    snapshot.thickened.phosphorus_kg_per_m3,
                    snapshot.thickened.state.suspended_solids()
                );
                println!(
                    "digester: pH={:.3}, biogas={:.1} m3/d, CH4={:.1}%, COD residual={:.2}%, N residual={:.2}%",
                    snapshot.digester.ph,
                    snapshot.digester.biogas_m3_per_d,
                    snapshot.digester.methane_fraction * 100.0,
                    snapshot.digester.cod_balance.residual * 100.0,
                    snapshot.digester.nitrogen_balance.residual * 100.0
                );
                println!(
                    "cake: flow={:.2} m3/d, TS={:.1} kg/m3, P={:.3} kg/m3; filtrate: flow={:.2} m3/d",
                    snapshot.cake.flow_m3_per_d,
                    snapshot.cake.state.suspended_solids(),
                    snapshot.cake.phosphorus_kg_per_m3,
                    snapshot.filtrate.flow_m3_per_d
                );
                for (name, ledger) in [
                    ("COD", &snapshot.cod_balance),
                    ("N", &snapshot.nitrogen_balance),
                    ("P", &snapshot.phosphorus_balance),
                ] {
                    println!(
                        "{} line ledger: in={:.1}, overflow={:.1}, digester_out={:.1}, gas={:.1}, inventory={:.1}, accounted={:.1}, residual={:.2}%, closed={}",
                        name,
                        ledger.input_kg,
                        ledger.overflow_kg,
                        ledger.digester_output_kg,
                        ledger.gas_kg,
                        ledger.inventory_kg,
                        ledger.accounted_kg,
                        ledger.residual * 100.0,
                        ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::Asm2d {
            config,
            minutes,
            dt,
            pac_dose,
            pac_reactor,
            pac_al2o3_fraction,
            tertiary_tss_removal,
            tertiary_po4_removal,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let mut plant: Asm2dPlantConfig = serde_json::from_str(&text)?;
            apply_pac_override(&mut plant, pac_dose, pac_reactor, pac_al2o3_fraction);
            apply_tertiary_override(&mut plant, tertiary_tss_removal, tertiary_po4_removal);
            let simulation = Asm2dSimulationConfig {
                dt_min: dt,
                duration_min: minutes,
            };
            let snapshot = simulate_asm2d(plant, simulation, Asm2dParams::default())?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!("plant: {} (ASM2d)", snapshot.plant_name);
                println!(
                    "t={:.0} min, steps={}, effluent={:.1} m3/h",
                    snapshot.time_min, snapshot.step_count, snapshot.effluent.flow_m3_h
                );
                println!(
                    "effluent: COD={:.2} S_S={:.3} NH4-N={:.3} NO3-N={:.3} TN={:.3} TP={:.3} PO4-P={:.3} SS={:.2} DO={:.3} mg/L",
                    snapshot.effluent.cod,
                    snapshot.effluent.s_s,
                    snapshot.effluent.nh4_n,
                    snapshot.effluent.no3_n,
                    snapshot.effluent.tn,
                    snapshot.effluent.tp,
                    snapshot.effluent.po4_p,
                    snapshot.effluent.ss,
                    snapshot.effluent.dissolved_oxygen
                );
                for reactor in &snapshot.reactors {
                    println!(
                        "reactor {} [{}]: COD={:.1}, TN={:.1}, TP={:.2}, SS={:.1}, DO={:.3}, KLa={:.1}",
                        reactor.id,
                        reactor.kind.label(),
                        reactor.cod,
                        reactor.tn,
                        reactor.tp,
                        reactor.ss,
                        reactor.dissolved_oxygen,
                        reactor.kla_h
                    );
                }
                println!(
                    "clarifier: feed TSS={:.1}, underflow TSS={:.1}, overflow TSS={:.1} mg/L",
                    snapshot.clarifier.feed_tss,
                    snapshot.clarifier.underflow_tss,
                    snapshot.clarifier.overflow_tss
                );
                if let Some(pac) = &snapshot.pac {
                    println!(
                        "PAC: reactor={}, dose={:.1} mg/L, product={:.1} kg/d, Al={:.1} kg/d, X_MeOH={:.1} kg/d, net chemical P removal={:.1} kg",
                        pac.reactor,
                        pac.dose_mg_l,
                        pac.product_kg_d,
                        pac.aluminum_kg_d,
                        pac.meoh_kg_d,
                        pac.net_chemical_p_removed_kg
                    );
                }
                if let Some(tertiary) = &snapshot.tertiary {
                    println!(
                        "Tertiary filter: capture={:.2}, inlet TSS={:.2} mg/L, outlet TSS={:.2} mg/L, captured solids={:.1} kg, captured P={:.1} kg",
                        tertiary.capture_fraction,
                        tertiary.inlet_tss,
                        tertiary.outlet_tss,
                        tertiary.captured_solids_kg,
                        tertiary.captured_phosphorus_kg
                    );
                }
                for (name, ledger) in [
                    ("COD", &snapshot.mass_balance.cod),
                    ("N", &snapshot.mass_balance.nitrogen),
                    ("P", &snapshot.mass_balance.phosphorus),
                ] {
                    println!(
                        "{} ledger: in={:.1}, out={:.1}, waste={:.1}, inventory={:.1}, oxidized={:.1}, gas={:.1}, residual={:.2}%, closed={}",
                        name,
                        ledger.inflow_kg,
                        ledger.effluent_kg,
                        ledger.waste_kg,
                        ledger.inventory_change_kg,
                        ledger.oxidized_kg,
                        ledger.gas_kg,
                        ledger.residual_fraction * 100.0,
                        ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
        Command::Asm2dParallel {
            config,
            minutes,
            dt,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let plant: Asm2dParallelConfig = serde_json::from_str(&text)?;
            let simulation = Asm2dSimulationConfig {
                dt_min: dt,
                duration_min: minutes,
            };
            let snapshot = simulate_asm2d_parallel(plant, simulation, Asm2dParams::default())?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!(
                    "plant: {} (ASM2d parallel, {})",
                    snapshot.plant_name, snapshot.train_count
                );
                println!(
                    "t={:.0} min, steps={}, influent={:.1} m3/h, effluent={:.1} m3/h, waste={:.1} m3/h",
                    snapshot.time_min,
                    snapshot.step_count,
                    snapshot.total_influent_flow_m3_h,
                    snapshot.effluent.flow_m3_h,
                    snapshot.waste.flow_m3_h
                );
                println!(
                    "aggregate effluent: COD={:.2} NH4-N={:.3} TN={:.3} TP={:.3} SS={:.2} mg/L",
                    snapshot.effluent.cod,
                    snapshot.effluent.nh4_n,
                    snapshot.effluent.tn,
                    snapshot.effluent.tp,
                    snapshot.effluent.ss
                );
                for (index, train) in snapshot.trains.iter().enumerate() {
                    println!(
                        "train {}: {} | effluent={:.1} m3/h COD={:.2} TP={:.3} | COD residual={:.2}%, N={:.2}%, P={:.2}%",
                        index,
                        train.plant_name,
                        train.effluent.flow_m3_h,
                        train.effluent.cod,
                        train.effluent.tp,
                        train.mass_balance.cod.residual_fraction * 100.0,
                        train.mass_balance.nitrogen.residual_fraction * 100.0,
                        train.mass_balance.phosphorus.residual_fraction * 100.0
                    );
                }
                for (name, ledger) in [
                    ("COD", &snapshot.mass_balance.cod),
                    ("N", &snapshot.mass_balance.nitrogen),
                    ("P", &snapshot.mass_balance.phosphorus),
                ] {
                    println!(
                        "{} aggregate ledger: in={:.1}, out={:.1}, waste={:.1}, inventory={:.1}, oxidized={:.1}, gas={:.1}, residual={:.2}%, closed={}",
                        name,
                        ledger.inflow_kg,
                        ledger.effluent_kg,
                        ledger.waste_kg,
                        ledger.inventory_change_kg,
                        ledger.oxidized_kg,
                        ledger.gas_kg,
                        ledger.residual_fraction * 100.0,
                        ledger.closed
                    );
                }
            }
            if let Some(path) = out {
                std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
                eprintln!("snapshot written to {}", path.display());
            }
        }
    }
    Ok(())
}

fn load_topology(path: &std::path::Path) -> Result<PlantTopology, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path)?;
    let topology: PlantTopology = serde_json::from_str(&text)?;
    Ok(topology)
}

// Keep the unused import check honest if the CLI grows a direct simulate call.
#[allow(dead_code)]
fn _simulate_once(
    topology: &PlantTopology,
    config: SimulationConfig,
) -> Result<aquapilot_engine::Snapshot, aquapilot_engine::EngineError> {
    simulate(topology, config, Asm1Params::default())
}

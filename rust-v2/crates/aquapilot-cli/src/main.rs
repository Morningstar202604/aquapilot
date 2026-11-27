use std::path::PathBuf;

use aquapilot_domain::PlantTopology;
use aquapilot_engine::{simulate, CompiledPlant, SimulationConfig, Simulator};
use aquapilot_model::asm2d::Asm2dParams;
use aquapilot_model::asm2d_parallel::{simulate_asm2d_parallel, Asm2dParallelConfig};
use aquapilot_model::asm2d_plant::{simulate_asm2d, Asm2dPlantConfig, Asm2dSimulationConfig};
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
        /// Optional output path for the JSON snapshot.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Print the full snapshot JSON to stdout.
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
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
        Command::Asm2d {
            config,
            minutes,
            dt,
            out,
            json,
        } => {
            let text = std::fs::read_to_string(&config)?;
            let plant: Asm2dPlantConfig = serde_json::from_str(&text)?;
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

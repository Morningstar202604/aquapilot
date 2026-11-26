use std::path::PathBuf;

use aquapilot_domain::PlantTopology;
use aquapilot_engine::{simulate, CompiledPlant, SimulationConfig, Simulator};
use aquapilot_model::Asm1Params;
use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "aquapilot-v2",
    about = "AquaPilot clean-room simulation engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
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
                    "  {} [{}] V={:.1} m3, HRT={:.2} h, KLa={:.1} 1/h",
                    reactor.id,
                    reactor.kind.label(),
                    reactor.volume_m3,
                    reactor.volume_m3
                        / reactor
                            .incoming
                            .iter()
                            .map(|item| item.flow_m3_h)
                            .sum::<f64>(),
                    reactor.kla_h
                );
            }
        }
        Command::Simulate {
            topology,
            minutes,
            dt,
            out,
            json,
        } => {
            let plant = load_topology(&topology)?;
            let config = SimulationConfig {
                dt_min: dt,
                duration_min: minutes,
            };
            let mut simulator = Simulator::new(&plant, config, Asm1Params::default())?;
            simulator.run()?;
            let snapshot = simulator.snapshot();
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!("plant: {}", snapshot.plant_name);
                println!(
                    "t={:.0} min, steps={}, effluent={:.1} m3/h",
                    snapshot.time_min, snapshot.step_count, snapshot.effluent.flow_m3_h
                );
                println!(
                    "effluent: COD={:.2} NH4-N={:.3} NO3-N={:.3} TN={:.3} TP={:.3} SS={:.2} DO={:.3} mg/L",
                    snapshot.effluent.cod,
                    snapshot.effluent.nh4_n,
                    snapshot.effluent.no3_n,
                    snapshot.effluent.tn,
                    snapshot.effluent.tp,
                    snapshot.effluent.ss,
                    snapshot.effluent.dissolved_oxygen
                );
                println!(
                    "COD ledger: in={:.1} kg, out={:.1} kg, inventory change={:.1} kg, unaccounted={:.1} kg",
                    snapshot.mass_balance.inflow_cod_kg,
                    snapshot.mass_balance.effluent_cod_kg,
                    snapshot.mass_balance.inventory_change_kg,
                    snapshot.mass_balance.unaccounted_cod_kg
                );
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

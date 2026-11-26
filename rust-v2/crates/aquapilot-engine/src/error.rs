#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Topology(#[from] aquapilot_domain::TopologyError),
    #[error("unsupported in V2-0: {0}")]
    Unsupported(String),
    #[error("connection {0} has no flow; V2-0 requires explicit flows")]
    MissingFlow(String),
    #[error("reactor {0} has no incoming stream")]
    DisconnectedReactor(String),
    #[error("unit {unit} has flow imbalance: in={incoming:.6} m3/h, out={outgoing:.6} m3/h")]
    FlowImbalance {
        unit: String,
        incoming: f64,
        outgoing: f64,
    },
    #[error("topology must contain exactly one influent and one effluent in V2-0")]
    MultipleBoundaryUnits,
    #[error("topology has no reactor")]
    NoReactor,
    #[error("effluent {0} has no incoming stream")]
    NoEffluentStream(String),
    #[error("invalid simulation config: {0}")]
    InvalidConfig(String),
    #[error("simulation failed at t={time_min:.3} min: {message}")]
    Simulation { time_min: f64, message: String },
}

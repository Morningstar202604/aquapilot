use crate::ids::UnitId;

/// Raw influent characterization used by the ASM1 mapping.
///
/// All concentrations are mg/L; flow is m3/h; temperature is degC.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RawWater {
    pub cod: f64,
    pub nh4_n: f64,
    pub no3_n: f64,
    pub tp: f64,
    pub ss: f64,
    pub alkalinity: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub temperature_c: f64,
}

/// Initial reactor liquor. Aggregate values are converted to ASM1 components
/// by the engine at construction time.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReactorInitial {
    pub cod: f64,
    pub nh4_n: f64,
    pub no3_n: f64,
    pub tp: f64,
    #[serde(rename = "do")]
    pub dissolved_oxygen: f64,
    pub alkalinity: f64,
    pub mlss: f64,
    pub temperature_c: f64,
    /// Optional explicit ASM1 state in canonical order:
    /// `[S_I, S_S, X_I, X_S, X_BH, X_BA, X_P, S_O, S_NO, S_NH, S_ND, X_ND, S_ALK]`.
    /// When present, the engine uses it instead of the aggregate mapping.
    #[serde(default)]
    pub composition: Option<[f64; 13]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReactorKind {
    Aerobic,
    Anoxic,
    Anaerobic,
}

impl ReactorKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Aerobic => "aerobic",
            Self::Anoxic => "anoxic",
            Self::Anaerobic => "anaerobic",
        }
    }

    pub fn is_aerobic(self) -> bool {
        matches!(self, Self::Aerobic)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    #[default]
    Process,
    Recycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecycleKind {
    #[default]
    None,
    Ras,
    Internal,
    Was,
}

impl RecycleKind {
    pub fn is_none(self) -> bool {
        matches!(self, Self::None)
    }

    /// RAS and internal recycle are back-edges in the forward process sort.
    /// WAS goes forward to the waste sink and therefore does not form a cycle.
    pub fn is_back_edge(self) -> bool {
        matches!(self, Self::Ras | Self::Internal)
    }
}

/// Takács-style hindered settling parameters. `a` and `b` are per g/m3;
/// the velocity law is `v_max * (exp(-a X) - exp(-b X))`, with `a < b`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SettlerParams {
    pub v_max_m_per_d: f64,
    pub x_max_g_per_m3: f64,
    pub x_min_g_per_m3: f64,
    pub a_per_g_per_m3: f64,
    pub b_per_g_per_m3: f64,
}

impl Default for SettlerParams {
    fn default() -> Self {
        Self {
            v_max_m_per_d: 474.0,
            x_max_g_per_m3: 10_000.0,
            x_min_g_per_m3: 0.001,
            a_per_g_per_m3: 0.0005,
            b_per_g_per_m3: 0.001,
        }
    }
}

/// Clarifier geometry and settler configuration extracted from `UnitKind`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClarifierSpec {
    pub area_m2: f64,
    pub depth_m: f64,
    pub layers: usize,
    pub feed_layer: usize,
    pub settling: SettlerParams,
}

fn default_kla() -> f64 {
    0.0
}

fn default_do_setpoint() -> f64 {
    0.0
}

fn default_layers() -> usize {
    10
}

fn default_feed_layer() -> usize {
    5
}

fn default_settler() -> SettlerParams {
    SettlerParams::default()
}

/// A unit operation in the flowsheet.
///
/// The enum is internally tagged by `type` in JSON. Geometry and model
/// parameters live on the unit itself so a topology file is self-contained.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UnitKind {
    Influent {
        flow_m3_h: f64,
        water: RawWater,
        /// Optional explicit ASM1 state in canonical order. Benchmark
        /// fixtures use it to pin the published influent fractionation.
        #[serde(default)]
        composition: Option<[f64; 13]>,
    },
    Aerobic {
        volume_m3: f64,
        initial: ReactorInitial,
        /// Maximum volumetric oxygen transfer coefficient, 1/h. When
        /// `do_setpoint` is zero this is used as a fixed KLa; otherwise it is
        /// the upper bound of the DO controller.
        #[serde(default = "default_kla")]
        kla_h: f64,
        /// Dissolved oxygen setpoint, mg/L. Zero keeps the fixed-KLa behavior.
        #[serde(default = "default_do_setpoint")]
        do_setpoint: f64,
    },
    Anoxic {
        volume_m3: f64,
        initial: ReactorInitial,
    },
    Anaerobic {
        volume_m3: f64,
        initial: ReactorInitial,
    },
    Clarifier {
        area_m2: f64,
        depth_m: f64,
        #[serde(default = "default_layers")]
        layers: usize,
        #[serde(default = "default_feed_layer")]
        feed_layer: usize,
        #[serde(default = "default_settler")]
        settling: SettlerParams,
    },
    Effluent,
    /// Sludge-wasting sink. V2-1 routes WAS here; the sludge line is V2-2.
    Waste,
}

impl UnitKind {
    pub fn reactor_kind(&self) -> Option<ReactorKind> {
        match self {
            Self::Aerobic { .. } => Some(ReactorKind::Aerobic),
            Self::Anoxic { .. } => Some(ReactorKind::Anoxic),
            Self::Anaerobic { .. } => Some(ReactorKind::Anaerobic),
            _ => None,
        }
    }

    pub fn is_reactor(&self) -> bool {
        self.reactor_kind().is_some()
    }

    pub fn is_influent(&self) -> bool {
        matches!(self, Self::Influent { .. })
    }

    pub fn is_effluent(&self) -> bool {
        matches!(self, Self::Effluent)
    }

    pub fn is_waste(&self) -> bool {
        matches!(self, Self::Waste)
    }

    pub fn is_clarifier(&self) -> bool {
        matches!(self, Self::Clarifier { .. })
    }

    pub fn clarifier_spec(&self) -> Option<ClarifierSpec> {
        match self {
            Self::Clarifier {
                area_m2,
                depth_m,
                layers,
                feed_layer,
                settling,
            } => Some(ClarifierSpec {
                area_m2: *area_m2,
                depth_m: *depth_m,
                layers: *layers,
                feed_layer: *feed_layer,
                settling: *settling,
            }),
            _ => None,
        }
    }

    pub fn volume_m3(&self) -> Option<f64> {
        match self {
            Self::Aerobic { volume_m3, .. }
            | Self::Anoxic { volume_m3, .. }
            | Self::Anaerobic { volume_m3, .. } => Some(*volume_m3),
            _ => None,
        }
    }

    pub fn initial(&self) -> Option<&ReactorInitial> {
        match self {
            Self::Aerobic { initial, .. }
            | Self::Anoxic { initial, .. }
            | Self::Anaerobic { initial, .. } => Some(initial),
            _ => None,
        }
    }

    pub fn kla_h(&self) -> f64 {
        match self {
            Self::Aerobic { kla_h, .. } => *kla_h,
            _ => 0.0,
        }
    }

    pub fn do_setpoint(&self) -> f64 {
        match self {
            Self::Aerobic { do_setpoint, .. } => *do_setpoint,
            _ => 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Unit {
    pub id: UnitId,
    pub name: String,
    #[serde(flatten)]
    pub kind: UnitKind,
}

/// A directed stream between two units.
///
/// `flow_m3_h` is explicit in V2-0. When it is absent the hydraulic solver
/// derives it in V2-1; the engine never silently assumes a flow.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Connection {
    pub id: crate::ids::ConnectionId,
    pub from: UnitId,
    pub to: UnitId,
    #[serde(default)]
    pub flow_m3_h: Option<f64>,
    #[serde(default)]
    pub stream: StreamKind,
    #[serde(default)]
    pub recycle: RecycleKind,
}

impl Connection {
    pub fn flow(&self) -> Option<f64> {
        self.flow_m3_h
    }
}

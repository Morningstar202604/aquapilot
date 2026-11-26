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
}

fn default_kla() -> f64 {
    0.0
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
    },
    Aerobic {
        volume_m3: f64,
        initial: ReactorInitial,
        /// Fixed volumetric oxygen transfer coefficient, 1/h. V2-0 uses fixed
        /// KLa; the DO controller replaces it in V2-1.
        #[serde(default = "default_kla")]
        kla_h: f64,
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
    },
    Effluent,
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

//! AquaPilot whole-plant runtime, M1b.
//!
//! This crate is the start of the missing `networkEngine` port: it owns pure
//! forcing and influent synthesis first. It is not a substitute for the TS
//! engine and does not expose a server or `PlantSnapshot` yet.

#![forbid(unsafe_code)]

pub mod forcing;
pub mod influent;

pub use forcing::{
    Controls, Recycle, ScenarioSpec, ScenarioType, aeration_capacity, diurnal, mixed,
    recycle_factors, scenario_envelope, seasonal_temperature, toxic_suppression,
};
pub use influent::{
    Influent, InfluentContext, InfluentSeries, SeriesSample, Uncertainty, derive_influent,
    sample_at,
};

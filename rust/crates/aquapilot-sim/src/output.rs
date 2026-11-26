//! Effluent shape and discharge limits, shared by metrics, alarms and phase 5.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effluent {
    pub flow: f64,
    pub cod: f64,
    pub bod: f64,
    pub ss: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
    pub ph: f64,
    pub temperature: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffluentLimits {
    pub cod: f64,
    pub bod: f64,
    pub ss: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
}

impl Default for EffluentLimits {
    fn default() -> Self {
        Self {
            cod: 50.0,
            bod: 10.0,
            ss: 10.0,
            nh: 5.0,
            tn: 15.0,
            tp: 0.5,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DischargeStandard {
    pub label: String,
    pub limits: EffluentLimits,
}

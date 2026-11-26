//! Influent synthesis and real-series sampling, ported from
//! `deriveInfluent` in `src/sim/networkEngine.ts` and `sampleAt` in
//! `src/sim/influentSeries.ts`.

use serde::Deserialize;

use crate::forcing::{
    ScenarioSpec, ScenarioType, diurnal, scenario_envelope, seasonal_temperature,
};

pub const DESIGN_FLOW: f64 = 2000.0;
pub const DESIGN_COD: f64 = 350.0;
pub const DESIGN_NH: f64 = 34.0;
pub const DESIGN_TP: f64 = 4.8;
pub const DESIGN_SS: f64 = 180.0;
pub const DESIGN_TEMPERATURE: f64 = 20.0;
pub const DESIGN_ALKALINITY: f64 = 320.0;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Influent {
    pub flow: f64,
    pub cod: f64,
    pub bod: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
    pub ss: f64,
    pub temperature: f64,
    pub alkalinity: f64,
}

impl Default for Influent {
    fn default() -> Self {
        Self {
            flow: DESIGN_FLOW,
            cod: DESIGN_COD,
            bod: 150.0,
            nh: DESIGN_NH,
            tn: 44.0,
            tp: DESIGN_TP,
            ss: DESIGN_SS,
            temperature: DESIGN_TEMPERATURE,
            alkalinity: DESIGN_ALKALINITY,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Uncertainty {
    pub flow: f64,
    pub cod: f64,
    pub nh: f64,
    pub tp: f64,
    pub temperature: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSample {
    pub minute: f64,
    pub flow: f64,
    pub cod: f64,
    pub nh: f64,
    pub tp: f64,
    pub ss: f64,
    pub temperature: f64,
    #[serde(default)]
    pub alkalinity: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfluentSeries {
    pub samples: Vec<SeriesSample>,
}

/// Inputs used by `deriveInfluent`; only the fields the function reads.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfluentContext {
    pub time_min: f64,
    pub seed: f64,
    pub rng_count: f64,
    #[serde(default)]
    pub scenario: Option<ScenarioSpec>,
    #[serde(default)]
    pub uncertainty: Option<Uncertainty>,
    #[serde(default)]
    pub influent_series: Option<InfluentSeries>,
}

struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    fn new(seed: f64) -> Self {
        Self { a: js_u32(seed) }
    }

    fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn normal(&mut self) -> f64 {
        let u = self.next().max(1e-9);
        let v = self.next().max(1e-9);
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// JavaScript `>>> 0`: truncate toward zero, modulo 2^32, unsigned.
fn js_u32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    // JS Math.min/Math.max propagate NaN; f64::min/max ignore it. Keep the
    // oracle's NaN semantics so a malformed sample cannot silently become 400.
    if value.is_nan() || min.is_nan() || max.is_nan() {
        return f64::NAN;
    }
    value.max(min).min(max)
}

fn noise(rng: &mut Mulberry32, sigma: f64) -> f64 {
    1.0 + rng.normal() * sigma
}

fn clamp_series(key: &str, value: f64) -> f64 {
    let (lo, hi) = match key {
        "flow" => (400.0, 5200.0),
        "cod" => (90.0, 1400.0),
        "nh" => (8.0, 120.0),
        "tp" => (0.8, 16.0),
        "ss" => (45.0, 900.0),
        "temperature" => (8.0, 31.0),
        "alkalinity" => (60.0, 380.0),
        _ => unreachable!("unknown series clamp key"),
    };
    clamp(value, lo, hi)
}

/// `sampleAt(series, minute)` including cyclic interpolation and clamps.
pub fn sample_at(series: &InfluentSeries, minute: f64) -> SeriesSample {
    let samples = &series.samples;
    if samples.is_empty() {
        return SeriesSample {
            minute,
            flow: DESIGN_FLOW,
            cod: DESIGN_COD,
            nh: DESIGN_NH,
            tp: DESIGN_TP,
            ss: DESIGN_SS,
            temperature: DESIGN_TEMPERATURE,
            alkalinity: Some(DESIGN_ALKALINITY),
        };
    }
    if samples.len() == 1 {
        let only = &samples[0];
        return SeriesSample {
            minute,
            flow: clamp_series("flow", only.flow),
            cod: clamp_series("cod", only.cod),
            nh: clamp_series("nh", only.nh),
            tp: clamp_series("tp", only.tp),
            ss: clamp_series("ss", only.ss),
            temperature: clamp_series("temperature", only.temperature),
            alkalinity: Some(clamp_series(
                "alkalinity",
                only.alkalinity.unwrap_or(DESIGN_ALKALINITY),
            )),
        };
    }

    let start = samples[0].minute;
    let span = samples[samples.len() - 1].minute - start;
    let offset = if span > 0.0 {
        ((minute - start) % span + span) % span
    } else {
        0.0
    };
    let target = start + offset;

    let mut lo = 0usize;
    let mut hi = samples.len() - 1;
    while lo < hi - 1 {
        let mid = (lo + hi) >> 1;
        if samples[mid].minute <= target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let a = &samples[lo];
    let b = &samples[hi];
    let denom = b.minute - a.minute;
    let t = if denom > 0.0 {
        (target - a.minute) / denom
    } else {
        0.0
    };
    let lerp = |x: f64, y: f64| x + (y - x) * t;

    SeriesSample {
        minute,
        flow: clamp_series("flow", lerp(a.flow, b.flow)),
        cod: clamp_series("cod", lerp(a.cod, b.cod)),
        nh: clamp_series("nh", lerp(a.nh, b.nh)),
        tp: clamp_series("tp", lerp(a.tp, b.tp)),
        ss: clamp_series("ss", lerp(a.ss, b.ss)),
        temperature: clamp_series("temperature", lerp(a.temperature, b.temperature)),
        alkalinity: if a.alkalinity.is_some() && b.alkalinity.is_some() {
            Some(lerp(
                a.alkalinity.unwrap_or(DESIGN_ALKALINITY),
                b.alkalinity.unwrap_or(DESIGN_ALKALINITY),
            ))
        } else {
            Some(DESIGN_ALKALINITY)
        },
    }
}

/// `deriveInfluent(state)` including synthetic and real-series paths.
pub fn derive_influent(ctx: &InfluentContext) -> Influent {
    let seed = ctx.seed * 31.0 + ctx.rng_count * 7919.0 + (ctx.time_min * 13.0).floor();
    let mut rng = Mulberry32::new(seed);
    let d = diurnal(ctx.time_min);
    let env = scenario_envelope(ctx.scenario.as_ref(), ctx.time_min);
    let mag = ctx.scenario.as_ref().map(|s| s.magnitude).unwrap_or(0.0);

    let series = ctx
        .influent_series
        .as_ref()
        .filter(|s| !s.samples.is_empty());
    let (mut flow, mut cod, mut nh, mut tp, mut ss, mut temperature, mut alkalinity);
    if let Some(series) = series {
        let sample = sample_at(series, ctx.time_min);
        flow = sample.flow;
        cod = sample.cod;
        nh = sample.nh;
        tp = sample.tp;
        ss = sample.ss;
        temperature = sample.temperature;
        alkalinity = sample.alkalinity.unwrap_or(DESIGN_ALKALINITY);
        flow *= noise(&mut rng, 0.004);
        cod *= noise(&mut rng, 0.008);
    } else {
        flow = DESIGN_FLOW * d * noise(&mut rng, 0.012);
        cod = DESIGN_COD * (0.92 + 0.18 * (d - 0.78)) * noise(&mut rng, 0.035);
        nh = DESIGN_NH * (0.94 + 0.14 * (d - 0.78)) * noise(&mut rng, 0.03);
        tp = DESIGN_TP * noise(&mut rng, 0.04);
        ss = DESIGN_SS * noise(&mut rng, 0.05);
        temperature = seasonal_temperature(ctx.time_min) + rng.normal() * 0.15;
        alkalinity = DESIGN_ALKALINITY * noise(&mut rng, 0.02);
    }

    if let Some(spec) = ctx.scenario.as_ref() {
        match spec.kind {
            ScenarioType::Storm => {
                let dilution = 1.0 / (1.0 + 1.2 * env * mag);
                flow *= 1.0 + 0.9 * env * mag;
                cod *= 0.5 + 0.5 * dilution;
                nh *= 0.5 + 0.5 * dilution;
                tp *= 0.65 + 0.35 * dilution;
                ss *= 1.0 + env;
                temperature -= 1.4 * env;
                alkalinity *= 0.85;
            }
            ScenarioType::ShockLoad => {
                cod *= 1.0 + 0.95 * env * mag;
                nh *= 1.0 + 0.7 * env * mag;
                tp *= 1.0 + 0.5 * env * mag;
                ss *= 1.0 + 0.35 * env * mag;
            }
            ScenarioType::Toxic => {
                cod *= 1.0 + 0.2 * env;
                tp *= 1.0 + 0.12 * env;
            }
            ScenarioType::Winter => {
                let target = if mag != 0.0 { mag } else { 12.0 };
                temperature -= (temperature - target) * (env * 1.1).min(1.0);
            }
            ScenarioType::PowerOutage => {
                flow *= 1.0 - 0.25 * env;
            }
            _ => {}
        }
    }

    let clamped_cod = clamp(cod, 90.0, 1400.0);
    let mut out = Influent {
        flow: clamp(flow, 400.0, 5200.0),
        cod: clamped_cod,
        bod: clamp(clamped_cod * 0.44, 30.0, 640.0),
        nh: clamp(nh, 8.0, 120.0),
        tn: clamp(nh * 1.27 + 4.0, 12.0, 160.0),
        tp: clamp(tp, 0.8, 16.0),
        ss: clamp(ss, 45.0, 900.0),
        temperature: clamp(temperature, 8.0, 31.0),
        alkalinity: clamp(alkalinity, 60.0, 380.0),
    };

    if let Some(u) = ctx.uncertainty {
        out.flow = clamp(out.flow * u.flow, 200.0, 6000.0);
        out.cod = clamp(out.cod * u.cod, 40.0, 1800.0);
        out.nh = clamp(out.nh * u.nh, 4.0, 180.0);
        out.tp = clamp(out.tp * u.tp, 0.3, 24.0);
        out.temperature = clamp(out.temperature + u.temperature, 5.0, 35.0);
        out.bod = clamp(out.cod * 0.44, 20.0, 800.0);
        out.tn = clamp(out.nh * 1.27 + 4.0, 8.0, 220.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_at_is_cyclic_and_clamped() {
        let series = InfluentSeries {
            samples: vec![
                SeriesSample {
                    minute: 0.0,
                    flow: 1000.0,
                    cod: 300.0,
                    nh: 30.0,
                    tp: 4.0,
                    ss: 150.0,
                    temperature: 20.0,
                    alkalinity: Some(300.0),
                },
                SeriesSample {
                    minute: 60.0,
                    flow: 1200.0,
                    cod: 330.0,
                    nh: 33.0,
                    tp: 4.4,
                    ss: 165.0,
                    temperature: 20.5,
                    alkalinity: Some(310.0),
                },
            ],
        };
        let at30 = sample_at(&series, 30.0);
        assert!((at30.flow - 1100.0).abs() < 1e-12);
        let at90 = sample_at(&series, 90.0);
        assert!((at90.flow - 1100.0).abs() < 1e-12);
        let clamped = sample_at(&series, 0.0);
        assert!((clamped.flow - 1000.0).abs() < 1e-12);
    }

    #[test]
    fn synthetic_influent_respects_design_bounds() {
        let ctx = InfluentContext {
            time_min: 600.0,
            seed: 21.0,
            rng_count: 0.0,
            scenario: None,
            uncertainty: None,
            influent_series: None,
        };
        let out = derive_influent(&ctx);
        assert!((out.flow - 400.0).abs() > 1e-12 && out.flow < 5200.0);
        assert!(out.cod >= 90.0 && out.cod <= 1400.0);
        assert!((out.bod - out.cod * 0.44).abs() < 1e-9 || out.bod == 640.0);
    }
}

//! Simple-model kinetics constants, ported from `src/sim/kinetics.ts`.
//!
//! These are effective rates calibrated for the 1-minute aggregate engine,
//! not raw ASM1 literature values. Keep them in one place so the Rust simple
//! branch and the TS oracle cannot drift independently.

pub const K_COD_AEROBIC: f64 = 1.4;
pub const K_COD_ANOXIC: f64 = 0.9;
pub const K_COD_ANAEROBIC: f64 = 0.6;
pub const K_NIT: f64 = 14.0;
pub const K_DEN: f64 = 8.0;
pub const K_P_REL: f64 = 5.0;
pub const K_P_UP: f64 = 3.0;
pub const KS_COD: f64 = 22.0;
pub const KS_NH: f64 = 1.0;
pub const KS_O2: f64 = 0.5;
pub const KS_O2_NIT: f64 = 0.9;
pub const O2_PER_COD: f64 = 0.9;
pub const O2_PER_NH: f64 = 4.57;
pub const ALK_PER_NH: f64 = 7.14;
pub const ALK_PER_NO3: f64 = 3.57;
pub const NITRATE_YIELD_PER_NITRIFIED_N: f64 = 1.0;
pub const DO_SAT_20: f64 = 9.1;

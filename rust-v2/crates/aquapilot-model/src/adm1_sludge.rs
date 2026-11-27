//! Sludge-line wrapper around the ADM1 CSTR: gravity thickener, anaerobic
//! digester, mechanical dewatering, and a phosphorus tracer.
//!
//! ADM1 does not carry phosphorus. The line therefore transports phosphorus as
//! an inert scalar through each unit; it is not allowed to react or partition
//! into biogas. This keeps the P ledger honest without pretending that ADM1 is
//! an ADM1-P model.

use serde::{Deserialize, Serialize};

use crate::adm1::{
    simulate_adm1, Adm1Config, Adm1Error, Adm1Gas, Adm1Params, Adm1Snapshot, Adm1State, X_C, X_I,
};

const PARTICULATE_START: usize = X_C;
const PARTICULATE_END: usize = X_I;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SludgeStream {
    pub flow_m3_per_d: f64,
    pub state: Adm1State,
    pub phosphorus_kg_per_m3: f64,
}

impl SludgeStream {
    pub fn cod_kg_per_d(&self) -> f64 {
        self.state.cod() * self.flow_m3_per_d
    }

    pub fn nitrogen_kg_per_d(&self) -> f64 {
        self.state.nitrogen() * self.flow_m3_per_d
    }

    pub fn phosphorus_kg_per_d(&self) -> f64 {
        self.phosphorus_kg_per_m3 * self.flow_m3_per_d
    }

    pub fn solids_kg_per_d(&self) -> f64 {
        self.state.suspended_solids() * self.flow_m3_per_d
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ThickenerConfig {
    /// Underflow as a fraction of feed flow.
    pub underflow_fraction: f64,
    /// Fraction of particulate COD captured in the underflow.
    pub solids_capture: f64,
    /// Fraction of phosphorus carried by particulates.
    pub phosphorus_particulate_fraction: f64,
}

impl Default for ThickenerConfig {
    fn default() -> Self {
        Self {
            underflow_fraction: 0.25,
            solids_capture: 0.90,
            phosphorus_particulate_fraction: 0.90,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DewateringConfig {
    /// Cake total-solids concentration, kg/m3 (e.g. 250 = 25% TS).
    pub cake_ts_kg_per_m3: f64,
    /// Fraction of particulate COD captured in the cake.
    pub solids_capture: f64,
    /// Fraction of phosphorus carried by particulates.
    pub phosphorus_particulate_fraction: f64,
}

impl Default for DewateringConfig {
    fn default() -> Self {
        Self {
            cake_ts_kg_per_m3: 250.0,
            solids_capture: 0.95,
            phosphorus_particulate_fraction: 0.90,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SludgeLineConfig {
    pub feed: SludgeStream,
    pub thickener: ThickenerConfig,
    pub dewatering: DewateringConfig,
    /// Digester liquid volume, m3. Flow is the thickener underflow.
    pub digester_volume_m3: f64,
    pub digester_initial: Adm1State,
    pub digester_initial_gas: Adm1Gas,
    pub digester_params: Adm1Params,
    pub temperature_k: f64,
    pub gas_volume_ratio: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SludgeMassBalance {
    pub input_kg: f64,
    pub overflow_kg: f64,
    pub cake_kg: f64,
    pub filtrate_kg: f64,
    pub gas_kg: f64,
    pub inventory_kg: f64,
    pub residual: f64,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SludgeLineSnapshot {
    pub thickener_overflow: SludgeStream,
    pub thickened: SludgeStream,
    pub digester: Adm1Snapshot,
    pub cake: SludgeStream,
    pub filtrate: SludgeStream,
    pub cod_balance: SludgeMassBalance,
    pub nitrogen_balance: SludgeMassBalance,
    pub phosphorus_balance: SludgeMassBalance,
}

#[derive(Debug, thiserror::Error)]
pub enum SludgeLineError {
    #[error(transparent)]
    Adm1(#[from] Adm1Error),
    #[error("sludge-line configuration is invalid")]
    InvalidConfig,
}

pub fn simulate_sludge_line(
    config: &SludgeLineConfig,
    days: f64,
    dt_days: f64,
) -> Result<SludgeLineSnapshot, SludgeLineError> {
    if config.feed.flow_m3_per_d <= 0.0
        || config.digester_volume_m3 <= 0.0
        || !(0.0..1.0).contains(&config.thickener.underflow_fraction)
        || !(0.0..=1.0).contains(&config.thickener.solids_capture)
        || !(0.0..=1.0).contains(&config.dewatering.solids_capture)
        || config.dewatering.cake_ts_kg_per_m3 <= 0.0
    {
        return Err(SludgeLineError::InvalidConfig);
    }

    let (thickened, thickener_overflow) = thicken(config);
    let digester_flow = thickened.flow_m3_per_d;
    let digester_config = Adm1Config {
        volume_m3: config.digester_volume_m3,
        flow_m3_per_d: digester_flow,
        temperature_k: config.temperature_k,
        gas_volume_ratio: config.gas_volume_ratio,
        feed: thickened.state,
        initial: config.digester_initial,
        initial_gas: config.digester_initial_gas,
        params: config.digester_params,
    };
    let digester = simulate_adm1(&digester_config, days, dt_days)?;
    let digester_effluent = SludgeStream {
        flow_m3_per_d: digester_flow,
        state: digester.effluent,
        phosphorus_kg_per_m3: thickened.phosphorus_kg_per_m3,
    };
    let (cake, filtrate) = dewater(&digester_effluent, config.dewatering);

    let cod_balance = line_balance(
        config.feed.cod_kg_per_d() * days,
        thickener_overflow.cod_kg_per_d() * days,
        cake.cod_kg_per_d() * days,
        filtrate.cod_kg_per_d() * days,
        digester.cod_balance.gas_kg,
        digester.cod_balance.inventory_kg,
    );
    let nitrogen_balance = line_balance(
        config.feed.nitrogen_kg_per_d() * days,
        thickener_overflow.nitrogen_kg_per_d() * days,
        cake.nitrogen_kg_per_d() * days,
        filtrate.nitrogen_kg_per_d() * days,
        0.0,
        digester.nitrogen_balance.inventory_kg,
    );
    let phosphorus_balance = line_balance(
        config.feed.phosphorus_kg_per_d() * days,
        thickener_overflow.phosphorus_kg_per_d() * days,
        cake.phosphorus_kg_per_d() * days,
        filtrate.phosphorus_kg_per_d() * days,
        0.0,
        0.0,
    );

    Ok(SludgeLineSnapshot {
        thickener_overflow,
        thickened,
        digester,
        cake,
        filtrate,
        cod_balance,
        nitrogen_balance,
        phosphorus_balance,
    })
}

fn line_balance(
    input: f64,
    overflow: f64,
    cake: f64,
    filtrate: f64,
    gas: f64,
    inventory: f64,
) -> SludgeMassBalance {
    let accounted = overflow + cake + filtrate + gas + inventory;
    let residual = if input.abs() > 1e-12 {
        (input - accounted) / input
    } else {
        accounted.abs()
    };
    SludgeMassBalance {
        input_kg: input,
        overflow_kg: overflow,
        cake_kg: cake,
        filtrate_kg: filtrate,
        gas_kg: gas,
        inventory_kg: inventory,
        residual,
        closed: residual.abs() <= 0.02,
    }
}

fn thicken(config: &SludgeLineConfig) -> (SludgeStream, SludgeStream) {
    let feed = config.feed;
    let underflow = feed.flow_m3_per_d * config.thickener.underflow_fraction;
    let overflow = feed.flow_m3_per_d - underflow;
    let capture = config.thickener.solids_capture;
    let mut under_state = Adm1State::default();
    let mut over_state = Adm1State::default();

    for i in 0..crate::adm1::ADM1_STATE_COMPONENTS {
        let concentration = feed.state.values[i];
        let mass_in = concentration * feed.flow_m3_per_d;
        let (under_mass, over_mass) = if (PARTICULATE_START..=PARTICULATE_END).contains(&i) {
            (mass_in * capture, mass_in * (1.0 - capture))
        } else {
            (concentration * underflow, concentration * overflow)
        };
        under_state.values[i] = under_mass / underflow;
        over_state.values[i] = over_mass / overflow;
    }

    let p_part = config
        .thickener
        .phosphorus_particulate_fraction
        .clamp(0.0, 1.0);
    let p_under = feed.phosphorus_kg_per_d()
        * (p_part * capture + (1.0 - p_part) * config.thickener.underflow_fraction);
    let p_over = feed.phosphorus_kg_per_d() - p_under;
    (
        SludgeStream {
            flow_m3_per_d: underflow,
            state: under_state,
            phosphorus_kg_per_m3: p_under / underflow,
        },
        SludgeStream {
            flow_m3_per_d: overflow,
            state: over_state,
            phosphorus_kg_per_m3: p_over / overflow,
        },
    )
}

fn dewater(feed: &SludgeStream, config: DewateringConfig) -> (SludgeStream, SludgeStream) {
    let total_solids = feed.state.suspended_solids() * feed.flow_m3_per_d;
    let cake_solids = total_solids * config.solids_capture;
    let cake_flow = (cake_solids / config.cake_ts_kg_per_m3).min(feed.flow_m3_per_d);
    let filtrate_flow = feed.flow_m3_per_d - cake_flow;
    let capture = config.solids_capture;
    let mut cake_state = Adm1State::default();
    let mut filtrate_state = Adm1State::default();

    for i in 0..crate::adm1::ADM1_STATE_COMPONENTS {
        let concentration = feed.state.values[i];
        let mass_in = concentration * feed.flow_m3_per_d;
        let (cake_mass, filtrate_mass) = if (PARTICULATE_START..=PARTICULATE_END).contains(&i) {
            (mass_in * capture, mass_in * (1.0 - capture))
        } else {
            (concentration * cake_flow, concentration * filtrate_flow)
        };
        cake_state.values[i] = if cake_flow > 1e-12 {
            cake_mass / cake_flow
        } else {
            0.0
        };
        filtrate_state.values[i] = if filtrate_flow > 1e-12 {
            filtrate_mass / filtrate_flow
        } else {
            0.0
        };
    }

    let p_part = config.phosphorus_particulate_fraction.clamp(0.0, 1.0);
    let p_cake = feed.phosphorus_kg_per_d()
        * (p_part * capture + (1.0 - p_part) * cake_flow / feed.flow_m3_per_d);
    let p_filtrate = feed.phosphorus_kg_per_d() - p_cake;
    (
        SludgeStream {
            flow_m3_per_d: cake_flow,
            state: cake_state,
            phosphorus_kg_per_m3: if cake_flow > 1e-12 {
                p_cake / cake_flow
            } else {
                0.0
            },
        },
        SludgeStream {
            flow_m3_per_d: filtrate_flow,
            state: filtrate_state,
            phosphorus_kg_per_m3: if filtrate_flow > 1e-12 {
                p_filtrate / filtrate_flow
            } else {
                0.0
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_feed() -> SludgeStream {
        let mut state = Adm1State::default();
        for (i, value) in [
            0.05, 0.02, 0.02, 0.01, 0.01, 0.01, 0.15, 1.0e-6, 1.0e-5, 0.10, 0.01, 0.05, 2.0, 1.4,
            1.5, 0.5, 0.05, 0.10, 0.03, 0.03, 0.02, 0.10, 0.02, 1.0,
        ]
        .iter()
        .enumerate()
        {
            state.values[i] = *value;
        }
        state.values[crate::adm1::S_CAT] = 0.04;
        state.values[crate::adm1::S_AN] = 0.02;
        SludgeStream {
            flow_m3_per_d: 480.0,
            state,
            phosphorus_kg_per_m3: 0.489,
        }
    }

    fn seed() -> Adm1State {
        let mut state = Adm1State::default();
        for (i, value) in [
            0.02, 0.01, 0.1, 0.01, 0.01, 0.02, 0.3, 1.0e-6, 0.05, 0.5, 0.5, 0.1, 2.0, 1.0, 1.0,
            0.5, 0.3, 0.9, 0.3, 0.3, 0.1, 0.7, 0.3, 5.0,
        ]
        .iter()
        .enumerate()
        {
            state.values[i] = *value;
        }
        state.values[crate::adm1::S_CAT] = 0.04;
        state.values[crate::adm1::S_AN] = 0.02;
        state
    }

    fn line_config() -> SludgeLineConfig {
        SludgeLineConfig {
            feed: synthetic_feed(),
            thickener: ThickenerConfig::default(),
            dewatering: DewateringConfig::default(),
            digester_volume_m3: 2400.0,
            digester_initial: seed(),
            digester_initial_gas: Adm1Gas {
                h2: 3.9e-9,
                ch4: 0.00254,
                ic: 0.00137,
            },
            digester_params: Adm1Params::default(),
            temperature_k: 308.15,
            gas_volume_ratio: 0.1,
        }
    }

    #[test]
    fn sludge_line_closes_cod_n_and_p() {
        let config = line_config();
        let snapshot = simulate_sludge_line(&config, 20.0, 0.002).expect("sludge line");
        assert!(snapshot.thickened.flow_m3_per_d == 120.0);
        assert!(snapshot.cake.flow_m3_per_d > 0.0);
        assert!(
            snapshot.cod_balance.residual.abs() < 0.03,
            "COD {}",
            snapshot.cod_balance.residual
        );
        assert!(
            snapshot.nitrogen_balance.residual.abs() < 0.03,
            "N {}",
            snapshot.nitrogen_balance.residual
        );
        assert!(
            snapshot.phosphorus_balance.residual.abs() < 0.01,
            "P {}",
            snapshot.phosphorus_balance.residual
        );
        assert!(snapshot.digester.methane_m3_per_d > 0.0);
    }
}

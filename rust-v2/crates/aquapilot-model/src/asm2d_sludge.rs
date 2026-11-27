//! One-way ASM2d -> ADM1 sludge-line interface.
//!
//! The interface deliberately preserves the three whole-plant ledgers at the
//! boundary: ASM2d COD becomes ADM1 COD, ASM2d total N becomes ADM1 total N
//! (nitrate is folded into `S_IN` because ADM1 has no nitrate state), and
//! ASM2d total P becomes the inert P tracer. Component identity is simplified:
//! all ASM2d particulate COD is carried as ADM1 `X_c`, because ASM2d
//! biomass/inert/storage fractions do not have a one-to-one ADM1 mapping.
//!
//! The return liquor is reported but not fed back into the ASM2d influent yet.

use serde::{Deserialize, Serialize};

use crate::adm1::{
    Adm1Gas, Adm1Params, Adm1State, S_AC, S_AN, S_CAT, S_I, S_IC, S_IN, S_SU, X_AA, X_AC, X_C,
    X_C4, X_FA, X_H2, X_I, X_PRO, X_SU,
};
use crate::adm1_sludge::{
    default_digester_gas, default_digester_seed, simulate_sludge_line, DewateringConfig,
    SludgeLineConfig, SludgeLineSnapshot, SludgeStream, ThickenerConfig,
};
use crate::asm2d::Asm2dState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dSludgeConfig {
    pub thickener: ThickenerConfig,
    pub dewatering: DewateringConfig,
    pub digester_volume_m3: f64,
    pub digester_initial: Adm1State,
    pub digester_initial_gas: Adm1Gas,
    pub digester_params: Adm1Params,
    pub temperature_k: f64,
    pub gas_volume_ratio: f64,
}

impl Default for Asm2dSludgeConfig {
    fn default() -> Self {
        Self {
            thickener: ThickenerConfig::default(),
            dewatering: DewateringConfig::default(),
            digester_volume_m3: 2400.0,
            digester_initial: default_digester_seed(),
            digester_initial_gas: default_digester_gas(),
            digester_params: Adm1Params::default(),
            temperature_k: 308.15,
            gas_volume_ratio: 0.1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asm2dSludgeSnapshot {
    pub flow_m3_per_d: f64,
    pub asm2d_cod_kg_per_m3: f64,
    pub asm2d_nitrogen_kg_per_m3: f64,
    pub asm2d_phosphorus_kg_per_m3: f64,
    pub adm1_feed: SludgeStream,
    pub line: SludgeLineSnapshot,
}

/// Translate the ASM2d underflow state into an ADM1 feed while preserving COD,
/// total N and total P exactly at the boundary.
pub fn adm1_feed_from_asm2d(state: &Asm2dState, flow_m3_per_d: f64) -> (SludgeStream, [f64; 3]) {
    // ASM2d states are mg/L (g/m3); ADM1 states are kg/m3.
    let particulate_cod =
        (state.xi + state.xs + state.xh + state.xpao + state.xpha + state.xaut) / 1000.0;
    let soluble_cod = (state.si + state.sf + state.sa) / 1000.0;
    let target_n = state.total_nitrogen() / 1000.0;
    let target_p = state.total_phosphorus() / 1000.0;

    let mut values = [0.0; crate::adm1::ADM1_STATE_COMPONENTS];
    values[X_C] = particulate_cod;
    values[S_SU] = state.sf / 1000.0;
    values[S_AC] = state.sa / 1000.0;
    values[S_I] = state.si / 1000.0;
    values[S_IC] = 0.48;
    values[S_CAT] = 0.04;
    values[S_AN] = 0.02;

    // ADM1 N coefficients for the mapped components. Nitrate and nitrite are
    // folded into S_IN; the residual is the ammonia/IN pool.
    // Acetate carries no N in ADM1; only X_c, S_I and the S_IN pool do here.
    let mapped_n = 0.0376 * particulate_cod + 0.06 * (state.si / 1000.0);
    let s_in = (target_n - mapped_n).max(0.0);
    values[S_IN] = s_in;

    let state = Adm1State::new(values);
    let stream = SludgeStream {
        flow_m3_per_d,
        state,
        phosphorus_kg_per_m3: target_p,
    };
    (
        stream,
        [
            state.cod() - (particulate_cod + soluble_cod),
            state.nitrogen() - target_n,
            0.0,
        ],
    )
}

/// Translate ADM1 filtrate back to an ASM2d recycle stream, preserving COD,
/// total N and total P at the return boundary.
pub fn asm2d_state_from_adm1(state: &Adm1State, phosphorus_kg_per_m3: f64) -> Asm2dState {
    let mut result = Asm2dState::zeros();
    result.sf = state.values[S_SU] * 1000.0;
    result.sa = state.values[S_AC] * 1000.0;
    result.si = state.values[S_I] * 1000.0;
    result.xs = state.values[X_C] * 1000.0;
    result.xi = state.values[X_I] * 1000.0;
    result.xh = (state.values[X_SU]
        + state.values[X_AA]
        + state.values[X_FA]
        + state.values[X_C4]
        + state.values[X_PRO]
        + state.values[X_AC]
        + state.values[X_H2])
        * 1000.0;
    result.salk = 300.0;

    let target_n = state.nitrogen() * 1000.0;
    let mapped_n = 0.01 * result.si
        + 0.03 * result.sf
        + 0.02 * result.xi
        + 0.04 * result.xs
        + 0.07 * result.xh;
    result.snh4 = (target_n - mapped_n).max(0.0);

    let target_p = phosphorus_kg_per_m3 * 1000.0;
    let mapped_p = 0.01 * result.sf + 0.01 * result.xi + 0.01 * result.xs + 0.02 * result.xh;
    result.spo4 = (target_p - mapped_p).max(0.0);
    result
}

pub fn simulate_asm2d_sludge(
    asm2d_underflow: &Asm2dState,
    was_flow_m3_h: f64,
    config: &Asm2dSludgeConfig,
    days: f64,
    dt_days: f64,
) -> Result<Asm2dSludgeSnapshot, crate::adm1_sludge::SludgeLineError> {
    let flow_m3_per_d = was_flow_m3_h * 24.0;
    let (feed, _) = adm1_feed_from_asm2d(asm2d_underflow, flow_m3_per_d);
    let line_config = SludgeLineConfig {
        feed,
        thickener: config.thickener,
        dewatering: config.dewatering,
        digester_volume_m3: config.digester_volume_m3,
        digester_initial: config.digester_initial,
        digester_initial_gas: config.digester_initial_gas,
        digester_params: config.digester_params,
        temperature_k: config.temperature_k,
        gas_volume_ratio: config.gas_volume_ratio,
    };
    let line = simulate_sludge_line(&line_config, days, dt_days)?;
    Ok(Asm2dSludgeSnapshot {
        flow_m3_per_d,
        asm2d_cod_kg_per_m3: asm2d_underflow.total_cod(),
        asm2d_nitrogen_kg_per_m3: asm2d_underflow.total_nitrogen(),
        asm2d_phosphorus_kg_per_m3: asm2d_underflow.total_phosphorus(),
        adm1_feed: feed,
        line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adm1::S_AA;

    fn waste_state() -> Asm2dState {
        let mut state = Asm2dState::zeros();
        state.snh4 = 0.77;
        state.sno3 = 8.09;
        state.spo4 = 0.068;
        state.sf = 1.34;
        state.sa = 0.007;
        state.si = 30.0;
        state.xi = 3677.7;
        state.xs = 77.2;
        state.xh = 1545.2;
        state.xpao = 1483.2;
        state.xpp = 387.1;
        state.xpha = 4.1;
        state.xaut = 128.6;
        state
    }

    #[test]
    fn interface_preserves_cod_n_and_p() {
        let state = waste_state();
        let (feed, residuals) = adm1_feed_from_asm2d(&state, 480.0);
        assert!(
            (residuals[0]).abs() < 1.0e-9,
            "cod residual {:?} feed {} state {}",
            residuals,
            feed.state.cod(),
            state.total_cod()
        );
        assert!(
            (residuals[1]).abs() < 1.0e-9,
            "n residual {:?} feed {} state {}",
            residuals,
            feed.state.nitrogen(),
            state.total_nitrogen()
        );
        assert!((feed.state.cod() - state.total_cod() / 1000.0).abs() < 1.0e-9);
        assert!((feed.state.nitrogen() - state.total_nitrogen() / 1000.0).abs() < 1.0e-9);
        assert!((feed.phosphorus_kg_per_m3 - state.total_phosphorus() / 1000.0).abs() < 1.0e-9);
        assert!(feed.state.values[S_AA] == 0.0);
    }

    #[test]
    fn reverse_mapping_preserves_cod_n_and_p() {
        let state = waste_state();
        let (feed, _) = adm1_feed_from_asm2d(&state, 480.0);
        let back = asm2d_state_from_adm1(&feed.state, feed.phosphorus_kg_per_m3);
        assert!((back.total_cod() - state.total_cod()).abs() < 1.0e-6);
        assert!((back.total_nitrogen() - state.total_nitrogen()).abs() < 1.0e-6);
        assert!((back.total_phosphorus() - state.total_phosphorus()).abs() < 1.0e-6);
    }

    #[test]
    fn coupled_line_closes_ledgers() {
        let state = waste_state();
        let snapshot =
            simulate_asm2d_sludge(&state, 20.0, &Asm2dSludgeConfig::default(), 5.0, 0.005)
                .expect("coupled sludge line");
        assert!(
            snapshot.line.cod_balance.residual.abs() < 0.03,
            "{:?}",
            snapshot.line.cod_balance
        );
        assert!(snapshot.line.nitrogen_balance.residual.abs() < 0.03);
        assert!(snapshot.line.phosphorus_balance.residual.abs() < 0.01);
        assert!(snapshot.line.digester.biogas_m3_per_d > 0.0);
    }
}

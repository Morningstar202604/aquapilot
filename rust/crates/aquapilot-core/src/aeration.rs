//! Oxygen transfer and DO PI control, ported from `src/sim/aeration.ts`.

pub const KLA_MAX: f64 = 18.0;
pub const KLA_MIN: f64 = 0.2;
pub const KP: f64 = 6.0;
pub const KI: f64 = 1.2;
pub const INTEGRAL_LIMIT: f64 = 12.0;
pub const KLA_RATE_LIMIT_PER_HOUR: f64 = 30.0;
pub const DO_SAT_20: f64 = 9.1;
pub const DO_SAT_SLOPE_PER_C: f64 = 0.11;
pub const SAE_KG_O2_PER_KWH: f64 = 3.4;
pub const BLOWER_EFFICIENCY: f64 = 0.7;
pub const MIN_BLOWER_KW: f64 = 5.0;
pub const MAX_BLOWER_KW: f64 = 900.0;
pub const AIR_DENSITY_KG_M3: f64 = 1.293;
pub const AIR_O2_MASS_FRACTION: f64 = 0.232;
pub const OXYGEN_TRANSFER_EFFICIENCY: f64 = 0.28;

pub fn saturation_do(temperature_c: f64) -> f64 {
    (DO_SAT_20 - DO_SAT_SLOPE_PER_C * (temperature_c - 20.0)).max(4.0)
}

#[derive(Debug, Clone, Copy)]
pub struct AerationInput {
    pub volume: f64,
    pub temperature_c: f64,
    pub do_level: f64,
    pub o2_demand: f64,
    pub do_setpoint: f64,
    pub capacity: f64,
    pub previous_kla: f64,
    pub previous_integral: f64,
    pub dt_h: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AerationResult {
    pub do_level: f64,
    pub kla: f64,
    pub integral: f64,
    pub o2_transferred_kg_h: f64,
    pub airflow_m3_h: f64,
    pub blower_kw: f64,
}

fn clamp(v: f64, a: f64, b: f64) -> f64 {
    b.min(a.max(v))
}

pub fn step_aeration(input: AerationInput) -> AerationResult {
    let dsat = saturation_do(input.temperature_c);
    let safe_volume = input.volume.max(1.0);
    let safe_dt = input.dt_h.max(1e-6);
    let available = input.capacity.clamp(0.0, 1.0);
    let max_kla = KLA_MAX * available;

    if available <= 0.02 {
        let do_next = (input.do_level - input.o2_demand.max(0.0) * safe_dt).max(0.02);
        return AerationResult {
            do_level: do_next.min(dsat),
            kla: 0.0,
            integral: 0.0,
            ..Default::default()
        };
    }

    let error = input.do_setpoint - input.do_level;
    let integral = clamp(
        input.previous_integral + error * safe_dt,
        -INTEGRAL_LIMIT,
        INTEGRAL_LIMIT,
    );
    let feed_forward = input.o2_demand.max(0.0) / (dsat - input.do_setpoint).max(0.5);
    let command = feed_forward + KP * error + KI * integral;
    let bounded = clamp(command, 0.0, max_kla);
    let max_delta = KLA_RATE_LIMIT_PER_HOUR * safe_dt;
    let previous = clamp(input.previous_kla, 0.0, KLA_MAX);
    let kla = if previous <= KLA_MIN {
        clamp(bounded, 0.0, max_kla)
    } else {
        clamp(
            bounded,
            (previous - max_delta).max(0.0),
            (max_kla).min(previous + max_delta),
        )
    };

    let equilibrium_do = dsat - input.o2_demand.max(0.0) / kla.max(1e-6);
    let do_next = if kla <= 0.01 {
        (input.do_level - input.o2_demand.max(0.0) * safe_dt).max(0.02)
    } else {
        clamp(
            equilibrium_do + (input.do_level - equilibrium_do) * (-kla * safe_dt).exp(),
            0.02,
            dsat,
        )
    };

    let transferred = (kla * (dsat - input.do_level).max(0.0) * safe_volume) / 1000.0;
    let airflow =
        transferred / (AIR_DENSITY_KG_M3 * AIR_O2_MASS_FRACTION * OXYGEN_TRANSFER_EFFICIENCY);
    let blower = clamp(
        transferred / SAE_KG_O2_PER_KWH / BLOWER_EFFICIENCY,
        MIN_BLOWER_KW,
        MAX_BLOWER_KW,
    );

    AerationResult {
        do_level: do_next,
        kla,
        integral,
        o2_transferred_kg_h: transferred,
        airflow_m3_h: airflow,
        blower_kw: if blower.is_finite() { blower } else { 0.0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturation_decreases_with_temperature() {
        assert!(saturation_do(10.0) > saturation_do(30.0));
        assert!(saturation_do(100.0) >= 4.0);
    }

    #[test]
    fn zero_capacity_consumes_do_and_returns_zero_kla() {
        let r = step_aeration(AerationInput {
            volume: 1000.0,
            temperature_c: 20.0,
            do_level: 2.0,
            o2_demand: 1.0,
            do_setpoint: 2.0,
            capacity: 0.0,
            previous_kla: 10.0,
            previous_integral: 3.0,
            dt_h: 1.0,
        });
        assert_eq!(r.kla, 0.0);
        assert_eq!(r.integral, 0.0);
        assert!((r.do_level - 1.0).abs() < 1e-12);
    }

    #[test]
    fn controller_is_rate_limited_and_bounded() {
        let r = step_aeration(AerationInput {
            volume: 5000.0,
            temperature_c: 20.0,
            do_level: 0.0,
            o2_demand: 200.0,
            do_setpoint: 2.0,
            capacity: 1.0,
            previous_kla: 0.0,
            previous_integral: 0.0,
            dt_h: 0.5,
        });
        assert!(r.kla >= 0.0 && r.kla <= KLA_MAX);
        assert!(r.do_level >= 0.02);
        assert!(r.do_level <= saturation_do(20.0));
    }
}

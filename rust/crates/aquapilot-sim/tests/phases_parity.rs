use std::collections::BTreeMap;

use aquapilot_sim::{
    Alarm, AlarmRuleInput, BiomassInput, Cost, Effluent, EffluentInput, EffluentLimits,
    EffluentMetric, Energy, EnergyInput, Totals, effluent_margin_rows, estimate_margin,
    evaluate_alarms, quality_score, solve_biomass, solve_effluent, solve_energy_and_cost,
    worst_ratio,
};
use serde::Deserialize;

const GOLDEN: &str = include_str!("../../../golden/sim-phases.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    schema_version: u32,
    generated_by: String,
    oracle: String,
    note: String,
    sources: BTreeMap<String, String>,
    counts: Counts,
    metrics: Vec<MetricCase>,
    alarms: Vec<AlarmCase>,
    effluent: Vec<EffluentCase>,
    biomass: Vec<BiomassCase>,
    energy: Vec<EnergyCase>,
}

#[derive(Debug, Deserialize)]
struct Counts {
    metrics: usize,
    alarms: usize,
    effluent: usize,
    biomass: usize,
    energy: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetricCase {
    effluent: Effluent,
    limits: EffluentLimits,
    rows: Vec<ExpectedRow>,
    worst_ratio: Option<f64>,
    score: u32,
    estimate: Vec<ExpectedRow>,
}

#[derive(Debug, Deserialize)]
struct ExpectedRow {
    key: EffluentMetric,
    metric: String,
    ratio: Option<f64>,
    value: f64,
    limit: f64,
    finite: bool,
}

#[derive(Debug, Deserialize)]
struct AlarmCase {
    input: AlarmRuleInput,
    standard: Option<aquapilot_sim::DischargeStandard>,
    expected: Vec<Alarm>,
}

#[derive(Debug, Deserialize)]
struct EffluentCase {
    input: EffluentInput,
    expected: EffluentExpected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffluentExpected {
    effluent: Effluent,
    pac_dose: f64,
}

#[derive(Debug, Deserialize)]
struct EnergyCase {
    input: EnergyInput,
    expected: EnergyExpected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnergyExpected {
    energy: Energy,
    cost: Cost,
    cost_today: Cost,
    totals: Totals,
    last_day: f64,
}

#[derive(Debug, Deserialize)]
struct BiomassCase {
    input: BiomassInput,
    expected: BiomassExpected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BiomassExpected {
    biomass_kg: f64,
    srt_days: f64,
    fm_ratio: f64,
}

fn close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 1e-12,
        "{label}: rust={actual:.17} ts={expected:.17} delta={:.3e}",
        (actual - expected).abs()
    );
}

fn ratio_close(actual: f64, expected: Option<f64>, label: &str) {
    match expected {
        Some(expected) => close(actual, expected, label),
        None => assert!(
            actual.is_infinite() && actual > 0.0,
            "{label}: expected +Infinity, got {actual}"
        ),
    }
}

fn rows_close(actual: &[aquapilot_sim::MarginRow], expected: &[ExpectedRow], label: &str) {
    assert_eq!(actual.len(), expected.len(), "{label}: row count");
    for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(a.key, e.key, "{label}[{i}].key");
        assert_eq!(a.metric, e.metric, "{label}[{i}].metric");
        assert_eq!(a.finite, e.finite, "{label}[{i}].finite");
        ratio_close(a.ratio, e.ratio, &format!("{label}[{i}].ratio"));
        close(a.value, e.value, &format!("{label}[{i}].value"));
        close(a.limit, e.limit, &format!("{label}[{i}].limit"));
    }
}

fn effluent_close(actual: &Effluent, expected: &Effluent, label: &str) {
    close(actual.flow, expected.flow, &format!("{label}.flow"));
    close(actual.cod, expected.cod, &format!("{label}.cod"));
    close(actual.bod, expected.bod, &format!("{label}.bod"));
    close(actual.ss, expected.ss, &format!("{label}.ss"));
    close(actual.nh, expected.nh, &format!("{label}.nh"));
    close(actual.tn, expected.tn, &format!("{label}.tn"));
    close(actual.tp, expected.tp, &format!("{label}.tp"));
    close(actual.ph, expected.ph, &format!("{label}.ph"));
    close(
        actual.temperature,
        expected.temperature,
        &format!("{label}.temperature"),
    );
}

#[test]
fn golden_header_and_counts_are_frozen() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    assert_eq!(golden.schema_version, 1);
    assert_eq!(golden.generated_by, "scripts/gen-sim-phases.ts");
    assert!(golden.oracle.contains("metrics.ts"));
    assert!(golden.note.contains("not a whole-plant step"));
    assert_eq!(golden.counts.metrics, 12);
    assert_eq!(golden.counts.alarms, 12);
    assert_eq!(golden.counts.effluent, 48);
    assert_eq!(golden.counts.biomass, 36);
    assert_eq!(golden.counts.energy, 24);
    assert_eq!(golden.metrics.len(), 12);
    assert_eq!(golden.alarms.len(), 12);
    assert_eq!(golden.effluent.len(), 48);
    assert_eq!(golden.biomass.len(), 36);
    assert_eq!(golden.energy.len(), 24);
    assert_eq!(golden.sources.len(), 5);
    for (path, hash) in &golden.sources {
        assert!(path.starts_with("src/sim/"));
        assert_eq!(hash.len(), 64, "{path} hash must be sha256");
    }
}

#[test]
fn metrics_match_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (i, case) in golden.metrics.iter().enumerate() {
        rows_close(
            &effluent_margin_rows(&case.effluent, &case.limits),
            &case.rows,
            &format!("metrics[{i}].rows"),
        );
        ratio_close(
            worst_ratio(&case.effluent, &case.limits),
            case.worst_ratio,
            &format!("metrics[{i}].worstRatio"),
        );
        assert_eq!(
            quality_score(&case.effluent, &EffluentLimits::default()),
            case.score,
            "metrics[{i}].score uses default limits like metrics.ts"
        );
        rows_close(
            &estimate_margin(&case.effluent, &case.limits),
            &case.estimate,
            &format!("metrics[{i}].estimate"),
        );
    }
}

#[test]
fn alarms_match_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (i, case) in golden.alarms.iter().enumerate() {
        let actual = evaluate_alarms(&case.input, case.standard.as_ref());
        assert_eq!(actual.len(), case.expected.len(), "alarms[{i}].len");
        for (j, (a, e)) in actual.iter().zip(case.expected.iter()).enumerate() {
            assert_eq!(a.id, e.id, "alarms[{i}][{j}].id");
            assert_eq!(a.at, e.at, "alarms[{i}][{j}].at");
            assert_eq!(a.severity, e.severity, "alarms[{i}][{j}].severity");
            assert_eq!(a.code, e.code, "alarms[{i}][{j}].code");
            assert_eq!(a.message, e.message, "alarms[{i}][{j}].message");
            assert_eq!(a.metric, e.metric, "alarms[{i}][{j}].metric");
            close(a.value, e.value, &format!("alarms[{i}][{j}].value"));
        }
    }
}

#[test]
fn effluent_phase_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (i, case) in golden.effluent.iter().enumerate() {
        let actual = solve_effluent(&case.input);
        effluent_close(
            &actual.effluent,
            &case.expected.effluent,
            &format!("effluent[{i}]"),
        );
        close(
            actual.pac_dose,
            case.expected.pac_dose,
            &format!("effluent[{i}].pacDose"),
        );
    }
}

#[test]
fn biomass_phase_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (i, case) in golden.biomass.iter().enumerate() {
        let actual = solve_biomass(&case.input);
        close(
            actual.biomass_kg,
            case.expected.biomass_kg,
            &format!("biomass[{i}].biomassKg"),
        );
        close(
            actual.srt_days,
            case.expected.srt_days,
            &format!("biomass[{i}].srtDays"),
        );
        close(
            actual.fm_ratio,
            case.expected.fm_ratio,
            &format!("biomass[{i}].fmRatio"),
        );
    }
}

#[test]
fn energy_phase_matches_ts_oracle() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden must parse");
    for (i, case) in golden.energy.iter().enumerate() {
        let actual = solve_energy_and_cost(&case.input);
        close(
            actual.energy.blower_kw,
            case.expected.energy.blower_kw,
            &format!("energy[{i}].blowerKw"),
        );
        close(
            actual.energy.mixer_kw,
            case.expected.energy.mixer_kw,
            &format!("energy[{i}].mixerKw"),
        );
        close(
            actual.energy.pump_kw,
            case.expected.energy.pump_kw,
            &format!("energy[{i}].pumpKw"),
        );
        close(
            actual.energy.total_kw,
            case.expected.energy.total_kw,
            &format!("energy[{i}].totalKw"),
        );
        close(
            actual.cost.energy,
            case.expected.cost.energy,
            &format!("energy[{i}].cost.energy"),
        );
        close(
            actual.cost.chemical,
            case.expected.cost.chemical,
            &format!("energy[{i}].cost.chemical"),
        );
        close(
            actual.cost.sludge,
            case.expected.cost.sludge,
            &format!("energy[{i}].cost.sludge"),
        );
        close(
            actual.cost.total,
            case.expected.cost.total,
            &format!("energy[{i}].cost.total"),
        );
        close(
            actual.cost_today.total,
            case.expected.cost_today.total,
            &format!("energy[{i}].costToday.total"),
        );
        close(
            actual.totals.inflow_m3,
            case.expected.totals.inflow_m3,
            &format!("energy[{i}].totals.inflowM3"),
        );
        close(
            actual.totals.energy_kwh,
            case.expected.totals.energy_kwh,
            &format!("energy[{i}].totals.energyKwh"),
        );
        close(
            actual.totals.waste_sludge_kg,
            case.expected.totals.waste_sludge_kg,
            &format!("energy[{i}].totals.wasteSludgeKg"),
        );
        close(
            actual.totals.influent_cod_kg,
            case.expected.totals.influent_cod_kg,
            &format!("energy[{i}].totals.influentCodKg"),
        );
        close(
            actual.totals.oxidized_cod_kg,
            case.expected.totals.oxidized_cod_kg,
            &format!("energy[{i}].totals.oxidizedCodKg"),
        );
        close(
            actual.last_day,
            case.expected.last_day,
            &format!("energy[{i}].lastDay"),
        );
    }
}

//! Active alarm rules, ported from `src/sim/alarmRules.ts`.

use serde::Deserialize;

use crate::output::{DischargeStandard, Effluent, EffluentLimits};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Alarm {
    pub id: String,
    pub at: f64,
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub metric: String,
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRuleInput {
    pub effluent: Effluent,
    #[serde(default)]
    pub standard: Option<DischargeStandard>,
    pub last_do: f64,
    pub srt_days: f64,
    pub blanket_m: f64,
    pub depth: f64,
    #[serde(default)]
    pub at_min: Option<f64>,
}

pub const BLANKET_MARGIN_M: f64 = 0.4;
pub const DO_FLOOR_MG_L: f64 = 1.0;
pub const SRT_FLOOR_D: f64 = 8.0;

fn limits_of(input: &AlarmRuleInput) -> EffluentLimits {
    input
        .standard
        .as_ref()
        .map(|s| s.limits)
        .unwrap_or_default()
}

fn label_of(input: &AlarmRuleInput) -> String {
    let raw = input
        .standard
        .as_ref()
        .map(|s| s.label.as_str())
        .unwrap_or("GB 18918-2002 一级 A");
    raw.strip_prefix("GB 18918-2002 ")
        .unwrap_or(raw)
        .to_string()
}

fn alarm(
    input: &AlarmRuleInput,
    severity: Severity,
    code: &str,
    message: String,
    metric: &str,
    value: f64,
) -> Alarm {
    Alarm {
        id: format!("LIVE-{code}"),
        at: input.at_min.unwrap_or(0.0),
        severity,
        code: code.to_string(),
        message,
        metric: metric.to_string(),
        value,
    }
}

/// `evaluateAlarms`: current active rules in the exact TS order.
pub fn evaluate_alarms(input: &AlarmRuleInput, standard: Option<&DischargeStandard>) -> Vec<Alarm> {
    let scoped;
    let input = if let Some(standard) = standard {
        scoped = AlarmRuleInput {
            effluent: input.effluent,
            standard: Some(standard.clone()),
            last_do: input.last_do,
            srt_days: input.srt_days,
            blanket_m: input.blanket_m,
            depth: input.depth,
            at_min: input.at_min,
        };
        &scoped
    } else {
        input
    };
    let limits = limits_of(input);
    let e = &input.effluent;
    let label = label_of(input);
    let mut out = Vec::new();

    if e.nh > limits.nh {
        out.push(alarm(
            input,
            Severity::Critical,
            "EFF_NH",
            format!(
                "出水氨氮 {:.2} mg/L 超{}（限值 {}）",
                e.nh, label, limits.nh
            ),
            "nh",
            e.nh,
        ));
    }
    if e.cod > limits.cod {
        out.push(alarm(
            input,
            Severity::Critical,
            "EFF_COD",
            format!(
                "出水 COD {:.1} mg/L 超{}（限值 {}）",
                e.cod, label, limits.cod
            ),
            "cod",
            e.cod,
        ));
    }
    if e.bod > limits.bod {
        out.push(alarm(
            input,
            Severity::Warning,
            "EFF_BOD",
            format!(
                "出水 BOD₅ {:.1} mg/L 超{}（限值 {}）",
                e.bod, label, limits.bod
            ),
            "bod",
            e.bod,
        ));
    }
    if e.tn > limits.tn {
        out.push(alarm(
            input,
            Severity::Warning,
            "EFF_TN",
            format!(
                "出水总氮 {:.1} mg/L 超{}（限值 {}）",
                e.tn, label, limits.tn
            ),
            "tn",
            e.tn,
        ));
    }
    if e.tp > limits.tp {
        out.push(alarm(
            input,
            Severity::Warning,
            "EFF_TP",
            format!(
                "出水总磷 {:.3} mg/L 超{}（限值 {}）",
                e.tp, label, limits.tp
            ),
            "tp",
            e.tp,
        ));
    }
    if e.ss > limits.ss {
        out.push(alarm(
            input,
            Severity::Warning,
            "EFF_SS",
            format!(
                "出水悬浮物 {:.1} mg/L 超{}（限值 {}）",
                e.ss, label, limits.ss
            ),
            "ss",
            e.ss,
        ));
    }
    if input.last_do < DO_FLOOR_MG_L {
        out.push(alarm(
            input,
            Severity::Warning,
            "DO_LOW",
            format!(
                "好氧区溶解氧 {:.2} mg/L 低于下限 {}",
                input.last_do, DO_FLOOR_MG_L
            ),
            "do",
            input.last_do,
        ));
    }
    if input.blanket_m > input.depth - BLANKET_MARGIN_M {
        out.push(alarm(
            input,
            Severity::Critical,
            "SLUDGE_BLANKET",
            format!(
                "二沉池泥位 {:.2} m 接近跑泥（池深 {:.1} m）",
                input.blanket_m, input.depth
            ),
            "blanket",
            input.blanket_m,
        ));
    }
    if input.srt_days < SRT_FLOOR_D {
        out.push(alarm(
            input,
            Severity::Warning,
            "SRT_LOW",
            format!(
                "污泥龄 {:.1} d 偏低（下限 {} d）",
                input.srt_days, SRT_FLOOR_D
            ),
            "srt",
            input.srt_days,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_effluent_has_no_alarms() {
        let input = AlarmRuleInput {
            effluent: Effluent {
                flow: 2000.0,
                cod: 20.0,
                bod: 5.0,
                ss: 5.0,
                nh: 1.0,
                tn: 5.0,
                tp: 0.1,
                ph: 7.0,
                temperature: 20.0,
            },
            standard: None,
            last_do: 2.0,
            srt_days: 15.0,
            blanket_m: 1.0,
            depth: 4.5,
            at_min: None,
        };
        assert!(evaluate_alarms(&input, None).is_empty());
    }
}

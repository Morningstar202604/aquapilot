//! Alarm history, ported from `pushAlarm` in `networkEngine.ts`.
//!
//! Active rules live in `alarms.rs`; this module owns de-duplication, sequence
//! numbering and the 80-entry cap.

use crate::alarms::{Alarm, AlarmRuleInput, Severity, evaluate_alarms};

pub const ALARM_DEDUP_WINDOW_MIN: f64 = 45.0;
pub const ALARM_HISTORY_LIMIT: usize = 80;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AlarmLedger {
    pub alarms: Vec<Alarm>,
    pub alarm_seq: u32,
}

impl AlarmLedger {
    /// Evaluate active rules and append only alarms outside the dedup window.
    /// Mirrors `raiseLimitAlarms` in `networkEngine.ts`.
    pub fn raise_limit_alarms(&mut self, input: &AlarmRuleInput) {
        for alarm in evaluate_alarms(input, None) {
            self.push(
                alarm.at,
                alarm.severity,
                &alarm.code,
                alarm.message,
                alarm.metric,
                alarm.value,
            );
        }
    }

    /// Push one alarm. Returns `false` when a same-code alarm is still inside
    /// the 45-minute de-duplication window.
    pub fn push(
        &mut self,
        at: f64,
        severity: Severity,
        code: &str,
        message: String,
        metric: String,
        value: f64,
    ) -> bool {
        if self
            .alarms
            .iter()
            .any(|a| a.code == code && at - a.at < ALARM_DEDUP_WINDOW_MIN)
        {
            return false;
        }
        self.alarm_seq = self.alarm_seq.wrapping_add(1);
        self.alarms.push(Alarm {
            id: format!("A{:04}", self.alarm_seq),
            at,
            severity,
            code: code.to_string(),
            message,
            metric,
            value,
        });
        if self.alarms.len() > ALARM_HISTORY_LIMIT {
            let excess = self.alarms.len() - ALARM_HISTORY_LIMIT;
            self.alarms.drain(0..excess);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(ledger: &mut AlarmLedger, at: f64, code: &str) -> bool {
        ledger.push(
            at,
            Severity::Warning,
            code,
            format!("{code} at {at}"),
            "metric".to_string(),
            at,
        )
    }

    #[test]
    fn same_code_within_window_is_dropped() {
        let mut ledger = AlarmLedger::default();
        assert!(push(&mut ledger, 0.0, "EFF_NH"));
        assert!(!push(&mut ledger, 10.0, "EFF_NH"));
        assert!(push(&mut ledger, 45.0, "EFF_NH"));
        assert_eq!(ledger.alarms.len(), 2);
        assert_eq!(ledger.alarm_seq, 2);
    }

    #[test]
    fn raise_limit_alarms_deduplicates_the_same_rule() {
        use crate::alarms::AlarmRuleInput;
        use crate::output::Effluent;
        let input = AlarmRuleInput {
            effluent: Effluent {
                flow: 2000.0,
                cod: 20.0,
                bod: 5.0,
                ss: 5.0,
                nh: 9.0,
                tn: 5.0,
                tp: 0.1,
                ph: 7.0,
                temperature: 20.0,
            },
            standard: None,
            last_do: 3.0,
            srt_days: 20.0,
            blanket_m: 1.0,
            depth: 4.0,
            at_min: Some(0.0),
        };
        let mut ledger = AlarmLedger::default();
        ledger.raise_limit_alarms(&input);
        assert_eq!(ledger.alarms.len(), 1);
        assert_eq!(ledger.alarms[0].code, "EFF_NH");
        ledger.raise_limit_alarms(&input);
        assert_eq!(ledger.alarms.len(), 1, "same step must not duplicate");
    }

    #[test]
    fn history_is_capped_at_eighty() {
        let mut ledger = AlarmLedger::default();
        for i in 0..100 {
            push(&mut ledger, i as f64, &format!("C{i}"));
        }
        assert_eq!(ledger.alarms.len(), 80);
        assert_eq!(ledger.alarms[0].code, "C20");
        assert_eq!(ledger.alarm_seq, 100);
    }
}

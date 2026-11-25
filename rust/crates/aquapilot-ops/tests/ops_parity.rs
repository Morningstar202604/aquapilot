//! Parity against the TypeScript M2-2 oracle frozen in `rust/golden/ops-cases.json`.
//!
//! This test is intentionally exact for booleans/strings and structural for
//! JSON payloads: the Rust port must not "look similar", it must decide the
//! same things as the current server.

use aquapilot_ops::audit::{DecisionAuditMark, decision_fingerprint, should_record_decision};
use aquapilot_ops::provider::validate_base_url;
use aquapilot_ops::rate_limit::{ClientState, RateKind, RateLimiter};
use aquapilot_ops::watchdog::{CheckInput, CheckResult, Severity, build_report};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    watchdog: Vec<WatchdogCase>,
    decisions: Vec<DecisionCase>,
    rate: Vec<RateCase>,
    url_cases: Vec<UrlCase>,
}

#[derive(Deserialize)]
struct WatchdogCase {
    input: CheckInput,
    checks: Vec<CheckResult>,
    severity: Severity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionCase {
    last: Option<LastMark>,
    fingerprint: String,
    at_min: f64,
    force: bool,
    window_min: f64,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastMark {
    key: String,
    at_min: f64,
}

#[derive(Deserialize)]
struct RateCase {
    times: Vec<u64>,
    limited: Vec<bool>,
    notices: Vec<Option<String>>,
}

#[derive(Deserialize)]
struct UrlCase {
    url: String,
    allowed: bool,
}

fn golden() -> Golden {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../golden/ops-cases.json"
    ))
    .expect("read rust/golden/ops-cases.json");
    serde_json::from_str(&raw).expect("parse ops cases")
}

#[test]
fn watchdog_matches_ts_oracle_case_by_case() {
    let cases = golden().watchdog;
    assert_eq!(cases.len(), 14);
    for (index, case) in cases.iter().enumerate() {
        let report = build_report(&case.input, "2026-11-25T12:00:00Z");
        assert_eq!(report.severity, case.severity, "severity case {index}");
        assert_eq!(report.checks, case.checks, "checks case {index}");
    }
}

#[test]
fn decision_dedupe_matches_ts_oracle() {
    let cases = golden().decisions;
    for case in cases {
        let last = case.last.map(|mark| DecisionAuditMark {
            key: mark.key,
            at_min: mark.at_min,
        });
        assert_eq!(
            should_record_decision(
                last.as_ref(),
                &case.fingerprint,
                case.at_min,
                case.force,
                case.window_min
            ),
            case.expected,
            "fingerprint {} at {}",
            case.fingerprint,
            case.at_min
        );
    }
    assert_eq!(
        decision_fingerprint("hold", "critical", "same"),
        "hold|critical|same"
    );
}

#[test]
fn rate_windows_and_notice_cooldown_match_ts_oracle() {
    let cases = golden().rate;
    let limiter = RateLimiter::default();

    let mut state = ClientState::default();
    let mut limited = Vec::new();
    for t in &cases[0].times {
        limited.push(limiter.limited(&mut state, RateKind::Control, *t));
    }
    assert_eq!(limited, cases[0].limited);

    let mut state = ClientState::default();
    let mut notices = Vec::new();
    for t in &cases[1].times {
        notices.push(limiter.notice(&mut state, "control", "too fast", *t));
    }
    assert_eq!(notices.len(), cases[1].notices.len());
    for (index, (got, want)) in notices.iter().zip(&cases[1].notices).enumerate() {
        match (got, want) {
            (None, None) => {}
            (Some(got), Some(want)) => {
                let got: Value = serde_json::from_str(got).unwrap();
                let want: Value = serde_json::from_str(want).unwrap();
                assert_eq!(got, want, "notice {index}");
            }
            other => panic!("notice {index} presence mismatch: {other:?}"),
        }
    }
}

#[test]
fn ssrf_url_decisions_match_ts_oracle() {
    let cases = golden().url_cases;
    assert_eq!(cases.len(), 9);
    for case in cases {
        let allowed = validate_base_url(&case.url).is_ok();
        assert_eq!(allowed, case.allowed, "url {}", case.url);
    }
}

//! Per-client fixed-window limiter plus throttled notices.
//!
//! Three defects from the TypeScript history are pinned here:
//! 1. a missing timestamp must not turn the window into NaN and silently pass;
//! 2. throttled messages must not emit one notice per message (amplification);
//! 3. state is per connection, so the caller must also cap connections.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTROL_MS: u64 = 500;
pub const TOPOLOGY_MS: u64 = 5_000;
pub const DECISION_MS: u64 = 2_000;
pub const CHAT_MS: u64 = 1_500;
pub const SNAPSHOT_MS: u64 = 1_000;
pub const NOTICE_COOLDOWN_MS: u64 = 2_000;
pub const MAX_LLM_IN_FLIGHT: usize = 2;
pub const MAX_WS_CLIENTS: usize = 50;
pub const MAX_BUFFERED_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RateKind {
    Control,
    Topology,
    Decision,
    Chat,
    Snapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientState {
    pub role: String,
    pub alive: bool,
    pub last_control_at: u64,
    pub last_topology_at: u64,
    pub last_trend_t: u64,
    pub last_llm_at: u64,
    pub last_decision_at: u64,
    pub last_chat_at: u64,
    pub hellos_sent: u32,
    pub last_snapshot_at: u64,
    pub llm_in_flight: usize,
    pub notice_at: BTreeMap<String, u64>,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            role: "viewer".into(),
            alive: true,
            last_control_at: 0,
            last_topology_at: 0,
            last_trend_t: 0,
            last_llm_at: 0,
            last_decision_at: 0,
            last_chat_at: 0,
            hellos_sent: 0,
            last_snapshot_at: 0,
            llm_in_flight: 0,
            notice_at: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateLimiter {
    pub notice_cooldown_ms: u64,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            notice_cooldown_ms: NOTICE_COOLDOWN_MS,
        }
    }
}

impl RateLimiter {
    /// Returns true when the request must be rejected. A zero timestamp is a
    /// valid "never used" value, not a missing value; subtract only after both
    /// operands exist.
    pub fn limited(&self, state: &mut ClientState, kind: RateKind, now_ms: u64) -> bool {
        let (last, window): (&mut u64, u64) = match kind {
            RateKind::Control => (&mut state.last_control_at, CONTROL_MS),
            RateKind::Topology => (&mut state.last_topology_at, TOPOLOGY_MS),
            RateKind::Decision => (&mut state.last_decision_at, DECISION_MS),
            RateKind::Chat => (&mut state.last_chat_at, CHAT_MS),
            RateKind::Snapshot => (&mut state.last_snapshot_at, SNAPSHOT_MS),
        };
        let elapsed = now_ms.saturating_sub(*last);
        if *last != 0 && elapsed < window {
            return true;
        }
        *last = now_ms;
        false
    }

    /// Build the throttled notice payload. Returns `None` while the cooldown is
    /// active, so a client dragging a slider cannot amplify server output.
    pub fn notice(
        &self,
        state: &mut ClientState,
        kind: &str,
        text: &str,
        now_ms: u64,
    ) -> Option<String> {
        if let Some(last) = state.notice_at.get(kind).copied()
            && now_ms.saturating_sub(last) < self.notice_cooldown_ms
        {
            return None;
        }
        state.notice_at.insert(kind.to_string(), now_ms);
        Some(
            serde_json::json!({
                "type": "notice",
                "level": "warn",
                "text": text,
            })
            .to_string(),
        )
    }

    pub fn allow_llm_request(state: &mut ClientState) -> bool {
        if state.llm_in_flight >= MAX_LLM_IN_FLIGHT {
            return false;
        }
        state.llm_in_flight += 1;
        true
    }

    pub fn finish_llm_request(state: &mut ClientState) {
        state.llm_in_flight = state.llm_in_flight.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_is_never_rejected() {
        let limiter = RateLimiter::default();
        let mut state = ClientState::default();
        assert!(!limiter.limited(&mut state, RateKind::Control, 0));
        assert!(!limiter.limited(&mut state, RateKind::Control, 1_000));
        assert!(limiter.limited(&mut state, RateKind::Control, 1_400));
    }

    #[test]
    fn each_kind_has_its_own_window() {
        let limiter = RateLimiter::default();
        let mut state = ClientState::default();
        assert!(!limiter.limited(&mut state, RateKind::Chat, 10_000));
        assert!(!limiter.limited(&mut state, RateKind::Control, 10_000));
        assert!(limiter.limited(&mut state, RateKind::Chat, 10_100));
        assert!(!limiter.limited(&mut state, RateKind::Chat, 11_500));
    }

    #[test]
    fn forty_messages_produce_two_notices() {
        let limiter = RateLimiter::default();
        let mut state = ClientState::default();
        let mut sent = 0;
        for i in 0..40u64 {
            // 40 messages inside 1 s, then one late message after cooldown.
            if limiter
                .notice(&mut state, "control", "too fast", i * 25)
                .is_some()
            {
                sent += 1;
            }
        }
        assert_eq!(sent, 1);
        if limiter
            .notice(&mut state, "control", "too fast", 2_500)
            .is_some()
        {
            sent += 1;
        }
        assert_eq!(sent, 2);
    }

    #[test]
    fn llm_in_flight_is_capped() {
        let _limiter = RateLimiter::default();
        let mut state = ClientState::default();
        assert!(RateLimiter::allow_llm_request(&mut state));
        assert!(RateLimiter::allow_llm_request(&mut state));
        assert!(!RateLimiter::allow_llm_request(&mut state));
        RateLimiter::finish_llm_request(&mut state);
        assert!(RateLimiter::allow_llm_request(&mut state));
    }
}

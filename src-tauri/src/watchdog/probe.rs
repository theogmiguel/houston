use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeReply {
    pub nonce: u64,
    pub js_now_ms: u64,
    pub js_perf_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Matched { nonce: u64, rtt_ms: u64 },
    Malformed,
    Unknown,
}

pub struct ProbeTable {
    outstanding: HashMap<u64, u64>,
    next_nonce: u64,
}

impl Default for ProbeTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProbeTable {
    pub fn new() -> Self {
        Self {
            outstanding: HashMap::new(),
            next_nonce: 1,
        }
    }

    #[cfg(test)]
    pub fn outstanding_len(&self) -> usize {
        self.outstanding.len()
    }

    pub fn issue(&mut self, now_ms: u64) -> (u64, String) {
        let nonce = self.next_nonce;
        self.next_nonce += 1;
        self.outstanding.insert(nonce, now_ms);
        (nonce, probe_script(nonce))
    }

    pub fn complete(&mut self, payload: &str, now_ms: u64) -> Completion {
        match parse_reply(payload) {
            Some(reply) => match self.outstanding.remove(&reply.nonce) {
                Some(issued) => Completion::Matched {
                    nonce: reply.nonce,
                    rtt_ms: now_ms.saturating_sub(issued),
                },
                None => Completion::Unknown,
            },
            // Native errors and callbacks from discarded generations can be empty.
            // Without a validated nonce they cannot complete any outstanding probe.
            None => Completion::Malformed,
        }
    }

    pub fn take_expired(&mut self, now_ms: u64, hang_ms: u64) -> Vec<u64> {
        let expired: Vec<u64> = self
            .outstanding
            .iter()
            .filter(|(_, &issued)| now_ms.saturating_sub(issued) >= hang_ms)
            .map(|(&nonce, _)| nonce)
            .collect();
        for nonce in &expired {
            self.outstanding.remove(nonce);
        }
        expired
    }

    pub fn discard(&mut self, nonce: u64) {
        self.outstanding.remove(&nonce);
    }

    pub fn discard_all(&mut self) {
        self.outstanding.clear();
    }
}

fn probe_script(nonce: u64) -> String {
    format!("(function(){{return {{t:Date.now(),p:Math.round(performance.now()),n:{nonce}}}}})()")
}

fn parse_reply(payload: &str) -> Option<ProbeReply> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    Some(ProbeReply {
        nonce: value.get("n")?.as_u64()?,
        js_now_ms: value.get("t")?.as_u64()?,
        js_perf_ms: value.get("p")?.as_u64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply_for(nonce: u64) -> String {
        format!(r#"{{"t":1700000000000,"p":1234,"n":{nonce}}}"#)
    }

    #[test]
    fn the_script_is_self_contained() {
        let script = probe_script(42);
        assert!(script.contains("n:42"));
        for forbidden in ["window.", "__TAURI", "houston"] {
            assert!(!script.contains(forbidden), "{script}");
        }
    }

    #[test]
    fn a_matching_reply_yields_the_round_trip_time() {
        let mut t = ProbeTable::new();
        let (nonce, _) = t.issue(1_000);
        match t.complete(&reply_for(nonce), 1_350) {
            Completion::Matched { rtt_ms, .. } => assert_eq!(rtt_ms, 350),
            other => panic!("{other:?}"),
        }
        assert_eq!(t.outstanding_len(), 0);
    }

    #[test]
    fn nonces_are_unique_per_probe() {
        let mut t = ProbeTable::new();
        let (a, _) = t.issue(0);
        let (b, _) = t.issue(1);
        assert_ne!(a, b);
        assert_eq!(t.outstanding_len(), 2);
    }

    #[test]
    fn replies_may_arrive_out_of_order() {
        let mut t = ProbeTable::new();
        let (a, _) = t.issue(1_000);
        let (b, _) = t.issue(2_000);
        assert!(matches!(
            t.complete(&reply_for(b), 2_100),
            Completion::Matched { rtt_ms: 100, .. }
        ));
        assert!(matches!(
            t.complete(&reply_for(a), 3_000),
            Completion::Matched { rtt_ms: 2_000, .. }
        ));
    }

    #[test]
    fn an_unknown_nonce_is_discarded_not_matched() {
        let mut t = ProbeTable::new();
        t.issue(1_000);
        assert_eq!(t.complete(&reply_for(9_999), 1_100), Completion::Unknown);
        assert_eq!(
            t.outstanding_len(),
            1,
            "a stray reply must not resolve an unrelated probe"
        );
    }

    #[test]
    fn malformed_payloads_preserve_every_outstanding_probe() {
        for payload in [
            "",
            "not json",
            "null",
            "{}",
            r#"{"n":1}"#,
            r#"{"n":1,"t":"invalid","p":123}"#,
            r#"{"n":1,"t":100,"p":null}"#,
        ] {
            let mut t = ProbeTable::new();
            let (a, _) = t.issue(1_000);
            let (b, _) = t.issue(2_000);
            assert!(
                !matches!(t.complete(payload, 2_500), Completion::Matched { .. }),
                "{payload:?}"
            );
            assert_eq!(
                t.outstanding_len(),
                2,
                "{payload:?} must not consume a nonce"
            );
            assert!(
                matches!(t.complete(&reply_for(a), 3_000), Completion::Matched { nonce, .. } if nonce == a)
            );
            assert!(
                matches!(t.complete(&reply_for(b), 3_000), Completion::Matched { nonce, .. } if nonce == b)
            );
        }
    }

    #[test]
    fn a_nonce_without_valid_timestamps_is_not_js_life() {
        for payload in [
            r#"{"n":1}"#,
            r#"{"n":1,"t":100}"#,
            r#"{"n":1,"t":"100","p":10}"#,
            r#"{"n":1,"t":100,"p":-1}"#,
        ] {
            let mut t = ProbeTable::new();
            let (nonce, _) = t.issue(1_000);
            assert!(
                !matches!(t.complete(payload, 2_000), Completion::Matched { .. }),
                "{payload}"
            );
            assert_eq!(t.take_expired(11_000, 10_000), vec![nonce]);
        }
    }

    #[test]
    fn a_valid_pre_navigation_reply_cannot_complete_a_post_load_probe() {
        let mut table = ProbeTable::new();
        let (old, _) = table.issue(1_000);
        table.discard_all();
        let (current, _) = table.issue(2_000);
        assert_eq!(table.complete(&reply_for(old), 2_010), Completion::Unknown);
        assert_eq!(table.outstanding_len(), 1);
        assert!(matches!(table.complete(&reply_for(current), 2_020),
            Completion::Matched { nonce, rtt_ms: 20 } if nonce == current));
    }

    #[test]
    fn an_empty_old_callback_cannot_complete_a_new_generation_probe() {
        let mut t = ProbeTable::new();
        t.issue(1_000);
        t.discard_all();
        let (current, _) = t.issue(2_000);
        t.complete("", 2_100);
        assert_eq!(t.take_expired(12_000, 10_000), vec![current]);
    }

    #[test]
    fn a_malformed_payload_with_nothing_outstanding_cannot_match() {
        let mut t = ProbeTable::new();
        assert!(!matches!(t.complete("", 1_000), Completion::Matched { .. }));
    }

    #[test]
    fn expiry_takes_only_probes_past_the_threshold() {
        let mut t = ProbeTable::new();
        let (old, _) = t.issue(0);
        t.issue(9_000);
        let expired = t.take_expired(10_000, 10_000);
        assert_eq!(expired, vec![old]);
        assert_eq!(t.outstanding_len(), 1);
    }

    #[test]
    fn expiry_is_inclusive_at_the_threshold() {
        let mut t = ProbeTable::new();
        t.issue(0);
        assert_eq!(t.take_expired(9_999, 10_000).len(), 0);
        assert_eq!(t.take_expired(10_000, 10_000).len(), 1);
    }

    #[test]
    fn an_expired_probe_is_only_reported_once() {
        let mut t = ProbeTable::new();
        t.issue(0);
        assert_eq!(t.take_expired(20_000, 10_000).len(), 1);
        assert_eq!(
            t.take_expired(30_000, 10_000).len(),
            0,
            "one hang must not be counted N times toward N_confirm"
        );
    }

    #[test]
    fn a_reply_arriving_after_its_own_timeout_is_unknown() {
        let mut t = ProbeTable::new();
        let (nonce, _) = t.issue(0);
        t.take_expired(20_000, 10_000);
        assert_eq!(
            t.complete(&reply_for(nonce), 25_000),
            Completion::Unknown,
            "a very late reply must not retroactively cancel a recorded failure"
        );
    }

    #[test]
    fn discarding_one_probe_leaves_the_others_in_flight() {
        let mut t = ProbeTable::new();
        let (a, _) = t.issue(0);
        t.issue(1_000);
        t.discard(a);
        assert_eq!(
            t.outstanding_len(),
            1,
            "a probe that failed to dispatch says nothing about the probes already in flight"
        );
        assert_eq!(
            t.take_expired(20_000, 10_000).len(),
            1,
            "the survivor still expires"
        );
    }

    #[test]
    fn discard_all_removes_without_failing() {
        let mut t = ProbeTable::new();
        t.issue(0);
        t.issue(1_000);
        t.discard_all();
        assert_eq!(t.outstanding_len(), 0);
        assert_eq!(
            t.take_expired(1_000_000, 10_000).len(),
            0,
            "discarded probes must never resurface as failures"
        );
    }
}

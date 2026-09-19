use houston_protocol as proto;
use serde_json::Value;

use super::time::parse_rfc3339_ms;

#[derive(Debug, Clone, PartialEq)]
pub struct UsageRecord {
    pub provider: proto::UsageProvider,
    pub timestamp_ms: i64,
    pub model: String,
    pub session_id: String,
    pub totals: proto::UsageTokenTotals,
    pub reported_cost_usd: Option<f64>,
    pub dedupe_key: Option<u64>,
}

fn count(v: Option<&Value>) -> u64 {
    match v.and_then(Value::as_i64) {
        Some(n) if n > 0 => n as u64,
        _ => 0,
    }
}

fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// FNV-1a, deliberately not `DefaultHasher`: these hashes are written to the
/// scan cache and compared by a later build, and `DefaultHasher` gives no
/// stability guarantee across releases — a silent change would stop deduping.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn dedupe_hash(message_id: Option<&str>, request_id: Option<&str>) -> Option<u64> {
    if message_id.is_none() && request_id.is_none() {
        return None;
    }
    let mut buf = Vec::with_capacity(96);
    buf.extend_from_slice(message_id.unwrap_or("").as_bytes());
    buf.push(b':');
    buf.extend_from_slice(request_id.unwrap_or("").as_bytes());
    Some(fnv1a64(&buf))
}

pub fn might_carry_usage(line: &str, provider: proto::UsageProvider) -> bool {
    match provider {
        proto::UsageProvider::Claude => line.contains("\"usage\""),
        proto::UsageProvider::Codex => line.contains("\"token_count\""),
    }
}

pub fn codex_line_is_relevant(line: &str) -> bool {
    might_carry_usage(line, proto::UsageProvider::Codex)
        || line.contains("\"turn_context\"")
        || line.contains("\"session_meta\"")
}

/// **The trap:** Claude writes one record per assistant *content block*, each
/// repeating the whole message's `usage`, so summing overcounts by ~2.4x. Drop
/// repeats by [`UsageRecord::dedupe_key`], globally — resuming copies them.
pub fn parse_claude_line(line: &str) -> Option<UsageRecord> {
    let root: Value = serde_json::from_str(line).ok()?;
    let record = root.as_object()?;

    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = record.get("message")?.as_object()?;
    let usage = message.get("usage")?.as_object()?;

    let timestamp_ms = parse_rfc3339_ms(text(record.get("timestamp"))?)?;
    let model = text(message.get("model"))?.to_string();

    let message_id = text(message.get("id"));
    let request_id = text(record.get("requestId"));
    let dedupe_key = dedupe_hash(message_id, request_id);

    Some(UsageRecord {
        provider: proto::UsageProvider::Claude,
        timestamp_ms,
        model,
        session_id: text(record.get("sessionId")).unwrap_or("").to_string(),
        totals: proto::UsageTokenTotals {
            uncached_input_tokens: count(usage.get("input_tokens")),
            cached_input_tokens: count(usage.get("cache_read_input_tokens")),
            cache_creation_tokens: count(usage.get("cache_creation_input_tokens")),
            output_tokens: count(usage.get("output_tokens")),
            reasoning_tokens: 0,
        },
        reported_cost_usd: record
            .get("costUSD")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite()),
        dedupe_key,
    })
}

/// A fork copies the parent's history re-stamped to the fork instant in one
/// synchronous burst, while the child's first real usage event comes a turn
/// later; one second splits them cleanly, and `pane_spawn` produces this shape.
const FORK_COPY_MAX_GAP_MS: i64 = 1_000;

#[derive(Debug, Default)]
pub struct CodexScanState {
    model: String,
    session_id: String,
    last_usage_signature: Option<String>,
    saw_session_meta: bool,
    suppressing_fork_copies: bool,
    fork_copy_anchor_ms: i64,
}

impl CodexScanState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn is_forked_session_meta(payload: &serde_json::Map<String, Value>) -> bool {
    if payload
        .get("forked_from_id")
        .and_then(Value::as_str)
        .is_some()
    {
        return true;
    }
    payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|s| s.get("subagent"))
        .and_then(Value::as_object)
        .and_then(|s| s.get("thread_spawn"))
        .and_then(Value::as_object)
        .and_then(|s| s.get("parent_thread_id"))
        .and_then(Value::as_str)
        .is_some()
}

/// **The traps, in order:** a fork repeats its ancestors' metas, so only the
/// first `session_meta` describes this file; `token_count` names no model, so it
/// is carried from `turn_context`; and re-emitted identical payloads are skipped.
pub fn parse_codex_line(line: &str, state: &mut CodexScanState) -> Option<UsageRecord> {
    let root: Value = serde_json::from_str(line).ok()?;
    let record = root.as_object()?;
    let payload = record.get("payload")?.as_object()?;
    let record_type = record.get("type").and_then(Value::as_str);

    if record_type == Some("session_meta") {
        if state.saw_session_meta {
            return None;
        }
        state.saw_session_meta = true;
        if let Some(id) = text(payload.get("id")).or_else(|| text(payload.get("session_id"))) {
            state.session_id = id.to_string();
        }
        if let Some(meta_ms) = text(record.get("timestamp")).and_then(parse_rfc3339_ms) {
            if is_forked_session_meta(payload) {
                state.suppressing_fork_copies = true;
                state.fork_copy_anchor_ms = meta_ms;
            }
        }
        return None;
    }

    if record_type == Some("turn_context") {
        if let Some(model) = text(payload.get("model")) {
            state.model = model.to_string();
        }
        return None;
    }

    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let last = payload.get("info")?.as_object()?.get("last_token_usage")?;
    let last_map = last.as_object()?;

    let timestamp_ms = parse_rfc3339_ms(text(record.get("timestamp"))?)?;
    if state.model.is_empty() {
        return None;
    }

    let signature = last.to_string();
    if state.last_usage_signature.as_deref() == Some(signature.as_str()) {
        return None;
    }
    state.last_usage_signature = Some(signature);

    if state.suppressing_fork_copies {
        if timestamp_ms - state.fork_copy_anchor_ms < FORK_COPY_MAX_GAP_MS {
            state.fork_copy_anchor_ms = timestamp_ms;
            return None;
        }
        state.suppressing_fork_copies = false;
    }

    let input_tokens = count(last_map.get("input_tokens"));
    let cached_input_tokens = count(last_map.get("cached_input_tokens"));
    let cache_creation_tokens = count(last_map.get("cache_write_input_tokens"));
    let output_tokens = count(last_map.get("output_tokens"));

    let totals = proto::UsageTokenTotals {
        uncached_input_tokens: input_tokens
            .saturating_sub(cached_input_tokens)
            .saturating_sub(cache_creation_tokens),
        cached_input_tokens,
        cache_creation_tokens,
        output_tokens,
        reasoning_tokens: count(last_map.get("reasoning_output_tokens")).min(output_tokens),
    };

    if totals.total() == 0 {
        return None;
    }

    Some(UsageRecord {
        provider: proto::UsageProvider::Codex,
        timestamp_ms,
        model: state.model.clone(),
        session_id: state.session_id.clone(),
        totals,
        reported_cost_usd: None,
        dedupe_key: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_line(id: &str, request: &str, ts: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","sessionId":"s1","requestId":"{request}",
             "message":{{"id":"{id}","model":"claude-opus-5",
             "usage":{{"input_tokens":{input},"output_tokens":{output},
             "cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}}}}"#
        )
        .replace('\n', "")
    }

    #[test]
    fn claude_content_blocks_share_one_dedupe_key() {
        let a = parse_claude_line(&claude_line(
            "msg_1",
            "req_1",
            "2026-08-27T10:00:00Z",
            100,
            50,
        ))
        .expect("block 1 parses");
        let b = parse_claude_line(&claude_line(
            "msg_1",
            "req_1",
            "2026-08-27T10:00:00Z",
            100,
            50,
        ))
        .expect("block 2 parses");
        assert_eq!(a.dedupe_key, b.dedupe_key);
        assert_eq!(a.dedupe_key, dedupe_hash(Some("msg_1"), Some("req_1")));
        let other = parse_claude_line(&claude_line("msg_2", "req_2", "2026-08-27T10:00:01Z", 1, 1))
            .unwrap();
        assert_ne!(a.dedupe_key, other.dedupe_key);
    }

    #[test]
    fn the_dedupe_hash_is_pinned_so_cached_keys_stay_comparable() {
        assert_eq!(
            dedupe_hash(Some("msg_1"), Some("req_1")),
            Some(8_889_374_960_014_768_852)
        );
        assert_eq!(
            dedupe_hash(Some("msg_1"), None),
            Some(17_904_985_851_531_154_408)
        );
        assert_eq!(dedupe_hash(None, None), None);
        assert_ne!(
            dedupe_hash(Some("ab"), Some("c")),
            dedupe_hash(Some("a"), Some("bc"))
        );
    }

    #[test]
    fn claude_falls_back_to_whichever_id_half_exists() {
        let only_message = r#"{"type":"assistant","timestamp":"2026-08-27T10:00:00Z",
          "message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_claude_line(&only_message).unwrap().dedupe_key,
            dedupe_hash(Some("msg_1"), None)
        );
        let neither = r#"{"type":"assistant","timestamp":"2026-08-27T10:00:00Z",
          "message":{"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1}}}"#
            .replace('\n', "");
        assert_eq!(parse_claude_line(&neither).unwrap().dedupe_key, None);
    }

    #[test]
    fn claude_input_fields_are_already_disjoint() {
        let r = parse_claude_line(&claude_line("m", "r", "2026-08-27T10:00:00Z", 100, 50)).unwrap();
        assert_eq!(r.totals.uncached_input_tokens, 100);
        assert_eq!(r.totals.cached_input_tokens, 7);
        assert_eq!(r.totals.cache_creation_tokens, 3);
        assert_eq!(r.totals.output_tokens, 50);
        assert_eq!(r.totals.reasoning_tokens, 0);
        assert_eq!(r.totals.total(), 160);
    }

    #[test]
    fn claude_skips_everything_that_is_not_an_assistant_turn_with_usage() {
        assert!(parse_claude_line("not json").is_none());
        assert!(parse_claude_line(r#"{"type":"user","message":{"usage":{}}}"#).is_none());
        assert!(parse_claude_line(
            r#"{"type":"assistant","message":{"id":"m","model":"x","usage":{"input_tokens":1}}}"#
        )
        .is_none());
        assert!(parse_claude_line(
            r#"{"type":"assistant","timestamp":"2026-08-27T10:00:00Z","message":{"id":"m","usage":{"input_tokens":1}}}"#
        )
        .is_none());
    }

    fn codex_meta(ts: &str, forked: bool) -> String {
        let extra = if forked {
            r#","forked_from_id":"parent_1""#
        } else {
            ""
        };
        format!(
            r#"{{"type":"session_meta","timestamp":"{ts}","payload":{{"id":"sess_1"{extra}}}}}"#
        )
    }

    fn codex_turn_context(model: &str) -> String {
        format!(
            r#"{{"type":"turn_context","timestamp":"2026-08-27T10:00:00Z","payload":{{"model":"{model}"}}}}"#
        )
    }

    fn codex_tokens(ts: &str, input: u64, cached: u64, output: u64) -> String {
        format!(
            r#"{{"type":"event_msg","timestamp":"{ts}","payload":{{"type":"token_count",
             "info":{{"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},
             "cache_write_input_tokens":0,"output_tokens":{output},"reasoning_output_tokens":10}}}}}}}}"#
        )
        .replace('\n', "")
    }

    #[test]
    fn codex_input_is_reported_inclusive_of_cache_and_gets_split() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_meta("2026-08-27T10:00:00Z", false), &mut st);
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        let r = parse_codex_line(
            &codex_tokens("2026-08-27T10:00:05Z", 1000, 900, 200),
            &mut st,
        )
        .expect("token_count parses");
        assert_eq!(r.totals.uncached_input_tokens, 100);
        assert_eq!(r.totals.cached_input_tokens, 900);
        assert_eq!(
            r.totals.uncached_input_tokens
                + r.totals.cached_input_tokens
                + r.totals.cache_creation_tokens,
            1000
        );
        assert_eq!(r.totals.reasoning_tokens, 10);
        assert_eq!(r.model, "gpt-5-codex");
        assert_eq!(r.session_id, "sess_1");
    }

    #[test]
    fn codex_drops_repeated_identical_token_counts() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        let line = codex_tokens("2026-08-27T10:00:05Z", 1000, 900, 200);
        assert!(parse_codex_line(&line, &mut st).is_some());
        assert!(
            parse_codex_line(&line, &mut st).is_none(),
            "an unchanged re-emitted token_count must not be counted twice"
        );
        assert!(parse_codex_line(
            &codex_tokens("2026-08-27T10:00:09Z", 1200, 900, 250),
            &mut st
        )
        .is_some());
    }

    #[test]
    fn codex_token_count_before_turn_context_does_not_poison_the_signature() {
        let mut st = CodexScanState::new();
        let line = codex_tokens("2026-08-27T10:00:05Z", 1000, 900, 200);
        assert!(parse_codex_line(&line, &mut st).is_none());
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        assert!(
            parse_codex_line(&line, &mut st).is_some(),
            "the re-emitted event after the model is known must still count"
        );
    }

    #[test]
    fn codex_fork_copies_are_suppressed_until_a_real_turn() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_meta("2026-08-27T10:00:00.000Z", true), &mut st);
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        assert!(parse_codex_line(
            &codex_tokens("2026-08-27T10:00:00.010Z", 100, 0, 10),
            &mut st
        )
        .is_none());
        assert!(parse_codex_line(
            &codex_tokens("2026-08-27T10:00:00.030Z", 200, 0, 20),
            &mut st
        )
        .is_none());
        let real = parse_codex_line(&codex_tokens("2026-08-27T10:00:06Z", 300, 0, 30), &mut st)
            .expect("the first real turn must count");
        assert_eq!(real.totals.output_tokens, 30);
        assert!(parse_codex_line(
            &codex_tokens("2026-08-27T10:00:06.020Z", 400, 0, 40),
            &mut st
        )
        .is_some());
    }

    #[test]
    fn codex_unforked_rollout_counts_its_first_event() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_meta("2026-08-27T10:00:00.000Z", false), &mut st);
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        assert!(
            parse_codex_line(
                &codex_tokens("2026-08-27T10:00:00.010Z", 100, 0, 10),
                &mut st
            )
            .is_some(),
            "suppression must apply to forks only"
        );
    }

    #[test]
    fn codex_keeps_the_first_session_meta_only() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_meta("2026-08-27T10:00:00Z", false), &mut st);
        parse_codex_line(
            r#"{"type":"session_meta","timestamp":"2026-08-27T10:00:01Z","payload":{"id":"ancestor"}}"#,
            &mut st,
        );
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        let r =
            parse_codex_line(&codex_tokens("2026-08-27T10:00:05Z", 100, 0, 10), &mut st).unwrap();
        assert_eq!(r.session_id, "sess_1", "ancestor metas must not reassign");
    }

    #[test]
    fn codex_zero_token_events_are_not_records() {
        let mut st = CodexScanState::new();
        parse_codex_line(&codex_turn_context("gpt-5-codex"), &mut st);
        assert!(
            parse_codex_line(&codex_tokens("2026-08-27T10:00:05Z", 0, 0, 0), &mut st).is_none()
        );
    }

    #[test]
    fn substring_gates_admit_what_the_parsers_need() {
        assert!(might_carry_usage(
            r#"{"message":{"usage":{}}}"#,
            proto::UsageProvider::Claude
        ));
        assert!(!might_carry_usage(
            "tool output",
            proto::UsageProvider::Claude
        ));
        assert!(codex_line_is_relevant(&codex_turn_context("m")));
        assert!(codex_line_is_relevant(&codex_meta(
            "2026-08-27T10:00:00Z",
            false
        )));
        assert!(codex_line_is_relevant(&codex_tokens(
            "2026-08-27T10:00:00Z",
            1,
            0,
            1
        )));
        assert!(!codex_line_is_relevant(
            r#"{"payload":{"type":"agent_message"}}"#
        ));
    }
}

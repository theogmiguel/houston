// ACP is a third lawful status source (docs/internals/invariants.md): a
// public, versioned protocol Houston reads directly, not screen-scraped and
// not an undocumented vendor stdio format.
use houston_protocol as proto;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownAcpAgent {
    pub slug: &'static str,
    pub display_name: &'static str,
    pub argv: &'static [&'static str],
    pub model_select_flag: Option<&'static str>,
}

const OPENCODE: KnownAcpAgent = KnownAcpAgent {
    slug: "acp-opencode",
    display_name: "opencode",
    argv: &["opencode", "acp"],
    model_select_flag: None,
};

const OMP: KnownAcpAgent = KnownAcpAgent {
    slug: "acp-omp",
    display_name: "omp",
    argv: &["omp", "acp"],
    model_select_flag: None,
};

// `--model` here is a different flag than Houston's hook-driven grok kind
// uses (`-m`, in `swarm.rs::flags_only`). Recorded as-is, not reconciled —
// that resolution is wiring work this module deliberately excludes.
const GROK: KnownAcpAgent = KnownAcpAgent {
    slug: "acp-grok",
    display_name: "Grok Build",
    argv: &["grok", "agent", "stdio"],
    model_select_flag: Some("--model"),
};

const HERMES: KnownAcpAgent = KnownAcpAgent {
    slug: "acp-hermes-agent",
    display_name: "Hermes Agent",
    argv: &["hermes", "acp"],
    model_select_flag: None,
};

pub const KNOWN_ACP_AGENTS: &[KnownAcpAgent] = &[OPENCODE, OMP, GROK, HERMES];

pub fn find_known_acp_agent(slug: &str) -> Option<&'static KnownAcpAgent> {
    KNOWN_ACP_AGENTS.iter().find(|agent| agent.slug == slug)
}

// ACP messages are normally small (envelope + a chunk of text or a tool
// summary), but a buggy or hostile child could write an unterminated stream
// forever. 1 MiB bounds the decode buffer without ever hitting a real message.
pub const MAX_ACP_LINE_LEN: usize = 1024 * 1024;

#[derive(Debug)]
pub enum AcpDecodeOutcome {
    Message(serde_json::Value),
    Error(AcpDecodeError),
}

#[derive(Debug)]
pub enum AcpDecodeError {
    Malformed {
        line: String,
        source: serde_json::Error,
    },
    LineTooLong {
        len: usize,
        cap: usize,
    },
}

impl std::fmt::Display for AcpDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcpDecodeError::Malformed { line, source } => write!(
                f,
                "ACP line is not valid JSON-RPC (expected a JSON object per line): {source} \
                 -- line: {line:?}"
            ),
            AcpDecodeError::LineTooLong { len, cap } => write!(
                f,
                "ACP line reached {len} bytes without a newline (cap {cap}); discarding the \
                 partial buffer so it cannot grow without bound"
            ),
        }
    }
}

impl std::error::Error for AcpDecodeError {}

#[derive(Debug, Default)]
pub struct AcpDecoder {
    buf: Vec<u8>,
}

impl AcpDecoder {
    pub fn new() -> Self {
        AcpDecoder { buf: Vec::new() }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<AcpDecodeOutcome> {
        self.buf.extend_from_slice(chunk);
        let mut outcomes = Vec::new();

        while let Some(newline_at) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=newline_at).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<serde_json::Value>(&line) {
                Ok(value) => outcomes.push(AcpDecodeOutcome::Message(value)),
                Err(source) => outcomes.push(AcpDecodeOutcome::Error(AcpDecodeError::Malformed {
                    line: String::from_utf8_lossy(&line).into_owned(),
                    source,
                })),
            }
        }

        if self.buf.len() > MAX_ACP_LINE_LEN {
            let len = self.buf.len();
            self.buf.clear();
            outcomes.push(AcpDecodeOutcome::Error(AcpDecodeError::LineTooLong {
                len,
                cap: MAX_ACP_LINE_LEN,
            }));
        }

        outcomes
    }
}

pub fn status_for_message(message: &serde_json::Value) -> Option<proto::AgentStatus> {
    event_for_message(message).map(crate::agent_events::AgentEvent::status)
}

// Only request_permission and a stopReason change status; every other
// session/update (agent_message_chunk, tool_call, plan, ...) is progress
// within an already-Working turn and must never be guessed into a status.
pub fn event_for_message(message: &serde_json::Value) -> Option<crate::agent_events::AgentEvent> {
    use crate::agent_events::AgentEvent;
    let obj = message.as_object()?;

    if obj.get("method").and_then(|m| m.as_str()) == Some("session/request_permission") {
        return Some(AgentEvent::NeedsInput);
    }

    if let Some(result) = obj.get("result").and_then(|r| r.as_object()) {
        if result.contains_key("stopReason") {
            return Some(AgentEvent::TurnEnded);
        }
    }

    None
}

pub fn agent_kind_for(agent: &KnownAcpAgent) -> proto::AgentKind {
    match agent.argv.first().copied() {
        Some("opencode") => proto::AgentKind::Opencode,
        Some("grok") => proto::AgentKind::Grok,
        _ => proto::AgentKind::Custom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn a_rows_agent_kind_follows_its_command_not_its_slug() {
        use proto::AgentKind::*;
        assert_eq!(agent_kind_for(&OPENCODE), Opencode);
        assert_eq!(agent_kind_for(&GROK), Grok);
        assert_eq!(agent_kind_for(&OMP), Custom);
        assert_eq!(agent_kind_for(&HERMES), Custom);
    }

    #[test]
    fn every_known_agent_slug_is_unique() {
        let slugs: BTreeSet<&str> = KNOWN_ACP_AGENTS.iter().map(|a| a.slug).collect();
        assert_eq!(
            slugs.len(),
            KNOWN_ACP_AGENTS.len(),
            "duplicate slug in KNOWN_ACP_AGENTS: {slugs:?}"
        );
    }

    #[test]
    fn every_known_agent_has_a_nonempty_argv() {
        for agent in KNOWN_ACP_AGENTS {
            assert!(
                !agent.argv.is_empty(),
                "{} has empty argv, which cannot launch anything",
                agent.slug
            );
        }
    }

    #[test]
    fn find_known_acp_agent_returns_the_matching_row() {
        let grok = find_known_acp_agent("acp-grok").expect("acp-grok is a known agent");
        assert_eq!(grok.argv, &["grok", "agent", "stdio"]);
        assert_eq!(grok.model_select_flag, Some("--model"));
    }

    #[test]
    fn find_known_acp_agent_returns_none_for_an_unknown_slug() {
        assert!(find_known_acp_agent("acp-nonexistent").is_none());
    }

    fn only_messages(outcomes: Vec<AcpDecodeOutcome>) -> Vec<serde_json::Value> {
        outcomes
            .into_iter()
            .map(|o| match o {
                AcpDecodeOutcome::Message(v) => v,
                AcpDecodeOutcome::Error(e) => panic!("unexpected decode error: {e}"),
            })
            .collect()
    }

    #[test]
    fn a_single_chunk_with_one_line_parses_to_one_message() {
        let mut decoder = AcpDecoder::new();
        let outcomes = decoder.feed(b"{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}\n");
        let messages = only_messages(outcomes);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["method"], "ping");
    }

    #[test]
    fn a_message_split_across_chunks_still_parses() {
        let mut decoder = AcpDecoder::new();
        let first = decoder.feed(b"{\"jsonrpc\":\"2.0\",\"meth");
        assert!(
            first.is_empty(),
            "no complete line yet, nothing should decode"
        );
        let outcomes = decoder.feed(b"od\":\"session/request_permission\"}\n");
        let messages = only_messages(outcomes);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["method"], "session/request_permission");
    }

    #[test]
    fn two_messages_in_one_chunk_both_parse_in_order() {
        let mut decoder = AcpDecoder::new();
        let outcomes = decoder.feed(b"{\"a\":1}\n{\"a\":2}\n");
        let messages = only_messages(outcomes);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["a"], 1);
        assert_eq!(messages[1]["a"], 2);
    }

    #[test]
    fn blank_lines_are_skipped_without_producing_an_outcome() {
        let mut decoder = AcpDecoder::new();
        let outcomes = decoder.feed(b"\n\n{\"a\":1}\n\n");
        let messages = only_messages(outcomes);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn a_malformed_line_is_reported_and_does_not_lose_the_buffer() {
        let mut decoder = AcpDecoder::new();
        let outcomes = decoder.feed(b"not json\n{\"a\":1}\n");
        assert_eq!(outcomes.len(), 2);
        match &outcomes[0] {
            AcpDecodeOutcome::Error(AcpDecodeError::Malformed { line, .. }) => {
                assert_eq!(line, "not json");
            }
            other => panic!("expected a Malformed error, got {other:?}"),
        }
        match &outcomes[1] {
            AcpDecodeOutcome::Message(v) => assert_eq!(v["a"], 1),
            other => panic!("expected the following line to still parse, got {other:?}"),
        }
    }

    #[test]
    fn an_unterminated_line_past_the_cap_is_reported_and_the_buffer_is_bounded() {
        let mut decoder = AcpDecoder::new();
        let oversized = vec![b'a'; MAX_ACP_LINE_LEN + 1];
        let outcomes = decoder.feed(&oversized);
        assert_eq!(outcomes.len(), 1);
        match &outcomes[0] {
            AcpDecodeOutcome::Error(AcpDecodeError::LineTooLong { len, cap }) => {
                assert_eq!(*cap, MAX_ACP_LINE_LEN);
                assert_eq!(*len, MAX_ACP_LINE_LEN + 1);
            }
            other => panic!("expected a LineTooLong error, got {other:?}"),
        }
        let outcomes = decoder.feed(b"{\"a\":1}\n");
        let messages = only_messages(outcomes);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn a_request_permission_request_means_needs_input() {
        let message: serde_json::Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}"#,
        )
        .expect("fixture is valid JSON");
        assert_eq!(
            status_for_message(&message),
            Some(proto::AgentStatus::NeedsInput)
        );
    }

    #[test]
    fn a_prompt_response_with_a_stop_reason_means_idle() {
        for reason in [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
        ] {
            let message: serde_json::Value = serde_json::from_str(&format!(
                r#"{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"{reason}"}}}}"#
            ))
            .expect("fixture is valid JSON");
            assert_eq!(
                status_for_message(&message),
                Some(proto::AgentStatus::Idle),
                "stopReason {reason} should map to Idle"
            );
        }
    }

    #[test]
    fn a_session_update_notification_maps_to_no_status_change() {
        for update_kind in [
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "plan",
            "current_mode_update",
            "available_commands_update",
        ] {
            let message: serde_json::Value = serde_json::from_str(&format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"{update_kind}"}}}}}}"#
            ))
            .expect("fixture is valid JSON");
            assert_eq!(
                status_for_message(&message),
                None,
                "sessionUpdate {update_kind} should not be guessed into a status"
            );
        }
    }

    #[test]
    fn an_unrecognized_message_maps_to_no_status_change() {
        let message: serde_json::Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"some/future/method"}"#)
                .expect("fixture is valid JSON");
        assert_eq!(status_for_message(&message), None);
    }
}

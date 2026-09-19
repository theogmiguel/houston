//! Shared plumbing for the headless engine adapters: argv shapes, stream
//! decoding and the permission-question vocabulary the decoders produce.
//! The Writer one-shot role and every routine run ride this.

use houston_protocol as proto;
use serde_json::Value;

pub const CLAUDE_CLI: &str = "claude";

pub const PERMISSION_TOOL: &str = "permission_prompt";

pub fn permission_tool_arg() -> String {
    format!(
        "mcp__{}__{}",
        crate::mcp_server::SERVER_NAME,
        PERMISSION_TOOL
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSupport {
    pub can_chat: bool,
    pub reason: Option<String>,
}

pub fn engine_support(engine: proto::AgentKind) -> EngineSupport {
    use proto::AgentKind as K;
    if crate::headless::engine_for(engine).is_some() {
        return EngineSupport {
            can_chat: true,
            reason: None,
        };
    }
    let reason = match engine {
        K::Claude | K::Codex | K::Opencode | K::Grok => unreachable!(
            "every registered engine has a headless::engine_for implementation; the branch \
             above already returned"
        ),
        K::Antigravity => Some(
            "Panes only. Google's terms on third-party access are unclear, and a strike can \
             reach your Google account.",
        ),
        K::Cursor => Some("Panes only. No verified headless stream."),
        _ => Some(
            "This engine can't run in a chat yet — no documented JSON event stream is wired for \
             it. Launch it in a terminal pane instead.",
        ),
    };
    EngineSupport {
        can_chat: reason.is_none(),
        reason: reason.map(str::to_string),
    }
}

pub fn engine_support_table() -> Vec<(proto::AgentKind, EngineSupport)> {
    use proto::AgentKind as K;
    [
        K::Claude,
        K::Codex,
        K::Antigravity,
        K::Opencode,
        K::Cursor,
        K::Grok,
        K::Shell,
        K::Ssh,
        K::Droid,
        K::Copilot,
        K::Aider,
        K::Custom,
    ]
    .into_iter()
    .map(|kind| (kind, engine_support(kind)))
    .collect()
}

// The argv IS the integration contract with Claude Code: print mode over
// documented stream-json, continuity replayed with `--resume <id>` from the
// `result` event. No transcript file is opened, no `control_request` written.
#[allow(clippy::too_many_arguments)]
pub fn claude_args(
    model: Option<&str>,
    effort: Option<proto::ChatEffort>,
    permission_mode: Option<proto::ChatPermissionMode>,
    resume_id: Option<&str>,
    plan: bool,
    purpose: Option<&str>,
    mcp_args: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("--effort".into());
        args.push(e.cli_value().to_string());
    }
    if let Some(r) = resume_id {
        args.push("--resume".into());
        args.push(r.to_string());
    }
    let mode = if plan {
        Some("plan")
    } else {
        permission_mode.map(|m| m.cli_value())
    };
    if let Some(mode) = mode {
        args.push("--permission-mode".into());
        args.push(mode.to_string());
    }
    if let Some(purpose) = purpose.map(str::trim).filter(|p| !p.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(purpose.to_string());
    }
    args.extend_from_slice(mcp_args);
    args.push("--permission-prompt-tool".into());
    args.push(permission_tool_arg());
    args
}

pub fn user_turn_line(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        }
    })
    .to_string()
}

pub use crate::headless::Decoded;

pub fn decode_line(line: &str) -> Vec<Decoded> {
    let line = line.trim();
    if line.is_empty() {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    match v.get("type").and_then(Value::as_str) {
        Some("system") => {
            if v.get("subtype").and_then(Value::as_str) == Some("init") {
                vec![Decoded::Init {
                    session_id: str_field(&v, "session_id"),
                }]
            } else {
                Vec::new()
            }
        }
        Some("stream_event") => {
            let ev = v.get("event").unwrap_or(&Value::Null);
            if ev.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return Vec::new();
            }
            let delta = ev.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => str_field(delta, "text")
                    .map(|text| vec![Decoded::TextDelta { text }])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        Some("assistant") => content_blocks(&v)
            .iter()
            .filter_map(assistant_block)
            .collect(),
        Some("user") => content_blocks(&v)
            .iter()
            .filter_map(tool_result_block)
            .collect(),
        Some("result") => {
            let is_error = v
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    v.get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s != "success")
                });
            let usage = v.get("usage").cloned().unwrap_or(Value::Null);
            vec![Decoded::Result {
                ok: !is_error,
                session_id: str_field(&v, "session_id"),
                error: if is_error {
                    str_field(&v, "result").or_else(|| str_field(&v, "error"))
                } else {
                    None
                },
                usage: proto::ChatUsage {
                    input_tokens: u64_field(&usage, "input_tokens"),
                    output_tokens: u64_field(&usage, "output_tokens"),
                    cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
                    duration_ms: u64_field(&v, "duration_ms"),
                },
            }]
        }
        Some("error") => str_field(&v, "message")
            .or_else(|| str_field(&v, "error"))
            .map(|text| vec![Decoded::StreamError { text }])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn content_blocks(v: &Value) -> Vec<Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn assistant_block(b: &Value) -> Option<Decoded> {
    match b.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = str_field(b, "text")?;
            (!text.trim().is_empty()).then_some(Decoded::Text { text })
        }
        "thinking" => {
            let text = str_field(b, "thinking").or_else(|| str_field(b, "text"))?;
            (!text.trim().is_empty()).then_some(Decoded::Reasoning { text })
        }
        "tool_use" => Some(Decoded::ToolStart {
            id: str_field(b, "id")?,
            name: str_field(b, "name").unwrap_or_else(|| "tool".into()),
            detail: tool_input_summary(b.get("input")),
        }),
        _ => None,
    }
}

fn tool_result_block(b: &Value) -> Option<Decoded> {
    if b.get("type").and_then(Value::as_str)? != "tool_result" {
        return None;
    }
    Some(Decoded::ToolEnd {
        id: str_field(b, "tool_use_id")?,
        ok: !b
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or_default(),
        detail: tool_result_summary(b.get("content")),
    })
}

pub const TOOL_DETAIL_MAX: usize = 400;

fn tool_input_summary(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    for key in ["command", "file_path", "path", "pattern", "url", "prompt"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return clip(s);
        }
    }
    clip(&input.to_string())
}

fn tool_result_summary(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => clip(s),
        Some(Value::Array(blocks)) => {
            let joined = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            clip(&joined)
        }
        Some(other) => clip(&other.to_string()),
        None => String::new(),
    }
}

fn clip(s: &str) -> String {
    let s = s.trim();
    if s.len() <= TOOL_DETAIL_MAX {
        return s.to_string();
    }
    let mut end = TOOL_DETAIL_MAX;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (+{} bytes)", &s[..end], s.len() - end)
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn u64_field(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

pub const ANSWER_ALLOW_ONCE: &str = "allow_once";
pub const ANSWER_ALLOW_SESSION: &str = "allow_for_session";
pub const ANSWER_DENY: &str = "deny";

pub fn question_for_permission(
    request_id: &str,
    tool_name: &str,
    input: &Value,
) -> proto::ChatQuestion {
    if tool_name == "AskUserQuestion" {
        if let Some(q) = ask_user_question(request_id, input) {
            return q;
        }
    }
    proto::ChatQuestion {
        id: request_id.to_string(),
        kind: proto::ChatQuestionKind::Permission,
        header: Some(format!("Approval needed for {tool_name}")),
        prompt: {
            let detail = tool_input_summary(Some(input));
            if detail.is_empty() {
                format!("{tool_name} wants to run.")
            } else {
                format!("{tool_name}: {detail}")
            }
        },
        options: vec![
            proto::ChatQuestionOption {
                label: ANSWER_ALLOW_ONCE.into(),
                description: Some("Run it this once.".into()),
            },
            proto::ChatQuestionOption {
                label: ANSWER_ALLOW_SESSION.into(),
                description: Some("Run it, and stop asking for this tool in this turn.".into()),
            },
            proto::ChatQuestionOption {
                label: ANSWER_DENY.into(),
                description: Some("Don't run it. The agent is told why.".into()),
            },
        ],
        multi_select: false,
        allow_free_text: false,
        answered: None,
    }
}

fn ask_user_question(request_id: &str, input: &Value) -> Option<proto::ChatQuestion> {
    let q = input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|qs| qs.first())?;
    let prompt = str_field(q, "question")?;
    let options: Vec<proto::ChatQuestionOption> = q
        .get("options")
        .and_then(Value::as_array)
        .map(|os| {
            os.iter()
                .filter_map(|o| {
                    Some(proto::ChatQuestionOption {
                        label: str_field(o, "label")?,
                        description: str_field(o, "description"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(proto::ChatQuestion {
        id: request_id.to_string(),
        kind: proto::ChatQuestionKind::Choice,
        header: str_field(q, "header"),
        prompt,
        options,
        multi_select: q
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        allow_free_text: true,
        answered: None,
    })
}

pub fn permission_reply(
    kind: proto::ChatQuestionKind,
    question_text: &str,
    answer: &str,
    original_input: &Value,
) -> Value {
    match kind {
        proto::ChatQuestionKind::Choice => {
            // The `answers` map KEY must be the full question text: Claude
            // Code looks answers up by it, so any other key silently loses
            // the answer and the turn continues having heard nothing.
            let mut answers = serde_json::Map::new();
            answers.insert(question_text.to_string(), Value::String(answer.to_string()));
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": {
                    "questions": original_input.get("questions").cloned().unwrap_or(Value::Null),
                    "answers": Value::Object(answers),
                },
            })
        }
        proto::ChatQuestionKind::Permission => {
            if answer == ANSWER_ALLOW_ONCE || answer == ANSWER_ALLOW_SESSION {
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": original_input.clone(),
                })
            } else {
                serde_json::json!({
                    "behavior": "deny",
                    "message": "The user declined this action.",
                })
            }
        }
    }
}

#[derive(Debug)]
pub struct PendingQuestion {
    pub question: proto::ChatQuestion,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_argv_is_the_documented_stream_and_nothing_else() {
        let args = claude_args(
            Some("opus"),
            Some(proto::ChatEffort::Xhigh),
            Some(proto::ChatPermissionMode::AcceptEdits),
            Some("sess-1"),
            true,
            Some("Ship the thing"),
            &["--mcp-config".into()],
        );
        let joined = args.join(" ");
        for expected in [
            "-p",
            "--input-format stream-json",
            "--output-format stream-json",
            "--verbose",
            "--model opus",
            "--effort xhigh",
            "--resume sess-1",
            "--permission-mode plan",
            "--append-system-prompt Ship the thing",
        ] {
            assert!(
                joined.contains(expected),
                "missing {expected:?} in {joined}"
            );
        }
        assert!(joined.contains("--permission-prompt-tool mcp__houston__permission_prompt"));
        for forbidden in [
            concat!("control_", "request"),
            concat!(".js", "onl"),
            concat!("proj", "ects"),
        ] {
            assert!(
                !joined.contains(forbidden),
                "argv reaches for {forbidden:?}: {joined}"
            );
        }
    }

    #[test]
    fn omitted_model_and_resume_leave_their_flags_off() {
        let args = claude_args(None, None, None, None, false, None, &[]);
        let joined = args.join(" ");
        assert!(!joined.contains("--model"), "{joined}");
        assert!(!joined.contains("--effort"), "{joined}");
        assert!(!joined.contains("--resume"), "{joined}");
        assert!(!joined.contains("--permission-mode"), "{joined}");
        assert!(!joined.contains("--append-system-prompt"), "{joined}");
    }

    #[test]
    fn the_permissions_chip_and_the_plan_toggle_never_both_land() {
        let both = claude_args(
            None,
            None,
            Some(proto::ChatPermissionMode::BypassPermissions),
            None,
            true,
            None,
            &[],
        );
        assert_eq!(
            both.iter().filter(|a| *a == "--permission-mode").count(),
            1,
            "{both:?}"
        );
        assert!(both.iter().any(|a| a == "plan"), "{both:?}");
        assert!(
            !both.iter().any(|a| a == "bypassPermissions"),
            "plan must win over the chip: {both:?}"
        );

        let chip = claude_args(
            None,
            None,
            Some(proto::ChatPermissionMode::BypassPermissions),
            None,
            false,
            None,
            &[],
        );
        let joined = chip.join(" ");
        assert!(
            joined.contains("--permission-mode bypassPermissions"),
            "{joined}"
        );
    }

    #[test]
    fn a_blank_brief_adds_no_flag() {
        for blank in ["", "   ", "\n\t "] {
            let args = claude_args(None, None, None, None, false, Some(blank), &[]);
            assert!(
                !args.iter().any(|a| a == "--append-system-prompt"),
                "{blank:?} produced {args:?}"
            );
        }
    }

    #[test]
    fn a_user_turn_is_a_documented_stream_json_line() {
        let v: Value = serde_json::from_str(&user_turn_line("hi")).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "hi");
    }

    #[test]
    fn the_table_mirrors_the_registry_and_every_refusal_says_why() {
        let table = engine_support_table();
        assert!(
            table
                .iter()
                .any(|(k, s)| *k == proto::AgentKind::Claude && s.can_chat),
            "claude is in the table and chats"
        );
        for (kind, support) in &table {
            let registered = crate::headless::engine_for(*kind).is_some();
            assert_eq!(
                support.can_chat, registered,
                "{kind:?}: can_chat must be exactly \"headless::engine_for has an implementation\""
            );
            if registered {
                assert!(
                    support.reason.is_none(),
                    "{kind:?} chats yet carries a reason"
                );
            } else {
                let reason = support.reason.as_deref().unwrap_or("");
                assert!(
                    !reason.trim().is_empty(),
                    "{kind:?} is disabled with no reason — the invisible-refusal defect"
                );
            }
        }
    }

    #[test]
    fn antigravity_and_cursor_are_refused_headless_by_name() {
        let table = engine_support_table();
        let reason_for = |k: proto::AgentKind| {
            table
                .iter()
                .find(|(kind, _)| *kind == k)
                .and_then(|(_, s)| s.reason.clone())
                .unwrap_or_else(|| panic!("{k:?} has no reason"))
        };
        assert_eq!(
            reason_for(proto::AgentKind::Antigravity),
            "Panes only. Google's terms on third-party access are unclear, and a strike can \
             reach your Google account."
        );
        assert_eq!(
            reason_for(proto::AgentKind::Cursor),
            "Panes only. No verified headless stream."
        );
    }

    #[test]
    fn init_carries_the_session_id_that_resume_replays() {
        let out = decode_line(
            r#"{"type":"system","subtype":"init","session_id":"abc-123","tools":["Bash"]}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::Init {
                session_id: Some("abc-123".into())
            }]
        );
    }

    #[test]
    fn an_assistant_message_yields_one_event_per_content_block() {
        let out = decode_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                {"type":"thinking","thinking":"weighing it"},
                {"type":"text","text":"Here you go."},
                {"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls -la"}}
            ]}}"#,
        );
        assert_eq!(
            out,
            vec![
                Decoded::Reasoning {
                    text: "weighing it".into()
                },
                Decoded::Text {
                    text: "Here you go.".into()
                },
                Decoded::ToolStart {
                    id: "tu_1".into(),
                    name: "Bash".into(),
                    detail: "ls -la".into(),
                },
            ]
        );
    }

    #[test]
    fn a_tool_result_closes_the_call_it_names() {
        let out = decode_line(
            r#"{"type":"user","message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"tu_1","content":"total 0","is_error":false}
            ]}}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::ToolEnd {
                id: "tu_1".into(),
                ok: true,
                detail: "total 0".into(),
            }]
        );
    }

    #[test]
    fn a_failed_tool_result_is_marked_failed() {
        let out = decode_line(
            r#"{"type":"user","message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"tu_2",
                 "content":[{"type":"text","text":"boom"}],"is_error":true}
            ]}}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::ToolEnd {
                id: "tu_2".into(),
                ok: false,
                detail: "boom".into(),
            }]
        );
    }

    #[test]
    fn partial_messages_stream_text_and_swallow_json_deltas() {
        let text = decode_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"Hel"}}}"#,
        );
        assert_eq!(text, vec![Decoded::TextDelta { text: "Hel".into() }]);
        let json = decode_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,
                "delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}}"#,
        );
        assert!(json.is_empty(), "{json:?}");
    }

    #[test]
    fn a_successful_result_carries_usage_and_the_next_resume_id() {
        let out = decode_line(
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"abc-123",
                "duration_ms":1200,"total_cost_usd":0.0134,
                "usage":{"input_tokens":900,"output_tokens":120},"result":"done"}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::Result {
                ok: true,
                session_id: Some("abc-123".into()),
                error: None,
                usage: proto::ChatUsage {
                    input_tokens: Some(900),
                    output_tokens: Some(120),
                    cost_usd: Some(0.0134),
                    duration_ms: Some(1200),
                },
            }]
        );
    }

    #[test]
    fn an_error_result_carries_the_clis_own_words() {
        let out = decode_line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,
                "session_id":"abc-123","result":"Credit balance is too low"}"#,
        );
        match &out[..] {
            [Decoded::Result { ok, error, .. }] => {
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("Credit balance is too low"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unknown_and_unparseable_lines_yield_nothing() {
        assert!(decode_line("").is_empty());
        assert!(decode_line("not json at all").is_empty());
        assert!(decode_line(r#"{"type":"something_new","payload":{}}"#).is_empty());
        assert!(decode_line(r#"{"type":"system","subtype":"telemetry"}"#).is_empty());
    }

    #[test]
    fn a_long_tool_detail_says_that_it_was_clipped() {
        let long = "x".repeat(TOOL_DETAIL_MAX + 50);
        let out = decode_line(
            &serde_json::json!({
                "type": "assistant",
                "message": {"content": [
                    {"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": long}}
                ]}
            })
            .to_string(),
        );
        match &out[..] {
            [Decoded::ToolStart { detail, .. }] => {
                assert!(detail.contains("… (+"), "{detail}");
                assert!(detail.len() < TOOL_DETAIL_MAX + 40, "{}", detail.len());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_ordinary_permission_offers_the_three_answers() {
        let q = question_for_permission(
            "req-1",
            "Bash",
            &serde_json::json!({"command": "cargo build --release"}),
        );
        assert_eq!(q.kind, proto::ChatQuestionKind::Permission);
        assert!(q.prompt.contains("cargo build --release"), "{}", q.prompt);
        let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![ANSWER_ALLOW_ONCE, ANSWER_ALLOW_SESSION, ANSWER_DENY]
        );
        assert!(!q.allow_free_text);
    }

    #[test]
    fn ask_user_question_becomes_a_choice_card_with_its_own_options() {
        let q = question_for_permission(
            "req-2",
            "AskUserQuestion",
            &serde_json::json!({"questions": [{
                "question": "Which database?",
                "header": "Storage",
                "multiSelect": false,
                "options": [
                    {"label": "SQLite", "description": "One file, no server"},
                    {"label": "Postgres", "description": "A server"}
                ]
            }]}),
        );
        assert_eq!(q.kind, proto::ChatQuestionKind::Choice);
        assert_eq!(q.header.as_deref(), Some("Storage"));
        assert_eq!(q.prompt, "Which database?");
        assert_eq!(q.options.len(), 2);
        assert_eq!(q.options[0].label, "SQLite");
        assert!(q.allow_free_text);
    }

    #[test]
    fn a_malformed_ask_user_question_falls_back_to_the_permission_card() {
        let q = question_for_permission("req-3", "AskUserQuestion", &serde_json::json!({}));
        assert_eq!(q.kind, proto::ChatQuestionKind::Permission);
        assert_eq!(q.options.len(), 3);
    }

    #[test]
    fn permission_replies_follow_claude_codes_documented_contract() {
        let input = serde_json::json!({"command": "ls"});
        let allow = permission_reply(
            proto::ChatQuestionKind::Permission,
            "",
            ANSWER_ALLOW_ONCE,
            &input,
        );
        assert_eq!(allow["behavior"], "allow");
        assert_eq!(allow["updatedInput"], input);

        let deny = permission_reply(proto::ChatQuestionKind::Permission, "", ANSWER_DENY, &input);
        assert_eq!(deny["behavior"], "deny");
        assert!(deny["message"].as_str().unwrap().contains("declined"));
    }

    #[test]
    fn a_choice_answer_is_keyed_by_the_question_text() {
        let input = serde_json::json!({"questions": [{"question": "Which database?"}]});
        let reply = permission_reply(
            proto::ChatQuestionKind::Choice,
            "Which database?",
            "SQLite",
            &input,
        );
        assert_eq!(reply["behavior"], "allow");
        assert_eq!(
            reply["updatedInput"]["answers"]["Which database?"],
            "SQLite"
        );
        assert_eq!(
            reply["updatedInput"]["questions"], input["questions"],
            "the original questions must ride back unchanged"
        );
    }
}

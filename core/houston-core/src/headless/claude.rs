use super::{Decoded, HeadlessEngine, PendingQuestion, TurnRequest};
use anyhow::{anyhow, Result};
use houston_protocol as proto;

/// `saw_init` distinguishes a real chat stream (which opens with `system`/`init`)
/// from a one-shot call's single envelope line — a structural difference, not a
/// flag on [`TurnRequest`].
#[derive(Default)]
pub struct ClaudeEngine {
    saw_init: bool,
}

impl HeadlessEngine for ClaudeEngine {
    fn support(&self) -> super::EngineSupport {
        crate::headless::shared::engine_support(proto::AgentKind::Claude)
    }

    fn program(&self) -> &str {
        crate::headless::shared::CLAUDE_CLI
    }

    fn argv(&self, req: &TurnRequest) -> Result<Vec<String>> {
        if req.one_shot {
            let model = req
                .model
                .as_deref()
                .ok_or_else(|| anyhow!("a Claude one-shot call needs a model"))?;
            let mut args = vec![
                "-p".to_string(),
                req.prompt.clone(),
                "--output-format".to_string(),
                "json".to_string(),
                "--model".to_string(),
                model.to_string(),
            ];
            args.extend(HEADLESS_ISOLATION_ARGS.iter().map(|s| s.to_string()));
            Ok(args)
        } else {
            Ok(crate::headless::shared::claude_args(
                req.model.as_deref(),
                req.effort,
                req.permission_mode,
                req.resume.as_deref(),
                req.plan,
                req.purpose.as_deref(),
                &mcp_args(req),
            ))
        }
    }

    fn stdin(&self, req: &TurnRequest) -> Option<String> {
        (!req.one_shot).then(|| crate::headless::shared::user_turn_line(&req.prompt))
    }

    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let out = crate::headless::shared::decode_line(line);
        if matches!(out.first(), Some(Decoded::Init { .. })) {
            self.saw_init = true;
        }
        if self.saw_init {
            return out;
        }
        // No `init` seen: a one-shot reply is one envelope line whose `result`
        // string `chat::decode_line` does not turn into an assistant row.
        match unwrap_cli_envelope(line) {
            Ok(text) => vec![Decoded::Text { text }],
            Err(_) => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    return out;
                };
                if v.get("is_error").and_then(serde_json::Value::as_bool) != Some(true) {
                    return out;
                }
                let error = v
                    .get("result")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("(no `result` text)")
                    .to_string();
                vec![Decoded::Result {
                    ok: false,
                    session_id: None,
                    error: Some(error),
                    usage: proto::ChatUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        duration_ms: None,
                    },
                }]
            }
        }
    }

    /// Claude's permission answer goes back over the `--permission-prompt-tool`
    /// MCP call's own HTTP response, never on this child's stdin.
    fn reply(&self, _question: &PendingQuestion, _answer: &str) -> Option<String> {
        None
    }

    fn models(&self) -> &'static [&'static str] {
        MODELS
    }

    fn verified(&self) -> bool {
        true
    }
}

/// The models the headless role pickers offer for Claude.
pub const MODELS: &[&str] = &["haiku", "sonnet", "opus"];

/// The model a Claude one-shot call falls back to when the role names none.
pub const ONESHOT_DEFAULT_MODEL: &str = "sonnet";

/// Left un-isolated a Claude one-shot is billed for whatever MCP config the
/// environment resolves — measured at 46,014 input tokens for a 241-byte
/// prompt, against 20,159 with these flags, for a byte-identical answer.
pub(crate) const HEADLESS_ISOLATION_ARGS: &[&str] = &[
    "--strict-mcp-config",
    "--mcp-config",
    r#"{"mcpServers":{}}"#,
    "--tools",
    "",
];

/// A one-shot reply is one `--output-format json` envelope whose `result`
/// string is the real answer; `chat::decode_line` does not turn it into an
/// assistant row, so the engine unwraps it here.
pub(crate) fn unwrap_cli_envelope(raw: &str) -> anyhow::Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        anyhow::bail!(
            "the CLI printed nothing on stdout (expected a JSON envelope with a `result` field)"
        );
    }
    let envelope: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        anyhow::anyhow!(
            "the CLI's stdout is not JSON (expected `--output-format json`'s envelope): {e}; \
             first {n} bytes: {head:?}",
            n = head_of(raw).len(),
            head = head_of(raw)
        )
    })?;
    if envelope
        .get("is_error")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        anyhow::bail!(
            "the CLI reported an error: {}",
            envelope
                .get("result")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("(no `result` text)")
        );
    }
    match envelope.get("result").and_then(serde_json::Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => anyhow::bail!(
            "the CLI's JSON envelope has no string `result` field; keys present: {:?}",
            envelope
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ),
    }
}

fn head_of(s: &str) -> &str {
    let mut end = s.len().min(200);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The same inline `--mcp-config` a Claude pane gets, plus `--strict-mcp-config`:
/// a pane is the user's own CLI and keeps their servers, while a headless turn
/// is Houston's, with a tool set it does not bill for every inherited schema.
fn mcp_args(req: &TurnRequest) -> Vec<String> {
    req.mcp
        .as_ref()
        .map(|cred| {
            let mut args = crate::mcp_launch::launch_for(
                proto::AgentKind::Claude,
                &cred.endpoint,
                &cred.token,
            )
            .args;
            args.push("--strict-mcp-config".to_string());
            args
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn req() -> TurnRequest {
        TurnRequest {
            cwd: PathBuf::from("/tmp"),
            prompt: "hi".into(),
            ..Default::default()
        }
    }

    #[test]
    fn chat_argv_matches_claude_args_byte_for_byte() {
        let mut r = req();
        r.model = Some("opus".into());
        r.resume = Some("sess-1".into());
        let engine = ClaudeEngine::default();
        let via_engine = engine.argv(&r).unwrap();
        let direct = crate::headless::shared::claude_args(
            r.model.as_deref(),
            r.effort,
            r.permission_mode,
            r.resume.as_deref(),
            r.plan,
            r.purpose.as_deref(),
            &[],
        );
        assert_eq!(via_engine, direct);
    }

    #[test]
    fn the_mcp_grant_renders_the_same_flags_a_pane_spawn_gets() {
        let mut r = req();
        r.mcp = Some(crate::mcp_launch::Credential {
            endpoint: "http://127.0.0.1:4242/mcp".into(),
            token: "tok-abc".into(),
        });
        let args = ClaudeEngine::default().argv(&r).unwrap();
        let pane = crate::mcp_launch::launch_for(
            proto::AgentKind::Claude,
            "http://127.0.0.1:4242/mcp",
            "tok-abc",
        );
        let start = args
            .windows(pane.args.len())
            .position(|w| w == pane.args)
            .expect("the pane's own --mcp-config flags, verbatim");
        assert_eq!(&args[start..start + pane.args.len()], &pane.args[..]);
        assert!(
            args.contains(&"--strict-mcp-config".to_string()),
            "a headless turn bounds its own tool set even though a pane does \
             not: {args:?}"
        );
        assert!(
            !pane.args.contains(&"--strict-mcp-config".to_string()),
            "the flag is the headless caller's, not the shared shape's: {:?}",
            pane.args
        );
    }

    #[test]
    fn one_shot_argv_is_p_prompt_output_format_json_model_then_isolation() {
        let mut r = req();
        r.one_shot = true;
        r.model = Some("sonnet".into());
        let engine = ClaudeEngine::default();
        let args = engine.argv(&r).unwrap();
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "hi");
        assert_eq!(
            &args[2..6],
            ["--output-format", "json", "--model", "sonnet"]
        );
        assert_eq!(&args[6..], HEADLESS_ISOLATION_ARGS);
    }

    #[test]
    fn one_shot_without_a_model_is_refused() {
        let mut r = req();
        r.one_shot = true;
        let engine = ClaudeEngine::default();
        assert!(engine.argv(&r).is_err());
    }

    #[test]
    fn decode_picks_the_result_field_as_the_answer_before_any_init() {
        let mut engine = ClaudeEngine::default();
        let out = engine.decode(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"the answer"}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::Text {
                text: "the answer".into()
            }]
        );
    }

    #[test]
    fn decode_leaves_a_real_chat_streams_result_alone_once_init_was_seen() {
        let mut engine = ClaudeEngine::default();
        engine.decode(r#"{"type":"system","subtype":"init","session_id":"s1"}"#);
        let out = engine.decode(
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"done"}"#,
        );
        assert_eq!(
            out,
            vec![Decoded::Result {
                ok: true,
                session_id: Some("s1".into()),
                error: None,
                usage: proto::ChatUsage {
                    input_tokens: None,
                    output_tokens: None,
                    cost_usd: None,
                    duration_ms: None,
                },
            }]
        );
    }

    #[test]
    fn decode_reads_a_one_shot_envelope_with_no_type_field() {
        let mut engine = ClaudeEngine::default();
        let out = engine.decode(r#"{"result":"{\"action\":\"wait\"}","total_cost_usd":0.01}"#);
        assert_eq!(
            out,
            vec![Decoded::Text {
                text: "{\"action\":\"wait\"}".into()
            }]
        );
    }

    #[test]
    fn the_isolation_flags_are_the_two_that_were_measured() {
        assert_eq!(
            HEADLESS_ISOLATION_ARGS,
            &[
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--tools",
                "",
            ],
        );
    }

    #[test]
    fn the_envelope_is_unwrapped_and_its_failures_named() {
        let ok = r#"{"type":"result","is_error":false,"result":"the answer"}"#;
        assert_eq!(unwrap_cli_envelope(ok).unwrap(), "the answer");

        assert!(unwrap_cli_envelope("")
            .unwrap_err()
            .to_string()
            .contains("nothing"));
        assert!(unwrap_cli_envelope("not json")
            .unwrap_err()
            .to_string()
            .contains("not JSON"));
        let no_result = unwrap_cli_envelope(r#"{"type":"result"}"#)
            .unwrap_err()
            .to_string();
        assert!(no_result.contains("`result`"), "{no_result}");
        let errored = unwrap_cli_envelope(r#"{"is_error":true,"result":"rate limited"}"#)
            .unwrap_err()
            .to_string();
        assert!(errored.contains("rate limited"), "{errored}");
    }

    #[test]
    fn stdin_carries_the_user_turn_for_chat_and_nothing_for_one_shot() {
        let engine = ClaudeEngine::default();
        let mut r = req();
        assert_eq!(
            engine.stdin(&r),
            Some(crate::headless::shared::user_turn_line("hi"))
        );
        r.one_shot = true;
        assert_eq!(engine.stdin(&r), None);
    }
}

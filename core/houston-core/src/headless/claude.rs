use super::{Decoded, HeadlessEngine, PendingQuestion, TurnRequest};
use anyhow::Result;
use houston_protocol as proto;

pub struct ClaudeEngine;

impl HeadlessEngine for ClaudeEngine {
    fn support(&self) -> super::EngineSupport {
        crate::headless::shared::engine_support(proto::AgentKind::Claude)
    }

    fn program(&self) -> &str {
        crate::headless::shared::CLAUDE_CLI
    }

    fn argv(&self, req: &TurnRequest) -> Result<Vec<String>> {
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

    fn stdin(&self, req: &TurnRequest) -> Option<String> {
        Some(crate::headless::shared::user_turn_line(&req.prompt))
    }

    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        crate::headless::shared::decode_line(line)
    }

    /// Claude's permission answer goes back over the `--permission-prompt-tool`
    /// MCP call's own HTTP response, never on this child's stdin.
    fn reply(&self, _question: &PendingQuestion, _answer: &str) -> Option<String> {
        None
    }
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
        let engine = ClaudeEngine;
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
        let args = ClaudeEngine.argv(&r).unwrap();
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
    fn decode_reads_the_result_line() {
        let mut engine = ClaudeEngine;
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
    fn stdin_carries_the_user_turn() {
        let engine = ClaudeEngine;
        assert_eq!(
            engine.stdin(&req()),
            Some(crate::headless::shared::user_turn_line("hi"))
        );
    }
}

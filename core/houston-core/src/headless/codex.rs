use super::{Decoded, HeadlessEngine, PendingQuestion, TurnRequest};
use anyhow::Result;
use houston_protocol as proto;
use serde_json::Value;

#[derive(Default)]
pub struct CodexEngine;

/// A one-shot call always gets `read-only` regardless of permission mode — it
/// has no permission to grant. The ask default is not representable in
/// `codex exec`, which never prompts, so it maps to the same as accept-edits.
fn sandbox_mode(req: &TurnRequest) -> &'static str {
    if req.one_shot {
        return "read-only";
    }
    match req.permission_mode {
        Some(proto::ChatPermissionMode::BypassPermissions) => "danger-full-access",
        Some(proto::ChatPermissionMode::AcceptEdits) | None => "workspace-write",
    }
}

impl HeadlessEngine for CodexEngine {
    fn support(&self) -> super::EngineSupport {
        crate::headless::shared::engine_support(proto::AgentKind::Codex)
    }

    fn program(&self) -> &str {
        "codex"
    }

    fn argv(&self, req: &TurnRequest) -> Result<Vec<String>> {
        let mut args = vec!["exec".to_string()];
        // `codex exec resume` rejects both `-C` and `-s`, so a resume keeps the
        // cwd and sandbox its thread was born with; the only override it takes
        // is the bypass flag, added below.
        if let Some(id) = &req.resume {
            args.push("resume".to_string());
            args.push(id.clone());
            args.push("--json".to_string());
            if matches!(
                req.permission_mode,
                Some(proto::ChatPermissionMode::BypassPermissions)
            ) {
                args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
            }
        } else {
            args.push("--json".to_string());
            args.push("-C".to_string());
            args.push(req.cwd.display().to_string());
            args.push("-s".to_string());
            args.push(sandbox_mode(req).to_string());
        }
        args.extend(mcp_args(req));
        if let Some(brief) = briefing_arg(req) {
            args.push("-c".to_string());
            args.push(brief);
        }
        if let Some(model) = &req.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        args.push(req.prompt.clone());
        Ok(args)
    }

    fn stdin(&self, _req: &TurnRequest) -> Option<String> {
        None
    }

    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        line.lines().flat_map(|l| self.decode_line(l)).collect()
    }

    fn reply(&self, _question: &PendingQuestion, _answer: &str) -> Option<String> {
        None
    }
}

fn mcp_args(req: &TurnRequest) -> Vec<String> {
    req.mcp
        .as_ref()
        .map(|cred| {
            crate::mcp_launch::launch_for(proto::AgentKind::Codex, &cred.endpoint, &cred.token).args
        })
        .unwrap_or_default()
}

/// The value is TOML-quoted: `-c` parses its right-hand side as TOML first, so
/// a briefing opening with `[` or `true` would be read as an array or boolean.
/// A JSON string literal is a valid TOML basic string.
fn briefing_arg(req: &TurnRequest) -> Option<String> {
    let brief = req
        .purpose
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())?;
    Some(format!(
        "developer_instructions={}",
        serde_json::Value::String(brief.to_string())
    ))
}

impl CodexEngine {
    fn decode_line(&mut self, line: &str) -> Vec<Decoded> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match v.get("type").and_then(Value::as_str) {
            Some("thread.started") => vec![Decoded::Init {
                session_id: str_field(&v, "thread_id"),
            }],
            Some("item.started") => {
                let item = v.get("item").unwrap_or(&Value::Null);
                match item.get("type").and_then(Value::as_str) {
                    Some("command_execution") => vec![Decoded::ToolStart {
                        id: str_field(item, "id").unwrap_or_default(),
                        name: "command_execution".to_string(),
                        detail: str_field(item, "command").unwrap_or_default(),
                    }],
                    _ => Vec::new(),
                }
            }
            Some("item.completed") => item_completed(v.get("item").unwrap_or(&Value::Null)),
            Some("turn.completed") => {
                let usage = v.get("usage").cloned().unwrap_or(Value::Null);
                vec![Decoded::Result {
                    ok: true,
                    session_id: None,
                    error: None,
                    usage: proto::ChatUsage {
                        input_tokens: u64_field(&usage, "input_tokens"),
                        output_tokens: u64_field(&usage, "output_tokens"),
                        cost_usd: None,
                        duration_ms: None,
                    },
                }]
            }
            Some("turn.failed") => {
                let error = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("(no error message)")
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
            Some("thread.error") => str_field(&v, "message")
                .map(|text| vec![Decoded::StreamError { text }])
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }
}

fn item_completed(item: &Value) -> Vec<Decoded> {
    match item.get("type").and_then(Value::as_str) {
        Some("command_execution") => vec![Decoded::ToolEnd {
            id: str_field(item, "id").unwrap_or_default(),
            ok: item.get("exit_code").and_then(Value::as_i64) == Some(0),
            detail: str_field(item, "aggregated_output").unwrap_or_default(),
        }],
        Some("agent_message") => str_field(item, "text")
            .filter(|t| !t.trim().is_empty())
            .map(|text| vec![Decoded::Text { text }])
            .unwrap_or_default(),
        Some("reasoning") => str_field(item, "text")
            .filter(|t| !t.trim().is_empty())
            .map(|text| vec![Decoded::Reasoning { text }])
            .unwrap_or_default(),
        Some("error") => str_field(item, "message")
            .map(|text| vec![Decoded::StreamError { text }])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn u64_field(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn req() -> TurnRequest {
        TurnRequest {
            cwd: PathBuf::from("/tmp/work"),
            prompt: "hi".into(),
            ..Default::default()
        }
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/tests/fixtures/headless/codex/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap_or_else(|e| panic!("reading fixture {name}: {e}"))
    }

    fn decode_all(engine: &mut CodexEngine, text: &str) -> Vec<Decoded> {
        text.lines().flat_map(|l| engine.decode(l)).collect()
    }

    #[test]
    fn fresh_turn_argv_is_exec_json_cd_sandbox_model_then_prompt() {
        let mut r = req();
        r.model = Some("gpt-5".into());
        let engine = CodexEngine;
        let args = engine.argv(&r).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "--json",
                "-C",
                "/tmp/work",
                "-s",
                "workspace-write",
                "--model",
                "gpt-5",
                "hi",
            ]
        );
    }

    #[test]
    fn accept_edits_and_the_ask_default_both_map_to_workspace_write() {
        let engine = CodexEngine;
        let mut r = req();
        r.permission_mode = Some(proto::ChatPermissionMode::AcceptEdits);
        assert!(engine
            .argv(&r)
            .unwrap()
            .contains(&"workspace-write".to_string()));
        r.permission_mode = None;
        assert!(engine
            .argv(&r)
            .unwrap()
            .contains(&"workspace-write".to_string()));
    }

    #[test]
    fn bypass_permissions_maps_to_danger_full_access() {
        let mut r = req();
        r.permission_mode = Some(proto::ChatPermissionMode::BypassPermissions);
        let engine = CodexEngine;
        assert!(engine
            .argv(&r)
            .unwrap()
            .contains(&"danger-full-access".to_string()));
    }

    #[test]
    fn one_shot_is_always_read_only_regardless_of_permission_mode() {
        let mut r = req();
        r.one_shot = true;
        r.permission_mode = Some(proto::ChatPermissionMode::BypassPermissions);
        let engine = CodexEngine;
        assert!(engine.argv(&r).unwrap().contains(&"read-only".to_string()));
    }

    #[test]
    fn resume_argv_has_no_cd_or_sandbox_flag() {
        let mut r = req();
        r.resume = Some("01a069da-9814-7690-b690-e4d1e9190e85".into());
        r.model = Some("gpt-5".into());
        let engine = CodexEngine;
        let args = engine.argv(&r).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "resume",
                "01a069da-9814-7690-b690-e4d1e9190e85",
                "--json",
                "--model",
                "gpt-5",
                "hi",
            ],
            "resume rejects -C and -s on the real CLI; neither may appear here"
        );
    }

    #[test]
    fn resume_with_bypass_permissions_adds_the_one_override_resume_has() {
        let mut r = req();
        r.resume = Some("s1".into());
        r.permission_mode = Some(proto::ChatPermissionMode::BypassPermissions);
        let engine = CodexEngine;
        let args = engine.argv(&r).unwrap();
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
    }

    #[test]
    fn a_briefed_turn_with_an_mcp_grant_carries_both_as_config_overrides() {
        let mut r = req();
        r.purpose = Some("You are Nova.".into());
        r.mcp = Some(crate::mcp_launch::Credential {
            endpoint: "http://127.0.0.1:4242/mcp".into(),
            token: "tok-abc".into(),
        });
        let args = CodexEngine.argv(&r).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "--json",
                "-C",
                "/tmp/work",
                "-s",
                "workspace-write",
                "-c",
                "mcp_servers.houston.url=http://127.0.0.1:4242/mcp",
                "-c",
                "mcp_servers.houston.bearer_token_env_var=\"HOUSTON_MCP_TOKEN\"",
                "-c",
                "developer_instructions=\"You are Nova.\"",
                "hi",
            ]
        );
        assert!(
            !args.iter().any(|a| a.contains("tok-abc")),
            "the bearer token rides the environment, never argv: {args:?}"
        );
    }

    #[test]
    fn a_resumed_turn_keeps_the_briefing_and_the_grant() {
        let mut r = req();
        r.resume = Some("s1".into());
        r.purpose = Some("You are Nova.".into());
        r.mcp = Some(crate::mcp_launch::Credential {
            endpoint: "http://127.0.0.1:4242/mcp".into(),
            token: "tok-abc".into(),
        });
        let args = CodexEngine.argv(&r).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "resume",
                "s1",
                "--json",
                "-c",
                "mcp_servers.houston.url=http://127.0.0.1:4242/mcp",
                "-c",
                "mcp_servers.houston.bearer_token_env_var=\"HOUSTON_MCP_TOKEN\"",
                "-c",
                "developer_instructions=\"You are Nova.\"",
                "hi",
            ]
        );
    }

    #[test]
    fn the_mcp_overrides_are_the_ones_a_pane_spawn_gets() {
        let mut r = req();
        r.mcp = Some(crate::mcp_launch::Credential {
            endpoint: "http://127.0.0.1:4242/mcp".into(),
            token: "tok-abc".into(),
        });
        let args = CodexEngine.argv(&r).unwrap();
        let pane = crate::mcp_launch::launch_for(
            proto::AgentKind::Codex,
            "http://127.0.0.1:4242/mcp",
            "tok-abc",
        );
        assert!(
            args.windows(pane.args.len()).any(|w| w == pane.args),
            "{args:?} must contain the pane's own overrides verbatim: {:?}",
            pane.args
        );
    }

    #[test]
    fn a_briefing_is_toml_quoted_so_its_own_punctuation_cannot_reparse() {
        let mut r = req();
        r.purpose = Some("[not an array] he said \"hi\"\nline two".into());
        let args = CodexEngine.argv(&r).unwrap();
        let brief = args
            .iter()
            .find(|a| a.starts_with("developer_instructions="))
            .expect("the briefing override");
        assert_eq!(
            brief,
            "developer_instructions=\"[not an array] he said \\\"hi\\\"\\nline two\""
        );
    }

    #[test]
    fn a_blank_briefing_adds_no_override_at_all() {
        let mut r = req();
        r.purpose = Some("   \n  ".into());
        let args = CodexEngine.argv(&r).unwrap();
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("developer_instructions=")),
            "{args:?}"
        );
    }

    #[test]
    fn stdin_is_always_none() {
        let engine = CodexEngine;
        assert_eq!(engine.stdin(&req()), None);
    }

    #[test]
    fn decodes_the_run_command_fixture() {
        let mut engine = CodexEngine;
        let out = decode_all(&mut engine, &fixture("run_command.ndjson"));
        assert_eq!(
            out[0],
            Decoded::Init {
                session_id: Some("01a069da-9814-7690-b690-e4d1e9190e85".into())
            }
        );
        assert!(out.iter().any(|d| matches!(
            d,
            Decoded::ToolStart { name, detail, .. }
                if name == "command_execution" && detail == "ls -la"
        )));
        assert!(out
            .iter()
            .any(|d| matches!(d, Decoded::ToolEnd { ok: true, .. })));
        assert!(out.iter().any(|d| matches!(
            d,
            Decoded::Text { text } if text.contains("ls -la")
        )));
        let result = out.last().expect("a result line");
        assert_eq!(
            result,
            &Decoded::Result {
                ok: true,
                session_id: None,
                error: None,
                usage: proto::ChatUsage {
                    input_tokens: Some(812),
                    output_tokens: Some(54),
                    cost_usd: None,
                    duration_ms: None,
                },
            }
        );
    }

    #[test]
    fn decodes_the_text_only_fixture() {
        let mut engine = CodexEngine;
        let out = decode_all(&mut engine, &fixture("text_only.ndjson"));
        assert_eq!(
            out[0],
            Decoded::Init {
                session_id: Some("01a069dc-a65a-7092-bb74-f4099b0a449a".into())
            }
        );
        assert!(out
            .iter()
            .any(|d| matches!(d, Decoded::Text { text } if text == "OK")));
        assert!(!out.iter().any(|d| matches!(d, Decoded::ToolStart { .. })));
    }

    #[test]
    fn decodes_the_resume_fixture_with_the_same_thread_id() {
        let mut engine = CodexEngine;
        let out = decode_all(&mut engine, &fixture("resume.ndjson"));
        assert_eq!(
            out[0],
            Decoded::Init {
                session_id: Some("01a069da-9814-7690-b690-e4d1e9190e85".into())
            }
        );
        let result = out.last().expect("a result line");
        assert!(matches!(result, Decoded::Result { ok: true, .. }));
    }
}

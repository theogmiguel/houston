//! Claude's provider adapter for thread sessions: `claude -p` with stream-json on stdin and
//! stdout. The generic half (process tree, turns, coalescing) is `thread_session.rs`.

use crate::thread_session::{
    cap_text, Conversation, Decoded, ProcessSpec, ProviderAdapter, ProviderStream, PERMISSION_TOOL,
};
use anyhow::{anyhow, bail, Result};
use houston_protocol::{
    AgentKind, ThreadEventKind, ThreadPermissionMode, TurnOutcome, THREAD_ASSISTANT_TEXT_MAX_BYTES,
    THREAD_TOOL_INPUT_MAX_BYTES, THREAD_TOOL_OUTPUT_MAX_BYTES,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// Flags that turn an interactive Claude launch into a headless thread process.
pub const THREAD_FLAGS: [&str; 7] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
];

/// The `--permission-mode` / bypass arguments of a mode; `Default` passes none.
pub fn permission_mode_args(mode: ThreadPermissionMode) -> Vec<&'static str> {
    match mode {
        ThreadPermissionMode::Default => Vec::new(),
        ThreadPermissionMode::AcceptEdits => vec!["--permission-mode", "acceptEdits"],
        ThreadPermissionMode::Plan => vec!["--permission-mode", "plan"],
        ThreadPermissionMode::Auto => vec!["--permission-mode", "auto"],
        ThreadPermissionMode::Bypass => vec!["--dangerously-skip-permissions"],
    }
}

fn parse_permission_mode(value: &str) -> Result<ThreadPermissionMode> {
    Ok(match value {
        "default" | "manual" => ThreadPermissionMode::Default,
        "acceptEdits" => ThreadPermissionMode::AcceptEdits,
        "plan" => ThreadPermissionMode::Plan,
        "auto" => ThreadPermissionMode::Auto,
        "bypassPermissions" => ThreadPermissionMode::Bypass,
        other => bail!(
            "thread launch: --permission-mode {other:?} is not a thread permission mode \
             (expected default, acceptEdits, plan, auto or bypassPermissions)"
        ),
    })
}

/// The launch a thread restarts from: the session's assembled Claude command without its
/// conversation arguments, which change between the first start and a resume.
pub struct ClaudeStreamJson {
    launch: ProcessSpec,
    /// Taken out of the arguments: a mode change restarts the process with other flags.
    pub permission_mode: ThreadPermissionMode,
}

impl ClaudeStreamJson {
    /// Splits `--session-id <id>`, `--resume <id>` and the permission flags out of an
    /// assembled command.
    pub fn from_command(
        cmd: &portable_pty::CommandBuilder,
    ) -> Result<(Self, Option<Conversation>)> {
        let argv = cmd.get_argv();
        let program = argv
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("thread launch has an empty argv (expected the claude path)"))?;
        let mut args = Vec::new();
        let mut conversation = None;
        let mut permission_mode = ThreadPermissionMode::Default;
        let mut rest = argv[1..].iter();
        while let Some(arg) = rest.next() {
            match arg.to_str() {
                Some("--dangerously-skip-permissions") => {
                    permission_mode = ThreadPermissionMode::Bypass;
                    continue;
                }
                Some("--permission-mode") => {
                    let value = rest
                        .next()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| {
                            anyhow!("thread launch: --permission-mode must be followed by a mode")
                        })?;
                    permission_mode = parse_permission_mode(value)?;
                    continue;
                }
                Some(flag) if flag.starts_with("--permission-mode=") => {
                    permission_mode = parse_permission_mode(&flag["--permission-mode=".len()..])?;
                    continue;
                }
                _ => {}
            }
            let kind = match arg.to_str() {
                Some("--session-id") => Some(false),
                Some("--resume") => Some(true),
                _ => None,
            };
            match kind {
                Some(resume) => {
                    let id = rest
                        .next()
                        .and_then(|id| id.to_str())
                        .ok_or_else(|| {
                            anyhow!("thread launch: {arg:?} must be followed by a conversation id")
                        })?
                        .to_string();
                    conversation = Some(if resume {
                        Conversation::Resume(id)
                    } else {
                        Conversation::New(id)
                    });
                }
                None => args.push(arg.clone()),
            }
        }
        let env = cmd
            .iter_full_env_as_str()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        Ok((
            Self {
                launch: ProcessSpec {
                    program,
                    args,
                    env,
                    cwd: cmd.get_cwd().map(PathBuf::from),
                },
                permission_mode,
            },
            conversation,
        ))
    }
}

impl ProviderAdapter for ClaudeStreamJson {
    fn provider(&self) -> AgentKind {
        AgentKind::Claude
    }

    fn command(
        &self,
        conversation: Option<&Conversation>,
        mode: ThreadPermissionMode,
    ) -> Result<ProcessSpec> {
        let mut spec = self.launch.clone();
        spec.args
            .extend(permission_mode_args(mode).into_iter().map(Into::into));
        // Without Houston's MCP server the tool does not exist and Claude would refuse to start.
        if spec.args.iter().any(|arg| arg == "--mcp-config") {
            spec.args.extend([
                "--permission-prompt-tool".into(),
                format!("mcp__{}__{PERMISSION_TOOL}", crate::mcp_server::SERVER_NAME).into(),
            ]);
        }
        match conversation {
            Some(Conversation::New(id)) => {
                spec.args.extend(["--session-id".into(), id.into()]);
            }
            Some(Conversation::Resume(id)) => {
                spec.args.extend(["--resume".into(), id.into()]);
            }
            None => {}
        }
        spec.args.extend(THREAD_FLAGS.map(Into::into));
        Ok(spec)
    }

    fn open(&self) -> Box<dyn ProviderStream> {
        Box::new(StreamMapper::default())
    }
}

/// Maps stream-json lines to thread events. One per process: block indices restart with it.
#[derive(Default)]
pub struct StreamMapper {
    open_text_block: HashMap<String, u64>,
}

impl ProviderStream for StreamMapper {
    fn user_message(&mut self, text: &str) -> Result<String> {
        Ok(serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": text},
        })
        .to_string())
    }

    fn decode(&mut self, line: &str) -> Decoded {
        self.map_line(line)
    }
}

impl StreamMapper {
    pub fn map_line(&mut self, line: &str) -> Decoded {
        let mut out = Decoded::default();
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            tracing::debug!("thread stdout line is not JSON; ignored");
            return out;
        };
        // Sub-agent traffic (a Task tool's own turns) carries its parent tool use; the
        // thread shows that tool's call and result, not its inner turns.
        if value
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null())
        {
            return out;
        }
        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.map_stream_event(&value, &mut out),
            Some("assistant") => self.map_assistant(&value, &mut out),
            Some("user") => map_tool_results(&value, &mut out),
            Some("result") => {
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let outcome = if is_error {
                    TurnOutcome::Error
                } else {
                    TurnOutcome::Completed
                };
                let error = is_error.then(|| result_error(&value));
                out.events.push(ThreadEventKind::TurnEnd { outcome, error });
                out.turn_end = Some(outcome);
            }
            Some("system") => {
                if value.get("subtype").and_then(Value::as_str) == Some("init") {
                    out.conversation = value
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                // `init` opens every turn and `status` follows a change such as ExitPlanMode.
                out.permission_mode = value
                    .get("permissionMode")
                    .and_then(Value::as_str)
                    .and_then(|mode| parse_permission_mode(mode).ok());
            }
            other => tracing::debug!("thread stream event {other:?} ignored"),
        }
        out
    }

    fn map_stream_event(&mut self, value: &Value, out: &mut Decoded) {
        let Some(event) = value.get("event") else {
            return;
        };
        let message = value
            .get("api_message_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let kind = event.pointer("/content_block/type").and_then(Value::as_str);
                if kind == Some("text") {
                    self.open_text_block.insert(message.to_string(), index);
                }
            }
            Some("content_block_delta") => {
                if event.pointer("/delta/type").and_then(Value::as_str) != Some("text_delta") {
                    return;
                }
                let text = event
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    out.events.push(ThreadEventKind::AssistantDelta {
                        message_id: block_key(message, index),
                        text: text.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    fn map_assistant(&mut self, value: &Value, out: &mut Decoded) {
        let message = value
            .pointer("/message/id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let index = self.open_text_block.get(message).copied().unwrap_or(0);
                    let (text, truncated) = cap_text(text, THREAD_ASSISTANT_TEXT_MAX_BYTES);
                    out.events.push(ThreadEventKind::AssistantMessage {
                        message_id: block_key(message, index),
                        text,
                        truncated,
                    });
                }
                Some("tool_use") => {
                    let input = block
                        .get("input")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "{}".to_string());
                    let (input, truncated) = cap_text(input, THREAD_TOOL_INPUT_MAX_BYTES);
                    out.events.push(ThreadEventKind::ToolCall {
                        tool_use_id: str_field(block, "id"),
                        name: str_field(block, "name"),
                        input,
                        truncated,
                    });
                }
                _ => {}
            }
        }
    }
}

/// Deltas and their final message share this key: one text block of one model message.
fn block_key(message: &str, index: u64) -> String {
    format!("{message}:{index}")
}

fn str_field(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn map_tool_results(value: &Value, out: &mut Decoded) {
    let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let output = match block.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            Some(other) if !other.is_null() => other.to_string(),
            _ => String::new(),
        };
        let (output, truncated) = cap_text(output, THREAD_TOOL_OUTPUT_MAX_BYTES);
        out.events.push(ThreadEventKind::ToolResult {
            tool_use_id: str_field(block, "tool_use_id"),
            is_error: block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            output,
            truncated,
        });
    }
}

fn result_error(value: &Value) -> String {
    let text = value
        .get("result")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("errors")
                .and_then(Value::as_array)
                .map(|errors| {
                    errors
                        .iter()
                        .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_string))
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .filter(|text| !text.is_empty())
        })
        .unwrap_or_else(|| {
            format!(
                "turn ended with {}",
                value
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("an error")
            )
        });
    cap_text(text, THREAD_TOOL_OUTPUT_MAX_BYTES).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn kinds(lines: &str) -> Vec<ThreadEventKind> {
        let mut mapper = StreamMapper::default();
        lines
            .lines()
            .flat_map(|line| mapper.map_line(line).events)
            .collect()
    }

    #[test]
    fn deltas_and_their_final_message_share_a_block_key() {
        let events = kinds(concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null,"api_message_id":"msg_1"}"#,
            "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}},"parent_tool_use_id":null,"api_message_id":"msg_1"}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hello"}]},"parent_tool_use_id":null}"#,
        ));
        assert_eq!(
            events,
            vec![
                ThreadEventKind::AssistantDelta {
                    message_id: "msg_1:1".into(),
                    text: "Hel".into()
                },
                ThreadEventKind::AssistantMessage {
                    message_id: "msg_1:1".into(),
                    text: "Hello".into(),
                    truncated: false
                },
            ]
        );
    }

    #[test]
    fn sub_agent_traffic_and_unknown_types_map_to_nothing() {
        let events = kinds(concat!(
            r#"{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"inner"}]},"parent_tool_use_id":"toolu_1"}"#,
            "\n",
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            "\n",
            r#"{"type":"something_new"}"#,
            "\n",
            "not json",
        ));
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn caps_name_their_truncation() {
        let input = "x".repeat(THREAD_TOOL_INPUT_MAX_BYTES * 2);
        let line = serde_json::json!({"type":"assistant","message":{"id":"m","content":[
            {"type":"tool_use","id":"t","name":"Write","input":{"content":input}}]}})
        .to_string();
        let output = "é".repeat(THREAD_TOOL_OUTPUT_MAX_BYTES);
        let result = serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":output}],"is_error":true}]}})
        .to_string();
        let events = kinds(&format!("{line}\n{result}"));
        match &events[0] {
            ThreadEventKind::ToolCall {
                input, truncated, ..
            } => {
                assert!(*truncated);
                assert_eq!(input.len(), THREAD_TOOL_INPUT_MAX_BYTES);
            }
            other => panic!("expected a tool call, got {other:?}"),
        }
        match &events[1] {
            ThreadEventKind::ToolResult {
                output,
                truncated,
                is_error,
                ..
            } => {
                assert!(*truncated && *is_error);
                assert!(output.len() <= THREAD_TOOL_OUTPUT_MAX_BYTES);
            }
            other => panic!("expected a tool result, got {other:?}"),
        }
    }

    #[test]
    fn an_error_result_carries_its_text() {
        let mut mapper = StreamMapper::default();
        let mapped = mapper.map_line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: overloaded"}"#,
        );
        assert_eq!(mapped.turn_end, Some(TurnOutcome::Error));
        assert_eq!(
            mapped.events,
            vec![ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Error,
                error: Some("API Error: overloaded".into())
            }]
        );
    }

    #[test]
    fn launch_splits_out_the_conversation_arguments() {
        let mut cmd = portable_pty::CommandBuilder::new("claude");
        cmd.args(["--resume", "abc", "--mcp-config", "{}"]);
        let (launch, conversation) = ClaudeStreamJson::from_command(&cmd).unwrap();
        assert_eq!(conversation, Some(Conversation::Resume("abc".into())));
        assert_eq!(
            launch.launch.args,
            vec![OsString::from("--mcp-config"), OsString::from("{}")]
        );
        let resumed = launch
            .command(conversation.as_ref(), ThreadPermissionMode::Default)
            .unwrap()
            .args;
        assert!(resumed
            .windows(2)
            .any(|pair| pair == [OsString::from("--resume"), "abc".into()]));
        assert_eq!(
            resumed[resumed.len() - THREAD_FLAGS.len()..],
            THREAD_FLAGS.map(OsString::from)
        );
    }

    #[test]
    fn system_events_report_the_permission_mode() {
        let mut mapper = StreamMapper::default();
        let init = mapper.map_line(
            r#"{"type":"system","subtype":"init","session_id":"s","permissionMode":"plan"}"#,
        );
        assert_eq!(init.permission_mode, Some(ThreadPermissionMode::Plan));
        let status =
            mapper.map_line(r#"{"type":"system","subtype":"status","permissionMode":"default"}"#);
        assert_eq!(status.permission_mode, Some(ThreadPermissionMode::Default));
        let unknown =
            mapper.map_line(r#"{"type":"system","subtype":"status","permissionMode":"dontAsk"}"#);
        assert_eq!(unknown.permission_mode, None);
    }

    #[test]
    fn launch_splits_out_the_permission_flags_and_adds_the_prompt_tool() {
        let mut cmd = portable_pty::CommandBuilder::new("claude");
        cmd.args(["--permission-mode", "plan", "--mcp-config", "{}"]);
        let (launch, _) = ClaudeStreamJson::from_command(&cmd).unwrap();
        assert_eq!(launch.permission_mode, ThreadPermissionMode::Plan);
        let argv = |mode| -> Vec<String> {
            launch
                .command(None, mode)
                .unwrap()
                .args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };
        let accept = argv(ThreadPermissionMode::AcceptEdits);
        assert_eq!(
            accept[..4],
            ["--mcp-config", "{}", "--permission-mode", "acceptEdits"]
        );
        assert!(accept.windows(2).any(|pair| pair
            == [
                "--permission-prompt-tool",
                "mcp__houston__thread_permission"
            ]));
        assert!(
            argv(ThreadPermissionMode::Bypass).contains(&"--dangerously-skip-permissions".into())
        );

        let mut bypass = portable_pty::CommandBuilder::new("claude");
        bypass.arg("--dangerously-skip-permissions");
        let (launch, _) = ClaudeStreamJson::from_command(&bypass).unwrap();
        assert_eq!(launch.permission_mode, ThreadPermissionMode::Bypass);
        assert!(
            !launch
                .command(None, ThreadPermissionMode::Default)
                .unwrap()
                .args
                .iter()
                .any(|arg| arg == "--permission-prompt-tool"),
            "without Houston's MCP server there is no tool to name"
        );

        let mut odd = portable_pty::CommandBuilder::new("claude");
        odd.args(["--permission-mode", "dontAsk"]);
        let error = ClaudeStreamJson::from_command(&odd)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("\"dontAsk\""), "{error}");
    }
}

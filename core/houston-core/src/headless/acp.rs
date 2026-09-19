use super::{Decoded, PendingQuestion, TurnRequest};
use anyhow::Result;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

/// Fixed, not a counter: [`AcpEngine`] is fresh per turn and sends its whole
/// handshake in one write, so there is no second `initialize` to collide with.
const INITIALIZE_ID: u64 = 1;
const SESSION_ID: u64 = 2;
const PROMPT_ID: u64 = 3;
/// The `session/new` id a resumed turn falls back to when `session/load` is
/// refused — a distinct id, so the refusal and the fallback's reply cannot be
/// confused.
const FALLBACK_SESSION_ID: u64 = 4;

const PROTOCOL_VERSION: u64 = 1;

fn jsonrpc_request(id: u64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

pub fn initialize_request(id: u64) -> String {
    jsonrpc_request(
        id,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
        }),
    )
}

pub fn session_new_request(id: u64, cwd: &Path) -> String {
    jsonrpc_request(
        id,
        "session/new",
        json!({
            "cwd": cwd.display().to_string(),
            "mcpServers": [],
        }),
    )
}

pub fn session_load_request(id: u64, session_id: &str, cwd: &Path) -> String {
    jsonrpc_request(
        id,
        "session/load",
        json!({
            "sessionId": session_id,
            "cwd": cwd.display().to_string(),
            "mcpServers": [],
        }),
    )
}

pub fn session_prompt_request(id: u64, session_id: &str, prompt: &str) -> String {
    jsonrpc_request(
        id,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }],
        }),
    )
}

pub fn permission_reply_line(request_id: &Value, option_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
    })
    .to_string()
}

fn wanted_kinds(
    mode: Option<proto::ChatPermissionMode>,
    one_shot: bool,
) -> Option<&'static [&'static str]> {
    if one_shot {
        return Some(&["reject_once", "reject_always"]);
    }
    match mode {
        Some(proto::ChatPermissionMode::AcceptEdits)
        | Some(proto::ChatPermissionMode::BypassPermissions) => {
            Some(&["allow_once", "allow_always"])
        }
        None => None,
    }
}

pub fn auto_permission_answer(
    mode: Option<proto::ChatPermissionMode>,
    one_shot: bool,
    options: &[proto::ChatQuestionOption],
) -> Option<String> {
    let wanted = wanted_kinds(mode, one_shot)?;
    options
        .iter()
        .find(|o| {
            o.description
                .as_deref()
                .is_some_and(|kind| wanted.contains(&kind))
        })
        .or_else(|| options.first())
        .map(|o| o.label.clone())
}

pub fn expired_answer(question: &proto::ChatQuestion) -> String {
    question
        .options
        .iter()
        .find(|o| {
            o.description
                .as_deref()
                .is_some_and(|kind| kind.starts_with("reject"))
        })
        .or_else(|| question.options.first())
        .map(|o| o.label.clone())
        .unwrap_or_default()
}

fn permission_question(id: String, params: &Value) -> proto::ChatQuestion {
    let tool_call = params.get("toolCall");
    let title = tool_call
        .and_then(|t| t.get("title"))
        .and_then(Value::as_str);
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| {
                    let option_id = o.get("optionId")?.as_str()?.to_string();
                    let kind = o.get("kind").and_then(Value::as_str).map(str::to_string);
                    Some(proto::ChatQuestionOption {
                        label: option_id,
                        description: kind,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    proto::ChatQuestion {
        id,
        kind: proto::ChatQuestionKind::Permission,
        header: Some(match title {
            Some(t) => format!("Approval needed for {t}"),
            None => "Approval needed".to_string(),
        }),
        prompt: match title {
            Some(t) => format!("{t} wants to run."),
            None => "The agent wants to run a tool.".to_string(),
        },
        options,
        multi_select: false,
        allow_free_text: false,
        answered: None,
    }
}

fn message_id(id: &Value) -> Option<String> {
    match id {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// `permission_mode`/`one_shot` are `Mutex`es because `argv`/`stdin` take
/// `&self` (the trait's shape): `decode`'s `&mut self` is the only place state
/// can be written, and `Cell` is not `Sync`, which the trait requires.
pub struct AcpEngine {
    agent: &'static crate::acp::KnownAcpAgent,
    decoder: crate::acp::AcpDecoder,
    permission_mode: Mutex<Option<proto::ChatPermissionMode>>,
    one_shot: Mutex<bool>,
    session_id: Option<String>,
    prompt: Mutex<String>,
    cwd: Mutex<std::path::PathBuf>,
    queued: Vec<String>,
    text_buf: String,
    pending: std::collections::HashMap<String, Value>,
}

impl AcpEngine {
    pub fn new(agent: &'static crate::acp::KnownAcpAgent) -> Self {
        AcpEngine {
            agent,
            decoder: crate::acp::AcpDecoder::new(),
            permission_mode: Mutex::new(None),
            one_shot: Mutex::new(false),
            session_id: None,
            prompt: Mutex::new(String::new()),
            cwd: Mutex::new(std::path::PathBuf::new()),
            queued: Vec::new(),
            text_buf: String::new(),
            pending: std::collections::HashMap::new(),
        }
    }

    pub fn program(&self) -> &str {
        self.agent.argv[0]
    }

    pub fn models(&self) -> &'static [&'static str] {
        self.agent.primary_models
    }

    pub fn argv(&self, req: &TurnRequest) -> Result<Vec<String>> {
        *self.permission_mode.lock().expect("acp engine lock") = req.permission_mode;
        *self.one_shot.lock().expect("acp engine lock") = req.one_shot;
        *self.prompt.lock().expect("acp engine lock") = req.prompt.clone();
        *self.cwd.lock().expect("acp engine lock") = req.cwd.clone();
        let mut args: Vec<String> = self.agent.argv[1..].iter().map(|s| s.to_string()).collect();
        if let (Some(flag), Some(model)) = (self.agent.model_select_flag, req.model.as_deref()) {
            args.push(flag.to_string());
            args.push(model.to_string());
        }
        Ok(args)
    }

    pub fn stdin(&self, req: &TurnRequest) -> Option<String> {
        let mut lines = vec![initialize_request(INITIALIZE_ID)];
        match req.resume.as_deref() {
            Some(session_id) => {
                lines.push(session_load_request(SESSION_ID, session_id, &req.cwd));
            }
            None => lines.push(session_new_request(SESSION_ID, &req.cwd)),
        }
        Some(lines.join("\n"))
    }

    pub fn outbound(&mut self) -> Vec<String> {
        std::mem::take(&mut self.queued)
    }

    pub fn stdin_stays_open(&self) -> bool {
        true
    }

    fn session_ready(&mut self, session_id: &str, out: &mut Vec<Decoded>) {
        self.session_id = Some(session_id.to_string());
        out.push(Decoded::Init {
            session_id: Some(session_id.to_string()),
        });
        let prompt = self.prompt.lock().expect("acp engine lock").clone();
        self.queued
            .push(session_prompt_request(PROMPT_ID, session_id, &prompt));
    }

    pub fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let mut framed = line.as_bytes().to_vec();
        framed.push(b'\n');
        let mut out = Vec::new();
        for outcome in self.decoder.feed(&framed) {
            match outcome {
                crate::acp::AcpDecodeOutcome::Message(v) => self.apply_message(&v, &mut out),
                crate::acp::AcpDecodeOutcome::Error(e) => {
                    out.push(Decoded::StreamError {
                        text: e.to_string(),
                    });
                }
            }
        }
        out
    }

    fn apply_message(&mut self, v: &Value, out: &mut Vec<Decoded>) {
        let Some(obj) = v.as_object() else {
            return;
        };

        if obj.get("method").and_then(Value::as_str) == Some("session/request_permission") {
            let Some(id) = obj.get("id").and_then(message_id) else {
                return;
            };
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            let question = permission_question(id.clone(), &params);
            self.pending.insert(id, obj.get("id").cloned().unwrap());
            let asking = self
                .permission_mode
                .lock()
                .expect("acp engine lock")
                .is_none()
                && !*self.one_shot.lock().expect("acp engine lock");
            if asking {
                out.push(Decoded::PermissionRequest { question });
                return;
            }
            let mode = *self.permission_mode.lock().expect("acp engine lock");
            let one_shot = *self.one_shot.lock().expect("acp engine lock");
            if let Some(option) = auto_permission_answer(mode, one_shot, &question.options) {
                let raw_id = self.pending.remove(&question.id).expect("inserted above");
                self.queued.push(permission_reply_line(&raw_id, &option));
            }
            return;
        }

        if obj.get("method").and_then(Value::as_str) == Some("session/update") {
            self.apply_session_update(obj.get("params"), out);
            return;
        }

        let Some(id) = obj.get("id") else {
            return;
        };
        match id.as_u64() {
            Some(SESSION_ID) | Some(FALLBACK_SESSION_ID) => {
                if let Some(session_id) = v.pointer("/result/sessionId").and_then(Value::as_str) {
                    let session_id = session_id.to_string();
                    self.session_ready(&session_id, out);
                } else if let Some(error) = obj.get("error") {
                    if id.as_u64() == Some(SESSION_ID) && self.session_id.is_none() {
                        let cwd = self.cwd.lock().expect("acp engine lock").clone();
                        self.queued
                            .push(session_new_request(FALLBACK_SESSION_ID, &cwd));
                    } else {
                        out.push(Decoded::StreamError {
                            text: format!("the agent refused to open a session: {error}"),
                        });
                    }
                }
            }
            Some(PROMPT_ID) => {
                if v.pointer("/result/stopReason").is_some() {
                    if !self.text_buf.is_empty() {
                        out.push(Decoded::Text {
                            text: std::mem::take(&mut self.text_buf),
                        });
                    }
                    out.push(Decoded::Result {
                        ok: true,
                        session_id: self.session_id.clone(),
                        error: None,
                        usage: proto::ChatUsage {
                            input_tokens: None,
                            output_tokens: None,
                            cost_usd: None,
                            duration_ms: None,
                        },
                    });
                } else if let Some(error) = obj.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("(no error message)")
                        .to_string();
                    out.push(Decoded::Result {
                        ok: false,
                        session_id: self.session_id.clone(),
                        error: Some(message),
                        usage: proto::ChatUsage {
                            input_tokens: None,
                            output_tokens: None,
                            cost_usd: None,
                            duration_ms: None,
                        },
                    });
                }
            }
            _ => {}
        }
    }

    fn apply_session_update(&mut self, params: Option<&Value>, out: &mut Vec<Decoded>) {
        let Some(update) = params.and_then(|p| p.get("update")) else {
            return;
        };
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "agent_message_chunk" => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.text_buf.push_str(text);
                    out.push(Decoded::TextDelta {
                        text: text.to_string(),
                    });
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    out.push(Decoded::Reasoning {
                        text: text.to_string(),
                    });
                }
            }
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = update
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                out.push(Decoded::ToolStart {
                    id,
                    detail: name.clone(),
                    name,
                });
            }
            "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                match update.get("status").and_then(Value::as_str) {
                    Some("completed") => out.push(Decoded::ToolEnd {
                        id,
                        ok: true,
                        detail: "done".to_string(),
                    }),
                    Some("failed") => out.push(Decoded::ToolEnd {
                        id,
                        ok: false,
                        detail: "failed".to_string(),
                    }),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    pub fn reply(&self, question: &PendingQuestion, answer: &str) -> Option<String> {
        let raw_id = self.pending.get(&question.question.id)?;
        Some(permission_reply_line(raw_id, answer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn req() -> TurnRequest {
        TurnRequest {
            cwd: PathBuf::from("/tmp/ws"),
            prompt: "hi there".into(),
            ..Default::default()
        }
    }

    #[test]
    fn initialize_request_is_exact() {
        assert_eq!(
            initialize_request(1),
            r#"{"id":1,"jsonrpc":"2.0","method":"initialize","params":{"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}},"protocolVersion":1}}"#
        );
    }

    #[test]
    fn session_new_request_is_exact() {
        assert_eq!(
            session_new_request(2, Path::new("/tmp/ws")),
            r#"{"id":2,"jsonrpc":"2.0","method":"session/new","params":{"cwd":"/tmp/ws","mcpServers":[]}}"#
        );
    }

    #[test]
    fn session_load_request_is_exact() {
        assert_eq!(
            session_load_request(2, "sess-1", Path::new("/tmp/ws")),
            r#"{"id":2,"jsonrpc":"2.0","method":"session/load","params":{"cwd":"/tmp/ws","mcpServers":[],"sessionId":"sess-1"}}"#
        );
    }

    #[test]
    fn session_prompt_request_is_exact() {
        assert_eq!(
            session_prompt_request(3, "sess-1", "hi"),
            r#"{"id":3,"jsonrpc":"2.0","method":"session/prompt","params":{"prompt":[{"text":"hi","type":"text"}],"sessionId":"sess-1"}}"#
        );
    }

    #[test]
    fn permission_reply_line_echoes_the_original_id_and_picks_the_option() {
        assert_eq!(
            permission_reply_line(&json!(7), "allow-once"),
            r#"{"id":7,"jsonrpc":"2.0","result":{"outcome":{"optionId":"allow-once","outcome":"selected"}}}"#
        );
        assert_eq!(
            permission_reply_line(&json!("req-7"), "allow-once"),
            r#"{"id":"req-7","jsonrpc":"2.0","result":{"outcome":{"optionId":"allow-once","outcome":"selected"}}}"#
        );
    }

    fn options() -> Vec<proto::ChatQuestionOption> {
        vec![
            proto::ChatQuestionOption {
                label: "allow-once".into(),
                description: Some("allow_once".into()),
            },
            proto::ChatQuestionOption {
                label: "reject-once".into(),
                description: Some("reject_once".into()),
            },
        ]
    }

    #[test]
    fn accept_edits_and_bypass_both_answer_allow() {
        for mode in [
            proto::ChatPermissionMode::AcceptEdits,
            proto::ChatPermissionMode::BypassPermissions,
        ] {
            assert_eq!(
                auto_permission_answer(Some(mode), false, &options()),
                Some("allow-once".to_string())
            );
        }
    }

    #[test]
    fn one_shot_always_answers_reject_even_under_an_allow_mode() {
        assert_eq!(
            auto_permission_answer(
                Some(proto::ChatPermissionMode::BypassPermissions),
                true,
                &options()
            ),
            Some("reject-once".to_string())
        );
    }

    #[test]
    fn ask_mode_answers_nothing_thats_a_card() {
        assert_eq!(auto_permission_answer(None, false, &options()), None);
    }

    #[test]
    fn argv_is_the_rosters_own_argv_minus_the_binary() {
        let agent = crate::acp::find_known_acp_agent("acp-opencode").unwrap();
        let engine = AcpEngine::new(agent);
        assert_eq!(engine.argv(&req()).unwrap(), vec!["acp".to_string()]);
    }

    #[test]
    fn argv_adds_the_model_flag_when_the_agent_and_the_request_both_have_one() {
        let agent = crate::acp::find_known_acp_agent("acp-grok").unwrap();
        let engine = AcpEngine::new(agent);
        let mut r = req();
        r.model = Some("grok-4.5".into());
        assert_eq!(
            engine.argv(&r).unwrap(),
            vec![
                "agent".to_string(),
                "stdio".to_string(),
                "--model".to_string(),
                "grok-4.5".to_string()
            ]
        );
    }

    #[test]
    fn stdin_on_a_fresh_turn_is_initialize_then_session_new_and_the_prompt_waits() {
        let agent = crate::acp::find_known_acp_agent("acp-opencode").unwrap();
        let mut engine = AcpEngine::new(agent);
        engine.argv(&req()).unwrap();
        let lines: Vec<String> = engine
            .stdin(&req())
            .unwrap()
            .split('\n')
            .map(str::to_string)
            .collect();
        assert_eq!(
            lines,
            vec![
                initialize_request(INITIALIZE_ID),
                session_new_request(SESSION_ID, Path::new("/tmp/ws")),
            ]
        );
        assert!(engine.stdin_stays_open());
        assert!(
            engine.outbound().is_empty(),
            "nothing to say before a session exists"
        );
        engine.decode(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses-1"}}"#);
        assert_eq!(
            engine.outbound(),
            vec![session_prompt_request(PROMPT_ID, "ses-1", "hi there")]
        );
        assert!(engine.outbound().is_empty(), "drained once");
    }

    #[test]
    fn stdin_on_a_resumed_turn_loads_the_session_and_a_refusal_falls_back_to_fresh() {
        let agent = crate::acp::find_known_acp_agent("acp-opencode").unwrap();
        let mut engine = AcpEngine::new(agent);
        let mut r = req();
        r.resume = Some("sess-old".into());
        engine.argv(&r).unwrap();
        let lines: Vec<String> = engine
            .stdin(&r)
            .unwrap()
            .split('\n')
            .map(str::to_string)
            .collect();
        assert_eq!(
            lines[1],
            session_load_request(SESSION_ID, "sess-old", Path::new("/tmp/ws"))
        );
        let out = engine.decode(
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}"#,
        );
        assert!(
            out.is_empty(),
            "a refused load is not an error row: {out:?}"
        );
        assert_eq!(
            engine.outbound(),
            vec![session_new_request(
                FALLBACK_SESSION_ID,
                Path::new("/tmp/ws")
            )]
        );
        let out = engine.decode(r#"{"jsonrpc":"2.0","id":4,"result":{"sessionId":"ses-new"}}"#);
        assert_eq!(
            out,
            vec![Decoded::Init {
                session_id: Some("ses-new".into())
            }],
            "the fresh id reaches the thread so the next turn resumes it"
        );
        assert_eq!(
            engine.outbound(),
            vec![session_prompt_request(PROMPT_ID, "ses-new", "hi there")]
        );
    }

    fn engine() -> AcpEngine {
        AcpEngine::new(crate::acp::find_known_acp_agent("acp-opencode").unwrap())
    }

    #[test]
    fn decode_reads_the_session_new_response_as_init() {
        let mut e = engine();
        e.argv(&req()).unwrap();
        let out = e.decode(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-new"}}"#);
        assert_eq!(
            out,
            vec![Decoded::Init {
                session_id: Some("sess-new".into())
            }]
        );
    }

    #[test]
    fn decode_reads_an_agent_message_chunk_as_a_text_delta() {
        let mut e = engine();
        let out = e.decode(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}"#,
        );
        assert_eq!(out, vec![Decoded::TextDelta { text: "hi".into() }]);
    }

    #[test]
    fn decode_reads_the_final_stop_reason_as_a_result() {
        let mut e = engine();
        let out = e.decode(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#);
        assert_eq!(
            out,
            vec![Decoded::Result {
                ok: true,
                session_id: None,
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
    fn decode_in_ask_mode_surfaces_a_permission_request_and_reply_answers_it() {
        let mut e = engine();
        let mut r = req();
        r.permission_mode = None;
        e.argv(&r).unwrap();
        let out = e.decode(
            r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"call_1","title":"Run `rm -rf build/`"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}"#,
        );
        let Decoded::PermissionRequest { question } = out.into_iter().next().expect("a question")
        else {
            panic!("expected a PermissionRequest");
        };
        assert_eq!(question.id, "9");
        assert_eq!(question.options.len(), 2);
        let pending = PendingQuestion { question };
        assert_eq!(
            e.reply(&pending, "allow-once"),
            Some(permission_reply_line(&json!(9), "allow-once"))
        );
    }

    #[test]
    fn decode_in_accept_edits_mode_answers_itself_and_emits_no_card() {
        let mut e = engine();
        let mut r = req();
        r.permission_mode = Some(proto::ChatPermissionMode::AcceptEdits);
        e.argv(&r).unwrap();
        let out = e.decode(
            r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"toolCall":{},"options":[{"optionId":"allow-once","kind":"allow_once"}]}}"#,
        );
        assert!(out.is_empty(), "no card in a decided mode: {out:?}");
        assert_eq!(
            e.outbound(),
            vec![permission_reply_line(&json!(9), "allow-once")],
            "the decided answer goes straight back to the agent"
        );
    }

    #[test]
    fn decode_in_one_shot_answers_itself_even_under_bypass_and_emits_no_card() {
        let mut e = engine();
        let mut r = req();
        r.one_shot = true;
        r.permission_mode = Some(proto::ChatPermissionMode::BypassPermissions);
        e.argv(&r).unwrap();
        let out = e.decode(
            r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"toolCall":{},"options":[{"optionId":"allow-once","kind":"allow_once"},{"optionId":"reject-once","kind":"reject_once"}]}}"#,
        );
        assert!(out.is_empty(), "a one-shot call never gets a card: {out:?}");
        assert_eq!(
            e.outbound(),
            vec![permission_reply_line(&json!(9), "reject-once")],
            "a one-shot call rejects on its own"
        );
    }

    #[test]
    fn an_expired_card_answers_with_the_reject_option() {
        let q = permission_question(
            "7".into(),
            &json!({"options":[{"optionId":"allow-once","kind":"allow_once"},{"optionId":"reject-once","kind":"reject_once"}]}),
        );
        assert_eq!(expired_answer(&q), "reject-once");
    }

    #[test]
    fn decode_reads_a_tool_call_and_its_completion() {
        let mut e = engine();
        let start = e.decode(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Run tests"}}}"#,
        );
        assert_eq!(
            start,
            vec![Decoded::ToolStart {
                id: "call_1".into(),
                name: "Run tests".into(),
                detail: "Run tests".into(),
            }]
        );
        let end = e.decode(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed"}}}"#,
        );
        assert_eq!(
            end,
            vec![Decoded::ToolEnd {
                id: "call_1".into(),
                ok: true,
                detail: "done".into(),
            }]
        );
    }

    #[test]
    fn decode_ignores_plan_and_mode_updates() {
        let mut e = engine();
        for kind in ["plan", "current_mode_update", "available_commands_update"] {
            let out = e.decode(&format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"{kind}"}}}}}}"#
            ));
            assert!(out.is_empty(), "{kind} must not become a transcript row");
        }
    }

    #[test]
    fn decode_surfaces_a_malformed_line_as_a_stream_error() {
        let mut e = engine();
        let out = e.decode("not json");
        assert!(matches!(out.as_slice(), [Decoded::StreamError { .. }]));
    }

    fn fixture(engine_name: &str, name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/tests/fixtures/headless/{engine_name}/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap_or_else(|e| panic!("reading the {engine_name}/{name} fixture: {e}"))
    }

    #[test]
    fn opencode_no_permission_fixture_decodes_to_init_text_and_a_done_result() {
        let mut e = engine();
        let out = e.decode(&fixture("opencode", "no_permission.ndjson"));
        assert_eq!(
            out,
            vec![
                Decoded::Init {
                    session_id: Some("ses_opencode_demo".into())
                },
                Decoded::TextDelta {
                    text: "Sure, ".into()
                },
                Decoded::TextDelta {
                    text: "done.".into()
                },
                Decoded::Text {
                    text: "Sure, done.".into(),
                },
                Decoded::Result {
                    ok: true,
                    session_id: Some("ses_opencode_demo".into()),
                    error: None,
                    usage: proto::ChatUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        duration_ms: None,
                    },
                },
            ]
        );
    }

    #[test]
    fn opencode_permission_fixture_surfaces_a_card_between_the_tool_rows() {
        let mut e = engine();
        let out = e.decode(&fixture("opencode", "permission.ndjson"));
        assert!(matches!(out.first(), Some(Decoded::Init { .. })), "{out:?}");
        assert!(
            matches!(out.get(1), Some(Decoded::ToolStart { .. })),
            "{out:?}"
        );
        let Some(Decoded::PermissionRequest { question }) = out.get(2) else {
            panic!("expected a PermissionRequest at index 2: {out:?}");
        };
        assert_eq!(question.id, "7");
        assert_eq!(
            question
                .options
                .iter()
                .map(|o| o.label.as_str())
                .collect::<Vec<_>>(),
            vec!["allow-once", "reject-once"]
        );
        assert!(
            matches!(out.get(3), Some(Decoded::ToolEnd { ok: true, .. })),
            "{out:?}"
        );
        assert!(
            matches!(out.get(4), Some(Decoded::Result { ok: true, .. })),
            "{out:?}"
        );
    }

    #[test]
    fn opencode_resume_fixture_decodes_to_text_and_a_done_result() {
        let mut e = engine();
        let out = e.decode(&fixture("opencode", "resume.ndjson"));
        assert_eq!(
            out,
            vec![
                Decoded::TextDelta {
                    text: "Continuing from before.".into()
                },
                Decoded::Text {
                    text: "Continuing from before.".into(),
                },
                Decoded::Result {
                    ok: true,
                    session_id: None,
                    error: None,
                    usage: proto::ChatUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        duration_ms: None,
                    },
                },
            ]
        );
    }

    fn grok_engine() -> AcpEngine {
        AcpEngine::new(crate::acp::find_known_acp_agent("acp-grok").unwrap())
    }

    #[test]
    fn grok_permission_fixture_surfaces_a_card_and_a_failed_tool_end() {
        let mut e = grok_engine();
        let out = e.decode(&fixture("grok", "permission.ndjson"));
        assert!(out
            .iter()
            .any(|d| matches!(d, Decoded::PermissionRequest { .. })));
        assert!(out
            .iter()
            .any(|d| matches!(d, Decoded::ToolEnd { ok: false, .. })));
        assert!(matches!(out.last(), Some(Decoded::Result { ok: true, .. })));
    }

    #[test]
    fn grok_no_permission_and_resume_fixtures_both_decode_cleanly() {
        for name in ["no_permission.ndjson", "resume.ndjson"] {
            let mut e = grok_engine();
            let out = e.decode(&fixture("grok", name));
            assert!(
                out.iter().any(|d| matches!(d, Decoded::TextDelta { .. })),
                "{name}: {out:?}"
            );
            assert!(
                matches!(out.last(), Some(Decoded::Result { ok: true, .. })),
                "{name}: {out:?}"
            );
        }
    }
}

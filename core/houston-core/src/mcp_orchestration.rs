use std::sync::{Arc, Weak};

use houston_protocol as proto;
use serde_json::{json, Value};

use crate::daemon::Daemon;
use crate::mcp_creds::McpScope;
use crate::mcp_server::{Annotations, BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec};
use crate::orchestrate;

pub struct OrchestrationTools {
    daemon: Weak<Daemon>,
}

impl OrchestrationTools {
    pub fn new(daemon: &Arc<Daemon>) -> Self {
        Self {
            daemon: Arc::downgrade(daemon),
        }
    }

    fn daemon(&self) -> Result<Arc<Daemon>, ToolError> {
        self.daemon
            .upgrade()
            .ok_or_else(|| ToolError("the Houston daemon is shutting down".into()))
    }
}

fn refused(e: anyhow::Error) -> ToolError {
    ToolError(format!("{e:#}"))
}

fn u32_arg(args: &Value, key: &str) -> Result<u32, ToolError> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            ToolError(format!(
                "{key} is required and must be a session id (a positive integer); got {}; example: {{\"{key}\": 123}}",
                args.get(key).unwrap_or(&Value::Null)
            ))
        })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ToolError(format!(
                "{key} is required and must be a non-empty string; got {}; example: {{\"{key}\": \"result text\"}}",
                args.get(key).unwrap_or(&Value::Null)
            ))
        })
}

fn key_names() -> Vec<&'static str> {
    orchestrate::SENDABLE_KEYS.iter().map(|(k, _)| *k).collect()
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// A non-array is refused, not read as empty: a caller that sent one string
/// where a list belongs would otherwise watch its artifacts vanish silently.
fn str_list_arg(args: &Value, key: &str) -> Result<Vec<String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items
            .iter()
            .map(|v| match v.as_str() {
                Some(s) => s.to_string(),
                None => v.to_string(),
            })
            .collect()),
        Some(other) => Err(ToolError(format!(
            "{key} must be an array of strings; got {other}"
        ))),
    }
}

const PANE_ROUTING: &str = concat!(
    "You are running inside a Houston pane. ",
    "To delegate work to another agent, prefer `pane_spawn` over this host's own sub-agent tool: ",
    "a pane is visible to the user in the grid, runs in the project directory, outlives your session, ",
    "and the user can read it and type into it while it works — none of which is true of an in-process sub-agent. ",
    "When the user says \"spawn an agent\", \"another agent\", \"a Claude in another pane\" or similar, they mean a pane. ",
    "`pane_spawn` returns as soon as the child is up. Your next action is either independent \
     work or `pane_wait`: it blocks at zero token cost until your inbox has a result, a \
     question, or an exit. Use diagnostics only after a wait timeout, for help, or when the \
     operator asks; do not sit in a diagnostic loop. ",
    "Its signature: `pane_spawn{kind: claude|codex|antigravity|opencode|cursor|grok, prompt, model?, cwd?, ",
    "auto_approve?, profile?, role?, target_workspace?, reusable?, handoff?, state_doc?, effort?, \
     output_format?, boundaries?}` — `role` is your own short name ",
    "for that child, unique among your live children, and it is how every wake from it identifies ",
    "itself; `output_format` and `boundaries` are the other two thirds of a brief, composed into ",
    "the prompt for you. ",
    "When the user asks for a handoff — the work continues in a new pane and this one is no \
     longer needed — pass `handoff: true`: the new pane is independent, not your child, so it \
     never reports back and the user can close this pane without killing it. Only a top-level \
     pane can hand off; child and depth caps apply to child spawning. ",
    "`workspace_info` lists registered target workspaces; `target_workspace` accepts only one \
     of those paths and `cwd` must stay inside it. ",
    "The other verbs are `pane_list`, `pane_get`, `pane_read`, `pane_prompt`, `pane_wait`, ",
    "`pane_send_keys`, `pane_kill`, `pane_submit`, `pane_pr_watch`, `pane_pr_unwatch`. ",
    "After receiving a completed child's result, preserve its needed output and artifacts, then promptly close the pane with `pane_kill` (or `hs-pane kill`); completed panes remain until the parent closes them, so do not accumulate them. Keep a reusable pane only when you intentionally plan more assigned work. Never close a child that is still working; inspect live descendants and do not confirm ending them unless their work is also complete and preserved. The worker must not kill itself before delivering its result. ",
    "Call `pane_pr_watch` with a PR URL or number and end your turn; do not poll. Use `pane_pr_unwatch` when updates are no longer needed. ",
    "A pane that needs input will not take a `pane_prompt` — read it, then answer it with ",
    "`pane_send_keys` (esc enter up down tab ctrl+c y n), or escalate to the user when their decision is required. Child needs-input belongs to its parent and does not notify the desktop. ",
    "Scale the spawn to the work: do it yourself when the task is smaller than the brief it would ",
    "need, and when you do delegate, size the model to that chunk rather than taking the CLI's own ",
    "default. A long result is a file the child names in `pane_submit{artifacts}`, never a body ",
    "you read back out of a terminal. ",
    "Fuller guidance — long results, reading a blocked child, what not to touch — is in the ",
    "`houston-pane` skill. ",
    "Name a `model` explicitly for cheap mechanical work — searches, greps, mechanical edits: ",
    "an omitted model inherits the child CLI's own default, which is usually far more than a ",
    "delegated task needs. Go down to `sonnet`, not below it: Claude Code cannot run auto mode ",
    "on `haiku`, so that spawn is refused rather than demoted to a pane that blocks on ",
    "approvals nobody is there to answer. ",
    "A spawned pane starts in its CLI's AUTO mode — Claude's \"auto mode on\" — so it does not ",
    "stop for routine approvals, since nobody is at its keyboard. It can still stop for something ",
    "genuinely dangerous, which reaches you as that pane needing input.",
);

/// A pane that HAS a parent is told its end-of-turn obligation by the daemon,
/// not by whatever the parent remembered to put in the brief — a parent that
/// forgets otherwise waits on a promise this very block made.
fn worker_duty(parent: u32) -> String {
    format!(
        "You were spawned by pane {parent}. When your task is done, hand the result back with          `pane_submit` (or `hs-pane submit`) — that is your end-of-turn, and it is what wakes          the pane waiting on you. Say what you did, what you did not, and anything it must          decide. The parent closes the completed pane after receiving your result; do not try          to close your own pane. "
    )
}

const SPAWNING_AUTHORITY: &str = concat!(
    "Whether you may spawn a child depends on the operator's orchestration switch, on how many child slots ",
    "you have left, and on how deep you already sit — and all three can change while you are running. ",
    "Your tool list is the live answer, not this paragraph: `pane_spawn` is advertised exactly when ",
    "you could actually use it. A top-level pane can still use `handoff: true` with its child slots full. ",
    "`pane_list`'s description always carries the current state — your ",
    "free slots and the depth cap, or, when `pane_spawn` is missing, which of the three closed it and ",
    "how it reopens. If `pane_spawn` is absent but `pane_list` is present, read that description and act on it — free a slot, ",
    "or say plainly that the operator has to enable spawning or raise a cap in Settings → ",
    "Orchestration — rather than quietly falling back to an in-process sub-agent. ",
    "Houston pushes a tools-changed notification the moment ",
    "any of the three moves, so re-read your tools rather than assuming the answer you were given at ",
    "startup still holds.",
);

/// Named with the same default and cap as the HTTP route's read: a limit
/// someone can hit is a limit they must see, and the two doors must not disagree.
const READ_LINES_DEFAULT: usize = 40;
const READ_LINES_MAX: usize = 500;

impl ToolProvider for OrchestrationTools {
    /// Why the paragraph exists at all: a bare tool name loses to a host tool
    /// with a full description. The live orchestration state rides in
    /// `pane_spawn`'s description instead, because `instructions` is frozen.
    fn instructions(&self, scope: &McpScope) -> Option<String> {
        let daemon = self.daemon.upgrade()?;
        let mut out = String::new();
        if let Some(parent) = daemon.parent_of(scope.session_id) {
            out.push_str(&worker_duty(parent));
        }
        out.push_str(PANE_ROUTING);
        out.push(' ');
        out.push_str(SPAWNING_AUTHORITY);
        Some(out)
    }

    fn tools(&self, scope: &McpScope) -> Vec<ToolSpec> {
        let Some(daemon) = self.daemon.upgrade() else {
            return Vec::new();
        };
        let enabled = daemon.orchestration_enabled();
        let show = daemon.parent_of(scope.session_id).is_some() || enabled;
        if !show {
            return Vec::new();
        }
        let max = daemon.orchestration_max_live_children();
        let free = max.saturating_sub(daemon.active_children_of(scope.session_id).len() as u32);
        let depth_cap = daemon.orchestration_max_spawn_depth();
        let would_be = daemon.spawn_depth_of(scope.session_id) + 1;
        let spawnable = daemon.spawnable_by(scope.session_id);
        let handoffable = daemon.handoffable_by(scope.session_id);
        let live = if !enabled {
            "ORCHESTRATION IS OFF right now — the operator turns it on in Settings → \
             Orchestration. `pane_submit` still works. "
                .to_string()
        } else if !spawnable {
            let why = if free == 0 {
                format!(
                    "all {max} of your child slots are in use — `pane_kill` one, or wait for \
                     one to finish, to restore child spawning"
                )
            } else {
                format!(
                    "you are at depth {} and the cap is {depth_cap}, so a pane you spawned \
                     does not itself spawn — the operator raises nesting in Settings → \
                     Orchestration",
                    would_be - 1
                )
            };
            if handoffable {
                format!(
                    "CHILD SPAWNING IS NOT AVAILABLE right now: {why}. `pane_spawn` remains \
                     available with `handoff: true` for an independent pane. "
                )
            } else {
                format!("`pane_spawn` IS NOT AVAILABLE TO YOU right now: {why}. ")
            }
        } else {
            format!(
                "ORCHESTRATION IS ON here: {free} of {max} child slots free, depth cap \
                 {depth_cap}. "
            )
        };
        self.pane_tools(Some(live), spawnable || handoffable)
    }

    fn all_tools(&self) -> Vec<ToolSpec> {
        self.pane_tools(None, true)
    }

    fn progress_message(&self, scope: &McpScope, name: &str, elapsed: u64) -> Option<String> {
        if name != "pane_wait" {
            return None;
        }
        let daemon = self.daemon.upgrade()?;
        Some(format!(
            "waiting for {} children; {elapsed}s elapsed",
            daemon.active_children_of(scope.session_id).len()
        ))
    }

    fn finish_delivery(&self, scope: &McpScope, output: &ToolOutput, sent: bool) {
        if let Some(id) = output
            .structured
            .as_ref()
            .and_then(|v| v.get("delivery_id"))
            .and_then(Value::as_str)
        {
            if let Some(daemon) = self.daemon.upgrade() {
                daemon.finish_wait_delivery(scope.session_id, id, sent);
            }
        }
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let daemon = self.daemon()?;
            let caller = scope.session_id;
            match name {
                "pane_pr_watch" => {
                    let target = match args.get("pr") {
                        Some(Value::String(value)) => value.clone(),
                        Some(Value::Number(value)) => value.to_string(),
                        Some(value) => {
                            return Err(ToolError(format!(
                                "pr must be a pull request URL or number; got {value}"
                            )))
                        }
                        None => {
                            return Err(ToolError(
                                "pr is required and must be a pull request URL or number".into(),
                            ))
                        }
                    };
                    let start_target = target.clone();
                    tokio::task::spawn_blocking(move || {
                        daemon.pr_watch_start(caller, &start_target)
                    })
                    .await
                    .map_err(|e| ToolError(format!("PR watch task panicked: {e}")))?
                    .map_err(refused)?;
                    Ok(ToolOutput::structured(
                        json!({"watching": true, "pr": target, "note": "End your turn now. Houston checks for changes and wakes this pane; do not poll."}),
                    ))
                }
                "pane_pr_unwatch" => {
                    let count =
                        tokio::task::spawn_blocking(move || daemon.pr_watch_stop_all(caller))
                            .await
                            .map_err(|e| ToolError(format!("PR unwatch task panicked: {e}")))?
                            .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({"stopped": count})))
                }
                "pane_spawn" => {
                    let request: orchestrate::SpawnRequest =
                        serde_json::from_value(args.clone())
                            .map_err(|e| ToolError(format!("pane_spawn arguments: {e}")))?;
                    let reusable = request.reusable;
                    let handoff = request.handoff;
                    let effort = request.effort;
                    let outcome = tokio::task::spawn_blocking(move || {
                        daemon.orchestrate_spawn_request(caller, request)
                    })
                    .await
                    .map_err(|e| ToolError(format!("spawn task panicked: {e}")))?
                    .map_err(refused)?;
                    let info = outcome.session;
                    Ok(ToolOutput::structured(json!({
                        "session": info.id,
                        "title": info.title,
                        "codename": info.codename,
                        "agent": info.agent,
                        "cwd": info.cwd,
                        "workspace": info.project_dir,
                        "reusable": reusable,
                        "handoff": handoff,
                        "effort": effort.map(|effort| serde_json::to_value(effort).expect("effort serializes")).unwrap_or(json!("CLI default")),
                        "warning": outcome.warning,
                        "warnings": outcome.warnings,
                        "next_action": if handoff {
                            orchestrate::HANDOFF_NEXT_ACTION
                        } else {
                            orchestrate::SPAWN_NEXT_ACTION
                        },
                    })))
                }
                "pane_list" => {
                    let children = daemon.orchestrate_list(caller).map_err(refused)?;
                    Ok(ToolOutput::structured(json!({ "panes": children })))
                }
                "pane_get" => {
                    let session = u32_arg(args, "session")?;
                    if let Some(value) = args.get("result_id") {
                        let id = value.as_i64().filter(|id| *id > 0).ok_or_else(|| {
                            ToolError(format!("result_id must be a positive integer; got {value}"))
                        })?;
                        let row = daemon
                            .orchestrate_result(caller, session, id)
                            .map_err(refused)?;
                        return Ok(ToolOutput::structured(
                            json!({"result_id":id,"body":row.body}),
                        ));
                    }
                    let detail = daemon.orchestrate_get(caller, session).map_err(refused)?;
                    Ok(ToolOutput::structured(
                        serde_json::to_value(detail)
                            .map_err(|e| ToolError(format!("serializing pane {session}: {e}")))?,
                    ))
                }
                "pane_send_keys" => {
                    let session = u32_arg(args, "session")?;
                    let keys: Vec<String> = args
                        .get("keys")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .map(|v| match v.as_str() {
                                    Some(s) => s.to_string(),
                                    None => v.to_string(),
                                })
                                .collect()
                        })
                        .ok_or_else(|| {
                            ToolError(format!(
                                "keys is required and must be an array of key names; got {}; example: {{\"session\": 123, \"keys\": [\"enter\"]}}",
                                args.get("keys").unwrap_or(&Value::Null)
                            ))
                        })?;
                    daemon
                        .orchestrate_send_keys(caller, session, &keys)
                        .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({
                        "sent": keys,
                        "session": session,
                    })))
                }
                "pane_read" => {
                    let session = u32_arg(args, "session")?;
                    let lines = match args.get("lines").and_then(Value::as_u64) {
                        Some(n) if n as usize > READ_LINES_MAX => {
                            return Err(ToolError(format!(
                                "read refused: {n} lines exceeds the {READ_LINES_MAX}-line cap"
                            )))
                        }
                        Some(n) => (n as usize).max(1),
                        None => READ_LINES_DEFAULT,
                    };
                    let screen = orchestrate::read_source_is_screen(
                        args.get("source").and_then(Value::as_str),
                    )
                    .map_err(ToolError)?;
                    let out = daemon
                        .orchestrate_read(caller, session, lines, screen)
                        .map_err(refused)?;
                    Ok(ToolOutput {
                        text: out.join("\n"),
                        structured: Some(json!({ "lines": out })),
                    })
                }
                "pane_prompt" => {
                    let session = u32_arg(args, "session")?;
                    let text = str_arg(args, "text")?;
                    let key: Option<String> = args
                        .get("client_request_id")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|e| {
                            ToolError(format!("client_request_id: expected a string; {e}"))
                        })?
                        .flatten();
                    let mode: Option<String> = args
                        .get("mode")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|e| {
                            ToolError(format!("mode: expected queue, steer or restart; {e}"))
                        })?
                        .flatten();
                    let response_mode = mode.clone().unwrap_or_else(|| "queue".into());
                    let text = text.to_string();
                    let (source, status, held) = tokio::task::spawn_blocking(move || {
                        daemon.orchestrate_prompt_request(
                            caller,
                            session,
                            &text,
                            key.as_deref(),
                            mode.as_deref(),
                        )
                    })
                    .await
                    .map_err(|e| ToolError(format!("prompt task panicked: {e}")))?
                    .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({
                        "mode": response_mode,
                        "queued": true,
                        "held": held,
                        "note": if held.is_some() { "held on the bounded wake lane until the pane can accept a prompt" } else { "written to the pane and submitted" },
                        "status_source": source,
                        "status_after": status,
                    })))
                }
                "pane_wait" => {
                    if args.get("until").is_some() {
                        return Err(ToolError(orchestrate::UNTIL_REMOVED_MSG.to_string()));
                    }
                    let session = match args.get("session") {
                        None | Some(Value::Null) => None,
                        Some(_) => Some(u32_arg(args, "session")?),
                    };
                    let kind = match args.get("kind").and_then(Value::as_str) {
                        None => None,
                        Some(k) => Some(orchestrate::InboxKind::parse(k).ok_or_else(|| {
                            ToolError(format!(
                                "kind {k:?} is not a pane_inbox kind — one of {}",
                                orchestrate::INBOX_KIND_VALUES.join(", ")
                            ))
                        })?),
                    };
                    let stall_guard = args
                        .get("stall_guard")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let timeout_ms = args
                        .get("timeout_ms")
                        .and_then(Value::as_u64)
                        .filter(|n| *n > 0)
                        .unwrap_or(orchestrate::DEFAULT_WAIT_TIMEOUT_MS);
                    let (provider, cap) = daemon.orchestration_wait_cap(caller);
                    let cap_note = orchestrate::wait_cap_note(provider, timeout_ms, cap);
                    let requested_timeout_ms = timeout_ms;
                    let timeout_ms = timeout_ms.min(cap);
                    let outcome = daemon
                        .orchestrate_wait_reserved(caller, session, kind, timeout_ms, stall_guard)
                        .await
                        .map_err(refused)?;
                    let message = outcome.message();
                    match outcome {
                        orchestrate::InboxWaitOutcome::Delivered {
                            rows,
                            delivery_id,
                            has_more,
                            waited_ms: _,
                        } => {
                            let entries: Vec<orchestrate::InboxEntry> = rows
                                .into_iter()
                                .map(|row| orchestrate::InboxEntry {
                                    from_label: daemon.inbox_sender_label(&row),
                                    excerpt: None,
                                    row,
                                })
                                .collect();
                            let mut text = orchestrate::compose_inbox(&entries, &delivery_id);
                            if let Some(note) = &cap_note {
                                text.push_str(&format!("\n{note}"));
                            }
                            let wire_rows: Vec<Value> = entries
                                .into_iter()
                                .map(|entry| {
                                    let row = entry.row;
                                    let mut metadata =
                                        serde_json::to_value(proto::InboxRow::from(row))
                                            .expect("inbox row serializes");
                                    metadata
                                        .as_object_mut()
                                        .expect("inbox row object")
                                        .remove("body");
                                    metadata
                                })
                                .collect();
                            Ok(ToolOutput {
                                text,
                                structured: Some(json!({
                                    "rows": wire_rows,
                                    "delivery_id": delivery_id,
                                    "has_more": has_more,
                                    "wait_cap_ms": cap,
                                    "requested_timeout_ms": requested_timeout_ms,
                                    "provider": provider,
                                    "cap_note": cap_note,
                                })),
                            })
                        }
                        orchestrate::InboxWaitOutcome::TimedOut {
                            waited_ms,
                            status,
                            status_source,
                        } => {
                            let next_action = "Call pane_wait again.";
                            let text = cap_note.as_ref().map_or_else(
                                || format!("timeout; {next_action}"),
                                |note| format!("timeout; {next_action} {note}"),
                            );
                            Ok(ToolOutput {
                                text,
                                structured: Some(json!({
                                    "rows": [],
                                    "timed_out": true,
                                    "wait_cap_ms": cap,
                                    "requested_timeout_ms": requested_timeout_ms,
                                    "provider": provider,
                                    "cap_note": cap_note,
                                    "waited_ms": waited_ms,
                                    "status": status,
                                    "status_source": status_source,
                                    "next_action": next_action,
                                })),
                            })
                        }
                        orchestrate::InboxWaitOutcome::Restarting { waited_ms } => Ok(ToolOutput {
                            text: message.clone(),
                            structured: Some(json!({
                                "rows": [], "timed_out": true, "restarting": true,
                                "waited_ms": waited_ms, "wait_cap_ms": cap,
                                "requested_timeout_ms": requested_timeout_ms,
                                "provider": provider, "cap_note": cap_note,
                                "next_action": message,
                            })),
                        }),
                        orchestrate::InboxWaitOutcome::Superseded => Ok(ToolOutput::structured(
                            json!({"superseded": true, "rows": []}),
                        )),
                        orchestrate::InboxWaitOutcome::NothingToWaitOn => {
                            Ok(ToolOutput::structured(
                                json!({"nothing_to_wait_on": true, "live_children": 0, "rows": [], "cap_note": cap_note, "wait_cap_ms": cap, "requested_timeout_ms": requested_timeout_ms, "provider": provider}),
                            ))
                        }
                        orchestrate::InboxWaitOutcome::Stalled { .. } => Err(ToolError(message)),
                    }
                }
                "pane_kill" => {
                    let session = u32_arg(args, "session")?;
                    let confirm = args
                        .get("confirm_children")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    tokio::task::spawn_blocking(move || {
                        daemon.orchestrate_kill(caller, session, confirm)
                    })
                    .await
                    .map_err(|e| ToolError(format!("kill task panicked: {e}")))?
                    .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({ "killed": session })))
                }
                "pane_submit" => {
                    let submission = orchestrate::Submission {
                        body: str_arg(args, "body")?.to_string(),
                        summary: opt_str(args, "summary"),
                        artifacts: str_list_arg(args, "artifacts")?,
                        request_id: match args.get("request_id") {
                            None | Some(Value::Null) => None,
                            Some(value) => Some(
                                value
                                    .as_u64()
                                    .and_then(|n| u32::try_from(n).ok())
                                    .ok_or_else(|| {
                                        ToolError(format!(
                                            "request_id {value} must be a u64 within 0..={}",
                                            u32::MAX
                                        ))
                                    })?,
                            ),
                        },
                    };
                    let outcome = tokio::task::spawn_blocking(move || {
                        daemon.orchestrate_submit(caller, submission)
                    })
                    .await
                    .map_err(|e| ToolError(format!("submit task panicked: {e}")))?
                    .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({
                        "submitted": true,
                        "message_id": outcome.row_id,
                        "request_id": outcome.request_id,
                        "reason": outcome.reason,
                        "note": outcome.note,
                    })))
                }
                other => Err(ToolError(format!(
                    "orchestration provider has no tool {other:?}"
                ))),
            }
        })
    }
}

impl OrchestrationTools {
    fn pane_tools(&self, live: Option<String>, spawnable: bool) -> Vec<ToolSpec> {
        let local = |a: Annotations| Annotations {
            open_world: false,
            ..a
        };
        let spawn_description = String::from(
            "Spawn a child with prompt, output_format and boundaries; returns session id. Child slot/depth caps apply. Top-level handoff creates an independent pane without a child slot. Size model to separable work.",
        );
        let mut out = vec![
            ToolSpec {
                name: "pane_pr_watch".into(),
                title: "Watch a PR".into(),
                description: "Watch a GitHub PR; Houston checks each minute and wakes you on a failed check, all reported checks passing, a new review or comment, or a new conflict. Call it last, end your turn, do not poll.".into(),
                input_schema: json!({"type":"object","properties":{"pr":{"type":["string","integer"],"description":"PR URL or number in this repository."}},"required":["pr"],"additionalProperties":false}),
                annotations: local(Annotations::local_write()),
            },
            ToolSpec {
                name: "pane_pr_unwatch".into(),
                title: "Stop PR watches".into(),
                description: "Stop this pane's PR watches.".into(),
                input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
                annotations: local(Annotations::local_write()),
            },
            ToolSpec {
                name: "pane_spawn".into(),
                title: "Spawn an agent pane".into(),
                description: spawn_description,
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "client_request_id": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_.-]+$" },
                        "kind": {
                            "type": "string",
                            "enum": ["claude", "codex", "antigravity", "opencode", "cursor", "grok"],
                            "description": "Which agent CLI to run in the new pane.",
                        },
                        "prompt": {
                            "type": "string",
                            "description": "The task, as one self-contained instruction.",
                        },
                        "model": {
                            "type": "string",
                            "description":
                                "Exact CLI model id; consult workspace_info.providers. Omitted uses CLI default.",
                        },
                        "cwd": {
                            "type": "string",
                            "description":
                                "Working directory; must remain inside the selected target workspace.",
                        },
                        "worktree": {
                            "type": "string",
                            "description":
                                "New worktree .houston/worktrees/<slug>, branch houston/<slug> or `branch`. Base: origin/HEAD, main, master, HEAD; no base override. Refuses cwd.",
                        },
                        "branch": {
                            "type": "string",
                            "description":
                                "The new branch for `worktree`, instead of houston/<worktree>. \
                                 Must not exist yet; refused without `worktree`.",
                        },
                        "target_workspace": {
                            "type": "string",
                            "description":
                                "A registered workspace path for the child. Omitted inherits \
                                 the parent's current workspace; arbitrary paths are refused.",
                        },
                        "reusable": {
                            "type": "boolean",
                            "default": false,
                            "description":
                                "Keep the process for follow-ups after handback. Default: end it, keeping the transcript until close or expiry.",
                        },
                        "state_doc": {
                            "description": "Handoff state, at most 65536 bytes: text or a path in the target workspace. Requires handoff.",
                            "oneOf": [ {"type": "string"}, {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": false}, {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": false} ]
                        },
                        "handoff": {
                            "type": "boolean",
                            "default": false,
                            "description":
                                "Independent pane: no handback or cleanup; this pane may close. Top-level only; refuses reusable, output_format.",
                        },
                        "effort": {
                            "type": "string",
                            "enum": ["low", "medium", "high", "xhigh", "max"],
                            "description":
                                "Optional per-run reasoning effort; unsupported providers refuse \
                                 the spawn.",
                        },
                        "auto_approve": {
                            "type": "boolean",
                            "description":
                                "Omitted: CLI AUTO mode. true skips AUTO prompts (dangerous); \
                                 false asks, reported as NeedsInput.",
                        },
                        "profile": {
                            "type": "string",
                            "description":
                                "Saved account label (Settings → Agent accounts); omitted uses the default. Unknown labels list valid ones.",
                        },
                        "role": {
                            "type": "string",
                            "maxLength": orchestrate::ROLE_MAX_CHARS,
                            "description":
                                "Child label in pane_list and handbacks: lowercase, digits, \
                                 hyphens; unique among live children. Handoff: pane title only.",
                        },
                        "output_format": {
                            "type": "string",
                            "maxLength": orchestrate::BRIEF_FIELD_MAX_CHARS,
                            "description":
                                "The shape you want the answer in — \"a table of file:line \
                                 and a one-line verdict\". Composed into the prompt.",
                        },
                        "boundaries": {
                            "type": "string",
                            "maxLength": orchestrate::BRIEF_FIELD_MAX_CHARS,
                            "description":
                                "Limits, e.g. \"read-only outside ui/\". Added to the prompt; \
                                 the child must report at a limit, never cross it.",
                        },
                    },
                    "required": ["kind", "prompt"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::destructive()),
            },
            ToolSpec {
                name: "pane_list".into(),
                title: "List your agent panes".into(),
                description: format!(
                    "{}Every pane you spawned, and their descendants, with each one's \
                     current status, role and delegation state. Use after a wait timeout, for help, or when the operator asks.",
                    live.unwrap_or_default()
                ),
                input_schema: json!({
                    "type": "object", "properties": {}, "additionalProperties": false
                }),
                annotations: local(Annotations::readonly()),
            },
            ToolSpec {
                name: "pane_get".into(),
                title: "Everything about one pane".into(),
                description: "Subtree state, children, depth, role, brief, stall and staged result. Inspect after a wait timeout, for help or when asked. result_id retrieves your stored body after closure.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
                        "result_id": { "type": "integer", "description": "Stored inbox result id for full body retrieval." },
                    },
                    "required": ["session"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::readonly()),
            },
            ToolSpec {
                name: "pane_send_keys".into(),
                title: "Press keys in a pane".into(),
                description: format!(
                    "Press up to {} keys in a blocked child: {}. Invalid keys send nothing; include enter explicitly. pane_prompt refuses permission/question prompts.",
                    orchestrate::SEND_KEYS_MAX,
                    key_names().join(" "),
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
                        "keys": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": orchestrate::SEND_KEYS_MAX,
                            "items": { "type": "string", "enum": key_names() },
                            "description": "The keys to press, in order.",
                        },
                    },
                    "required": ["session", "keys"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::destructive()),
            },
            ToolSpec {
                name: "pane_read".into(),
                title: "Read a pane's terminal".into(),
                description: format!(
                    "Use after a wait timeout, for help, or when the operator asks. What a pane is showing, ANSI stripped. Default \
                     {READ_LINES_DEFAULT} lines, at most {READ_LINES_MAX} and {} characters.",
                    orchestrate::READ_TAIL_MAX_CHARS
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
                        "lines": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": READ_LINES_MAX,
                            "description": "How many lines to return.",
                        },
                        "source": {
                            "type": "string",
                            "enum": orchestrate::READ_SOURCE_VALUES,
                            "description":
                                "screen (default): visible grid, including repainting CLIs. tail: newline-split raw ring, including text older than the screen.",
                        },
                    },
                    "required": ["session"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::readonly()),
            },
            ToolSpec {
                name: "pane_prompt".into(),
                title: "Send a prompt to a pane".into(),
                description: "Prompt child: queue waits; steer writes now; restart interrupts, then waits. Drafts/permissions/questions block immediate modes. client_request_id deduplicates.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
                        "client_request_id": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_.-]+$" },
                        "mode": { "type": "string", "enum": ["queue", "steer", "restart"], "default": "queue" },
                        "text": { "type": "string", "description": "What to send." },
                    },
                    "required": ["session", "text"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::destructive()),
            },
            ToolSpec {
                name: "pane_wait".into(),
                title: "Wait for your inbox".into(),
                description: "After pane_spawn, call this and block; do not poll pane_get/pane_read/pane_list. Returns inbox result, no-handback, question or exit rows at zero token cost while blocked. After receiving a completed result, preserve needed output and artifacts, then promptly close that completed pane with pane_kill; keep a reusable pane only for intentional follow-up work. Omit session for the whole inbox; specify a child to scope rows. Urgent child rows bypass kind. Without supported hooks, only submit or exit produces rows.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": {
                            "type": "integer",
                            "description":
                                "Scope to one child's rows. Omit to wait on your whole inbox.",
                        },
                        "kind": {
                            "type": "string",
                            "enum": orchestrate::INBOX_KIND_VALUES,
                            "description":
                                "Only rows of this kind — except an urgent one \
                                 (needs_input, exited) for a waited child, which always \
                                 comes through regardless.",
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Defaults to 600000 ms; clamped to the calling parent's provider cap, named in the response.",
                        },
                        "stall_guard": {
                            "type": "boolean",
                            "description":
                                "For a wait right after `pane_prompt` (requires `session`): \
                                 return `prompt_stalled` if no row has arrived and the \
                                 pane's status has not moved within 5 s of this call, \
                                 instead of blocking for the full timeout.",
                        },
                    },
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::readonly()),
            },
            ToolSpec {
                name: "pane_kill".into(),
                title: "Kill a pane you spawned".into(),
                description: "End and dismiss your child's terminal. After receiving a completed result and preserving needed output/artifacts, close the pane promptly; do not accumulate completed panes. Keep a reusable pane only for intentional follow-up work. Do not kill a working child; inspect live descendants and confirm ending them only when their work is complete and preserved. Read needed output first.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
                        "confirm_children": {
                            "type": "boolean",
                            "description": "Confirm killing its live children too.",
                        },
                    },
                    "required": ["session"],
                    "additionalProperties": false,
                }),
                annotations: local(Annotations::destructive()),
            },
            ToolSpec {
                name: "pane_submit".into(),
                title: "Hand your result to the pane that spawned you".into(),
                description: format!(
                    "Child panes only: deliver your final result to the parent's inbox, waking its wait or next turn. Call once at end-of-turn; report completed work, omissions and decisions. The parent closes your completed pane after receiving the result; do not try to close your own pane. Body clips at {} characters; put long results in files named by artifacts.",
                    orchestrate::SUBMIT_BODY_MAX_CHARS
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "body": { "type": "string", "description": "Your result." },
                        "summary": {
                            "type": "string",
                            "maxLength": orchestrate::SUBMIT_SUMMARY_MAX_CHARS,
                            "description":
                                "One line naming the outcome, read above the body — \"3 of \
                                 7 call sites are unsafe\".",
                        },
                        "artifacts": {
                            "type": "array",
                            "maxItems": orchestrate::SUBMIT_ARTIFACTS_MAX,
                            "items": { "type": "string" },
                            "description":
                                "Files this result points at instead of quoting. Inside this \
                                 workspace, absolute or relative to your own directory, and \
                                 each must exist.",
                        },
                        "request_id": {
                            "type": "integer",
                            "minimum": 1,
                            "description":
                                "Request answered; workspace_info reports the current one. Needed for an older request; omit for current, or unassociated if two are open.",
                        },
                    },
                    "required": ["body"],
                    "additionalProperties": false,
                }),
                annotations: Annotations::local_write(),
            },
        ];
        if !spawnable {
            out.retain(|t| t.name != "pane_spawn");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_descriptions_and_schema_require_bounded_blocking() {
        let specs = OrchestrationTools {
            daemon: Weak::new(),
        }
        .pane_tools(None, true);
        let wait = specs.iter().find(|spec| spec.name == "pane_wait").unwrap();
        assert!(wait.description.contains(
            "After pane_spawn, call this and block; do not poll pane_get/pane_read/pane_list"
        ));
        assert!(wait
            .description
            .contains("preserve needed output and artifacts"));
        assert!(wait
            .description
            .contains("promptly close that completed pane with pane_kill"));
        assert!(wait.input_schema["properties"]["timeout_ms"]
            .get("maximum")
            .is_none());
        assert!(wait.input_schema["properties"]["timeout_ms"]["description"]
            .as_str()
            .unwrap()
            .contains("calling parent"));
        for spec in specs
            .iter()
            .filter(|spec| matches!(spec.name.as_str(), "pane_get" | "pane_read" | "pane_list"))
        {
            assert!(spec.description.contains("after a wait timeout"));
            assert!(!spec.description.contains("before deciding to wait"));
        }
        let kill = specs.iter().find(|spec| spec.name == "pane_kill").unwrap();
        assert!(kill.description.contains("completed result"));
        assert!(kill
            .description
            .contains("do not accumulate completed panes"));
        assert!(kill.description.contains("Do not kill a working child"));
    }

    #[test]
    fn every_tool_is_named_pane_and_schema_closed() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let specs = provider.all_tools();
        let names: Vec<_> = specs.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            names,
            vec![
                "pane_pr_watch",
                "pane_pr_unwatch",
                "pane_spawn",
                "pane_list",
                "pane_get",
                "pane_send_keys",
                "pane_read",
                "pane_prompt",
                "pane_wait",
                "pane_kill",
                "pane_submit",
            ],
            "the tool set mirrors the hs-pane verbs one for one"
        );
        for spec in &specs {
            assert_eq!(
                spec.input_schema["additionalProperties"],
                json!(false),
                "{} must reject unknown args",
                spec.name
            );
            assert!(
                !spec.annotations.open_world,
                "{} acts on daemon-owned panes, not the open web",
                spec.name
            );
        }
    }

    #[test]
    fn pane_spawn_schema_offers_worktree_and_branch() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let specs = provider.all_tools();
        let spawn = specs
            .iter()
            .find(|s| s.name == "pane_spawn")
            .expect("pane_spawn is listed");
        for key in ["worktree", "branch"] {
            assert_eq!(
                spawn.input_schema["properties"][key]["type"],
                json!("string"),
                "pane_spawn must offer `{key}` as a string"
            );
        }
        let required = spawn.input_schema["required"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for key in ["worktree", "branch"] {
            assert!(
                !required.contains(&json!(key)),
                "`{key}` must stay optional so existing callers keep working"
            );
        }
    }

    #[test]
    fn read_and_write_tools_are_annotated_apart() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        for spec in provider.all_tools() {
            let readonly = matches!(
                spec.name.as_str(),
                "pane_list" | "pane_get" | "pane_read" | "pane_wait"
            );
            // pane_submit is neither: a local additive write, not a read and not
            // destructive (it only appends a row to the parent's own inbox).
            let local_write = matches!(
                spec.name.as_str(),
                "pane_submit" | "pane_pr_watch" | "pane_pr_unwatch"
            );
            assert_eq!(
                spec.annotations.read_only, readonly,
                "{} read_only annotation",
                spec.name
            );
            assert_eq!(
                spec.annotations.destructive,
                !readonly && !local_write,
                "{} destructive annotation",
                spec.name
            );
        }
    }

    #[test]
    fn the_codex_gateway_would_serve_pane_submit_and_pane_wait_directly_but_gate_spawn_and_kill() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let by_name: std::collections::HashMap<String, ToolSpec> = provider
            .all_tools()
            .into_iter()
            .map(|s| (s.name.clone(), s))
            .collect();
        for name in [
            "pane_submit",
            "pane_wait",
            "pane_list",
            "pane_get",
            "pane_read",
        ] {
            let spec = &by_name[name];
            assert!(
                !crate::mcp_server::codex_requires_approval(spec.annotations),
                "{name} should be servable directly by the Codex gateway"
            );
        }
        for name in ["pane_spawn", "pane_kill", "pane_send_keys", "pane_prompt"] {
            let spec = &by_name[name];
            assert!(
                crate::mcp_server::codex_requires_approval(spec.annotations),
                "{name} must stay behind call_tool"
            );
        }
    }

    #[test]
    fn without_a_daemon_there_is_no_instructions_paragraph_to_invent() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let scope = McpScope {
            session_id: 1,
            workspace_id: "/tmp/ws".into(),
        };
        assert!(provider.instructions(&scope).is_none());
    }

    #[tokio::test]
    async fn a_dead_daemon_is_a_readable_refusal_not_a_panic() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let scope = McpScope {
            session_id: 1,
            workspace_id: "ws".into(),
        };
        let err = provider
            .call(&scope, "pane_list", &json!({}))
            .await
            .expect_err("a dropped daemon must refuse");
        assert!(err.0.contains("shutting down"), "{}", err.0);
    }

    #[test]
    fn the_mcp_tools_and_the_cli_verbs_share_one_table() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let specs = provider.all_tools();
        let by_name: std::collections::HashMap<&str, &ToolSpec> =
            specs.iter().map(|s| (s.name.as_str(), s)).collect();

        for verb in orchestrate::PANE_VERBS.iter() {
            let Some(tool) = verb.tool else {
                continue;
            };
            let spec = by_name
                .get(tool)
                .unwrap_or_else(|| panic!("{tool} not advertised by the MCP provider"));
            let schema_args: Vec<&str> = spec.input_schema["properties"]
                .as_object()
                .map(|m| {
                    let mut k: Vec<&str> = m.keys().map(String::as_str).collect();
                    k.sort_unstable();
                    k
                })
                .unwrap_or_default();
            let mut expected: Vec<&str> = verb.args.to_vec();
            expected.sort_unstable();
            assert_eq!(
                schema_args, expected,
                "{tool}: schema args differ from the shared CLI/MCP table"
            );
        }

        let advertised: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        for verb in orchestrate::PANE_VERBS.iter() {
            if let Some(tool) = verb.tool {
                assert!(
                    advertised.contains(&tool),
                    "{tool} is in the shared table but the MCP provider does not advertise it"
                );
            }
        }
    }
}

#[cfg(test)]
mod argument_example_tests {
    use super::*;

    #[test]
    fn k6_worktree_schema_names_base_order_and_no_override() {
        let provider = OrchestrationTools {
            daemon: Weak::new(),
        };
        let tools = provider.all_tools();
        let spawn = tools.iter().find(|tool| tool.name == "pane_spawn").unwrap();
        let description = spawn.input_schema["properties"]["worktree"]["description"]
            .as_str()
            .unwrap();
        assert!(
            description.contains("origin/HEAD, main, master, HEAD")
                && description.contains("no base override"),
            "{description}"
        );
    }

    #[test]
    fn k6_required_arguments_name_shape_value_and_example() {
        for value in [json!({}), json!({"session": null}), json!({"session": 0})] {
            let error = u32_arg(&value, "session").unwrap_err().0;
            assert!(
                error.contains("positive integer")
                    && error.contains("got")
                    && error.contains("example: {\"session\": 123}"),
                "{error}"
            );
        }
        let error = str_arg(&json!({"body":null}), "body").unwrap_err().0;
        assert!(
            error.contains("non-empty string")
                && error.contains("got null")
                && error.contains("example: {\"body\": \"result text\"}"),
            "{error}"
        );
    }
}

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
    "`pane_send_keys`, `pane_kill`, `pane_submit`. ",
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
        "You were spawned by pane {parent}. When your task is done, hand the result back with          `pane_submit` (or `hs-pane submit`) — that is your end-of-turn, and it is what wakes          the pane waiting on you. Say what you did, what you did not, and anything it must          decide. "
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
                "pane_spawn" => {
                    let kind: proto::AgentKind =
                        serde_json::from_value(args.get("kind").cloned().unwrap_or(Value::Null))
                            .map_err(|e| {
                                ToolError(format!(
                                    "kind must be one of claude|codex|antigravity|opencode|cursor|\
                                     grok; got {}: {e}",
                                    args.get("kind").unwrap_or(&Value::Null)
                                ))
                            })?;
                    let prompt = str_arg(args, "prompt")?.to_string();
                    let model = opt_str(args, "model");
                    let cwd = opt_str(args, "cwd");
                    let auto_approve = args.get("auto_approve").and_then(Value::as_bool);
                    let profile = opt_str(args, "profile");
                    let role = opt_str(args, "role");
                    let target_workspace = opt_str(args, "target_workspace");
                    let reusable = args
                        .get("reusable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let handoff = args
                        .get("handoff")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if handoff && reusable {
                        return Err(ToolError(orchestrate::HANDOFF_REUSABLE_REFUSED.to_string()));
                    }
                    let effort = args
                        .get("effort")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|e| {
                            ToolError(format!(
                                "effort must be one of low|medium|high|xhigh|max: {e}"
                            ))
                        })?;
                    let brief = orchestrate::Brief {
                        prompt,
                        output_format: opt_str(args, "output_format"),
                        boundaries: opt_str(args, "boundaries"),
                    };
                    // Not `opt_str`: an empty slug must reach the slug rule and be refused,
                    // not read as "no worktree" and spawn in the workspace instead.
                    let worktree = crate::worktrees::spawn_ask(
                        args.get("worktree")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        opt_str(args, "branch"),
                    )
                    .map_err(|e| ToolError(format!("{e:#}")))?;
                    let state_doc = args.get("state_doc").cloned();
                    let reply_daemon = Arc::clone(&daemon);
                    let isolated = worktree.is_some();
                    let info = tokio::task::spawn_blocking(move || {
                        let brief = daemon.handoff_state_brief(
                            caller,
                            target_workspace.as_deref(),
                            handoff,
                            brief,
                            state_doc.as_ref(),
                        )?;
                        if handoff {
                            daemon.orchestrate_handoff(
                                caller,
                                kind,
                                model,
                                cwd,
                                brief,
                                auto_approve,
                                profile,
                                role,
                                target_workspace,
                                effort,
                                worktree,
                            )
                        } else {
                            daemon.orchestrate_spawn_with_options(
                                caller,
                                kind,
                                model,
                                cwd,
                                brief,
                                auto_approve,
                                profile,
                                role,
                                target_workspace,
                                reusable,
                                effort,
                                worktree,
                            )
                        }
                    })
                    .await
                    .map_err(|e| ToolError(format!("spawn task panicked: {e}")))?
                    .map_err(refused)?;
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
                        "warning": if isolated { crate::launch::worktree_trust_warning(info.agent) } else { reply_daemon.spawn_checkout_warning(info.id) },
                        "warnings": reply_daemon.spawn_warnings(&info, isolated),
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
                    let text = text.to_string();
                    let (source, status, held) = tokio::task::spawn_blocking(move || {
                        daemon.orchestrate_prompt_with_hold(caller, session, &text)
                    })
                    .await
                    .map_err(|e| ToolError(format!("prompt task panicked: {e}")))?
                    .map_err(refused)?;
                    Ok(ToolOutput::structured(json!({
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
                    if timeout_ms > orchestrate::DEFAULT_WAIT_TIMEOUT_MS {
                        return Err(ToolError(format!("pane_wait timeout_ms {timeout_ms} exceeds the limit {} ms; expected 1..={} ms", orchestrate::DEFAULT_WAIT_TIMEOUT_MS, orchestrate::DEFAULT_WAIT_TIMEOUT_MS)));
                    }
                    let outcome = daemon
                        .orchestrate_wait_reserved(caller, session, kind, timeout_ms, stall_guard)
                        .await
                        .map_err(refused)?;
                    let message = outcome.message();
                    let next_action = outcome.next_action();
                    match outcome {
                        orchestrate::InboxWaitOutcome::Delivered {
                            rows,
                            delivery_id,
                            has_more,
                            waited_ms,
                        } => {
                            let entries: Vec<orchestrate::InboxEntry> = rows
                                .iter()
                                .map(|row| orchestrate::InboxEntry {
                                    from_label: daemon.inbox_sender_label(row),
                                    excerpt: None,
                                    row: row.clone(),
                                })
                                .collect();
                            let text = orchestrate::compose_inbox(&entries, &delivery_id);
                            let wire_rows: Vec<proto::InboxRow> =
                                rows.into_iter().map(Into::into).collect();
                            Ok(ToolOutput {
                                text,
                                structured: Some(json!({
                                    "rows": wire_rows,
                                    "delivery_id": delivery_id,
                                    "has_more": has_more,
                                    "waited_ms": waited_ms,
                                })),
                            })
                        }
                        orchestrate::InboxWaitOutcome::TimedOut {
                            waited_ms,
                            status,
                            status_source,
                        } => {
                            let text = match &next_action {
                                Some(next) => format!("{message}\n{next}"),
                                None => message,
                            };
                            Ok(ToolOutput {
                                text,
                                structured: Some(json!({
                                    "rows": [],
                                    "timed_out": true,
                                    "waited_ms": waited_ms,
                                    "status": status,
                                    "status_source": status_source,
                                    "next_action": next_action,
                                })),
                            })
                        }
                        orchestrate::InboxWaitOutcome::Superseded => Ok(ToolOutput::structured(
                            json!({"superseded": true, "rows": []}),
                        )),
                        orchestrate::InboxWaitOutcome::NothingToWaitOn => {
                            Ok(ToolOutput::structured(
                                json!({"nothing_to_wait_on": true, "live_children": 0, "rows": []}),
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
                name: "pane_spawn".into(),
                title: "Spawn an agent pane".into(),
                description: spawn_description,
                input_schema: json!({
                    "type": "object",
                    "properties": {
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
                                "Exact model identifier accepted by that CLI, forwarded unchanged \
                                 (for Codex, e.g. gpt-5.6-luna, not luna). Omitted inherits \
                                 the CLI default.",
                        },
                        "cwd": {
                            "type": "string",
                            "description":
                                "Working directory; must remain inside the selected target workspace.",
                        },
                        "worktree": {
                            "type": "string",
                            "description":
                                "New worktree at .houston/worktrees/<slug>; new branch houston/<slug> or `branch`. Base: origin/HEAD, main, master, HEAD (not caller branch); no base override. Refuses cwd; tracked for cleanup.",
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
                                "Keep the process for follow-up prompts after handback. Default: end the process and retain session/transcript until close or retention expiry.",
                        },
                        "state_doc": {
                            "description": "Handoff state, at most STATE_DOC_MAX_BYTES (65536 bytes), as text or a path inside the target workspace. Requires handoff: true.",
                            "oneOf": [ {"type": "string"}, {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": false}, {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": false} ]
                        },
                        "handoff": {
                            "type": "boolean",
                            "default": false,
                            "description":
                                "Independent pane: no handback or child cleanup; this pane may close. Top-level only; refuses reusable and output_format.",
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
                                "Leave unset: the CLI's own AUTO mode. true also skips \
                                 AUTO's own prompts (the dangerous flag); false makes the \
                                 child stop and ask, reported as NeedsInput.",
                        },
                        "profile": {
                            "type": "string",
                            "description":
                                "Saved account label from Settings → Agent accounts. Omit for default account. Unknown labels are refused with available names.",
                        },
                        "role": {
                            "type": "string",
                            "maxLength": orchestrate::ROLE_MAX_CHARS,
                            "description":
                                "Your own short name for this child (\"reviewer\"), carried \
                                 in `pane_list` and in every handback. Lowercase, digits and \
                                 hyphens; unique among your live children. With handoff, \
                                 only the new pane's title.",
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
                                "What this child must not do — \"read-only outside ui/\". \
                                 Composed into the prompt as a limit to report at, never \
                                 cross.",
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
                description: "Subtree pane state, children, depth, pending turn conditions, role, brief, stall and staged result. Use after a wait timeout, for help, or when the operator asks.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
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
                    "Press keys in one of your panes — the lever for a pane that is BLOCKED, \
                     which `pane_prompt` refuses on purpose. Only these, at most {} per \
                     call: {}. A key outside the list sends nothing at all, and `enter` is a \
                     key you ask for.",
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
                description: "Submit `text` to your child. Held status/operator input queues it on the pane's wake lane; otherwise writes synchronously and reports write errors. Refuses permission/question prompts: read them and answer with pane_send_keys.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "integer", "description": "The pane's session id." },
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
                description: "After pane_spawn, call this and block; do not poll pane_get/pane_read/pane_list. Returns inbox result, no-handback, question or exit rows at zero token cost while blocked. Omit session for the whole inbox; specify a child to scope rows. Urgent child rows bypass kind. Without supported hooks, only submit or exit produces rows.".into(),
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
                            "maximum": orchestrate::DEFAULT_WAIT_TIMEOUT_MS,
                            "description": "Defaults to 10 minutes.",
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
                description: "End and dismiss your child's terminal; read needed output first. Live descendants require confirm_children to end the subtree.".into(),
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
                    "Child panes only: deliver your final result to the parent's inbox, waking its wait or next turn. Call once at end-of-turn; report completed work, omissions and decisions. Body clips at {} characters; put long results in files named by artifacts.",
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
        assert_eq!(
            wait.input_schema["properties"]["timeout_ms"]["maximum"],
            orchestrate::DEFAULT_WAIT_TIMEOUT_MS
        );
        let maximum = wait.input_schema["properties"]["timeout_ms"]["maximum"]
            .as_u64()
            .unwrap();
        assert!(maximum < crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC * 1000);
        for spec in specs
            .iter()
            .filter(|spec| matches!(spec.name.as_str(), "pane_get" | "pane_read" | "pane_list"))
        {
            assert!(spec.description.contains("after a wait timeout"));
            assert!(!spec.description.contains("before deciding to wait"));
        }
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
            let local_write = spec.name == "pane_submit";
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

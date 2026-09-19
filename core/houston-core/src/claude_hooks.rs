use anyhow::{anyhow, Context, Result};
use houston_protocol as proto;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

pub fn hook_events() -> Vec<&'static str> {
    crate::agent_events::events_for(houston_protocol::AgentKind::Claude)
        .iter()
        .map(|(name, _)| *name)
        .chain(crate::agent_events::CLAUDE_CORRELATION_EVENTS)
        .collect()
}

const SENTINEL: &str = "--houston-managed";

/// The sentinel is tagged per channel: untagged, a dev daemon and the installed
/// one would evict each other's group on every boot. Matching is per
/// whitespace-delimited token, never `contains` — release's is a prefix of dev's.
pub fn sentinel_for(channel: Option<&str>) -> String {
    match channel {
        None => SENTINEL.to_string(),
        Some(c) => format!("{SENTINEL}={c}"),
    }
}

/// `;` is a separator because the shell guard writes it directly against the
/// sentinel (`--houston-managed=dev; fi`); without it that `;` rides into the
/// token and no channel recognizes its own group.
fn tokens(cmd: &str) -> impl Iterator<Item = &str> {
    cmd.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '[' | ']' | ';'))
}

fn command_has_sentinel(cmd: &str, sentinel: &str) -> bool {
    tokens(cmd).any(|t| t == sentinel)
}

pub const LAUNCHER_NAME: &str = "claude-hook";

const MANAGED_SUFFIX: &str = "-managed";

fn token_names_launcher(tok: &str) -> bool {
    tok.strip_suffix(LAUNCHER_NAME)
        .is_some_and(|head| head.ends_with("/bin/"))
}

fn is_legacy_sentinel(tok: &str) -> bool {
    let Some(rest) = tok.strip_prefix("--") else {
        return false;
    };
    let stem = rest.split_once('=').map_or(rest, |(s, _)| s);
    let current = SENTINEL.strip_prefix("--").unwrap_or(SENTINEL);
    stem.len() > MANAGED_SUFFIX.len() && stem.ends_with(MANAGED_SUFFIX) && stem != current
}

pub fn command_is_legacy_managed(cmd: &str) -> bool {
    let mut launcher = false;
    let mut legacy = false;
    for t in tokens(cmd) {
        launcher |= token_names_launcher(t);
        legacy |= is_legacy_sentinel(t);
    }
    launcher && legacy
}

pub fn launcher_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("bin")
}

pub fn launcher_path(state_dir: &Path) -> PathBuf {
    launcher_dir(state_dir).join(LAUNCHER_NAME)
}

pub fn point_launcher(state_dir: &Path, exe: &Path) -> Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let exe = crate::exe_path::agent_helper_exe(exe);
    let dir = launcher_dir(state_dir);
    let path = launcher_path(state_dir);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        let meta =
            std::fs::symlink_metadata(&dir).with_context(|| format!("stat {}", dir.display()))?;
        if !meta.is_dir() {
            let kind = if meta.file_type().is_symlink() {
                "a symlink"
            } else {
                "not a directory"
            };
            return Err(anyhow!(
                "{} is {kind}, not a real directory - refusing to chmod through it",
                dir.display()
            ));
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod {}", dir.display()))?;
    }
    #[cfg(windows)]
    {
        let meta =
            std::fs::symlink_metadata(&dir).with_context(|| format!("stat {}", dir.display()))?;
        if !meta.is_dir() {
            let kind = if meta.file_type().is_symlink() {
                "a symlink"
            } else {
                "not a directory"
            };
            return Err(anyhow!(
                "{} is {kind}, not a real directory - refusing to install the launcher through it",
                dir.display()
            ));
        }
    }
    sweep_stale_tmp(&dir);
    let tmp = dir.join(format!(
        "{LAUNCHER_NAME}.tr-tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&tmp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&exe, &tmp).with_context(|| {
        format!(
            "linking {} -> {} (expected a writable directory)",
            tmp.display(),
            exe.display()
        )
    })?;
    #[cfg(windows)]
    {
        if std::fs::hard_link(&exe, &tmp)
            .with_context(|| format!("hard-linking {} -> {}", exe.display(), tmp.display()))
            .is_err()
        {
            std::fs::copy(&exe, &tmp).with_context(|| {
                format!(
                    "copying {} -> {} (hardlink failed - different volume?)",
                    exe.display(),
                    tmp.display()
                )
            })?;
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("renaming {} to {}", tmp.display(), path.display()));
    }
    Ok(path)
}

fn sweep_stale_tmp(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{LAUNCHER_NAME}.tr-tmp.");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(prefix.as_str()) else {
            continue;
        };
        let Some((pid_str, _seq)) = rest.split_once('.') else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if crate::pid::process_is_alive(pid) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

pub fn settings_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join(".claude").join("settings.local.json")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HooksInstall {
    pub created_file: bool,
    pub created_hooks: bool,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) fn guard_launcher_exec(exe: &Path, argv_tail: &str) -> String {
    let exe = shell_quote(&crate::exe_path::command_spelling(exe));
    format!("if [ -x {exe} ]; then exec {exe} {argv_tail}; fi")
}

fn hook_command(exe: &str, event: &str, sentinel: &str) -> String {
    guard_launcher_exec(Path::new(exe), &format!("hook {event} {sentinel}"))
}

fn tr_hook_group(exe: &str, event: &str, sentinel: &str) -> serde_json::Value {
    let sync_stdout = matches!(event, "UserPromptSubmit" | "Stop" | "StopFailure");
    serde_json::json!({
        "hooks": [
            {
                "type": "command",
                "command": hook_command(exe, event, sentinel),
                "async": !sync_stdout,
                "timeout": 5
            }
        ]
    })
}

fn group_is_ours(group: &serde_json::Value, sentinel: &str) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .is_some_and(|c| command_has_sentinel(c, sentinel))
            })
        })
        .unwrap_or(false)
}

pub fn install(settings_path: &Path, exe: &str, sentinel: &str) -> Result<HooksInstall> {
    let exe = crate::exe_path::strip_deleted_exe_suffix(Path::new(exe));
    let exe = exe.to_string_lossy();
    let exe = exe.as_ref();
    let existed = settings_path.exists();
    let mut root = read_json(settings_path)?.unwrap_or_else(|| serde_json::json!({}));
    let obj = root.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{} is not a JSON object (expected settings object)",
            settings_path.display()
        )
    })?;
    let created_hooks = !obj.contains_key("hooks");
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{}: \"hooks\" is not a JSON object",
            settings_path.display()
        )
    })?;
    for event in hook_events() {
        let arr = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let arr = arr
            .as_array_mut()
            .ok_or_else(|| anyhow!("{}: hooks.{event} is not an array", settings_path.display()))?;
        arr.retain(|g| !group_is_ours(g, sentinel));
        arr.push(tr_hook_group(exe, event, sentinel));
    }
    write_json(settings_path, &root)?;
    Ok(HooksInstall {
        created_file: !existed,
        created_hooks,
    })
}

pub fn remove(
    settings_path: &Path,
    created_file: bool,
    created_hooks: bool,
    sentinel: &str,
) -> Result<()> {
    let Some(mut root) = read_json(settings_path)? else {
        return Ok(());
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            if let Some(arr) = hooks.get_mut(&event).and_then(|v| v.as_array_mut()) {
                arr.retain(|g| !group_is_ours(g, sentinel));
                if arr.is_empty() {
                    hooks.remove(&event);
                }
            }
        }
    }
    let hooks_empty = obj
        .get("hooks")
        .and_then(|h| h.as_object())
        .map(|h| h.is_empty())
        .unwrap_or(false);
    if hooks_empty && created_hooks {
        obj.remove("hooks");
    }
    if created_file && obj.is_empty() {
        if settings_path.exists() {
            std::fs::remove_file(settings_path)
                .with_context(|| format!("removing {}", settings_path.display()))?;
        }
        return Ok(());
    }
    write_json(settings_path, &root)
}

fn another_channels_launcher(argv0: Option<&Path>, config_dir: Option<&Path>) -> Option<String> {
    let (argv0, config_dir) = (argv0?, config_dir?);
    let launcher_state_dir = argv0
        .parent()
        .filter(|bin| bin.file_name().is_some_and(|n| n == "bin"))?
        .parent()?;
    let is_channel_dir = launcher_state_dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| {
            n == crate::paths::BASE_DIR || n.starts_with(&format!("{}-", crate::paths::BASE_DIR))
        });
    if !is_channel_dir || launcher_state_dir == config_dir {
        return None;
    }
    Some(format!(
        "launcher {} belongs to another channel than this pane's {} — its own channel's \
         launcher in this workspace's hooks file covers the event; standing down",
        launcher_state_dir.display(),
        config_dir.display()
    ))
}

pub fn run_hook_client(args: &[String]) {
    let Some(event) = args.get(2) else {
        return;
    };
    let agent = args
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| args.get(i + 1))
        .cloned();
    if agent.is_none() && std::env::var("GROK_SESSION_ID").is_ok() {
        eprintln!(
            "hook {event}: GROK_SESSION_ID is set on the Claude path — Grok fired this \
             workspace's Claude hooks too; the Grok-side drop already covers it"
        );
        return;
    }
    if let Some(reason) = another_channels_launcher(
        args.first().map(Path::new),
        crate::paths::config_dir().ok().as_deref(),
    ) {
        eprintln!("hook {event}: {reason}");
        return;
    }
    let Some(session) = std::env::var("TR_SESSION")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };
    let ms = crate::hook_drop::now_ms();

    let provider = agent
        .as_deref()
        .and_then(|slug| crate::agent_hooks::provider_from_slug(slug).ok())
        .unwrap_or(proto::AgentKind::Claude);
    let input = read_stdin_payload(&mut std::io::stdin(), std::io::stdin().is_terminal());
    let payload = parse_hook_payload(&input, provider);

    let carries_prompt = crate::agent_events::AgentEvent::from_provider(provider, event)
        == Some(crate::agent_events::AgentEvent::PromptSubmitted)
        || (provider == proto::AgentKind::Codex && event == "notify");
    let prompt = carries_prompt
        .then_some(payload.prompt)
        .flatten()
        .map(|p| {
            p.chars()
                .take(crate::hook_drop::PROMPT_CAPTURE_CHARS)
                .collect::<String>()
        })
        .filter(|p| !p.trim().is_empty());
    let turn_ended = crate::agent_events::AgentEvent::from_provider(provider, event)
        == Some(crate::agent_events::AgentEvent::TurnEnded);
    let mut stop_continued = false;
    if turn_ended {
        if crate::orchestrate::door2_continue_json(provider, "").is_some() {
            if payload.stop_hook_active {
                eprintln!(
                    "hook {event}: stop_hook_active for session {session} — logged, not relied on"
                );
            }
            stop_continued = stop_hook_try_continue(session, provider);
        } else {
            eprintln!(
                "hook {event}: provider {provider:?} has no verified stop-hook continue shape — \
                 door 3 carries its rows"
            );
        }
    }
    let antigravity_last_message = (provider == proto::AgentKind::Antigravity && event == "Stop")
        .then_some(payload.transcript_path.as_deref())
        .flatten()
        .and_then(crate::antigravity_transcript::antigravity_last_message_from_transcript);
    let drop = crate::hook_drop::HookDrop {
        v: crate::hook_drop::DROP_V,
        event: event.clone(),
        session,
        cwd: payload.cwd,
        agent: agent.clone(),
        prompt,
        last_message: antigravity_last_message.or(payload.last_message),
        background_tasks: payload.background_tasks,
        internal_prompt: payload.internal_prompt,
        reason: payload.reason,
        notification_type: payload.notification_type,
        stop_hook_active: payload.stop_hook_active,
        prompt_id: payload.prompt_id,
        pending_task_ids: payload.pending_task_ids,
        task_id: payload.task_id,
        agent_id: payload.agent_id,
        tool_use_id: payload.tool_use_id,
        stop_continued,
        session_id: payload.session_id,
        fully_idle: payload.fully_idle,
        tool_name: payload.tool_name,
    };
    let root = crate::paths::config_dir();
    let drop_dir = match &root {
        Ok(root) => Some(crate::hook_drop::drop_dir(root)),
        Err(e) => {
            eprintln!(
                "hook {event}: resolving the drop directory root for session {session}: {e:#} — \
                 this event's status transition is lost"
            );
            None
        }
    };
    if let Some(dir) = &drop_dir {
        if let Err(e) = crate::hook_drop::write_drop(dir, &drop, ms) {
            eprintln!(
                "hook {event}: writing the drop file for session {session} into {}: {e:#} — \
                 this event's status transition is lost",
                dir.display()
            );
        }
    }
}

fn stop_hook_try_continue(session: u32, provider: proto::AgentKind) -> bool {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(crate::orchestrate::STOP_INBOX_QUERY_MS);
    let base = match crate::orchestrate::cli_base_url(
        std::env::var(crate::mcp_launch::URL_ENV).ok().as_deref(),
    ) {
        Ok(base) => base,
        Err(e) => {
            eprintln!(
                "hook Stop: no daemon endpoint for session {session}: {e:#} — ending the turn"
            );
            return false;
        }
    };
    let token = match std::env::var(crate::mcp_launch::CODEX_TOKEN_ENV) {
        Ok(token) if !token.trim().is_empty() => token,
        _ => {
            eprintln!("hook Stop: no pane credential for session {session} — ending the turn");
            return false;
        }
    };
    let empty = serde_json::json!({});
    let (status, text) = match crate::orchestrate::http_json_deadline(
        &base,
        "POST",
        "/inbox/reserve",
        &token,
        Some(&empty),
        deadline,
    ) {
        Ok(reply) => reply,
        Err(e) => {
            eprintln!("hook Stop: reserving rows for session {session}: {e:#} — ending the turn");
            return false;
        }
    };
    if status != 200 {
        eprintln!("hook Stop: reserving rows for session {session} answered {status}: {text} — ending the turn");
        return false;
    }
    let reserved: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("hook Stop: the reserve reply for session {session} does not parse: {e} — ending the turn");
            return false;
        }
    };
    if reserved
        .get("rows")
        .and_then(|r| r.as_array())
        .is_none_or(|rows| rows.is_empty())
    {
        if reserved.get("capped").and_then(|c| c.as_bool()) == Some(true) {
            eprintln!(
                "hook Stop: session {session} spent its block budget ({} of {}) — ending the turn",
                reserved.get("blocks").and_then(|b| b.as_u64()).unwrap_or(0),
                reserved.get("limit").and_then(|l| l.as_u64()).unwrap_or(0),
            );
        }
        return false;
    }
    let (Some(delivery_id), Some(expires_at), Some(text)) = (
        reserved.get("delivery_id").and_then(|d| d.as_str()),
        reserved.get("expires_at").and_then(|e| e.as_u64()),
        reserved.get("text").and_then(|t| t.as_str()),
    ) else {
        eprintln!("hook Stop: the reserve reply for session {session} names no delivery — ending the turn");
        return false;
    };
    if crate::hook_drop::now_ms() >= expires_at {
        eprintln!(
            "hook Stop: reservation {delivery_id} for session {session} lapsed before stdout — \
             ending the turn"
        );
        return false;
    }
    let Some(continue_json) = crate::orchestrate::door2_continue_json(provider, text) else {
        return false;
    };
    print!("{continue_json}");
    {
        use std::io::Write as _;
        if let Err(e) = std::io::stdout().flush() {
            eprintln!("hook Stop: flushing the block for session {session}: {e} — ending the turn");
            return false;
        }
    }
    let confirm = serde_json::json!({ "delivery_id": delivery_id });
    if let Err(e) = crate::orchestrate::http_json_deadline(
        &base,
        "POST",
        "/inbox/delivered",
        &token,
        Some(&confirm),
        deadline,
    ) {
        eprintln!(
            "hook Stop: confirming reservation {delivery_id} for session {session}: {e:#} — it \
             lapses and the row stays eligible"
        );
    }
    true
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct HookPayload {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub last_message: Option<String>,
    pub background_tasks: Option<u32>,
    pub pending_task_ids: Vec<String>,
    pub internal_prompt: bool,
    pub task_id: Option<String>,
    pub reason: Option<String>,
    pub notification_type: Option<String>,
    pub stop_hook_active: bool,
    pub prompt_id: Option<String>,
    pub agent_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub fully_idle: Option<bool>,
    pub tool_name: Option<String>,
    pub transcript_path: Option<String>,
}

const TASK_NOTIFICATION_TAG: &str = "<task-notification>";

const TASK_ID_OPEN: &str = "<task-id>";
const TASK_ID_CLOSE: &str = "</task-id>";

fn first_task_id(prompt: &str) -> Option<String> {
    let start = prompt.find(TASK_ID_OPEN)? + TASK_ID_OPEN.len();
    let rest = &prompt[start..];
    let end = rest.find(TASK_ID_CLOSE)?;
    let id = rest[..end].trim();
    (!id.is_empty()).then(|| id.to_string())
}

// A TTY stdin must yield empty WITHOUT touching the fd: OpenCode's plugin can
// leak the TUI's PTY in, and an unconditional read camps in n_tty_read stealing
// keystrokes/mouse bytes from the agent.
fn read_stdin_payload<R: Read>(reader: &mut R, is_tty: bool) -> String {
    if is_tty {
        return String::new();
    }
    let mut input = String::new();
    let _ = reader.read_to_string(&mut input);
    input
}

pub(crate) fn parse_hook_payload(input: &str, provider: proto::AgentKind) -> HookPayload {
    let parsed = serde_json::from_str::<serde_json::Value>(input).ok();
    let field = |key: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    let grok_field = |snake: &str, camel: &str| {
        field(snake).or_else(|| {
            (provider == proto::AgentKind::Grok)
                .then(|| field(camel))
                .flatten()
        })
    };
    let field_bool = |key: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_bool())
    };
    let grok_bool = |snake: &str, camel: &str| {
        field_bool(snake).or_else(|| {
            (provider == proto::AgentKind::Grok)
                .then(|| field_bool(camel))
                .flatten()
        })
    };
    let input_message = parsed
        .as_ref()
        .and_then(|v| v.get("input-messages"))
        .and_then(|v| v.as_array())
        .and_then(|messages| messages.first())
        .and_then(|v| v.as_str())
        .map(String::from);
    let clean = |v: Option<String>| v.map(|s| crate::sanitize::redact_secrets(&s).0);
    let background = parsed
        .as_ref()
        .and_then(|v| v.get("background_tasks"))
        .and_then(|v| v.as_array());
    let prompt = field("prompt").or(input_message);
    let internal_prompt = prompt
        .as_deref()
        .is_some_and(|p| p.trim_start().starts_with(TASK_NOTIFICATION_TAG));
    let tool_call = parsed.as_ref().and_then(|v| v.get("toolCall"));
    let tool_name = tool_call
        .and_then(|t| t.get("name"))
        .and_then(|v| v.as_str());
    let questions = tool_call
        .and_then(|t| t.get("args"))
        .and_then(|a| a.get("questions"))
        .and_then(|q| q.as_array())
        .map(|qs| {
            qs.iter()
                .filter_map(|q| q.get("question").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|s| !s.is_empty());
    let step_idx = parsed
        .as_ref()
        .and_then(|v| v.get("stepIdx"))
        .and_then(|v| v.as_i64());
    HookPayload {
        session_id: field("session_id")
            .or_else(|| field("sessionId"))
            .or_else(|| field("conversation_id"))
            .or_else(|| {
                (provider == proto::AgentKind::Antigravity)
                    .then(|| field("conversationId"))
                    .flatten()
            }),
        cwd: field("cwd"),
        last_message: clean(
            grok_field("last_assistant_message", "lastAssistantMessage")
                .or_else(|| {
                    (provider == proto::AgentKind::Cursor)
                        .then(|| field("text"))
                        .flatten()
                })
                .map(|m| crate::orchestrate::cap_submit_body(&m)),
        ),
        background_tasks: background.map(|a| a.len() as u32),
        pending_task_ids: background
            .map(|entries| {
                entries
                    .iter()
                    .filter(|e| {
                        e.get("type").and_then(|v| v.as_str()) == Some("subagent")
                            && e.get("status").and_then(|v| v.as_str()) == Some("running")
                    })
                    .filter_map(|e| e.get("id").and_then(|v| v.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        task_id: prompt.as_deref().and_then(first_task_id),
        internal_prompt,
        reason: clean(
            grok_field("tool_name", "toolName")
                .or_else(|| field("message"))
                .or_else(|| {
                    (provider == proto::AgentKind::Antigravity)
                        .then(|| questions.clone())
                        .flatten()
                }),
        ),
        notification_type: grok_field("notification_type", "notificationType"),
        stop_hook_active: grok_bool("stop_hook_active", "stopHookActive").unwrap_or(false),
        prompt_id: grok_field("prompt_id", "promptId").or_else(|| field("turn_id")),
        agent_id: grok_field("agent_id", "agentId"),
        tool_use_id: grok_field("tool_use_id", "toolUseId").or_else(|| {
            (provider == proto::AgentKind::Antigravity)
                .then(|| step_idx.map(|n| n.to_string()))
                .flatten()
        }),
        fully_idle: field_bool("fullyIdle"),
        tool_name: tool_name.map(String::from),
        transcript_path: field("transcriptPath"),
        prompt: clean(prompt),
    }
}

fn read_json(path: &Path) -> Result<Option<serde_json::Value>> {
    match std::fs::read_to_string(path) {
        Ok(c) => {
            let v = serde_json::from_str(&c)
                .with_context(|| format!("parsing {} as JSON", path.display()))?;
            Ok(Some(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

fn write_json(path: &Path, v: &serde_json::Value) -> Result<()> {
    let mut text = serde_json::to_string_pretty(v)?;
    text.push('\n');
    atomic_write(path, &text)
}

// Write-then-rename: a crash mid-write must not leave the user's
// `settings.local.json` truncated where the next parse would reject it.
fn atomic_write(path: &Path, content: &str) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension(format!(
        "tr-tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, content).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} into place", tmp.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    #[test]
    fn a_launcher_under_another_channels_state_dir_stands_down() {
        let reason = another_channels_launcher(
            Some(Path::new("/h/.houston/bin/claude-hook")),
            Some(Path::new("/h/.houston-dev")),
        )
        .expect("the release launcher is not the dev pane's");
        assert!(
            reason.contains("/h/.houston") && reason.contains("/h/.houston-dev"),
            "{reason}"
        );
        assert!(
            another_channels_launcher(
                Some(Path::new("/h/.houston-dev/bin/claude-hook")),
                Some(Path::new("/h/.houston")),
            )
            .is_some(),
            "and the dev launcher is not the release pane's"
        );
    }

    #[test]
    fn the_panes_own_launcher_and_a_bare_binary_both_run() {
        assert_eq!(
            another_channels_launcher(
                Some(Path::new("/h/.houston-dev/bin/claude-hook")),
                Some(Path::new("/h/.houston-dev")),
            ),
            None,
            "same channel"
        );
        assert_eq!(
            another_channels_launcher(
                Some(Path::new("/repo/target/debug/houston-core")),
                Some(Path::new("/h/.houston-dev")),
            ),
            None,
            "not a channel launcher at all: a test or a shell ran the binary directly"
        );
        assert_eq!(
            another_channels_launcher(Some(Path::new("/h/.houston/bin/claude-hook")), None),
            None,
            "an unknown channel is not a positive match"
        );
    }

    const EXE: &str = "/opt/houston/houston-core";
    fn rel() -> String {
        sentinel_for(None)
    }

    fn exe_fixture() -> PathBuf {
        #[cfg(unix)]
        return PathBuf::from(EXE);
        #[cfg(windows)]
        {
            let p = std::env::temp_dir().join("tr-claude-hooks-exe-fixture");
            if !p.exists() {
                std::fs::write(&p, b"fixture\r\n").unwrap();
            }
            p
        }
    }

    struct MustNotRead;
    impl Read for MustNotRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("a TTY stdin must never be read — this read would steal the user's input");
        }
    }

    #[test]
    fn a_tty_stdin_is_never_read() {
        assert_eq!(read_stdin_payload(&mut MustNotRead, true), "");
    }

    #[test]
    fn a_piped_stdin_still_delivers_the_payload() {
        let mut piped = std::io::Cursor::new(r#"{"cwd":"/tmp"}"#);
        assert_eq!(read_stdin_payload(&mut piped, false), r#"{"cwd":"/tmp"}"#);
    }

    #[test]
    fn install_creates_all_events_and_removal_deletes_a_tr_created_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = settings_path(tmp.path());

        let install = install(&path, EXE, &rel()).unwrap();
        assert!(install.created_file, "file did not exist before");
        assert!(install.created_hooks, "hooks object did not exist before");

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for event in hook_events() {
            let group = &v["hooks"][event][0];
            let cmd = group["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains("hook"), "{event} command wired to the client");
            assert!(cmd.contains(event), "{event} command names its event");
            assert!(
                command_has_sentinel(cmd, &rel()),
                "{event} carries the removal marker"
            );
            let expect_async = !matches!(event, "UserPromptSubmit" | "Stop" | "StopFailure");
            assert_eq!(
                group["hooks"][0]["async"], expect_async,
                "{event} async posture"
            );
        }

        remove(&path, install.created_file, install.created_hooks, &rel()).unwrap();
        assert!(
            !path.exists(),
            "a file Houston created is removed with its hooks"
        );
    }

    #[test]
    fn the_installer_registers_the_status_events_and_the_correlation_ones() {
        assert_eq!(
            hook_events(),
            vec![
                "SessionStart",
                "UserPromptSubmit",
                "Stop",
                "StopFailure",
                "Notification",
                "PermissionRequest",
                "SubagentStart",
                "SubagentStop",
            ]
        );
    }

    #[test]
    fn install_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = settings_path(tmp.path());
        install(&path, EXE, &rel()).unwrap();
        let once = std::fs::read_to_string(&path).unwrap();
        install(&path, EXE, &rel()).unwrap();
        let twice = std::fs::read_to_string(&path).unwrap();
        assert_eq!(once, twice, "re-install must not duplicate our groups");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        for event in hook_events() {
            assert_eq!(
                v["hooks"][event].as_array().unwrap().len(),
                1,
                "exactly one {event} group after two installs"
            );
        }
    }

    #[test]
    fn install_strips_the_linux_deleted_exe_suffix() {
        let tmp = tempfile::tempdir().unwrap();
        let path = settings_path(tmp.path());
        install(&path, &format!("{EXE} (deleted)"), &rel()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for event in hook_events() {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(
                !cmd.contains(" (deleted)"),
                "{event} baked the dangling path: {cmd}"
            );
            assert!(cmd.contains(EXE), "{event} lost the exe path: {cmd}");
        }
    }

    #[test]
    fn a_users_own_hooks_survive_install_and_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let path = settings_path(tmp.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{
              "theme": "dark",
              "hooks": {
                "Stop": [ { "hooks": [ { "type": "command", "command": "echo mine" } ] } ]
              }
            }"#,
        )
        .unwrap();

        let install = install(&path, EXE, &rel()).unwrap();
        assert!(
            !install.created_file && !install.created_hooks,
            "both preexisted"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user's Stop hook kept, ours appended");

        remove(&path, install.created_file, install.created_hooks, &rel()).unwrap();
        assert!(path.exists(), "a file Houston did not create stays");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark", "unrelated settings preserved");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "only Houston's group removed");
        assert_eq!(stop[0]["hooks"][0]["command"], "echo mine");
        assert!(
            v["hooks"].get("SessionStart").is_none(),
            "Houston-only event key removed on uninstall"
        );
    }

    #[test]
    fn group_is_ours_matches_only_tr_commands() {
        let ours = tr_hook_group(EXE, "Stop", &rel());
        assert!(group_is_ours(&ours, &rel()));
        let theirs = serde_json::json!({
            "hooks": [ { "type": "command", "command": "echo mine" } ]
        });
        assert!(!group_is_ours(&theirs, &rel()));
    }

    #[test]
    fn a_channel_sentinel_is_never_matched_by_another_channels() {
        let rel = sentinel_for(None);
        let dev = sentinel_for(Some("dev"));
        assert_eq!(rel, "--houston-managed");
        assert_eq!(dev, "--houston-managed=dev");

        let rel_cmd = hook_command(EXE, "Stop", &rel);
        let dev_cmd = hook_command(EXE, "Stop", &dev);
        assert!(command_has_sentinel(&rel_cmd, &rel));
        assert!(command_has_sentinel(&dev_cmd, &dev));
        assert!(
            !command_has_sentinel(&dev_cmd, &rel),
            "release must not claim dev's command (the substring trap)"
        );
        assert!(
            !command_has_sentinel(&rel_cmd, &dev),
            "dev must not claim release's command"
        );
    }

    #[test]
    fn two_channels_coexist_and_do_not_evict_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let path = settings_path(tmp.path());
        let rel = sentinel_for(None);
        let dev = sentinel_for(Some("dev"));

        let rel_install = install(&path, EXE, &rel).unwrap();
        install(&path, "/repo/core/target/debug/houston-core", &dev).unwrap();

        let groups = |p: &std::path::Path| -> Vec<String> {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
            v["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["hooks"][0]["command"].as_str().unwrap().to_string())
                .collect()
        };
        let after_both = groups(&path);
        assert_eq!(after_both.len(), 2, "one group per channel: {after_both:?}");

        install(&path, EXE, &rel).unwrap();
        let after_refresh = groups(&path);
        assert_eq!(
            after_refresh.len(),
            2,
            "release re-install kept dev's group: {after_refresh:?}"
        );
        assert!(
            after_refresh.iter().any(|c| command_has_sentinel(c, &dev)),
            "dev's group survived a release refresh"
        );

        remove(
            &path,
            rel_install.created_file,
            rel_install.created_hooks,
            &rel,
        )
        .unwrap();
        assert!(path.exists(), "dev still has hooks here, so the file stays");
        let after_remove = groups(&path);
        assert_eq!(after_remove.len(), 1, "only release's group removed");
        assert!(command_has_sentinel(&after_remove[0], &dev));
    }

    #[test]
    fn shell_quote_escapes_embedded_quotes() {
        assert_eq!(shell_quote("/a/b"), "'/a/b'");
        assert_eq!(shell_quote("/a b/c"), "'/a b/c'");
        assert_eq!(shell_quote("/a'b"), "'/a'\\''b'");
    }

    #[cfg(unix)]
    fn fake_exe(path: &Path, tag: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\necho \"{tag} $*\"\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    const ETXTBSY_MAX_RETRIES: u32 = 5;

    #[cfg(unix)]
    fn spawn_retrying_etxtbsy(
        cmd: &mut std::process::Command,
    ) -> std::io::Result<std::process::Child> {
        for attempt in 0..=ETXTBSY_MAX_RETRIES {
            match cmd.spawn() {
                Err(e) if e.raw_os_error() == Some(26) && attempt < ETXTBSY_MAX_RETRIES => {
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
                }
                Err(e) if e.raw_os_error() == Some(26) => panic!(
                    "exec of a just-written fake binary: ETXTBSY persisted past \
                     ETXTBSY_MAX_RETRIES={ETXTBSY_MAX_RETRIES} (documented harness race, \
                     docs/internals/testing.md 'Reading a failure') — giving up: {e}"
                ),
                other => return other,
            }
        }
        unreachable!("loop above always returns or panics")
    }

    #[cfg(unix)]
    fn run(path: &Path, args: &[&str]) -> String {
        let mut cmd = std::process::Command::new(path);
        cmd.args(args).stdout(std::process::Stdio::piped());
        let out = spawn_retrying_etxtbsy(&mut cmd)
            .unwrap()
            .wait_with_output()
            .unwrap();
        assert!(out.status.success(), "{path:?} failed: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_command_whose_launcher_is_gone_exits_quietly() {
        let state = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let real = bin.path().join("houston-tauri");
        fake_exe(&real, "HOOK-RAN");
        let launcher = point_launcher(state.path(), &real).unwrap();
        let cmd = hook_command(
            &launcher.display().to_string(),
            "UserPromptSubmit",
            &sentinel_for(Some("dev")),
        );

        let sh = |command: &str| {
            std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .output()
                .unwrap()
        };

        let present = sh(&cmd);
        assert!(
            present.status.success(),
            "a healthy channel's hook must still run: {present:?}"
        );
        assert!(
            String::from_utf8_lossy(&present.stdout).contains("HOOK-RAN"),
            "and must actually reach the binary: {present:?}"
        );

        std::fs::remove_file(&real).unwrap();
        let gone = sh(&cmd);
        assert!(
            gone.status.success(),
            "a missing launcher must exit 0, not {:?}",
            gone.status
        );
        assert!(
            gone.stderr.is_empty(),
            "and say nothing Claude could show as a hook error: {}",
            String::from_utf8_lossy(&gone.stderr)
        );
        assert!(
            gone.stdout.is_empty(),
            "nor anything Claude could splice into the prompt: {}",
            String::from_utf8_lossy(&gone.stdout)
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_baked_command_names_the_launcher_not_the_binary() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let path = settings_path(ws.path());
        let launcher = point_launcher(state.path(), Path::new(EXE)).unwrap();
        assert_eq!(launcher, launcher_path(state.path()));

        let dev = sentinel_for(Some("dev"));
        install(&path, &launcher.display().to_string(), &dev).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for event in hook_events() {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(
                cmd.contains(&launcher.display().to_string()),
                "{event} must name the launcher: {cmd}"
            );
            assert!(
                !cmd.contains(EXE),
                "{event} baked the binary path — the whole staleness bug: {cmd}"
            );
            assert!(
                command_has_sentinel(cmd, &dev),
                "{event} lost the channel-tagged sentinel: {cmd}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_launcher_survives_a_rebuild_in_place_of_its_target() {
        let state = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let target = target_dir.path().join("houston-core");
        fake_exe(&target, "V1");

        let launcher = point_launcher(
            state.path(),
            Path::new(&format!("{} (deleted)", target.display())),
        )
        .unwrap();
        assert_eq!(run(&launcher, &["hook", "Stop"]), "V1 hook Stop");

        std::fs::remove_file(&target).unwrap();
        fake_exe(&target, "V2");
        assert_eq!(
            run(&launcher, &["hook", "Stop"]),
            "V2 hook Stop",
            "a rebuild-in-place must reach the new binary through the same path"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacing_the_launcher_never_disturbs_a_hook_running_through_it() {
        let state = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let slow = dir.path().join("slow");
        std::fs::create_dir_all(slow.parent().unwrap()).unwrap();
        let go = dir.path().join("go");
        std::fs::write(
            &slow,
            format!(
                "#!/bin/sh\necho STARTED\nwhile [ ! -e {} ]; do :; done\necho SLOW-DONE\n",
                shell_quote(&go.display().to_string())
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let fast = dir.path().join("fast");
        fake_exe(&fast, "FAST");

        let launcher = point_launcher(state.path(), &slow).unwrap();
        let mut cmd = std::process::Command::new(&launcher);
        cmd.stdout(std::process::Stdio::piped());
        let mut child = spawn_retrying_etxtbsy(&mut cmd).unwrap();
        let mut started = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.as_mut().unwrap()),
            &mut started,
        )
        .unwrap();
        assert_eq!(started.trim(), "STARTED");
        point_launcher(state.path(), &fast).unwrap();
        std::fs::write(&go, "").unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "the in-flight hook died: {out:?}");
        assert_eq!(
            String::from_utf8(out.stdout).unwrap().trim(),
            "SLOW-DONE",
            "an in-flight hook must finish on the binary it exec'd"
        );
        assert_eq!(
            run(&launcher, &["x"]),
            "FAST x",
            "and the next one is repointed"
        );

        const ROUNDS: usize = 200;
        let watching = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let misses = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watcher = std::thread::spawn({
            let (path, watching, misses) = (launcher.clone(), watching.clone(), misses.clone());
            move || {
                while watching.load(std::sync::atomic::Ordering::Relaxed) {
                    if std::fs::symlink_metadata(&path).is_err() {
                        misses.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        });
        for i in 0..ROUNDS {
            point_launcher(state.path(), if i % 2 == 0 { &slow } else { &fast }).unwrap();
        }
        watching.store(false, std::sync::atomic::Ordering::Relaxed);
        watcher.join().unwrap();
        assert_eq!(
            misses.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "the launcher vanished during {ROUNDS} repoints — a hook exec'ing then gets ENOENT"
        );
        assert_eq!(run(&launcher, &["z"]), "FAST z");
    }

    #[cfg(unix)]
    #[test]
    fn dev_and_release_launchers_are_independent() {
        let home = tempfile::tempdir().unwrap();
        let rel_state = crate::paths::dir_for(home.path(), None);
        let dev_state = crate::paths::dir_for(home.path(), Some("dev"));
        let bins = tempfile::tempdir().unwrap();
        let rel_exe = bins.path().join("installed/houston-core");
        let dev_exe = bins.path().join("debug/houston-core");
        fake_exe(&rel_exe, "RELEASE");
        fake_exe(&dev_exe, "DEV");

        let rel_launcher = point_launcher(&rel_state, &rel_exe).unwrap();
        let dev_launcher = point_launcher(&dev_state, &dev_exe).unwrap();
        assert_ne!(rel_launcher, dev_launcher);
        assert_eq!(run(&rel_launcher, &[]), "RELEASE");
        assert_eq!(run(&dev_launcher, &[]), "DEV");

        point_launcher(&dev_state, &dev_exe).unwrap();
        assert_eq!(
            run(&rel_launcher, &[]),
            "RELEASE",
            "a dev boot must not repoint the installed app's launcher"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_launcher_dir_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let state = tempfile::tempdir().unwrap();
        point_launcher(state.path(), Path::new(EXE)).unwrap();
        let mode = std::fs::metadata(launcher_dir(state.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "launcher dir mode");
    }

    #[cfg(unix)]
    #[test]
    fn point_launcher_refuses_to_chmod_through_a_symlinked_bin_dir() {
        use std::os::unix::fs::PermissionsExt;
        let state = tempfile::tempdir().unwrap();
        let victim = tempfile::tempdir().unwrap();
        std::fs::set_permissions(victim.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(victim.path(), launcher_dir(state.path())).unwrap();

        let err = point_launcher(state.path(), Path::new(EXE)).unwrap_err();
        assert!(
            err.to_string().contains("symlink") && err.to_string().contains("refusing"),
            "error must name the path and what it actually is: {err}"
        );
        let victim_mode = std::fs::metadata(victim.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            victim_mode, 0o755,
            "the symlink target's mode must be untouched"
        );
    }

    #[test]
    fn point_launcher_sweeps_only_tmp_residue_from_dead_writers() {
        let state = tempfile::tempdir().unwrap();
        point_launcher(state.path(), &exe_fixture()).unwrap();
        let dir = launcher_dir(state.path());

        const DEAD_PID_ATTEMPTS: u32 = 8;
        let mut dead_pid = None;
        for _ in 0..DEAD_PID_ATTEMPTS {
            #[cfg(unix)]
            let mut child = std::process::Command::new("true").spawn().unwrap();
            #[cfg(windows)]
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "exit 0"])
                .spawn()
                .unwrap();
            let pid = child.id();
            child.wait().unwrap();
            drop(child);
            if !crate::pid::process_is_alive(pid) {
                dead_pid = Some(pid);
                break;
            }
        }
        let dead_pid = dead_pid.unwrap_or_else(|| {
            panic!(
                "could not obtain a provably-dead pid in {DEAD_PID_ATTEMPTS} attempts: \
                 every reaped child's pid still read as alive, which means pid recycling \
                 on this host is far more aggressive than one recycle in {DEAD_PID_ATTEMPTS} \
                 - that is a real finding, not a flake to retry harder"
            )
        });

        let stale = dir.join(format!("{LAUNCHER_NAME}.tr-tmp.{dead_pid}.{}", u64::MAX));
        std::fs::write(&stale, "").unwrap();
        let live_pid = std::process::id();
        let in_flight = dir.join(format!(
            "{LAUNCHER_NAME}.tr-tmp.{live_pid}.{}",
            u64::MAX - 1
        ));
        std::fs::write(&in_flight, "").unwrap();

        point_launcher(state.path(), &exe_fixture()).unwrap();

        assert!(!stale.exists(), "residue from a dead writer must be swept");
        assert!(
            in_flight.exists(),
            "a tmp file whose writer (this process) is still alive must survive the sweep"
        );
    }

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/hooks/claude")
            .join(format!("claude-2.1.263-{name}.json"));
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading the fixture {}: {e}", path.display()))
    }

    #[test]
    fn the_park_stop_looks_exactly_like_a_finish() {
        let p = parse_hook_payload(&fixture("05-Stop"), proto::AgentKind::Claude);
        assert_eq!(p.background_tasks, Some(0));
        assert!(p.pending_task_ids.is_empty());
        assert_eq!(
            p.last_message.as_deref(),
            Some("Agent launched in background. Waiting for completion.")
        );
        assert!(!p.stop_hook_active);
        assert!(p.prompt_id.is_some());
    }

    #[test]
    fn a_subagent_stop_names_the_notification_the_cli_still_owes() {
        let p = parse_hook_payload(&fixture("04-SubagentStop"), proto::AgentKind::Claude);
        assert_eq!(p.agent_id.as_deref(), Some("a4c7bcb2117fa13c2"));
        assert_eq!(p.background_tasks, Some(1));
        assert_eq!(p.pending_task_ids, vec!["a4c7bcb2117fa13c2".to_string()]);
        assert_eq!(p.last_message.as_deref(), Some("ALPHA"));
    }

    #[test]
    fn the_internal_prompt_is_recognised_and_names_its_task() {
        let p = parse_hook_payload(&fixture("06-UserPromptSubmit"), proto::AgentKind::Claude);
        assert!(p.internal_prompt);
        assert_eq!(p.task_id.as_deref(), Some("a4c7bcb2117fa13c2"));

        let real = parse_hook_payload(&fixture("02-UserPromptSubmit"), proto::AgentKind::Claude);
        assert!(
            !real.internal_prompt,
            "an operator's prompt is not internal"
        );
        assert_eq!(real.task_id, None);
    }

    #[test]
    fn only_a_running_subagent_entry_is_a_pending_task() {
        let p = parse_hook_payload(
            r#"{"background_tasks":[
                 {"id":"sh-1","type":"shell","status":"running"},
                 {"id":"sub-1","type":"subagent","status":"running"},
                 {"id":"sub-2","type":"subagent","status":"completed"}]}"#,
            proto::AgentKind::Claude,
        );
        assert_eq!(p.background_tasks, Some(3), "the count is every entry");
        assert_eq!(
            p.pending_task_ids,
            vec!["sub-1".to_string()],
            "only a running sub-agent is owed a notification"
        );
    }

    #[test]
    fn a_block_reports_its_tool_and_falls_back_to_the_message() {
        let req = parse_hook_payload(&fixture("08-PermissionRequest"), proto::AgentKind::Claude);
        assert_eq!(req.reason.as_deref(), Some("Bash"));
        assert_eq!(
            req.tool_use_id.as_deref(),
            Some("toolu_01PermissionProbeBash01")
        );

        let note = parse_hook_payload(&fixture("09-Notification"), proto::AgentKind::Claude);
        assert_eq!(note.notification_type.as_deref(), Some("permission_prompt"));
        assert_eq!(
            note.reason.as_deref(),
            Some("Claude needs your permission to use Bash")
        );
        assert_eq!(
            note.prompt_id, req.prompt_id,
            "both hooks belong to the same request"
        );

        let idle = parse_hook_payload(&fixture("10-Notification-idle"), proto::AgentKind::Claude);
        assert_eq!(idle.notification_type.as_deref(), Some("idle_prompt"));
    }

    #[test]
    fn a_secret_in_a_lifted_string_is_redacted_before_it_leaves_the_helper() {
        let p = parse_hook_payload(
            r#"{"last_assistant_message":"the token is ghp_0123456789abcdefghijklmnopqrstuvwxyz"}"#,
            proto::AgentKind::Claude,
        );
        let msg = p.last_message.expect("a last message");
        assert!(!msg.contains("ghp_0123456789"), "{msg}");
        assert!(msg.contains("[redacted:"), "{msg}");
    }

    #[test]
    fn a_long_last_message_is_capped_at_the_submit_cap() {
        let long = "x".repeat(crate::orchestrate::SUBMIT_BODY_MAX_CHARS + 500);
        let p = parse_hook_payload(
            &format!("{{\"last_assistant_message\":\"{long}\"}}"),
            proto::AgentKind::Claude,
        );
        let msg = p.last_message.expect("a last message");
        assert!(
            msg.chars().count() < crate::orchestrate::SUBMIT_BODY_MAX_CHARS + 500,
            "the cap did not apply: {} chars",
            msg.chars().count()
        );
        assert!(msg.contains(&crate::orchestrate::SUBMIT_BODY_MAX_CHARS.to_string()));
    }

    #[test]
    fn the_payload_lift_takes_cwd_alongside_the_fields_it_already_took() {
        let p = parse_hook_payload(
            r#"{"session_id":"abc","cwd":"/home/dev/proj","prompt":"review @core"}"#,
            proto::AgentKind::Claude,
        );
        assert_eq!(p.prompt.as_deref(), Some("review @core"));
        assert_eq!(p.cwd.as_deref(), Some("/home/dev/proj"));
        assert_eq!(p.session_id.as_deref(), Some("abc"));
    }

    #[test]
    fn a_missing_or_wrongly_typed_cwd_costs_only_that_field() {
        let none = parse_hook_payload(r#"{"session_id":"abc"}"#, proto::AgentKind::Claude);
        assert_eq!(none.cwd, None);
        assert_eq!(none.session_id.as_deref(), Some("abc"));

        let numeric = parse_hook_payload(
            r#"{"session_id":"abc","cwd":12345}"#,
            proto::AgentKind::Claude,
        );
        assert_eq!(
            numeric.cwd, None,
            "a non-string cwd is dropped, not coerced"
        );
        assert_eq!(numeric.session_id.as_deref(), Some("abc"));

        assert_eq!(
            parse_hook_payload("not json at all", proto::AgentKind::Claude),
            HookPayload::default()
        );
        assert_eq!(
            parse_hook_payload("", proto::AgentKind::Claude),
            HookPayload::default()
        );
    }

    #[test]
    fn grok_lifts_the_camel_case_twin_when_snake_case_is_absent() {
        let p = parse_hook_payload(
            r#"{"lastAssistantMessage":"PONG","stopHookActive":true,
                 "notificationType":"permission_prompt","toolName":"Bash",
                 "promptId":"req-1","agentId":"sub-1","toolUseId":"tu-1"}"#,
            proto::AgentKind::Grok,
        );
        assert_eq!(p.last_message.as_deref(), Some("PONG"));
        assert!(p.stop_hook_active);
        assert_eq!(p.notification_type.as_deref(), Some("permission_prompt"));
        assert_eq!(p.reason.as_deref(), Some("Bash"));
        assert_eq!(p.prompt_id.as_deref(), Some("req-1"));
        assert_eq!(p.agent_id.as_deref(), Some("sub-1"));
        assert_eq!(p.tool_use_id.as_deref(), Some("tu-1"));
    }

    #[test]
    fn a_non_grok_provider_never_gets_the_camel_case_fallback() {
        let p = parse_hook_payload(
            r#"{"lastAssistantMessage":"PONG","stopHookActive":true}"#,
            proto::AgentKind::Claude,
        );
        assert_eq!(p.last_message, None);
        assert!(!p.stop_hook_active);
    }

    #[test]
    fn cursor_lifts_last_message_from_its_own_text_field() {
        let p = parse_hook_payload(r#"{"text":"PONG"}"#, proto::AgentKind::Cursor);
        assert_eq!(p.last_message.as_deref(), Some("PONG"));
    }

    #[test]
    fn a_non_cursor_provider_never_gets_the_text_fallback() {
        let p = parse_hook_payload(r#"{"text":"PONG"}"#, proto::AgentKind::Claude);
        assert_eq!(p.last_message, None);
    }

    #[test]
    fn antigravity_lifts_conversation_id_into_session_id() {
        let p = parse_hook_payload(
            r#"{"conversationId":"conv-root-1","transcriptPath":"/tmp/t"}"#,
            proto::AgentKind::Antigravity,
        );
        assert_eq!(p.session_id.as_deref(), Some("conv-root-1"));
        assert_eq!(p.transcript_path.as_deref(), Some("/tmp/t"));
    }

    #[test]
    fn a_non_antigravity_provider_never_gets_the_conversation_id_fallback() {
        let p = parse_hook_payload(
            r#"{"conversationId":"conv-root-1"}"#,
            proto::AgentKind::Claude,
        );
        assert_eq!(p.session_id, None);
    }

    #[test]
    fn antigravity_lifts_fully_idle_on_stop() {
        let parked = parse_hook_payload(r#"{"fullyIdle":false}"#, proto::AgentKind::Antigravity);
        assert_eq!(parked.fully_idle, Some(false));
        let closed = parse_hook_payload(r#"{"fullyIdle":true}"#, proto::AgentKind::Antigravity);
        assert_eq!(closed.fully_idle, Some(true));
    }

    #[test]
    fn antigravity_lifts_the_ask_question_tool_call() {
        let p = parse_hook_payload(
            r#"{"stepIdx":3,"toolCall":{"name":"ask_question","args":{"questions":[
                 {"question":"Which branch?"}]}}}"#,
            proto::AgentKind::Antigravity,
        );
        assert_eq!(p.tool_name.as_deref(), Some("ask_question"));
        assert_eq!(p.reason.as_deref(), Some("Which branch?"));
        assert_eq!(p.tool_use_id.as_deref(), Some("3"));
    }

    #[test]
    fn antigravity_lifts_an_ordinary_tool_calls_name_too() {
        let p = parse_hook_payload(
            r#"{"stepIdx":1,"toolCall":{"name":"read_file","args":{}}}"#,
            proto::AgentKind::Antigravity,
        );
        assert_eq!(p.tool_name.as_deref(), Some("read_file"));
        assert_eq!(p.reason, None, "no questions array — nothing to join");
    }

    #[test]
    fn antigravity_joins_multiple_questions_into_one_reason() {
        let p = parse_hook_payload(
            r#"{"toolCall":{"name":"ask_custom_permission","args":{"questions":[
                 {"question":"Delete the file?"},{"question":"Also the backup?"}]}}}"#,
            proto::AgentKind::Antigravity,
        );
        assert_eq!(
            p.reason.as_deref(),
            Some("Delete the file?; Also the backup?")
        );
    }
}

#[cfg(test)]
mod sentinel_tests {
    use super::*;

    fn group_with(cmd: &str) -> serde_json::Value {
        serde_json::json!({ "hooks": [{ "type": "command", "command": cmd }] })
    }

    #[test]
    fn leaves_an_unmarked_group_alone() {
        let theirs = group_with("/usr/local/bin/my-own-hook --verbose");
        assert!(!group_is_ours(&theirs, &sentinel_for(None)));
        assert!(!group_is_ours(&theirs, &sentinel_for(Some("dev"))));
    }

    #[test]
    fn each_channel_owns_only_its_own_group() {
        let dev =
            group_with("'/home/u/.houston-dev/bin/claude-hook' hook Stop --houston-managed=dev");
        assert!(group_is_ours(&dev, &sentinel_for(Some("dev"))));
        assert!(!group_is_ours(&dev, &sentinel_for(None)));
    }

    #[test]
    fn spells_the_sentinel_per_channel() {
        assert_eq!(sentinel_for(None), "--houston-managed");
        assert_eq!(sentinel_for(Some("dev")), "--houston-managed=dev");
    }

    #[test]
    fn recognizes_a_superseded_command_without_claiming_a_live_or_foreign_one() {
        for cmd in [
            "'/home/u/.old-name/bin/claude-hook' hook Stop --old-name-managed",
            "'/home/u/.old-name-dev/bin/claude-hook' hook Stop --old-name-managed=dev",
            "'C:/Users/u/.old-name/bin/claude-hook' hook Stop --old-name-managed",
            "notify = [\"/home/u/.old-name/bin/claude-hook\", \"hook\", \"--old-name-managed\"]",
        ] {
            assert!(command_is_legacy_managed(cmd), "superseded: {cmd}");
        }
        for cmd in [
            "'/home/u/.houston/bin/claude-hook' hook Stop --houston-managed",
            "'/home/u/.houston-dev/bin/claude-hook' hook Stop --houston-managed=dev",
            "/opt/other/bin/other-hook run --other-managed",
            "'/home/u/.old-name/bin/claude-hook' hook Stop",
            "my-hook.sh --managed",
            "echo hello",
        ] {
            assert!(!command_is_legacy_managed(cmd), "not ours to remove: {cmd}");
        }
    }
}

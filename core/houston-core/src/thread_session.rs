//! A Claude session in thread view: `claude -p` with stream-json on pipes, not a PTY.
//! Stop ends the whole process tree (process group / Job object); the next message
//! resumes the conversation in a new process. See docs/internals/invariants.md.

use anyhow::{anyhow, bail, Context, Result};
use houston_protocol::{
    ApprovalDecision, ThreadEvent, ThreadEventKind, ThreadPermissionMode, TurnOutcome,
    THREAD_APPROVAL_INPUT_MAX_BYTES, THREAD_ASSISTANT_TEXT_MAX_BYTES, THREAD_TOOL_INPUT_MAX_BYTES,
    THREAD_TOOL_OUTPUT_MAX_BYTES, THREAD_USER_MESSAGE_MAX_BYTES,
};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;
#[cfg(any(target_os = "linux", windows))]
use std::time::Instant;

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

/// Houston's MCP tool that answers a thread's permission prompts (`--permission-prompt-tool`).
pub const PERMISSION_TOOL: &str = "thread_permission";
/// Held requests per session; each holds an MCP call open, so a loop cannot pile them up.
pub const APPROVALS_PENDING_MAX: usize = 16;
/// A tool name or tool use id above this is cut; real ones are a few dozen bytes.
const APPROVAL_NAME_MAX_BYTES: usize = 256;
/// The longest deny message Claude is told.
pub const APPROVAL_MESSAGE_MAX_BYTES: usize = 4 * 1024;

/// 30 `thread_events` messages a second per session at most.
pub const THREAD_EVENTS_MIN_INTERVAL: Duration = Duration::from_millis(34);
/// One stdout line above this is skipped whole, with a notice: a single tool result can
/// be megabytes, and at most 256 KiB of any event is kept anyway.
const STDOUT_LINE_MAX_BYTES: usize = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
/// Time a stopped Claude gets to exit on SIGTERM before its group is killed.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_millis(1000);
/// Bounds the system-wide thread snapshot walk that resumes a suspended Claude; it
/// normally takes milliseconds.
#[cfg(windows)]
const RESUME_TIMEOUT: Duration = Duration::from_secs(5);

/// What the daemon does with a thread's events. A trait so the backend runs in unit tests
/// without a daemon.
pub trait ThreadHost: Send + Sync + 'static {
    /// Called in `seq` order for every event except `AssistantDelta`.
    fn store(&self, session: u32, event: &ThreadEvent);
    fn broadcast(&self, session: u32, events: Vec<ThreadEvent>);
    /// The stream's `result` event ended a turn.
    fn turn_ended(&self, session: u32, outcome: TurnOutcome);
    /// Stop or an exit ended the process, so no turn is running any more.
    fn settle(&self, session: u32, outcome: TurnOutcome);
    /// A new Claude process leads the thread's process group.
    fn process_started(&self, session: u32, pid: u32);
    /// Stop, an exit or close ended the process tree, so nothing of it is left to reclaim.
    fn process_gone(&self, session: u32);
    /// Whether Houston now holds at least one unanswered permission request.
    fn approvals_pending(&self, session: u32, pending: bool);
    /// The stream reported a permission mode other than the recorded one.
    fn permission_mode_reported(&self, session: u32, mode: ThreadPermissionMode);
}

/// What `thread_approve` tells a held permission request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalAnswer {
    Allow,
    Deny(String),
}

struct PendingApproval {
    answer: tokio::sync::oneshot::Sender<ApprovalAnswer>,
}

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
#[derive(Clone, Debug)]
pub struct ThreadLaunch {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
    /// Taken out of `args`: a mode change restarts the process with other flags.
    pub permission_mode: ThreadPermissionMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conversation {
    /// `--session-id`: nothing has been sent in it yet.
    New(String),
    /// `--resume`: the conversation has at least one turn.
    Resume(String),
}

impl ThreadLaunch {
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
                program,
                args,
                env,
                cwd: cmd.get_cwd().map(PathBuf::from),
                permission_mode,
            },
            conversation,
        ))
    }

    fn command(
        &self,
        conversation: Option<&Conversation>,
        permission_mode: ThreadPermissionMode,
    ) -> std::process::Command {
        let mut command = crate::spawn::command(&self.program);
        command.args(&self.args);
        command.args(permission_mode_args(permission_mode));
        // Without Houston's MCP server the tool does not exist and Claude would refuse to start.
        if self.args.iter().any(|arg| arg == "--mcp-config") {
            command.args([
                "--permission-prompt-tool".to_string(),
                format!("mcp__{}__{PERMISSION_TOOL}", crate::mcp_server::SERVER_NAME),
            ]);
        }
        match conversation {
            Some(Conversation::New(id)) => {
                command.args(["--session-id", id]);
            }
            Some(Conversation::Resume(id)) => {
                command.args(["--resume", id]);
            }
            None => {}
        }
        command.args(THREAD_FLAGS);
        command.env_clear();
        command.envs(self.env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        command
    }
}

/// Cuts `text` to at most `max` bytes on a character boundary.
pub fn cap_text(mut text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

/// What one stdout line produced besides events.
#[derive(Debug, Default, PartialEq)]
pub struct Mapped {
    pub events: Vec<ThreadEventKind>,
    pub turn_end: Option<TurnOutcome>,
    pub conversation: Option<String>,
    pub permission_mode: Option<ThreadPermissionMode>,
}

/// Maps stream-json lines to thread events. One per process: block indices restart with it.
#[derive(Default)]
pub struct StreamMapper {
    open_text_block: HashMap<String, u64>,
}

impl StreamMapper {
    pub fn map_line(&mut self, line: &str) -> Mapped {
        let mut out = Mapped::default();
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

    fn map_stream_event(&mut self, value: &Value, out: &mut Mapped) {
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

    fn map_assistant(&mut self, value: &Value, out: &mut Mapped) {
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
                        summary: None,
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

fn map_tool_results(value: &Value, out: &mut Mapped) {
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

/// Merges adjacent deltas of one block so a burst becomes one entry with the later `seq`.
pub fn coalesce(events: Vec<ThreadEvent>) -> Vec<ThreadEvent> {
    let mut out: Vec<ThreadEvent> = Vec::with_capacity(events.len());
    for event in events {
        if let (
            Some(ThreadEvent {
                seq,
                kind:
                    ThreadEventKind::AssistantDelta {
                        message_id: last_id,
                        text: last_text,
                    },
                ..
            }),
            ThreadEventKind::AssistantDelta { message_id, text },
        ) = (out.last_mut(), &event.kind)
        {
            if last_id == message_id {
                last_text.push_str(text);
                *seq = event.seq;
                continue;
            }
        }
        out.push(event);
    }
    out
}

#[derive(Default)]
struct OutboxState {
    pending: Vec<ThreadEvent>,
    closed: bool,
}

/// Live events waiting for the next `thread_events` message.
#[derive(Default)]
struct Outbox {
    state: Mutex<OutboxState>,
    ready: Condvar,
}

impl Outbox {
    fn push(&self, events: Vec<ThreadEvent>) {
        let mut state = self.state.lock().expect("thread outbox lock");
        state.pending.extend(events);
        self.ready.notify_one();
    }

    fn close(&self) {
        self.state.lock().expect("thread outbox lock").closed = true;
        self.ready.notify_all();
    }

    /// Sends at most one message per interval until closed and drained.
    fn run(&self, session: u32, host: &dyn ThreadHost) {
        loop {
            let batch = {
                let mut state = self.state.lock().expect("thread outbox lock");
                while state.pending.is_empty() && !state.closed {
                    state = self.ready.wait(state).expect("thread outbox wait");
                }
                if state.pending.is_empty() {
                    return;
                }
                std::mem::take(&mut state.pending)
            };
            host.broadcast(session, coalesce(batch));
            std::thread::sleep(THREAD_EVENTS_MIN_INTERVAL);
        }
    }
}

struct Tail {
    bytes: Vec<u8>,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > STDERR_TAIL_BYTES {
            let cut = self.bytes.len() - STDERR_TAIL_BYTES;
            self.bytes.drain(..cut);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).trim().to_string()
    }
}

/// Assigns a suspended child, then resumes it, so nothing it starts escapes the job.
#[cfg(windows)]
fn adopt_suspended(job: &crate::pid::OwnedJob, child: &std::process::Child) -> Result<()> {
    job.assign(child)
        .with_context(|| format!("assigning Claude pid {} to its Job object", child.id()))?;
    crate::pid::resume_owned_child(child, Instant::now(), RESUME_TIMEOUT)
        .with_context(|| format!("resuming suspended Claude pid {}", child.id()))
}

/// One run of the Claude process. A Stop or a crash ends it; the handle starts the next.
struct ThreadProcess {
    generation: u64,
    pid: u32,
    child: Mutex<Option<std::process::Child>>,
    /// Held only by writers: ending the tree never waits for it, so a write blocked on a
    /// Claude that stopped reading cannot hold up Stop, Kill or shutdown.
    stdin: Mutex<Option<std::process::ChildStdin>>,
    stopping: AtomicBool,
    stderr: Arc<Mutex<Tail>>,
    #[cfg(windows)]
    job: crate::pid::OwnedJob,
}

impl ThreadProcess {
    fn spawn(
        launch: &ThreadLaunch,
        conversation: Option<&Conversation>,
        permission_mode: ThreadPermissionMode,
        generation: u64,
    ) -> Result<(
        Arc<Self>,
        std::process::ChildStdout,
        std::process::ChildStderr,
    )> {
        let mut command = launch.command(conversation, permission_mode);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let job = {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            crate::pid::OwnedJob::new().context("creating the thread's Job object")?
        };
        let mut child = command.spawn().with_context(|| {
            format!(
                "starting {} for a thread session (expected the claude CLI on PATH)",
                launch.program.to_string_lossy()
            )
        })?;
        #[cfg(windows)]
        if let Err(error) = adopt_suspended(&job, &child) {
            let _ = crate::pid::terminate_owned_child(&child);
            let _ = child.wait();
            return Err(error);
        }
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let process = Arc::new(Self {
            generation,
            pid: child.id(),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            stopping: AtomicBool::new(false),
            stderr: Arc::new(Mutex::new(Tail { bytes: Vec::new() })),
            #[cfg(windows)]
            job,
        });
        Ok((process, stdout, stderr))
    }

    fn write_line(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().expect("thread stdin lock");
        let pipe = stdin
            .as_mut()
            .ok_or_else(|| anyhow!("Claude pid {} has no open stdin", self.pid))?;
        pipe.write_all(line.as_bytes())
            .and_then(|()| pipe.write_all(b"\n"))
            .and_then(|()| pipe.flush())
            .with_context(|| format!("writing a message to Claude pid {}", self.pid))
    }

    /// Ends every process in the tree and reaps the root. Returns its exit code if known.
    fn end_tree(&self, graceful: bool) -> Option<i32> {
        let mut child = self.child.lock().expect("thread child lock").take()?;
        #[cfg(target_os = "linux")]
        {
            if graceful {
                let _ = crate::pid::signal_unreaped_child_group(&child, crate::pid::Signal::Term);
                let deadline = Instant::now() + STOP_GRACE;
                while Instant::now() < deadline
                    && !crate::pid::unreaped_child_exited(&child).unwrap_or(true)
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            if let Err(error) =
                crate::pid::signal_unreaped_child_group(&child, crate::pid::Signal::Kill)
            {
                tracing::warn!("ending thread process group {}: {error}", self.pid);
            }
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let _ = graceful;
            let _ = crate::pid::signal_process_group(child.id(), crate::pid::Signal::Kill);
        }
        #[cfg(windows)]
        {
            let _ = graceful;
            if let Err(error) = self.job.terminate() {
                tracing::warn!(
                    "terminating the Job object of thread pid {}: {error}",
                    self.pid
                );
                let _ = crate::pid::terminate_owned_child(&child);
            }
        }
        child.wait().ok().and_then(|status| status.code())
    }
}

struct HandleState {
    process: Option<Arc<ThreadProcess>>,
    conversation: Option<Conversation>,
    permission_mode: ThreadPermissionMode,
    generation: u64,
    /// A message was sent and its `result` has not arrived.
    turn_open: bool,
    closed: bool,
    close_cause: Option<String>,
    /// Text streamed for the open block whose final message has not arrived yet.
    partial: Option<(String, String)>,
}

impl HandleState {
    fn track_partial(&mut self, events: &[ThreadEventKind]) {
        for event in events {
            match event {
                ThreadEventKind::AssistantDelta { message_id, text } => match &mut self.partial {
                    Some((open, so_far)) if open == message_id => so_far.push_str(text),
                    _ => self.partial = Some((message_id.clone(), text.clone())),
                },
                ThreadEventKind::AssistantMessage { message_id, .. }
                    if self
                        .partial
                        .as_ref()
                        .is_some_and(|(open, _)| open == message_id) =>
                {
                    self.partial = None
                }
                ThreadEventKind::TurnEnd { .. } => self.partial = None,
                _ => {}
            }
        }
    }

    /// What an ended process leaves of an open turn: the streamed text of a cut-off answer
    /// as a truncated message, then the turn end.
    fn end_open_turn(
        &mut self,
        outcome: TurnOutcome,
        error: Option<String>,
    ) -> Vec<ThreadEventKind> {
        let mut events = Vec::new();
        if let Some((message_id, text)) = self.partial.take().filter(|(_, text)| !text.is_empty()) {
            events.push(ThreadEventKind::AssistantMessage {
                message_id,
                text: cap_text(text, THREAD_ASSISTANT_TEXT_MAX_BYTES).0,
                truncated: true,
            });
        }
        if std::mem::take(&mut self.turn_open) {
            events.push(ThreadEventKind::TurnEnd { outcome, error });
        }
        events
    }
}

/// The thread backend of one session.
pub struct ThreadHandle {
    session: u32,
    launch: ThreadLaunch,
    host: Arc<dyn ThreadHost>,
    /// Serialises process start, Stop, exit handling and close, with their events and the
    /// daemon's status settle, so a message sent during a Stop waits for the old tree.
    op: Mutex<()>,
    state: Mutex<HandleState>,
    next_seq: Mutex<u64>,
    outbox: Arc<Outbox>,
    closed: (Mutex<bool>, Condvar),
    approvals: Mutex<HashMap<String, PendingApproval>>,
}

impl ThreadHandle {
    /// Starts the first process at once; it waits on stdin for the first message.
    pub fn start(
        session: u32,
        launch: ThreadLaunch,
        conversation: Option<Conversation>,
        next_seq: u64,
        host: Arc<dyn ThreadHost>,
    ) -> Result<Arc<Self>> {
        let outbox = Arc::new(Outbox::default());
        let permission_mode = launch.permission_mode;
        let handle = Arc::new(Self {
            session,
            launch,
            host: Arc::clone(&host),
            op: Mutex::new(()),
            state: Mutex::new(HandleState {
                process: None,
                conversation,
                permission_mode,
                generation: 0,
                turn_open: false,
                closed: false,
                close_cause: None,
                partial: None,
            }),
            next_seq: Mutex::new(next_seq.max(1)),
            outbox: Arc::clone(&outbox),
            closed: (Mutex::new(false), Condvar::new()),
            approvals: Mutex::new(HashMap::new()),
        });
        std::thread::Builder::new()
            .name(format!("thread-events-{session}"))
            .spawn(move || outbox.run(session, host.as_ref()))
            .context("starting the thread event sender")?;
        let mut state = handle.state.lock().expect("thread state lock");
        if let Err(error) = handle.ensure_process(&mut state) {
            drop(state);
            handle.close();
            return Err(error);
        }
        drop(state);
        Ok(handle)
    }

    pub fn session(&self) -> u32 {
        self.session
    }

    /// The running Claude's pid, if a process is running.
    pub fn pid(&self) -> Option<u32> {
        let state = self.state.lock().expect("thread state lock");
        state.process.as_ref().map(|process| process.pid)
    }

    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .expect("thread state lock")
            .process
            .is_some()
    }

    /// A message was sent and its turn has not ended.
    pub fn turn_open(&self) -> bool {
        self.state.lock().expect("thread state lock").turn_open
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.0.lock().expect("thread closed lock")
    }

    pub fn permission_mode(&self) -> ThreadPermissionMode {
        self.state
            .lock()
            .expect("thread state lock")
            .permission_mode
    }

    pub fn has_pending_approvals(&self) -> bool {
        !self
            .approvals
            .lock()
            .expect("thread approvals lock")
            .is_empty()
    }

    /// Records the new mode and, when a process runs, restarts it with the mode's flags
    /// and `--resume`. Refused while a turn is open or a request waits: the restart would
    /// end them.
    pub fn set_permission_mode(self: &Arc<Self>, mode: ThreadPermissionMode) -> Result<()> {
        let _op = self.op.lock().expect("thread operation lock");
        let previous = {
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                bail!(
                    "session {} is closed; its permission mode cannot change",
                    self.session
                );
            }
            if state.turn_open {
                bail!(
                    "thread_set_permission_mode refused for session {}: a turn is open (a \
                     message has no turn end yet); change the mode once it ends or after Stop",
                    self.session
                );
            }
            let waiting = self.approvals.lock().expect("thread approvals lock").len();
            if waiting > 0 {
                bail!(
                    "thread_set_permission_mode refused for session {}: {waiting} permission \
                     request(s) wait for an answer; answer them first",
                    self.session
                );
            }
            state.permission_mode = mode;
            state.process.take()
        };
        let Some(previous) = previous else {
            return Ok(());
        };
        previous.stopping.store(true, Ordering::Release);
        previous.end_tree(true);
        let mut state = self.state.lock().expect("thread state lock");
        if state.closed || state.process.is_some() {
            return Ok(());
        }
        self.ensure_process(&mut state).map(|_| ())
    }

    /// Holds one permission prompt for the user: records it and returns its id and the
    /// receiver its answer arrives on.
    pub fn request_approval(
        &self,
        tool_name: &str,
        tool_use_id: &str,
        input: &Value,
    ) -> Result<(String, tokio::sync::oneshot::Receiver<ApprovalAnswer>)> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (answer, receiver) = tokio::sync::oneshot::channel();
        let input = input.to_string();
        let input_bytes = input.len() as u64;
        let (input, truncated) = cap_text(input, THREAD_APPROVAL_INPUT_MAX_BYTES);
        let first = {
            // Under `state`, where Stop and Close take the process before they drain the
            // requests: a request either lands before that drain or is refused here.
            let state = self.state.lock().expect("thread state lock");
            if state.closed || state.process.is_none() {
                bail!(
                    "session {} has no running Claude process; nothing can be approved",
                    self.session
                );
            }
            let mut approvals = self.approvals.lock().expect("thread approvals lock");
            if approvals.len() >= APPROVALS_PENDING_MAX {
                bail!(
                    "{PERMISSION_TOOL} refused for session {}: {} permission requests already \
                     wait for an answer, the limit is {APPROVALS_PENDING_MAX} \
                     (APPROVALS_PENDING_MAX)",
                    self.session,
                    approvals.len()
                );
            }
            approvals.insert(request_id.clone(), PendingApproval { answer });
            approvals.len() == 1
        };
        if first {
            self.host.approvals_pending(self.session, true);
        }
        self.emit(vec![ThreadEventKind::ApprovalRequest {
            request_id: request_id.clone(),
            tool_use_id: cap_text(tool_use_id.to_string(), APPROVAL_NAME_MAX_BYTES).0,
            tool_name: cap_text(tool_name.to_string(), APPROVAL_NAME_MAX_BYTES).0,
            input,
            truncated,
            input_bytes,
        }]);
        Ok((request_id, receiver))
    }

    /// Answers a held request. Errors name the request and the ones still pending.
    pub fn answer_approval(&self, request_id: &str, answer: ApprovalAnswer) -> Result<()> {
        let (pending, left) = {
            let mut approvals = self.approvals.lock().expect("thread approvals lock");
            let pending = approvals.remove(request_id);
            let left: Vec<String> = approvals.keys().cloned().collect();
            (pending, left)
        };
        let Some(pending) = pending else {
            bail!(
                "thread_approve refused for session {}: no pending permission request \
                 {request_id:?} (pending: {left:?})",
                self.session
            );
        };
        let answer = match answer {
            ApprovalAnswer::Deny(message) => {
                ApprovalAnswer::Deny(cap_text(message, APPROVAL_MESSAGE_MAX_BYTES).0)
            }
            allow => allow,
        };
        let (decision, reason) = match &answer {
            ApprovalAnswer::Allow => (ApprovalDecision::Allowed, None),
            ApprovalAnswer::Deny(message) => (ApprovalDecision::Denied, Some(message.clone())),
        };
        // A dropped receiver means Claude ended the call first; the tool does not run either way.
        let _ = pending.answer.send(answer);
        self.emit(vec![ThreadEventKind::ApprovalResolved {
            request_id: request_id.to_string(),
            decision,
            reason,
        }]);
        if left.is_empty() {
            self.host.approvals_pending(self.session, false);
        }
        Ok(())
    }

    /// Claude ended a call nobody answered (it timed out or its process went away).
    pub fn withdraw_approval(&self, request_id: &str) {
        let (removed, empty) = {
            let mut approvals = self.approvals.lock().expect("thread approvals lock");
            (approvals.remove(request_id).is_some(), approvals.is_empty())
        };
        if !removed {
            return;
        }
        self.emit(vec![ThreadEventKind::ApprovalResolved {
            request_id: request_id.to_string(),
            decision: ApprovalDecision::Withdrawn,
            reason: Some("Claude stopped waiting for an answer; the tool did not run.".into()),
        }]);
        if empty {
            self.host.approvals_pending(self.session, false);
        }
    }

    /// Records requests a previous daemon held and never resolved; nothing can answer them.
    pub fn settle_orphaned_approvals(&self, request_ids: Vec<String>) {
        self.emit(
            request_ids
                .into_iter()
                .map(|request_id| ThreadEventKind::ApprovalResolved {
                    request_id,
                    decision: ApprovalDecision::Withdrawn,
                    reason: Some(
                        "Houston restarted before anyone answered; the tool did not run.".into(),
                    ),
                })
                .collect(),
        );
    }

    /// A recovery stop or daemon shutdown is about to close the thread: its held requests
    /// were never answered, so they are withdrawn rather than denied by the user.
    pub fn withdraw_for_restart(&self) {
        self.resolve_pending(
            ApprovalDecision::Withdrawn,
            "Houston restarted before anyone answered; the tool did not run.",
            false,
        );
    }

    /// Denies every held request with `reason`, before the process they belong to ends.
    /// `report` is false when the caller holds daemon locks the status path takes.
    fn deny_pending(&self, reason: &str, report: bool) {
        self.resolve_pending(ApprovalDecision::Denied, reason, report);
    }

    fn resolve_pending(&self, decision: ApprovalDecision, reason: &str, report: bool) {
        let pending: Vec<(String, PendingApproval)> = self
            .approvals
            .lock()
            .expect("thread approvals lock")
            .drain()
            .collect();
        if pending.is_empty() {
            return;
        }
        let mut events = Vec::with_capacity(pending.len());
        for (request_id, approval) in pending {
            let _ = approval
                .answer
                .send(ApprovalAnswer::Deny(reason.to_string()));
            events.push(ThreadEventKind::ApprovalResolved {
                request_id,
                decision,
                reason: Some(reason.to_string()),
            });
        }
        self.emit(events);
        if report {
            #[cfg(feature = "test-barriers")]
            crate::test_barriers::pause("thread-approvals-report", self.session);
            self.host.approvals_pending(self.session, false);
        }
    }

    /// Records `text` and delivers it as one stream-json user message, starting a process
    /// that resumes the conversation first when none runs.
    pub fn send(self: &Arc<Self>, text: &str) -> Result<()> {
        if text.len() > THREAD_USER_MESSAGE_MAX_BYTES {
            bail!(
                "message refused for thread session {}: it is {} bytes, over the {} byte limit \
                 (THREAD_USER_MESSAGE_MAX_BYTES)",
                self.session,
                text.len(),
                THREAD_USER_MESSAGE_MAX_BYTES
            );
        }
        let process = {
            let _op = self.op.lock().expect("thread operation lock");
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                bail!(
                    "session {} is closed; its thread takes no messages",
                    self.session
                );
            }
            let process = self.ensure_process(&mut state)?;
            state.turn_open = true;
            drop(state);
            self.emit(vec![ThreadEventKind::UserMessage {
                text: text.to_string(),
            }]);
            process
        };
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": text},
        })
        .to_string();
        // Written outside every lock: Claude may be writing a long answer to stdout while
        // this blocks on a full stdin pipe, and the stdout reader must keep draining.
        if let Err(error) = process.write_line(&line) {
            if process.stopping.load(Ordering::Acquire) {
                bail!(
                    "thread session {} stopped before this message reached Claude",
                    self.session
                );
            }
            self.emit(vec![ThreadEventKind::Notice {
                text: format!("This message did not reach Claude: {error:#}"),
            }]);
            return Err(error);
        }
        Ok(())
    }

    /// Ends the process tree. Returns whether a process was running.
    pub fn stop(&self) -> bool {
        let _op = self.op.lock().expect("thread operation lock");
        let Some(process) = self.state.lock().expect("thread state lock").process.take() else {
            return false;
        };
        self.deny_pending("Stopped in Houston before anyone answered.", true);
        process.stopping.store(true, Ordering::Release);
        process.end_tree(true);
        self.host.process_gone(self.session);
        let events = self
            .state
            .lock()
            .expect("thread state lock")
            .end_open_turn(TurnOutcome::Interrupted, None);
        self.emit(events);
        #[cfg(feature = "test-barriers")]
        crate::test_barriers::pause("thread-stop-settle", self.session);
        self.host.settle(self.session, TurnOutcome::Interrupted);
        true
    }

    /// Records the end of a turn that stored history left open, with `notice` as its cause.
    pub fn end_stored_turn(&self, notice: &str) {
        let _op = self.op.lock().expect("thread operation lock");
        self.emit(vec![
            ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Interrupted,
                error: None,
            },
            ThreadEventKind::Notice {
                text: notice.to_string(),
            },
        ]);
    }

    /// Names why the next `close` happens, for the notice it records mid-turn.
    pub fn note_close_cause(&self, cause: &str) {
        self.state.lock().expect("thread state lock").close_cause = Some(cause.to_string());
    }

    /// Ends the thread for good, recording an open turn as interrupted with its cause.
    /// Waits for a Stop or exit in progress, whose status settle takes daemon locks:
    /// callers must not hold `temporary_cleanup_lock`.
    pub fn close(&self) {
        let op = self.op.lock().expect("thread operation lock");
        self.close_held(op, true);
    }

    /// `close` unless a send, Stop or exit holds the thread. Returns whether it closed.
    /// Its caller holds `temporary_cleanup_lock`, so held requests are denied unreported.
    pub fn try_close(&self) -> bool {
        match self.op.try_lock() {
            Ok(op) => {
                self.close_held(op, false);
                true
            }
            Err(std::sync::TryLockError::WouldBlock) => false,
            Err(std::sync::TryLockError::Poisoned(_)) => panic!("thread operation lock poisoned"),
        }
    }

    fn close_held(&self, _op: std::sync::MutexGuard<'_, ()>, report: bool) {
        let process = {
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                return;
            }
            state.closed = true;
            state.process.take()
        };
        self.deny_pending("The session ended before anyone answered.", report);
        if let Some(process) = &process {
            process.stopping.store(true, Ordering::Release);
            process.end_tree(false);
            self.host.process_gone(self.session);
        }
        let mut state = self.state.lock().expect("thread state lock");
        let was_open = state.turn_open;
        let mut events = state.end_open_turn(TurnOutcome::Interrupted, None);
        if was_open {
            let cause = state
                .close_cause
                .take()
                .unwrap_or_else(|| "its session ended".to_string());
            events.push(ThreadEventKind::Notice {
                text: format!("Houston stopped this thread: {cause}."),
            });
        }
        drop(state);
        self.emit(events);
        self.outbox.close();
        let (closed, changed) = &self.closed;
        *closed.lock().expect("thread closed lock") = true;
        changed.notify_all();
    }

    pub fn wait_closed(&self) {
        let (closed, changed) = &self.closed;
        let mut closed = closed.lock().expect("thread closed lock");
        while !*closed {
            closed = changed.wait(closed).expect("thread closed wait");
        }
    }

    fn ensure_process(self: &Arc<Self>, state: &mut HandleState) -> Result<Arc<ThreadProcess>> {
        if let Some(process) = &state.process {
            return Ok(Arc::clone(process));
        }
        state.generation += 1;
        let (process, stdout, stderr) = ThreadProcess::spawn(
            &self.launch,
            state.conversation.as_ref(),
            state.permission_mode,
            state.generation,
        )?;
        let tail = Arc::clone(&process.stderr);
        let stderr_reader = std::thread::Builder::new()
            .name(format!("thread-stderr-{}", self.session))
            .spawn(move || drain_stderr(stderr, &tail));
        let weak = Arc::downgrade(self);
        let owned = Arc::clone(&process);
        let stdout_reader = std::thread::Builder::new()
            .name(format!("thread-stdout-{}", self.session))
            .spawn(move || read_stdout(weak, owned, stdout));
        if let Err(error) = stderr_reader.and(stdout_reader) {
            process.end_tree(false);
            return Err(error).context("starting the thread's output readers");
        }
        self.host.process_started(self.session, process.pid);
        state.process = Some(Arc::clone(&process));
        Ok(process)
    }

    fn emit(&self, kinds: Vec<ThreadEventKind>) {
        if kinds.is_empty() {
            return;
        }
        let mut next = self.next_seq.lock().expect("thread seq lock");
        let now = crate::daemon::now_ms();
        let events: Vec<ThreadEvent> = kinds
            .into_iter()
            .map(|kind| {
                let event = ThreadEvent {
                    seq: *next,
                    at_ms: now,
                    kind,
                };
                *next += 1;
                if !matches!(event.kind, ThreadEventKind::AssistantDelta { .. }) {
                    self.host.store(self.session, &event);
                }
                event
            })
            .collect();
        self.outbox.push(events);
    }

    fn on_line(&self, generation: u64, mapper: &mut StreamMapper, line: &str) {
        let mapped = mapper.map_line(line);
        self.on_mapped(generation, mapped);
    }

    fn on_mapped(&self, generation: u64, mapped: Mapped) {
        let mut reported_mode = None;
        {
            // Held while emitting, so a Stop either drops this line or sees its delta.
            let mut state = self.state.lock().expect("thread state lock");
            if state
                .process
                .as_ref()
                .is_none_or(|current| current.generation != generation)
            {
                return;
            }
            // `--resume` only once the stream shows Claude holds the conversation.
            if let Some(id) = mapped.conversation {
                state.conversation = Some(Conversation::Resume(id));
            } else if mapped.turn_end.is_some() {
                if let Some(Conversation::New(id)) = &state.conversation {
                    state.conversation = Some(Conversation::Resume(id.clone()));
                }
            }
            if mapped.turn_end.is_some() {
                state.turn_open = false;
            }
            if let Some(mode) = mapped.permission_mode {
                if mode != state.permission_mode {
                    state.permission_mode = mode;
                    reported_mode = Some(mode);
                }
            }
            state.track_partial(&mapped.events);
            self.emit(mapped.events);
        }
        if let Some(mode) = reported_mode {
            self.host.permission_mode_reported(self.session, mode);
        }
        if let Some(outcome) = mapped.turn_end {
            self.host.turn_ended(self.session, outcome);
        }
    }

    fn line_skipped(&self, generation: u64, bytes: usize) {
        self.on_mapped(
            generation,
            Mapped {
                events: vec![ThreadEventKind::Notice {
                    text: format!(
                        "Skipped one {bytes} byte line of Claude's output: over the {} MiB \
                         limit for a thread line, so an event of this turn is missing.",
                        STDOUT_LINE_MAX_BYTES / (1024 * 1024)
                    ),
                }],
                ..Mapped::default()
            },
        );
    }

    fn process_ended(&self, process: &ThreadProcess) {
        if process.stopping.load(Ordering::Acquire) {
            return;
        }
        let _op = self.op.lock().expect("thread operation lock");
        {
            let mut state = self.state.lock().expect("thread state lock");
            if process.stopping.load(Ordering::Acquire)
                || state
                    .process
                    .as_ref()
                    .is_none_or(|current| current.generation != process.generation)
            {
                return;
            }
            state.process = None;
        }
        self.deny_pending("Claude exited before anyone answered.", true);
        let code = process.end_tree(false);
        self.host.process_gone(self.session);
        let stderr = process.stderr.lock().expect("thread stderr lock").text();
        let code = code.map_or_else(
            || "no exit code".to_string(),
            |code| format!("exit code {code}"),
        );
        let mut events = self.state.lock().expect("thread state lock").end_open_turn(
            TurnOutcome::Error,
            Some(format!("Claude exited during the turn ({code})")),
        );
        let text = if stderr.is_empty() {
            format!("Claude exited ({code}); the next message starts it again.")
        } else {
            format!("Claude exited ({code}); the next message starts it again. Its last output:\n{stderr}")
        };
        events.push(ThreadEventKind::Notice { text });
        self.emit(events);
        self.host.settle(self.session, TurnOutcome::Error);
    }
}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        self.outbox.close();
    }
}

fn drain_stderr(mut stderr: std::process::ChildStderr, tail: &Mutex<Tail>) {
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => tail.lock().expect("thread stderr lock").push(&buf[..n]),
        }
    }
}

fn read_stdout(
    handle: Weak<ThreadHandle>,
    process: Arc<ThreadProcess>,
    stdout: std::process::ChildStdout,
) {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut mapper = StreamMapper::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        let Ok(Some(bytes)) = read_bounded_line(&mut reader, &mut line, STDOUT_LINE_MAX_BYTES)
        else {
            break;
        };
        let Some(handle) = handle.upgrade() else {
            break;
        };
        if bytes > STDOUT_LINE_MAX_BYTES {
            tracing::warn!(
                "thread pid {}: skipped a {bytes} byte stdout line over {STDOUT_LINE_MAX_BYTES}",
                process.pid
            );
            handle.line_skipped(process.generation, bytes);
        } else {
            handle.on_line(
                process.generation,
                &mut mapper,
                &String::from_utf8_lossy(&line),
            );
        }
    }
    if let Some(handle) = handle.upgrade() {
        handle.process_ended(&process);
    }
}

/// Reads one `\n`-terminated line, keeping it in `out` only up to `max` bytes. Returns the
/// line's length (`None` at EOF); a length over `max` means the line was skipped.
fn read_bounded_line(
    reader: &mut impl BufRead,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<Option<usize>> {
    let mut length = 0;
    let mut read_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(read_any.then_some(length));
        }
        read_any = true;
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(at) => (&available[..at], at + 1),
            None => (available, available.len()),
        };
        length += chunk.len();
        if length <= max {
            out.extend_from_slice(chunk);
        } else {
            out.clear();
        }
        let ended = done > chunk.len();
        reader.consume(done);
        if ended {
            return Ok(Some(length));
        }
    }
}

/// A thread's process group as a later daemon can find it: Claude leads the group, inside
/// the daemon's session, on one boot. Windows needs none: its Job object kills the tree
/// when the daemon's handle closes, crash included.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThreadGroup {
    pub pgid: u32,
    pub sid: u32,
    pub system: String,
    /// `pid::process_creation_token` of the leader, so a reused pgid is told apart.
    #[serde(default)]
    pub leader_creation: Option<u64>,
}

impl ThreadGroup {
    #[cfg(target_os = "linux")]
    pub fn capture(leader: u32) -> Option<Self> {
        // SAFETY: getsid(0) only reads this process's session id.
        let sid = unsafe { libc::getsid(0) };
        let system = crate::recovery_process::system_identity().ok().flatten()?;
        (sid > 0).then_some(Self {
            pgid: leader,
            sid: sid as u32,
            system,
            leader_creation: crate::pid::process_creation_token(leader),
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn capture(_leader: u32) -> Option<Self> {
        None
    }

    /// Kills what is left of the group after its daemon died: every process still in this
    /// pgid and session id on this boot, unless a new process now holds the leader's pid.
    /// Returns how many were signalled.
    #[cfg(target_os = "linux")]
    pub fn reclaim(&self) -> Result<usize> {
        let current = crate::recovery_process::system_identity()?;
        if current.as_deref() != Some(self.system.as_str())
            || self.reused(crate::pid::process_creation_token(self.pgid))
        {
            return Ok(0);
        }
        let mut stats = Vec::new();
        for entry in std::fs::read_dir("/proc")
            .context("listing /proc")?
            .flatten()
        {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            if let Some((pgrp, session)) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| group_and_session(&stat))
            {
                stats.push((pid, pgrp, session));
            }
        }
        let members = self.members(&stats, std::process::id());
        for pid in &members {
            let creation = crate::pid::process_creation_token(*pid);
            if let Err(error) = crate::pid::signal_process_checked_identity(
                *pid,
                crate::pid::Signal::Kill,
                creation,
            ) {
                tracing::warn!(
                    "stopping process {pid} left in thread group {}: {error}",
                    self.pgid
                );
            }
        }
        Ok(members.len())
    }

    #[cfg(not(target_os = "linux"))]
    pub fn reclaim(&self) -> Result<usize> {
        Ok(0)
    }

    /// A live process with the leader's pid but another creation token means every member
    /// exited and the pgid number was issued again.
    pub fn reused(&self, live_leader: Option<u64>) -> bool {
        matches!((self.leader_creation, live_leader), (Some(was), Some(now)) if was != now)
    }

    /// The processes of `stats` (pid, pgrp, session) that belong to this group.
    pub fn members(&self, stats: &[(u32, u32, u32)], me: u32) -> Vec<u32> {
        if self.pgid <= 1 || self.sid <= 1 {
            return Vec::new();
        }
        stats
            .iter()
            .filter(|(pid, pgrp, session)| *pid != me && *pgrp == self.pgid && *session == self.sid)
            .map(|(pid, _, _)| *pid)
            .collect()
    }
}

/// The pgrp and session fields of a `/proc/<pid>/stat` line.
pub fn group_and_session(stat: &str) -> Option<(u32, u32)> {
    let mut fields = stat[stat.rfind(')')? + 1..].split_whitespace();
    // After the command: state, ppid, pgrp, session.
    let pgrp = fields.nth(2)?.parse().ok()?;
    let session = fields.next()?.parse().ok()?;
    Some((pgrp, session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_group_is_matched_by_pgid_and_session_only() {
        let group = ThreadGroup {
            pgid: 400,
            sid: 30,
            system: "linux:x".into(),
            leader_creation: Some(7),
        };
        let stats = [
            (400, 400, 30),
            (401, 400, 30),
            (402, 400, 31),
            (403, 402, 30),
            (9, 400, 30),
        ];
        assert_eq!(group.members(&stats, 9), [400, 401]);
        let broadcast = ThreadGroup { pgid: 1, ..group };
        assert!(broadcast.members(&stats, 9).is_empty());
        assert_eq!(
            group_and_session("12 (a b) c) S 1 400 30 0 -1"),
            Some((400, 30))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reclaim_kills_a_left_over_group_member() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let mut sleeper = crate::spawn::command("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let group = ThreadGroup::capture(sleeper.id()).expect("a Linux group identity");
        assert!(group.reclaim().unwrap() >= 1);
        assert_eq!(sleeper.wait().unwrap().signal(), Some(libc::SIGKILL));
    }

    #[test]
    fn a_group_is_reused_only_when_a_different_leader_holds_its_pid() {
        let group = ThreadGroup {
            pgid: 400,
            sid: 30,
            system: "linux:x".into(),
            leader_creation: Some(7),
        };
        assert!(group.reused(Some(8)));
        assert!(!group.reused(Some(7)), "the original leader still runs");
        assert!(
            !group.reused(None),
            "the leader exited; its members may remain"
        );
        let recorded_before_tokens = ThreadGroup {
            leader_creation: None,
            ..group
        };
        assert!(!recorded_before_tokens.reused(Some(8)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reclaim_leaves_a_group_whose_pgid_was_issued_again() {
        use std::os::unix::process::CommandExt;
        let mut sleeper = crate::spawn::command("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut group = ThreadGroup::capture(sleeper.id()).expect("a Linux group identity");
        let token = group.leader_creation.expect("the leader's creation token");
        group.leader_creation = Some(token + 1);
        assert_eq!(group.reclaim().unwrap(), 0);
        assert!(
            sleeper.try_wait().unwrap().is_none(),
            "the new group was killed"
        );
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

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
    fn coalescing_merges_adjacent_deltas_of_one_block() {
        let delta = |seq, id: &str, text: &str| ThreadEvent {
            seq,
            at_ms: 0,
            kind: ThreadEventKind::AssistantDelta {
                message_id: id.into(),
                text: text.into(),
            },
        };
        let merged = coalesce(vec![
            delta(1, "a", "x"),
            delta(2, "a", "y"),
            delta(3, "b", "z"),
            delta(4, "b", "w"),
        ]);
        assert_eq!(merged, vec![delta(2, "a", "xy"), delta(4, "b", "zw")]);
    }

    #[test]
    fn bounded_lines_skip_an_overlong_line_and_keep_the_next() {
        let data = format!("{}\nshort\nlast", "y".repeat(100));
        let mut reader = BufReader::with_capacity(8, data.as_bytes());
        let mut line = Vec::new();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 10).unwrap(),
            Some(100)
        );
        line.clear();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 10).unwrap(),
            Some(5)
        );
        assert_eq!(line, b"short");
        line.clear();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 10).unwrap(),
            Some(4)
        );
        assert_eq!(line, b"last");
        line.clear();
        assert_eq!(read_bounded_line(&mut reader, &mut line, 10).unwrap(), None);
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
        let (launch, _) = ThreadLaunch::from_command(&cmd).unwrap();
        assert_eq!(launch.permission_mode, ThreadPermissionMode::Plan);
        let argv = |mode| -> Vec<String> {
            launch
                .command(None, mode)
                .get_args()
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
        let (launch, _) = ThreadLaunch::from_command(&bypass).unwrap();
        assert_eq!(launch.permission_mode, ThreadPermissionMode::Bypass);
        assert!(
            !launch
                .command(None, ThreadPermissionMode::Default)
                .get_args()
                .any(|arg| arg == "--permission-prompt-tool"),
            "without Houston's MCP server there is no tool to name"
        );

        let mut odd = portable_pty::CommandBuilder::new("claude");
        odd.args(["--permission-mode", "dontAsk"]);
        let error = ThreadLaunch::from_command(&odd).err().unwrap().to_string();
        assert!(error.contains("\"dontAsk\""), "{error}");
    }

    #[test]
    fn launch_splits_out_the_conversation_arguments() {
        let mut cmd = portable_pty::CommandBuilder::new("claude");
        cmd.args(["--resume", "abc", "--mcp-config", "{}"]);
        let (launch, conversation) = ThreadLaunch::from_command(&cmd).unwrap();
        assert_eq!(conversation, Some(Conversation::Resume("abc".into())));
        assert_eq!(
            launch.args,
            vec![OsString::from("--mcp-config"), OsString::from("{}")]
        );
    }
}

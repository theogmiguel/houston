//! A Claude session in thread view: `claude -p` with stream-json on pipes, not a PTY.
//! Stop ends the whole process tree (process group / Job object); the next message
//! resumes the conversation in a new process. See docs/internals/invariants.md.

use anyhow::{anyhow, bail, Context, Result};
use houston_protocol::{
    ThreadEvent, ThreadEventKind, TurnOutcome, THREAD_ASSISTANT_TEXT_MAX_BYTES,
    THREAD_TOOL_INPUT_MAX_BYTES, THREAD_TOOL_OUTPUT_MAX_BYTES,
};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;
#[cfg(target_os = "linux")]
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

/// 30 `thread_events` messages a second per session at most.
pub const THREAD_EVENTS_MIN_INTERVAL: Duration = Duration::from_millis(34);
/// One stdout line above this is skipped whole: a single tool result can be megabytes,
/// and only its first 16 KiB are kept anyway.
const STDOUT_LINE_MAX_BYTES: usize = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
/// Time a stopped Claude gets to exit on SIGTERM before its group is killed.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_millis(1000);

/// What the daemon does with a thread's events. A trait so the backend runs in unit tests
/// without a daemon.
pub trait ThreadHost: Send + Sync + 'static {
    /// Called in `seq` order for every event except `AssistantDelta`.
    fn store(&self, session: u32, event: &ThreadEvent);
    fn broadcast(&self, session: u32, events: Vec<ThreadEvent>);
    /// The stream's `result` event ended a turn.
    fn turn_ended(&self, session: u32, outcome: TurnOutcome);
    /// The process ended on its own; no turn can still be running.
    fn process_ended(&self, session: u32);
}

/// The launch a thread restarts from: the session's assembled Claude command without its
/// conversation arguments, which change between the first start and a resume.
#[derive(Clone, Debug)]
pub struct ThreadLaunch {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conversation {
    /// `--session-id`: nothing has been sent in it yet.
    New(String),
    /// `--resume`: the conversation has at least one turn.
    Resume(String),
}

impl ThreadLaunch {
    /// Splits `--session-id <id>` and `--resume <id>` out of an assembled command.
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
        let mut rest = argv[1..].iter();
        while let Some(arg) = rest.next() {
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
            },
            conversation,
        ))
    }

    fn command(&self, conversation: Option<&Conversation>) -> std::process::Command {
        let mut command = crate::spawn::command(&self.program);
        command.args(&self.args);
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

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a Job object handle may be used and closed from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn new() -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: null attributes and name create an unnamed job owned by this process.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error()).context("creating a Job object");
        }
        let job = Job(handle);
        // SAFETY: a zeroed limit structure is valid; only the flag below is set.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe `limits`, which outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .context("setting kill-on-close on the thread's Job object");
        }
        Ok(job)
    }

    /// Assigns a suspended child, then resumes it, so nothing it starts escapes the job.
    fn adopt_suspended(&self, child: &std::process::Child) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: both handles are live for the duration of the call.
        if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as _) } == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("assigning Claude pid {} to its Job object", child.id()));
        }
        resume_threads(child.id())
    }

    fn terminate(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: the handle is a live Job object owned by this struct.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(std::io::Error::last_os_error())
                .context("terminating the thread's Job object");
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this struct and closed once; kill-on-close ends
        // any process still in the job.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn resume_threads(pid: u32) -> Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: a thread snapshot of the whole system; the handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("listing threads to resume Claude");
    }
    // SAFETY: zeroed is valid for THREADENTRY32 once dwSize is set.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    // SAFETY: `entry` is a properly sized out-parameter for the snapshot walk.
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: opening a thread of our own suspended child by its id.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                // SAFETY: `thread` is a live handle opened above and closed right after.
                unsafe {
                    ResumeThread(thread);
                    CloseHandle(thread);
                }
                resumed += 1;
            }
        }
        // SAFETY: as for Thread32First.
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    // SAFETY: closing the snapshot handle created above.
    unsafe { CloseHandle(snapshot) };
    if resumed == 0 {
        bail!("Claude pid {pid} was started suspended but none of its threads could be resumed");
    }
    Ok(())
}

/// One run of the Claude process. A Stop or a crash ends it; the handle starts the next.
struct ThreadProcess {
    generation: u64,
    pid: u32,
    child: Mutex<Option<std::process::Child>>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
    stopping: AtomicBool,
    stderr: Arc<Mutex<Tail>>,
    #[cfg(windows)]
    job: Job,
}

impl ThreadProcess {
    fn spawn(
        launch: &ThreadLaunch,
        conversation: Option<&Conversation>,
        generation: u64,
    ) -> Result<(
        Arc<Self>,
        std::process::ChildStdout,
        std::process::ChildStderr,
    )> {
        let mut command = launch.command(conversation);
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
            Job::new()?
        };
        let mut child = command.spawn().with_context(|| {
            format!(
                "starting {} for a thread session (expected the claude CLI on PATH)",
                launch.program.to_string_lossy()
            )
        })?;
        #[cfg(windows)]
        if let Err(error) = job.adopt_suspended(&child) {
            let _ = child.kill();
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
        *self.stdin.lock().expect("thread stdin lock") = None;
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
                tracing::warn!("{error:#}");
                let _ = child.kill();
            }
        }
        child.wait().ok().and_then(|status| status.code())
    }
}

struct HandleState {
    process: Option<Arc<ThreadProcess>>,
    conversation: Option<Conversation>,
    generation: u64,
    open_turns: u32,
    closed: bool,
}

/// The thread backend of one session.
pub struct ThreadHandle {
    session: u32,
    launch: ThreadLaunch,
    host: Arc<dyn ThreadHost>,
    state: Mutex<HandleState>,
    next_seq: Mutex<u64>,
    outbox: Arc<Outbox>,
    closed: (Mutex<bool>, Condvar),
}

impl ThreadHandle {
    /// Starts the first process at once, so the session's start-up hooks fire before its
    /// first message.
    pub fn start(
        session: u32,
        launch: ThreadLaunch,
        conversation: Option<Conversation>,
        next_seq: u64,
        host: Arc<dyn ThreadHost>,
    ) -> Result<Arc<Self>> {
        let outbox = Arc::new(Outbox::default());
        let handle = Arc::new(Self {
            session,
            launch,
            host: Arc::clone(&host),
            state: Mutex::new(HandleState {
                process: None,
                conversation,
                generation: 0,
                open_turns: 0,
                closed: false,
            }),
            next_seq: Mutex::new(next_seq.max(1)),
            outbox: Arc::clone(&outbox),
            closed: (Mutex::new(false), Condvar::new()),
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

    pub fn is_closed(&self) -> bool {
        *self.closed.0.lock().expect("thread closed lock")
    }

    /// Records `text` and delivers it as one stream-json user message, starting a process
    /// that resumes the conversation first when none runs.
    pub fn send(self: &Arc<Self>, text: &str) -> Result<()> {
        let process = {
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                bail!(
                    "session {} is closed; its thread takes no messages",
                    self.session
                );
            }
            let process = self.ensure_process(&mut state)?;
            state.open_turns = state.open_turns.saturating_add(1);
            if let Some(Conversation::New(id)) = &state.conversation {
                state.conversation = Some(Conversation::Resume(id.clone()));
            }
            process
        };
        self.emit(vec![ThreadEventKind::UserMessage {
            text: text.to_string(),
        }]);
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": text},
        })
        .to_string();
        // Written outside every lock: Claude may be writing a long answer to stdout while
        // this blocks on a full stdin pipe, and the stdout reader must keep draining.
        if let Err(error) = process.write_line(&line) {
            self.emit(vec![ThreadEventKind::Notice {
                text: format!("This message did not reach Claude: {error:#}"),
            }]);
            return Err(error);
        }
        Ok(())
    }

    /// Ends the process tree. Returns whether a process was running.
    pub fn stop(&self) -> bool {
        let (process, open_turns) = {
            let mut state = self.state.lock().expect("thread state lock");
            let open = std::mem::take(&mut state.open_turns);
            (state.process.take(), open)
        };
        let Some(process) = process else {
            return false;
        };
        process.stopping.store(true, Ordering::Release);
        process.end_tree(true);
        if open_turns > 0 {
            self.emit(vec![ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Interrupted,
                error: None,
            }]);
        }
        true
    }

    /// Ends the thread for good: the session was killed or closed.
    pub fn close(&self) {
        let process = {
            let mut state = self.state.lock().expect("thread state lock");
            state.closed = true;
            state.process.take()
        };
        if let Some(process) = process {
            process.stopping.store(true, Ordering::Release);
            process.end_tree(false);
        }
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
        let (process, stdout, stderr) =
            ThreadProcess::spawn(&self.launch, state.conversation.as_ref(), state.generation)?;
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
        if let Some(id) = mapped.conversation {
            let mut state = self.state.lock().expect("thread state lock");
            if state.generation == generation {
                let resumable = matches!(state.conversation, Some(Conversation::Resume(_)));
                state.conversation = Some(if resumable {
                    Conversation::Resume(id)
                } else {
                    Conversation::New(id)
                });
            }
        }
        if mapped.turn_end.is_some() {
            let mut state = self.state.lock().expect("thread state lock");
            state.open_turns = state.open_turns.saturating_sub(1);
        }
        self.emit(mapped.events);
        if let Some(outcome) = mapped.turn_end {
            self.host.turn_ended(self.session, outcome);
        }
    }

    fn process_ended(&self, process: &ThreadProcess) {
        if process.stopping.load(Ordering::Acquire) {
            return;
        }
        let open_turns = {
            let mut state = self.state.lock().expect("thread state lock");
            if state
                .process
                .as_ref()
                .is_none_or(|current| current.generation != process.generation)
            {
                return;
            }
            state.process = None;
            std::mem::take(&mut state.open_turns)
        };
        let code = process.end_tree(false);
        let stderr = process.stderr.lock().expect("thread stderr lock").text();
        let code = code.map_or_else(
            || "no exit code".to_string(),
            |code| format!("exit code {code}"),
        );
        let mut events = Vec::new();
        if open_turns > 0 {
            events.push(ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Error,
                error: Some(format!("Claude exited during the turn ({code})")),
            });
        }
        let text = if stderr.is_empty() {
            format!("Claude exited ({code}); the next message starts it again.")
        } else {
            format!("Claude exited ({code}); the next message starts it again. Its last output:\n{stderr}")
        };
        events.push(ThreadEventKind::Notice { text });
        self.emit(events);
        self.host.process_ended(self.session);
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
        match read_bounded_line(&mut reader, &mut line, STDOUT_LINE_MAX_BYTES) {
            Ok(None) | Err(_) => break,
            Ok(Some(false)) => {
                let Some(handle) = handle.upgrade() else {
                    break;
                };
                handle.on_line(
                    process.generation,
                    &mut mapper,
                    &String::from_utf8_lossy(&line),
                );
            }
            Ok(Some(true)) => tracing::warn!(
                "thread pid {}: skipped a stdout line over {STDOUT_LINE_MAX_BYTES} bytes",
                process.pid
            ),
        }
    }
    if let Some(handle) = handle.upgrade() {
        handle.process_ended(&process);
    }
}

/// Reads one `\n`-terminated line into `out`, keeping at most `max` bytes. `None` at EOF,
/// `Some(true)` when the line was longer than `max` and was skipped.
fn read_bounded_line(
    reader: &mut impl BufRead,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<Option<bool>> {
    let mut overflow = false;
    let mut read_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(read_any.then_some(overflow));
        }
        read_any = true;
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(at) => (&available[..at], at + 1),
            None => (available, available.len()),
        };
        if !overflow {
            if out.len() + chunk.len() > max {
                overflow = true;
                out.clear();
            } else {
                out.extend_from_slice(chunk);
            }
        }
        let ended = done > chunk.len();
        reader.consume(done);
        if ended {
            return Ok(Some(overflow));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Some(true)
        );
        line.clear();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 10).unwrap(),
            Some(false)
        );
        assert_eq!(line, b"short");
        line.clear();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 10).unwrap(),
            Some(false)
        );
        assert_eq!(line, b"last");
        line.clear();
        assert_eq!(read_bounded_line(&mut reader, &mut line, 10).unwrap(), None);
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

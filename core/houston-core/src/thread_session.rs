//! A session in thread view: a provider CLI on pipes, decoded by a `ProviderAdapter`
//! (Claude's: `claude_stream.rs`). Stop ends the process tree (process group / Job object);
//! the next message resumes the conversation in a new process. See docs/internals/invariants.md.

use anyhow::{anyhow, bail, Context, Result};
use houston_protocol::{
    AgentKind, ThreadEvent, ThreadEventKind, TurnOutcome, THREAD_ASSISTANT_TEXT_MAX_BYTES,
    THREAD_USER_MESSAGE_MAX_BYTES,
};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;
#[cfg(any(target_os = "linux", windows))]
use std::time::Instant;

/// 30 `thread_events` messages a second per session at most.
pub const THREAD_EVENTS_MIN_INTERVAL: Duration = Duration::from_millis(34);
/// One stdout line above this is skipped whole, with a notice: a single tool result can
/// be megabytes, and at most 256 KiB of any event is kept anyway.
const STDOUT_LINE_MAX_BYTES: usize = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
/// Time a stopped provider process gets to exit on SIGTERM before its group is killed.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_millis(1000);
/// Bounds the system-wide thread snapshot walk that resumes a suspended process; it
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
    /// A new provider process leads the thread's process group.
    fn process_started(&self, session: u32, pid: u32);
    /// Stop, an exit or close ended the process tree, so nothing of it is left to reclaim.
    fn process_gone(&self, session: u32);
}

/// The provider-specific half of a structured session.
pub trait ProviderAdapter: Send + Sync + 'static {
    /// Names the provider in notices and refusals.
    fn provider(&self) -> AgentKind;
    /// The process for `conversation`.
    fn command(&self, conversation: Option<&Conversation>) -> Result<ProcessSpec>;
    /// One codec per process: decoders keep per-process state (block indices, request ids).
    fn open(&self) -> Box<dyn ProviderStream>;
}

pub trait ProviderStream: Send {
    /// Lines written before the first message: none for Claude; an `initialize` request
    /// for a JSON-RPC provider.
    fn handshake(&mut self) -> Vec<String> {
        Vec::new()
    }
    /// The stdin line that starts a turn.
    fn user_message(&mut self, text: &str) -> Result<String>;
    /// One stdout line. Unknown types decode to nothing.
    fn decode(&mut self, line: &str) -> Decoded;
}

/// What one stdout line produced besides events.
#[derive(Debug, Default, PartialEq)]
pub struct Decoded {
    pub events: Vec<ThreadEventKind>,
    pub turn_end: Option<TurnOutcome>,
    pub conversation: Option<String>,
}

/// A provider process: started with exactly this environment and piped stdio.
#[derive(Clone, Debug)]
pub struct ProcessSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

impl ProcessSpec {
    fn command(&self) -> std::process::Command {
        let mut command = crate::spawn::command(&self.program);
        command.args(&self.args);
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conversation {
    /// `--session-id`: nothing has been sent in it yet.
    New(String),
    /// `--resume`: the conversation has at least one turn.
    Resume(String),
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
        .with_context(|| format!("assigning thread pid {} to its Job object", child.id()))?;
    crate::pid::resume_owned_child(child, Instant::now(), RESUME_TIMEOUT)
        .with_context(|| format!("resuming suspended thread pid {}", child.id()))
}

/// One run of the provider process. A Stop or a crash ends it; the handle starts the next.
struct ThreadProcess {
    generation: u64,
    provider: AgentKind,
    pid: u32,
    child: Mutex<Option<std::process::Child>>,
    /// Held only by writers: ending the tree never waits for it, so a write blocked on a
    /// process that stopped reading cannot hold up Stop, Kill or shutdown.
    stdin: Mutex<Option<std::process::ChildStdin>>,
    /// Locked per line by the stdout reader and per message by `send`, never across a write.
    stream: Mutex<Box<dyn ProviderStream>>,
    stopping: AtomicBool,
    stderr: Arc<Mutex<Tail>>,
    #[cfg(windows)]
    job: crate::pid::OwnedJob,
}

impl ThreadProcess {
    fn spawn(
        adapter: &dyn ProviderAdapter,
        conversation: Option<&Conversation>,
        generation: u64,
    ) -> Result<(
        Arc<Self>,
        std::process::ChildStdout,
        std::process::ChildStderr,
    )> {
        let provider = adapter.provider();
        let spec = adapter.command(conversation)?;
        let mut command = spec.command();
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
                "starting {} for a thread session (expected the {provider:?} CLI on PATH)",
                spec.program.to_string_lossy()
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
            provider,
            pid: child.id(),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            stream: Mutex::new(adapter.open()),
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
            .ok_or_else(|| anyhow!("{:?} pid {} has no open stdin", self.provider, self.pid))?;
        pipe.write_all(line.as_bytes())
            .and_then(|()| pipe.write_all(b"\n"))
            .and_then(|()| pipe.flush())
            .with_context(|| format!("writing a message to {:?} pid {}", self.provider, self.pid))
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
    adapter: Arc<dyn ProviderAdapter>,
    host: Arc<dyn ThreadHost>,
    /// Serialises process start, Stop, exit handling and close, with their events and the
    /// daemon's status settle, so a message sent during a Stop waits for the old tree.
    op: Mutex<()>,
    state: Mutex<HandleState>,
    next_seq: Mutex<u64>,
    outbox: Arc<Outbox>,
    closed: (Mutex<bool>, Condvar),
}

impl ThreadHandle {
    /// Starts the first process at once; it waits on stdin for the first message.
    pub fn start(
        session: u32,
        adapter: Arc<dyn ProviderAdapter>,
        conversation: Option<Conversation>,
        next_seq: u64,
        host: Arc<dyn ThreadHost>,
    ) -> Result<Arc<Self>> {
        let outbox = Arc::new(Outbox::default());
        let handle = Arc::new(Self {
            session,
            adapter,
            host: Arc::clone(&host),
            op: Mutex::new(()),
            state: Mutex::new(HandleState {
                process: None,
                conversation,
                generation: 0,
                turn_open: false,
                closed: false,
                close_cause: None,
                partial: None,
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

    /// The provider process pid, if a process is running.
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
        let (process, line) = {
            let _op = self.op.lock().expect("thread operation lock");
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                bail!(
                    "session {} is closed; its thread takes no messages",
                    self.session
                );
            }
            let process = self.ensure_process(&mut state)?;
            let line = process
                .stream
                .lock()
                .expect("thread stream lock")
                .user_message(text)?;
            state.turn_open = true;
            drop(state);
            self.emit(vec![ThreadEventKind::UserMessage {
                text: text.to_string(),
            }]);
            (process, line)
        };
        // Written outside every lock: the provider may be writing a long answer to stdout
        // while this blocks on a full stdin pipe, and the stdout reader must keep draining.
        if let Err(error) = process.write_line(&line) {
            if process.stopping.load(Ordering::Acquire) {
                bail!(
                    "thread session {} stopped before this message reached {:?}",
                    self.session,
                    process.provider
                );
            }
            self.emit(vec![ThreadEventKind::Notice {
                text: format!(
                    "This message did not reach {:?}: {error:#}",
                    process.provider
                ),
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
        self.close_held(op);
    }

    /// `close` unless a send, Stop or exit holds the thread. Returns whether it closed.
    pub fn try_close(&self) -> bool {
        match self.op.try_lock() {
            Ok(op) => {
                self.close_held(op);
                true
            }
            Err(std::sync::TryLockError::WouldBlock) => false,
            Err(std::sync::TryLockError::Poisoned(_)) => panic!("thread operation lock poisoned"),
        }
    }

    fn close_held(&self, _op: std::sync::MutexGuard<'_, ()>) {
        let process = {
            let mut state = self.state.lock().expect("thread state lock");
            if state.closed {
                return;
            }
            state.closed = true;
            state.process.take()
        };
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
            self.adapter.as_ref(),
            state.conversation.as_ref(),
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
        let handshake = process
            .stream
            .lock()
            .expect("thread stream lock")
            .handshake();
        for line in handshake {
            if let Err(error) = process.write_line(&line) {
                process.end_tree(false);
                return Err(error);
            }
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

    fn on_line(&self, process: &ThreadProcess, line: &str) {
        let decoded = process
            .stream
            .lock()
            .expect("thread stream lock")
            .decode(line);
        self.on_decoded(process.generation, decoded);
    }

    fn on_decoded(&self, generation: u64, mapped: Decoded) {
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
            // Resume only once the stream shows the provider holds the conversation.
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
            state.track_partial(&mapped.events);
            self.emit(mapped.events);
        }
        if let Some(outcome) = mapped.turn_end {
            self.host.turn_ended(self.session, outcome);
        }
    }

    fn line_skipped(&self, process: &ThreadProcess, bytes: usize) {
        self.on_decoded(
            process.generation,
            Decoded {
                events: vec![ThreadEventKind::Notice {
                    text: format!(
                        "Skipped one {bytes} byte line of {:?}'s output: over the {} MiB \
                         limit for a thread line, so an event of this turn is missing.",
                        process.provider,
                        STDOUT_LINE_MAX_BYTES / (1024 * 1024)
                    ),
                }],
                ..Decoded::default()
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
        let code = process.end_tree(false);
        self.host.process_gone(self.session);
        let stderr = process.stderr.lock().expect("thread stderr lock").text();
        let code = code.map_or_else(
            || "no exit code".to_string(),
            |code| format!("exit code {code}"),
        );
        let provider = process.provider;
        let mut events = self.state.lock().expect("thread state lock").end_open_turn(
            TurnOutcome::Error,
            Some(format!("{provider:?} exited during the turn ({code})")),
        );
        let text = if stderr.is_empty() {
            format!("{provider:?} exited ({code}); the next message starts it again.")
        } else {
            format!("{provider:?} exited ({code}); the next message starts it again. Its last output:\n{stderr}")
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
            handle.line_skipped(&process, bytes);
        } else {
            handle.on_line(&process, &String::from_utf8_lossy(&line));
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

/// A thread's process group as a later daemon can find it: the provider leads the group, inside
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

    /// A provider that is not Claude: one plain line in, `reply:<line>` out, then it exits.
    #[derive(Default)]
    struct EchoAdapter {
        spawned: Mutex<Vec<ProcessSpec>>,
    }

    impl ProviderAdapter for EchoAdapter {
        fn provider(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn command(&self, conversation: Option<&Conversation>) -> Result<ProcessSpec> {
            assert_eq!(conversation, None);
            #[cfg(unix)]
            let (program, args) = ("sh", ["-c", "read line; echo \"reply:$line\""].as_slice());
            #[cfg(windows)]
            let (program, args) = (
                "cmd",
                ["/v:on", "/d", "/c", "set /p line=&echo reply:!line!"].as_slice(),
            );
            let host = crate::host_env::HostEnv::capture();
            let spec = ProcessSpec {
                program: program.into(),
                args: args.iter().map(OsString::from).collect(),
                env: host
                    .names()
                    .filter_map(|name| name.to_str())
                    .filter_map(|name| Some((name.to_string(), host.var(name)?)))
                    .collect(),
                cwd: None,
            };
            self.spawned.lock().unwrap().push(spec.clone());
            Ok(spec)
        }

        fn open(&self) -> Box<dyn ProviderStream> {
            Box::new(EchoStream)
        }
    }

    struct EchoStream;

    impl ProviderStream for EchoStream {
        fn user_message(&mut self, text: &str) -> Result<String> {
            Ok(text.to_string())
        }

        fn decode(&mut self, line: &str) -> Decoded {
            let Some(text) = line.trim_end().strip_prefix("reply:") else {
                return Decoded::default();
            };
            Decoded {
                events: vec![
                    ThreadEventKind::AssistantMessage {
                        message_id: "reply:0".into(),
                        text: text.into(),
                        truncated: false,
                    },
                    ThreadEventKind::TurnEnd {
                        outcome: TurnOutcome::Completed,
                        error: None,
                    },
                ],
                turn_end: Some(TurnOutcome::Completed),
                conversation: None,
            }
        }
    }

    #[derive(Default)]
    struct StoredEvents {
        events: Mutex<Vec<ThreadEventKind>>,
        changed: Condvar,
    }

    impl ThreadHost for StoredEvents {
        fn store(&self, _session: u32, event: &ThreadEvent) {
            self.events.lock().unwrap().push(event.kind.clone());
            self.changed.notify_all();
        }
        fn broadcast(&self, _session: u32, _events: Vec<ThreadEvent>) {}
        fn turn_ended(&self, _session: u32, _outcome: TurnOutcome) {}
        fn settle(&self, _session: u32, _outcome: TurnOutcome) {}
        fn process_started(&self, _session: u32, _pid: u32) {}
        fn process_gone(&self, _session: u32) {}
    }

    #[test]
    fn a_second_adapter_drives_a_turn_without_claude_flags() {
        let adapter = Arc::new(EchoAdapter::default());
        let host = Arc::new(StoredEvents::default());
        let handle = ThreadHandle::start(7, adapter.clone(), None, 1, host.clone()).unwrap();
        handle.send("hello").unwrap();
        let events = host.events.lock().unwrap();
        let (events, wait) = host
            .changed
            .wait_timeout_while(events, Duration::from_secs(30), |events| {
                !events
                    .iter()
                    .any(|event| matches!(event, ThreadEventKind::TurnEnd { .. }))
            })
            .unwrap();
        assert!(!wait.timed_out(), "no turn end: {events:?}");
        assert!(
            matches!(&events[0], ThreadEventKind::UserMessage { text, .. } if text == "hello"),
            "{events:?}"
        );
        assert!(
            matches!(&events[1], ThreadEventKind::AssistantMessage { text, .. } if text == "hello"),
            "{events:?}"
        );
        assert!(
            matches!(
                &events[2],
                ThreadEventKind::TurnEnd {
                    outcome: TurnOutcome::Completed,
                    ..
                }
            ),
            "{events:?}"
        );
        drop(events);
        assert!(!handle.turn_open());
        let spawned = adapter.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 1);
        assert!(
            !spawned[0].args.iter().any(|arg| arg == "--input-format"),
            "{:?}",
            spawned[0].args
        );
        drop(spawned);
        handle.close();
    }
}

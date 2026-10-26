use super::*;
use crate::claude_stream::ClaudeStreamJson;
use crate::thread_session::{
    ApprovalAnswer, Conversation, DeferredHook, StructuredRuntime, ThreadCommandList, ThreadHost,
};
use std::sync::Weak;

/// Per-session history cap: whichever of these is reached first prunes the oldest events.
pub const THREAD_HISTORY_MAX_EVENTS: u64 = 20_000;
pub const THREAD_HISTORY_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Pruning goes below the cap by this share, so a full thread is not pruned on every event.
const THREAD_PRUNE_TO_PERCENT: u64 = 90;

struct DaemonThreadHost {
    daemon: Weak<Daemon>,
    usage: Mutex<Option<(u64, u64)>>,
    /// The last stored list, so the report at every turn's start writes only a change.
    commands: Mutex<Option<ThreadCommandList>>,
}

impl ThreadHost for DaemonThreadHost {
    fn store(&self, session: u32, event: &proto::ThreadEvent) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        let added = match daemon.db.thread_event_insert(session, event) {
            Ok(added) => added,
            Err(error) => {
                tracing::error!("{error:#}");
                return;
            }
        };
        let mut usage = self.usage.lock().expect("thread usage lock");
        let (events, bytes) = match *usage {
            Some((events, bytes)) => (events + 1, bytes + added),
            None => match daemon.db.thread_usage(session) {
                Ok(read) => read,
                Err(error) => {
                    tracing::warn!("reading thread history size of session {session}: {error:#}");
                    return;
                }
            },
        };
        *usage = Some((events, bytes));
        if events <= THREAD_HISTORY_MAX_EVENTS && bytes <= THREAD_HISTORY_MAX_BYTES {
            return;
        }
        let notice = format!(
            "Earlier messages were removed: a thread keeps at most {THREAD_HISTORY_MAX_EVENTS} \
             events or {} MiB of history.",
            THREAD_HISTORY_MAX_BYTES / (1024 * 1024)
        );
        match daemon.db.thread_prune(
            session,
            THREAD_HISTORY_MAX_EVENTS * THREAD_PRUNE_TO_PERCENT / 100,
            THREAD_HISTORY_MAX_BYTES * THREAD_PRUNE_TO_PERCENT / 100,
            &notice,
            now_ms(),
        ) {
            Ok(after) => *usage = Some(after),
            Err(error) => tracing::error!("pruning thread history of session {session}: {error:#}"),
        }
    }

    fn broadcast(&self, session: u32, events: Vec<proto::ThreadEvent>) {
        if let Some(daemon) = self.daemon.upgrade() {
            daemon.broadcast_control(&proto::ServerMsg::ThreadEvents { session, events });
        }
    }

    fn turn_ended(
        &self,
        session: u32,
        outcome: proto::TurnOutcome,
        deferred: Option<DeferredHook>,
    ) {
        if let Some(daemon) = self.daemon.upgrade() {
            daemon.thread_turn_ended(session, outcome, deferred);
        }
    }

    fn settle(&self, session: u32, outcome: proto::TurnOutcome) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        match outcome {
            proto::TurnOutcome::Interrupted => daemon.thread_settle(
                session,
                "thread_stop",
                crate::agent_events::AgentEvent::TurnInterrupted,
            ),
            _ => daemon.thread_settle(
                session,
                "thread_exit",
                crate::agent_events::AgentEvent::TurnFailed,
            ),
        }
    }

    fn process_started(&self, session: u32, pid: u32) {
        if let Some(daemon) = self.daemon.upgrade() {
            daemon.record_thread_group(session, pid);
        }
    }

    fn process_gone(&self, session: u32) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        if let Err(error) = daemon.db.clear_thread_group(session) {
            tracing::warn!("clearing thread session {session}'s process group: {error:#}");
        }
    }
    fn approvals_pending(&self, session: u32, pending: bool) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        let event = if pending {
            crate::agent_events::AgentEvent::NeedsInput
        } else {
            crate::agent_events::AgentEvent::InputResolved
        };
        daemon.apply_agent_event(session, THREAD_APPROVAL_SOURCE, event, false, false, None);
    }

    fn permission_mode_reported(&self, session: u32, mode: proto::ThreadPermissionMode) {
        if let Some(daemon) = self.daemon.upgrade() {
            if let Err(error) = daemon.persist_thread_permission_mode(session, mode) {
                tracing::warn!("recording session {session}'s permission mode: {error:#}");
            }
            daemon.broadcast_thread_info(session);
        }
    }

    fn commands_reported(&self, session: u32, list: ThreadCommandList) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        let mut last = self.commands.lock().expect("thread commands lock");
        if last.is_none() {
            *last = daemon.db.thread_commands(session).unwrap_or_else(|error| {
                tracing::warn!("reading session {session}'s thread commands: {error:#}");
                None
            });
        }
        if last.as_ref() == Some(&list) {
            return;
        }
        if let Err(error) = daemon.db.set_thread_commands(session, &list) {
            tracing::warn!("recording session {session}'s thread commands: {error:#}");
        }
        daemon.broadcast_control(&thread_commands_msg(session, &list));
        *last = Some(list);
    }

    fn stored_commands(&self, session: u32) -> Option<ThreadCommandList> {
        let daemon = self.daemon.upgrade()?;
        let mut last = self.commands.lock().expect("thread commands lock");
        if last.is_none() {
            *last = daemon.db.thread_commands(session).unwrap_or_else(|error| {
                tracing::warn!("reading session {session}'s thread commands: {error:#}");
                None
            });
        }
        last.clone()
    }

    fn title_reported(&self, session: u32, title: &str) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        if let Ok(live) = daemon.get(session) {
            daemon.name_pane_from_cli_title(session, &live, title);
        }
    }

    fn resume_refused(&self, session: u32, conversation: &str) {
        if let Some(daemon) = self.daemon.upgrade() {
            if let Err(error) = daemon.drop_refused_resume(session, conversation) {
                tracing::warn!(
                    "clearing session {session}'s refused resume handle {conversation}: {error:#}"
                );
            }
        }
    }

    fn conversation_reported(&self, session: u32, conversation: &str) {
        if let Some(daemon) = self.daemon.upgrade() {
            if let Err(error) = daemon.adopt_thread_conversation(session, conversation) {
                tracing::warn!(
                    "recording session {session}'s conversation {conversation} as its resume \
                     handle: {error:#}"
                );
            }
        }
    }

    fn queue_push(
        &self,
        session: u32,
        text: &str,
        excerpts: &[proto::ThreadExcerpt],
    ) -> Result<()> {
        let daemon = self.live_daemon()?;
        let message = proto::ThreadQueuedMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.to_string(),
            state: proto::QueuedState::Queued,
            hold_reason: None,
            created_at_ms: now_ms(),
            excerpts: excerpts.to_vec(),
        };
        let _publish = daemon.thread_queue_publish();
        let items = daemon
            .db
            .thread_queue_push(session, "thread_send", &message)?;
        daemon.broadcast_thread_queue(session, items);
        Ok(())
    }

    fn queue_take(
        &self,
        session: u32,
        id: Option<&str>,
    ) -> Result<Option<proto::ThreadQueuedMessage>> {
        let daemon = self.live_daemon()?;
        let _publish = daemon.thread_queue_publish();
        let Some((taken, items)) = daemon.db.thread_queue_take(session, id)? else {
            return Ok(None);
        };
        #[cfg(feature = "test-barriers")]
        crate::test_barriers::pause("thread-queue-publish", session);
        daemon.broadcast_thread_queue(session, items);
        Ok(Some(taken))
    }

    fn queue_sent(&self, session: u32, id: &str) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        if let Err(error) = daemon.db.thread_queue_sent(id) {
            tracing::error!("removing sent message {id} from session {session}'s queue: {error:#}");
        }
    }

    fn queue_waiting(&self, session: u32) -> Result<usize> {
        self.live_daemon()?.db.thread_queue_waiting(session)
    }

    fn queue_release(&self, session: u32, id: &str) -> Result<()> {
        let daemon = self.live_daemon()?;
        let _publish = daemon.thread_queue_publish();
        let items = daemon
            .db
            .thread_queue_release(session, id)?
            .ok_or_else(|| {
                anyhow!(
                "thread_queue_send refused for session {session}: message {id:?} is not in its \
                 queue; it was sent or removed"
            )
            })?;
        daemon.broadcast_thread_queue(session, items);
        Ok(())
    }

    fn queue_restore(&self, session: u32, message: &proto::ThreadQueuedMessage, reason: &str) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        let _publish = daemon.thread_queue_publish();
        // A respawn may have moved the message to the replacement row in the meantime.
        match daemon.db.thread_queue_restore(&message.id, reason) {
            Ok(Some((owner, items))) => daemon.broadcast_thread_queue(owner, items),
            Ok(None) => tracing::debug!(
                "message {} of session {session} left the queue before it could go back",
                message.id
            ),
            Err(error) => tracing::error!(
                "putting message {} back in session {session}'s queue: {error:#}",
                message.id
            ),
        }
    }

    fn queue_hold(&self, session: u32, reason: &str) {
        let Some(daemon) = self.daemon.upgrade() else {
            return;
        };
        let _publish = daemon.thread_queue_publish();
        match daemon.db.thread_queue_hold(session, reason) {
            Ok(Some(items)) => daemon.broadcast_thread_queue(session, items),
            Ok(None) => {}
            Err(error) => tracing::error!("holding session {session}'s queue: {error:#}"),
        }
    }
}

fn thread_commands_msg(session: u32, list: &ThreadCommandList) -> proto::ServerMsg {
    proto::ServerMsg::ThreadCommands {
        session,
        commands: list.commands.clone(),
        skills: list.skills.clone(),
        terminal_only: list.terminal_only.clone(),
    }
}

impl DaemonThreadHost {
    fn live_daemon(&self) -> Result<Arc<Daemon>> {
        self.daemon
            .upgrade()
            .ok_or_else(|| anyhow!("the daemon is shutting down"))
    }
}

/// How `thread_permission` answers a prompt: at once, or after the user decides.
pub(crate) enum PermissionPrompt {
    Answered(ApprovalAnswer),
    Held(
        tokio::sync::oneshot::Receiver<ApprovalAnswer>,
        ApprovalGuard,
    ),
}

/// A question Houston cannot show as choices is refused with this message, which sends it
/// into Claude's reply.
const ASK_IN_REPLY: &str = "Ask the question in your reply; Houston cannot show it as choices";

/// The status source of a permission request Houston itself holds for a thread.
const THREAD_APPROVAL_SOURCE: &str = "thread_approval";

/// The deny message Claude reads when the user gives no reason.
const DENIED_IN_HOUSTON: &str = "The user denied this tool call in Houston.";

/// Withdraws a held request when the MCP call ends without an answer.
pub(crate) struct ApprovalGuard {
    pub(super) handle: Arc<StructuredRuntime>,
    pub(super) request_id: String,
}

impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        self.handle.withdraw_approval(&self.request_id);
    }
}

/// What `spawn_session` hands over once a thread session's command is assembled.
pub(super) struct ThreadSpawn<'a> {
    pub id: u32,
    pub cmd: CommandBuilder,
    pub info: proto::SessionInfo,
    pub cols: u16,
    pub rows: u16,
    pub title_source: TitleSource,
    pub extra_env: Vec<(String, String)>,
    pub launch_selections: Option<crate::launch::SessionLaunchSelections>,
    pub command_override: bool,
    pub resume_handle: Option<ResumeHandle>,
    pub resumed: bool,
    pub preassigned: Option<String>,
    pub replacement: Option<SessionReplacement>,
    pub startup: &'a mut SessionStartup,
}

impl Daemon {
    /// The refusal every thread-only request gives a terminal session, naming its view.
    pub(super) fn thread_handle(&self, id: u32, verb: &str) -> Result<Arc<StructuredRuntime>> {
        let session = self.get(id)?;
        match session.thread() {
            Some(handle) => Ok(Arc::clone(handle)),
            None => bail!(
                "{verb} refused for session {id}: it is a terminal session (view {}); \
                 {verb} applies to thread sessions only",
                session.info.view.as_str()
            ),
        }
    }

    pub fn session_view(&self, id: u32) -> proto::SessionView {
        if let Ok(session) = self.get(id) {
            return session.info.view;
        }
        self.db
            .session_view(id)
            .unwrap_or(proto::SessionView::Terminal)
    }

    /// Sends at once, queues while a turn is open, or with `steer` goes ahead of the queue.
    pub fn thread_send(
        self: &Arc<Self>,
        id: u32,
        text: &str,
        steer: bool,
        excerpts: &[proto::ThreadExcerpt],
    ) -> Result<()> {
        ensure_excerpts(id, "thread_send", text, excerpts)?;
        self.ensure_thread_command(id, "thread_send", text, excerpts)?;
        let handle = self.thread_message_target(id, "thread_send")?;
        if steer {
            handle.send_steered(text, excerpts)
        } else {
            handle.send(text, excerpts)
        }
    }

    pub fn thread_queue_send(self: &Arc<Self>, id: u32, message: &str) -> Result<()> {
        self.thread_message_target(id, "thread_queue_send")?
            .send_queued(message)
    }

    pub fn thread_steer(self: &Arc<Self>, id: u32, message: &str) -> Result<()> {
        self.thread_message_target(id, "thread_steer")?
            .steer(message)
    }

    /// A live thread that may take a message now, refused by name otherwise.
    fn thread_message_target(&self, id: u32, verb: &str) -> Result<Arc<StructuredRuntime>> {
        let handle = self.thread_handle(id, verb)?;
        let state = *self.get(id)?.state.lock().expect("state lock");
        if !state.is_live() {
            bail!("{verb} refused for session {id}: it is {state:?}; restart it first");
        }
        self.ensure_not_closing(id, verb)?;
        self.ensure_not_switching(id, verb)?;
        Ok(handle)
    }

    pub fn thread_stop(self: &Arc<Self>, id: u32) -> Result<()> {
        self.thread_handle(id, "thread_stop")?.stop();
        Ok(())
    }

    pub fn thread_approve(
        &self,
        id: u32,
        request_id: &str,
        allow: bool,
        message: Option<String>,
    ) -> Result<()> {
        let handle = self.thread_handle(id, "thread_approve")?;
        let answer = if allow {
            ApprovalAnswer::Allow
        } else {
            ApprovalAnswer::Deny(
                message
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| DENIED_IN_HOUSTON.to_string()),
            )
        };
        handle.answer_approval(request_id, answer)
    }

    /// Restarts an idle thread with the new mode's flags and records the mode for respawn.
    pub fn thread_set_permission_mode(
        self: &Arc<Self>,
        id: u32,
        mode: proto::ThreadPermissionMode,
    ) -> Result<()> {
        let handle = self.thread_handle(id, "thread_set_permission_mode")?;
        if let Ok(Some(status @ (proto::AgentStatus::Working | proto::AgentStatus::NeedsInput))) =
            self.session_status(id)
        {
            bail!(
                "thread_set_permission_mode refused for session {id}: it is {}; change the \
                 permission mode once the turn ends or after Stop",
                status_name(status)
            );
        }
        if mode == proto::ThreadPermissionMode::Auto {
            if let Some(model) = self
                .db
                .session_launch_selections(id)?
                .and_then(|selections| selections.model)
                .filter(|model| {
                    crate::launch::model_blocks_auto_mode(proto::AgentKind::Claude, model)
                })
            {
                bail!(
                    "thread_set_permission_mode refused for session {id}: model {model:?} \
                     cannot run in auto mode; choose another mode"
                );
            }
        }
        if handle.permission_mode() == mode {
            return Ok(());
        }
        handle.set_permission_mode(mode)?;
        self.persist_thread_permission_mode(id, mode)
            .with_context(|| {
                format!(
                    "session {id} now runs in mode {} but Restart would not keep it",
                    mode.as_str()
                )
            })?;
        self.broadcast_thread_info(id);
        Ok(())
    }

    /// Records a thread's mode where Restart and restore read it.
    fn persist_thread_permission_mode(
        &self,
        id: u32,
        mode: proto::ThreadPermissionMode,
    ) -> Result<()> {
        let approval = crate::launch::ApprovalMode::from_thread(mode);
        match self.db.session_launch_selections(id)? {
            Some(mut selections) => {
                selections.approval = approval;
                self.db.set_session_launch_selections(id, &selections)
            }
            None => self.db.session_set_approval_mode(id, approval.as_str()),
        }
    }

    fn broadcast_thread_info(&self, id: u32) {
        if let Ok(session) = self.get(id) {
            let mut info = session.snapshot_info();
            info.compactions = self.compactions_of(&info);
            self.broadcast_control(&proto::ServerMsg::SessionUpdated { info });
        }
    }

    /// True while Houston holds a permission request of this thread: its status is
    /// NeedsInput and no tool activity may override it.
    pub(super) fn thread_approvals_pending(&self, id: u32) -> bool {
        self.get(id).is_ok_and(|session| {
            session
                .thread()
                .is_some_and(|handle| handle.has_pending_approvals())
        })
    }

    /// Holds Claude's permission prompt for a thread session until the user answers it.
    pub(crate) fn thread_permission_request(
        &self,
        id: u32,
        args: &serde_json::Value,
    ) -> Result<(PermissionPrompt, serde_json::Value)> {
        let handle = match self.get(id).map(|session| session.thread().cloned()) {
            Ok(Some(handle)) => handle,
            _ => bail!(
                "{} refused for session {id}: Houston answers permission prompts for thread \
                 sessions only, never for a terminal pane",
                crate::thread_session::PERMISSION_TOOL
            ),
        };
        let tool_name = args
            .get("tool_name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                anyhow!(
                    "{} needs a string \"tool_name\" and an object \"input\"; got {}",
                    crate::thread_session::PERMISSION_TOOL,
                    one_line(&args.to_string(), 200)
                )
            })?;
        let input = args
            .get("input")
            .filter(|input| input.is_object())
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "{} needs an object \"input\" with the tool's arguments; got {}",
                    crate::thread_session::PERMISSION_TOOL,
                    one_line(&args.to_string(), 200)
                )
            })?;
        let tool_use_id = args
            .get("tool_use_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if tool_name == super::thread_questions::ASK_USER_QUESTION {
            return match super::thread_questions::parse_questions(&input) {
                Ok((questions, truncated)) => {
                    self.hold_question(&handle, tool_use_id, questions, truncated, input)
                }
                Err(error) => Ok((
                    PermissionPrompt::Answered(ApprovalAnswer::Deny(format!(
                        "{ASK_IN_REPLY}: {error}."
                    ))),
                    input,
                )),
            };
        }
        let (request_id, receiver) = handle.request_approval(tool_name, tool_use_id, &input)?;
        Ok((
            PermissionPrompt::Held(receiver, ApprovalGuard { handle, request_id }),
            input,
        ))
    }

    /// Refuses a queue request for an unknown or terminal session, naming the verb.
    fn ensure_thread_session(&self, id: u32, verb: &str) -> Result<()> {
        if self.get(id).is_err() && !self.db.session_exists(id)? {
            bail!("{verb} refused for session {id}: unknown session");
        }
        let view = self.session_view(id);
        if view != proto::SessionView::Thread {
            bail!(
                "{verb} refused for session {id}: it is a terminal session (view {}); \
                 {verb} applies to thread sessions only",
                view.as_str()
            );
        }
        Ok(())
    }

    fn broadcast_thread_queue(&self, id: u32, items: Vec<proto::ThreadQueuedMessage>) {
        self.broadcast_control(&proto::ServerMsg::ThreadQueue { session: id, items });
    }

    /// Held from a queue change until its snapshot is broadcast, so snapshots reach clients
    /// in the order the changes were made. Taken after `op` and the runtime state, before
    /// the database.
    pub(super) fn thread_queue_publish(&self) -> std::sync::MutexGuard<'_, ()> {
        self.thread_queue_publish
            .lock()
            .expect("thread queue publish lock")
    }

    /// `thread_queue_list` answered on the connection's control channel, after every
    /// snapshot broadcast before it.
    pub fn thread_queue_reply(&self, id: u32, conn_id: u64) -> Result<()> {
        self.ensure_thread_session(id, "thread_queue_list")?;
        let _publish = self.thread_queue_publish();
        let items = self.db.thread_queue(id)?;
        self.send_control_to(
            conn_id,
            &proto::ServerMsg::ThreadQueue { session: id, items },
        );
        Ok(())
    }

    pub fn thread_queue_list(&self, id: u32) -> Result<proto::ServerMsg> {
        self.ensure_thread_session(id, "thread_queue_list")?;
        Ok(proto::ServerMsg::ThreadQueue {
            session: id,
            items: self.db.thread_queue(id)?,
        })
    }

    /// Empty lists before the thread's first turn: Claude reports its commands as a turn starts.
    pub fn thread_commands_list(&self, id: u32) -> Result<proto::ServerMsg> {
        self.ensure_thread_session(id, "thread_commands_list")?;
        let list = self.db.thread_commands(id)?.unwrap_or_default();
        Ok(thread_commands_msg(id, &list))
    }

    pub fn thread_queue_edit(&self, id: u32, message: &str, text: &str) -> Result<()> {
        self.ensure_thread_session(id, "thread_queue_edit")?;
        let not_queued = || {
            anyhow!(
                "thread_queue_edit refused for session {id}: message {message:?} is not in its \
                 queue; it was sent or removed"
            )
        };
        let excerpts = self
            .db
            .thread_queue(id)?
            .into_iter()
            .find(|row| row.id == message)
            .ok_or_else(not_queued)?
            .excerpts;
        ensure_excerpts(id, "thread_queue_edit", text, &excerpts)?;
        self.ensure_thread_command(id, "thread_queue_edit", text, &excerpts)?;
        let _publish = self.thread_queue_publish();
        let items = self
            .db
            .thread_queue_edit(id, message, text)?
            .ok_or_else(not_queued)?;
        self.broadcast_thread_queue(id, items);
        Ok(())
    }

    /// Refuses, by name, a message that would make Claude run a command that must not run
    /// from a thread (`claude_stream::command_refusal`), using the commands it last reported.
    pub(crate) fn ensure_thread_command(
        &self,
        id: u32,
        verb: &str,
        text: &str,
        excerpts: &[proto::ThreadExcerpt],
    ) -> Result<()> {
        let listed = self.db.thread_commands(id)?;
        match crate::claude_stream::command_refusal(text, !excerpts.is_empty(), listed.as_ref()) {
            Some(reason) => bail!("{verb} refused for session {id}: {reason}"),
            None => Ok(()),
        }
    }

    /// The session id Claude's stream reports becomes the resume handle that Restart, restore,
    /// a view switch and a handoff use, so `/clear` and a thread without hooks resume it. A
    /// hook that reported a transcript for the same id supplies it.
    fn adopt_thread_conversation(&self, id: u32, conversation: &str) -> Result<()> {
        let held = self.db.session_resume_handle(id)?;
        if let Some((current, transcript)) = &held {
            if current == conversation
                && (transcript.is_some() || self.db.session_resume_from_stream(id)?)
            {
                return Ok(());
            }
        }
        let (transcript, native) = self.db.session_transcript_link(id)?;
        let transcript = transcript.filter(|_| native.as_deref() == Some(conversation));
        self.db
            .set_session_stream_resume_handle(id, conversation, transcript.as_deref())?;
        if held.is_none() {
            self.broadcast_control(&proto::ServerMsg::SessionResumable {
                session: id,
                resumable: true,
            });
        }
        Ok(())
    }

    /// Claude no longer has the conversation the handle names, so Restart and a daemon
    /// restart would fail the same way: the handle goes until the stream reports a new one.
    fn drop_refused_resume(&self, id: u32, conversation: &str) -> Result<()> {
        let held = self.db.session_resume_handle(id)?;
        if held.is_some_and(|(current, _)| current == conversation) {
            self.db.set_session_resume_handle(id, None)?;
            self.broadcast_control(&proto::ServerMsg::SessionResumable {
                session: id,
                resumable: false,
            });
        }
        Ok(())
    }

    pub fn thread_queue_remove(&self, id: u32, message: &str) -> Result<()> {
        self.ensure_thread_session(id, "thread_queue_remove")?;
        let _publish = self.thread_queue_publish();
        let items = self.db.thread_queue_remove(id, message)?.ok_or_else(|| {
            anyhow!(
                "thread_queue_remove refused for session {id}: message {message:?} is not in its \
                 queue; it was sent or removed"
            )
        })?;
        self.broadcast_thread_queue(id, items);
        Ok(())
    }

    pub fn thread_history(
        &self,
        id: u32,
        before_seq: Option<u64>,
        limit: u32,
    ) -> Result<proto::ServerMsg> {
        if limit == 0 || limit > proto::THREAD_HISTORY_PAGE_MAX {
            bail!(
                "thread_history refused for session {id}: limit {limit} is outside 1 to {} \
                 (THREAD_HISTORY_PAGE_MAX)",
                proto::THREAD_HISTORY_PAGE_MAX
            );
        }
        if self.get(id).is_err() && !self.db.session_exists(id)? {
            bail!("thread_history refused for session {id}: unknown session");
        }
        let view = self.session_view(id);
        if view != proto::SessionView::Thread {
            bail!(
                "thread_history refused for session {id}: it is a terminal session (view {}); \
                 thread_history applies to thread sessions only",
                view.as_str()
            );
        }
        let (events, has_more) = self.db.thread_events_page(id, before_seq, limit)?;
        Ok(proto::ServerMsg::ThreadHistory {
            session: id,
            before_seq,
            events,
            has_more,
        })
    }

    /// `pane_read` for a thread: its latest stored assistant text and tool summaries.
    pub(crate) fn thread_read_lines(&self, id: u32, lines: usize) -> Result<Vec<String>> {
        let (events, _) = self
            .db
            .thread_events_page(id, None, proto::THREAD_HISTORY_PAGE_MAX)?;
        let mut out = Vec::new();
        for event in events {
            let text = match event.kind {
                proto::ThreadEventKind::AssistantMessage { text, .. } => text,
                proto::ThreadEventKind::ToolCall { name, input, .. } => {
                    format!("[tool {name}] {}", one_line(&input, 200))
                }
                proto::ThreadEventKind::ToolResult {
                    is_error, output, ..
                } => format!(
                    "[{}] {}",
                    if is_error {
                        "tool error"
                    } else {
                        "tool result"
                    },
                    one_line(&output, 200)
                ),
                proto::ThreadEventKind::TurnEnd { outcome, error } => match error {
                    Some(error) => format!("[turn {outcome:?}] {}", one_line(&error, 200)),
                    None => format!("[turn {outcome:?}]"),
                },
                proto::ThreadEventKind::Notice { text } => {
                    format!("[notice] {}", one_line(&text, 200))
                }
                proto::ThreadEventKind::ApprovalRequest {
                    tool_name, input, ..
                } => format!("[permission request {tool_name}] {}", one_line(&input, 200)),
                proto::ThreadEventKind::ApprovalResolved {
                    decision, reason, ..
                } => match reason {
                    Some(reason) => format!("[permission {decision:?}] {}", one_line(&reason, 200)),
                    None => format!("[permission {decision:?}]"),
                },
                proto::ThreadEventKind::QuestionRequest { questions, .. } => {
                    let asked: Vec<&str> = questions.iter().map(|q| q.question.as_str()).collect();
                    format!("[question] {}", one_line(&asked.join(" | "), 200))
                }
                proto::ThreadEventKind::QuestionResolved {
                    outcome,
                    answers,
                    reason,
                    ..
                } => {
                    let detail = answers
                        .iter()
                        .map(|a| {
                            let mut parts = a.selected.clone();
                            parts.extend(a.other.clone());
                            format!("{}={}", a.question, parts.join(", "))
                        })
                        .chain(reason)
                        .collect::<Vec<_>>()
                        .join(" | ");
                    format!("[question {outcome:?}] {}", one_line(&detail, 200))
                }
                proto::ThreadEventKind::UserMessage { .. }
                | proto::ThreadEventKind::AssistantDelta { .. }
                | proto::ThreadEventKind::ReasoningDelta { .. }
                | proto::ThreadEventKind::Reasoning { .. } => continue,
            };
            out.extend(text.lines().map(str::to_string));
        }
        let skip = out.len().saturating_sub(lines);
        Ok(out.split_off(skip))
    }

    /// The stream's `result` ends the turn while no lifecycle hook reports for this session,
    /// or when a `Stop` hook arrived while the turn was open (`deferred`); otherwise that
    /// hook owns the transition.
    fn thread_turn_ended(
        self: &Arc<Self>,
        id: u32,
        outcome: proto::TurnOutcome,
        deferred: Option<DeferredHook>,
    ) {
        let Ok(session) = self.get(id) else {
            return;
        };
        if session.lifecycle_hook_seen.load(Ordering::Acquire) && deferred.is_none() {
            return;
        }
        let event = match outcome {
            proto::TurnOutcome::Completed => crate::agent_events::AgentEvent::TurnEnded,
            proto::TurnOutcome::Interrupted => crate::agent_events::AgentEvent::TurnInterrupted,
            proto::TurnOutcome::Error => crate::agent_events::AgentEvent::TurnFailed,
        };
        let prompt_id = deferred.and_then(|hook| hook.prompt_id);
        self.apply_agent_event(
            id,
            "thread_result",
            event,
            false,
            true,
            prompt_id.as_deref(),
        );
    }

    fn record_thread_group(&self, id: u32, pid: u32) {
        let Some(group) = crate::thread_session::ThreadGroup::capture(pid) else {
            return;
        };
        let recorded = serde_json::to_string(&group)
            .map_err(anyhow::Error::from)
            .and_then(|json| self.db.set_thread_group(id, &json));
        if let Err(error) = recorded {
            tracing::warn!("recording thread session {id}'s process group: {error:#}");
        }
    }

    /// Kills what a thread's previous Claude left running after its daemon died.
    pub(super) fn reclaim_thread_group(&self, id: u32) -> Result<()> {
        let Some(json) = self.db.thread_group(id)? else {
            return Ok(());
        };
        let group: crate::thread_session::ThreadGroup =
            serde_json::from_str(&json).with_context(|| {
                format!("session {id}'s thread group {json:?} is not a ThreadGroup")
            })?;
        let stopped = group.reclaim()?;
        if stopped > 0 {
            tracing::info!(
                "session {id}: stopped {stopped} process(es) left in thread group {}",
                group.pgid
            );
        }
        Ok(())
    }

    /// Restores the thread sessions a handoff closed, resuming each conversation as a
    /// restart does: on the new generation, or here when the handoff failed.
    pub fn restore_handed_over_threads(self: &Arc<Self>, ids: &[u32]) {
        if ids.is_empty() {
            return;
        }
        match self.db.list_interrupted() {
            Ok(rows) => {
                let rows: Vec<_> = rows
                    .into_iter()
                    .filter(|info| ids.contains(&info.id) && !self.sessions_contain(info.id))
                    .collect();
                let mut dead = self.dead.lock().expect("dead lock");
                for info in rows {
                    dead.insert(info.id, info);
                }
            }
            Err(error) => {
                tracing::warn!("handoff: reading thread sessions {ids:?} to restore: {error:#}");
            }
        }
        for &id in ids {
            self.shutdown_preserved
                .lock()
                .expect("shutdown preserved lock")
                .remove(&id);
            // A parent's restore may already have restored this one as its child.
            let dead = self.dead.lock().expect("dead lock").contains_key(&id);
            if !dead && !self.sessions_contain(id) {
                continue;
            }
            if let Err(error) =
                self.respawn_with(id, true, None, None, false, RespawnConversation::Restore)
            {
                tracing::warn!("handoff: restoring thread session {id} failed: {error:#}");
                if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
                    info.restore_deferred = Some(proto::RestoreReason::SpawnFailed);
                    info.resume_notice = Some(format!(
                        "Thread session {id} was not restored after the daemon handoff: \
                         {error:#}"
                    ));
                }
            }
        }
    }

    fn sessions_contain(&self, id: u32) -> bool {
        self.sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&id)
    }

    /// The daemon ended the process itself, so no turn is running any more.
    fn thread_settle(
        self: &Arc<Self>,
        id: u32,
        source: &str,
        event: crate::agent_events::AgentEvent,
    ) {
        let idle = matches!(self.session_status(id), Ok(Some(proto::AgentStatus::Idle)));
        if !idle {
            self.apply_agent_event(id, source, event, false, true, None);
        }
    }

    pub(super) fn spawn_thread_session(
        self: &Arc<Self>,
        spawn: ThreadSpawn<'_>,
    ) -> Result<proto::SessionInfo> {
        let ThreadSpawn {
            id,
            cmd,
            mut info,
            cols,
            rows,
            title_source,
            extra_env,
            launch_selections,
            command_override,
            resume_handle,
            resumed,
            preassigned,
            replacement,
            startup,
        } = spawn;
        if let Some(replacement) = &replacement {
            self.reclaim_thread_group(replacement.id)?;
        }
        let (adapter, assembled) = ClaudeStreamJson::from_command(&cmd)?;
        let conversation = assembled.or_else(|| preassigned.clone().map(Conversation::New));
        let history_owner = replacement
            .as_ref()
            .map_or(id, |replacement| replacement.id);
        let next_seq = self
            .db
            .thread_max_seq(history_owner)?
            .map_or(1, |seq| seq + 1);
        let host = Arc::new(DaemonThreadHost {
            daemon: Arc::downgrade(self),
            usage: Mutex::new(None),
            commands: Mutex::new(None),
        });
        let permission_mode = adapter.permission_mode;
        let handle = StructuredRuntime::start(
            id,
            Arc::new(adapter),
            conversation,
            permission_mode,
            next_seq,
            host,
        )?;
        info.view = proto::SessionView::Thread;
        info.permission_mode = Some(handle.permission_mode());
        self.session_checkout_metadata(&mut info);
        let agent = info.agent;
        let session = Arc::new(Session {
            info: info.clone(),
            pid: None,
            custom_cmd: None,
            state: Mutex::new(proto::SessionState::Running),
            title: Mutex::new(info.title.clone()),
            project_dir: Mutex::new(info.project_dir.clone()),
            detected: Mutex::new(None),
            running: Mutex::new(None),
            blocks: None,
            shell_token_redactor: None,
            raw_output_bytes: AtomicU64::new(0),
            shell_token_file: None,
            shell: None,
            osc_cwd: Mutex::new(None),
            osc52: Mutex::new(crate::osc52::Osc52Scanner::new()),
            osc_title: None,
            composer_ready: None,
            composer_watch: AtomicBool::new(false),
            cli_title: Mutex::new(CliTitleState::default()),
            title_source: Mutex::new(title_source),
            title_revision: AtomicU64::new(0),
            title_excerpt: Mutex::new((None, None)),
            title_excerpt_closed: AtomicBool::new(true),
            title_profile_env: Self::agent_profile_config_dir(agent, &extra_env)
                .map(|directory| (Self::agent_profile_env_var(agent), directory.to_string())),
            transient_title_candidates: Mutex::new(Vec::new()),
            tags: Mutex::new(info.tags.clone()),
            acp: None,
            scrollback: Mutex::new(Scrollback::default()),
            scrollback_checkpointed: Mutex::new(None),
            ws_attaches: AtomicU32::new(0),
            vt: Mutex::new(None),
            vt_refused: AtomicBool::new(true),
            last_output: AtomicU64::new(self.started.elapsed().as_millis() as u64),
            status: Mutex::new(info.status),
            status_since_ms: Mutex::new(info.status_since_ms),
            context: Mutex::new(info.context),
            activity: Mutex::new(crate::session_activity::Tracker::default()),
            removed: AtomicBool::new(false),
            backend_exited: AtomicBool::new(false),
            lifecycle_hook_seen: AtomicBool::new(false),
            input_intervention: AtomicBool::new(false),
            input_pending: AtomicBool::new(false),
            input_current_id: Mutex::new(None),
            input_intervention_id: Mutex::new(None),
            input_intervention_answer: Mutex::new(None),
            hook_input_reason: Mutex::new(None),
            hook_permission_details: Mutex::new(None),
            hook_cwd: Mutex::new(None),
            hook_last_message: Mutex::new(None),
            hook_latest_prompt: Mutex::new(info.latest_prompt.clone()),
            hook_latest_agent_message: Mutex::new(info.last_agent_message.clone()),
            sleep_notice: Mutex::new(None),
            recovery_notice: Mutex::new(None),
            slept_at_ms: Mutex::new(info.slept_at_ms),
            limit: Mutex::new(None),
            geometry: AtomicU32::new((u32::from(cols) << 16) | u32::from(rows)),
            runtime: SessionRuntime::Structured(Arc::clone(&handle)),
        });
        startup.session = Some(Arc::clone(&session));
        let conversation_link = if resumed {
            resume_handle
                .as_ref()
                .map(|(conversation, transcript)| (transcript.clone(), Some(conversation.clone())))
        } else {
            preassigned.map(|conversation| (None, Some(conversation)))
        };
        self.db
            .insert_session_with_startup_metadata(
                &info,
                title_source.as_str(),
                Self::agent_profile_config_dir(agent, &extra_env),
                crate::db::SessionStartupMetadata {
                    process_identity: None,
                    launch_selections: launch_selections.as_ref(),
                    command_override,
                    resume_handle: resume_handle.as_ref().map(|(conversation, transcript)| {
                        (conversation.as_str(), transcript.as_deref())
                    }),
                    transcript_path: conversation_link
                        .as_ref()
                        .and_then(|link| link.0.as_deref()),
                    native_session_id: conversation_link
                        .as_ref()
                        .and_then(|link| link.1.as_deref()),
                    replacement: replacement
                        .as_ref()
                        .map(|replacement| (replacement.id, now_ms())),
                },
                || Ok(()),
            )
            .context(orchestrate::MutationMayHaveActed)?;
        match self.db.thread_unresolved_approvals(id) {
            Ok(orphans) => handle.settle_orphaned_approvals(orphans),
            Err(error) => tracing::warn!("reading unanswered approvals of session {id}: {error:#}"),
        }
        // The first process started before its row existed.
        if let Some(pid) = handle.pid() {
            self.record_thread_group(id, pid);
        }
        // A resume refused that early found no row whose handle it could drop.
        if let Some(conversation) = handle.refused_resume() {
            if let Err(error) = self.drop_refused_resume(id, &conversation) {
                tracing::warn!("clearing session {id}'s refused resume handle: {error:#}");
            }
        }
        // A daemon that died mid-turn stored no turn end; close it before any new message.
        if replacement.is_some() {
            match self.db.thread_turn_left_open(id) {
                Ok(true) => handle.end_stored_turn("Houston restarted while this turn ran."),
                Ok(false) => {}
                Err(error) => tracing::warn!("reading session {id}'s last thread turn: {error:#}"),
            }
        }
        self.sessions
            .lock()
            .expect("sessions lock")
            .insert(id, Arc::clone(&session));
        self.write_run_state();
        self.reap_reevaluate();
        self.record_launch_conversation(id, resumed, conversation_link);
        let mut created = info.clone();
        created.compactions = self.compactions_of(&created);
        self.broadcast_control(&proto::ServerMsg::SessionCreated { info: created });
        startup.committed = true;
        startup.gate.finish(true);

        let daemon = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("thread-life-{id}"))
            .spawn(move || {
                handle.wait_closed();
                let parent = daemon.parent_of(id);
                daemon.finish_session(id, None);
                daemon.publish_session_exit(id, &session, None);
                if let Some(parent) = parent {
                    daemon.broadcast_live_children(parent);
                }
                daemon.delegation_child_exited(id, None);
                daemon.routine_pane_exited(id);
            })
            .context(orchestrate::MutationMayHaveActed)?;
        Ok(info)
    }
}

/// A message Claude will read: not empty and within `THREAD_USER_MESSAGE_MAX_BYTES`.
fn ensure_message_text(id: u32, verb: &str, text: &str) -> Result<()> {
    if text.len() > proto::THREAD_USER_MESSAGE_MAX_BYTES {
        bail!(
            "{verb} refused for session {id}: the message is {} bytes, over the {} byte \
             limit (THREAD_USER_MESSAGE_MAX_BYTES)",
            text.len(),
            proto::THREAD_USER_MESSAGE_MAX_BYTES
        );
    }
    if text.trim().is_empty() {
        bail!("{verb} refused for session {id}: the message is empty");
    }
    Ok(())
}

/// Pane names are short; a longer source is not a pane name.
const EXCERPT_SOURCE_MAX_BYTES: usize = 256;

/// A message with terminal excerpts: within `THREAD_EXCERPTS_MAX` and
/// `THREAD_EXCERPT_MAX_BYTES`, and, composed for Claude, within `THREAD_USER_MESSAGE_MAX_BYTES`.
/// Its text may be blank when an excerpt carries the question.
fn ensure_excerpts(
    id: u32,
    verb: &str,
    text: &str,
    excerpts: &[proto::ThreadExcerpt],
) -> Result<()> {
    if excerpts.is_empty() {
        return ensure_message_text(id, verb, text);
    }
    if excerpts.len() > proto::THREAD_EXCERPTS_MAX {
        bail!(
            "{verb} refused for session {id}: the message has {} excerpts, the limit \
             (THREAD_EXCERPTS_MAX) is {}; remove one to send it",
            excerpts.len(),
            proto::THREAD_EXCERPTS_MAX
        );
    }
    for (at, excerpt) in excerpts.iter().enumerate() {
        let source = one_line(&excerpt.source, 60);
        if excerpt.source.trim().is_empty() || excerpt.source.len() > EXCERPT_SOURCE_MAX_BYTES {
            bail!(
                "{verb} refused for session {id}: excerpt {} names its pane as {source:?} ({} \
                 bytes); expected a pane name of 1 to {EXCERPT_SOURCE_MAX_BYTES} bytes",
                at + 1,
                excerpt.source.len()
            );
        }
        if excerpt.text.trim().is_empty() {
            bail!(
                "{verb} refused for session {id}: excerpt {} from pane {source:?} is empty",
                at + 1
            );
        }
        if excerpt.text.len() > proto::THREAD_EXCERPT_MAX_BYTES {
            bail!(
                "{verb} refused for session {id}: excerpt {} from pane {source:?} is {} bytes, \
                 over the {} byte limit (THREAD_EXCERPT_MAX_BYTES)",
                at + 1,
                excerpt.text.len(),
                proto::THREAD_EXCERPT_MAX_BYTES
            );
        }
    }
    let composed = crate::thread_session::compose_message(text, excerpts).len();
    if composed > proto::THREAD_USER_MESSAGE_MAX_BYTES {
        bail!(
            "{verb} refused for session {id}: the message with its excerpts is {composed} bytes, \
             over the {} byte limit (THREAD_USER_MESSAGE_MAX_BYTES)",
            proto::THREAD_USER_MESSAGE_MAX_BYTES
        );
    }
    Ok(())
}

fn status_name(status: proto::AgentStatus) -> &'static str {
    match status {
        proto::AgentStatus::Working => "working",
        proto::AgentStatus::NeedsInput => "waiting for input",
        _ => "busy",
    }
}

pub(super) fn one_line(text: &str, max_chars: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(max_chars) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
    }
}

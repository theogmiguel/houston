use super::*;
use crate::claude_stream::ClaudeStreamJson;
use crate::thread_session::{Conversation, ThreadHandle, ThreadHost};
use std::sync::Weak;

/// Per-session history cap: whichever of these is reached first prunes the oldest events.
pub const THREAD_HISTORY_MAX_EVENTS: u64 = 20_000;
pub const THREAD_HISTORY_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Pruning goes below the cap by this share, so a full thread is not pruned on every event.
const THREAD_PRUNE_TO_PERCENT: u64 = 90;

struct DaemonThreadHost {
    daemon: Weak<Daemon>,
    usage: Mutex<Option<(u64, u64)>>,
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

    fn turn_ended(&self, session: u32, outcome: proto::TurnOutcome) {
        if let Some(daemon) = self.daemon.upgrade() {
            daemon.thread_turn_ended(session, outcome);
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
    fn thread_handle(&self, id: u32, verb: &str) -> Result<Arc<ThreadHandle>> {
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

    pub fn thread_send(self: &Arc<Self>, id: u32, text: &str) -> Result<()> {
        if text.len() > proto::THREAD_USER_MESSAGE_MAX_BYTES {
            bail!(
                "thread_send refused for session {id}: the message is {} bytes, over the {} byte \
                 limit (THREAD_USER_MESSAGE_MAX_BYTES)",
                text.len(),
                proto::THREAD_USER_MESSAGE_MAX_BYTES
            );
        }
        if text.trim().is_empty() {
            bail!("thread_send refused for session {id}: the message is empty");
        }
        let handle = self.thread_handle(id, "thread_send")?;
        let state = *self.get(id)?.state.lock().expect("state lock");
        if !state.is_live() {
            bail!("thread_send refused for session {id}: it is {state:?}; restart it first");
        }
        self.ensure_not_closing(id, "thread_send")?;
        handle.send(text)
    }

    pub fn thread_stop(self: &Arc<Self>, id: u32) -> Result<()> {
        self.thread_handle(id, "thread_stop")?.stop();
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
                proto::ThreadEventKind::UserMessage { .. }
                | proto::ThreadEventKind::AssistantDelta { .. } => continue,
            };
            out.extend(text.lines().map(str::to_string));
        }
        let skip = out.len().saturating_sub(lines);
        Ok(out.split_off(skip))
    }

    /// The stream's `result` ends the turn only while no lifecycle hook reports for this
    /// session; otherwise its `Stop` hook owns the transition.
    fn thread_turn_ended(self: &Arc<Self>, id: u32, outcome: proto::TurnOutcome) {
        let Ok(session) = self.get(id) else {
            return;
        };
        if session.lifecycle_hook_seen.load(Ordering::Acquire) {
            return;
        }
        let event = match outcome {
            proto::TurnOutcome::Completed => crate::agent_events::AgentEvent::TurnEnded,
            proto::TurnOutcome::Interrupted => crate::agent_events::AgentEvent::TurnInterrupted,
            proto::TurnOutcome::Error => crate::agent_events::AgentEvent::TurnFailed,
        };
        self.apply_agent_event(id, "thread_result", event, false, true, None);
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
        });
        let handle = ThreadHandle::start(id, Arc::new(adapter), conversation, next_seq, host)?;
        info.view = proto::SessionView::Thread;
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
        // The first process started before its row existed.
        if let Some(pid) = handle.pid() {
            self.record_thread_group(id, pid);
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

fn one_line(text: &str, max_chars: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(max_chars) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
    }
}

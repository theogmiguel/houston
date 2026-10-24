use super::*;

const DEFAULT_VIEW_SETTING: &str = "default_view";

/// The notice a thread shows for the turns its session took as a terminal.
pub(crate) fn terminal_turns_notice(turns: u64) -> String {
    if turns == 1 {
        "1 turn happened in the terminal; this thread does not show it.".to_string()
    } else {
        format!("{turns} turns happened in the terminal; this thread does not show them.")
    }
}

fn status_word(status: proto::AgentStatus) -> &'static str {
    match status {
        proto::AgentStatus::Spawning => "Starting",
        proto::AgentStatus::Working => "Working",
        proto::AgentStatus::Idle => "Idle",
        proto::AgentStatus::NeedsInput => "Needs input",
        proto::AgentStatus::Unavailable => "Unavailable",
    }
}

fn verb(view: proto::SessionView) -> &'static str {
    match view {
        proto::SessionView::Thread => "Open as thread",
        proto::SessionView::Terminal => "Open in terminal",
    }
}

impl Daemon {
    pub fn default_view(&self) -> proto::SessionView {
        match self
            .db
            .get_setting(DEFAULT_VIEW_SETTING)
            .ok()
            .flatten()
            .as_deref()
        {
            Some("thread") => proto::SessionView::Thread,
            _ => proto::SessionView::Terminal,
        }
    }

    pub fn set_default_view(&self, view: proto::SessionView) -> Result<()> {
        self.db.set_setting(DEFAULT_VIEW_SETTING, view.as_str())?;
        self.broadcast_control(&proto::ServerMsg::DefaultView { view });
        Ok(())
    }

    /// A Claude terminal's turn end, counted for the notice a later thread view shows.
    pub(super) fn note_terminal_turn(&self, id: u32) {
        let Ok(session) = self.get(id) else { return };
        if session.info.agent != proto::AgentKind::Claude
            || session.info.view != proto::SessionView::Terminal
        {
            return;
        }
        if let Err(error) = self.db.add_terminal_turn(id) {
            tracing::warn!("counting a terminal turn of session {id}: {error:#}");
        }
    }

    /// Refuses input to a session while it moves to another view.
    pub(super) fn ensure_not_switching(&self, id: u32, operation: &str) -> Result<()> {
        if self
            .switching_views
            .lock()
            .expect("switching views lock")
            .contains(&id)
        {
            bail!("{operation} refused: session {id} is moving to another view");
        }
        Ok(())
    }

    /// Checks a switch: the session must be a live, idle Claude conversation in the other
    /// view that a respawn may replace. Runs before the switch and again under the lifecycle
    /// lock just before the old process stops.
    fn ensure_switchable(&self, id: u32, view: proto::SessionView) -> Result<proto::SessionView> {
        let verb = verb(view);
        let session = match self.get(id) {
            Ok(session) => session,
            Err(_) if self.dead.lock().expect("dead lock").contains_key(&id) => bail!(
                "{verb} refused for session {id}: it is not running; restart or wake it first"
            ),
            Err(error) => return Err(error.context(format!("{verb} refused"))),
        };
        let agent = session.info.agent;
        if agent != proto::AgentKind::Claude {
            bail!(
                "{verb} refused for session {id}: view switching supports Claude only; {} \
                 sessions stay terminals",
                crate::agent_hooks::provider_slug(agent)
            );
        }
        if let Some(slug) = &session.info.acp {
            bail!("{verb} refused for session {id}: ACP agent {slug:?} runs as a terminal only");
        }
        if session.custom_cmd.is_some() {
            bail!("{verb} refused for session {id}: it runs a custom command, which has no thread view");
        }
        if session.info.hidden {
            bail!("{verb} refused for session {id}: it is a hidden helper session");
        }
        let state = *session.state.lock().expect("state lock");
        if state == proto::SessionState::Sleeping
            || self
                .sleeping_sessions
                .lock()
                .expect("sleeping sessions lock")
                .contains(&id)
        {
            bail!("{verb} refused for session {id}: it is sleeping; wake it first");
        }
        if !state.is_live() {
            bail!("{verb} refused for session {id}: it is {state:?}; restart it first");
        }
        if let Some(agent) = self.db.swarm_agent_by_session(id)? {
            bail!(
                "{verb} refused for session {id}: it is swarm agent {} of swarm {}, which \
                 resumes through its swarm",
                agent.id,
                agent.swarm
            );
        }
        let (live_children, _) = self.child_counts_of(id);
        if live_children > 0 {
            bail!(
                "{verb} refused for session {id}: {live_children} live child pane(s) would lose \
                 their handback target; close or wait for them first"
            );
        }
        let current = session.info.view;
        if current == view {
            bail!(
                "{verb} refused for session {id}: it is already a {} session",
                view.as_str()
            );
        }
        if let Some(handle) = session.thread() {
            if handle.has_pending_approvals() {
                bail!(
                    "{verb} refused for session {id}: Claude is waiting for an answer to a \
                     permission request; allow or deny it first"
                );
            }
        }
        let status = *session.status.lock().expect("status lock");
        if let Some(
            status @ (proto::AgentStatus::Working
            | proto::AgentStatus::Spawning
            | proto::AgentStatus::NeedsInput),
        ) = status
        {
            bail!(
                "{verb} refused for session {id}: Claude's status is {}; wait for the turn to \
                 end or stop it first",
                status_word(status)
            );
        }
        if let Some(handle) = session.thread() {
            if handle.turn_open() {
                bail!(
                    "{verb} refused for session {id}: a thread turn is still open; wait for it \
                     to end or stop it first"
                );
            }
        }
        Ok(current)
    }

    /// Moves a Claude session to `view`: an exact-ID respawn of the same conversation, which
    /// keeps its name, children and resume handle. Terminal turns become one thread notice.
    pub fn set_session_view(
        self: &Arc<Self>,
        id: u32,
        view: proto::SessionView,
    ) -> Result<proto::SessionInfo> {
        let _switching = SwitchingMark::claim(self, id, verb(view))?;
        let current = self.ensure_switchable(id, view)?;
        #[cfg(feature = "test-barriers")]
        crate::test_barriers::pause("view-switch-checked", id);
        let turns = if view == proto::SessionView::Thread {
            self.db.terminal_turns(id)?
        } else {
            0
        };
        // Without a handle the new view starts a new conversation; say so when context existed.
        let conversation = if self.db.session_resume_handle(id)?.is_none()
            && (turns > 0 || self.db.thread_usage(id)?.0 > 0)
        {
            RespawnConversation::Fallback(format!(
                "Started a fresh CLI: session {id} has no resume handle"
            ))
        } else {
            RespawnConversation::Resume
        };
        let notice = (turns > 0).then(|| terminal_turns_notice(turns));
        let notice_seq = self
            .db
            .begin_view_switch(id, view, notice.as_deref(), now_ms())?;
        let precheck = || self.ensure_switchable(id, view).map(|_| ());
        match self.respawn_checked(id, true, None, None, true, conversation, &precheck) {
            Ok(info) => {
                if let Err(error) = self.db.set_terminal_turns(info.id, 0) {
                    tracing::warn!(
                        "resetting the terminal turns of session {}: {error:#}",
                        info.id
                    );
                }
                Ok(info)
            }
            Err(error) => {
                if let Err(undo) = self.db.undo_view_switch(id, current, notice_seq) {
                    tracing::warn!(
                        "restoring view {} of session {id}: {undo:#}",
                        current.as_str()
                    );
                }
                Err(error.context(format!("{} failed for session {id}", verb(view))))
            }
        }
    }
}

/// Marks a session as switching for the life of the switch.
struct SwitchingMark<'a> {
    daemon: &'a Daemon,
    id: u32,
}

impl<'a> SwitchingMark<'a> {
    fn claim(daemon: &'a Daemon, id: u32, verb: &str) -> Result<Self> {
        if !daemon
            .switching_views
            .lock()
            .expect("switching views lock")
            .insert(id)
        {
            bail!("{verb} refused for session {id}: it is already moving to another view");
        }
        Ok(Self { daemon, id })
    }
}

impl Drop for SwitchingMark<'_> {
    fn drop(&mut self) {
        self.daemon
            .switching_views
            .lock()
            .expect("switching views lock")
            .remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_turns_notice_counts_in_words() {
        assert_eq!(
            terminal_turns_notice(1),
            "1 turn happened in the terminal; this thread does not show it."
        );
        assert_eq!(
            terminal_turns_notice(3),
            "3 turns happened in the terminal; this thread does not show them."
        );
    }
}

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

    /// Checks a switch before anything stops: the session must be an idle Claude conversation
    /// in the other view.
    fn ensure_switchable(&self, id: u32, view: proto::SessionView) -> Result<proto::SessionView> {
        let verb = verb(view);
        let session = self.get(id).with_context(|| format!("{verb} refused"))?;
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
        let current = session.info.view;
        if current == view {
            bail!(
                "{verb} refused for session {id}: it is already a {} session",
                view.as_str()
            );
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
        if let Backend::Thread(handle) = &session.backend {
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
        let current = self.ensure_switchable(id, view)?;
        let turns = if view == proto::SessionView::Thread {
            self.db.terminal_turns(id)?
        } else {
            0
        };
        let notice_seq = if turns > 0 {
            let seq = self.db.thread_max_seq(id)?.map_or(1, |max| max + 1);
            self.db.thread_event_insert(
                id,
                &proto::ThreadEvent {
                    seq,
                    at_ms: now_ms(),
                    kind: proto::ThreadEventKind::Notice {
                        text: terminal_turns_notice(turns),
                    },
                },
            )?;
            Some(seq)
        } else {
            None
        };
        self.db.set_session_view(id, view)?;
        match self.respawn_with(id, true, None, None, true, RespawnConversation::Resume) {
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
                if let Err(undo) = self.db.set_session_view(id, current) {
                    tracing::warn!(
                        "restoring view {} of session {id}: {undo:#}",
                        current.as_str()
                    );
                }
                if let Some(seq) = notice_seq {
                    if let Err(undo) = self.db.thread_event_delete(id, seq) {
                        tracing::warn!(
                            "removing the terminal turns notice of session {id}: {undo:#}"
                        );
                    }
                }
                Err(error.context(format!("{} failed for session {id}", verb(view))))
            }
        }
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

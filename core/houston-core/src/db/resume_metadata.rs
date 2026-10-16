use super::Db;
use crate::agent_events::{names_root_conversation, AgentEvent};
use crate::hook_drop::{DropName, HookDrop};
use anyhow::Result;
use houston_protocol as proto;
use rusqlite::OptionalExtension;
use std::path::Path;

/// Whether a drop can name its pane's root conversation: the only drops recovery records.
pub(crate) fn names_root_conversation_event(provider: proto::AgentKind, drop: &HookDrop) -> bool {
    crate::launch::resumes_conversations(provider)
        && names_root_conversation(provider, &drop.event)
        && drop.agent_id.is_none()
        && drop.subagent_type.is_none()
        && matches!(
            AgentEvent::from_provider(provider, &drop.event),
            Some(AgentEvent::SessionStarted | AgentEvent::PromptSubmitted | AgentEvent::TurnEnded)
        )
}

pub struct RootHookMetadata {
    pub cwd: String,
    pub transcript_path: Option<String>,
    pub conversation: String,
    pub resumable: bool,
    pub was_resumable: bool,
}

impl Db {
    pub fn session_resume_binding(&self, id: u32) -> Result<Option<(String, String)>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT resume_agent, resume_cwd FROM sessions WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?
            .and_then(|(agent, cwd)| agent.zip(cwd)))
    }

    pub fn check_session_resume_binding(
        &self,
        id: u32,
        provider: proto::AgentKind,
        cwd: &Path,
    ) -> std::result::Result<(), String> {
        let binding = self
            .session_resume_binding(id)
            .map_err(|error| format!("reading session {id}'s resume binding: {error:#}"))?;
        let Some((agent, recorded_cwd)) = binding else {
            return Err(format!("session {id}'s stored conversation has no validated provider and folder binding; a new root turn is required before exact resume"));
        };
        let expected = crate::agent_hooks::provider_slug(provider);
        if agent != expected {
            return Err(format!("session {id}'s stored conversation belongs to {agent}, but the selected provider is {expected}"));
        }
        if Path::new(&recorded_cwd) != cwd {
            return Err(format!("session {id}'s stored conversation belongs to folder {recorded_cwd}, but the selected folder is {}", cwd.display()));
        }
        Ok(())
    }

    pub fn session_has_bound_resume_handle(&self, id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1 AND resume_session_id IS NOT NULL
                AND resume_agent = CASE WHEN agent = 'shell' THEN detected_agent ELSE agent END
                AND resume_cwd = cwd)",
            [id],
            |row| row.get(0),
        )?)
    }

    pub fn root_hook_recovery_session_ids(&self) -> Result<Vec<u32>> {
        let conn = self.conn.lock().expect("db lock");
        let mut statement = conn.prepare(
            "SELECT id FROM sessions WHERE state IN ('interrupted', 'exited')
                AND agent IN ('claude', 'codex', 'zcode', 'shell') AND acp IS NULL
                AND NOT EXISTS(SELECT 1 FROM routine_runs WHERE session_id = sessions.id)
                AND NOT EXISTS(SELECT 1 FROM swarm_agents WHERE session_id = sessions.id)",
        )?;
        let ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<u32>, _>>()?;
        Ok(ids)
    }

    /// Commit only root conversation metadata. Recovery never applies lifecycle or input.
    pub fn record_root_hook_metadata(
        &self,
        drop: &HookDrop,
        provider: proto::AgentKind,
        order: DropName,
        recovery: bool,
    ) -> Result<Option<RootHookMetadata>> {
        if !names_root_conversation_event(provider, drop) {
            return Ok(None);
        }
        let event = AgentEvent::from_provider(provider, &drop.event);
        let Some(conversation) = drop.session_id.as_deref().filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }) else {
            return Ok(None);
        };
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let row = tx
            .query_row(
                "SELECT agent, detected_agent, cwd, state, acp, native_session_id,
                    transcript_path, resume_session_id, resume_agent, resume_cwd,
                    root_hook_ms, root_hook_seq, profile_config_dir,
                    EXISTS(SELECT 1 FROM routine_runs WHERE session_id = sessions.id),
                    EXISTS(SELECT 1 FROM swarm_agents WHERE session_id = sessions.id)
             FROM sessions WHERE id = ?1",
                [drop.session],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, Option<String>>(9)?,
                        r.get::<_, Option<u64>>(10)?,
                        r.get::<_, Option<u32>>(11)?,
                        r.get::<_, Option<String>>(12)?,
                        r.get::<_, bool>(13)?,
                        r.get::<_, bool>(14)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            agent,
            detected,
            old_cwd,
            state,
            acp,
            old_conversation,
            old_transcript,
            old_handle,
            bound_agent,
            bound_cwd,
            last_ms,
            last_seq,
            old_profile,
            routine,
            swarm,
        )) = row
        else {
            return Ok(None);
        };
        let slug = crate::agent_hooks::provider_slug(provider);
        let effective = if agent == "shell" {
            detected.as_deref()
        } else {
            Some(agent.as_str())
        };
        let eligible = acp.is_none() && !routine && !swarm;
        if (agent != "shell" && agent != slug)
            || (recovery && !eligible)
            || (recovery && !matches!(state.as_str(), "interrupted" | "exited"))
            || (!recovery
                && !matches!(
                    state.as_str(),
                    "running" | "working" | "awaiting_input" | "awaiting_approval" | "exited"
                ))
            || order.session != drop.session
            || last_ms.is_some_and(|ms| {
                order.ms < ms
                    || ((recovery || last_seq == Some(u32::MAX))
                        && (order.ms, order.seq) <= (ms, last_seq.unwrap_or(0)))
            })
        {
            return Ok(None);
        }
        // An absent cwd cannot establish a binding during recovery. Ordinary hooks
        // may omit it, in which case the current persisted root cwd is unchanged.
        let cwd = match drop.cwd.as_deref() {
            Some(cwd)
                if cwd.len() <= 4096 && Path::new(cwd).is_absolute() && Path::new(cwd).is_dir() =>
            {
                cwd
            }
            None if !recovery => old_cwd.as_str(),
            _ => return Ok(None),
        };
        let transcript = match drop
            .transcript_path
            .as_deref()
            .filter(|path| !path.is_empty())
        {
            Some(path) if path.len() <= 4096 && Path::new(path).is_absolute() => {
                Some(path.to_string())
            }
            Some(_) => return Ok(None),
            None if effective == Some(slug)
                && old_conversation.as_deref() == Some(conversation) =>
            {
                old_transcript
            }
            None => None,
        };
        let profile = match drop.resume_evidence.as_ref() {
            Some(evidence) => evidence.profile_dir.clone(),
            None if effective == Some(slug) => old_profile.clone(),
            None => None,
        };
        if profile
            .as_deref()
            .is_some_and(|path| path.len() > 4096 || !Path::new(path).is_absolute())
        {
            return Ok(None);
        }
        let was_resumable = old_handle.is_some()
            && bound_agent.as_deref() == effective
            && bound_cwd.as_deref() == Some(old_cwd.as_str());
        let same_binding = effective == Some(slug) && old_cwd == cwd && old_profile == profile;
        let turn = eligible
            && matches!(
                event,
                Some(AgentEvent::PromptSubmitted | AgentEvent::TurnEnded)
            );
        let retained = eligible && was_resumable && same_binding;
        // A fresh startup has no turn. An older handle stays eligible only in
        // the same namespace; preserve rejected handles for diagnostics and retry.
        tx.execute(
            "UPDATE sessions SET detected_agent = CASE WHEN agent = 'shell' THEN ?2 ELSE detected_agent END,
                cwd = ?3, native_session_id = ?4, transcript_path = ?5,
                profile_config_dir = ?6,
                profile_label = CASE WHEN profile_config_dir IS ?6 AND ?7 THEN profile_label ELSE NULL END,
                resume_session_id = CASE WHEN ?8 THEN ?4 ELSE resume_session_id END,
                resume_transcript_path = CASE WHEN ?8 THEN ?5 ELSE resume_transcript_path END,
                resume_agent = CASE WHEN ?8 THEN ?2 WHEN ?11 THEN NULL ELSE resume_agent END,
                resume_cwd = CASE WHEN ?8 THEN ?3 WHEN ?11 THEN NULL ELSE resume_cwd END,
                root_hook_ms = ?9, root_hook_seq = ?10 WHERE id = ?1",
            rusqlite::params![drop.session, slug, cwd, conversation, transcript, profile,
                effective == Some(slug), turn, order.ms, order.seq,
                effective == Some(slug) && old_profile != profile],
        )?;
        tx.commit()?;
        Ok(Some(RootHookMetadata {
            cwd: cwd.to_string(),
            transcript_path: transcript,
            conversation: conversation.to_string(),
            resumable: turn || retained,
            was_resumable,
        }))
    }

    pub fn root_hook_is_newer(&self, id: u32, order: DropName) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let previous = conn
            .query_row(
                "SELECT root_hook_ms, root_hook_seq FROM sessions WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, Option<u64>>(0)?, row.get::<_, Option<u32>>(1)?)),
            )
            .optional()?;
        Ok(previous.is_none_or(|(ms, seq)| {
            ms.is_none_or(|ms| order.ms > ms || (order.ms == ms && seq != Some(u32::MAX)))
        }))
    }

    /// Shell OSC cwd supersedes older hook drops, including drops not drained yet.
    pub fn record_shell_cwd(&self, id: u32, cwd: &str, observed_ms: u64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE sessions SET cwd = ?2,
                    root_hook_ms = MAX(COALESCE(root_hook_ms, 0), ?3), root_hook_seq = 4294967295
             WHERE id = ?1 AND agent = 'shell' AND cwd != ?2
                 AND (root_hook_ms IS NULL OR root_hook_ms <= ?3)
                 AND state IN ('running', 'working', 'awaiting_input', 'awaiting_approval', 'interrupted')",
            rusqlite::params![id, cwd, observed_ms],
        )? != 0)
    }
}

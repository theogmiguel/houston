use super::*;

impl Daemon {
    pub fn generated_titles_enabled(&self) -> bool {
        self.db
            .get_setting("generated_titles")
            .ok()
            .flatten()
            .as_deref()
            == Some("1")
    }

    pub fn set_generated_titles(&self, enabled: bool) -> Result<()> {
        self.db
            .set_setting("generated_titles", if enabled { "1" } else { "0" })?;
        self.broadcast_control(&proto::ServerMsg::GeneratedTitles { enabled });
        Ok(())
    }

    fn note_title_excerpt(
        &self,
        id: u32,
        provider: proto::AgentKind,
        drop: &crate::hook_drop::HookDrop,
    ) {
        let Ok(session) = self.get(id) else { return };
        if session.info.hidden
            || drop.internal_prompt
            || drop.agent_id.is_some()
            || drop.subagent_type.is_some()
            || session.title_excerpt_closed.load(Ordering::Relaxed)
        {
            return;
        }
        let mut excerpt = session.title_excerpt.lock().expect("title excerpt lock");
        if session.title_excerpt_closed.load(Ordering::Relaxed) {
            return;
        }
        let event = crate::agent_events::AgentEvent::from_provider(provider, &drop.event);
        if excerpt.0.is_none() && event == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            excerpt.0 = drop.prompt.as_deref().map(bounded_hook_text);
        }
        if event == Some(crate::agent_events::AgentEvent::TurnEnded) && !drop.stop_continued {
            session.title_excerpt_closed.store(true, Ordering::Relaxed);
        }
        if excerpt.0.is_some()
            && excerpt.1.is_none()
            && event == Some(crate::agent_events::AgentEvent::TurnEnded)
            && !drop.stop_continued
        {
            excerpt.1 = drop.last_message.as_deref().map(bounded_hook_text);
        }
    }

    fn maybe_generate_title(self: &Arc<Self>, id: u32) {
        if !self.db.claim_title_first_turn(id).unwrap_or(false) || !self.generated_titles_enabled()
        {
            return;
        }
        if let Err(error) = self.generate_title(id) {
            tracing::debug!("session {id}: automatic title generation: {error:#}");
        }
    }

    pub fn generate_title(self: &Arc<Self>, id: u32) -> Result<()> {
        let session = self.get(id)?;
        let info = session.snapshot_info();
        if info.hidden
            || info.agent == proto::AgentKind::Shell
            || info.state != proto::SessionState::Running
        {
            bail!("session {id} title generation requires a live agent pane");
        }
        if info.title_source > TitleSource::Prompt {
            bail!("session {id} title source {:?} outranks generated titles; expected prompt or codename", info.title_source);
        }
        let provider = info.detected_agent.unwrap_or(info.agent);
        crate::generated_title::argv(provider, String::new())?;
        if info.profile_label.is_some() && session.title_profile_env.is_none() {
            bail!("{provider:?} title generation refused for session {id}: the original account profile cannot be recovered");
        }
        let prompt = {
            let excerpt = session.title_excerpt.lock().expect("title excerpt lock");
            let first_prompt = excerpt
                .0
                .as_deref()
                .context("title generation requires a hook-delivered first prompt")?;
            let first_reply = excerpt
                .1
                .as_deref()
                .context("title generation requires a hook-delivered first reply")?;
            crate::generated_title::prompt(first_prompt, first_reply)
        };
        if self
            .title_generation_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            bail!("title generation concurrency limit 1 reached (actual 1); cannot generate session {id}");
        }
        let result = (|| {
            if !self.db.claim_title_generation(id)? {
                bail!("session {id} title generation limit 1 reached (actual 1); cannot generate again");
            }
            let job = TitleJob {
                revision: session.title_revision.load(Ordering::Relaxed),
                prompt,
                directory: tempfile::Builder::new()
                    .prefix("houston-title-")
                    .tempdir()?,
            };
            self.handoff_generate_impl(id, provider, None, Some(job))
                .map(|_| ())
        })();
        if result.is_err() {
            self.title_generation_busy.store(false, Ordering::Release);
        }
        result
    }

    fn finish_generated_title(&self, job: HandoffJob) {
        self.sessions
            .lock()
            .expect("sessions lock")
            .remove(&job.hidden);
        self.remote_forget_session(job.hidden);
        let result = (|| -> Result<()> {
            if let Some(reason) = job.fail_reason.as_deref() {
                bail!("{} title generation failed: {reason}", job.provider_name);
            }
            if job.exit.flatten() != Some(0) {
                bail!(
                    "{} title generation exited with {:?}; expected exit code 0",
                    job.provider_name,
                    job.exit.flatten()
                );
            }
            let title = crate::generated_title::parse(&String::from_utf8_lossy(&job.buffer))?;
            let Some(generation) = job.title_job.as_ref() else {
                return Ok(());
            };
            let Ok(session) = self.get(job.source) else {
                return Ok(());
            };
            let mut source = session.title_source.lock().expect("title source lock");
            if !crate::generated_title::accepts_result(
                generation.revision,
                session.title_revision.load(Ordering::Relaxed),
                *source,
                *session.state.lock().expect("state lock"),
            ) {
                return Ok(());
            }
            self.db
                .save_title_candidate(job.source, TitleSource::Auto, &title)?;
            self.db
                .update_session_title_with_source(job.source, &title, Some("auto"))?;
            *source = TitleSource::Auto;
            *session.title.lock().expect("title lock") = title.clone();
            session.title_revision.fetch_add(1, Ordering::Relaxed);
            drop(source);
            self.broadcast_control(&proto::ServerMsg::SessionRenamed {
                session: job.source,
                title,
                title_source: TitleSource::Auto,
            });
            Ok(())
        })();
        if let Err(error) = result {
            self.broadcast_control(&proto::ServerMsg::Error {
                message: format!("session {}: {error:#}", job.source),
                context: Some("session_title_generate".into()),
            });
        }
        self.title_generation_busy.store(false, Ordering::Release);
    }
}

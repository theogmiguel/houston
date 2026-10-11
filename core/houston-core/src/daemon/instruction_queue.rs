use super::*;
use crate::db::{InstructionRow, MessageReceipt};
use proto::{InstructionMode as Mode, InstructionState as State};

impl Daemon {
    fn instruction_scope(&self, caller: Option<u32>, target: u32) -> Result<()> {
        anyhow::ensure!(
            target > 0,
            "session {target}: expected a positive session id"
        );
        if let Some(caller) = caller {
            self.assert_orchestration_target(caller, target)?;
        }
        self.db.session_origin(target)?;
        Ok(())
    }

    fn instruction_context(&self, target: u32) -> Result<String> {
        let session = self.get(target)?;
        let mut ancestry = Vec::new();
        let mut cursor = target;
        for _ in 0..=proto::ORCHESTRATION_CAP_MAX {
            let Some(parent) = self.db.delegation_parent_of(cursor)? else {
                break;
            };
            anyhow::ensure!(
                !ancestry.contains(&parent) && parent != target,
                "session {target}: cyclic parent ancestry at {parent}"
            );
            ancestry.push(parent);
            cursor = parent;
        }
        let cwd = self
            .live_cwd(target)
            .unwrap_or_else(|| PathBuf::from(&session.info.cwd));
        Ok(serde_json::json!({
            "target": target,
            "origin": self.db.session_origin(target)?,
            "provider": self.agent_kind_of(target),
            "workspace": self.current_workspace(target)?,
            "cwd": cwd,
            "profile": self.db.session_orchestration_identity(target)?.1,
            "profile_dir": self.db.session_profile_config_dir(target)?,
            "conversation": self.db.session_resume_handle(target)?,
            "ancestry": ancestry,
        })
        .to_string())
    }

    fn instruction_checked(
        &self,
        caller: Option<u32>,
        target: u32,
        id: &str,
    ) -> Result<InstructionRow> {
        self.instruction_scope(caller, target)?;
        let row = self.db.instruction_row(id)?.ok_or_else(|| {
            anyhow!("instruction_id {id:?}: expected an instruction retained for session {target}")
        })?;
        anyhow::ensure!(
            row.target == target,
            "instruction_id {id:?} targets session {}; requested session {target}",
            row.target
        );
        if let Some(caller) = caller {
            anyhow::ensure!(
                caller == row.origin || self.recorded_descendant_of(caller, row.origin)?,
                "instruction_id {id:?}: caller {caller} is not its origin {} or an ancestor",
                row.origin
            );
        }
        Ok(row)
    }

    pub fn instruction_queue(
        &self,
        caller: Option<u32>,
        session: u32,
    ) -> Result<proto::InstructionQueueSnapshot> {
        self.instruction_scope(caller, session)?;
        let rows = self.db.instruction_rows(session)?;
        let queued_count = rows
            .iter()
            .filter(|row| row.info.state == State::Queued)
            .count() as u32;
        let held_count = rows
            .iter()
            .filter(|row| row.info.state == State::HeldAfterRecovery)
            .count() as u32;
        let uncertain_count = rows
            .iter()
            .filter(|row| row.info.state == State::Uncertain)
            .count() as u32;
        let active = |row: &&InstructionRow| {
            matches!(
                row.info.state,
                State::Queued | State::HeldAfterRecovery | State::Uncertain
            ) || (row.info.state == State::Delivered && !row.completed)
        };
        let mut items: Vec<_> = rows
            .iter()
            .filter(active)
            .map(|row| row.info.clone())
            .collect();
        let hold_reason = items
            .first()
            .and_then(|item| item.hold_reason.clone())
            .or_else(|| {
                (queued_count > 0)
                    .then(|| self.paste_hold_reason(session))
                    .flatten()
            });
        let active_count = items.len();
        // The per-origin limit bounds active rows at sixteen. Preserve them before
        // adding recent final history to the thirty-two item control snapshot.
        items.extend(
            rows.iter()
                .rev()
                .filter(|row| !active(row))
                .take(32usize.saturating_sub(active_count))
                .map(|row| row.info.clone()),
        );
        let truncated = rows.len() > items.len();
        Ok(proto::InstructionQueueSnapshot {
            session,
            queued_count,
            held_count,
            uncertain_count,
            hold_reason,
            items,
            truncated,
        })
    }

    pub fn instruction_get(
        &self,
        caller: Option<u32>,
        session: u32,
        instruction_id: &str,
    ) -> Result<proto::InstructionDetail> {
        let row = self.instruction_checked(caller, session, instruction_id)?;
        Ok(proto::InstructionDetail {
            session,
            instruction: row.info,
            body: row.body,
        })
    }

    pub fn instruction_cancel(
        self: &Arc<Self>,
        caller: Option<u32>,
        session: u32,
        instruction_id: &str,
    ) -> Result<proto::InstructionQueueSnapshot> {
        let _cleanup = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.ensure_not_closing(session, "instruction mutation")?;
        let _dispatch = self
            .instruction_dispatch_lock
            .lock()
            .expect("instruction dispatch lock");
        let row = self.instruction_checked(caller, session, instruction_id)?;
        anyhow::ensure!(row.info.state != State::Delivered,
            "instruction_id {instruction_id:?} is delivered; cancelling delivered PTY input is refused");
        self.db
            .instruction_set_state(instruction_id, State::Cancelled, None, now_ms())?;
        let snapshot = self.instruction_queue(caller, session)?;
        self.broadcast_control(&proto::ServerMsg::InstructionQueue {
            snapshot: snapshot.clone(),
        });
        self.instruction_wake(session)?;
        Ok(snapshot)
    }

    pub fn instruction_resume(
        self: &Arc<Self>,
        caller: Option<u32>,
        session: u32,
        instruction_id: &str,
    ) -> Result<proto::InstructionQueueSnapshot> {
        let _cleanup = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.ensure_not_closing(session, "instruction mutation")?;
        let _dispatch = self
            .instruction_dispatch_lock
            .lock()
            .expect("instruction dispatch lock");
        let row = self.instruction_checked(caller, session, instruction_id)?;
        anyhow::ensure!(row.info.state == State::HeldAfterRecovery && !row.touched,
            "instruction_id {instruction_id:?} is {:?}, touched={}; expected untouched held_after_recovery; uncertain delivery requires cancel and a new intent", row.info.state, row.touched);
        anyhow::ensure!(self.get(session)?.state.lock().expect("state lock").is_live(),
            "instruction_id {instruction_id:?}: target session {session} must be live before resume");
        anyhow::ensure!(row.context == self.instruction_context(session)?,
            "instruction_id {instruction_id:?}: exact target, origin, provider, workspace, cwd, profile, conversation or ancestry changed; resume refused");
        self.cancel_temporary_cleanup_locked(session);
        self.db
            .instruction_set_state(instruction_id, State::Queued, None, now_ms())?;
        let snapshot = self.instruction_queue(caller, session)?;
        self.broadcast_control(&proto::ServerMsg::InstructionQueue {
            snapshot: snapshot.clone(),
        });
        self.instruction_wake(session)?;
        Ok(snapshot)
    }

    fn broadcast_instruction_queue(&self, session: u32) {
        match self.instruction_queue(None, session) {
            Ok(snapshot) => {
                self.broadcast_control(&proto::ServerMsg::InstructionQueue { snapshot })
            }
            Err(error) => {
                tracing::warn!("reading instruction queue for session {session}: {error:#}")
            }
        }
    }

    fn instruction_uncertain_notice(self: &Arc<Self>, row: &InstructionRow, reason: &str) {
        let body = format!("Instruction {} for child {} has uncertain delivery: {}. Preview: {}. Inspect with pane_instruction_get and this instruction_id, then cancel before creating a new intent. Do not replay automatically.",
            row.info.id, row.target, bounded_hook_text(reason), bounded_hook_text(&row.info.preview));
        if let Err(error) = self.inbox_write(
            row.origin,
            &self.current_workspace(row.target).unwrap_or_default(),
            Some(row.target),
            row.info.request_id,
            orchestrate::InboxKind::OperatorNote,
            "Instruction delivery needs inspection",
            &body,
            Vec::new(),
            Some("instruction_uncertain"),
            None,
            false,
            true,
        ) {
            tracing::warn!(
                "notifying instruction {} origin {}: {error}",
                row.info.id,
                row.origin
            );
        }
    }

    // Compatibility callers keep their tuple; transport doors use this typed
    // acceptance so retries report the durable intent's current state.
    pub fn orchestrate_instruction_request(
        self: &Arc<Self>,
        caller: u32,
        target: u32,
        text: &str,
        key: Option<&str>,
        mode: Option<&str>,
    ) -> Result<(
        proto::InstructionAcceptance,
        String,
        Option<proto::AgentStatus>,
    )> {
        let mode = orchestrate::PromptMode::parse(mode)?;
        let wire_mode = match mode {
            orchestrate::PromptMode::Queue => Mode::Queue,
            orchestrate::PromptMode::Steer => Mode::Steer,
            orchestrate::PromptMode::Restart => Mode::Restart,
        };
        let text = text.trim();
        anyhow::ensure!(!text.is_empty(), "prompt text must not be empty");
        let receipt = MessageReceipt::new(
            caller,
            key.map(str::to_string),
            "pane_prompt",
            &serde_json::json!({"session":target,"text":text,"mode":mode}),
        )?;
        let _cleanup = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.ensure_not_closing(target, "pane_prompt")?;
        let _dispatch = self
            .instruction_dispatch_lock
            .lock()
            .expect("instruction dispatch lock");
        self.instruction_scope(Some(caller), target)?;
        if let Some(row) = self.db.instruction_retry(&receipt)? {
            anyhow::ensure!(
                row.target == target,
                "instruction {} targets {}, expected {target}",
                row.info.id,
                row.target
            );
            return Ok((
                row.acceptance(),
                self.get(target)
                    .map(|session| {
                        orchestrate::status_source(session.status_kind())
                            .label()
                            .to_string()
                    })
                    .unwrap_or_else(|_| "none".into()),
                self.session_status(target).ok().flatten(),
            ));
        }
        if let Some(row) = self.delegation_of(target) {
            if let Some(state) = orchestrate::DelegationState::parse(&row.state) {
                let failed_live = state == orchestrate::DelegationState::Failed;
                if let Some(refusal) =
                    orchestrate::prompt_refusal(target, state).filter(|_| !failed_live)
                {
                    bail!("{refusal}");
                }
            }
        }
        let session = self.get(target)?;
        let state = *session.state.lock().expect("state lock");
        anyhow::ensure!(
            state.is_live(),
            "session {target} is {state:?}: accepting an instruction requires a live target"
        );
        let provider = self
            .agent_kind_of(target)
            .ok_or_else(|| anyhow!("pane {target} has no provider"))?;
        orchestrate::prompt_mode_supported(provider, mode)?;
        if mode != orchestrate::PromptMode::Queue {
            if let Some(reason) = self.immediate_paste_hold_reason(target) {
                bail!("mode {mode:?} refused for pane {target}: {reason}; use mode queue");
            }
            anyhow::ensure!(!self.db.instruction_rows(target)?.iter().any(|row|
                matches!(row.info.state, State::Queued | State::HeldAfterRecovery | State::Uncertain)
                    || (row.info.state == State::Delivered && !row.completed && !row.adopted)),
                "mode {mode:?} refused for pane {target}: a prior instruction is pending; use mode queue");
        } else {
            anyhow::ensure!(self.session_status(target)? != Some(proto::AgentStatus::NeedsInput),
                "refused: pane {target} needs input (NeedsInput); inspect it and answer before sending a new prompt");
        }
        let source = orchestrate::status_source(session.status_kind())
            .label()
            .to_string();
        let row = self.db.instruction_accept(
            target,
            &self.instruction_context(target)?,
            wire_mode,
            text,
            &receipt,
            now_ms(),
        )?;
        self.cancel_temporary_cleanup_locked(target);
        self.broadcast_instruction_queue(target);
        drop(_dispatch);
        drop(_cleanup);
        self.instruction_dispatch(target)?;
        self.instruction_wake(target)?;
        let row = self
            .db
            .instruction_row(&row.info.id)?
            .expect("accepted instruction retained");
        Ok((
            row.acceptance(),
            source,
            self.session_status(target).ok().flatten(),
        ))
    }

    fn instruction_wake(self: &Arc<Self>, target: u32) -> Result<()> {
        let mut active = self
            .instruction_wake_active
            .lock()
            .expect("instruction wake lock");
        if !active.insert(target) {
            return Ok(());
        }
        let daemon = Arc::downgrade(self);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("instruction-wake-{target}"))
            .spawn(move || {
                let mut backoff = SWARM_WAKE_SETTLE;
                loop {
                    let Some(this) = daemon.upgrade() else { return };
                    let keep = {
                        let keep = match this.instruction_dispatch(target) {
                            Ok(keep) => keep,
                            Err(error) => {
                                tracing::warn!(
                                    "dispatching instruction for session {target}: {error:#}"
                                );
                                false
                            }
                        };
                        if !keep || this.refusing_mutations() {
                            this.instruction_wake_active
                                .lock()
                                .expect("instruction wake lock")
                                .remove(&target);
                            false
                        } else {
                            true
                        }
                    };
                    if !keep {
                        return;
                    }
                    drop(this);
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(SWARM_WAKE_BACKOFF_MAX);
                }
            })
        {
            active.remove(&target);
            return Err(
                anyhow!("starting instruction wake for session {target}: {error}")
                    .context(orchestrate::MutationMayHaveActed),
            );
        }
        Ok(())
    }

    fn instruction_admission(
        &self,
    ) -> (std::sync::MutexGuard<'_, ()>, std::sync::MutexGuard<'_, ()>) {
        let cleanup = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        let dispatch = self
            .instruction_dispatch_lock
            .lock()
            .expect("instruction dispatch lock");
        (cleanup, dispatch)
    }

    fn instruction_write_receipt(
        &self,
        target: u32,
        data: &[u8],
        admission: &mut Option<(std::sync::MutexGuard<'_, ()>, std::sync::MutexGuard<'_, ()>)>,
    ) -> std::result::Result<(), StdinWriteError> {
        // begin_write has already claimed queued -> uncertain. Release both guards
        // until the FIFO receipt, then commit only if cancellation has not won.
        let receipt = self.admit_stdin_counting(target, data);
        drop(admission.take());
        Self::wait_stdin_receipt(target, receipt)
    }

    fn instruction_target_live(&self, target: u32) -> bool {
        self.ensure_not_closing(target, "instruction completion")
            .is_ok()
            && self
                .get(target)
                .is_ok_and(|session| session.state.lock().expect("state lock").is_live())
    }

    fn instruction_unwritten_receipt(&self, row: &InstructionRow, reason: &str) -> Result<()> {
        self.db
            .instruction_unwritten(&row.info.id, reason, now_ms())?;
        if !self.instruction_target_live(row.target) {
            self.db.instruction_set_state(
                &row.info.id,
                if row.interrupt_sent {
                    State::Uncertain
                } else {
                    State::HeldAfterRecovery
                },
                Some("target ended before write; inspect retained instruction"),
                now_ms(),
            )?;
        }
        Ok(())
    }

    fn instruction_write_evidence(&self, target: u32) -> InstructionWriteEvidence {
        self.instruction_writes
            .lock()
            .expect("instruction writes lock")
            .get(&target)
            .cloned()
            .unwrap_or_default()
    }

    fn instruction_dispatch(self: &Arc<Self>, target: u32) -> Result<bool> {
        let mut admission = Some(self.instruction_admission());
        if self
            .ensure_not_closing(target, "instruction dispatch")
            .is_err()
        {
            return Ok(false);
        }
        let rows = self.db.instruction_rows(target)?;
        let Some(mut head) = rows.iter().find(|row| {
            matches!(
                row.info.state,
                State::Queued | State::HeldAfterRecovery | State::Uncertain
            ) || (row.info.state == State::Delivered && !row.completed)
        }) else {
            return Ok(false);
        };
        if head.info.state == State::Delivered && head.adopted {
            if let Some(next) = rows
                .iter()
                .find(|row| row.info.state == State::Queued && row.info.mode != Mode::Queue)
            {
                head = next;
            }
        }
        if head.info.state != State::Queued {
            return Ok(head.info.state == State::Delivered);
        }
        let row = self
            .db
            .instruction_row(&head.info.id)?
            .expect("queued instruction retained");
        if self
            .instruction_writes
            .lock()
            .expect("instruction writes lock")
            .contains_key(&target)
        {
            return Ok(true);
        }
        self.instruction_writes
            .lock()
            .expect("instruction writes lock")
            .insert(
                target,
                InstructionWriteEvidence {
                    instruction_id: row.info.id.clone(),
                    ..Default::default()
                },
            );
        let _write = InstructionWriteReservation {
            daemon: self,
            target,
        };

        if !self
            .get(target)
            .is_ok_and(|s| s.state.lock().expect("state lock").is_live())
        {
            self.db.instruction_set_state(
                &row.info.id,
                State::HeldAfterRecovery,
                Some("target session ended; exact live context required before explicit resume"),
                now_ms(),
            )?;
            self.broadcast_instruction_queue(target);
            return Ok(false);
        }
        if row.info.mode == Mode::Restart
            && !row.interrupt_sent
            && self.session_status(target)? == Some(proto::AgentStatus::Working)
        {
            if let Some(reason) = self.immediate_paste_hold_reason(target) {
                self.db.instruction_set_state(
                    &row.info.id,
                    State::Queued,
                    Some(&reason),
                    now_ms(),
                )?;
                return Ok(true);
            }
            let provider = self
                .agent_kind_of(target)
                .ok_or_else(|| anyhow!("session {target}: provider missing"))?;
            self.db
                .instruction_begin_write(&row.info.id, None, None, now_ms())?;
            let outcome = self.instruction_write_receipt(
                target,
                orchestrate::prompt_interrupt_key(provider)?,
                &mut admission,
            );
            admission = Some(self.instruction_admission());
            if self
                .db
                .instruction_row(&row.info.id)?
                .is_none_or(|current| current.info.state != State::Uncertain)
            {
                return Ok(false);
            }
            match outcome {
                Ok(()) if !self.instruction_target_live(target) => {
                    self.db.instruction_set_state(&row.info.id, State::Uncertain,
                        Some("interrupt completed while target ended; cancel before creating a new intent"), now_ms())?;
                }
                Ok(()) => {
                    self.db
                        .instruction_interrupt_written(&row.info.id, now_ms())?;
                    self.instruction_settle_old_round_locked(target)?;
                    if self.instruction_write_evidence(target).restart_ready {
                        self.db.instruction_restart_ready(target, now_ms())?;
                    }
                }
                Err(error) if error.nothing_written() => self.instruction_unwritten_receipt(
                    &row,
                    &format!("interrupt wrote no bytes: {error}"),
                )?,
                Err(error) => {
                    let reason = format!(
                        "interrupt outcome uncertain: {error}; cancel before creating a new intent"
                    );
                    self.db.instruction_set_state(
                        &row.info.id,
                        State::Uncertain,
                        Some(&reason),
                        now_ms(),
                    )?;
                    self.instruction_uncertain_notice(&row, &reason);
                }
            }
            self.broadcast_instruction_queue(target);
            let keep = self.instruction_target_live(target);
            drop(admission);
            return Ok(keep);
        }
        if row.interrupt_sent && !row.restart_ready {
            return Ok(true);
        }
        let held = if row.info.mode == Mode::Steer {
            self.immediate_paste_hold_reason(target)
        } else {
            self.paste_hold_reason(target)
        };
        if let Some(reason) = held {
            self.db
                .instruction_set_state(&row.info.id, State::Queued, Some(&reason), now_ms())?;
            return Ok(true);
        }
        // Before the first prompt hook, the spawn's initial request is still reserved.
        let request = self
            .round_a_re_prompt_opens(target)
            .or_else(|| self.delegation_round_of(target));
        let text = request.map_or_else(
            || row.body.clone(),
            |request| format!("{}\n\n{}", orchestrate::request_header(request), row.body),
        );
        let prompt_id = self
            .last_prompt_id
            .lock()
            .expect("last prompt id lock")
            .get(&target)
            .cloned();
        self.db
            .instruction_begin_write(&row.info.id, request, prompt_id.as_deref(), now_ms())?;
        let outcome =
            self.instruction_write_receipt(target, &bracketed_paste(&text), &mut admission);
        admission = Some(self.instruction_admission());
        if self
            .db
            .instruction_row(&row.info.id)?
            .is_none_or(|current| current.info.state != State::Uncertain)
        {
            return Ok(false);
        }
        match outcome {
            Ok(()) => {}
            Err(error) if error.nothing_written() => {
                self.instruction_unwritten_receipt(
                    &row,
                    &format!("paste wrote no bytes: {error}"),
                )?;
                self.broadcast_instruction_queue(target);
                return Ok(true);
            }
            Err(error) => {
                let reason = format!(
                    "partial PTY paste: {error}; inspect the composer, cancel before a new intent"
                );
                self.db.instruction_set_state(
                    &row.info.id,
                    State::Uncertain,
                    Some(&reason),
                    now_ms(),
                )?;
                self.instruction_uncertain_notice(&row, &reason);
                self.broadcast_instruction_queue(target);
                return Ok(false);
            }
        }
        drop(admission.take());
        std::thread::sleep(SWARM_WAKE_SETTLE);
        admission = Some(self.instruction_admission());
        if self
            .db
            .instruction_row(&row.info.id)?
            .is_none_or(|current| current.info.state != State::Uncertain)
        {
            return Ok(false);
        }
        let held = if row.info.mode == Mode::Steer {
            self.immediate_paste_hold_reason(target)
        } else {
            self.paste_hold_reason(target)
        };
        let held = self
            .ensure_not_closing(target, "instruction submission")
            .err()
            .map(|error| error.to_string())
            .or(held);
        let failure = match held {
            Some(reason) => Some(reason),
            None => self
                .instruction_write_receipt(target, b"\r", &mut admission)
                .err()
                .map(|error| format!("Enter outcome uncertain: {error}")),
        };
        if admission.is_none() {
            admission = Some(self.instruction_admission());
        }
        if self
            .db
            .instruction_row(&row.info.id)?
            .is_none_or(|current| current.info.state != State::Uncertain)
        {
            return Ok(false);
        }
        let failure = failure.or_else(|| {
            (!self.instruction_target_live(target))
                .then(|| "target ended during submission; inspect retained instruction".to_string())
        });
        if let Some(ref reason) = failure {
            self.db.instruction_set_state(
                &row.info.id,
                State::Uncertain,
                Some(&format!(
                    "pasted but submission unconfirmed: {reason}; cancel before a new intent"
                )),
                now_ms(),
            )?;
            self.instruction_uncertain_notice(&row, reason);
        } else {
            if row.info.mode != Mode::Queue {
                for previous in rows.iter().filter(|previous| {
                    previous.info.state == State::Delivered
                        && previous.adopted
                        && !previous.completed
                }) {
                    self.db.instruction_complete(&previous.info.id, now_ms())?;
                }
            }
            self.db.instruction_set_state(
                &row.info.id,
                State::Delivered,
                Some("waiting for authoritative start or named request adoption"),
                now_ms(),
            )?;
            let evidence = self.instruction_write_evidence(target);
            if evidence.started {
                self.instruction_adopt_locked(target, None)?;
                if evidence.ended {
                    self.db.instruction_complete(&row.info.id, now_ms())?;
                }
            } else {
                self.prompt_awaiting_hook
                    .lock()
                    .expect("prompt awaiting hook lock")
                    .insert(target);
            }
        }
        self.broadcast_instruction_queue(target);
        drop(admission);
        Ok(failure.is_none())
    }

    pub(super) fn instruction_adopt_locked(&self, child: u32, named: Option<u32>) -> Result<bool> {
        let rows = self.db.instruction_rows(child)?;
        let evidence = self.instruction_write_evidence(child);
        let Some(row) = rows.iter().find(|row| {
            !row.completed
                && !row.adopted
                && (row.info.state == State::Delivered
                    || (row.info.state == State::Uncertain
                        && evidence.instruction_id == row.info.id
                        && (evidence.started
                            || named.is_some_and(|request| row.info.request_id == Some(request)))))
        }) else {
            return Ok(false);
        };
        let Some(request) = row.info.request_id else {
            return Ok(false);
        };
        if named.is_some_and(|named| named != request) {
            return Ok(false);
        }
        if row.info.state == State::Uncertain {
            if let Some(evidence) = self
                .instruction_writes
                .lock()
                .expect("instruction writes lock")
                .get_mut(&child)
            {
                evidence.started = true;
            }
        }
        let current = self.delegation_round_of(child).ok_or_else(|| {
            anyhow!("session {child}: delegation missing during instruction adoption")
        })?;
        if request > current {
            anyhow::ensure!(
                request == current + 1,
                "session {child}: reserved request {request}, expected {}",
                current + 1
            );
            self.instruction_settle_round_locked(child, current)?;
            self.db.delegation_bump_round(child, now_ms())?;
            self.db
                .delegation_set_no_handback(child, false, 0, now_ms())?;
            self.db.delegation_set_state(child, "working", now_ms())?;
        }
        self.instruction_settle_round_locked(child, request.saturating_sub(1))?;
        self.prompt_awaiting_hook
            .lock()
            .expect("prompt awaiting hook lock")
            .remove(&child);
        self.turn_start_round
            .lock()
            .expect("turn start round lock")
            .insert(child, request);
        self.db.instruction_adopt(&row.info.id, now_ms())?;
        self.broadcast_instruction_queue(child);
        Ok(true)
    }

    fn instruction_settle_old_round_locked(&self, child: u32) -> Result<()> {
        let Some(round) = self.delegation_round_of(child) else {
            return Ok(());
        };
        self.instruction_settle_round_locked(child, round)
    }

    pub(super) fn instruction_settle_round_locked(&self, child: u32, round: u32) -> Result<()> {
        for id in self
            .db
            .instruction_interrupt_staged(child, round, now_ms())?
        {
            self.broadcast_inbox_row(id);
            if let (Some(row), Some(daemon)) = (self.db.inbox_get(id)?, self.self_arc()) {
                daemon.inbox_notify(row.to_session, false);
            }
        }
        Ok(())
    }

    // The caller must release cleanup admission before entering. A named request
    // can adopt through report/submit even when a hook has not arrived.
    pub(crate) fn instruction_lifecycle(
        self: &Arc<Self>,
        child: u32,
        event: crate::agent_events::AgentEvent,
        event_name: &str,
        prompt_id: Option<&str>,
    ) -> Result<()> {
        use crate::agent_events::AgentEvent;
        let _cleanup = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        if event != AgentEvent::SessionEnded
            && self.ensure_not_closing(child, "instruction event").is_err()
        {
            return Ok(());
        }
        let _dispatch = self
            .instruction_dispatch_lock
            .lock()
            .expect("instruction dispatch lock");
        if self.db.instruction_rows(child)?.is_empty() {
            return Ok(());
        }
        // Supported lifecycle evidence can arrive before the FIFO write receipt.
        // Retain only flags for this session's claimed intent; cancellation still wins.
        {
            let mut writes = self
                .instruction_writes
                .lock()
                .expect("instruction writes lock");
            if let Some(evidence) = writes.get_mut(&child) {
                if let Some(row) = self.db.instruction_row(&evidence.instruction_id)? {
                    if row.info.state == State::Uncertain {
                        let stale = row.info.mode == Mode::Queue
                            && prompt_id.is_some()
                            && row.dispatch_prompt_id.as_deref() == prompt_id;
                        match event {
                            AgentEvent::PromptSubmitted => evidence.started = true,
                            AgentEvent::Activity
                                if !stale
                                    && self.session_status(child)?
                                        == Some(proto::AgentStatus::Working) =>
                            {
                                evidence.started = true
                            }
                            AgentEvent::TurnEnded | AgentEvent::TurnInterrupted => {
                                if !stale && evidence.started {
                                    evidence.ended = true;
                                }
                                if event_name != "quiet-settle" {
                                    evidence.restart_ready = true;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        match event {
            AgentEvent::PromptSubmitted => {
                self.instruction_adopt_locked(child, None)?;
            }
            AgentEvent::Activity
                if self.session_status(child)? == Some(proto::AgentStatus::Working) =>
            {
                let stale = self.db.instruction_rows(child)?.iter().any(|row| {
                    row.info.state == State::Delivered
                        && !row.adopted
                        && row.info.mode == Mode::Queue
                        && prompt_id.is_some()
                        && row.dispatch_prompt_id.as_deref() == prompt_id
                });
                if !stale {
                    self.instruction_adopt_locked(child, None)?;
                }
            }
            AgentEvent::TurnEnded | AgentEvent::TurnInterrupted => {
                for row in self.db.instruction_rows(child)? {
                    if row.info.state == State::Delivered && row.adopted && !row.completed {
                        let stale = row.info.mode == Mode::Queue
                            && prompt_id.is_some()
                            && row.dispatch_prompt_id.as_deref() == prompt_id;
                        if !stale {
                            self.db.instruction_complete(&row.info.id, now_ms())?;
                        }
                    }
                }
                // A quiet terminal does not prove that an interrupt was handled.
                if event_name != "quiet-settle" {
                    self.db.instruction_restart_ready(child, now_ms())?;
                }
            }
            AgentEvent::SessionEnded | AgentEvent::TurnFailed => {
                for row in self.db.instruction_rows(child)? {
                    if row.info.state == State::Queued {
                        self.db.instruction_set_state(
                            &row.info.id,
                            if row.touched {
                                State::Uncertain
                            } else {
                                State::HeldAfterRecovery
                            },
                            Some("target ended before delivery; inspect retained instruction"),
                            now_ms(),
                        )?;
                    }
                }
            }
            _ => {}
        }
        self.broadcast_instruction_queue(child);
        self.instruction_wake(child)?;
        Ok(())
    }
}

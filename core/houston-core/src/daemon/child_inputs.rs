use super::*;

use proto::PANE_ESCALATION_REASON_MAX as ESCALATION_REASON_MAX;

impl Daemon {
    pub(super) fn child_input_body(input: &proto::ChildInputRequest) -> String {
        if input.kind != proto::ChildInputKind::Permission {
            return orchestrate::needs_input_body(input.reason.as_deref());
        }
        let text = |value: &proto::ProviderReportedText| match value {
            proto::ProviderReportedText::Reported { text } => text.clone(),
            proto::ProviderReportedText::NotReported { provider } => {
                format!("not reported by {provider:?}")
            }
        };
        let details = input
            .permission
            .as_ref()
            .map(|details| {
                format!(
                    " Provider: {:?}. Command: {}. Block reason: {}.",
                    details.provider,
                    text(&details.command),
                    text(&details.block_reason)
                )
            })
            .unwrap_or_default();
        format!("Permission episode {}.{details} Use pane_deny with this episode_id or pane_escalate with your recommendation; only the operator may approve. The episode stays pending until provider evidence resolves it.", input.id)
    }

    fn unreported_permission(provider: proto::AgentKind) -> proto::PermissionInputDetails {
        proto::PermissionInputDetails {
            provider,
            command: proto::ProviderReportedText::NotReported { provider },
            block_reason: proto::ProviderReportedText::NotReported { provider },
        }
    }

    pub(super) fn permission_details(
        provider: proto::AgentKind,
        drop: &crate::hook_drop::HookDrop,
    ) -> proto::PermissionInputDetails {
        let text = |value: Option<&str>| {
            value
                .filter(|text| !text.trim().is_empty())
                .map(|text| proto::ProviderReportedText::Reported {
                    text: bounded_hook_text(text),
                })
                .unwrap_or(proto::ProviderReportedText::NotReported { provider })
        };
        proto::PermissionInputDetails {
            provider,
            command: text(drop.permission_command.as_deref()),
            block_reason: text(drop.permission_block_reason.as_deref()),
        }
    }

    pub(super) fn assert_no_operator_input_intervention(
        &self,
        child: u32,
        expected: Option<&str>,
    ) -> Result<()> {
        let session = self.get(child)?;
        if !session.input_intervention.load(Ordering::Acquire) {
            return Ok(());
        }
        let captured = session
            .input_intervention_id
            .lock()
            .expect("intervention input lock");
        if expected
            .zip(captured.as_deref())
            .is_some_and(|(expected, captured)| expected != captured)
        {
            return Ok(());
        }
        bail!("response refused: child {child} input {} has an operator intervention awaiting provider evidence; inspect the child and wait for its lifecycle confirmation",
            captured.as_deref().unwrap_or("not yet reported"));
    }

    pub(super) fn pending_permission_episode(&self, child: u32) -> Result<Option<String>> {
        if let Some(input) = self.db.child_permission_request(child)? {
            return Ok(Some(input.id));
        }
        Ok(self
            .permission_episodes
            .lock()
            .expect("episodes lock")
            .get(&child)
            .and_then(|episodes| {
                episodes
                    .permission_episodes()
                    .first()
                    .map(|episode| format!("provider:{child}:{:?}", episode.key))
            }))
    }

    pub(super) fn child_input_paste_hold_reason(&self, child: u32) -> Option<String> {
        match self.pending_permission_episode(child) {
            Ok(Some(episode)) => return Some(format!("child {child} has pending permission episode {episode}; use pane_deny or pane_escalate; only the operator may approve")),
            Err(error) => return Some(format!("pane input state cannot be read: {error}")),
            Ok(None) => {}
        }
        match self.db.child_input_request(child) {
            Ok(Some(input)) => Some(format!("child {child} has unresolved {:?} input request {}; inspect and answer it before prompting", input.kind, input.id)),
            Err(error) => Some(format!("pane input state cannot be read: {error}")),
            Ok(None) => None,
        }
    }

    pub fn orchestrate_deny(
        self: &Arc<Self>,
        caller: u32,
        request: proto::PaneDenyRequest,
    ) -> Result<serde_json::Value> {
        let _native_input = self.native_input_mutation_guard()?;
        let _guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.ensure_not_closing(request.child, "deny")?;
        self.assert_orchestration_target(caller, request.child)?;
        let session = self.get(request.child)?;
        let state = *session.state.lock().expect("state lock");
        anyhow::ensure!(
            state.is_live(),
            "deny refused: child {} is {state:?}; expected a live child",
            request.child
        );
        let input = self.db.child_permission_request(request.child)?.ok_or_else(|| anyhow!(
            "deny refused: child {} has no unresolved permission episode {}; expected current provider permission evidence", request.child, request.episode_id))?;
        anyhow::ensure!(
            input.id == request.episode_id,
            "deny refused: child {} permission episode {:?} is stale; current episode is {}",
            request.child,
            request.episode_id,
            input.id
        );
        anyhow::ensure!(
            input.owner == proto::ChildInputOwner::Orchestrator,
            "deny refused: child {} permission episode {} belongs to the operator after escalation",
            request.child,
            input.id
        );
        self.assert_no_operator_input_intervention(request.child, None)?;
        let provider = input
            .permission
            .as_ref()
            .map(|details| details.provider)
            .or_else(|| self.agent_kind_of(request.child))
            .ok_or_else(|| {
                anyhow!(
                    "deny refused: child {} has no reported provider",
                    request.child
                )
            })?;
        let pending_reply = |already_attempted: bool| {
            serde_json::json!({
                "denial_sent":!already_attempted, "pending":true, "already_attempted":already_attempted,
                "child":request.child, "episode_id":input.id, "provider":provider,
            })
        };
        if self
            .db
            .child_permission_deny_attempted(request.child, &input.id)?
        {
            return Ok(pending_reply(true));
        }
        let bytes = super::provider_deny::bytes(&session, provider)?;
        let episodes = self.permission_episodes.lock().expect("episodes lock");
        let pending = episodes
            .get(&request.child)
            .map(orchestrate::PermissionEpisodes::input_episodes)
            .unwrap_or_default();
        anyhow::ensure!(pending.len() == 1 && pending[0].input_kind == proto::ChildInputKind::Permission,
            "deny refused for {provider:?}: child {} episode {} has {} live provider prompts; expected exactly one verified permission prompt; use pane_escalate", request.child, input.id, pending.len());
        let source = self.db.child_permission_source(request.child, &input.id)?;
        anyhow::ensure!(source.as_deref() == Some(format!("{:?}", pending[0].key).as_str()),
            "deny refused for {provider:?}: child {} episode {} no longer matches the live provider prompt; use pane_escalate", request.child, input.id);
        if !self
            .db
            .child_permission_claim_deny(request.child, &input.id, now_ms())?
        {
            return Ok(pending_reply(true));
        }
        let receipt = self.admit_stdin_counting(request.child, bytes);
        drop(episodes);
        drop(_guard);
        drop(_native_input);
        let outcome = Self::wait_stdin_receipt(request.child, receipt);
        let _guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        if let Err(error) = outcome {
            if error.nothing_written() {
                self.db
                    .child_permission_retry_zero_write(request.child, &input.id)?;
            }
            return Err(anyhow!("deny attempt for {provider:?}, child {}, episode {} failed: {error}; pending until provider evidence", request.child, input.id));
        }
        self.ensure_not_closing(request.child, "deny completion")?;
        // Sending denial is an attempt, not provider evidence that the modal resolved.
        self.cancel_temporary_cleanup_locked(request.child);
        Ok(pending_reply(false))
    }

    pub fn orchestrate_escalate(
        self: &Arc<Self>,
        caller: u32,
        request: proto::PaneEscalateRequest,
    ) -> Result<serde_json::Value> {
        let _native_input = self.native_input_mutation_guard()?;
        let detail = request.reason.trim();
        anyhow::ensure!(!detail.is_empty() && detail.chars().count() <= ESCALATION_REASON_MAX,
            "escalate refused: reason {:?}; expected nonblank text of at most {ESCALATION_REASON_MAX} characters", request.reason);
        let guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.ensure_not_closing(request.child, "escalate")?;
        self.assert_orchestration_target(caller, request.child)?;
        let child = self.get(request.child)?;
        let state = *child.state.lock().expect("state lock");
        anyhow::ensure!(state.is_live(),
            "escalate refused: child {} is {state:?}; expected a live child with an unresolved input request", request.child);
        let input = self.db.child_input_request(request.child)?.ok_or_else(|| anyhow!(
            "escalate refused: child {} has no unresolved input request; expected a live question, blocker or permission ask", request.child))?;
        let changed = if input.owner == proto::ChildInputOwner::Orchestrator {
            self.db.child_input_escalate(
                request.child,
                &input,
                proto::ChildInputEscalationReason::Explicit,
                Some(detail.to_string()),
                now_ms(),
            )?
        } else {
            false
        };
        let current = self.db.child_input_request(request.child)?.ok_or_else(|| anyhow!(
            "escalate refused: child {} input {} resolved before escalation; expected the same unresolved ask", request.child, input.id))?;
        if changed && current.kind == proto::ChildInputKind::Permission {
            self.permission_input_notice(request.child, &current);
        }
        self.broadcast_delegation(request.child);
        self.tasks_on_input_ownership(request.child);
        drop(guard);
        Ok(
            serde_json::json!({"escalated":true,"changed":changed,"child":request.child,"input_request":current}),
        )
    }

    pub(super) fn tasks_on_input_ownership(&self, child: u32) {
        let status = self
            .db
            .child_input_request(child)
            .ok()
            .flatten()
            .map(|input| {
                if input.owner == proto::ChildInputOwner::User {
                    proto::AgentStatus::NeedsInput
                } else {
                    proto::AgentStatus::Working
                }
            })
            .unwrap_or_else(|| {
                self.session_status(child)
                    .ok()
                    .flatten()
                    .unwrap_or(proto::AgentStatus::Unavailable)
            });
        if let Ok(session) = self.get(child) {
            session.input_pending.store(
                self.delegation_of(child)
                    .is_some_and(|row| row.input_request.is_some()),
                Ordering::Release,
            );
        }
        self.tasks_on_session_status(child, status);
    }

    pub(super) fn escalate_child_inputs_locked(
        &self,
        parent: u32,
        reason: proto::ChildInputEscalationReason,
    ) {
        let inputs = match self.db.child_inputs_owned_by_parent(parent) {
            Ok(inputs) => inputs,
            Err(error) => {
                tracing::warn!("reading asks owned by parent {parent}: {error}");
                return;
            }
        };
        for (child, input) in inputs {
            if self
                .get(child)
                .ok()
                .is_none_or(|s| !s.state.lock().expect("state lock").is_live())
            {
                continue;
            }
            match self
                .db
                .child_input_escalate(child, &input, reason, None, now_ms())
            {
                Ok(true) => {
                    if input.kind == proto::ChildInputKind::Permission {
                        if let (Some(daemon), Ok(Some(current))) =
                            (self.self_arc(), self.db.child_input_request(child))
                        {
                            daemon.permission_input_notice(child, &current);
                        }
                    }
                    self.broadcast_delegation(child);
                    self.tasks_on_input_ownership(child);
                }
                Ok(false) => {}
                Err(error) => tracing::warn!("escalating child {child} ask {}: {error}", input.id),
            }
        }
    }

    pub(super) fn sync_child_inputs_locked(
        self: &Arc<Self>,
        child: u32,
        event: &str,
        ev: crate::agent_events::AgentEvent,
    ) {
        use crate::agent_events::AgentEvent;
        if matches!(
            ev,
            AgentEvent::TurnEnded | AgentEvent::TurnInterrupted | AgentEvent::TurnFailed
        ) && event != "quiet-settle"
        {
            self.escalate_child_inputs_locked(
                child,
                proto::ChildInputEscalationReason::ParentTurnEnded,
            );
        }
        if ev == AgentEvent::SessionEnded {
            self.escalate_child_inputs_locked(
                child,
                proto::ChildInputEscalationReason::ParentUnavailable,
            );
        }
        if self.delegation_of(child).is_none() {
            return;
        }
        if ev == AgentEvent::NeedsInput {
            let episodes = self
                .permission_episodes
                .lock()
                .expect("episodes lock")
                .get(&child)
                .map(orchestrate::PermissionEpisodes::input_episodes)
                .unwrap_or_default();
            let provider = self.agent_kind_of(child).unwrap_or(proto::AgentKind::Shell);
            let requests: Vec<_> = if episodes.is_empty() {
                let since = self
                    .get(child)
                    .ok()
                    .and_then(|s| *s.status_since_ms.lock().expect("status since lock"))
                    .unwrap_or(now_ms());
                let kind = if matches!(event, "ACP" | "permission_prompt" | "PermissionRequest") {
                    proto::ChildInputKind::Permission
                } else {
                    proto::ChildInputKind::Unclassified
                };
                let reason = self.get(child).ok().and_then(|s| {
                    s.hook_input_reason
                        .lock()
                        .expect("input reason lock")
                        .clone()
                });
                let details = (kind == proto::ChildInputKind::Permission).then(|| {
                    if event == "ACP" {
                        Self::unreported_permission(provider)
                    } else {
                        self.get(child)
                            .ok()
                            .and_then(|s| {
                                s.hook_permission_details
                                    .lock()
                                    .expect("permission details lock")
                                    .clone()
                            })
                            .unwrap_or_else(|| Self::unreported_permission(provider))
                    }
                });
                vec![(
                    format!("unclassified:{event}:{since}"),
                    kind,
                    reason,
                    details,
                )]
            } else {
                episodes
                    .into_iter()
                    .map(|episode| {
                        let details = (episode.input_kind == proto::ChildInputKind::Permission)
                            .then(|| {
                                episode
                                    .permission
                                    .unwrap_or_else(|| Self::unreported_permission(provider))
                            });
                        (
                            format!("{:?}", episode.key),
                            episode.input_kind,
                            episode.reason.as_deref().map(bounded_hook_text),
                            details,
                        )
                    })
                    .collect()
            };
            for (source, kind, reason, permission) in requests {
                match self.db.child_input_open_provider(
                    child,
                    &source,
                    kind,
                    proto::ChildInputOwner::Orchestrator,
                    reason,
                    now_ms(),
                ) {
                    Ok((input, _)) => {
                        if let Some(permission) = permission {
                            if let Err(error) = self
                                .db
                                .child_input_permission_details(child, &input.id, permission)
                            {
                                tracing::warn!(
                                    "persisting child {child} permission details: {error}"
                                );
                            }
                        }
                    }
                    Err(error) => tracing::warn!("persisting child {child} input: {error}"),
                }
            }
            if self.parent_of(child).is_some_and(|parent| {
                self.get(parent)
                    .ok()
                    .is_none_or(|s| !s.state.lock().expect("state lock").is_live())
            }) {
                if let Some(parent) = self.parent_of(child) {
                    self.escalate_child_inputs_locked(
                        parent,
                        proto::ChildInputEscalationReason::ParentUnavailable,
                    );
                }
            }
        } else if event != "quiet-settle"
            && matches!(
                ev,
                AgentEvent::PromptSubmitted
                    | AgentEvent::InputResolved
                    | AgentEvent::TurnEnded
                    | AgentEvent::TurnInterrupted
                    | AgentEvent::TurnFailed
                    | AgentEvent::SessionEnded
            )
        {
            // Individual episode resolution removes matched identities separately. The final
            // InputResolved and authoritative turn/prompt evidence resolve provider asks only.
            self.permission_episodes
                .lock()
                .expect("episodes lock")
                .remove(&child);
            if let Err(error) = self.db.child_input_resolve_provider(child, now_ms()) {
                tracing::warn!("resolving child {child} provider input: {error}");
            }
            let answer = self.get(child).ok().and_then(|session| {
                session
                    .input_intervention_answer
                    .lock()
                    .expect("input answer lock")
                    .take()
            });
            self.publish_input_intervention(child, answer.as_deref());
        }
    }

    fn permission_input_notice(self: &Arc<Self>, child: u32, input: &proto::ChildInputRequest) {
        let Some(parent) = self.parent_of(child) else {
            return;
        };
        if let Err(error) = self.db.child_input_resolve_notices(child, now_ms()) {
            tracing::warn!("retiring child {child} actionable block notices: {error}");
        }
        let label = self.child_label_of(child);
        let body = format!("{label} (child {child}) is awaiting user permission. The user can answer in the child pane; this notice is informational. Input request: {}.{}", input.id, input.reason.as_ref().map(|reason| format!(" Provider reason: {reason}")).unwrap_or_default());
        if let Err(error) = self.inbox_write(
            parent,
            &self.current_workspace(child).unwrap_or_default(),
            Some(child),
            self.delegation_of(child).map(|r| r.round),
            orchestrate::InboxKind::OperatorNote,
            &format!("{label} is awaiting user permission"),
            &body,
            Vec::new(),
            Some("awaiting_user_permission"),
            None,
            false,
            true,
        ) {
            tracing::warn!("recording child {child} user-permission notice: {error}");
        }
    }

    pub(super) fn note_input_intervention(&self, child: u32) -> bool {
        if let Ok(session) = self.get(child) {
            if (session.input_pending.load(Ordering::Acquire)
                || *session.status.lock().expect("status lock")
                    == Some(proto::AgentStatus::NeedsInput))
                && !session.input_intervention.swap(true, Ordering::AcqRel)
            {
                *session
                    .input_intervention_id
                    .lock()
                    .expect("intervention input lock") = session
                    .input_current_id
                    .lock()
                    .expect("current input lock")
                    .clone();
                return true;
            }
        }
        false
    }

    pub(super) fn publish_input_intervention(&self, child: u32, answer: Option<&str>) {
        let Ok(session) = self.get(child) else {
            return;
        };
        if !session.input_intervention.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Some(id) = session
            .input_intervention_id
            .lock()
            .expect("intervention input lock")
            .take()
        {
            if id.starts_with("report:") {
                if let Err(error) = self
                    .db
                    .child_input_resolve_intervention(child, &id, now_ms())
                {
                    tracing::warn!("resolving child {child} directly answered ask: {error}");
                }
                self.broadcast_delegation(child);
                self.tasks_on_input_ownership(child);
            }
        }
        let Some(parent) = self.parent_of(child) else {
            return;
        };
        let Some(daemon) = self.self_arc() else {
            return;
        };
        let label = self.child_label_of(child);
        let body = if let Some(answer) = answer.filter(|s| !s.trim().is_empty()) {
            format!(
                "The user intervened in {label} (child {child}). Provider-reported answer: {}",
                bounded_hook_text(answer)
            )
        } else {
            format!("The user intervened in {label} (child {child}). No structured answer was reported.")
        };
        if let Err(error) = daemon.inbox_write(
            parent,
            &self.current_workspace(child).unwrap_or_default(),
            Some(child),
            self.delegation_of(child).map(|r| r.round),
            orchestrate::InboxKind::OperatorNote,
            &format!("The user intervened in {label}"),
            &body,
            Vec::new(),
            Some("user_input_intervention"),
            None,
            false,
            true,
        ) {
            tracing::warn!("recording child {child} user intervention: {error}");
        }
    }
}

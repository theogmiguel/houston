use houston_protocol as proto;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentEvent {
    SessionStarted,
    PromptSubmitted,
    // Provider activity that keeps a turn alive but is not a new user prompt.
    // OpenCode emits this for session.status busy/retry pulses.
    Activity,
    InputResolved,
    // At most one row of this per provider: its own loop-termination event,
    // never a per-step event near a turn's end. Exception: two spellings of
    // the SAME end (Claude's Stop/StopFailure) — see EXCLUSIVE_TURN_ENDS.
    TurnEnded,
    TurnInterrupted,
    NeedsInput,
}

impl AgentEvent {
    pub fn status(self) -> proto::AgentStatus {
        match self {
            AgentEvent::SessionStarted | AgentEvent::TurnEnded | AgentEvent::TurnInterrupted => {
                proto::AgentStatus::Idle
            }
            AgentEvent::PromptSubmitted | AgentEvent::Activity | AgentEvent::InputResolved => {
                proto::AgentStatus::Working
            }
            AgentEvent::NeedsInput => proto::AgentStatus::NeedsInput,
        }
    }

    pub fn notice(self, provider_event: &str) -> Option<proto::AgentNoticeKind> {
        match self {
            AgentEvent::TurnEnded if matches!(provider_event, "StopFailure" | "session.error") => {
                Some(proto::AgentNoticeKind::Error)
            }
            AgentEvent::TurnEnded => Some(proto::AgentNoticeKind::Finished),
            AgentEvent::NeedsInput => Some(proto::AgentNoticeKind::NeedsInput),
            AgentEvent::SessionStarted
            | AgentEvent::PromptSubmitted
            | AgentEvent::Activity
            | AgentEvent::InputResolved
            | AgentEvent::TurnInterrupted => None,
        }
    }

    pub fn applies(
        self,
        current: Option<proto::AgentStatus>,
        ambiguous_idle_notification: bool,
    ) -> bool {
        match self {
            AgentEvent::NeedsInput => {
                !ambiguous_idle_notification || current != Some(proto::AgentStatus::Idle)
            }
            AgentEvent::InputResolved => current == Some(proto::AgentStatus::NeedsInput),
            _ => true,
        }
    }

    pub fn from_provider(provider: proto::AgentKind, name: &str) -> Option<Self> {
        events_for(provider)
            .iter()
            .find(|(their_name, _)| *their_name == name)
            .map(|(_, ev)| *ev)
    }
}

// SubagentStart/SubagentStop are deliberately absent: a sub-agent runs
// INSIDE its parent's turn, so reading either as a status would move a
// pane on something that is not its own lifecycle (see the correlation list).
const CLAUDE_EVENTS: [(&str, AgentEvent); 9] = [
    ("SessionStart", AgentEvent::SessionStarted),
    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
    ("Stop", AgentEvent::TurnEnded),
    ("StopFailure", AgentEvent::TurnEnded),
    ("Notification", AgentEvent::NeedsInput),
    ("PermissionRequest", AgentEvent::NeedsInput),
    ("PermissionDenied", AgentEvent::InputResolved),
    ("Elicitation", AgentEvent::NeedsInput),
    ("ElicitationResult", AgentEvent::InputResolved),
];

pub const CLAUDE_CORRELATION_EVENTS: [&str; 5] = [
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
];

const CODEX_EVENTS: [(&str, AgentEvent); 5] = [
    ("SessionStart", AgentEvent::SessionStarted),
    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
    ("Stop", AgentEvent::TurnEnded),
    ("Interrupt", AgentEvent::TurnInterrupted),
    ("PermissionRequest", AgentEvent::NeedsInput),
];

pub const CODEX_CORRELATION_EVENTS: [&str; 5] = [
    "SubagentStart",
    "SubagentStop",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
];

const OPENCODE_EVENTS: [(&str, AgentEvent); 14] = [
    ("session.created", AgentEvent::SessionStarted),
    ("message.updated", AgentEvent::PromptSubmitted),
    ("session.status", AgentEvent::Activity),
    ("permission.asked", AgentEvent::NeedsInput),
    ("permission.updated", AgentEvent::NeedsInput),
    ("permission.replied", AgentEvent::InputResolved),
    ("question.asked", AgentEvent::NeedsInput),
    ("question.replied", AgentEvent::InputResolved),
    ("question.rejected", AgentEvent::InputResolved),
    ("question.v2.asked", AgentEvent::NeedsInput),
    ("question.v2.replied", AgentEvent::InputResolved),
    ("question.v2.rejected", AgentEvent::InputResolved),
    ("session.idle", AgentEvent::TurnEnded),
    ("session.error", AgentEvent::TurnEnded),
];

pub const OPENCODE_CORRELATION_EVENTS: [&str; 1] = ["SubagentStop"];

const CURSOR_EVENTS: [(&str, AgentEvent); 3] = [
    ("sessionStart", AgentEvent::SessionStarted),
    ("beforeSubmitPrompt", AgentEvent::PromptSubmitted),
    ("stop", AgentEvent::TurnEnded),
];

// afterAgentResponse is the only place Cursor's own last-said text lives
// (`stop` carries none), so it's lifted into last_message — but still never
// a status: it fires after every assistant message, not just the last one.
pub const CURSOR_CORRELATION_EVENTS: [&str; 3] =
    ["subagentStart", "subagentStop", "afterAgentResponse"];

const GROK_EVENTS: [(&str, AgentEvent); 4] = [
    ("SessionStart", AgentEvent::SessionStarted),
    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
    ("Stop", AgentEvent::TurnEnded),
    ("Notification", AgentEvent::NeedsInput),
];

pub const GROK_CORRELATION_EVENTS: [&str; 2] = ["SubagentStart", "SubagentStop"];

// PreToolUse maps to NeedsInput here, but the table alone can't tell
// `ask_question` from an ordinary tool call — the daemon gates on the tool
// name. PostInvocation (per LLM round-trip) must never become TurnEnded.
const ANTIGRAVITY_EVENTS: [(&str, AgentEvent); 4] = [
    ("SessionStart", AgentEvent::SessionStarted),
    ("PreInvocation", AgentEvent::PromptSubmitted),
    ("Stop", AgentEvent::TurnEnded),
    ("PreToolUse", AgentEvent::NeedsInput),
];

pub const ANTIGRAVITY_CORRELATION_EVENTS: [&str; 1] = ["PostToolUse"];

pub fn events_for(provider: proto::AgentKind) -> &'static [(&'static str, AgentEvent)] {
    match provider {
        proto::AgentKind::Claude => &CLAUDE_EVENTS,
        proto::AgentKind::Codex => &CODEX_EVENTS,
        proto::AgentKind::Opencode => &OPENCODE_EVENTS,
        proto::AgentKind::Cursor => &CURSOR_EVENTS,
        proto::AgentKind::Grok => &GROK_EVENTS,
        proto::AgentKind::Antigravity => &ANTIGRAVITY_EVENTS,
        _ => &[],
    }
}

pub fn has_event_mapping(provider: proto::AgentKind) -> bool {
    !events_for(provider).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_names_map_to_the_taxonomy_and_nothing_else_does() {
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Claude, "SessionStart"),
            Some(AgentEvent::SessionStarted)
        );
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Claude, "Stop"),
            Some(AgentEvent::TurnEnded)
        );
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Claude, "PreToolUse"),
            None
        );
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Codex, "SessionStart"),
            Some(AgentEvent::SessionStarted)
        );
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Codex, "PreToolUse"),
            None
        );
        assert!(has_event_mapping(proto::AgentKind::Claude));
        assert!(!has_event_mapping(proto::AgentKind::Shell));
        assert!(has_event_mapping(proto::AgentKind::Antigravity));
    }

    #[test]
    fn opencode_status_is_activity_not_a_new_prompt() {
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Opencode, "session.status"),
            Some(AgentEvent::Activity)
        );
        assert_ne!(
            AgentEvent::from_provider(proto::AgentKind::Opencode, "session.status"),
            Some(AgentEvent::PromptSubmitted)
        );
    }

    #[test]
    fn every_provider_maps_only_its_own_spellings() {
        let expected: [(proto::AgentKind, &[(&str, AgentEvent)]); 6] = [
            (
                proto::AgentKind::Claude,
                &[
                    ("SessionStart", AgentEvent::SessionStarted),
                    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
                    ("Stop", AgentEvent::TurnEnded),
                    ("StopFailure", AgentEvent::TurnEnded),
                    ("Notification", AgentEvent::NeedsInput),
                    ("PermissionRequest", AgentEvent::NeedsInput),
                    ("PermissionDenied", AgentEvent::InputResolved),
                    ("Elicitation", AgentEvent::NeedsInput),
                    ("ElicitationResult", AgentEvent::InputResolved),
                ],
            ),
            (
                proto::AgentKind::Codex,
                &[
                    ("SessionStart", AgentEvent::SessionStarted),
                    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
                    ("Stop", AgentEvent::TurnEnded),
                    ("Interrupt", AgentEvent::TurnInterrupted),
                    ("PermissionRequest", AgentEvent::NeedsInput),
                ],
            ),
            (
                proto::AgentKind::Opencode,
                &[
                    ("session.created", AgentEvent::SessionStarted),
                    ("message.updated", AgentEvent::PromptSubmitted),
                    ("session.status", AgentEvent::Activity),
                    ("permission.asked", AgentEvent::NeedsInput),
                    ("permission.updated", AgentEvent::NeedsInput),
                    ("permission.replied", AgentEvent::InputResolved),
                    ("question.asked", AgentEvent::NeedsInput),
                    ("question.replied", AgentEvent::InputResolved),
                    ("question.rejected", AgentEvent::InputResolved),
                    ("question.v2.asked", AgentEvent::NeedsInput),
                    ("question.v2.replied", AgentEvent::InputResolved),
                    ("question.v2.rejected", AgentEvent::InputResolved),
                    ("session.idle", AgentEvent::TurnEnded),
                    ("session.error", AgentEvent::TurnEnded),
                ],
            ),
            (
                proto::AgentKind::Cursor,
                &[
                    ("sessionStart", AgentEvent::SessionStarted),
                    ("beforeSubmitPrompt", AgentEvent::PromptSubmitted),
                    ("stop", AgentEvent::TurnEnded),
                ],
            ),
            (
                proto::AgentKind::Grok,
                &[
                    ("SessionStart", AgentEvent::SessionStarted),
                    ("UserPromptSubmit", AgentEvent::PromptSubmitted),
                    ("Stop", AgentEvent::TurnEnded),
                    ("Notification", AgentEvent::NeedsInput),
                ],
            ),
            (
                proto::AgentKind::Antigravity,
                &[
                    ("SessionStart", AgentEvent::SessionStarted),
                    ("PreInvocation", AgentEvent::PromptSubmitted),
                    ("Stop", AgentEvent::TurnEnded),
                    ("PreToolUse", AgentEvent::NeedsInput),
                ],
            ),
        ];
        for (provider, rows) in expected {
            assert_eq!(events_for(provider), rows, "{provider:?}");
            assert!(has_event_mapping(provider));
            for (name, ev) in rows {
                assert_eq!(
                    AgentEvent::from_provider(provider, name),
                    Some(*ev),
                    "{provider:?} should read {name:?}"
                );
            }
        }
        assert_eq!(
            AgentEvent::from_provider(proto::AgentKind::Cursor, "Notification"),
            None
        );
    }

    const EVERY_KIND: [proto::AgentKind; 12] = [
        proto::AgentKind::Claude,
        proto::AgentKind::Codex,
        proto::AgentKind::Antigravity,
        proto::AgentKind::Shell,
        proto::AgentKind::Custom,
        proto::AgentKind::Opencode,
        proto::AgentKind::Cursor,
        proto::AgentKind::Grok,
        proto::AgentKind::Droid,
        proto::AgentKind::Copilot,
        proto::AgentKind::Aider,
        proto::AgentKind::Ssh,
    ];

    const EXCLUSIVE_TURN_ENDS: [(proto::AgentKind, [&str; 2]); 2] = [
        (proto::AgentKind::Claude, ["Stop", "StopFailure"]),
        (
            proto::AgentKind::Opencode,
            ["session.idle", "session.error"],
        ),
    ];

    #[test]
    fn every_provider_ends_a_turn_at_most_once() {
        for kind in EVERY_KIND {
            let ends: Vec<&str> = events_for(kind)
                .iter()
                .filter(|(_, ev)| *ev == AgentEvent::TurnEnded)
                .map(|(name, _)| *name)
                .collect();
            let licensed = EXCLUSIVE_TURN_ENDS
                .iter()
                .any(|(k, pair)| *k == kind && ends == pair);
            assert!(
                ends.len() <= 1 || licensed,
                "{kind:?} maps {} events to TurnEnded ({ends:?}) — a turn can only end once, \
                 and the row must be the CLI's loop-termination event",
                ends.len()
            );
        }
    }

    #[test]
    fn the_correlation_events_are_installed_and_are_still_not_a_status() {
        for name in CLAUDE_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Claude, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !CLAUDE_EVENTS
                .iter()
                .any(|(name, _)| CLAUDE_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn codex_subagent_events_are_not_turn_ends() {
        for name in CODEX_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Codex, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !CODEX_EVENTS
                .iter()
                .any(|(name, _)| CODEX_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn grok_subagent_events_are_not_turn_ends() {
        for name in GROK_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Grok, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !GROK_EVENTS
                .iter()
                .any(|(name, _)| GROK_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn cursor_correlation_events_are_not_turn_ends() {
        for name in CURSOR_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Cursor, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !CURSOR_EVENTS
                .iter()
                .any(|(name, _)| CURSOR_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn opencode_subagent_stop_is_not_a_turn_end() {
        for name in OPENCODE_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Opencode, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !OPENCODE_EVENTS
                .iter()
                .any(|(name, _)| OPENCODE_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn antigravitys_step_events_split_between_a_gated_block_and_correlation() {
        let agy = proto::AgentKind::Antigravity;
        assert_eq!(
            AgentEvent::from_provider(agy, "Stop"),
            Some(AgentEvent::TurnEnded)
        );
        assert_eq!(
            AgentEvent::from_provider(agy, "SessionStart"),
            Some(AgentEvent::SessionStarted)
        );
        assert_eq!(
            AgentEvent::from_provider(agy, "PreInvocation"),
            Some(AgentEvent::PromptSubmitted)
        );
        assert_eq!(
            AgentEvent::from_provider(agy, "PreToolUse"),
            Some(AgentEvent::NeedsInput),
            "the table says a block is possible; the daemon's tool-name gate says whether \
             THIS one is"
        );
        assert_eq!(
            AgentEvent::from_provider(agy, "PostInvocation"),
            None,
            "Antigravity's PostInvocation fires mid-turn and must map to nothing"
        );
    }

    #[test]
    fn antigravity_post_tool_use_is_correlation_only() {
        for name in ANTIGRAVITY_CORRELATION_EVENTS {
            assert_eq!(
                AgentEvent::from_provider(proto::AgentKind::Antigravity, name),
                None,
                "{name} is correlation evidence, never a pane status"
            );
        }
        assert!(
            !ANTIGRAVITY_EVENTS
                .iter()
                .any(|(name, _)| ANTIGRAVITY_CORRELATION_EVENTS.contains(name)),
            "the two lists must not overlap — the status table is the one \
             `from_provider` reads"
        );
    }

    #[test]
    fn a_subagent_finishing_is_never_read_as_a_turn_end() {
        for kind in [proto::AgentKind::Claude, proto::AgentKind::Grok] {
            assert_eq!(
                AgentEvent::from_provider(kind, "SubagentStop"),
                None,
                "{kind:?} must not read SubagentStop — it fires mid-turn"
            );
        }
    }

    #[test]
    fn every_event_drives_a_status_and_only_terminal_attention_reports_a_notice() {
        assert_eq!(
            AgentEvent::SessionStarted.status(),
            proto::AgentStatus::Idle
        );
        assert_eq!(
            AgentEvent::PromptSubmitted.status(),
            proto::AgentStatus::Working
        );
        assert_eq!(AgentEvent::Activity.status(), proto::AgentStatus::Working);
        assert_eq!(AgentEvent::TurnEnded.status(), proto::AgentStatus::Idle);
        assert_eq!(
            AgentEvent::TurnInterrupted.status(),
            proto::AgentStatus::Idle
        );
        assert_eq!(
            AgentEvent::InputResolved.status(),
            proto::AgentStatus::Working
        );
        assert_eq!(
            AgentEvent::NeedsInput.status(),
            proto::AgentStatus::NeedsInput
        );

        assert_eq!(
            AgentEvent::TurnEnded.notice("Stop"),
            Some(proto::AgentNoticeKind::Finished)
        );
        assert_eq!(
            AgentEvent::TurnEnded.notice("StopFailure"),
            Some(proto::AgentNoticeKind::Error)
        );
        assert_eq!(
            AgentEvent::TurnEnded.notice("session.error"),
            Some(proto::AgentNoticeKind::Error)
        );
        assert_eq!(
            AgentEvent::NeedsInput.notice("PermissionRequest"),
            Some(proto::AgentNoticeKind::NeedsInput)
        );
        assert_eq!(AgentEvent::PromptSubmitted.notice("prompt"), None);
        assert_eq!(AgentEvent::Activity.notice("session.status"), None);
        assert_eq!(AgentEvent::InputResolved.notice("resolved"), None);
        assert_eq!(AgentEvent::TurnInterrupted.notice("Interrupt"), None);
        assert_eq!(AgentEvent::SessionStarted.notice("start"), None);
    }

    #[test]
    fn only_an_ambiguous_idle_notification_is_suppressed() {
        assert!(!AgentEvent::NeedsInput.applies(Some(proto::AgentStatus::Idle), true));
        assert!(AgentEvent::NeedsInput.applies(Some(proto::AgentStatus::Idle), false));

        assert!(AgentEvent::NeedsInput.applies(Some(proto::AgentStatus::Working), true));
        assert!(AgentEvent::NeedsInput.applies(Some(proto::AgentStatus::Spawning), true));
        assert!(AgentEvent::NeedsInput.applies(Some(proto::AgentStatus::NeedsInput), true));
        assert!(AgentEvent::NeedsInput.applies(None, true));

        for status in [
            None,
            Some(proto::AgentStatus::Idle),
            Some(proto::AgentStatus::Working),
            Some(proto::AgentStatus::Spawning),
            Some(proto::AgentStatus::NeedsInput),
            Some(proto::AgentStatus::Unavailable),
        ] {
            assert!(AgentEvent::SessionStarted.applies(status, false));
            assert!(AgentEvent::PromptSubmitted.applies(status, false));
            assert!(AgentEvent::Activity.applies(status, false));
            assert_eq!(
                AgentEvent::InputResolved.applies(status, false),
                status == Some(proto::AgentStatus::NeedsInput)
            );
            assert!(AgentEvent::TurnEnded.applies(status, false));
            assert!(AgentEvent::TurnInterrupted.applies(status, false));
        }
    }
}

use houston_protocol as proto;
use std::time::{Duration, Instant};

// Half-second coalescing bounds hook-driven JSON traffic while keeping rail text responsive.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Default)]
pub struct Tracker {
    activity: Option<proto::SessionActivity>,
    last_sent: Option<Instant>,
    pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispatch {
    Unchanged,
    SendNow,
    Schedule(Duration),
}

impl Tracker {
    pub fn activity(&self) -> Option<proto::SessionActivity> {
        self.activity.clone()
    }

    pub fn update(
        &mut self,
        provider: proto::AgentKind,
        event: &str,
        prompt: Option<&str>,
        last_message: Option<&str>,
        tool: Option<&str>,
        now: Instant,
    ) -> Dispatch {
        let mut activity = self.activity.clone().unwrap_or(proto::SessionActivity {
            prompt: None,
            last_message: None,
            tool: None,
            model: None,
        });
        let before = activity.clone();
        let event_kind = crate::agent_events::AgentEvent::from_provider(provider, event);

        if event_kind == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            activity.prompt = prompt.and_then(first_line);
            activity.last_message = None;
            activity.tool = None;
        }
        if crate::orchestrate::provider_capabilities(provider).last_message {
            if let Some(message) = last_message.and_then(first_line) {
                activity.last_message = Some(message);
            }
        }
        if is_tool_end(provider, event) {
            activity.tool = None;
        } else if let Some(name) = tool.and_then(first_line) {
            activity.tool = Some(name);
        }
        if matches!(
            event_kind,
            Some(
                crate::agent_events::AgentEvent::TurnEnded
                    | crate::agent_events::AgentEvent::TurnInterrupted
                    | crate::agent_events::AgentEvent::TurnFailed
            )
        ) {
            activity.tool = None;
        }

        if activity == before {
            return Dispatch::Unchanged;
        }
        if activity.prompt.is_none()
            && activity.last_message.is_none()
            && activity.tool.is_none()
            && activity.model.is_none()
        {
            self.activity = None;
        } else {
            self.activity = Some(activity);
        }

        let Some(last_sent) = self.last_sent else {
            self.last_sent = Some(now);
            return Dispatch::SendNow;
        };
        let elapsed = now.saturating_duration_since(last_sent);
        if elapsed >= COALESCE_WINDOW {
            self.last_sent = Some(now);
            self.pending = false;
            Dispatch::SendNow
        } else if self.pending {
            Dispatch::Unchanged
        } else {
            self.pending = true;
            Dispatch::Schedule(COALESCE_WINDOW - elapsed)
        }
    }

    pub fn flush(&mut self, now: Instant) -> Option<Option<proto::SessionActivity>> {
        if !self.pending {
            return None;
        }
        self.pending = false;
        self.last_sent = Some(now);
        Some(self.activity())
    }
}

fn first_line(value: &str) -> Option<String> {
    let line = value.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(160).collect())
}

fn is_tool_end(provider: proto::AgentKind, event: &str) -> bool {
    matches!(
        (provider, event),
        (
            proto::AgentKind::Claude,
            "PostToolUse" | "PostToolUseFailure"
        ) | (proto::AgentKind::Codex, "PostToolUse")
            | (proto::AgentKind::Antigravity, "PostToolUse")
    )
}

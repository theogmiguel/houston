//! Where each provider reports a usage limit. Status and limits come from typed
//! provider events only; this module names the channel each provider uses so a
//! run knows whether it can switch away from one that stops working.
use houston_protocol as proto;

use crate::hook_drop::HookDrop;

/// The error class a provider's hook reports for a plan or rate limit.
pub const LIMIT_ERROR: &str = "rate_limit";

/// How a provider tells Houston it hit a usage limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitSignal {
    /// A lifecycle hook carries the provider's typed error class.
    Hook,
    /// The pane-owned app server reports it on the live thread.
    AppServer,
    /// A headless probe that runs only after a stalled pane.
    StallProbe,
    /// No typed signal: a run could not tell a slow turn from a spent quota.
    NoSignal,
}

/// Codex's app-server observer is Unix-only; Windows uses the stall probe.
pub fn signal_for(provider: proto::AgentKind, windows: bool) -> LimitSignal {
    match provider {
        proto::AgentKind::Claude | proto::AgentKind::Opencode => LimitSignal::Hook,
        proto::AgentKind::Codex => {
            if windows {
                LimitSignal::StallProbe
            } else {
                LimitSignal::AppServer
            }
        }
        proto::AgentKind::Zcode => LimitSignal::StallProbe,
        _ => LimitSignal::NoSignal,
    }
}

/// A provider whose limit Houston never hears about.
pub fn reports_no_limit(provider: proto::AgentKind, windows: bool) -> bool {
    signal_for(provider, windows) == LimitSignal::NoSignal
}

/// The limit a root hook drop reports; the provider's own error class decides.
pub fn hook_limit(provider: proto::AgentKind, d: &HookDrop) -> Option<proto::SessionLimit> {
    let event = match provider {
        proto::AgentKind::Claude => "StopFailure",
        proto::AgentKind::Opencode => "session.error",
        _ => return None,
    };
    (d.event == event && d.agent_id.is_none() && d.error.as_deref() == Some(LIMIT_ERROR)).then(
        || proto::SessionLimit {
            error: LIMIT_ERROR.to_string(),
            details: d
                .error_details
                .as_deref()
                .map(crate::daemon::bounded_hook_text)
                .filter(|details| !details.is_empty()),
            since_ms: crate::daemon::now_ms(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn limit_drop(event: &str, error: Option<&str>) -> HookDrop {
        HookDrop {
            event: event.into(),
            error: error.map(String::from),
            error_details: Some("Usage limit reached for this account".into()),
            ..HookDrop::default()
        }
    }

    #[test]
    fn every_provider_names_one_signal_on_each_platform() {
        for windows in [false, true] {
            for kind in EVERY_KIND {
                let expected = match kind {
                    proto::AgentKind::Claude | proto::AgentKind::Opencode => LimitSignal::Hook,
                    proto::AgentKind::Codex if !windows => LimitSignal::AppServer,
                    proto::AgentKind::Codex | proto::AgentKind::Zcode => LimitSignal::StallProbe,
                    _ => LimitSignal::NoSignal,
                };
                assert_eq!(
                    signal_for(kind, windows),
                    expected,
                    "{kind:?} windows={windows}"
                );
                assert_eq!(
                    reports_no_limit(kind, windows),
                    expected == LimitSignal::NoSignal,
                    "{kind:?} windows={windows}"
                );
            }
        }
    }

    #[test]
    fn claudes_stop_failure_rate_limit_is_a_limit() {
        let d = limit_drop("StopFailure", Some(LIMIT_ERROR));
        let limit = hook_limit(proto::AgentKind::Claude, &d).expect("a limit");
        assert_eq!(limit.error, LIMIT_ERROR);
        assert_eq!(
            limit.details.as_deref(),
            Some("Usage limit reached for this account")
        );
        assert_eq!(
            hook_limit(
                proto::AgentKind::Claude,
                &limit_drop("Stop", Some(LIMIT_ERROR))
            ),
            None,
            "only StopFailure reports it"
        );
        assert_eq!(
            hook_limit(
                proto::AgentKind::Claude,
                &limit_drop("StopFailure", Some("overloaded"))
            ),
            None
        );
        assert_eq!(
            hook_limit(proto::AgentKind::Claude, &limit_drop("StopFailure", None)),
            None
        );
    }

    #[test]
    fn opencodes_session_error_rate_limit_is_a_limit() {
        let limit = hook_limit(
            proto::AgentKind::Opencode,
            &limit_drop("session.error", Some(LIMIT_ERROR)),
        )
        .expect("a limit");
        assert_eq!(limit.error, LIMIT_ERROR);
        for (event, error) in [
            ("session.error", Some("server_error")),
            ("session.error", None),
            ("session.idle", Some(LIMIT_ERROR)),
        ] {
            assert_eq!(
                hook_limit(proto::AgentKind::Opencode, &limit_drop(event, error)),
                None,
                "{event} {error:?}"
            );
        }
    }

    #[test]
    fn a_non_root_drop_or_another_provider_reports_no_limit() {
        let mut child = limit_drop("StopFailure", Some(LIMIT_ERROR));
        child.agent_id = Some("subagent-1".into());
        assert_eq!(hook_limit(proto::AgentKind::Claude, &child), None);

        let opencode = limit_drop("session.error", Some(LIMIT_ERROR));
        assert_eq!(hook_limit(proto::AgentKind::Codex, &opencode), None);
        assert_eq!(hook_limit(proto::AgentKind::Zcode, &opencode), None);
        assert_eq!(hook_limit(proto::AgentKind::Claude, &opencode), None);
    }

    #[test]
    fn a_limit_without_details_stays_empty() {
        let mut d = limit_drop("StopFailure", Some(LIMIT_ERROR));
        d.error_details = Some("   ".into());
        assert_eq!(
            hook_limit(proto::AgentKind::Claude, &d).unwrap().details,
            None
        );
    }
}

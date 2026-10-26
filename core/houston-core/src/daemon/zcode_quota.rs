//! The opt-in ZCode quota check outside Night shift. A pane that shows Working
//! while its CLI reports no failed turn gets one headless probe; the probe's
//! exit is typed evidence, never a reading of the pane's screen.
use std::collections::HashMap;
use std::sync::Arc;

use houston_protocol as proto;

use super::{now_ms, Daemon};
use crate::night_shift::provider_probe;

const SETTING: &str = "zcode_quota_check";
const PROBE_STALL_MS: u64 = 60_000;

#[derive(Default)]
pub(crate) struct ZcodeQuotaState {
    /// Session -> when its last probe started, so one stall window probes once.
    probe_at: HashMap<u32, u64>,
    /// One ZCode probe at a time on the machine.
    pub(super) probe_busy: bool,
}

impl Daemon {
    pub fn zcode_quota_check_enabled(&self) -> bool {
        setting_enabled(self.db.get_setting(SETTING).ok().flatten().as_deref())
    }

    pub fn set_zcode_quota_check(&self, enabled: bool) -> anyhow::Result<()> {
        self.db
            .set_setting(SETTING, if enabled { "1" } else { "0" })?;
        self.broadcast_control(&proto::ServerMsg::ZcodeQuotaCheck { enabled });
        Ok(())
    }

    /// One pass over the panes outside a Night shift run: a ZCode pane Working
    /// for the stall window, with no probe in that window, gets the shared
    /// probe when the setting is on.
    pub fn zcode_quota_tick_at(self: &Arc<Self>, now_ms: u64) {
        if !self.zcode_quota_check_enabled() {
            return;
        }
        let stall = u64::from(proto::NIGHT_SHIFT_STALL_MINUTES) * PROBE_STALL_MS;
        let ids: Vec<u32> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions
                .values()
                .filter(|s| s.info.agent == proto::AgentKind::Zcode && !s.info.hidden)
                .map(|s| s.info.id)
                .collect()
        };
        let mut candidate = None;
        for id in ids {
            if self.night_run_of_pane(id).is_some() {
                continue;
            }
            let Ok(session) = self.get(id) else {
                continue;
            };
            let working =
                *session.status.lock().expect("status lock") == Some(proto::AgentStatus::Working);
            let since = *session.status_since_ms.lock().expect("status since lock");
            let Some(since) = since else { continue };
            let last = self
                .zcode_quota
                .lock()
                .expect("zcode quota")
                .probe_at
                .get(&id)
                .copied();
            if should_probe(working, since, now_ms, last, stall) {
                candidate = Some(id);
                break;
            }
        }
        let Some(id) = candidate else {
            return;
        };
        {
            let mut state = self.zcode_quota.lock().expect("zcode quota");
            if state.probe_busy {
                return;
            }
            state.probe_busy = true;
            state.probe_at.insert(id, now_ms);
        }
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("zcode-quota-probe".into())
            .spawn(move || {
                let outcome = me.quota_probe_run(proto::AgentKind::Zcode);
                match outcome {
                    provider_probe::Outcome::Answered => {}
                    // The pane is already stalled: no answer counts as failed.
                    provider_probe::Outcome::Failed(why)
                    | provider_probe::Outcome::TimedOut(why) => me.zcode_quota_failed(id, &why),
                    provider_probe::Outcome::Unavailable(why) => tracing::info!(
                        "ZCode quota probe for pane {id} could not run ({why}); the pane is left \
                         alone"
                    ),
                }
                me.zcode_quota.lock().expect("zcode quota").probe_busy = false;
            });
        if let Err(e) = spawned {
            tracing::warn!("starting ZCode quota probe for pane {id}: {e}");
            self.zcode_quota.lock().expect("zcode quota").probe_busy = false;
        }
    }

    /// A failed probe: the pane becomes Limited with `quota`, its failed turn
    /// ends and its delegation round closes as Claude's StopFailure closes it.
    fn zcode_quota_failed(self: &Arc<Self>, id: u32, why: &str) {
        let reason = format!("zcode quota probe failed: {why}");
        let details = match provider_probe::reset_at(why) {
            Some(at) => format!("{reason} (reset at {at})"),
            None => reason.clone(),
        };
        if self.ensure_not_closing(id, "ZCode quota probe").is_err() {
            return;
        }
        let Ok(session) = self.get(id) else {
            return;
        };
        if !session.state.lock().expect("state lock").is_live() {
            return;
        }
        let limit = proto::SessionLimit {
            error: "quota".into(),
            details: Some(crate::daemon::bounded_hook_text(&details)),
            since_ms: now_ms(),
        };
        {
            let _guard = self
                .temporary_cleanup_lock
                .lock()
                .expect("temporary cleanup lock");
            let started = self.mark_limited(id, &session, limit);
            self.night_shift_provider_limited(id, proto::AgentKind::Zcode, &reason);
            if self.record_failed_turn(id, proto::AgentKind::Zcode, &reason, true, started, None) {
                tracing::warn!("recording ZCode quota limit for pane {id} must be retried");
            }
        }
        self.apply_agent_event(
            id,
            "ZCode quota probe",
            crate::agent_events::AgentEvent::TurnFailed,
            false,
            false,
            None,
        );
    }
}

/// The setting is opt-in: only the stored `1` turns it on.
fn setting_enabled(stored: Option<&str>) -> bool {
    stored == Some("1")
}

/// A pane gets a probe when it is Working through the stall window and its last
/// probe is at least a stall window old.
fn should_probe(working: bool, since_ms: u64, now_ms: u64, last: Option<u64>, stall: u64) -> bool {
    working
        && now_ms.saturating_sub(since_ms) >= stall
        && last.is_none_or(|at| now_ms.saturating_sub(at) >= stall)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_is_off_until_stored_as_one() {
        assert!(!setting_enabled(None));
        assert!(!setting_enabled(Some("0")));
        assert!(!setting_enabled(Some("true")));
        assert!(setting_enabled(Some("1")));
    }

    #[test]
    fn a_probe_needs_working_the_whole_window_and_no_recent_probe() {
        let stall = 20 * PROBE_STALL_MS;
        assert!(should_probe(true, 1_000, 1_000 + stall, None, stall));
        assert!(!should_probe(true, 1_000, 1_000 + stall - 1, None, stall));
        assert!(!should_probe(false, 1_000, 1_000 + stall, None, stall));
        assert!(!should_probe(
            true,
            1_000,
            1_000 + stall,
            Some(1_000 + stall / 2),
            stall
        ));
        assert!(should_probe(
            true,
            1_000,
            1_000 + 2 * stall,
            Some(1_000 + stall),
            stall
        ));
    }
}

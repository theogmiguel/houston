use std::collections::VecDeque;

use super::log::{ThresholdCrossed, TransitionLog, Trigger};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    /// Probe period while the window is visible.
    pub probe_ms: u64,
    /// Probe period while hidden: five times slower, since a minimized app
    /// waking the webview thirty times a minute to confirm an invisible
    /// compositor is wasted work; still frequent enough to catch it on return.
    pub probe_hidden_ms: u64,
    pub warn_ms: u64,
    /// An outstanding probe older than this counts as a failed probe.
    pub hang_ms: u64,
    /// Consecutive failed probes required before declaring `Unresponsive`.
    pub confirm: u32,
    pub suspend_ms: u64,
    /// `wall - boot` divergence that classifies an NTP step. Kept as a
    /// separate knob from `suspend_ms` on purpose: retuning suspend
    /// sensitivity must not silently retune wall-step sensitivity too.
    pub wall_step_ms: u64,
    pub grace_ms: u64,
    pub clock_tick_ms: u64,
    pub paint_ms: u64,
    /// Reload budget: `reload_budget` reloads per `reload_window_ms`, with
    /// `reload_cooldown_ms` between attempts, so a crash loop degrades to
    /// the "Gone" terminal state instead of reloading forever.
    pub reload_cooldown_ms: u64,
    pub reload_budget: u32,
    pub reload_window_ms: u64,
    pub boot_ms: u64,
    pub recover_ms: u64,
    /// How long the recovery confirmation dialog stays up before a timeout
    /// is treated as confirmed, so an unattended machine still recovers.
    pub prompt_timeout_ms: u64,
    pub dpr_poll_ms: u64,
    pub rtt_summary_probes: u32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            probe_ms: 2_000,
            probe_hidden_ms: 10_000,
            warn_ms: 1_500,
            hang_ms: 10_000,
            confirm: 3,
            suspend_ms: 2_000,
            wall_step_ms: 2_000,
            grace_ms: 15_000,
            clock_tick_ms: 1_000,
            paint_ms: 5_000,
            reload_cooldown_ms: 60_000,
            reload_budget: 3,
            reload_window_ms: 10 * 60_000,
            boot_ms: 30_000,
            recover_ms: 20_000,
            prompt_timeout_ms: 10_000,
            dpr_poll_ms: 1_000,
            rtt_summary_probes: 30,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Booting,
    Healthy,
    Suspect,
    Unresponsive,
    PaintStalled,
    Gone,
    Recovering,
    Halted,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Booting => "booting",
            State::Healthy => "healthy",
            State::Suspect => "suspect",
            State::Unresponsive => "unresponsive",
            State::PaintStalled => "paint-stalled",
            State::Gone => "gone",
            State::Recovering => "recovering",
            State::Halted => "halted",
        }
    }

    fn wants_recovery(self) -> bool {
        matches!(
            self,
            State::Unresponsive | State::PaintStalled | State::Gone
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    Crashed,
    ExceededMemoryLimit,
    TerminatedByApi,
}

impl TerminationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminationReason::Crashed => "web-process-crashed",
            TerminationReason::ExceededMemoryLimit => "web-process-oom",
            TerminationReason::TerminatedByApi => "web-process-api",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Tick,
    PageLoaded,
    ProbeReturned { rtt_ms: u64 },
    ProbeFailed,
    Suspended { suspended_ms: u64 },
    WallStep { step_ms: i64 },
    Starved { by_ms: u64 },
    WebProcessTerminated { reason: TerminationReason },
    ResponsivenessChanged { responsive: bool },
    InspectorAttached(bool),
    WindowVisible(bool),
    WindowFocused(bool),
    PaintReport { ok: bool, raf_gap_ms: u64 },
    ReloadRequested { reason: String },
    RecoveryConfirmed { timed_out: bool },
    RecoveryDeclined,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Log(TransitionLog),
    DiscardOutstandingProbes,
    EmitWake { suspended_ms: u64 },
    Reload,
    TerminateWebProcess,
    RecordReloadInPage,
    PromptThenRecover { timeout_ms: u64 },
    SetTitle(TitleState),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleState {
    Normal,
    NotResponding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReloadBlock {
    Cooldown,
    BudgetExhausted,
}

#[derive(Debug, Clone)]
struct Incident {
    id: u64,
    reason: String,
    rung: u8,
    rung_issued_ms: Option<u64>,
    expecting_api_termination: bool,
    prompt_deadline_ms: Option<u64>,
}

pub struct Machine {
    state: State,
    thresholds: Thresholds,
    failures: u32,
    grace_until_ms: Option<u64>,
    inspector_attached: bool,
    window_visible: bool,
    window_focused: bool,
    responsive: bool,
    reloads: VecDeque<u64>,
    last_reload_ms: Option<u64>,
    recovery_enabled: bool,
    incident: Option<Incident>,
    next_incident_id: u64,
    booting_since_ms: u64,
    rtt_history: VecDeque<u64>,
    withheld_logged: Option<&'static str>,
    rtt_window: Vec<u64>,
}

const RTT_HISTORY_LEN: usize = 16;

fn summarise(window: &mut [u64]) -> Trigger {
    window.sort_unstable();
    let n = window.len();
    let rank = |p: f64| window[(((n as f64) * p).ceil() as usize).clamp(1, n) - 1];
    Trigger::ProbeRttSummary {
        count: n as u32,
        min_ms: window[0],
        p50_ms: rank(0.50),
        p99_ms: rank(0.99),
        max_ms: window[n - 1],
    }
}

impl Machine {
    pub fn new(thresholds: Thresholds, recovery_enabled: bool, now_ms: u64) -> Self {
        Self {
            state: State::Booting,
            thresholds,
            failures: 0,
            grace_until_ms: None,
            inspector_attached: false,
            window_visible: true,
            window_focused: true,
            responsive: true,
            reloads: VecDeque::new(),
            last_reload_ms: None,
            recovery_enabled,
            incident: None,
            next_incident_id: 1,
            booting_since_ms: now_ms,
            withheld_logged: None,
            rtt_history: VecDeque::new(),
            rtt_window: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn state(&self) -> State {
        self.state
    }

    pub fn thresholds(&self) -> Thresholds {
        self.thresholds
    }

    pub fn probe_period_ms(&self) -> u64 {
        if self.window_visible {
            self.thresholds.probe_ms
        } else {
            self.thresholds.probe_hidden_ms
        }
    }

    #[cfg(test)]
    pub fn is_suppressed(&self, now_ms: u64) -> bool {
        self.inspector_attached
            || !self.window_visible
            || self.grace_until_ms.is_some_and(|until| now_ms < until)
    }

    fn suppression_reason(&self, now_ms: u64) -> Option<&'static str> {
        if self.inspector_attached {
            Some("inspector-attached")
        } else if !self.window_visible {
            Some("window-not-visible")
        } else if self.grace_until_ms.is_some_and(|until| now_ms < until) {
            Some("post-wake-grace")
        } else {
            None
        }
    }

    fn log(&self, prev: State, trigger: Trigger, crossed: Option<ThresholdCrossed>) -> Action {
        Action::Log(TransitionLog {
            state: self.state.as_str(),
            prev_state: prev.as_str(),
            trigger,
            threshold_crossed: crossed,
            probe_rtt_ms: self.rtt_history.iter().copied().collect(),
            incident_id: self.incident.as_ref().map(|i| i.id),
            incident_reason: self.incident.as_ref().map(|i| i.reason.clone()),
            suppressed: None,
        })
    }

    pub fn on_event(&mut self, event: Event, now_ms: u64) -> Vec<Action> {
        let prev = self.state;
        let mut actions = Vec::new();

        match event {
            Event::PageLoaded => {}

            Event::Tick => {
                self.on_tick(now_ms, prev, &mut actions);
                return actions;
            }

            Event::ProbeReturned { rtt_ms } => {
                self.rtt_history.push_back(rtt_ms);
                while self.rtt_history.len() > RTT_HISTORY_LEN {
                    self.rtt_history.pop_front();
                }
                self.rtt_window.push(rtt_ms);
                if self.rtt_window.len() as u32 >= self.thresholds.rtt_summary_probes {
                    let summary = summarise(&mut self.rtt_window);
                    self.rtt_window.clear();
                    actions.push(self.log(prev, summary, None));
                }
                self.failures = 0;
                let crossed = (rtt_ms >= self.thresholds.warn_ms)
                    .then(|| ThresholdCrossed::new("T_warn", self.thresholds.warn_ms, rtt_ms));
                match self.state {
                    State::Booting | State::Suspect | State::Recovering | State::Unresponsive => {
                        self.state = State::Healthy;
                        self.close_incident();
                        actions.push(self.log(prev, Trigger::ProbeReturned { rtt_ms }, crossed));
                        actions.push(Action::SetTitle(TitleState::Normal));
                    }
                    State::Gone | State::PaintStalled | State::Halted => {}
                    State::Healthy => {
                        if crossed.is_some() {
                            actions.push(self.log(
                                prev,
                                Trigger::ProbeReturned { rtt_ms },
                                crossed,
                            ));
                        }
                    }
                }
            }

            Event::ProbeFailed => {
                self.failures = self.failures.saturating_add(1);
                let crossed = ThresholdCrossed::new(
                    "T_hang",
                    self.thresholds.hang_ms,
                    self.thresholds.hang_ms,
                );
                match self.state {
                    State::Healthy | State::Booting => {
                        self.state = State::Suspect;
                        actions.push(self.log(
                            prev,
                            Trigger::ProbeFailed {
                                consecutive: self.failures,
                                responsive: self.responsive,
                            },
                            Some(crossed),
                        ));
                    }
                    State::Suspect => {
                        if self.failures >= self.thresholds.confirm {
                            self.enter_unresponsive("js-hang", now_ms);
                            actions.push(self.log(
                                prev,
                                Trigger::ProbeFailed {
                                    consecutive: self.failures,
                                    responsive: self.responsive,
                                },
                                Some(ThresholdCrossed::new(
                                    "N_confirm",
                                    self.thresholds.confirm as u64,
                                    self.failures as u64,
                                )),
                            ));
                            self.maybe_recover(now_ms, &mut actions);
                        } else {
                            actions.push(self.log(
                                prev,
                                Trigger::ProbeFailed {
                                    consecutive: self.failures,
                                    responsive: self.responsive,
                                },
                                Some(crossed),
                            ));
                        }
                    }
                    _ => {}
                }
            }

            Event::Suspended { suspended_ms } => {
                self.grace_until_ms = Some(now_ms.saturating_add(self.thresholds.grace_ms));
                self.failures = 0;
                actions.push(Action::DiscardOutstandingProbes);
                actions.push(Action::EmitWake { suspended_ms });
                actions.push(self.log(
                    prev,
                    Trigger::Suspend { suspended_ms },
                    Some(ThresholdCrossed::new(
                        "T_suspend",
                        self.thresholds.suspend_ms,
                        suspended_ms,
                    )),
                ));
            }

            Event::WallStep { step_ms } => {
                actions.push(self.log(prev, Trigger::WallStep { step_ms }, None));
            }

            Event::Starved { by_ms } => {
                self.failures = 0;
                actions.push(Action::DiscardOutstandingProbes);
                actions.push(self.log(prev, Trigger::Starved { by_ms }, None));
            }

            Event::WebProcessTerminated { reason } => {
                let expected = self
                    .incident
                    .as_ref()
                    .is_some_and(|i| i.expecting_api_termination)
                    && reason == TerminationReason::TerminatedByApi;
                if let Some(incident) = self.incident.as_mut() {
                    incident.expecting_api_termination = false;
                }
                if expected {
                    actions.push(self.log(prev, Trigger::WebProcessTerminated { reason }, None));
                } else {
                    self.state = State::Gone;
                    self.open_incident(reason.as_str());
                    actions.push(self.log(prev, Trigger::WebProcessTerminated { reason }, None));
                    self.maybe_recover(now_ms, &mut actions);
                }
            }

            Event::ResponsivenessChanged { responsive } => {
                if responsive == self.responsive {
                    return actions;
                }
                self.responsive = responsive;
                actions.push(self.log(prev, Trigger::Responsiveness { responsive }, None));
            }

            Event::InspectorAttached(attached) => {
                self.inspector_attached = attached;
            }

            Event::WindowVisible(visible) => {
                self.window_visible = visible;
            }

            Event::WindowFocused(focused) => {
                self.window_focused = focused;
            }

            Event::PaintReport { ok, raf_gap_ms } => {
                if !self.window_visible {
                    return actions;
                }
                match (ok, self.state) {
                    (false, State::Healthy) => {
                        self.state = State::PaintStalled;
                        self.open_incident("compositor-stall");
                        actions.push(self.log(
                            prev,
                            Trigger::PaintReport { ok, raf_gap_ms },
                            Some(ThresholdCrossed::new(
                                "T_paint",
                                self.thresholds.paint_ms,
                                raf_gap_ms,
                            )),
                        ));
                        self.maybe_recover(now_ms, &mut actions);
                    }
                    (true, State::PaintStalled) => {
                        self.state = State::Healthy;
                        self.close_incident();
                        actions.push(self.log(prev, Trigger::PaintReport { ok, raf_gap_ms }, None));
                        actions.push(Action::SetTitle(TitleState::Normal));
                    }
                    _ => {}
                }
            }

            Event::ReloadRequested { reason } => {
                self.close_incident();
                self.open_incident(&format!("renderer-requested:{reason}"));
                self.state = State::Recovering;
                actions.push(self.log(prev, Trigger::ReloadRequested { reason }, None));
                self.issue_rung(now_ms, &mut actions);
            }

            Event::RecoveryConfirmed { timed_out } => {
                if !self.prompt_outstanding() {
                    actions.push(self.log(prev, Trigger::PromptStale, None));
                    return actions;
                }
                if let Some(incident) = self.incident.as_mut() {
                    incident.prompt_deadline_ms = None;
                }
                actions.push(self.log(prev, Trigger::PromptAnswered { timed_out }, None));
                self.issue_rung(now_ms, &mut actions);
            }

            Event::RecoveryDeclined => {
                if !self.prompt_outstanding() {
                    actions.push(self.log(prev, Trigger::PromptStale, None));
                    return actions;
                }
                if let Some(incident) = self.incident.as_mut() {
                    incident.prompt_deadline_ms = None;
                }
                self.state = State::Halted;
                actions.push(self.log(prev, Trigger::PromptDeclined, None));
                actions.push(Action::SetTitle(TitleState::NotResponding));
            }
        }

        actions
    }

    fn on_tick(&mut self, now_ms: u64, prev: State, actions: &mut Vec<Action>) {
        if self.state == State::Booting
            && now_ms.saturating_sub(self.booting_since_ms) >= self.thresholds.boot_ms
        {
            self.enter_unresponsive("boot-timeout", now_ms);
            actions.push(self.log(
                prev,
                Trigger::BootTimeout,
                Some(ThresholdCrossed::new(
                    "T_boot",
                    self.thresholds.boot_ms,
                    now_ms.saturating_sub(self.booting_since_ms),
                )),
            ));
            self.maybe_recover(now_ms, actions);
            return;
        }

        let prompt_expired = self
            .incident
            .as_ref()
            .and_then(|i| i.prompt_deadline_ms)
            .is_some_and(|deadline| now_ms >= deadline);
        if prompt_expired {
            if let Some(incident) = self.incident.as_mut() {
                incident.prompt_deadline_ms = None;
            }
            actions.push(self.log(prev, Trigger::PromptAnswered { timed_out: true }, None));
            self.issue_rung(now_ms, actions);
            return;
        }

        let rung_expired = self.state == State::Recovering
            && self
                .incident
                .as_ref()
                .and_then(|i| i.rung_issued_ms)
                .is_some_and(|issued| now_ms.saturating_sub(issued) >= self.thresholds.recover_ms);
        if rung_expired {
            self.issue_rung(now_ms, actions);
            return;
        }

        if self.state.wants_recovery() {
            self.maybe_recover(now_ms, actions);
        }
    }

    fn enter_unresponsive(&mut self, reason: &str, _now_ms: u64) {
        self.state = State::Unresponsive;
        self.open_incident(reason);
    }

    fn open_incident(&mut self, reason: &str) {
        if self.incident.is_some() {
            return;
        }
        let id = self.next_incident_id;
        self.next_incident_id += 1;
        self.withheld_logged = None;
        self.incident = Some(Incident {
            id,
            reason: reason.to_string(),
            rung: 0,
            rung_issued_ms: None,
            expecting_api_termination: false,
            prompt_deadline_ms: None,
        });
    }

    fn prompt_outstanding(&self) -> bool {
        self.incident
            .as_ref()
            .is_some_and(|i| i.prompt_deadline_ms.is_some())
    }

    fn close_incident(&mut self) {
        self.incident = None;
        self.failures = 0;
        self.withheld_logged = None;
    }

    fn maybe_recover(&mut self, now_ms: u64, actions: &mut Vec<Action>) {
        let prev = self.state;
        actions.push(Action::SetTitle(TitleState::NotResponding));

        if !self.recovery_enabled {
            self.log_withheld(prev, "detect-only", actions);
            return;
        }

        if let Some(reason) = self.suppression_reason(now_ms) {
            self.log_withheld(prev, reason, actions);
            return;
        }

        match self.reload_block(now_ms) {
            Some(ReloadBlock::BudgetExhausted) => {
                self.state = State::Halted;
                actions.push(self.log(prev, Trigger::BudgetExhausted, None));
                actions.push(Action::SetTitle(TitleState::NotResponding));
                return;
            }
            Some(ReloadBlock::Cooldown) => {
                self.log_withheld(prev, "reload-cooldown", actions);
                return;
            }
            None => {}
        }

        if self.window_focused {
            let deadline = now_ms.saturating_add(self.thresholds.prompt_timeout_ms);
            if let Some(incident) = self.incident.as_mut() {
                if incident.prompt_deadline_ms.is_some() {
                    return;
                }
                incident.prompt_deadline_ms = Some(deadline);
            }
            self.state = State::Recovering;
            actions.push(self.log(prev, Trigger::PromptIssued, None));
            actions.push(Action::PromptThenRecover {
                timeout_ms: self.thresholds.prompt_timeout_ms,
            });
            return;
        }

        self.state = State::Recovering;
        actions.push(self.log(prev, Trigger::RecoveryStarted, None));
        self.issue_rung(now_ms, actions);
    }

    fn log_withheld(&mut self, prev: State, reason: &'static str, actions: &mut Vec<Action>) {
        if self.withheld_logged == Some(reason) {
            return;
        }
        self.withheld_logged = Some(reason);
        actions.push(Action::Log(TransitionLog {
            state: self.state.as_str(),
            prev_state: prev.as_str(),
            trigger: Trigger::RecoveryWithheld { reason },
            threshold_crossed: None,
            probe_rtt_ms: self.rtt_history.iter().copied().collect(),
            incident_id: self.incident.as_ref().map(|i| i.id),
            incident_reason: self.incident.as_ref().map(|i| i.reason.clone()),
            suppressed: Some(reason),
        }));
    }

    fn issue_rung(&mut self, now_ms: u64, actions: &mut Vec<Action>) {
        let prev = self.state;
        match self.reload_block(now_ms) {
            Some(ReloadBlock::BudgetExhausted) => {
                self.state = State::Halted;
                actions.push(self.log(prev, Trigger::BudgetExhausted, None));
                actions.push(Action::SetTitle(TitleState::NotResponding));
                return;
            }
            Some(ReloadBlock::Cooldown) => return,
            None => {}
        }
        let Some(incident) = self.incident.as_mut() else {
            return;
        };
        incident.rung += 1;
        let rung = incident.rung;
        incident.rung_issued_ms = Some(now_ms);
        if rung == 2 {
            incident.expecting_api_termination = true;
        }

        match rung {
            1 => {
                self.state = State::Recovering;
                self.record_reload(now_ms);
                actions.push(self.log(prev, Trigger::RecoveryRung { rung: 1 }, None));
                actions.push(Action::RecordReloadInPage);
                actions.push(Action::Reload);
            }
            2 => {
                self.state = State::Recovering;
                self.record_reload(now_ms);
                actions.push(self.log(prev, Trigger::RecoveryRung { rung: 2 }, None));
                actions.push(Action::TerminateWebProcess);
                actions.push(Action::Reload);
            }
            _ => {
                self.state = State::Halted;
                actions.push(self.log(prev, Trigger::LadderExhausted, None));
                actions.push(Action::SetTitle(TitleState::NotResponding));
            }
        }
    }

    fn reload_block(&mut self, now_ms: u64) -> Option<ReloadBlock> {
        let window_start = now_ms.saturating_sub(self.thresholds.reload_window_ms);
        while self.reloads.front().is_some_and(|&t| t < window_start) {
            self.reloads.pop_front();
        }
        if (self.reloads.len() as u32) >= self.thresholds.reload_budget {
            return Some(ReloadBlock::BudgetExhausted);
        }
        if let Some(last) = self.last_reload_ms {
            if now_ms.saturating_sub(last) < self.thresholds.reload_cooldown_ms {
                return Some(ReloadBlock::Cooldown);
            }
        }
        None
    }

    fn record_reload(&mut self, now_ms: u64) {
        self.reloads.push_back(now_ms);
        self.last_reload_ms = Some(now_ms);
        self.booting_since_ms = now_ms;
    }

    pub fn note_reload_issued(&mut self, now_ms: u64) {
        self.booting_since_ms = now_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thresholds() -> Thresholds {
        Thresholds::default()
    }

    fn healthy(recovery: bool) -> Machine {
        let mut m = Machine::new(thresholds(), recovery, 0);
        m.on_event(Event::ProbeReturned { rtt_ms: 5 }, 0);
        assert_eq!(m.state(), State::Healthy);
        m
    }

    fn logs(actions: &[Action]) -> Vec<&TransitionLog> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Log(l) => Some(l),
                _ => None,
            })
            .collect()
    }

    fn has(actions: &[Action], want: &Action) -> bool {
        actions.iter().any(|a| a == want)
    }

    fn fail_to_unresponsive(m: &mut Machine, at_ms: u64) -> Vec<Action> {
        let confirm = m.thresholds().confirm;
        let mut last = Vec::new();
        for _ in 0..confirm {
            last = m.on_event(Event::ProbeFailed, at_ms);
        }
        last
    }

    #[test]
    fn booting_to_healthy_on_first_probe() {
        let mut m = Machine::new(thresholds(), false, 0);
        assert_eq!(m.state(), State::Booting);
        m.on_event(Event::ProbeReturned { rtt_ms: 12 }, 100);
        assert_eq!(m.state(), State::Healthy);
    }

    #[test]
    fn booting_times_out_to_unresponsive() {
        let mut m = Machine::new(thresholds(), false, 0);
        m.on_event(Event::Tick, 29_000);
        assert_eq!(m.state(), State::Booting);
        m.on_event(Event::Tick, 30_000);
        assert_eq!(m.state(), State::Unresponsive);
    }

    #[test]
    fn healthy_to_suspect_on_one_failed_probe() {
        let mut m = healthy(false);
        m.on_event(Event::ProbeFailed, 10_000);
        assert_eq!(m.state(), State::Suspect);
    }

    #[test]
    fn suspect_returns_to_healthy_on_a_probe() {
        let mut m = healthy(false);
        m.on_event(Event::ProbeFailed, 10_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 40 }, 12_000);
        assert_eq!(m.state(), State::Healthy);
    }

    #[test]
    fn n_confirm_failures_declare_unresponsive() {
        let mut m = healthy(false);
        m.on_event(Event::ProbeFailed, 10_000);
        assert_eq!(m.state(), State::Suspect);
        m.on_event(Event::ProbeFailed, 12_000);
        assert_eq!(m.state(), State::Suspect, "two is not yet N_confirm");
        m.on_event(Event::ProbeFailed, 14_000);
        assert_eq!(m.state(), State::Unresponsive);
    }

    #[test]
    fn a_successful_probe_resets_the_failure_count() {
        let mut m = healthy(false);
        m.on_event(Event::ProbeFailed, 10_000);
        m.on_event(Event::ProbeFailed, 12_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 30 }, 13_000);
        m.on_event(Event::ProbeFailed, 20_000);
        m.on_event(Event::ProbeFailed, 22_000);
        assert_eq!(m.state(), State::Suspect);
    }

    #[test]
    fn web_process_terminated_goes_straight_to_gone() {
        let mut m = healthy(false);
        m.on_event(
            Event::WebProcessTerminated {
                reason: TerminationReason::Crashed,
            },
            5_000,
        );
        assert_eq!(m.state(), State::Gone, "condition E has no timeout in it");
    }

    #[test]
    fn oom_termination_is_recorded_with_its_reason() {
        let mut m = healthy(false);
        let a = m.on_event(
            Event::WebProcessTerminated {
                reason: TerminationReason::ExceededMemoryLimit,
            },
            5_000,
        );
        let l = logs(&a);
        assert!(
            l.iter()
                .any(|r| format!("{:?}", r.trigger).contains("ExceededMemoryLimit")),
            "{l:?}"
        );
    }

    #[test]
    fn suppression_blocks_recovery_but_not_detection() {
        let mut m = healthy(true);
        m.on_event(
            Event::Suspended {
                suspended_ms: 60_000,
            },
            1_000,
        );
        let actions = fail_to_unresponsive(&mut m, 2_000);
        assert_eq!(
            m.state(),
            State::Unresponsive,
            "detection continues while suppressed"
        );
        assert!(
            !has(&actions, &Action::Reload),
            "suppression must block the reload: {actions:?}"
        );
        assert!(
            logs(&actions)
                .iter()
                .any(|l| l.suppressed == Some("post-wake-grace")),
            "the withheld recovery must be logged — it is the calibration data: {actions:?}"
        );
    }

    #[test]
    fn grace_lapsing_lets_a_still_wedged_state_escalate() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(
            Event::Suspended {
                suspended_ms: 60_000,
            },
            1_000,
        );
        fail_to_unresponsive(&mut m, 2_000);
        assert_eq!(m.state(), State::Unresponsive);
        let a = m.on_event(Event::Tick, 17_000);
        assert!(
            has(&a, &Action::Reload),
            "a wedge that began during grace must still be acted on once grace lapses: {a:?}"
        );
    }

    #[test]
    fn inspector_attached_suppresses_indefinitely() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(Event::InspectorAttached(true), 0);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert!(
            !has(&a, &Action::Reload),
            "a breakpoint is a deliberate hang"
        );
        let a = m.on_event(Event::Tick, 10_000_000);
        assert!(
            !has(&a, &Action::Reload),
            "still attached, still suppressed"
        );
    }

    #[test]
    fn hidden_window_suppresses_recovery() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(Event::WindowVisible(false), 0);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert!(!has(&a, &Action::Reload), "{a:?}");
    }

    #[test]
    fn suppression_does_not_block_logging_or_state_change() {
        let mut m = healthy(true);
        m.on_event(Event::InspectorAttached(true), 0);
        let a = m.on_event(Event::ProbeFailed, 10_000);
        assert_eq!(m.state(), State::Suspect);
        assert!(!logs(&a).is_empty(), "logging continues while suppressed");
    }

    #[test]
    fn detect_only_never_reloads_but_reaches_every_state() {
        let mut m = healthy(false);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(m.state(), State::Unresponsive);
        assert!(!has(&a, &Action::Reload), "Phase 1 is detect-only: {a:?}");
        assert!(
            logs(&a).iter().any(|l| l.suppressed == Some("detect-only")),
            "{a:?}"
        );
    }

    #[test]
    fn a_withheld_recovery_is_recorded_once_per_incident_not_once_per_tick() {
        let mut m = healthy(false);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(
            logs(&a)
                .iter()
                .filter(|l| l.suppressed == Some("detect-only"))
                .count(),
            1
        );
        let mut later = 0;
        for tick in 1..60 {
            let a = m.on_event(Event::Tick, 10_000 + tick * 1_000);
            later += logs(&a)
                .iter()
                .filter(|l| l.suppressed == Some("detect-only"))
                .count();
        }
        assert_eq!(later, 0, "one decision, one record");
    }

    #[test]
    fn a_new_incident_records_its_own_withheld_recovery() {
        let mut m = healthy(false);
        fail_to_unresponsive(&mut m, 10_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 10 }, 30_000);
        let a = fail_to_unresponsive(&mut m, 100_000);
        assert_eq!(
            logs(&a)
                .iter()
                .filter(|l| l.suppressed == Some("detect-only"))
                .count(),
            1,
            "{a:?}"
        );
    }

    #[test]
    fn detect_only_still_sets_the_title() {
        let mut m = healthy(false);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert!(
            has(&a, &Action::SetTitle(TitleState::NotResponding)),
            "the title is the one surface that survives a dead web process: {a:?}"
        );
    }

    #[test]
    fn unfocused_recovery_reloads_without_prompting() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(m.state(), State::Recovering);
        assert!(has(&a, &Action::Reload), "{a:?}");
        assert!(
            !a.iter()
                .any(|x| matches!(x, Action::PromptThenRecover { .. })),
            "unfocused must not prompt: {a:?}"
        );
    }

    #[test]
    fn focused_recovery_prompts_first() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(true), 0);
        let a = fail_to_unresponsive(&mut m, 10_000);
        assert!(
            a.iter()
                .any(|x| matches!(x, Action::PromptThenRecover { .. })),
            "{a:?}"
        );
        assert!(
            !has(&a, &Action::Reload),
            "no reload before the answer: {a:?}"
        );
    }

    #[test]
    fn an_unanswered_prompt_times_out_and_recovers() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(true), 0);
        fail_to_unresponsive(&mut m, 10_000);
        let t = m.thresholds().prompt_timeout_ms;
        let a = m.on_event(Event::Tick, 10_000 + t);
        assert!(
            has(&a, &Action::Reload),
            "a prompt nobody answers must not become an indefinite hold: {a:?}"
        );
    }

    #[test]
    fn a_stale_decline_cannot_halt_a_recovered_renderer() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(true), 0);
        fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(m.state(), State::Recovering, "prompt is outstanding");

        m.on_event(Event::ProbeReturned { rtt_ms: 12 }, 11_000);
        assert_eq!(m.state(), State::Healthy);

        let a = m.on_event(Event::RecoveryDeclined, 12_000);
        assert_eq!(
            m.state(),
            State::Healthy,
            "a stale answer must not latch a healthy app into Halted"
        );
        assert!(
            !has(&a, &Action::SetTitle(TitleState::NotResponding)),
            "and must not retitle a working window: {a:?}"
        );
        assert!(
            logs(&a)
                .iter()
                .any(|l| matches!(l.trigger, Trigger::PromptStale)),
            "the race is recorded rather than silently dropped: {a:?}"
        );
    }

    #[test]
    fn a_stale_confirm_cannot_trigger_a_reload() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(true), 0);
        fail_to_unresponsive(&mut m, 10_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 12 }, 11_000);
        let a = m.on_event(Event::RecoveryConfirmed { timed_out: false }, 12_000);
        assert!(
            !has(&a, &Action::Reload),
            "a recovered renderer must not be reloaded by a stale answer: {a:?}"
        );
        assert_eq!(m.state(), State::Healthy);
    }

    #[test]
    fn a_user_reload_after_the_ladder_exhausted_still_reloads() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        for step in 1..8u64 {
            m.on_event(Event::Tick, 10_000 + step * 61_000);
        }
        assert_eq!(m.state(), State::Halted);

        let a = m.on_event(
            Event::ReloadRequested {
                reason: "user-pressed-the-button".into(),
            },
            10_000 + 20 * 60_000,
        );
        assert!(
            has(&a, &Action::Reload),
            "the user's own reload must not be silently swallowed: {a:?}"
        );
    }

    #[test]
    fn a_user_reload_opens_its_own_incident() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let a1 = fail_to_unresponsive(&mut m, 10_000);
        let first = logs(&a1)
            .iter()
            .filter_map(|l| l.incident_id)
            .next()
            .unwrap();
        let a2 = m.on_event(
            Event::ReloadRequested {
                reason: "user".into(),
            },
            10_000 + 20 * 60_000,
        );
        let second = logs(&a2)
            .iter()
            .filter_map(|l| l.incident_id)
            .next()
            .unwrap();
        assert_ne!(
            first, second,
            "a user-initiated reload is its own incident, not a rung of the old one"
        );
    }

    #[test]
    fn a_declined_prompt_halts_and_does_not_reload() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(true), 0);
        fail_to_unresponsive(&mut m, 10_000);
        let a = m.on_event(Event::RecoveryDeclined, 11_000);
        assert_eq!(m.state(), State::Halted);
        assert!(!has(&a, &Action::Reload), "{a:?}");
        let a = m.on_event(Event::Tick, 999_000);
        assert!(!has(&a, &Action::Reload), "{a:?}");
    }

    #[test]
    fn rung_two_terminates_then_reloads() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        let a = m.on_event(Event::Tick, 80_000);
        assert!(has(&a, &Action::TerminateWebProcess), "{a:?}");
        assert!(
            has(&a, &Action::Reload),
            "termination alone leaves a blank view: {a:?}"
        );
        let i = a.iter().position(|x| *x == Action::TerminateWebProcess);
        let r = a.iter().position(|x| *x == Action::Reload);
        assert!(i < r, "terminate must precede reload: {a:?}");
    }

    #[test]
    fn an_api_termination_we_asked_for_is_not_a_new_incident() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        let incident_before = logs(&m.on_event(Event::Tick, 80_000))
            .first()
            .and_then(|l| l.incident_id);
        let a = m.on_event(
            Event::WebProcessTerminated {
                reason: TerminationReason::TerminatedByApi,
            },
            80_100,
        );
        assert_ne!(
            m.state(),
            State::Gone,
            "our own rung-2 kill must not read as a fresh crash"
        );
        let after = logs(&a).first().and_then(|l| l.incident_id);
        assert_eq!(after, incident_before, "same incident: {a:?}");
    }

    #[test]
    fn a_crash_during_recovery_is_still_a_real_incident() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        m.on_event(
            Event::WebProcessTerminated {
                reason: TerminationReason::Crashed,
            },
            11_000,
        );
        assert_eq!(
            m.state(),
            State::Gone,
            "only TerminatedByApi is excused, and only when we asked for it"
        );
    }

    #[test]
    fn a_cooldown_defers_recovery_it_does_not_halt_it() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(m.state(), State::Recovering, "rung 1 issued");

        let a = m.on_event(
            Event::WebProcessTerminated {
                reason: TerminationReason::Crashed,
            },
            11_000,
        );
        assert_ne!(
            m.state(),
            State::Halted,
            "a cooldown is a wait, not a latch"
        );
        assert!(
            logs(&a)
                .iter()
                .any(|l| l.suppressed == Some("reload-cooldown")),
            "and the wait is recorded as its own reason: {a:?}"
        );

        let a = m.on_event(Event::Tick, 75_000);
        assert!(has(&a, &Action::Reload), "deferred, not cancelled: {a:?}");
    }

    #[test]
    fn the_ladder_never_exits_the_app() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        for t in 1..40 {
            m.on_event(Event::Tick, 10_000 + t * 60_000);
        }
        assert_eq!(m.state(), State::Halted);
    }

    #[test]
    fn recovery_returns_to_healthy_when_a_probe_comes_back() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        assert_eq!(m.state(), State::Recovering);
        let a = m.on_event(Event::ProbeReturned { rtt_ms: 20 }, 12_000);
        assert_eq!(m.state(), State::Healthy);
        assert!(has(&a, &Action::SetTitle(TitleState::Normal)), "{a:?}");
    }

    #[test]
    fn cooldown_blocks_a_second_reload_inside_sixty_seconds() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        fail_to_unresponsive(&mut m, 10_000);
        let a = m.on_event(Event::Tick, 31_000);
        assert!(!has(&a, &Action::Reload), "{a:?}");
        assert!(!has(&a, &Action::TerminateWebProcess), "{a:?}");
    }

    #[test]
    fn the_budget_halts_after_three_reloads_in_the_window() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let mut reloads = 0;
        for step in 0..10u64 {
            let t = 10_000 + step * 61_000;
            let a = fail_to_unresponsive(&mut m, t);
            reloads += a.iter().filter(|x| **x == Action::Reload).count();
            m.on_event(Event::ProbeReturned { rtt_ms: 10 }, t + 1_000);
        }
        assert_eq!(
            reloads,
            m.thresholds().reload_budget as usize,
            "3 reloads / 10 min, then Halted"
        );
        assert_eq!(m.state(), State::Halted);
    }

    #[test]
    fn the_budget_window_slides() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        for step in 0..3u64 {
            let t = 10_000 + step * 61_000;
            fail_to_unresponsive(&mut m, t);
            m.on_event(Event::ProbeReturned { rtt_ms: 10 }, t + 1_000);
        }
        let t = 10_000 + 11 * 60_000;
        let a = fail_to_unresponsive(&mut m, t);
        assert!(has(&a, &Action::Reload), "the window must slide: {a:?}");
    }

    #[test]
    fn halted_is_a_latch_for_automatic_recovery() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        for step in 0..10u64 {
            let t = 10_000 + step * 61_000;
            fail_to_unresponsive(&mut m, t);
            m.on_event(Event::ProbeReturned { rtt_ms: 10 }, t + 1_000);
        }
        assert_eq!(m.state(), State::Halted);
        let a = m.on_event(Event::Tick, 10_000_000);
        assert!(!has(&a, &Action::Reload), "{a:?}");
    }

    #[test]
    fn a_user_requested_reload_is_honoured_from_halted() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        for step in 0..10u64 {
            let t = 10_000 + step * 61_000;
            fail_to_unresponsive(&mut m, t);
            m.on_event(Event::ProbeReturned { rtt_ms: 10 }, t + 1_000);
        }
        assert_eq!(m.state(), State::Halted);
        let a = m.on_event(
            Event::ReloadRequested {
                reason: "user".into(),
            },
            10_000_000,
        );
        assert!(has(&a, &Action::Reload), "{a:?}");
    }

    #[test]
    fn a_suspend_discards_probes_and_emits_wake() {
        let mut m = healthy(true);
        let a = m.on_event(
            Event::Suspended {
                suspended_ms: 3_600_000,
            },
            5_000,
        );
        assert!(has(&a, &Action::DiscardOutstandingProbes), "{a:?}");
        assert!(
            has(
                &a,
                &Action::EmitWake {
                    suspended_ms: 3_600_000
                }
            ),
            "{a:?}"
        );
        assert_eq!(m.state(), State::Healthy, "a suspend is not a state change");
    }

    #[test]
    fn a_wall_step_logs_and_does_nothing_else() {
        let mut m = healthy(true);
        let a = m.on_event(Event::WallStep { step_ms: 7_200_000 }, 5_000);
        assert_eq!(a.len(), 1, "the step path has no action edge: {a:?}");
        assert!(matches!(a[0], Action::Log(_)), "{a:?}");
        assert!(!m.is_suppressed(5_000), "a step must not arm grace");
    }

    #[test]
    fn a_starved_window_discards_probes_and_does_not_advance_failures() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(Event::ProbeFailed, 10_000);
        m.on_event(Event::ProbeFailed, 12_000);
        let a = m.on_event(Event::Starved { by_ms: 4_000 }, 13_000);
        assert!(has(&a, &Action::DiscardOutstandingProbes), "{a:?}");
        m.on_event(Event::ProbeFailed, 20_000);
        assert_eq!(m.state(), State::Suspect);
    }

    #[test]
    fn a_paint_failure_for_a_hidden_window_is_dropped() {
        let mut m = healthy(true);
        m.on_event(Event::WindowVisible(false), 0);
        let a = m.on_event(
            Event::PaintReport {
                ok: false,
                raf_gap_ms: 30_000,
            },
            5_000,
        );
        assert_eq!(m.state(), State::Healthy, "rAF stops when hidden — normal");
        assert!(a.is_empty(), "{a:?}");
    }

    #[test]
    fn the_probe_slows_while_the_window_is_hidden() {
        let t = Thresholds::default();
        let mut m = Machine::new(t, false, 0);
        assert_eq!(m.probe_period_ms(), t.probe_ms);

        m.on_event(Event::WindowVisible(false), 1_000);
        assert_eq!(
            m.probe_period_ms(),
            t.probe_hidden_ms,
            "a hidden window must not be probed at the visible rate"
        );
        assert!(
            t.probe_hidden_ms > t.probe_ms && t.probe_hidden_ms < t.boot_ms,
            "the hidden period must be slower than the visible one and still \
             inside boot_ms, so a webview that dies while hidden is caught: \
             probe_ms {}, probe_hidden_ms {}, boot_ms {}",
            t.probe_ms,
            t.probe_hidden_ms,
            t.boot_ms
        );

        m.on_event(Event::WindowVisible(true), 2_000);
        assert_eq!(
            m.probe_period_ms(),
            t.probe_ms,
            "becoming visible must restore the fast period on the next round"
        );
    }

    #[test]
    fn a_paint_failure_while_visible_stalls_then_clears() {
        let mut m = healthy(false);
        m.on_event(Event::WindowVisible(true), 0);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(
            Event::PaintReport {
                ok: false,
                raf_gap_ms: 9_000,
            },
            5_000,
        );
        assert_eq!(m.state(), State::PaintStalled);
        m.on_event(
            Event::PaintReport {
                ok: true,
                raf_gap_ms: 16,
            },
            6_000,
        );
        assert_eq!(m.state(), State::Healthy);
    }

    #[test]
    fn a_probe_does_not_clear_a_paint_stall() {
        let mut m = healthy(false);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(
            Event::PaintReport {
                ok: false,
                raf_gap_ms: 9_000,
            },
            5_000,
        );
        assert_eq!(m.state(), State::PaintStalled);
        m.on_event(Event::ProbeReturned { rtt_ms: 5 }, 6_000);
        assert_eq!(
            m.state(),
            State::PaintStalled,
            "a compositor stall answers probes throughout — that is its signature"
        );
    }

    #[test]
    fn responsiveness_logs_only_on_a_change() {
        let mut m = healthy(false);
        let a = m.on_event(Event::ResponsivenessChanged { responsive: true }, 1_000);
        assert!(a.is_empty(), "no change, no record: {a:?}");
        let a = m.on_event(Event::ResponsivenessChanged { responsive: false }, 2_000);
        assert_eq!(logs(&a).len(), 1, "the edge is recorded: {a:?}");
        let a = m.on_event(Event::ResponsivenessChanged { responsive: false }, 3_000);
        assert!(a.is_empty(), "and only the edge: {a:?}");
    }

    #[test]
    fn probe_rtts_are_summarised_periodically() {
        let mut m = healthy(false);
        let n = m.thresholds().rtt_summary_probes;
        let mut summaries = 0;
        for i in 0..n {
            let a = m.on_event(Event::ProbeReturned { rtt_ms: i as u64 }, 1_000 + i as u64);
            summaries += logs(&a)
                .iter()
                .filter(|l| matches!(l.trigger, Trigger::ProbeRttSummary { .. }))
                .count();
        }
        assert_eq!(
            summaries, 1,
            "a healthy renderer produces no transitions, so without this record              a quiet week logs nothing and spec §9.5 Q1 is unanswerable"
        );
    }

    #[test]
    fn the_summary_reports_the_distribution_not_just_the_last_value() {
        let mut window: Vec<u64> = (1..=100).collect();
        let t = summarise(&mut window);
        match t {
            Trigger::ProbeRttSummary {
                count,
                min_ms,
                p50_ms,
                p99_ms,
                max_ms,
            } => {
                assert_eq!(count, 100);
                assert_eq!(min_ms, 1);
                assert_eq!(p50_ms, 50);
                assert_eq!(p99_ms, 99);
                assert_eq!(max_ms, 100);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_summary_handles_a_single_sample() {
        let mut window = vec![7];
        match summarise(&mut window) {
            Trigger::ProbeRttSummary {
                count,
                min_ms,
                p50_ms,
                p99_ms,
                max_ms,
            } => {
                assert_eq!((count, min_ms, p50_ms, p99_ms, max_ms), (1, 7, 7, 7, 7));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn responsiveness_corroborates_but_never_triggers() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let a = m.on_event(Event::ResponsivenessChanged { responsive: false }, 5_000);
        assert_eq!(
            m.state(),
            State::Healthy,
            "is_web_process_responsive is never a sole trigger (spec §9.6)"
        );
        assert!(!has(&a, &Action::Reload), "{a:?}");
    }

    #[test]
    fn responsiveness_is_carried_into_the_probe_failure_record() {
        let mut m = healthy(true);
        m.on_event(Event::ResponsivenessChanged { responsive: false }, 5_000);
        let a = m.on_event(Event::ProbeFailed, 10_000);
        assert!(
            logs(&a)
                .iter()
                .any(|l| format!("{:?}", l.trigger).contains("responsive: false")),
            "{a:?}"
        );
    }

    #[test]
    fn a_late_probe_logs_the_threshold_and_its_value() {
        let mut m = healthy(false);
        let a = m.on_event(Event::ProbeReturned { rtt_ms: 1_700 }, 5_000);
        let l = logs(&a);
        let crossed = l[0].threshold_crossed.as_ref().expect("T_warn recorded");
        assert_eq!(crossed.name, "T_warn");
        assert_eq!(crossed.value, 1_500, "the value AT THE TIME, per §5.4");
        assert_eq!(crossed.observed, 1_700);
    }

    #[test]
    fn a_warn_level_probe_does_not_change_state() {
        let mut m = healthy(false);
        m.on_event(Event::ProbeReturned { rtt_ms: 1_700 }, 5_000);
        assert_eq!(m.state(), State::Healthy, "condition A has no action edge");
    }

    #[test]
    fn records_carry_the_rtt_history_and_an_incident_id() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        m.on_event(Event::ProbeReturned { rtt_ms: 11 }, 1_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 22 }, 2_000);
        let a = fail_to_unresponsive(&mut m, 10_000);
        let l = logs(&a);
        let with_incident = l
            .iter()
            .find(|r| r.incident_id.is_some())
            .expect("incident id");
        assert!(
            with_incident.probe_rtt_ms.contains(&22),
            "the calibration instrument must ride along: {with_incident:?}"
        );
    }

    #[test]
    fn one_incident_id_spans_its_rungs() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let a1 = fail_to_unresponsive(&mut m, 10_000);
        let a2 = m.on_event(Event::Tick, 80_000);
        let id1 = logs(&a1).iter().filter_map(|l| l.incident_id).next();
        let id2 = logs(&a2).iter().filter_map(|l| l.incident_id).next();
        assert!(id1.is_some());
        assert_eq!(id1, id2, "rungs must join to their trigger");
    }

    #[test]
    fn a_new_incident_gets_a_new_id() {
        let mut m = healthy(true);
        m.on_event(Event::WindowFocused(false), 0);
        let a1 = fail_to_unresponsive(&mut m, 10_000);
        m.on_event(Event::ProbeReturned { rtt_ms: 10 }, 12_000);
        let a2 = fail_to_unresponsive(&mut m, 200_000);
        let id1 = logs(&a1)
            .iter()
            .filter_map(|l| l.incident_id)
            .next()
            .unwrap();
        let id2 = logs(&a2)
            .iter()
            .filter_map(|l| l.incident_id)
            .next()
            .unwrap();
        assert_ne!(id1, id2);
    }
}

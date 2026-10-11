#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod clocks;
pub mod gtk_signals;
mod ingress;
pub mod log;
pub mod machine;
pub mod probe;
pub mod webview2_signals;

use ingress::{EventSender, Inbox, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use clocks::{ClockClassifier, Clocks, SystemClocks};
use log::{BufferedSink, NdjsonSink, Record, SessionSource, Sink, TransitionLog};
use machine::{Action, Event, Machine, Thresholds, TitleState};
use probe::{Completion, ProbeTable};

const HALTED_TITLE: &str = "Houston — UI not responding (agents still running)";

#[derive(Default)]
pub struct RendererHealth {
    state: std::sync::Mutex<HealthState>,
}

#[derive(Default)]
struct HealthState {
    unavailable: bool,
    generation: u64,
    navigation_required: bool,
}

impl RendererHealth {
    fn state(&self) -> std::sync::MutexGuard<'_, HealthState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn unavailable(&self) -> bool {
        self.state().unavailable
    }

    fn record_termination(&self) {
        let mut state = self.state();
        state.generation += 1;
        state.navigation_required = true;
        state.unavailable = true;
    }

    fn page_loaded(&self, watchdog_enabled: bool) {
        let mut state = self.state();
        state.generation += 1;
        state.navigation_required = false;
        if !watchdog_enabled {
            state.unavailable = false;
        }
    }

    fn probe_generation(&self) -> Option<u64> {
        let state = self.state();
        (!state.navigation_required).then_some(state.generation)
    }

    fn recover(&self, generation: u64) {
        let mut state = self.state();
        // Serialize acknowledgment with the native callback, including queued replies.
        if !state.navigation_required && state.generation == generation {
            state.unavailable = false;
        }
    }

    fn record_state(&self, state: machine::State) {
        if matches!(
            state,
            machine::State::Unresponsive
                | machine::State::PaintStalled
                | machine::State::Gone
                | machine::State::Recovering
                | machine::State::Halted
        ) {
            self.state().unavailable = true;
        }
    }
}

enum Msg {
    Wake,
    Event(Event),
    ProbeReply {
        payload: String,
        generation: u64,
    },
    PromptAnswer {
        _permit: WorkPermit,
        incident_id: u64,
        generation: u64,
        outcome: PromptOutcome,
    },
    Paint {
        ok: bool,
        raf_gap_ms: u64,
        generation: u64,
    },
}

pub struct WatchdogHandle {
    tx: Sender,
    join: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub thresholds: Thresholds,
    pub recovery_enabled: bool,
    pub log_path: std::path::PathBuf,
}

impl Config {
    pub fn from_env(log_path: std::path::PathBuf) -> Option<Self> {
        if cfg!(debug_assertions) && !env_flag("HOUSTON_WATCHDOG", "TR_WATCHDOG") {
            return None;
        }
        Some(Self {
            thresholds: Thresholds::default(),
            recovery_enabled: env_flag("HOUSTON_WATCHDOG_RECOVER", "TR_WATCHDOG_RECOVER"),
            log_path,
        })
    }
}

fn flag_value(primary: Option<String>, legacy: Option<String>) -> bool {
    primary.or(legacy).is_some_and(|value| value == "1")
}

fn env_flag(primary: &str, legacy: &str) -> bool {
    flag_value(std::env::var(primary).ok(), std::env::var(legacy).ok())
}

pub fn install_termination_logger<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        eprintln!(
            "houston-tauri: renderer-crash logging not installed: no webview window \
             labelled {label:?} (expected the window built by main.rs's setup(), which must \
             run before this)"
        );
        return false;
    };
    let health = app.state::<Arc<RendererHealth>>().inner().clone();
    #[cfg(target_os = "linux")]
    {
        if let Err(err) = window.with_webview(move |platform| {
            gtk_signals::install_termination_logger(&platform, health)
        }) {
            eprintln!(
                "houston-tauri: renderer-crash logging not installed: could not reach \
                 the platform webview: {err}"
            );
            return false;
        }
    }
    #[cfg(windows)]
    if let Err(err) = window.with_webview(move |platform| {
        webview2_signals::install_termination_logger(&platform, health)
    }) {
        eprintln!(
            "houston-tauri: renderer-crash logging not installed: could not reach \
             the platform webview: {err}"
        );
        return false;
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    drop((window, health));
    true
}

pub fn install<R: Runtime>(app: &AppHandle<R>, label: &str, config: Config) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        eprintln!(
            "houston-tauri: watchdog not installed: no webview window labelled {label:?} \
             (expected the window built by main.rs's setup(), which must run before this)"
        );
        return false;
    };

    let (tx, rx) = ingress::channel();
    app.manage(WatchdogHandle {
        tx: tx.clone(),
        join: std::sync::Mutex::new(None),
    });
    let destroyed_tx = tx.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            destroyed_tx.stop();
        }
    });

    let signal_tx = tx.clone();
    #[cfg(target_os = "linux")]
    if let Err(err) = window.with_webview(move |platform| {
        gtk_signals::install(&platform, signal_events(signal_tx));
    }) {
        eprintln!("houston-tauri: watchdog could not reach the platform webview: {err}");
    }
    #[cfg(windows)]
    {
        let webview_tx = signal_tx;
        if let Err(err) = window.with_webview(move |platform| {
            webview2_signals::install(&platform, signal_events(webview_tx));
        }) {
            eprintln!("houston-tauri: watchdog could not reach the platform webview: {err}");
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    drop(signal_tx);

    let sink: Arc<dyn Sink> =
        match BufferedSink::new(Arc::new(NdjsonSink::new(config.log_path.clone()))) {
            Ok(sink) => Arc::new(sink),
            Err(err) => {
                tx.stop();
                eprintln!("houston-tauri: watchdog log worker failed to spawn: {err}");
                return false;
            }
        };
    let sessions: SessionSource = Box::new(Vec::new);

    let page_loaded = Arc::new(AtomicBool::new(false));
    let supervisor = Supervisor {
        window,
        rx,
        tx,
        sink,
        sessions,
        page_loaded: page_loaded.clone(),
        last_scale: Arc::new(std::sync::Mutex::new(None)),
        prompt: Arc::new(std::sync::Mutex::new(None)),
        recovery_work: WorkGate::new(1),
        recovery_intent: Arc::new(std::sync::Mutex::new(None)),
        prompt_work: WorkGate::new(1),
        poll: WorkGate::new(1),
        eval: WorkGate::new(2),
        title: std::sync::Mutex::new(None),
        clocks: SystemClocks,
    };

    std::thread::Builder::new()
        .name("tr-watchdog".into())
        .spawn(move || supervisor.run(config))
        .map(|join| {
            *app.state::<WatchdogHandle>()
                .join
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(join);
            true
        })
        .unwrap_or_else(|err| {
            eprintln!("houston-tauri: watchdog thread failed to spawn: {err}");
            false
        })
}

pub fn note_page_loaded<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.try_state::<WatchdogHandle>();
    if let Some(health) = app.try_state::<Arc<RendererHealth>>() {
        health.page_loaded(handle.is_some());
    }
    if let Some(handle) = handle {
        let _ = handle.tx.send(Msg::Event(Event::PageLoaded));
    }
}

pub fn maybe_selftest_wedge<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(delay_ms) = std::env::var("HOUSTON_WATCHDOG_SELFTEST_WEDGE_MS")
        .or_else(|_| std::env::var("TR_WATCHDOG_SELFTEST_WEDGE_MS"))
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay_ms));
        eprintln!("houston-tauri: watchdog selftest wedging the JS main thread now (unbounded)");
        let _ = window.eval("(function(){while(true){}})()");
    });
}

pub fn maybe_selftest_terminate<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(delay_ms) = std::env::var("HOUSTON_WATCHDOG_SELFTEST_TERMINATE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, delay_ms);
        eprintln!("houston-tauri: renderer termination selftest is only supported on Linux");
    }
    #[cfg(target_os = "linux")]
    {
        static FIRED: AtomicBool = AtomicBool::new(false);
        if FIRED.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            eprintln!("houston-tauri: selftest terminating the main renderer through WebKit");
            let _ = window.with_webview(|platform| gtk_signals::terminate_web_process(&platform));
        });
    }
}

#[cfg(any(target_os = "linux", windows))]
fn signal_events(tx: Sender) -> EventSender {
    EventSender(tx)
}

pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    if let Some(handle) = app.try_state::<WatchdogHandle>() {
        handle.tx.stop();
        if let Some(join) = handle.join.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = join.join();
        }
    }
}

struct Supervisor<R: Runtime, C: Clocks> {
    window: WebviewWindow<R>,
    rx: Inbox,
    tx: Sender,
    sink: Arc<dyn Sink>,
    sessions: SessionSource,
    page_loaded: Arc<AtomicBool>,
    last_scale: Arc<std::sync::Mutex<Option<f64>>>,
    prompt: Arc<std::sync::Mutex<Option<PromptLease>>>,
    recovery_work: WorkGate,
    recovery_intent: Arc<std::sync::Mutex<Option<(u8, u64)>>>,
    prompt_work: WorkGate,
    poll: WorkGate,
    eval: WorkGate,
    title: std::sync::Mutex<Option<TitleState>>,
    clocks: C,
}

impl<R: Runtime, C: Clocks> Supervisor<R, C> {
    fn run(mut self, config: Config) {
        let t = config.thresholds;
        let start = self.clocks.sample();
        let mut machine = Machine::new(t, config.recovery_enabled, start.mono_ms);
        let mut classifier = ClockClassifier::new(
            Duration::from_millis(t.clock_tick_ms),
            t.suspend_ms,
            t.wall_step_ms,
        );
        let mut probes = ProbeTable::new();
        let mut next_probe_ms = u64::MAX;
        let mut capacity_deadline_ms = None;
        let mut next_tick_ms = start.mono_ms + t.clock_tick_ms;

        eprintln!(
            "houston-tauri: watchdog armed (recovery {}), log at {}",
            if config.recovery_enabled {
                "ENABLED"
            } else {
                "detect-only"
            },
            config.log_path.display()
        );

        loop {
            let now = self.clocks.sample();
            let sleep_ms = next_tick_ms
                .min(next_probe_ms)
                .saturating_sub(now.mono_ms)
                .min(t.clock_tick_ms);

            match self.rx.recv_timeout(Duration::from_millis(sleep_ms)) {
                Ok(Msg::Event(Event::PageLoaded)) => {
                    capacity_deadline_ms = None;
                    let now = self.clocks.sample();
                    self.page_loaded.store(true, Ordering::SeqCst);
                    if let Some(generation) = self
                        .window
                        .app_handle()
                        .state::<Arc<RendererHealth>>()
                        .probe_generation()
                    {
                        let _ = self.window.emit(
                            "wd:paint-generation",
                            serde_json::json!({ "generation": generation }),
                        );
                    }
                    self.cancel_prompt();
                    let actions = machine.on_event(Event::PageLoaded, now.mono_ms);
                    self.apply(&mut machine, &mut probes, actions, now);
                    next_probe_ms = now.mono_ms;
                }
                Ok(Msg::Event(event)) => {
                    let now = self.clocks.sample();
                    let terminated = matches!(event, Event::WebProcessTerminated { .. });
                    if terminated {
                        capacity_deadline_ms = None;
                    }
                    let actions = machine.on_event(event, now.mono_ms);
                    self.apply(&mut machine, &mut probes, actions, now);
                    // Navigation may finish before the supervisor consumes native process loss.
                    if terminated
                        && self
                            .window
                            .app_handle()
                            .state::<Arc<RendererHealth>>()
                            .probe_generation()
                            .is_some()
                    {
                        self.cancel_prompt();
                        let actions = machine.on_event(Event::PageLoaded, now.mono_ms);
                        self.apply(&mut machine, &mut probes, actions, now);
                    }
                }
                Ok(Msg::PromptAnswer {
                    _permit,
                    incident_id,
                    generation,
                    outcome,
                }) => {
                    if self
                        .window
                        .app_handle()
                        .state::<Arc<RendererHealth>>()
                        .probe_generation()
                        == Some(generation)
                    {
                        let event = match outcome {
                            PromptOutcome::Reload => Some(Event::RecoveryConfirmed {
                                incident_id,
                                timed_out: false,
                            }),
                            PromptOutcome::Decline => Some(Event::RecoveryDeclined { incident_id }),
                            PromptOutcome::TimedOut => Some(Event::RecoveryConfirmed {
                                incident_id,
                                timed_out: true,
                            }),
                            PromptOutcome::Cancelled => None,
                        };
                        if let Some(event) = event {
                            let now = self.clocks.sample();
                            let actions = machine.on_event(event, now.mono_ms);
                            self.apply(&mut machine, &mut probes, actions, now);
                        }
                    }
                }
                Ok(Msg::Paint {
                    ok,
                    raf_gap_ms,
                    generation,
                }) => {
                    let health = self.window.app_handle().state::<Arc<RendererHealth>>();
                    if health.probe_generation() == Some(generation) {
                        let now = self.clocks.sample();
                        let actions =
                            machine.on_event(Event::PaintReport { ok, raf_gap_ms }, now.mono_ms);
                        self.apply(&mut machine, &mut probes, actions, now);
                        if machine.state() == machine::State::Healthy {
                            health.recover(generation);
                        }
                    }
                }
                Ok(Msg::ProbeReply {
                    payload,
                    generation,
                }) => {
                    let health = self.window.app_handle().state::<Arc<RendererHealth>>();
                    if health.probe_generation() != Some(generation) {
                        continue;
                    }
                    let now = self.clocks.sample();
                    let event = match probes.complete(&payload, now.mono_ms) {
                        Completion::Matched { rtt_ms, .. } => Some(Event::ProbeReturned { rtt_ms }),
                        Completion::Malformed | Completion::Unknown => None,
                    };
                    if let Some(event) = event {
                        let actions = machine.on_event(event, now.mono_ms);
                        self.apply(&mut machine, &mut probes, actions, now);
                        if machine.state() == machine::State::Healthy {
                            health.recover(generation);
                        }
                    }
                }
                Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.cancel_prompt();
                    probes.discard_all();
                    let dropped = self.tx.dropped.swap(0, Ordering::Relaxed);
                    if dropped != 0 {
                        self.sink.dropped(dropped);
                    }
                    return;
                }
            }

            let now = self.clocks.sample();

            if now.mono_ms >= next_tick_ms {
                next_tick_ms = now.mono_ms + t.clock_tick_ms;
                self.tick(&mut machine, &mut probes, &mut classifier, now);
            }

            if self.page_loaded.load(Ordering::SeqCst) && now.mono_ms >= next_probe_ms {
                next_probe_ms = now.mono_ms + machine.probe_period_ms();
                if !self.issue_probe(&mut probes, now.mono_ms) {
                    if capacity_failed(&mut capacity_deadline_ms, now.mono_ms, t.hang_ms) {
                        let actions = machine.on_event(Event::ProbeFailed, now.mono_ms);
                        self.apply(&mut machine, &mut probes, actions, now);
                    }
                } else {
                    capacity_deadline_ms = None;
                }
            }
        }
    }

    fn tick(
        &mut self,
        machine: &mut Machine,
        probes: &mut ProbeTable,
        classifier: &mut ClockClassifier,
        now: clocks::ClockSample,
    ) {
        let dropped = self.tx.dropped.swap(0, Ordering::Relaxed);
        if dropped != 0 {
            self.sink.dropped(dropped);
        }
        let verdict = classifier.classify(now);

        if !verdict.is_quiet() {
            if let Some(suspended_ms) = verdict.suspended_ms {
                let actions = machine.on_event(Event::Suspended { suspended_ms }, now.mono_ms);
                self.apply(machine, probes, actions, now);
            }
            if let Some(step_ms) = verdict.wall_step_ms {
                let actions = machine.on_event(Event::WallStep { step_ms }, now.mono_ms);
                self.apply(machine, probes, actions, now);
            }
            if let Some(by_ms) = verdict.starved_by_ms {
                let actions = machine.on_event(Event::Starved { by_ms }, now.mono_ms);
                self.apply(machine, probes, actions, now);
            }
        }

        for _ in probes.take_expired(now.mono_ms, machine.thresholds().hang_ms) {
            let actions = machine.on_event(Event::ProbeFailed, now.mono_ms);
            self.apply(machine, probes, actions, now);
        }

        let actions = machine.on_event(Event::Tick, now.mono_ms);
        self.apply(machine, probes, actions, now);

        self.poll_platform();
        self.dispatch_recovery();
    }

    fn poll_platform(&self) {
        let Some(permit) = self.poll.acquire() else {
            return;
        };
        let tx = self.tx.clone();
        let window = self.window.clone();
        let last_scale = self.last_scale.clone();
        let _ = self.window.run_on_main_thread(move || {
            if tx.stop.load(Ordering::SeqCst) {
                return;
            }
            let visible =
                window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
            let _ = tx.send(Msg::Event(Event::WindowVisible(visible)));
            let _ = tx.send(Msg::Event(Event::WindowFocused(
                window.is_focused().unwrap_or(true),
            )));
            if let Ok(scale) = window.scale_factor() {
                let mut last = last_scale.lock().unwrap_or_else(|p| p.into_inner());
                if last.is_some_and(|prev: f64| (prev - scale).abs() > f64::EPSILON) {
                    let _ = window.emit("wd:dpr", serde_json::json!({ "scale_factor": scale }));
                }
                *last = Some(scale);
            }
            #[cfg(target_os = "linux")]
            let _ = window.with_webview(move |platform| {
                if !tx.stop.load(Ordering::SeqCst) {
                    for event in gtk_signals::poll(&platform) {
                        let _ = tx.send(Msg::Event(event));
                    }
                }
                drop(permit);
            });
            #[cfg(not(target_os = "linux"))]
            drop(permit);
        });
    }

    fn issue_probe(&self, probes: &mut ProbeTable, now_ms: u64) -> bool {
        let health = self
            .window
            .app_handle()
            .state::<Arc<RendererHealth>>()
            .inner()
            .clone();
        let Some(generation) = health.probe_generation() else {
            return true;
        };
        let Some(permit) = self.eval.acquire() else {
            return false;
        };
        let token = NativeToken {
            health,
            stop: self.tx.stop.clone(),
            generation,
        };
        let (nonce, script) = probes.issue(now_ms);
        let tx = self.tx.clone();
        let window = self.window.clone();
        if let Err(err) = self.window.run_on_main_thread(move || {
            if !token.live() {
                return;
            }
            let permit = std::sync::Mutex::new(Some(permit));
            let _ = window.eval_with_callback(script, move |payload| {
                // Expiry in ProbeTable does not release this physical callback slot.
                drop(permit.lock().unwrap_or_else(|p| p.into_inner()).take());
                if payload.len() > 256 {
                    return;
                }
                let _ = tx.send(Msg::ProbeReply {
                    payload,
                    generation,
                });
            });
        }) {
            eprintln!("houston-tauri: watchdog could not dispatch a probe: {err}");
            probes.discard(nonce);
        }
        true
    }

    fn apply(
        &self,
        machine: &mut Machine,
        probes: &mut ProbeTable,
        actions: Vec<Action>,
        now: clocks::ClockSample,
    ) {
        if let Some(health) = self.window.app_handle().try_state::<Arc<RendererHealth>>() {
            health.record_state(machine.state());
        }
        {
            let mut slot = self.prompt.lock().unwrap_or_else(|p| p.into_inner());
            if slot.as_ref().is_some_and(|lease| {
                machine.prompt_identity() != Some((lease.incident_id, lease.deadline_ms))
            }) {
                if let Some(lease) = slot.take() {
                    lease.cancel.store(true, Ordering::SeqCst);
                }
            }
        }
        let mut record_reload = false;
        let mut terminate = false;
        for action in actions {
            match action {
                Action::Log(transition) => self.write(transition, now),
                Action::DiscardOutstandingProbes => probes.discard_all(),
                Action::EmitWake { suspended_ms } => {
                    let _ = self.window.emit(
                        "wd:wake",
                        serde_json::json!({
                            "suspended_ms": suspended_ms,
                            "boot_ms": now.boot_ms,
                        }),
                    );
                }
                Action::RecordReloadInPage => {
                    record_reload = true;
                }
                Action::Reload => {
                    let now_ms = self.clocks.sample().mono_ms;
                    machine.note_reload_issued(now_ms);
                    self.window
                        .app_handle()
                        .state::<Arc<RendererHealth>>()
                        .record_termination();
                    self.page_loaded.store(false, Ordering::SeqCst);
                    probes.discard_all();
                    self.queue_recovery(record_reload, terminate);
                }
                Action::TerminateWebProcess => {
                    terminate = true;
                }
                Action::PromptThenRecover {
                    incident_id,
                    deadline_ms,
                } => {
                    #[cfg(target_os = "linux")]
                    self.prompt(incident_id, deadline_ms);
                    #[cfg(not(target_os = "linux"))]
                    {
                        let _ = deadline_ms;
                        eprintln!("houston-tauri: native recovery confirmation is unsupported on this platform; recovery withheld");
                        let actions =
                            machine.on_event(Event::RecoveryDeclined { incident_id }, now.mono_ms);
                        self.apply(machine, probes, actions, now);
                    }
                }
                Action::SetTitle(title) => {
                    if title == TitleState::Normal {
                        self.cancel_prompt();
                    }
                    let mut last = self.title.lock().unwrap_or_else(|p| p.into_inner());
                    if *last == Some(title) {
                        continue;
                    }
                    *last = Some(title);
                    let _ = self.window.set_title(match title {
                        TitleState::Normal => "Houston",
                        TitleState::NotResponding => HALTED_TITLE,
                    });
                }
            }
        }
    }

    fn queue_recovery(&self, record_reload: bool, terminate: bool) {
        let flags = 1 | if record_reload { 2 } else { 0 } | if terminate { 4 } else { 0 };
        let generation = self
            .window
            .app_handle()
            .state::<Arc<RendererHealth>>()
            .state()
            .generation;
        *self
            .recovery_intent
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some((flags, generation));
        self.dispatch_recovery();
    }

    fn dispatch_recovery(&self) {
        if self
            .recovery_intent
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none()
        {
            return;
        }
        let Some(permit) = self.recovery_work.acquire() else {
            return;
        };
        let intent = self.recovery_intent.clone();
        let stopped = self.tx.stop.clone();
        let health = self
            .window
            .app_handle()
            .state::<Arc<RendererHealth>>()
            .inner()
            .clone();
        let eval = self.eval.clone();
        let window = self.window.clone();
        let _ = self.window.run_on_main_thread(move || {
            let Some((flags, generation)) = intent.lock().unwrap_or_else(|p| p.into_inner()).take() else { return; };
            {
                let state = health.state();
                if stopped.load(Ordering::SeqCst) || state.generation != generation || !state.navigation_required { return; }
            }
            if flags & 2 != 0 {
                if let Some(permit) = eval.acquire() {
                    let permit = std::sync::Mutex::new(Some(permit));
                    let _ = window.eval_with_callback(RECORD_RELOAD_JS, move |_| {
                        drop(permit.lock().unwrap_or_else(|p| p.into_inner()).take());
                    });
                }
            }
            if flags & 4 != 0 {
                #[cfg(target_os = "linux")]
                let _ = window.with_webview(|platform| gtk_signals::terminate_web_process(&platform));
                #[cfg(not(target_os = "linux"))]
                eprintln!("houston-tauri: forced renderer termination is unsupported on this platform; trying reload only");
            }
            if let Err(err) = window.reload() { eprintln!("houston-tauri: watchdog reload failed: {err}"); }
            drop(permit);
        });
    }

    fn cancel_prompt(&self) {
        if let Some(lease) = self.prompt.lock().unwrap_or_else(|p| p.into_inner()).take() {
            lease.cancel.store(true, Ordering::SeqCst);
        }
    }

    fn prompt(&self, incident_id: u64, deadline_ms: u64) {
        let Some(permit) = self.prompt_work.acquire() else {
            return;
        };
        let health = self
            .window
            .app_handle()
            .state::<Arc<RendererHealth>>()
            .inner()
            .clone();
        let Some(generation) = health.probe_generation() else {
            return;
        };
        let lease = PromptLease {
            incident_id,
            deadline_ms,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        self.cancel_prompt();
        *self.prompt.lock().unwrap_or_else(|p| p.into_inner()) = Some(lease.clone());
        let tx = self.tx.clone();
        let window = self.window.clone();
        let slot = self.prompt.clone();
        let dispatch_lease = lease.clone();
        if let Err(err) = self.window.run_on_main_thread(move || {
            let outcome = if tx.stop.load(Ordering::SeqCst)
                || health.probe_generation() != Some(generation)
            {
                PromptOutcome::Cancelled
            } else {
                native_prompt(
                    dispatch_lease.deadline_ms,
                    prompt_parent(&window).as_ref(),
                    &dispatch_lease.cancel,
                )
            };
            release_prompt(&slot, &dispatch_lease);
            let _ = tx.send(Msg::PromptAnswer {
                _permit: permit,
                incident_id,
                generation,
                outcome,
            });
        }) {
            release_prompt(&self.prompt, &lease);
            eprintln!("houston-tauri: watchdog prompt dispatch failed: {err}");
        }
    }

    fn write(&self, transition: TransitionLog, now: clocks::ClockSample) {
        self.sink.write(&Record {
            schema: log::SCHEMA_VERSION,
            ts_wall: now.wall_ms,
            ts_mono: now.mono_ms,
            ts_boot: now.boot_ms,
            transition,
            session_ids: (self.sessions)(),
        });
    }
}

fn capacity_failed(deadline: &mut Option<u64>, now_ms: u64, hang_ms: u64) -> bool {
    let next = deadline.get_or_insert(now_ms.saturating_add(hang_ms));
    if now_ms < *next {
        return false;
    }
    *next = now_ms.saturating_add(hang_ms);
    true
}

struct NativeToken {
    health: Arc<RendererHealth>,
    stop: Arc<AtomicBool>,
    generation: u64,
}
impl NativeToken {
    fn live(&self) -> bool {
        !self.stop.load(Ordering::SeqCst) && self.health.probe_generation() == Some(self.generation)
    }
}

// Physical permits are returned only when queued closures/callbacks finish or
// are dropped by the runtime, never when logical probe receipts expire.
#[derive(Clone)]
struct WorkGate {
    count: Arc<std::sync::atomic::AtomicUsize>,
    limit: usize,
}

impl WorkGate {
    fn new(limit: usize) -> Self {
        Self {
            count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            limit,
        }
    }
    fn acquire(&self) -> Option<WorkPermit> {
        let mut count = self.count.load(Ordering::SeqCst);
        while count < self.limit {
            match self.count.compare_exchange_weak(
                count,
                count + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(WorkPermit(self.count.clone())),
                Err(actual) => count = actual,
            }
        }
        None
    }
}
struct WorkPermit(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for WorkPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct PromptLease {
    incident_id: u64,
    deadline_ms: u64,
    cancel: Arc<AtomicBool>,
}

fn release_prompt(slot: &std::sync::Mutex<Option<PromptLease>>, lease: &PromptLease) {
    let mut slot = slot.lock().unwrap_or_else(|p| p.into_inner());
    if slot
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(&current.cancel, &lease.cancel))
    {
        *slot = None;
    }
    lease.cancel.store(true, Ordering::SeqCst);
}

fn prompt_preflight(deadline_ms: u64, cancel: &AtomicBool, now_ms: u64) -> Option<PromptOutcome> {
    if cancel.load(Ordering::SeqCst) {
        Some(PromptOutcome::Cancelled)
    } else if now_ms >= deadline_ms {
        Some(PromptOutcome::TimedOut)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptOutcome {
    Reload,
    Decline,
    TimedOut,
    Cancelled,
}

#[cfg(target_os = "linux")]
fn prompt_parent<R: Runtime>(window: &WebviewWindow<R>) -> Option<gtk::ApplicationWindow> {
    window.gtk_window().ok()
}

#[cfg(not(target_os = "linux"))]
fn prompt_parent<R: Runtime>(_window: &WebviewWindow<R>) -> Option<()> {
    None
}

#[cfg(target_os = "linux")]
fn native_prompt(
    deadline_ms: u64,
    parent: Option<&gtk::ApplicationWindow>,
    cancel: &Arc<AtomicBool>,
) -> PromptOutcome {
    native_prompt_with_driver(deadline_ms, parent, cancel, |_| {})
}

#[cfg(target_os = "linux")]
fn native_prompt_with_driver(
    deadline_ms: u64,
    parent: Option<&gtk::ApplicationWindow>,
    cancel: &Arc<AtomicBool>,
    shown: impl FnOnce(&gtk::MessageDialog),
) -> PromptOutcome {
    use gtk::prelude::*;

    if let Some(outcome) = prompt_preflight(deadline_ms, cancel, SystemClocks.sample().mono_ms) {
        return outcome;
    }
    let dialog = gtk::MessageDialog::new(
        parent,
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        gtk::MessageType::Warning,
        gtk::ButtonsType::None,
        "Houston's interface has stopped responding.\n\nReloading recovers the window. \
         Your agents keep running either way — do not force-quit the app.",
    );
    dialog.add_button("Wait", gtk::ResponseType::Cancel);
    dialog.add_button("Reload the interface", gtk::ResponseType::Accept);
    if let Some(outcome) = prompt_preflight(deadline_ms, cancel, SystemClocks.sample().mono_ms) {
        // SAFETY: the undisplayed dialog has no callbacks or other owners yet.
        unsafe {
            dialog.destroy();
        }
        return outcome;
    }
    dialog.show_all();

    const POLL_MS: u64 = 250;
    let verdict = std::rc::Rc::new(std::cell::Cell::new(None::<PromptOutcome>));
    let slot = verdict.clone();
    let poll_cancel = cancel.clone();
    let weak = dialog.downgrade();
    let armed = std::rc::Rc::new(std::cell::Cell::new(true));
    let closure_armed = armed.clone();
    let source = glib::timeout_add_local(Duration::from_millis(POLL_MS), move || {
        let Some(dialog) = weak.upgrade() else {
            closure_armed.set(false);
            return glib::ControlFlow::Break;
        };
        let Some(outcome) =
            prompt_preflight(deadline_ms, &poll_cancel, SystemClocks.sample().mono_ms)
        else {
            return glib::ControlFlow::Continue;
        };
        slot.set(Some(outcome));
        dialog.response(gtk::ResponseType::DeleteEvent);
        closure_armed.set(false);
        glib::ControlFlow::Break
    });

    shown(&dialog);
    let response = dialog.run();
    remove_if_armed(source, &armed);
    // SAFETY: `dialog.run()` has returned, so no other code still holds it.
    unsafe {
        dialog.destroy();
    }

    if let Some(outcome) = verdict.get() {
        return outcome;
    }
    if let Some(outcome) = prompt_preflight(deadline_ms, cancel, SystemClocks.sample().mono_ms) {
        return outcome;
    }
    match response {
        gtk::ResponseType::Accept => PromptOutcome::Reload,
        gtk::ResponseType::Cancel => PromptOutcome::Decline,
        _ => PromptOutcome::Decline,
    }
}

#[cfg(target_os = "linux")]
fn remove_if_armed(source: glib::SourceId, armed: &std::cell::Cell<bool>) {
    if armed.replace(false) {
        source.remove();
    }
}

#[cfg(not(target_os = "linux"))]
fn native_prompt(
    _deadline_ms: u64,
    _parent: Option<&()>,
    _cancel: &Arc<AtomicBool>,
) -> PromptOutcome {
    eprintln!("houston-tauri: native recovery confirmation is unsupported on this platform; recovery withheld");
    PromptOutcome::Decline
}

const RECORD_RELOAD_JS: &str = r#"
(function () {
  try {
    var key = 'tr-reload-times';
    var now = Date.now();
    var raw = window.localStorage.getItem(key);
    var times = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(times)) times = [];
    times.push(now);
    window.localStorage.setItem(key, JSON.stringify(times.slice(-10)));
  } catch (e) {}
})();
"#;

#[tauri::command]
pub fn wd_paint_generation(health: tauri::State<'_, Arc<RendererHealth>>) -> Option<u64> {
    health.probe_generation()
}

#[tauri::command]
pub fn wd_paint_report(
    handle: tauri::State<'_, WatchdogHandle>,
    ok: bool,
    raf_gap_ms: u64,
    generation: u64,
    visibility: Option<String>,
) -> Result<(), String> {
    if visibility.as_deref() == Some("hidden") {
        return Ok(());
    }
    handle
        .tx
        .send(Msg::Paint {
            ok,
            raf_gap_ms,
            generation,
        })
        .map_err(|_| {
            "watchdog ingress limit 32 receipts reached; paint report was not accepted".into()
        })
}

#[tauri::command]
pub fn wd_request_reload(
    handle: tauri::State<'_, WatchdogHandle>,
    reason: String,
) -> Result<(), String> {
    if reason.len() > 256 {
        return Err(format!(
            "reload reason limit 256 bytes exceeded: {} bytes",
            reason.len()
        ));
    }
    handle
        .tx
        .send(Msg::Event(Event::ReloadRequested { reason }))
        .map_err(|_| "watchdog ingress limit 32 receipts reached; reload was not accepted".into())
}

#[tauri::command]
pub fn wd_report_wake(source: String, skipped_ms: u64) {
    eprintln!(
        "houston-tauri: watchdog advisory wake report from {source:?}, skipped {skipped_ms} ms \
         (advisory only — no suppression armed)"
    );
}

#[tauri::command]
pub fn wd_debug_wedge(window: tauri::WebviewWindow, ms: Option<u64>) {
    if !cfg!(debug_assertions) {
        eprintln!("houston-tauri: wd_debug_wedge is debug-only; refusing in a release build");
        return;
    }
    let script = match ms {
        Some(ms) => format!("(function(){{var e=Date.now()+{ms};while(Date.now()<e){{}}}})()"),
        None => "(function(){while(true){}})()".to_string(),
    };
    let _ = window.eval(script);
}

#[cfg(all(test, target_os = "linux"))]
mod source_lifecycle_tests {
    use super::Clocks;
    use std::cell::Cell;
    use std::panic::{self, AssertUnwindSafe};
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    fn broken_source(ctx: &glib::MainContext) -> glib::SourceId {
        let fired = Rc::new(Cell::new(false));
        let flag = fired.clone();
        let source = glib::timeout_add_local(Duration::from_millis(1), move || {
            flag.set(true);
            glib::ControlFlow::Break
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fired.get() && Instant::now() < deadline {
            ctx.iteration(false);
        }
        assert!(
            fired.get(),
            "the timeout never ran; the test proves nothing"
        );
        source
    }

    #[test]
    #[ignore = "needs a display and shows a real dialog; run by hand"]
    fn the_timed_out_prompt_returns_instead_of_panicking() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        assert!(gtk::init().is_ok(), "no display; this test cannot run here");
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome =
            super::native_prompt(super::SystemClocks.sample().mono_ms + 300, None, &cancel);
        assert_eq!(outcome, super::PromptOutcome::TimedOut);
    }

    #[test]
    fn expired_native_prompt_entry_never_constructs_a_dialog() {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let outcome = super::native_prompt_with_driver(0, None, &cancel, |_| {
            panic!("expired prompt was displayed")
        });
        assert_eq!(outcome, super::PromptOutcome::TimedOut);
    }

    #[test]
    #[ignore = "needs an isolated unlocked display; select this test alone"]
    fn native_wait_close_and_answer_deadline_use_the_issued_deadline() {
        use super::{native_prompt_with_driver, PromptOutcome, SystemClocks};
        use gtk::prelude::*;
        use std::sync::{atomic::AtomicBool, Arc};
        assert!(gtk::init().is_ok(), "isolated display required");
        for response in [gtk::ResponseType::Cancel, gtk::ResponseType::DeleteEvent] {
            let cancel = Arc::new(AtomicBool::new(false));
            let result = native_prompt_with_driver(
                SystemClocks.sample().mono_ms + 10_000,
                None,
                &cancel,
                |dialog| {
                    let dialog = dialog.clone();
                    glib::timeout_add_local_once(Duration::from_millis(1), move || {
                        dialog.response(response)
                    });
                },
            );
            assert_eq!(result, PromptOutcome::Decline);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let deadline = SystemClocks.sample().mono_ms + 100;
        let result = native_prompt_with_driver(deadline, None, &cancel, |dialog| {
            let dialog = dialog.clone();
            // Return Wait after expiry but before the 250 ms dialog poll.
            glib::timeout_add_local_once(Duration::from_millis(150), move || {
                dialog.response(gtk::ResponseType::Cancel)
            });
        });
        assert_eq!(result, PromptOutcome::TimedOut);
    }

    #[test]
    fn the_prompt_poll_source_is_removed_exactly_once() {
        let ctx = glib::MainContext::default();
        let _owner = ctx
            .acquire()
            .expect("the default main context is owned by another thread");

        let source = broken_source(&ctx);
        let previous = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| source.remove()));
        panic::set_hook(previous);
        assert!(
            outcome.is_err(),
            "removing an already-broken source must panic — that panic, on the GTK main \
             thread, is the crash this guard exists to prevent"
        );

        let source = broken_source(&ctx);
        let armed = Cell::new(false);
        super::remove_if_armed(source, &armed);
        assert!(!armed.get());

        let ticked = Rc::new(Cell::new(0u32));
        let counter = ticked.clone();
        let source = glib::timeout_add_local(Duration::from_millis(1), move || {
            counter.set(counter.get() + 1);
            glib::ControlFlow::Continue
        });
        let armed = Cell::new(true);
        super::remove_if_armed(source, &armed);
        assert!(!armed.get(), "the flag must be cleared by the removal");
        let deadline = Instant::now() + Duration::from_millis(50);
        while Instant::now() < deadline {
            ctx.iteration(false);
        }
        assert_eq!(ticked.get(), 0, "the source kept running after removal");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_capacity_pressure_does_not_shorten_the_hang_deadline() {
        let mut deadline = None;
        for now in [4_000, 6_000, 8_000, 10_000, 12_000] {
            assert!(!capacity_failed(&mut deadline, now, 10_000));
        }
        assert!(capacity_failed(&mut deadline, 14_000, 10_000));
        assert!(!capacity_failed(&mut deadline, 16_000, 10_000));
        assert!(capacity_failed(&mut deadline, 24_000, 10_000));
    }

    #[test]
    fn held_native_executor_and_unanswered_callbacks_have_physical_bounds() {
        let gate = WorkGate::new(2);
        let health = Arc::new(RendererHealth::default());
        health.page_loaded(true);
        let stop = Arc::new(AtomicBool::new(false));
        let effects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut executor: Vec<Box<dyn FnOnce()>> = Vec::new();
        let mut probes = ProbeTable::new();
        for tick in 0..10_000 {
            if let Some(permit) = gate.acquire() {
                probes.issue(tick);
                let token = NativeToken {
                    health: health.clone(),
                    stop: stop.clone(),
                    generation: health.probe_generation().unwrap(),
                };
                let effects = effects.clone();
                executor.push(Box::new(move || {
                    if token.live() {
                        effects.fetch_add(1, Ordering::SeqCst);
                    }
                    drop(permit);
                }));
            }
            probes.take_expired(tick + 10_000, 10_000);
            probes.discard_all();
            assert!(executor.len() <= 2);
        }
        assert_eq!(executor.len(), 2);
        assert!(
            gate.acquire().is_none(),
            "logical expiry must not release native callback ownership"
        );
        health.page_loaded(true);
        for job in executor.drain(..) {
            job();
        }
        assert_eq!(
            effects.load(Ordering::SeqCst),
            0,
            "old generation executed native work"
        );
        assert_eq!(gate.count.load(Ordering::SeqCst), 0);
        let permit = gate.acquire().unwrap();
        let token = NativeToken {
            health,
            stop: stop.clone(),
            generation: 2,
        };
        stop.store(true, Ordering::SeqCst);
        assert!(!token.live());
        drop(permit);
        assert_eq!(gate.count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn queued_native_poll_retains_one_permit_until_executor_releases_it() {
        let gate = WorkGate::new(1);
        let held = gate.acquire().unwrap();
        for _ in 0..10_000 {
            assert!(gate.acquire().is_none());
        }
        drop(held);
        assert!(gate.acquire().is_some());
    }

    #[test]
    fn held_prompt_dispatch_expires_without_opening_a_dialog() {
        let cancel = AtomicBool::new(false);
        assert_eq!(prompt_preflight(100, &cancel, 99), None);
        assert_eq!(
            prompt_preflight(100, &cancel, 100),
            Some(PromptOutcome::TimedOut)
        );
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            prompt_preflight(100, &cancel, 101),
            Some(PromptOutcome::Cancelled)
        );
    }

    #[test]
    fn old_prompt_completion_cannot_release_or_cancel_its_replacement() {
        let old = PromptLease {
            incident_id: 1,
            deadline_ms: 100,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let new = PromptLease {
            incident_id: 2,
            deadline_ms: 200,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let slot = std::sync::Mutex::new(Some(new.clone()));
        release_prompt(&slot, &old);
        assert_eq!(slot.lock().unwrap().as_ref().unwrap().incident_id, 2);
        assert!(!new.cancel.load(Ordering::SeqCst));
        release_prompt(&slot, &new);
        assert!(slot.lock().unwrap().is_none());
        assert!(new.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn the_halted_title_tells_the_user_not_to_kill_the_app() {
        assert!(HALTED_TITLE.contains("agents still running"));
    }

    #[test]
    fn the_reload_mirror_script_targets_the_renderers_own_key() {
        assert!(RECORD_RELOAD_JS.contains("tr-reload-times"));
    }

    #[test]
    fn the_reload_mirror_script_cannot_throw_into_the_page() {
        assert!(RECORD_RELOAD_JS.contains("try {") && RECORD_RELOAD_JS.contains("catch"));
    }
}

#[cfg(test)]
mod reliability_tests {
    use super::*;

    #[test]
    fn paint_recovery_keeps_native_close_health_until_current_page_paints() {
        let health = RendererHealth::default();
        let mut machine = Machine::new(Thresholds::default(), true, 0);
        machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 1);
        machine.on_event(
            Event::PaintReport {
                ok: false,
                raf_gap_ms: 9_000,
            },
            2,
        );
        health.record_state(machine.state());
        assert!(health.unavailable());
        machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 3);
        if machine.state() == machine::State::Healthy {
            health.recover(0);
        }
        assert!(health.unavailable());
        health.record_termination();
        machine.note_reload_issued(4);
        let old = 0;
        health.page_loaded(true);
        machine.on_event(Event::PageLoaded, 5);
        let current = health.probe_generation().unwrap();
        health.recover(old);
        assert!(health.unavailable());
        machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 6);
        assert_eq!(machine.state(), machine::State::Recovering);
        assert!(health.unavailable());
        machine.on_event(
            Event::PaintReport {
                ok: true,
                raf_gap_ms: 16,
            },
            7,
        );
        if machine.state() == machine::State::Healthy {
            health.recover(current);
        }
        assert!(!health.unavailable());
    }

    #[test]
    fn native_termination_rejects_a_queued_reply_before_the_forwarded_event() {
        let health = RendererHealth::default();
        let mut machine = Machine::new(Thresholds::default(), true, 0);
        machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 1);
        let queued = health.probe_generation().unwrap();
        health.record_termination();
        assert_eq!(health.probe_generation(), None);
        health.recover(queued);
        assert!(
            health.unavailable(),
            "the supervisor has not received termination yet"
        );
        let actions = machine.on_event(
            Event::WebProcessTerminated {
                reason: machine::TerminationReason::Crashed,
            },
            2,
        );
        health.record_state(machine.state());
        assert_eq!(machine.state(), machine::State::Recovering);
        assert!(actions.contains(&Action::DiscardOutstandingProbes));
        let actions = machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 3);
        assert!(!actions.contains(&Action::SetTitle(TitleState::Normal)));
        health.recover(queued);
        assert!(
            health.unavailable(),
            "recovery enabled must still await navigation"
        );
        health.page_loaded(true);
        machine.on_event(Event::PageLoaded, 4);
        health.recover(queued);
        assert!(
            health.unavailable(),
            "navigation itself and old replies cannot recover"
        );
        let current = health.probe_generation().unwrap();
        machine.on_event(Event::ProbeReturned { rtt_ms: 5 }, 5);
        assert_eq!(machine.state(), machine::State::Healthy);
        health.recover(current);
        assert!(!health.unavailable());
    }

    #[test]
    fn termination_between_reply_validation_and_acknowledgment_remains_latched() {
        let health = RendererHealth::default();
        let validated = health.probe_generation().unwrap();
        health.record_termination();
        health.page_loaded(true);
        health.recover(validated);
        assert!(health.unavailable());
        let current = health.probe_generation().unwrap();
        health.record_termination();
        health.recover(current);
        assert!(health.unavailable());
    }

    #[test]
    fn every_navigation_invalidates_pre_load_replies() {
        let health = RendererHealth::default();
        health.record_state(machine::State::Unresponsive);
        let old = health.probe_generation().unwrap();
        health.page_loaded(true);
        health.recover(old);
        assert!(health.unavailable());
        health.recover(health.probe_generation().unwrap());
        assert!(!health.unavailable());
    }

    #[test]
    fn every_detected_failure_allows_native_close_and_stale_state_cannot_clear_it() {
        use machine::State;
        for state in [
            State::Unresponsive,
            State::PaintStalled,
            State::Gone,
            State::Recovering,
            State::Halted,
        ] {
            let health = RendererHealth::default();
            health.record_state(state);
            assert!(health.unavailable(), "{state:?}");
            for stale in [State::Booting, State::Healthy, State::Suspect] {
                health.record_state(stale);
                assert!(
                    health.unavailable(),
                    "{stale:?} is not a fresh health acknowledgment"
                );
            }
        }
    }

    #[test]
    fn houston_flags_override_legacy_flags_including_explicit_disable() {
        assert!(!flag_value(None, None));
        assert!(flag_value(None, Some("1".into())));
        assert!(flag_value(Some("1".into()), Some("0".into())));
        assert!(!flag_value(Some("0".into()), Some("1".into())));
        assert!(!flag_value(Some("invalid".into()), Some("1".into())));
    }
}

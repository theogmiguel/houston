#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod clocks;
pub mod gtk_signals;
pub mod log;
pub mod machine;
pub mod probe;
pub mod webview2_signals;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use clocks::{ClockClassifier, Clocks, SystemClocks};
use log::{NdjsonSink, Record, SessionSource, Sink, TransitionLog};
use machine::{Action, Event, Machine, Thresholds, TitleState};
use probe::{Completion, ProbeTable};

const HALTED_TITLE: &str = "Houston — UI not responding (agents still running)";

enum Msg {
    Event(Event),
    ProbeReply(String),
}

pub struct WatchdogHandle {
    tx: Sender<Msg>,
}

impl WatchdogHandle {
    fn send(&self, event: Event) {
        let _ = self.tx.send(Msg::Event(event));
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub thresholds: Thresholds,
    pub recovery_enabled: bool,
    pub log_path: std::path::PathBuf,
}

impl Config {
    pub fn from_env(log_path: std::path::PathBuf) -> Option<Self> {
        let flag = |name: &str| std::env::var(name).is_ok_and(|v| v == "1");
        if cfg!(debug_assertions) && !flag("TR_WATCHDOG") {
            return None;
        }
        Some(Self {
            thresholds: Thresholds::default(),
            recovery_enabled: flag("TR_WATCHDOG_RECOVER"),
            log_path,
        })
    }
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
    #[cfg(target_os = "linux")]
    {
        if let Err(err) =
            window.with_webview(|platform| gtk_signals::install_termination_logger(&platform))
        {
            eprintln!(
                "houston-tauri: renderer-crash logging not installed: could not reach \
                 the platform webview: {err}"
            );
            return false;
        }
    }
    #[cfg(windows)]
    if let Err(err) =
        window.with_webview(|platform| webview2_signals::install_termination_logger(&platform))
    {
        eprintln!(
            "houston-tauri: renderer-crash logging not installed: could not reach \
             the platform webview: {err}"
        );
        return false;
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    drop(window);
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

    let (tx, rx) = mpsc::channel();
    app.manage(WatchdogHandle { tx: tx.clone() });

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

    let sink: Arc<dyn Sink> = Arc::new(NdjsonSink::new(config.log_path.clone()));
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
        prompt_open: Arc::new(AtomicBool::new(false)),
        prompt_cancel: Arc::new(AtomicBool::new(false)),
        clocks: SystemClocks,
    };

    std::thread::Builder::new()
        .name("tr-watchdog".into())
        .spawn(move || supervisor.run(config))
        .map(|_| true)
        .unwrap_or_else(|err| {
            eprintln!("houston-tauri: watchdog thread failed to spawn: {err}");
            false
        })
}

pub fn note_page_loaded<R: Runtime>(app: &AppHandle<R>) {
    if let Some(handle) = app.try_state::<WatchdogHandle>() {
        let _ = handle.tx.send(Msg::Event(Event::PageLoaded));
    }
}

pub fn maybe_selftest_wedge<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(delay_ms) = std::env::var("TR_WATCHDOG_SELFTEST_WEDGE_MS")
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

#[cfg(any(target_os = "linux", windows))]
fn signal_events(tx: Sender<Msg>) -> Sender<Event> {
    let (event_tx, event_rx) = mpsc::channel::<Event>();
    std::thread::Builder::new()
        .name("tr-watchdog-signals".into())
        .spawn(move || {
            while let Ok(event) = event_rx.recv() {
                if tx.send(Msg::Event(event)).is_err() {
                    return;
                }
            }
        })
        .ok();
    event_tx
}
struct Supervisor<R: Runtime, C: Clocks> {
    window: WebviewWindow<R>,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
    sink: Arc<dyn Sink>,
    sessions: SessionSource,
    page_loaded: Arc<AtomicBool>,
    last_scale: Arc<std::sync::Mutex<Option<f64>>>,
    prompt_open: Arc<AtomicBool>,
    prompt_cancel: Arc<AtomicBool>,
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
                    let now = self.clocks.sample();
                    self.page_loaded.store(true, Ordering::SeqCst);
                    machine.note_reload_issued(now.mono_ms);
                    probes.discard_all();
                    next_probe_ms = now.mono_ms;
                }
                Ok(Msg::Event(event)) => {
                    let now = self.clocks.sample();
                    let actions = machine.on_event(event, now.mono_ms);
                    self.apply(&mut machine, &mut probes, actions, now);
                }
                Ok(Msg::ProbeReply(payload)) => {
                    let now = self.clocks.sample();
                    let event = match probes.complete(&payload, now.mono_ms) {
                        Completion::Matched { rtt_ms, .. } => Some(Event::ProbeReturned { rtt_ms }),
                        Completion::Malformed { rtt_ms, .. } => {
                            Some(Event::ProbeReturned { rtt_ms })
                        }
                        Completion::Unknown => None,
                    };
                    if let Some(event) = event {
                        let actions = machine.on_event(event, now.mono_ms);
                        self.apply(&mut machine, &mut probes, actions, now);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }

            let now = self.clocks.sample();

            if now.mono_ms >= next_tick_ms {
                next_tick_ms = now.mono_ms + t.clock_tick_ms;
                self.tick(&mut machine, &mut probes, &mut classifier, now);
            }

            if self.page_loaded.load(Ordering::SeqCst) && now.mono_ms >= next_probe_ms {
                next_probe_ms = now.mono_ms + machine.probe_period_ms();
                self.issue_probe(&mut probes, now.mono_ms);
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
    }

    fn poll_platform(&self) {
        let tx = self.tx.clone();
        let window = self.window.clone();
        let last_scale = self.last_scale.clone();
        let _ = self.window.run_on_main_thread(move || {
            let visible =
                window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
            let _ = tx.send(Msg::Event(Event::WindowVisible(visible)));
            let _ = tx.send(Msg::Event(Event::WindowFocused(
                window.is_focused().unwrap_or(true),
            )));

            if let Ok(scale) = window.scale_factor() {
                let mut last = match last_scale.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if last.is_some_and(|prev: f64| (prev - scale).abs() > f64::EPSILON) {
                    let _ = window.emit("wd:dpr", serde_json::json!({ "scale_factor": scale }));
                }
                *last = Some(scale);
            }
        });

        #[cfg(target_os = "linux")]
        {
            let tx = self.tx.clone();
            let _ = self.window.with_webview(move |platform| {
                for event in gtk_signals::poll(&platform) {
                    if tx.send(Msg::Event(event)).is_err() {
                        return;
                    }
                }
            });
        }
    }

    fn issue_probe(&self, probes: &mut ProbeTable, now_ms: u64) {
        let (nonce, script) = probes.issue(now_ms);
        let tx = self.tx.clone();
        if let Err(err) = self.window.eval_with_callback(script, move |payload| {
            let _ = tx.send(Msg::ProbeReply(payload));
        }) {
            eprintln!("houston-tauri: watchdog could not dispatch a probe: {err}");
            probes.discard(nonce);
        }
    }

    fn apply(
        &self,
        machine: &mut Machine,
        probes: &mut ProbeTable,
        actions: Vec<Action>,
        now: clocks::ClockSample,
    ) {
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
                    let _ = self.window.eval(RECORD_RELOAD_JS);
                }
                Action::Reload => {
                    let now_ms = self.clocks.sample().mono_ms;
                    machine.note_reload_issued(now_ms);
                    self.page_loaded.store(false, Ordering::SeqCst);
                    probes.discard_all();
                    if let Err(err) = self.window.reload() {
                        eprintln!("houston-tauri: watchdog reload failed: {err}");
                    }
                }
                Action::TerminateWebProcess => {
                    #[cfg(target_os = "linux")]
                    let _ = self
                        .window
                        .with_webview(|platform| gtk_signals::terminate_web_process(&platform));
                }
                Action::PromptThenRecover { timeout_ms } => {
                    self.prompt(timeout_ms);
                }
                Action::SetTitle(title) => {
                    if title == TitleState::Normal {
                        self.prompt_cancel.store(true, Ordering::SeqCst);
                    }
                    let _ = self.window.set_title(match title {
                        TitleState::Normal => "Houston",
                        TitleState::NotResponding => HALTED_TITLE,
                    });
                }
            }
        }
    }

    fn prompt(&self, timeout_ms: u64) {
        if self.prompt_open.swap(true, Ordering::SeqCst) {
            eprintln!(
                "houston-tauri: watchdog prompt already on screen; refusing to stack another"
            );
            return;
        }
        self.prompt_cancel.store(false, Ordering::SeqCst);
        let tx = self.tx.clone();
        let window = self.window.clone();
        let open = self.prompt_open.clone();
        let cancel = self.prompt_cancel.clone();
        let _ = self.window.run_on_main_thread(move || {
            let outcome = native_prompt(timeout_ms, prompt_parent(&window).as_ref(), &cancel);
            open.store(false, Ordering::SeqCst);
            let event = match outcome {
                PromptOutcome::Reload => Some(Event::RecoveryConfirmed { timed_out: false }),
                PromptOutcome::Decline => Some(Event::RecoveryDeclined),
                PromptOutcome::TimedOut => Some(Event::RecoveryConfirmed { timed_out: true }),
                PromptOutcome::Cancelled => None,
            };
            if let Some(event) = event {
                let _ = tx.send(Msg::Event(event));
            }
        });
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
    timeout_ms: u64,
    parent: Option<&gtk::ApplicationWindow>,
    cancel: &Arc<AtomicBool>,
) -> PromptOutcome {
    use gtk::prelude::*;

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
    dialog.show_all();

    const POLL_MS: u64 = 250;
    let verdict = std::rc::Rc::new(std::cell::Cell::new(None::<PromptOutcome>));
    let slot = verdict.clone();
    let cancel = cancel.clone();
    let weak = dialog.downgrade();
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let armed = std::rc::Rc::new(std::cell::Cell::new(true));
    let closure_armed = armed.clone();
    let source = glib::timeout_add_local(Duration::from_millis(POLL_MS), move || {
        let Some(dialog) = weak.upgrade() else {
            closure_armed.set(false);
            return glib::ControlFlow::Break;
        };
        let outcome = if cancel.load(Ordering::SeqCst) {
            PromptOutcome::Cancelled
        } else if std::time::Instant::now() >= deadline {
            PromptOutcome::TimedOut
        } else {
            return glib::ControlFlow::Continue;
        };
        slot.set(Some(outcome));
        dialog.response(gtk::ResponseType::DeleteEvent);
        closure_armed.set(false);
        glib::ControlFlow::Break
    });

    let response = dialog.run();
    remove_if_armed(source, &armed);
    // SAFETY: `dialog.run()` has returned, so no other code still holds it.
    unsafe {
        dialog.destroy();
    }

    if let Some(outcome) = verdict.get() {
        return outcome;
    }
    match response {
        gtk::ResponseType::Accept => PromptOutcome::Reload,
        gtk::ResponseType::Cancel => PromptOutcome::Decline,
        _ => PromptOutcome::TimedOut,
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
    _timeout_ms: u64,
    _parent: Option<&()>,
    _cancel: &Arc<AtomicBool>,
) -> PromptOutcome {
    PromptOutcome::TimedOut
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
pub fn wd_paint_report(
    handle: tauri::State<'_, WatchdogHandle>,
    ok: bool,
    raf_gap_ms: u64,
    visibility: Option<String>,
) {
    if visibility.as_deref() == Some("hidden") {
        return;
    }
    handle.send(Event::PaintReport { ok, raf_gap_ms });
}

#[tauri::command]
pub fn wd_request_reload(handle: tauri::State<'_, WatchdogHandle>, reason: String) {
    handle.send(Event::ReloadRequested { reason });
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
        let outcome = super::native_prompt(300, None, &cancel);
        assert_eq!(outcome, super::PromptOutcome::TimedOut);
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

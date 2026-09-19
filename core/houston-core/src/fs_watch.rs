use std::path::Path;
use std::time::Duration;

pub struct PollLadder {
    burst_remaining: u8,
}

impl PollLadder {
    // Poll rungs: a yielding round re-arms a short 1 s burst, then the steady
    // rungs trade latency for cost. The 30 s inactive rung is also the swarm-mail
    // GC sweep interval, so lengthening it slows that cleanup as well.
    const BURST_POLLS: u8 = 5;
    const BURST_DELAY_MS: u64 = 1_000;
    const WATCHER_OK_ACTIVE_MS: u64 = 7_500;
    pub(crate) const WATCHER_OK_INACTIVE_MS: u64 = 30_000;
    const WATCHER_DEAD_ACTIVE_MS: u64 = 2_000;
    const WATCHER_DEAD_INACTIVE_MS: u64 = 5_000;

    pub fn new() -> Self {
        Self { burst_remaining: 0 }
    }

    pub fn record_poll(&mut self, found: usize) {
        if found > 0 {
            self.burst_remaining = Self::BURST_POLLS;
        } else {
            self.burst_remaining = self.burst_remaining.saturating_sub(1);
        }
    }

    pub fn next_delay(&self, watcher_healthy: bool, view_active: bool) -> Duration {
        if self.burst_remaining > 0 {
            return Duration::from_millis(Self::BURST_DELAY_MS);
        }
        let ms = match (watcher_healthy, view_active) {
            (true, true) => Self::WATCHER_OK_ACTIVE_MS,
            (true, false) => Self::WATCHER_OK_INACTIVE_MS,
            (false, true) => Self::WATCHER_DEAD_ACTIVE_MS,
            (false, false) => Self::WATCHER_DEAD_INACTIVE_MS,
        };
        Duration::from_millis(ms)
    }
}

impl Default for PollLadder {
    fn default() -> Self {
        Self::new()
    }
}

pub struct MailWatchState {
    events: std::sync::atomic::AtomicU64,
    healthy: std::sync::atomic::AtomicBool,
    wake: std::sync::Arc<tokio::sync::Notify>,
}

impl MailWatchState {
    pub fn new(wake: std::sync::Arc<tokio::sync::Notify>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            events: std::sync::atomic::AtomicU64::new(0),
            healthy: std::sync::atomic::AtomicBool::new(false),
            wake,
        })
    }

    fn note_event(&self) {
        self.events
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.wake.notify_one();
    }

    pub fn events(&self) -> u64 {
        self.events.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn healthy(&self) -> bool {
        self.healthy.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[doc(hidden)]
pub fn is_content_change_for_tests(kind: notify::event::EventKind) -> bool {
    is_content_change(kind)
}

// Content changes are create/remove, data/name modify, and a write-closing
// access. Metadata events are the IN_ATTRIB trap and deliberately not one; the
// catch-all treats notify overflow as a possible change, never a silent miss.
fn is_content_change(kind: notify::event::EventKind) -> bool {
    use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind};
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Name(_)) => true,
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Access(_) => false,
        _ => true,
    }
}

/// Hint-only: on a content change the callback only notes the event and never
/// reads the changed file, so a missed or duplicated inotify event is harmless —
/// the next poll is the source of truth. An event schedules a poll at delay 0.
pub fn start_watcher(
    root: &Path,
    state: std::sync::Arc<MailWatchState>,
) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher as _;
    let cb_state = std::sync::Arc::clone(&state);
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) if is_content_change(event.kind) => {
                cb_state.note_event();
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("fs watcher event error: {e}"),
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(
                    "fs watcher: delivery degraded to polling — failed to start a watcher for \
                     {}: {e}",
                    root.display()
                );
                return None;
            }
        };
    if let Err(e) = watcher.watch(root, notify::RecursiveMode::Recursive) {
        tracing::warn!(
            "fs watcher: delivery degraded to polling — failed to watch {}: {e}",
            root.display()
        );
        return None;
    }
    state
        .healthy
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_returns_every_rung_for_its_input_combination() {
        let ladder = PollLadder::new();
        assert_eq!(ladder.next_delay(true, true), Duration::from_millis(7_500));
        assert_eq!(
            ladder.next_delay(true, false),
            Duration::from_millis(30_000)
        );
        assert_eq!(ladder.next_delay(false, true), Duration::from_millis(2_000));
        assert_eq!(
            ladder.next_delay(false, false),
            Duration::from_millis(5_000)
        );
    }

    #[test]
    fn ladder_burst_lasts_exactly_five_polls_then_falls_back() {
        let mut ladder = PollLadder::new();
        assert_eq!(ladder.next_delay(true, true), Duration::from_millis(7_500));

        ladder.record_poll(1);
        for i in 0..PollLadder::BURST_POLLS {
            assert_eq!(
                ladder.next_delay(true, true),
                Duration::from_millis(1_000),
                "burst poll {i} must still use the burst delay"
            );
            ladder.record_poll(0);
        }
        assert_eq!(ladder.next_delay(true, true), Duration::from_millis(7_500));
    }

    #[test]
    fn ladder_yielding_poll_during_a_burst_rearms_the_full_burst() {
        let mut ladder = PollLadder::new();
        ladder.record_poll(1);
        ladder.record_poll(0);
        ladder.record_poll(0);
        ladder.record_poll(2);
        for i in 0..PollLadder::BURST_POLLS {
            assert_eq!(
                ladder.next_delay(false, false),
                Duration::from_millis(1_000),
                "re-armed burst poll {i} must still use the burst delay"
            );
            ladder.record_poll(0);
        }
        assert_eq!(
            ladder.next_delay(false, false),
            Duration::from_millis(5_000)
        );
    }

    #[test]
    fn ladder_burst_outranks_every_watcher_active_combination() {
        let mut ladder = PollLadder::new();
        ladder.record_poll(1);
        for (healthy, active) in [(true, true), (true, false), (false, true), (false, false)] {
            assert_eq!(
                ladder.next_delay(healthy, active),
                Duration::from_millis(1_000),
                "burst must outrank ({healthy}, {active})"
            );
        }
    }

    fn wait_for(mut cond: impl FnMut() -> bool, what: &str) {
        for _ in 0..100 {
            if cond() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for: {what}");
    }

    #[test]
    fn watcher_callback_only_increments_the_event_counter() {
        let tmp = tempfile::tempdir().unwrap();
        let wake = std::sync::Arc::new(tokio::sync::Notify::new());
        let state = MailWatchState::new(wake);
        let _watcher = start_watcher(tmp.path(), std::sync::Arc::clone(&state))
            .expect("watcher must start on a real, existing directory");
        assert!(state.healthy());
        assert_eq!(state.events(), 0, "must start with no events observed");

        std::fs::write(tmp.path().join("0000000000001-deadbeef.json"), b"{}").unwrap();

        wait_for(
            || state.events() > 0,
            "event counter to increment after a file landed in the watched scope",
        );
        assert!(state.events() >= 1, "expected at least one event, got 0");
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn watcher_failing_to_start_leaves_health_false_and_logs_the_path() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let wake = std::sync::Arc::new(tokio::sync::Notify::new());
        let state = MailWatchState::new(wake);

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let watcher = tracing::subscriber::with_default(subscriber, || {
            start_watcher(&missing, std::sync::Arc::clone(&state))
        });

        assert!(
            watcher.is_none(),
            "watching a nonexistent directory must fail to start"
        );
        assert!(!state.healthy(), "health flag must stay false");

        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains(&missing.display().to_string()),
            "warning should name the path that failed: {logged}"
        );
        assert!(
            logged.contains("degraded to polling"),
            "warning should say delivery degraded to polling: {logged}"
        );

        let ladder = PollLadder::new();
        assert_eq!(
            ladder.next_delay(state.healthy(), true),
            Duration::from_millis(2_000),
            "a dead watcher must select the watcher-dead rung"
        );
    }
}

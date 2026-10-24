//! Delivery canary for the hook-drop watcher: writes a probe into the watched drop
//! directory and requires the watcher's event counter to advance; a miss selects the
//! ladder's watcher-dead rungs. Cadence and health inputs: docs/internals/daemon.md.

use std::path::Path;
use std::time::Duration;

use crate::fs_watch::MailWatchState;

/// Reserved probe name in the watched drop directory: never `.json`, so
/// `hook_drop::run_pass` skips it silently and it is never a hook or inbox
/// row. One fixed name bounds the probe to a single file.
pub const PROBE_NAME: &str = "houston-canary.probe";

/// Matches the idle healthy rung: a live watcher delivers the probe's own
/// create event within milliseconds, so the directory gains at most one
/// ~40-byte file per interval.
const PROBE_EVERY_MS: u64 = 30_000;

/// A probe unacknowledged this long is a miss. Far above healthy event
/// latency (milliseconds) and below the cadence, so the first tick past the
/// deadline — within one canary period — declares it.
const PROBE_DEADLINE_MS: u64 = 15_000;

/// The probe whose delivery is still being judged.
#[derive(Debug)]
struct Outstanding {
    /// `MailWatchState::events()` read before the probe was written, so its
    /// own create event cannot be folded into the baseline. Any advance since,
    /// the probe's or a real drop's, is delivery evidence.
    baseline: u64,
    written_ms: u64,
}

#[derive(Debug)]
pub struct CanaryState {
    outstanding: Option<Outstanding>,
    /// `None` until the first round, which writes a probe at once.
    last_write_ms: Option<u64>,
    unhealthy: bool,
    warned: bool,
    every_ms: u64,
    deadline_ms: u64,
}

impl Default for CanaryState {
    fn default() -> Self {
        Self {
            outstanding: None,
            last_write_ms: None,
            unhealthy: false,
            warned: false,
            every_ms: PROBE_EVERY_MS,
            deadline_ms: PROBE_DEADLINE_MS,
        }
    }
}

impl CanaryState {
    /// Also makes the next round write a probe regardless of the cadence.
    #[doc(hidden)]
    pub fn set_timing_for_test(&mut self, every: Duration, deadline: Duration) {
        self.every_ms = every.as_millis() as u64;
        self.deadline_ms = deadline.as_millis() as u64;
        self.last_write_ms = None;
    }
}

/// One canary round: judge any outstanding probe, then write the next one when
/// due. Returns whether hook-drop event delivery is healthy; `false` selects
/// the swarm-mail ladder's watcher-dead rungs.
pub fn check(state: &mut CanaryState, dir: &Path, watch: &MailWatchState, now_ms: u64) -> bool {
    if !watch.healthy() {
        // The watcher never started: the health conjunction that consumes this
        // verdict is already false, and no probe was ever written to clean up.
        return false;
    }
    if let Some(outstanding) = state.outstanding.take() {
        if watch.events() > outstanding.baseline {
            let _ = std::fs::remove_file(dir.join(PROBE_NAME));
            if state.unhealthy {
                tracing::info!(
                    "hook-drop canary: the delivery probe in {} was delivered again — \
                     leaving the watcher-dead rungs",
                    dir.display()
                );
            }
            state.unhealthy = false;
            state.warned = false;
        } else if now_ms.saturating_sub(outstanding.written_ms) >= state.deadline_ms {
            let _ = std::fs::remove_file(dir.join(PROBE_NAME));
            if !state.warned {
                tracing::warn!(
                    "hook-drop canary: no watcher event within {}ms of the delivery probe in {} — \
                     hook-drop delivery degraded to polling; holding the ladder's watcher-dead \
                     rungs until a probe is delivered",
                    state.deadline_ms,
                    dir.display()
                );
                state.warned = true;
            }
            state.unhealthy = true;
        } else {
            state.outstanding = Some(outstanding);
        }
    }
    let due = state
        .last_write_ms
        .is_none_or(|last| now_ms.saturating_sub(last) >= state.every_ms);
    if due && state.outstanding.is_none() {
        state.last_write_ms = Some(now_ms);
        let baseline = watch.events();
        match write_probe(dir, now_ms) {
            Ok(()) => {
                state.outstanding = Some(Outstanding {
                    baseline,
                    written_ms: now_ms,
                });
            }
            Err(error) => {
                if !state.warned {
                    tracing::warn!(
                        "hook-drop canary: writing the delivery probe {} failed: {error} — \
                         holding the ladder's watcher-dead rungs",
                        dir.join(PROBE_NAME).display()
                    );
                    state.warned = true;
                }
                state.unhealthy = true;
            }
        }
    }
    !state.unhealthy
}

/// Returns once `watch`'s counter holds still for 100 ms: a dropped watcher's thread
/// can still count events it had already queued.
#[doc(hidden)]
pub fn wait_for_quiet_for_test(watch: &MailWatchState) {
    let mut last = watch.events();
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        let now = watch.events();
        if now == last {
            return;
        }
        last = now;
    }
    panic!("the watcher kept counting events for 5 s after it was stopped");
}

/// Never creates the directory: a watch on a vanished drop directory delivers
/// nothing, so a missing directory is a miss rather than something to repair
/// here with permissions `hook_drop::ensure_drop_dir` would not choose.
fn write_probe(dir: &Path, now_ms: u64) -> std::io::Result<()> {
    std::fs::write(
        dir.join(PROBE_NAME),
        format!(r#"{{"houston_delivery_probe":{now_ms}}}"#),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use crate::hook_drop::{self, DropVerdict, HookDrop, Pass};

    fn wait_for(mut cond: impl FnMut() -> bool, what: &str) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for: {what}");
    }

    fn wait_delivered(state: &CanaryState, watch: &MailWatchState, what: &str) {
        let baseline = state
            .outstanding
            .as_ref()
            .expect("a probe is outstanding")
            .baseline;
        wait_for(|| watch.events() > baseline, what);
    }

    fn watched_dir() -> (
        tempfile::TempDir,
        std::sync::Arc<MailWatchState>,
        notify::RecommendedWatcher,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = hook_drop::drop_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        let watch = MailWatchState::new(std::sync::Arc::new(tokio::sync::Notify::new()));
        let watcher = crate::fs_watch::start_watcher(&dir, std::sync::Arc::clone(&watch))
            .expect("watcher must start on a real directory");
        (tmp, watch, watcher)
    }

    fn probe_path(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        hook_drop::drop_dir(tmp.path()).join(PROBE_NAME)
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl LogBuf {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

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
    fn the_probe_name_is_invisible_to_the_drop_pass() {
        assert_eq!(hook_drop::parse_drop_name(PROBE_NAME), None);

        let tmp = tempfile::tempdir().unwrap();
        let dir = hook_drop::drop_dir(tmp.path());
        hook_drop::ensure_drop_dir(&dir).unwrap();
        write_probe(&dir, 1_754_600_000_000).unwrap();
        hook_drop::write_drop(
            &dir,
            &HookDrop {
                event: "Stop".into(),
                session: 7,
                ..HookDrop::default()
            },
            1_754_600_000_000,
        )
        .unwrap();

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut seen = Vec::new();
        let out = tracing::subscriber::with_default(subscriber, || {
            let mut state = hook_drop::DropDirState::new();
            hook_drop::run_pass(&dir, &mut state, 1_754_600_000_001, Pass::Steady, |d| {
                seen.push(d.event.clone());
                DropVerdict::Applied
            })
        });

        assert_eq!(
            seen,
            vec!["Stop".to_string()],
            "only the real drop is applied"
        );
        assert_eq!((out.applied, out.kept, out.collected), (1, 0, 0));
        assert!(
            probe_path(&tmp).exists(),
            "the drop pass must neither consume nor delete the probe"
        );
        assert!(
            !buf.text().contains("does not parse"),
            "the probe is skipped silently, not warned about: {}",
            buf.text()
        );
    }

    #[test]
    fn a_delivered_probe_is_consumed_and_reports_healthy() {
        let (tmp, watch, _watcher) = watched_dir();
        let mut state = CanaryState::default();

        assert!(check(
            &mut state,
            &hook_drop::drop_dir(tmp.path()),
            &watch,
            1_000
        ));
        wait_delivered(&state, &watch, "the probe's own create event");
        assert!(
            probe_path(&tmp).exists(),
            "the probe stays until it is judged"
        );

        assert!(check(
            &mut state,
            &hook_drop::drop_dir(tmp.path()),
            &watch,
            2_000
        ));
        assert!(
            !probe_path(&tmp).exists(),
            "a delivered probe is consumed by the checker"
        );
        assert!(
            !check_has_outstanding(&state),
            "nothing is left outstanding after a delivery"
        );
    }

    #[test]
    fn a_create_event_that_lands_while_the_probe_is_written_still_counts() {
        let (tmp, watch, _watcher) = watched_dir();
        let dir = hook_drop::drop_dir(tmp.path());
        let mut state = CanaryState::default();
        let before = watch.events();

        assert!(check(&mut state, &dir, &watch, 1_000));
        wait_for(|| watch.events() > before, "the probe's create event");
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            check(&mut state, &dir, &watch, 1_000 + PROBE_DEADLINE_MS),
            "an event delivered before the write returned is delivery, not a miss"
        );
    }

    fn check_has_outstanding(state: &CanaryState) -> bool {
        state.outstanding.is_some()
    }

    #[test]
    fn a_missed_probe_latches_unhealthy_until_a_probe_is_delivered() {
        let (tmp, watch, watcher) = watched_dir();
        let mut state = CanaryState::default();
        let dir = hook_drop::drop_dir(tmp.path());

        assert!(check(&mut state, &dir, &watch, 1_000));
        wait_delivered(&state, &watch, "the first probe's create event");
        assert!(
            check(&mut state, &dir, &watch, 2_000),
            "first probe delivered"
        );

        drop(watcher);
        wait_for_quiet_for_test(&watch);

        assert!(
            check(&mut state, &dir, &watch, 31_000),
            "a fresh probe is not judged before its deadline"
        );
        assert!(probe_path(&tmp).exists());
        assert!(
            !check(&mut state, &dir, &watch, 31_000 + 15_000),
            "the deadline with a flat event counter is a miss"
        );
        assert!(!probe_path(&tmp).exists(), "the missed probe is removed");
        assert!(
            !check(&mut state, &dir, &watch, 31_000 + 16_000),
            "the miss latches until a probe is delivered"
        );

        let restarted = crate::fs_watch::start_watcher(&dir, std::sync::Arc::clone(&watch))
            .expect("restarted watcher must start");
        assert!(
            !check(&mut state, &dir, &watch, 61_000),
            "writing the next probe does not lift the latch by itself"
        );
        assert!(probe_path(&tmp).exists());
        wait_delivered(&state, &watch, "the recovery probe's create event");
        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let recovered = tracing::subscriber::with_default(subscriber, || {
            check(&mut state, &dir, &watch, 61_100)
        });
        assert!(recovered, "delivery recovered");
        let logged = buf.text();
        assert!(
            logged.contains("delivered again") && !logged.contains("    "),
            "recovery is logged on one clean line: {logged}"
        );
        assert!(!probe_path(&tmp).exists());
        drop(restarted);
    }

    #[test]
    fn dead_delivery_bounds_the_directory_to_one_probe() {
        let (tmp, watch, watcher) = watched_dir();
        drop(watcher);
        wait_for_quiet_for_test(&watch);
        let mut state = CanaryState::default();
        let dir = hook_drop::drop_dir(tmp.path());

        assert!(
            check(&mut state, &dir, &watch, 31_000),
            "the first probe is written"
        );
        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        tracing::subscriber::with_default(subscriber, || {
            for round in 0..3u64 {
                let now = 31_000 * (round + 2);
                assert!(!check(&mut state, &dir, &watch, now), "round {round}");
                let entries = std::fs::read_dir(&dir).unwrap().count();
                assert!(
                    entries <= 1,
                    "round {round}: {entries} files in the drop directory"
                );
            }
        });
        let logged = buf.text();
        assert_eq!(
            logged.matches("no watcher event within").count(),
            1,
            "a miss warns once until delivery recovers: {logged}"
        );
        assert!(
            !logged.contains("    "),
            "the warning text has no indentation runs from a lost line continuation: {logged}"
        );
    }

    #[test]
    fn a_vanished_drop_directory_is_a_named_miss_and_is_not_recreated() {
        let (tmp, watch, _watcher) = watched_dir();
        let dir = hook_drop::drop_dir(tmp.path());
        let gone = tmp.path().join("hooks").join("gone");

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut state = CanaryState::default();
        let healthy = tracing::subscriber::with_default(subscriber, || {
            check(&mut state, &gone, &watch, 1_000)
        });

        assert!(!healthy, "a failed probe write must read as unhealthy");
        assert!(!gone.exists(), "the canary never creates the directory");
        assert!(dir.is_dir());
        let logged = buf.text();
        assert!(
            logged.contains("delivery probe") && logged.contains(PROBE_NAME),
            "the warning must name the canary and the probe path: {logged}"
        );
        assert!(
            !logged.contains("    "),
            "the warning text has no indentation runs from a lost line continuation: {logged}"
        );
    }

    #[test]
    fn a_probe_is_written_on_the_first_round_and_then_once_per_period() {
        let (tmp, watch, _watcher) = watched_dir();
        let dir = hook_drop::drop_dir(tmp.path());
        let mut state = CanaryState::default();

        assert!(check(&mut state, &dir, &watch, 1_000));
        assert!(probe_path(&tmp).exists(), "the first round writes a probe");
        wait_delivered(&state, &watch, "the probe's create event");
        assert!(check(&mut state, &dir, &watch, 1_100));
        assert!(!probe_path(&tmp).exists());

        assert!(check(&mut state, &dir, &watch, 1_000 + PROBE_EVERY_MS - 1));
        assert!(!probe_path(&tmp).exists(), "no probe before the period");
        assert!(check(&mut state, &dir, &watch, 1_000 + PROBE_EVERY_MS));
        assert!(probe_path(&tmp).exists(), "one probe per period");
    }

    #[test]
    fn no_probe_is_written_when_the_watcher_never_started() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = hook_drop::drop_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        let watch = MailWatchState::new(std::sync::Arc::new(tokio::sync::Notify::new()));
        let mut state = CanaryState::default();

        assert!(!check(&mut state, &dir, &watch, 1_000));
        assert!(!probe_path(&tmp).exists());
    }
}

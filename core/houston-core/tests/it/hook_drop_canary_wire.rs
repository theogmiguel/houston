use crate::common;
use houston_core::hook_drop::{self, HookDrop};
use houston_core::hook_drop_canary::PROBE_NAME;
use std::time::{Duration, Instant};

const HEALTHY_IDLE_RUNG: Duration = Duration::from_millis(30_000);
const DEAD_IDLE_RUNG: Duration = Duration::from_millis(5_000);
const WAIT_BUDGET: Duration = Duration::from_secs(5);
const TICK_STEP: Duration = Duration::from_millis(50);

fn probe_path(state_dir: &std::path::Path) -> std::path::PathBuf {
    hook_drop::drop_dir(state_dir).join(PROBE_NAME)
}

fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + WAIT_BUDGET;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(TICK_STEP);
    }
}

#[tokio::test]
async fn the_ladder_degrades_within_one_canary_period_and_recovers() {
    let (_addr, state_dir, daemon) = common::start_daemon_without_mail_loop().await;
    let probe = probe_path(state_dir.path());
    // A long cadence means only the forced first round of each phase writes.
    let force_probe = || {
        daemon.set_hook_drop_canary_timing_for_test(
            Duration::from_secs(60),
            Duration::from_millis(200),
        )
    };
    force_probe();

    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        HEALTHY_IDLE_RUNG,
        "a fresh daemon with a live watcher is healthy"
    );
    assert!(probe.exists(), "the first tick writes the probe");
    let consumed = wait_until(|| {
        daemon.swarm_mail_tick_for_test();
        !probe.exists()
    });
    assert!(consumed, "a delivered probe is consumed by the checker");
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        HEALTHY_IDLE_RUNG,
        "delivered probes keep the healthy rung"
    );

    daemon.stop_hook_drop_watcher_for_test();
    force_probe();
    let probe_written = Instant::now();
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        HEALTHY_IDLE_RUNG,
        "a fresh probe is not judged before its deadline"
    );
    assert!(probe.exists());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        DEAD_IDLE_RUNG,
        "a flat event counter at the deadline must select the watcher-dead rung"
    );
    assert!(
        probe_written.elapsed() < HEALTHY_IDLE_RUNG,
        "the miss is declared within one canary period"
    );
    assert!(!probe.exists(), "the missed probe is removed");
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        DEAD_IDLE_RUNG,
        "the miss latches until a probe is delivered"
    );

    daemon.restart_hook_drop_watcher_for_test();
    force_probe();
    let recovered = wait_until(|| daemon.swarm_mail_tick_for_test() == HEALTHY_IDLE_RUNG);
    assert!(
        recovered,
        "delivery recovers once the watcher answers again"
    );
    assert!(!probe.exists(), "the recovery probe is consumed");
}

#[tokio::test]
async fn probes_never_surface_as_hooks_or_session_state() {
    let (_addr, state_dir, daemon) = common::start_daemon_without_mail_loop().await;
    let probe = probe_path(state_dir.path());
    daemon
        .set_hook_drop_canary_timing_for_test(Duration::from_secs(60), Duration::from_millis(200));

    let fixture_drop = hook_drop::write_drop(
        &hook_drop::drop_dir(state_dir.path()),
        &HookDrop {
            event: "Stop".into(),
            session: 4242,
            ..HookDrop::default()
        },
        hook_drop::now_ms(),
    )
    .expect("writing the fixture drop");
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        HEALTHY_IDLE_RUNG,
        "the probe and the fixture drop coexist on the healthy rung"
    );
    assert!(probe.exists());

    let consumed = wait_until(|| {
        daemon.swarm_mail_tick_for_test();
        !probe.exists()
    });
    assert!(consumed, "the canary consumed its probe");

    assert!(
        fixture_drop.exists(),
        "the real drop is untouched: an unknown session is kept, not applied"
    );
    assert!(
        daemon.list().is_empty(),
        "no probe or fixture drop may create session state"
    );
    assert_eq!(
        daemon.swarm_mail_tick_for_test(),
        HEALTHY_IDLE_RUNG,
        "the drop pass stays listed-ok while probes cycle through the directory"
    );
}

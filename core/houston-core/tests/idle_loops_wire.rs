mod common;

use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol as proto;
use std::time::Duration;

use common::TOKEN;

fn test_daemon() -> (std::sync::Arc<Daemon>, tempfile::TempDir) {
    let state = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("t.db"),
    })
    .unwrap();
    (daemon, state)
}

#[tokio::test]
async fn a_fully_idle_daemon_does_not_tick_beyond_the_routine_loops_boot_pass() {
    let (daemon, _state) = test_daemon();
    houston_core::boot::spawn_background_loops(&daemon);

    tokio::time::sleep(Duration::from_millis(300)).await;

    let (routine, delegation) = daemon.idle_tick_counts_for_test();
    assert_eq!(
        routine, 1,
        "routine_fire_loop ticks once at boot, then parks"
    );
    assert_eq!(delegation, 0, "delegation_watch_loop must never tick idle");
}

fn context_switches() -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir("/proc/self/task") else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        for line in status.lines() {
            if let Some(n) = line
                .strip_prefix("voluntary_ctxt_switches:")
                .or_else(|| line.strip_prefix("nonvoluntary_ctxt_switches:"))
            {
                total += n.trim().parse::<u64>().unwrap_or(0);
            }
        }
    }
    total
}

#[tokio::test]
#[ignore = "perf smoke — run explicitly"]
async fn p3_idle_context_switches_per_minute() {
    let _serial = PROCESS_WIDE.lock().await;
    const CEILING_PER_MIN: f64 = 15.0;
    const WINDOW_SECS: u64 = 20;

    let (daemon, _state) = test_daemon();
    daemon
        .routine_create_for_test(
            "far-future",
            "noop",
            proto::Cadence::Interval { seconds: 86_400 },
            None,
            proto::AgentKind::Claude,
            None,
            None,
        )
        .expect("create routine");

    houston_core::boot::spawn_background_loops(&daemon);

    tokio::time::sleep(Duration::from_secs(2)).await;
    let start = context_switches();
    let cpu_start = std::time::Instant::now();

    tokio::time::sleep(Duration::from_secs(WINDOW_SECS)).await;

    let delta = context_switches().saturating_sub(start);
    let elapsed_min = cpu_start.elapsed().as_secs_f64() / 60.0;
    let per_min = delta as f64 / elapsed_min;
    println!(
        "P3: {delta} switches over {WINDOW_SECS}s ({per_min:.1}/min, ceiling {CEILING_PER_MIN}/min)"
    );

    assert!(
        per_min <= CEILING_PER_MIN,
        "idle scheduling activity {per_min:.1}/min exceeds the {CEILING_PER_MIN}/min ceiling \
         ({delta} switches over {WINDOW_SECS}s)"
    );
}

static PROCESS_WIDE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn wait_for_last_line(daemon: &Daemon, ids: &[u32], lines: usize, deadline: Duration) {
    let wanted = lines.to_string();
    let start = std::time::Instant::now();
    for id in ids {
        loop {
            let screen = daemon.session_screen_for_test(*id);
            if screen.iter().any(|l| l.trim() == wanted) {
                break;
            }
            assert!(
                start.elapsed() < deadline,
                "session {id} never showed \"{wanted}\" as a screen row within the {deadline:?} \
                 deadline; last non-empty row was {:?}",
                screen.iter().rev().find(|l| !l.trim().is_empty())
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

fn thread_count() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:")?.trim().parse().ok())
        .unwrap_or(0)
}

fn vmrss_mib() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_whitespace()
            .next()?
            .parse::<f64>()
            .ok()
            .map(|kib| kib / 1024.0)
    })
}

#[tokio::test]
#[ignore = "perf smoke — run explicitly, release build only"]
async fn p4_idle_rss_at_zero_sessions() {
    let _serial = PROCESS_WIDE.lock().await;
    if cfg!(debug_assertions) {
        eprintln!("P4 needs a release build to mean anything; skipping under debug_assertions");
        return;
    }
    const CEILING_MIB: f64 = 30.0;

    let (daemon, _state) = test_daemon();
    houston_core::boot::spawn_background_loops(&daemon);
    tokio::time::sleep(Duration::from_secs(2)).await;

    let mib = vmrss_mib().expect("VmRSS must be readable on Linux");
    println!("P4: {mib:.1} MiB at 0 sessions (ceiling {CEILING_MIB} MiB)");
    assert!(
        mib <= CEILING_MIB,
        "idle RSS {mib:.1} MiB exceeds the {CEILING_MIB} MiB ceiling"
    );
}

#[tokio::test]
#[ignore = "perf smoke — run explicitly, release build only"]
async fn p4_idle_rss_with_twelve_saturated_emulators() {
    let _serial = PROCESS_WIDE.lock().await;
    if cfg!(debug_assertions) {
        eprintln!("P4 needs a release build to mean anything; skipping under debug_assertions");
        return;
    }
    if !houston_core::vt::available() {
        eprintln!("no emulator in this build; nothing for this measurement to weigh");
        return;
    }
    const SESSIONS: usize = 12;
    const LINES: usize = 10_000;
    const CEILING_MIB: f64 = 64.0;
    const CLOSE_SLACK_MIB: f64 = 8.0;
    const POLL_DEADLINE: Duration = Duration::from_secs(120);
    const SETTLE_DEADLINE: Duration = Duration::from_secs(20);

    let (daemon, _state) = test_daemon();
    houston_core::boot::spawn_background_loops(&daemon);
    let project = tempfile::tempdir().unwrap();

    let threads_before = thread_count();
    let mib_before = vmrss_mib().expect("VmRSS must be readable on Linux");
    println!(
        "P4: {mib_before:.1} MiB and {threads_before} threads before creating {SESSIONS} sessions"
    );

    let mut ids = Vec::new();
    for _ in 0..SESSIONS {
        let info = daemon
            .create_session(houston_core::daemon::CreateParams {
                agent: proto::AgentKind::Shell,
                project_dir: project.path().to_path_buf(),
                cmd: None,
                cols: 120,
                rows: 32,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
            })
            .expect("a shell session starts");
        ids.push(info.id);
    }

    for id in &ids {
        daemon
            .write_stdin(*id, format!("seq 1 {LINES}\n").as_bytes())
            .expect("stdin reaches the PTY");
    }

    wait_for_last_line(&daemon, &ids, LINES, POLL_DEADLINE).await;

    let mib_at_load = vmrss_mib().expect("VmRSS must be readable on Linux");
    let threads_at_load = thread_count();
    println!(
        "P4: {mib_at_load:.1} MiB and {threads_at_load} threads at {SESSIONS} idle shells with saturated emulators (LINES={LINES}, ceiling {CEILING_MIB} MiB)"
    );
    assert!(
        mib_at_load <= CEILING_MIB,
        "RSS {mib_at_load:.1} MiB at {SESSIONS} saturated sessions exceeds the {CEILING_MIB} MiB ceiling"
    );

    for id in &ids {
        daemon.close(*id).expect("a live session closes");
    }

    let settle_start = std::time::Instant::now();
    let settle_deadline = settle_start + SETTLE_DEADLINE;
    let mut threads_after = thread_count();
    while threads_after > threads_before && std::time::Instant::now() < settle_deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        threads_after = thread_count();
    }
    let settle_secs = settle_start.elapsed().as_secs_f64();
    assert!(
        threads_after <= threads_before,
        "thread count {threads_after} did not return to the pre-session count {threads_before} \
         within the {SETTLE_DEADLINE:?} deadline after closing {SESSIONS} sessions"
    );

    let mib_after_close = vmrss_mib().expect("VmRSS must be readable on Linux");
    println!(
        "P4: {mib_after_close:.1} MiB and {threads_after} threads after closing {SESSIONS} sessions ({settle_secs:.1} s to settle)"
    );
    assert!(
        mib_after_close <= mib_before + CLOSE_SLACK_MIB,
        "RSS {mib_after_close:.1} MiB after closing {SESSIONS} sessions exceeds the pre-session \
         reading ({mib_before:.1} MiB) plus the {CLOSE_SLACK_MIB} MiB slack"
    );
}

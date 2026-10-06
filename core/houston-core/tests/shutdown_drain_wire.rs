mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::Arc;

#[cfg(unix)]
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn daemon(state_dir: &std::path::Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn create_custom(d: &Arc<Daemon>, dir: &std::path::Path, cmd: Vec<&str>) -> u32 {
    d.create_session(CreateParams {
        agent: proto::AgentKind::Custom,
        project_dir: dir.to_path_buf(),
        cmd: Some(cmd.into_iter().map(String::from).collect()),
        cols: 80,
        rows: 24,
        cwd_from: None,
        shell_integration: false,
        auto_approve: false,
        acp: None,
        profile: None,
        prompt: None,
        model: None,
        effort: None,
    })
    .unwrap()
    .id
}

#[tokio::test]
#[cfg(unix)]
async fn a_session_ignoring_sighup_and_sigterm_confirms_forced_exit_before_the_marker() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let mut updates = d.subscribe();
    let id = create_custom(
        &d,
        proj.path(),
        vec![
            "sh",
            "-c",
            "trap '' TERM HUP; echo $$ > root.pid; sleep 100 & echo $! > child.pid; wait",
        ],
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let pids = loop {
        let root = std::fs::read_to_string(proj.path().join("root.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        let child = std::fs::read_to_string(proj.path().join("child.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let (Some(root), Some(child)) = (root, child) {
            break [root, child];
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "PTY fixture did not start"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert!(pids
        .iter()
        .all(|pid| houston_core::pid::process_is_alive(*pid)));
    assert!(!state.path().join("clean-shutdown").exists());

    d.reap_set_exit_hook_for_test(Box::new(|| {}));
    let result = {
        let _env = ENV_LOCK.lock().unwrap();
        std::env::set_var("HOUSTON_SHUTDOWN_DRAIN_MS", "200");
        let result = d.manage_shutdown();
        std::env::remove_var("HOUSTON_SHUTDOWN_DRAIN_MS");
        result
    };
    let ok = result.expect("SIGKILL must stop a session that ignores SIGHUP and SIGTERM");
    assert!(ok.ok);
    assert_eq!(ok.stopped_sessions, 1);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let houston_core::daemon::Outbound::Control(text) = updates.recv().await.unwrap() {
                if let proto::ServerMsg::SessionState {
                    session,
                    state,
                    exit_code,
                } = serde_json::from_str(&text).unwrap()
                {
                    if session == id {
                        assert!(matches!(
                            state,
                            proto::SessionState::Killed | proto::SessionState::Exited
                        ));
                        assert!(
                            exit_code.is_some(),
                            "the backend must confirm its exit status"
                        );
                        break;
                    }
                }
            }
        }
    })
    .await
    .expect("the forced exit must be reported");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let alive = pids.iter().any(|pid| {
            if !houston_core::pid::process_is_alive(*pid) {
                return false;
            }
            #[cfg(target_os = "linux")]
            {
                std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                    stat[stat.rfind(')').unwrap() + 2..]
                        .split_whitespace()
                        .next()
                        != Some("Z")
                })
            }
            #[cfg(not(target_os = "linux"))]
            {
                true
            }
        });
        if !alive {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "shutdown left an owned process alive: {pids:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        state.path().join("clean-shutdown").exists(),
        "confirmed forced exit must write the clean-shutdown marker"
    );
}

#[tokio::test]
async fn an_ordinary_session_confirms_exit_within_the_bound_and_the_marker_is_written() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    #[cfg(unix)]
    let cmd = vec!["sh", "-c", "sleep 30"];
    #[cfg(windows)]
    let cmd = vec![
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Start-Sleep -Seconds 30",
    ];
    let id = create_custom(&d, proj.path(), cmd);

    d.reap_set_exit_hook_for_test(Box::new(|| {}));
    let result = d.manage_shutdown();
    let ok = result.expect("an ordinary session must shut down cleanly");
    assert!(ok.ok);
    assert_eq!(ok.stopped_sessions, 1);
    let _ = id;
    assert!(
        state.path().join("clean-shutdown").exists(),
        "a successful shutdown must write the clean-shutdown marker"
    );
}

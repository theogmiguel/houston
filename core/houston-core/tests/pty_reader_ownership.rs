#![cfg(all(target_os = "linux", feature = "test-barriers"))]
#![allow(clippy::disallowed_methods)]
mod common;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;

static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Home {
    _lock: std::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let lock = ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        Self {
            _lock: lock,
            _dir: dir,
            previous,
        }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        if let Some(home) = &self.previous {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

const DESCENDANT: &str = r#"
import os, signal, time
signal.signal(signal.SIGHUP, signal.SIG_IGN)
with open('root', 'w') as f: f.write(str(os.getpid()))
child = os.fork()
if child == 0:
    with open('descendant', 'w') as f: f.write(str(os.getpid()))
    time.sleep(30)
    os._exit(0)
while not os.path.exists('descendant'): time.sleep(.005)
print('READY', flush=True)
while not os.path.exists('exit-root'): time.sleep(.005)
print('FINAL_BYTES', flush=True)
os._exit(0)
"#;

struct Descendant {
    pid: u32,
    creation: u64,
}
impl Descendant {
    fn capture(dir: &Path) -> Self {
        Self::capture_file(dir, "descendant")
    }
    fn capture_file(dir: &Path, name: &str) -> Self {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
                if let Ok(pid) = text.parse() {
                    return Self {
                        pid,
                        creation: houston_core::pid::process_creation_token(pid).unwrap(),
                    };
                }
            }
            assert!(
                Instant::now() < deadline,
                "descendant identity receipt missing"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn exited(&self) -> bool {
        if houston_core::pid::process_creation_token(self.pid) != Some(self.creation) {
            return true;
        }
        std::fs::read_to_string(format!("/proc/{}/stat", self.pid)).is_ok_and(|stat| {
            stat.rsplit_once(')')
                .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
        })
    }
    fn require_exit(&self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.exited() {
            assert!(
                Instant::now() < deadline,
                "exact descendant {}/{} survived teardown",
                self.pid,
                self.creation
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Descendant {
    fn drop(&mut self) {
        let _ = houston_core::pid::signal_process_checked_identity(
            self.pid,
            houston_core::pid::Signal::Kill,
            Some(self.creation),
        );
    }
}
struct Pane {
    daemon: Arc<Daemon>,
    id: u32,
}
impl Drop for Pane {
    fn drop(&mut self) {
        let _ = self.daemon.close(self.id);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exited_root_close_drains_reader_and_terminates_exact_quiet_descendant() {
    exited_root_cleanup(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exited_root_close_survives_scope_stop_failure() {
    exited_root_cleanup(true, false).await;
}

async fn exited_root_cleanup(fail_scope: bool, respawn: bool) {
    let _home = Home::new();
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut socket = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut socket).await;
    socket
        .send(Message::text(common::create_custom_msg(
            vec!["python3", "-u", "-c", DESCENDANT],
            dir.path(),
        )))
        .await
        .unwrap();
    let id = common::expect_created(&mut socket).await.id;
    let _pane = Pane {
        daemon: daemon.clone(),
        id,
    };
    let descendant = Descendant::capture(dir.path());
    let root = Descendant::capture_file(dir.path(), "root");
    common::attach_and_collect_output_until(&mut socket, id, "READY").await;
    assert!(daemon.pty_reader_active_for_test(id));
    std::fs::write(dir.path().join("exit-root"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while daemon
            .list()
            .into_iter()
            .find(|info| info.id == id)
            .unwrap()
            .state
            != proto::SessionState::Exited
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!descendant.exited());
    assert!(
        daemon.pty_reader_active_for_test(id),
        "quiet descendant retains reader after root exit"
    );
    common::attach_and_collect_output_until(&mut socket, id, "FINAL_BYTES").await;
    let completed = daemon.pty_reader_completion_for_test(id).unwrap();
    struct ScopeReset;
    impl Drop for ScopeReset {
        fn drop(&mut self) {
            houston_core::session_isolation::fail_scope_termination_for_test(false);
        }
    }
    houston_core::session_isolation::fail_scope_termination_for_test(fail_scope);
    let _scope = ScopeReset;
    let replacement_dir = tempfile::tempdir().unwrap();
    let replacement = if respawn {
        Some(
            daemon
                .respawn(id, false, Some(replacement_dir.path().into()), None, false)
                .unwrap(),
        )
    } else {
        daemon.close(id).unwrap();
        None
    };
    let _replacement = replacement.as_ref().map(|info| Pane {
        daemon: daemon.clone(),
        id: info.id,
    });
    let _replacement_child = replacement
        .as_ref()
        .map(|_| Descendant::capture(replacement_dir.path()));
    assert!(completed(), "cleanup owns reader completion before removal");
    assert_ne!(
        houston_core::pid::process_creation_token(root.pid),
        Some(root.creation),
        "old root reaped before removal"
    );
    assert!(!daemon.list().iter().any(|info| info.id == id));
    descendant.require_exit();
}

#[test]
fn startup_rollback_terminates_descendant_before_reaping_owned_root() {
    let _home = Home::new();
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: common::TOKEN.into(),
        db_path: dir.path().join("test.db"),
    })
    .unwrap();
    let identities = Arc::new(std::sync::Mutex::new(None));
    let observed = identities.clone();
    let project = dir.path().to_path_buf();
    daemon.set_startup_test(
        Some("after-spawn"),
        Box::new(move |_, root| {
            let child = Descendant::capture(&project);
            assert!(houston_core::pid::process_creation_token(root).is_some());
            *observed.lock().unwrap() = Some((root, child));
        }),
    );
    let result = daemon.create_session(CreateParams {
        agent: proto::AgentKind::Codex,
        project_dir: dir.path().into(),
        cmd: Some(vec![
            "python3".into(),
            "-u".into(),
            "-c".into(),
            DESCENDANT.into(),
        ]),
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
    });
    assert!(result.is_err());
    let (root, child) = identities.lock().unwrap().take().unwrap();
    assert!(
        !Path::new(&format!("/proc/{root}")).exists(),
        "root is reaped"
    );
    child.require_exit();
    assert!(daemon.list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exited_respawn_cleans_quiet_descendant_before_replacing_registered_ownership() {
    exited_root_cleanup(false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_wake_cleans_quiet_descendant_before_restoring_sleeping_placeholder() {
    let _home = Home::new();
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut socket = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut socket).await;
    let script = DESCENDANT.strip_suffix("os._exit(0)\n").unwrap().to_owned() + "os._exit(1)\n";
    socket
        .send(Message::text(common::create_custom_msg(
            vec!["python3", "-u", "-c", &script],
            dir.path(),
        )))
        .await
        .unwrap();
    let id = common::expect_created(&mut socket).await.id;
    let _pane = Pane {
        daemon: daemon.clone(),
        id,
    };
    let descendant = Descendant::capture(dir.path());
    let root = Descendant::capture_file(dir.path(), "root");
    common::attach_and_collect_output_until(&mut socket, id, "READY").await;
    let completed = daemon.pty_reader_completion_for_test(id).unwrap();
    // Install the same launch receipt Wake records, without invoking an agent provider.
    daemon.mark_wake_launch_for_test(id);
    std::fs::write(dir.path().join("exit-root"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while daemon
            .list()
            .iter()
            .find(|info| info.id == id)
            .unwrap()
            .state
            != proto::SessionState::Sleeping
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        completed(),
        "Sleep placeholder cannot discard a live reader"
    );
    assert_ne!(
        houston_core::pid::process_creation_token(root.pid),
        Some(root.creation),
        "failed Wake root reaped before rollback"
    );
    descendant.require_exit();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_close_drains_reader_paused_before_osc7501_reply_admission() {
    query_close(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reader_drain_timeout_preserves_registered_ownership_for_close_retry() {
    query_close(true).await;
}

async fn query_close(force_timeout: bool) {
    let _home = Home::new();
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut socket = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut socket).await;
    let barrier = tempfile::tempdir().unwrap();
    struct BarrierReset(Option<std::ffi::OsString>, std::path::PathBuf);
    impl Drop for BarrierReset {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.1.join("armed"));
            if let Some(previous) = &self.0 {
                std::env::set_var("HOUSTON_TEST_BARRIER_DIR", previous);
            } else {
                std::env::remove_var("HOUSTON_TEST_BARRIER_DIR");
            }
        }
    }
    let _barrier_reset = BarrierReset(
        std::env::var_os("HOUSTON_TEST_BARRIER_DIR"),
        barrier.path().into(),
    );
    std::env::set_var("HOUSTON_TEST_BARRIER_DIR", barrier.path());
    std::fs::write(barrier.path().join("armed"), "terminal-query").unwrap();
    socket.send(Message::text(common::create_custom_msg(
        vec!["python3", "-u", "-c", "import os,time; print('READY',flush=True);\nwhile not os.path.exists('query'): time.sleep(.005)\nprint('\\x1b]7501;?\\x07',flush=True); time.sleep(30)"], dir.path(),
    ))).await.unwrap();
    let id = common::expect_created(&mut socket).await.id;
    let _pane = Pane {
        daemon: daemon.clone(),
        id,
    };
    common::attach_and_collect_output_until(&mut socket, id, "READY").await;
    let completed = daemon.pty_reader_completion_for_test(id).unwrap();
    std::fs::write(dir.path().join("query"), "").unwrap();
    let receipt = format!("terminal-query {id}");
    tokio::time::timeout(Duration::from_secs(15), async {
        while std::fs::read_to_string(barrier.path().join("reached"))
            .ok()
            .as_deref()
            != Some(receipt.as_str())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let closing = daemon.clone();
    let close = tokio::task::spawn_blocking(move || closing.session_close_checked(id, true));
    tokio::time::timeout(Duration::from_secs(15), async {
        while !daemon.pty_cleanup_started_for_test(id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Cancellation is published under the lifecycle lock immediately before its
    // reader-completion wait. Release query admission only after that receipt.
    if force_timeout {
        let error = close.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("cleanup drain limit 1000 ms"));
        assert!(daemon.list().iter().any(|info| info.id == id));
        assert!(
            !completed(),
            "timed-out reader remains owned by the registered pane"
        );
        std::fs::remove_file(barrier.path().join("armed")).unwrap();
        daemon
            .session_close_checked(id, true)
            .expect("Close retry drains the retained ownership");
    } else {
        std::fs::remove_file(barrier.path().join("armed")).unwrap();
        close
            .await
            .unwrap()
            .expect("first Close succeeds without a timeout retry");
    }
    assert!(completed());
    assert!(!daemon.list().iter().any(|info| info.id == id));
}

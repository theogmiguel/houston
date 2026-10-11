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
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.join("descendant")) {
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
    exited_root_close(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exited_root_close_survives_scope_stop_failure() {
    exited_root_close(true).await;
}

async fn exited_root_close(fail_scope: bool) {
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
    daemon.close(id).unwrap();
    assert!(completed(), "close owns reader completion before removal");
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

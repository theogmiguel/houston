#![cfg(all(windows, feature = "test-barriers"))]
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static ENV: Mutex<()> = Mutex::new(());

struct Fixture {
    _state: tempfile::TempDir,
    workspace: tempfile::TempDir,
    barrier: tempfile::TempDir,
    daemon: Arc<Daemon>,
    previous: Option<std::ffi::OsString>,
}

impl Fixture {
    fn new() -> Self {
        let state = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let barrier = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("HOUSTON_TEST_BARRIER_DIR");
        std::env::set_var("HOUSTON_TEST_BARRIER_DIR", barrier.path());
        let daemon = Daemon::new(DaemonConfig::new(
            "windows-lifecycle-fixture".into(),
            state.path().join("fixture.db"),
            crate::common::capture_env(),
        ))
        .unwrap();
        Self {
            _state: state,
            workspace,
            barrier,
            daemon,
            previous,
        }
    }

    fn pane(&self) -> proto::SessionInfo {
        let script = self.workspace.path().join("live.ps1");
        std::fs::write(&script, "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'), 'ready')\nStart-Sleep -Seconds 60\n").unwrap();
        let info = self
            .daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.workspace.path().to_path_buf(),
                cmd: Some(vec![
                    "powershell.exe".into(),
                    "-NoProfile".into(),
                    "-File".into(),
                    script.display().to_string(),
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
            })
            .unwrap();
        self.wait_for(&self.workspace.path().join("ready"));
        info
    }

    fn arm(&self) {
        std::fs::write(self.barrier.path().join("armed"), "pty-reader-eof").unwrap();
    }

    fn reached(&self) {
        self.wait_for(&self.barrier.path().join("reached"));
    }

    fn wait_for(&self, path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "fixture receipt missing: {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn release(&self) {
        let _ = std::fs::remove_file(self.barrier.path().join("armed"));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.release();
        if let Some(previous) = &self.previous {
            std::env::set_var("HOUSTON_TEST_BARRIER_DIR", previous);
        } else {
            std::env::remove_var("HOUSTON_TEST_BARRIER_DIR");
        }
    }
}

#[test]
fn forced_restart_waits_for_the_owned_reader_eof() {
    let _env = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    let old = fixture.pane();
    fixture.arm();
    let daemon = Arc::clone(&fixture.daemon);
    let restart = std::thread::spawn(move || daemon.respawn(old.id, false, None, None, true));
    fixture.reached();
    std::thread::sleep(Duration::from_millis(100));
    let finished_before_eof = restart.is_finished();
    fixture.release();
    let fresh = restart
        .join()
        .unwrap()
        .expect("forced restart drains its owned reader");
    assert!(
        !finished_before_eof,
        "replacement must wait for reader completion"
    );
    assert_ne!(fresh.id, old.id);
    fixture.daemon.close(fresh.id).unwrap();
}

#[test]
fn workspace_removal_waits_for_the_owned_reader_eof() {
    let _env = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    let old = fixture.pane();
    let path = fixture.workspace.path().display().to_string();
    fixture.daemon.workspace_add(&path).unwrap();
    fixture.arm();
    let daemon = Arc::clone(&fixture.daemon);
    let removal = std::thread::spawn(move || daemon.workspace_remove(&path));
    fixture.reached();
    std::thread::sleep(Duration::from_millis(100));
    let finished_before_eof = removal.is_finished();
    fixture.release();
    assert!(removal.join().unwrap().unwrap().is_empty());
    assert!(
        !finished_before_eof,
        "workspace removal must wait for reader completion"
    );
    assert!(!fixture
        .daemon
        .list()
        .iter()
        .any(|session| session.id == old.id));
}

#[test]
fn missing_reader_eof_keeps_the_session_owned_and_refuses_cleanup() {
    let _env = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    let pane = fixture.pane();
    fixture.arm();
    fixture.daemon.kill(pane.id).unwrap();
    fixture.reached();
    let refusal = fixture.daemon.close(pane.id).unwrap_err().to_string();
    assert!(refusal.contains("PTY EOF"), "{refusal}");
    assert!(fixture
        .daemon
        .list()
        .iter()
        .any(|session| session.id == pane.id));
    fixture.release();
    fixture.daemon.close(pane.id).unwrap();
}

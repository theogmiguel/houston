#![cfg(target_os = "linux")]
#![allow(clippy::disallowed_methods)]

use futures_util::SinkExt;
use houston_core::{
    adoption,
    daemon::{Daemon, DaemonConfig},
    server,
};
use houston_protocol as proto;
use std::{
    io::Read,
    os::fd::{FromRawFd, OwnedFd},
    sync::Arc,
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;
#[path = "common/mod.rs"]
mod common;

static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct TestHome {
    _lock: std::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let lock = TEST_ENV.lock().unwrap_or_else(|error| error.into_inner());
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
impl Drop for TestHome {
    fn drop(&mut self) {
        if let Some(home) = &self.previous {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
struct Cleanup {
    daemon: Arc<Daemon>,
    ids: Vec<u32>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        for id in &self.ids {
            let _ = self.daemon.close(*id);
        }
    }
}
struct Fixture {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: u32,
    creation: Option<u64>,
}
impl Fixture {
    fn kill(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            houston_core::pid::signal_process_checked_identity(
                self.pid,
                houston_core::pid::Signal::Kill,
                self.creation,
            )
            .unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.kill();
        let _ = self.child.wait();
    }
}
async fn wall_timeout<F: std::future::Future>(
    budget: Duration,
    future: F,
) -> Result<F::Output, ()> {
    let (expired_tx, expired_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let watchdog = std::thread::Builder::new()
        .name("pty-audit-clock".into())
        .spawn(move || {
            if done_rx.recv_timeout(budget).is_err() {
                let _ = expired_tx.send(());
            }
        })
        .unwrap();
    let result = tokio::select! { result = future => Ok(result), _ = expired_rx => Err(()) };
    let _ = done_tx.send(());
    watchdog.join().unwrap();
    result
}

async fn wait_writer(active: &(dyn Fn() -> bool + Send + Sync)) {
    wall_timeout(Duration::from_secs(15), async {
        while !active() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stdin admission receipt");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn adopted_fallback_kill_survives_blocked_stdin() {
    adopted_blocked_writer(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn adopted_without_scope_kill_survives_blocked_stdin() {
    adopted_blocked_writer(false).await;
}

async fn adopted_blocked_writer(fail_scope: bool) {
    let _home = TestHome::new();
    let dir = tempfile::tempdir().unwrap();
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = portable_pty::CommandBuilder::new("sh");
    cmd.args(["-c", "stty raw -echo; printf READY; exec sleep 60"]);
    let child = pair.slave.spawn_command(cmd).unwrap();
    let pid = child.process_id().unwrap();
    let mut fixture = Fixture {
        child,
        pid,
        creation: houston_core::pid::process_creation_token(pid),
    };
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut ready = [0; 5];
    reader.read_exact(&mut ready).unwrap();
    assert_eq!(&ready, b"READY");
    // A direct PTY fixture cannot join a Houston-owned scope; prove the fallback discriminator.
    assert!(!houston_core::session_isolation::terminate_owned_scope(
        pid,
        130,
        None,
        houston_core::pid::process_creation_token(pid)
    )
    .unwrap());
    let fd = unsafe { libc::dup(pair.master.as_raw_fd().unwrap()) };
    assert!(fd >= 0);
    let manifest: adoption::SessionManifest = serde_json::from_value(serde_json::json!({
        "session_id":130,"pid":pid,"cols":80,"rows":24,"output_offset":5,"state":"running","status":null,
        "hidden":false,"project_dir":dir.path(),"cwd":dir.path(),"title":"unread","codename":"unread","tags":[],"agent":"custom",
        "swarm_agent":null,"hook_cwd":null,"mcp_cred":null,"vt_snapshot":"","vt_format_version":0
    })).unwrap();
    // Adoption transfers a live session whose retiring daemon already persisted its row.
    let db = houston_core::db::Db::open(&dir.path().join("test.db")).unwrap();
    let info: proto::SessionInfo = serde_json::from_value(serde_json::json!({
        "id":130,"agent":"custom","project_dir":dir.path(),"cwd":dir.path(),"state":"running","title":"unread"
    })).unwrap();
    db.insert_session(&info).unwrap();
    drop(db);
    let adopted =
        Daemon::session_from_manifest(&manifest, unsafe { OwnedFd::from_raw_fd(fd) }).unwrap();
    drop(pair.master);
    drop(reader);
    let daemon = Daemon::new_adopting(
        DaemonConfig {
            token: common::TOKEN.into(),
            db_path: dir.path().join("test.db"),
        },
        0,
        vec![adopted],
    )
    .unwrap();
    let cleanup = Cleanup {
        daemon: daemon.clone(),
        ids: vec![130],
    };
    let (addr, _) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut ws).await;
    let unblock = daemon.stdin_cleanup_for_test(130).unwrap();
    let active = daemon.stdin_writer_receipt_for_test(130).unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(130, &vec![b'x'; 1024 * 1024]).into(),
    ))
    .await
    .unwrap();
    wait_writer(active.as_ref()).await;
    eprintln!("receipt: adopted backend writer active; scope failure mode {fail_scope}");
    houston_core::session_isolation::fail_scope_termination_for_test(fail_scope);
    let killer = daemon.clone();
    let (killed_tx, killed_rx) = std::sync::mpsc::channel();
    let killing = std::thread::spawn(move || {
        let _ = killed_tx.send(killer.kill(130));
    });
    let result = killed_rx.recv_timeout(Duration::from_secs(15));
    houston_core::session_isolation::fail_scope_termination_for_test(false);
    if result.is_err() {
        eprintln!("receipt: adopted kill exceeded 15s; rescuing exact fixture and reserved writer");
        fixture.kill();
        unblock();
    }
    killing.join().unwrap();
    assert!(
        result.is_ok(),
        "adopted fallback kill must not wait on the blocked writer mutex"
    );
    result.unwrap().unwrap();
    fixture.child.wait().unwrap();
    let closer = daemon.clone();
    wall_timeout(
        Duration::from_secs(15),
        tokio::task::spawn_blocking(move || closer.close(130)),
    )
    .await
    .expect("another lifecycle operation must complete after adopted kill")
    .unwrap()
    .unwrap();
    assert!(!houston_core::pid::process_is_alive(pid));
    drop(cleanup);
}

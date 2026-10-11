#![cfg(target_os = "linux")]
#![allow(clippy::disallowed_methods)]

use futures_util::{SinkExt, StreamExt};
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
async fn control(ws: &mut common::WsStream, msg: proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(&msg).unwrap()))
        .await
        .unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_socket_resize_and_sibling_output_survive_blocked_stdin() {
    let _home = TestHome::new();
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut cleanup = Cleanup {
        daemon: daemon.clone(),
        ids: vec![],
    };
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(common::create_custom_msg(
        vec!["sh", "-c", "stty raw -echo; printf READY; exec sleep 60"],
        dir.path(),
    )))
    .await
    .unwrap();
    let blocked = common::expect_created(&mut ws).await.id;
    cleanup.ids.push(blocked);
    common::attach_and_collect_output_until(&mut ws, blocked, "READY").await;
    ws.send(Message::text(common::create_custom_msg(
        vec!["sh", "-c", "cat"],
        dir.path(),
    )))
    .await
    .unwrap();
    let sibling = common::expect_created(&mut ws).await.id;
    cleanup.ids.push(sibling);
    let unblock = daemon.stdin_cleanup_for_test(blocked).unwrap();
    let active = daemon.stdin_writer_receipt_for_test(blocked).unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(blocked, &vec![b'x'; 1024 * 1024]).into(),
    ))
    .await
    .unwrap();
    wait_writer(active.as_ref()).await;
    control(
        &mut ws,
        proto::ClientMsg::SessionResize {
            session: blocked,
            cols: 91,
            rows: 31,
        },
    )
    .await;
    let resize = wall_timeout(Duration::from_secs(15), async {
        loop {
            let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
                continue;
            };
            if let proto::ServerMsg::SessionResized {
                session,
                cols,
                rows,
            } = serde_json::from_str(&text).unwrap()
            {
                if session == blocked {
                    assert_eq!((cols, rows), (91, 31));
                    break;
                }
            }
        }
    })
    .await;
    // Independent cleanup must unblock the original socket on the red implementation.
    if resize.is_err() {
        unblock();
        daemon.kill(blocked).unwrap();
    }
    assert!(
        resize.is_ok(),
        "same /ws socket must receive resize while stdin remains blocked"
    );
    assert!(
        daemon.stdin_write_in_progress_for_test(blocked),
        "resize must precede delivery completion"
    );
    ws.send(Message::Binary(
        proto::encode_stdin_frame(sibling, b"SIBLING\n").into(),
    ))
    .await
    .unwrap();
    common::attach_and_collect_output_until(&mut ws, sibling, "SIBLING").await;
    control(
        &mut ws,
        proto::ClientMsg::SessionKill {
            session: blocked,
            confirm_children: None,
        },
    )
    .await;
    wall_timeout(Duration::from_secs(15), async {
        while daemon.stdin_write_in_progress_for_test(blocked) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("same-socket kill must cancel admitted delivery");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admitted_input_and_terminal_replies_keep_order_after_disconnect() {
    let _home = TestHome::new();
    assert!(
        houston_core::vt::available(),
        "this regression requires real libghostty-vt replies"
    );
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut cleanup = Cleanup {
        daemon: daemon.clone(),
        ids: vec![],
    };
    let script = r#"
import os, tty, time
tty.setraw(0)
print('READY', flush=True)
while not os.path.exists('query'): time.sleep(.01)
os.write(1, b'\x1b]7501;?\x07AFTER_QUERY')
while not os.path.exists('consume'): time.sleep(.01)
expected = b'x' * 1048576 + b'FIRST' + b'\x1b]7501;?\x07' + b'SECOND'
data = b''
while len(data) < len(expected): data += os.read(0, len(expected) - len(data))
print('ORDERED' if data == expected else 'BAD_ORDER', flush=True)
time.sleep(60)"#;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(common::create_custom_msg(
        vec!["python3", "-u", "-c", &script],
        dir.path(),
    )))
    .await
    .unwrap();
    let id = common::expect_created(&mut ws).await.id;
    cleanup.ids.push(id);
    common::attach_and_collect_output_until(&mut ws, id, "READY").await;
    let active = daemon.stdin_writer_receipt_for_test(id).unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, &vec![b'x'; 1024 * 1024]).into(),
    ))
    .await
    .unwrap();
    wait_writer(active.as_ref()).await;
    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, b"FIRST").into(),
    ))
    .await
    .unwrap();
    control(&mut ws, proto::ClientMsg::SessionList).await;
    loop {
        if matches!(
            common::next_control(&mut ws).await,
            proto::ServerMsg::SessionList { .. }
        ) {
            break;
        }
    }
    std::fs::write(dir.path().join("query"), "").unwrap();
    common::collect_output_until(&mut ws, id, "AFTER_QUERY").await;
    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, b"SECOND").into(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, &vec![b'x'; 5 * 1024 * 1024]).into(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Error { message, context } = common::next_control(&mut ws).await {
            assert_eq!(context.as_deref(), Some("stdin"));
            assert!(message.contains("byte limit 4194304"), "{message}");
            assert!(message.contains("requested 5242880"), "{message}");
            break;
        }
    }
    assert!(daemon.stdin_write_in_progress_for_test(id));
    ws.close(None).await.unwrap();
    drop(ws);
    std::fs::write(dir.path().join("consume"), "").unwrap();
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut ws).await;
    common::attach_and_collect_output_until(&mut ws, id, "ORDERED").await;
    wall_timeout(Duration::from_secs(15), async {
        while daemon.stdin_write_in_progress_for_test(id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("all admitted input outcomes must finish");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdin_job_limit_refuses_admission_and_reports_every_cancelled_job() {
    let _home = TestHome::new();
    let (addr, dir, daemon) = common::start_daemon_without_mail_loop().await;
    let mut cleanup = Cleanup {
        daemon: daemon.clone(),
        ids: vec![],
    };
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(common::create_custom_msg(
        vec!["sh", "-c", "stty raw -echo; printf READY; exec sleep 60"],
        dir.path(),
    )))
    .await
    .unwrap();
    let id = common::expect_created(&mut ws).await.id;
    cleanup.ids.push(id);
    common::attach_and_collect_output_until(&mut ws, id, "READY").await;
    let active = daemon.stdin_writer_receipt_for_test(id).unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, &vec![b'x'; 1024 * 1024]).into(),
    ))
    .await
    .unwrap();
    wait_writer(active.as_ref()).await;
    for _ in 0..128 {
        ws.send(Message::Binary(proto::encode_stdin_frame(id, b"j").into()))
            .await
            .unwrap();
    }
    loop {
        if let proto::ServerMsg::Error { message, .. } = common::next_control(&mut ws).await {
            assert!(
                message.contains("job limit 128, actual 128, requested 1"),
                "{message}"
            );
            assert!(message.contains("nothing was written"), "{message}");
            break;
        }
    }
    let refused = daemon.write_stdin_counting(id, b"direct").unwrap_err();
    assert!(refused.nothing_written());
    assert!(refused
        .to_string()
        .contains("job limit 128, actual 128, requested 1"));
    control(
        &mut ws,
        proto::ClientMsg::SessionKill {
            session: id,
            confirm_children: None,
        },
    )
    .await;
    let mut cancellations = 0;
    let mut partial = false;
    wall_timeout(Duration::from_secs(15), async {
        while cancellations < 128 {
            let Some(Ok(Message::Text(text))) = ws.next().await else {
                continue;
            };
            if let proto::ServerMsg::Error { message, context } =
                serde_json::from_str(&text).unwrap()
            {
                assert_eq!(context.as_deref(), Some("stdin"));
                assert!(message.contains("stdin delivery failed"), "{message}");
                assert!(!message.contains("cannot say how much"), "{message}");
                partial |= message.contains("byte(s) had already been written");
                cancellations += 1;
            }
        }
    })
    .await
    .expect("every accepted job must receive an explicit cancellation result");
    assert!(
        partial,
        "the active delivery must report the bytes accepted before cancellation"
    );
    wall_timeout(Duration::from_secs(15), async {
        while daemon.stdin_write_in_progress_for_test(id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("all admitted input outcomes must finish");
}

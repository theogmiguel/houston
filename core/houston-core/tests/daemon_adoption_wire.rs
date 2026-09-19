#![allow(clippy::disallowed_methods)]
#![cfg(unix)]

use futures_util::SinkExt;
use houston_protocol as proto;
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

#[path = "common/mod.rs"]
mod common;
use common::{collect_output_until, connect_and_hello, create_custom_msg, expect_created};

fn core_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

fn supervisor_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-supervisor")
}

const POLL_TIMEOUT: Duration = Duration::from_secs(15);

fn poll_until<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(start.elapsed() < timeout, "timed out waiting for condition");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(serde::Deserialize, Clone, Debug)]
struct DaemonFile {
    port: u16,
    token: String,
    pid: u32,
    #[serde(default)]
    generation: Option<u64>,
    #[serde(default)]
    pid_creation: Option<u64>,
}

fn read_daemon_json(path: &std::path::Path) -> Option<DaemonFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

struct SupervisorGuard(std::process::Child);
impl Drop for SupervisorGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct ChannelGuard(std::path::PathBuf);
impl Drop for ChannelGuard {
    fn drop(&mut self) {
        use houston_core::pid::{process_is_alive, signal_process_checked_identity, Signal};
        let Some(daemon) = read_daemon_json(&self.0.join("daemon.json")) else {
            return;
        };
        let (pid, pid_creation) = (daemon.pid, daemon.pid_creation);
        let _ = signal_process_checked_identity(pid, Signal::Term, pid_creation);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if process_is_alive(pid) {
            let _ = signal_process_checked_identity(pid, Signal::Kill, pid_creation);
        }
    }
}

fn spawn_supervised_daemon(
    home: &std::path::Path,
    channel_dir: &std::path::Path,
) -> SupervisorGuard {
    let mut cmd = common::hermetic_command(supervisor_bin(), home);
    cmd.env("HOUSTON_CHANNEL", "dev")
        .arg("--channel-dir")
        .arg(channel_dir)
        .arg("--daemon")
        .arg(core_bin())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    SupervisorGuard(cmd.spawn().expect("spawn houston-supervisor"))
}

async fn daemon_handoff(port: u16, token: &str) -> proto::ManageDaemonHandoffResult {
    daemon_handoff_to(port, token, None).await
}

async fn daemon_handoff_to(
    port: u16,
    token: &str,
    candidate_bin: Option<&str>,
) -> proto::ManageDaemonHandoffResult {
    let client = reqwest::Client::new();
    let req = proto::ManageRequest {
        manage_version: proto::MANAGE_VERSION,
        verb: proto::ManageVerb::DaemonHandoff,
        candidate_bin: candidate_bin.map(str::to_string),
    };
    client
        .post(format!("http://127.0.0.1:{port}/manage"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&req)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .expect("POST /manage daemon_handoff")
        .json()
        .await
        .expect("parsing daemon_handoff response")
}

#[tokio::test]
async fn handoff_transfers_a_live_session_to_a_new_generation() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);

    let cfg_path = channel_dir.join("daemon.json");
    let before = poll_until(POLL_TIMEOUT, || read_daemon_json(&cfg_path));
    assert_eq!(
        before.generation, None,
        "a first-boot daemon.json must carry no generation"
    );

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", before.port).parse().unwrap();
    let mut ws = connect_and_hello(addr, &before.token).await;
    let _ = common::next_control(&mut ws).await;

    let project = tempfile::tempdir().unwrap();
    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "cat"],
        project.path(),
    )))
    .await
    .unwrap();
    let session_id = expect_created(&mut ws).await.id;

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"before-handoff\n").into(),
    ))
    .await
    .unwrap();
    let seen = collect_output_until(&mut ws, session_id, "before-handoff").await;
    assert!(seen.contains("before-handoff"));
    drop(ws);

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(
        result.accepted,
        "handoff must be accepted against a supervised, SSH-free daemon: {result:?}"
    );
    assert_eq!(result.sessions_transferred, Some(1));
    let expected_generation = result
        .generation
        .expect("accepted handoff names a generation");

    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(expected_generation)).then_some(f)
    });
    assert_eq!(after.port, before.port, "handoff must preserve the port");
    assert_ne!(
        after.pid, before.pid,
        "the new generation must be a different process"
    );
    assert!(
        !channel_dir.join("clean-shutdown").exists(),
        "a handoff is not a shutdown: the retiring generation must leave no clean marker"
    );

    let mut ws2 = connect_and_hello(addr, &after.token).await;
    let hello_ok = common::next_control(&mut ws2).await;
    match hello_ok {
        proto::ServerMsg::HelloOk { sessions, .. } => {
            assert!(
                sessions.iter().any(|s| s.id == session_id),
                "reconnect after handoff must still list session {session_id}: {sessions:?}"
            );
        }
        other => panic!("expected HelloOk, got {other:?}"),
    }
    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    ws2.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"after-handoff\n").into(),
    ))
    .await
    .unwrap();
    let seen_after = collect_output_until(&mut ws2, session_id, "after-handoff").await;
    assert!(
        seen_after.contains("after-handoff"),
        "the session must keep echoing after the handoff: {seen_after:?}"
    );

    let client = reqwest::Client::new();
    let _ = client
        .post(format!("http://127.0.0.1:{}/manage", after.port))
        .header("Authorization", format!("Bearer {}", after.token))
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonShutdown,
            candidate_bin: None,
        })
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn handoff_is_refused_without_a_supervisor() {
    let home = tempfile::tempdir().unwrap();
    let _channel_guard = ChannelGuard(home.path().join(".houston-dev"));
    let mut cmd = common::hermetic_command(core_bin(), home.path());
    cmd.env("HOUSTON_CHANNEL", "dev")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn houston-core");

    let cfg_path = home.path().join(".houston-dev").join("daemon.json");
    let cfg = poll_until(POLL_TIMEOUT, || read_daemon_json(&cfg_path));

    let result = daemon_handoff(cfg.port, &cfg.token).await;
    assert!(
        !result.accepted,
        "a daemon with no supervisor must refuse a handoff, not attempt one"
    );
    assert!(
        result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("supervisor"),
        "the refusal must name the missing supervisor: {result:?}"
    );

    houston_core::pid::signal_process(child.id(), houston_core::pid::Signal::Term)
        .expect("signalling the spawned daemon");
    let _ = child.wait();
}

use houston_core::adoption::{self, FromNew, FromOld};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};

fn spawn_candidate(home: &std::path::Path, sock: &std::path::Path) -> std::process::Child {
    common::hermetic_command(core_bin(), home)
        .env("HOUSTON_CHANNEL", "dev")
        .arg("--adopt")
        .arg(sock)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the adoption candidate")
}

fn fake_old_daemon(home: &std::path::Path) -> (std::path::PathBuf, UnixListener) {
    let channel_dir = home.join(".houston-dev");
    std::fs::create_dir_all(&channel_dir).expect("create the channel dir");
    let sock = channel_dir.join("adopt-fake.sock");
    let listener = UnixListener::bind(&sock).expect("bind the adoption socket");
    (sock, listener)
}

fn read_hello(sock: &mut UnixStream) -> adoption::AdoptionHello {
    sock.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    match adoption::read_frame::<_, FromNew>(sock).expect("reading the candidate's hello") {
        FromNew::Hello(h) => h,
        other => panic!("the candidate's first message must be a hello, got {other:?}"),
    }
}

#[tokio::test]
async fn a_refused_candidate_exits_without_touching_the_channel() {
    let home = tempfile::tempdir().unwrap();
    let (sock_path, listener) = fake_old_daemon(home.path());
    let child = spawn_candidate(home.path(), &sock_path);

    let (mut sock, _) = listener.accept().expect("candidate connects");
    let hello = read_hello(&mut sock);
    assert_eq!(
        hello.manifest_version,
        adoption::MANIFEST_VERSION,
        "a candidate names the manifest version it speaks"
    );
    assert_eq!(hello.platform, "linux");

    let reason = format!(
        "manifest version mismatch: this daemon speaks {}, candidate speaks 99",
        adoption::MANIFEST_VERSION
    );
    adoption::write_frame(
        &mut sock,
        &FromOld::Refuse {
            reason: reason.clone(),
        },
    )
    .expect("sending the refusal");

    let out = child.wait_with_output().expect("candidate exits");
    assert!(
        !out.status.success(),
        "a refused candidate must exit non-zero, got {:?}",
        out.status
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains(&reason),
        "the candidate must print the refusal verbatim: {stderr}"
    );
    assert!(
        !home
            .path()
            .join(".houston-dev")
            .join("daemon.json")
            .exists(),
        "a refused candidate must not write a discovery file"
    );
    assert!(
        !home.path().join(".houston-dev").join("houston.db").exists(),
        "a refused candidate must not open the DB"
    );
}

#[tokio::test]
async fn a_truncated_manifest_frame_stops_the_candidate() {
    use std::io::Write;

    let home = tempfile::tempdir().unwrap();
    let (sock_path, listener) = fake_old_daemon(home.path());
    let child = spawn_candidate(home.path(), &sock_path);

    let (mut sock, _) = listener.accept().expect("candidate connects");
    let _ = read_hello(&mut sock);
    sock.write_all(&4096u32.to_le_bytes()).unwrap();
    sock.write_all(b"{\"Manifest\":{\"version\":1,").unwrap();
    sock.flush().unwrap();
    drop(sock);

    let out = child.wait_with_output().expect("candidate exits");
    assert!(
        !out.status.success(),
        "a truncated manifest must stop the candidate, got {:?}",
        out.status
    );
    assert!(
        !home
            .path()
            .join(".houston-dev")
            .join("daemon.json")
            .exists(),
        "a candidate that never got a whole manifest must not write a discovery file"
    );
}

#[tokio::test]
async fn a_lost_commit_ack_still_leaves_the_commit_record_on_disk() {
    let home = tempfile::tempdir().unwrap();
    let _channel_guard = ChannelGuard(home.path().join(".houston-dev"));
    let (sock_path, listener) = fake_old_daemon(home.path());
    let mut child = spawn_candidate(home.path(), &sock_path);

    let (mut sock, _) = listener.accept().expect("candidate connects");
    let _ = read_hello(&mut sock);

    let manifest = adoption::Manifest {
        version: adoption::MANIFEST_VERSION,
        generation: 7,
        token: "commit-record-token".to_string(),
        sessions: Vec::new(),
    };
    adoption::write_frame(&mut sock, &FromOld::Manifest(manifest)).expect("sending the manifest");

    let transferred =
        std::net::TcpListener::bind("127.0.0.1:0").expect("bind a listener to hand over");
    let port = transferred.local_addr().unwrap().port();
    let lock_file = std::fs::File::create(home.path().join(".houston-dev").join("daemon.lock"))
        .expect("create a lock file to hand over");
    adoption::send_fds(
        sock.as_raw_fd(),
        &[transferred.as_raw_fd(), lock_file.as_raw_fd()],
    )
    .expect("transferring descriptors");

    match adoption::read_frame::<_, FromNew>(&mut sock).expect("reading prepared") {
        FromNew::Prepared => {}
        other => panic!("expected Prepared, got {other:?}"),
    }
    adoption::write_frame(&mut sock, &FromOld::Commit { generation: 7 }).expect("sending commit");
    drop(sock);

    let cfg_path = home.path().join(".houston-dev").join("daemon.json");
    let cfg = poll_until(POLL_TIMEOUT, || {
        read_daemon_json(&cfg_path).filter(|f| f.generation == Some(7))
    });
    assert_eq!(
        cfg.port, port,
        "the committed record names the transferred port"
    );
    assert_eq!(cfg.token, "commit-record-token");

    let _ = manage_shutdown(cfg.port, &cfg.token).await;
    let _ = child.wait();
}

async fn manage_shutdown(port: u16, token: &str) -> Result<(), reqwest::Error> {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/manage"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonShutdown,
            candidate_bin: None,
        })
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map(|_| ())
}

async fn supervised_daemon_with_session(
    home: &std::path::Path,
    channel_dir: &std::path::Path,
    project: &std::path::Path,
    cmd: Vec<&str>,
) -> (DaemonFile, u32, common::WsStream) {
    let cfg_path = channel_dir.join("daemon.json");
    let before = poll_until(POLL_TIMEOUT, || read_daemon_json(&cfg_path));
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", before.port).parse().unwrap();
    let mut ws = connect_and_hello(addr, &before.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(create_custom_msg(cmd, project)))
        .await
        .unwrap();
    let session_id = expect_created(&mut ws).await.id;
    let _ = home;
    (before, session_id, ws)
}

#[tokio::test]
async fn a_candidate_dying_before_prepare_leaves_the_old_daemon_serving() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let (before, session_id, mut ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"before-fault\n").into(),
    ))
    .await
    .unwrap();
    assert!(collect_output_until(&mut ws, session_id, "before-fault")
        .await
        .contains("before-fault"));

    let db = channel_dir.join("houston.db");
    let restore = std::fs::metadata(&db).unwrap().permissions();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o000)).unwrap();

    let result = daemon_handoff(before.port, &before.token).await;
    std::fs::set_permissions(&db, restore).unwrap();
    assert!(
        !result.accepted,
        "a candidate that cannot prepare must not be committed to: {result:?}"
    );
    assert!(
        result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("prepare"),
        "the refusal must name the failed preparation: {result:?}"
    );

    let after = read_daemon_json(&channel_dir.join("daemon.json")).expect("daemon.json survives");
    assert_eq!(
        after.pid, before.pid,
        "the old generation must still own the channel"
    );
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"after-fault\n").into(),
    ))
    .await
    .unwrap();
    assert!(collect_output_until(&mut ws, session_id, "after-fault")
        .await
        .contains("after-fault"));

    let _ = manage_shutdown(before.port, &before.token).await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn a_second_consecutive_handoff_carries_the_session_again() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;
    drop(ws);

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", before.port).parse().unwrap();
    let mut previous = before.clone();
    for round in 1..=2 {
        let result = daemon_handoff(previous.port, &previous.token).await;
        assert!(
            result.accepted,
            "handoff {round} must be accepted: {result:?}"
        );
        assert_eq!(result.sessions_transferred, Some(1));
        let generation = result
            .generation
            .expect("an accepted handoff names a generation");
        assert_eq!(
            generation,
            round + 1,
            "generations must advance one per handoff"
        );
        let next = poll_until(POLL_TIMEOUT, || {
            let f = read_daemon_json(&cfg_path)?;
            (f.pid != previous.pid && f.generation == Some(generation)).then_some(f)
        });
        assert_eq!(next.port, before.port, "every handoff preserves the port");

        let mut ws = connect_and_hello(addr, &next.token).await;
        let _ = common::next_control(&mut ws).await;
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionAttach {
                session: session_id,
                replay_bytes: None,
                snapshot: None,
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        let needle = format!("round-{round}");
        ws.send(Message::Binary(
            proto::encode_stdin_frame(session_id, format!("{needle}\n").as_bytes()).into(),
        ))
        .await
        .unwrap();
        assert!(collect_output_until(&mut ws, session_id, &needle)
            .await
            .contains(&needle));
        drop(ws);
        previous = next;
    }

    let _ = manage_shutdown(previous.port, &previous.token).await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn a_real_exit_code_reaches_the_new_generation_through_the_supervisor() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "read line; exit 42"],
    )
    .await;
    drop(ws);

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(result.accepted, "{result:?}");
    let generation = result.generation.unwrap();
    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(generation)).then_some(f)
    });

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    let mut ws = connect_and_hello(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"go\n").into(),
    ))
    .await
    .unwrap();

    let exit_code = wait_for_exit(&mut ws, session_id).await;
    assert_eq!(
        exit_code,
        Some(42),
        "the real exit code must survive the generation that spawned the child"
    );

    let _ = manage_shutdown(after.port, &after.token).await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn a_signalled_session_finishes_through_the_supervisor_with_no_exit_code() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "read line; kill -9 $$"],
    )
    .await;
    drop(ws);

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(result.accepted, "{result:?}");
    let generation = result.generation.unwrap();
    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(generation)).then_some(f)
    });

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    let mut ws = connect_and_hello(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"go\n").into(),
    ))
    .await
    .unwrap();

    assert_eq!(wait_for_exit(&mut ws, session_id).await, None);

    let _ = manage_shutdown(after.port, &after.token).await;
    let _ = guard.0.wait();
}

async fn wait_for_exit(ws: &mut common::WsStream, session: u32) -> Option<i32> {
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::SessionState {
                session: s,
                state,
                exit_code,
            } if s == session
                && matches!(
                    state,
                    proto::SessionState::Exited | proto::SessionState::Killed
                ) =>
            {
                return exit_code
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn queued_hooks_cross_the_boundary_exactly_once_and_in_order() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;
    drop(ws);

    let drop_dir = channel_dir.join("hooks").join("drop");
    std::fs::create_dir_all(&drop_dir).unwrap();
    let now = houston_core::hook_drop::now_ms();
    for (seq, event) in [(1u32, "UserPromptSubmit"), (2, "Stop")] {
        let body = serde_json::json!({
            "v": 1, "event": event, "session": session_id, "agent": "claude"
        });
        let name = houston_core::hook_drop::drop_filename(now, seq, session_id);
        std::fs::write(drop_dir.join(name), serde_json::to_vec(&body).unwrap()).unwrap();
    }

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(result.accepted, "{result:?}");
    let generation = result.generation.unwrap();
    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(generation)).then_some(f)
    });

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    poll_until(POLL_TIMEOUT, || {
        (std::fs::read_dir(&drop_dir).ok()?.count() == 0).then_some(())
    });

    let mut ws = connect_and_hello(addr, &after.token).await;
    let listed = match common::next_control(&mut ws).await {
        proto::ServerMsg::HelloOk { sessions, .. } => sessions,
        other => panic!("expected HelloOk, got {other:?}"),
    };
    let session = listed
        .iter()
        .find(|s| s.id == session_id)
        .expect("the session survives the handoff");
    assert_eq!(
        session.status,
        Some(proto::AgentStatus::Idle),
        "a turn start followed by its turn end must land on Idle: {session:?}"
    );

    let _ = manage_shutdown(after.port, &after.token).await;
    let _ = guard.0.wait();
}

async fn snapshot_state(ws: &mut common::WsStream, session_id: u32) -> Vec<u8> {
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: Some(true),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::AttachSnapshot { session, state, .. } if session == session_id => {
                use base64::Engine as _;
                return base64::engine::general_purpose::STANDARD
                    .decode(state)
                    .expect("attach_snapshot state is base64");
            }
            proto::ServerMsg::Scrollback { session, .. } if session == session_id => {
                panic!("a snapshot attach for session {session_id} was answered with a byte replay")
            }
            _ => {}
        }
    }
}

const SPLIT_ESCAPE_FIXTURE: &str = "printf 'CUTPOINT\\n'
printf '\\033[1'
head -n 1 >/dev/null
printf ';32mSPLITOK\\n'
sleep 30
";

#[tokio::test]
async fn an_escape_sequence_split_across_the_handoff_continues_on_the_new_generation() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let project = tempfile::tempdir().unwrap();
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let (before, session_id, mut ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", SPLIT_ESCAPE_FIXTURE],
    )
    .await;
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", before.port).parse().unwrap();

    let seen = collect_output_until(&mut ws, session_id, "CUTPOINT").await;
    assert!(seen.contains("CUTPOINT"));

    let mut pending_seen = false;
    for _ in 0..50 {
        if snapshot_state(&mut ws, session_id)
            .await
            .windows(4)
            .any(|w| w == b"PEND")
        {
            pending_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        pending_seen,
        "the retiring daemon must hold the half-seen CSI in its snapshot before the handoff"
    );
    drop(ws);

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(result.accepted, "handoff must be accepted: {result:?}");
    let expected_generation = result
        .generation
        .expect("accepted handoff names a generation");
    let cfg_path = channel_dir.join("daemon.json");
    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(expected_generation)).then_some(f)
    });

    let mut ws2 = connect_and_hello(addr, &after.token).await;
    match common::next_control(&mut ws2).await {
        proto::ServerMsg::HelloOk {
            snapshot_attach, ..
        } => assert!(
            snapshot_attach,
            "a Linux daemon built with libghostty-vt must advertise snapshot attach"
        ),
        other => panic!("expected HelloOk, got {other:?}"),
    }

    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    ws2.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"\n").into(),
    ))
    .await
    .unwrap();
    let _ = collect_output_until(&mut ws2, session_id, "SPLITOK").await;

    let state = snapshot_state(&mut ws2, session_id).await;
    let mut emulator = houston_core::vt::Emulator::new(80, 24, houston_core::vt::VT_HISTORY_BYTES)
        .expect("emulator");
    emulator
        .import(&state)
        .expect("import the daemon's snapshot");
    let screen = emulator.screen_text(40).join("\n");
    assert!(
        screen.contains("SPLITOK"),
        "the completed sequence's text must be on screen: {screen:?}"
    );
    assert!(
        !screen.contains(";32m"),
        "the split CSI must have been CONSUMED across the boundary, not printed as text: \
         {screen:?}"
    );

    let _ = manage_shutdown(after.port, &after.token).await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn handoff_spawns_the_candidate_binary_the_caller_named() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;
    drop(ws);

    // A stand-in for the freshly installed sidecar: the real daemon binary at a
    // path nothing is running from, so `/proc/<pid>/exe` proves which binary
    // the supervisor spawned. `current_exe` would never be this path.
    let candidate_dir = tempfile::tempdir().unwrap();
    let candidate = candidate_dir.path().join("houston-core-candidate");
    std::fs::copy(core_bin(), &candidate).expect("copying the daemon binary");
    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o755)).unwrap();

    let candidate_arg = candidate.to_string_lossy().into_owned();
    let result = daemon_handoff_to(before.port, &before.token, Some(&candidate_arg)).await;
    assert!(
        result.accepted,
        "a handoff naming a runnable candidate must be accepted: {result:?}"
    );
    assert_eq!(result.sessions_transferred, Some(1));
    let generation = result
        .generation
        .expect("an accepted handoff names a generation");

    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(generation)).then_some(f)
    });
    let exe = std::fs::read_link(format!("/proc/{}/exe", after.pid)).expect("/proc/<pid>/exe");
    assert_eq!(
        exe, candidate,
        "the successor must be the binary the caller named, not the retiring daemon's own path"
    );

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    let mut ws = connect_and_hello(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"candidate-alive\n").into(),
    ))
    .await
    .unwrap();
    assert!(collect_output_until(&mut ws, session_id, "candidate-alive")
        .await
        .contains("candidate-alive"));

    let _ = manage_shutdown(after.port, &after.token).await;
    let _ = guard.0.wait();
}

#[tokio::test]
async fn handoff_refuses_an_unusable_candidate_without_parks_or_kills() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, mut ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;

    // A directory is not a runnable daemon; the refusal must land before any
    // session is parked, because the candidate is validated first.
    let candidate_dir = tempfile::tempdir().unwrap();
    let candidate_arg = candidate_dir.path().to_string_lossy().into_owned();
    let result = daemon_handoff_to(before.port, &before.token, Some(&candidate_arg)).await;
    assert!(
        !result.accepted,
        "a directory candidate must be refused: {result:?}"
    );
    let reason = result.reason.unwrap_or_default();
    assert!(
        reason.contains(&candidate_arg),
        "the refusal must name the candidate path: {reason}"
    );
    assert!(
        reason.contains("not a regular file"),
        "the refusal must name the shape it expected: {reason}"
    );

    let after = read_daemon_json(&cfg_path).expect("daemon.json survives");
    assert_eq!(
        after.pid, before.pid,
        "the old generation must still own the channel"
    );
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"after-refusal\n").into(),
    ))
    .await
    .unwrap();
    assert!(collect_output_until(&mut ws, session_id, "after-refusal")
        .await
        .contains("after-refusal"));

    let _ = manage_shutdown(before.port, &before.token).await;
    let _ = guard.0.wait();
}

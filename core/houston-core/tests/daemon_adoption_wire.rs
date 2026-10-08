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
use common::{
    attach_and_collect_output_until, collect_output_until, create_custom_msg, expect_created,
};

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

async fn connect_when_ready(addr: std::net::SocketAddr, token: &str) -> common::WsStream {
    let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
    let hello = serde_json::to_string(&proto::ClientMsg::Hello {
        token: token.to_string(),
        protocol: proto::PROTOCOL_VERSION,
    })
    .unwrap();
    loop {
        let error = match tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await {
            Ok((mut ws, _)) => match ws.send(Message::text(&hello)).await {
                Ok(()) => return ws,
                Err(error) => error.to_string(),
            },
            Err(error) => error.to_string(),
        };
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for the daemon WebSocket at {addr}: {error}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
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
        expected_sessions: None,
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
    let mut ws = connect_when_ready(addr, &before.token).await;
    let _ = common::next_control(&mut ws).await;

    let project = tempfile::tempdir().unwrap();
    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "cat"],
        project.path(),
    )))
    .await
    .unwrap();
    let origin = expect_created(&mut ws).await.id;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionRespawn {
            session: origin,
            force: Some(true),
            shell_integration: Some(false),
            cwd: None,
            shell: None,
            fresh: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let replacement = expect_created(&mut ws).await;
    assert_ne!(replacement.id, origin);
    assert_eq!(replacement.session_origin, Some(origin));
    let session_id = replacement.id;

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

    let mut ws2 = connect_when_ready(addr, &after.token).await;
    let hello_ok = common::next_control(&mut ws2).await;
    match hello_ok {
        proto::ServerMsg::HelloOk { sessions, .. } => {
            let adopted = sessions
                .iter()
                .find(|s| s.id == session_id)
                .unwrap_or_else(|| {
                    panic!("reconnect after handoff must list session {session_id}: {sessions:?}")
                });
            assert_eq!(adopted.session_origin, Some(origin));
        }
        other => panic!("expected HelloOk, got {other:?}"),
    }
    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
            from_offset: None,
            generation: None,
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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
    poll_until(POLL_TIMEOUT, || child.try_wait().expect("poll daemon exit"));
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

    manage_shutdown(cfg.port, &cfg.token).await;
    poll_until(POLL_TIMEOUT, || child.try_wait().expect("poll daemon exit"));
}

async fn manage_shutdown(port: u16, token: &str) {
    let response: serde_json::Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/manage"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonShutdown,
            candidate_bin: None,
            expected_sessions: None,
        })
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .expect("POST /manage daemon_shutdown")
        .error_for_status()
        .expect("shutdown HTTP status")
        .json()
        .await
        .expect("shutdown response");
    assert_eq!(response["ok"], true, "shutdown refused: {response}");
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
    let mut ws = connect_when_ready(addr, &before.token).await;
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

    manage_shutdown(before.port, &before.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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

        let mut ws = connect_when_ready(addr, &next.token).await;
        let _ = common::next_control(&mut ws).await;
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionAttach {
                session: session_id,
                replay_bytes: None,
                snapshot: None,
                from_offset: None,
                generation: None,
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

    manage_shutdown(previous.port, &previous.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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
    let mut ws = connect_when_ready(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
            from_offset: None,
            generation: None,
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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
    let mut ws = connect_when_ready(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
            from_offset: None,
            generation: None,
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
}

#[tokio::test]
async fn shutdown_ends_an_adopted_session_that_ignores_sigterm() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    let cfg_path = channel_dir.join("daemon.json");
    // An interactive shell ignores SIGTERM; `read` keeps it a single process.
    let (before, _session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "trap '' TERM; read line"],
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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

    let mut ws = connect_when_ready(addr, &after.token).await;
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
}

async fn snapshot_state(ws: &mut common::WsStream, session_id: u32) -> Vec<u8> {
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: Some(true),
            from_offset: None,
            generation: None,
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

    let seen = attach_and_collect_output_until(&mut ws, session_id, "CUTPOINT").await;
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

    let mut ws2 = connect_when_ready(addr, &after.token).await;
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
            from_offset: None,
            generation: None,
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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
    let mut ws = connect_when_ready(addr, &after.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
            from_offset: None,
            generation: None,
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

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
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

    manage_shutdown(before.port, &before.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
}

#[tokio::test]
async fn failed_candidate_exec_keeps_the_original_generation_and_session() {
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    std::fs::create_dir_all(&channel_dir).unwrap();
    let stderr_path = home.path().join("supervisor.stderr");
    let mut command = common::hermetic_command(supervisor_bin(), home.path());
    command
        .env("HOUSTON_CHANNEL", "dev")
        .arg("--channel-dir")
        .arg(&channel_dir)
        .arg("--daemon")
        .arg(core_bin())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&stderr_path).unwrap());
    let mut guard = SupervisorGuard(command.spawn().expect("spawn supervised test daemon"));
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
    let supervisor_before = std::fs::read_to_string(channel_dir.join("supervisor.json")).unwrap();

    // The executable passes path validation, but exec fails because its
    // interpreter does not exist. This exercises the post-validation race.
    let candidate = home.path().join("unlaunchable-daemon");
    std::fs::write(&candidate, b"#!/nonexistent/daemon-interpreter\n").unwrap();
    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o755)).unwrap();
    let result = daemon_handoff_to(
        before.port,
        &before.token,
        Some(&candidate.to_string_lossy()),
    )
    .await;
    assert!(
        !result.accepted,
        "failed exec must abort adoption: {result:?}"
    );
    assert!(
        result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("candidate did not connect"),
        "{result:?}"
    );
    let stderr = std::fs::read_to_string(&stderr_path).unwrap();
    assert!(
        stderr.contains(&candidate.to_string_lossy().to_string()),
        "{stderr}"
    );
    assert!(
        stderr.contains("failed:") && stderr.contains("retaining generation 1"),
        "{stderr}"
    );
    assert!(
        guard.0.try_wait().unwrap().is_none(),
        "supervisor must survive failed exec"
    );
    let after = read_daemon_json(&cfg_path).expect("original daemon discovery survives");
    assert_eq!(after.pid, before.pid);
    assert_eq!(after.generation, before.generation);
    assert_eq!(
        std::fs::read_to_string(channel_dir.join("supervisor.json")).unwrap(),
        supervisor_before
    );
    let addr = format!("127.0.0.1:{}", before.port).parse().unwrap();
    let mut ws = connect_when_ready(addr, &before.token).await;
    let _ = common::next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: session_id,
            replay_bytes: None,
            snapshot: None,
            from_offset: None,
            generation: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"after-failed-exec\n").into(),
    ))
    .await
    .unwrap();
    assert!(
        collect_output_until(&mut ws, session_id, "after-failed-exec")
            .await
            .contains("after-failed-exec")
    );
    manage_shutdown(before.port, &before.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
}

struct OrchestrationHandoff {
    _channel: ChannelGuard,
    _supervisor: SupervisorGuard,
    _home: tempfile::TempDir,
    before: DaemonFile,
    cfg: std::path::PathBuf,
    parent: u32,
    child: u32,
    log: std::path::PathBuf,
    child_gate: std::path::PathBuf,
    parent_gate: std::path::PathBuf,
}

impl Drop for OrchestrationHandoff {
    fn drop(&mut self) {
        if let Some(name) = self._home.path().file_name() {
            let prefix =
                std::path::Path::new("/tmp").join(format!("l1-{}", name.to_string_lossy()));
            let _ = std::fs::copy(
                &self.log,
                std::path::PathBuf::from(format!("{}.receipts", prefix.display())),
            );
            let _ = std::fs::copy(
                self._home.path().join("daemon-stderr"),
                std::path::PathBuf::from(format!("{}.stderr", prefix.display())),
            );
        }
    }
}

impl OrchestrationHandoff {
    async fn new(
        provider: &str,
        child_steps: serde_json::Value,
        wait_transport: Option<&str>,
    ) -> Self {
        use serde_json::json;
        let home = tempfile::tempdir().unwrap();
        let channel_dir = home.path().join(".houston-dev");
        std::fs::create_dir_all(&channel_dir).unwrap();
        std::os::unix::fs::symlink(&channel_dir, home.path().join(".houston-chaos")).unwrap();
        let db = houston_core::db::Db::open(&channel_dir.join("houston.db")).unwrap();
        db.set_setting(houston_core::orchestrate::ENABLED_KEY, "1")
            .unwrap();
        drop(db);
        let command = common::hermetic_command(supervisor_bin(), home.path());
        drop(command);
        for name in ["claude", "codex", "grok"] {
            let shim = home.path().join("provider-shims").join(name);
            std::fs::remove_file(&shim).unwrap();
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_fake_agent"), shim).unwrap();
        }
        let project = home.path().join("workspace");
        std::fs::create_dir_all(&project).unwrap();
        let log = home.path().join("receipts.jsonl");
        let child_gate = home.path().join("child-ready");
        let parent_gate = home.path().join("parent-ready");
        let fixtures =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hooks");
        let script = |name: &str, seed: u64, provider: &str, steps: serde_json::Value| {
            let path = home.path().join(format!("{name}.json"));
            std::fs::write(&path, json!({"provider":provider,"seed":seed,"home":home.path(),"helper":core_bin(),"fixtures":fixtures,"log":log,"steps":steps}).to_string()).unwrap();
            path
        };
        let mut steps = Vec::new();
        if wait_transport.is_some() {
            steps.push(json!({"op":"call","tool":"pane_submit","args":{"body":"PENDING_RESULT","summary":"PENDING_RESULT","request_id":1}}));
        }
        steps.push(json!({"op":"wait_file","path":child_gate}));
        let mut child_steps = child_steps;
        for step in child_steps.as_array_mut().unwrap() {
            if step["finish_gate"] == "parent_gate" {
                step["finish_gate"] = json!(parent_gate);
            }
        }
        steps.extend(child_steps.as_array().unwrap().iter().cloned());
        steps.push(json!({"op":"hang"}));
        let child_script = script("child", 2, provider, json!(steps));
        let mut args = json!({"kind":provider,"prompt":format!("@fake:{}",child_script.display()),"auto_approve":false,"reusable":true,"role":"worker"});
        if provider == "claude" {
            args["model"] = json!("haiku");
        }
        let mut steps = vec![json!({"op":"spawn","args":args})];
        if wait_transport.is_some() {
            steps.push(json!({"op":if wait_transport == Some("http") {"http_wait"} else {"call"},"tool":"pane_wait","args":{"timeout_ms":20000}}));
        }
        steps.extend([
            json!({"op":"wait_file","path":parent_gate}),
            json!({"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}}),
            json!({"op":"call","tool":"pane_wait","args":{"timeout_ms":100}}),
            json!({"op":"hang"}),
        ]);
        let parent_script = script("parent", 1, "claude", json!(steps));
        let channel = ChannelGuard(channel_dir.clone());
        let mut cmd = common::hermetic_command(supervisor_bin(), home.path());
        cmd.env("HOUSTON_CHANNEL", "dev")
            .arg("--channel-dir")
            .arg(&channel_dir)
            .arg("--daemon")
            .arg(core_bin())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(home.path().join("daemon-stderr")).unwrap());
        let supervisor = SupervisorGuard(cmd.spawn().unwrap());
        let cfg = channel_dir.join("daemon.json");
        let before = poll_until(POLL_TIMEOUT, || read_daemon_json(&cfg));
        let addr = format!("127.0.0.1:{}", before.port).parse().unwrap();
        let mut ws = connect_when_ready(addr, &before.token).await;
        let _ = common::next_control(&mut ws).await;
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::WorkspaceAdd {
                path: project.display().to_string(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        ws.send(Message::text(create_custom_msg(
            vec![
                env!("CARGO_BIN_EXE_fake_agent"),
                &format!("@fake:{}", parent_script.display()),
            ],
            &project,
        )))
        .await
        .unwrap();
        let parent = expect_created(&mut ws).await.id;
        drop(ws);
        let child = poll_until(POLL_TIMEOUT, || {
            Self::read_log(&log)
                .into_iter()
                .find(|row| {
                    row["seed"] == 1
                        && row["event"] == "reply"
                        && row["data"]["tool"] == "pane_spawn"
                })?
                .get("data")?
                .get("result")?
                .get("session")?
                .as_u64()
                .map(|id| id as u32)
        });
        if wait_transport.is_some() {
            poll_until(POLL_TIMEOUT, || {
                Self::read_log(&log)
                    .iter()
                    .any(|row| {
                        row["seed"] == 1
                            && row["event"] == "call"
                            && row["data"]["tool"] == "pane_wait"
                    })
                    .then_some(())
            });
            poll_until(POLL_TIMEOUT, || {
                Self::read_log(&log)
                    .iter()
                    .any(|row| {
                        row["seed"] == 2
                            && row["event"] == "reply"
                            && row["data"]["tool"] == "pane_submit"
                    })
                    .then_some(())
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Self {
            _home: home,
            _channel: channel,
            _supervisor: supervisor,
            before,
            cfg,
            parent,
            child,
            log,
            child_gate,
            parent_gate,
        }
    }

    fn read_log(path: &std::path::Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn waits(&self) -> Vec<serde_json::Value> {
        Self::read_log(&self.log)
            .into_iter()
            .filter(|row| {
                row["seed"] == 1 && row["event"] == "reply" && row["data"]["tool"] == "pane_wait"
            })
            .map(|row| row["data"]["result"].clone())
            .collect()
    }

    async fn handoff(&self) -> DaemonFile {
        let result = daemon_handoff(self.before.port, &self.before.token).await;
        assert!(result.accepted, "{result:?}");
        poll_until(POLL_TIMEOUT, || {
            let after = read_daemon_json(&self.cfg)?;
            (after.pid != self.before.pid && after.generation == result.generation).then_some(after)
        })
    }

    fn release_result(&self) {
        std::fs::write(&self.child_gate, "").unwrap();
        std::fs::write(&self.parent_gate, "").unwrap();
    }

    fn assert_result_once(&self, expected_waits: usize) {
        poll_until(Duration::from_secs(30), || {
            (self.waits().len() == expected_waits).then_some(())
        });
        let waits = self.waits();
        let results: Vec<_> = waits
            .iter()
            .flat_map(|reply| reply["rows"].as_array().unwrap())
            .filter(|row| row["kind"] == "result")
            .collect();
        assert_eq!(results.len(), 1, "{waits:?}");
        assert_eq!(results[0]["from_session"], self.child);
        if expected_waits == 3 {
            assert_eq!(results[0]["summary"], "PENDING_RESULT");
        }
    }
}

#[tokio::test]
async fn l1_adopted_child_keeps_its_parent_and_can_submit() {
    let rig = OrchestrationHandoff::new(
        "claude",
        serde_json::json!([{"op":"submit","summary":"ADOPTED_RESULT"}]),
        None,
    )
    .await;
    let after = rig.handoff().await;
    let addr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    let mut ws = connect_when_ready(addr, &after.token).await;
    let proto::ServerMsg::HelloOk { sessions, .. } = common::next_control(&mut ws).await else {
        panic!("missing hello")
    };
    let child = sessions
        .iter()
        .find(|session| session.id == rig.child)
        .unwrap();
    assert_eq!(
        child.spawned_by,
        Some(rig.parent),
        "adoption lost orchestration identity"
    );
    assert_eq!(
        child.delegation.as_ref().unwrap().role.as_deref(),
        Some("worker")
    );
    drop(ws);
    rig.release_result();
    rig.assert_result_once(2);
}

#[tokio::test]
async fn l1_open_wait_retries_across_handoff_without_losing_a_result() {
    for transport in ["mcp", "http"] {
        let rig=OrchestrationHandoff::new("claude",serde_json::json!([{"op":"hook","event":"Stop","fixture":"claude-2.1.263-07-Stop.json"}]),Some(transport)).await;
        rig.handoff().await;
        let first = poll_until(POLL_TIMEOUT, || rig.waits().first().cloned());
        assert_eq!(first["timed_out"], true, "{first}");
        assert_eq!(first["restarting"], true, "{first}");
        assert!(first["rows"].as_array().unwrap().is_empty());
        assert!(first["next_action"].as_str().unwrap().contains("pane_wait"));
        rig.release_result();
        rig.assert_result_once(3);
    }
}

#[tokio::test]
async fn l1_manual_claude_child_can_hand_back_without_a_permission_prompt() {
    let rig=OrchestrationHandoff::new("claude",serde_json::json!([{"op":"require_handback_allow"},{"op":"submit","summary":"MANUAL_RESULT"}]),None).await;
    rig.release_result();
    rig.assert_result_once(2);
}

#[tokio::test]
async fn l1_codex_startup_cursor_query_survives_the_handoff_window() {
    let rig =
        OrchestrationHandoff::new("codex", serde_json::json!([{"op":"terminal_query"}]), None)
            .await;
    std::fs::write(&rig.child_gate, "").unwrap();
    rig.handoff().await;
    let reply = poll_until(POLL_TIMEOUT, || {
        OrchestrationHandoff::read_log(&rig.log)
            .into_iter()
            .find(|row| row["event"] == "terminal_reply")
    });
    assert_eq!(reply["data"]["reply"], "\x1b[3;7R");
}

#[tokio::test]
async fn l1_codex_cursor_query_before_handoff() {
    let rig =
        OrchestrationHandoff::new("codex", serde_json::json!([{"op":"terminal_query"}]), None)
            .await;
    std::fs::write(&rig.child_gate, "").unwrap();
    let reply = poll_until(POLL_TIMEOUT, || {
        OrchestrationHandoff::read_log(&rig.log)
            .into_iter()
            .find(|row| row["event"] == "terminal_reply")
    });
    assert_eq!(reply["data"]["reply"], "\x1b[3;7R");
}

#[tokio::test]
async fn l1_manual_grok_child_gets_only_the_handback_permission() {
    let rig=OrchestrationHandoff::new("grok",serde_json::json!([{"op":"require_handback_allow"},{"op":"submit","summary":"GROK_RESULT"}]),None).await;
    rig.release_result();
    rig.assert_result_once(2);
}

#[tokio::test]
async fn l1_codex_split_cursor_query_and_post_adoption_da_are_answered() {
    let rig = OrchestrationHandoff::new(
        "codex",
        serde_json::json!([
            {"op":"terminal_query","finish_gate":"parent_gate"},
            {"op":"terminal_query","query":"da"}
        ]),
        None,
    )
    .await;
    std::fs::write(&rig.child_gate, "").unwrap();
    poll_until(POLL_TIMEOUT, || {
        OrchestrationHandoff::read_log(&rig.log)
            .iter()
            .any(|row| row["event"] == "query_started")
            .then_some(())
    });
    rig.handoff().await;
    std::fs::write(&rig.parent_gate, "").unwrap();
    let replies = poll_until(POLL_TIMEOUT, || {
        let replies: Vec<_> = OrchestrationHandoff::read_log(&rig.log)
            .into_iter()
            .filter(|row| row["event"] == "terminal_reply")
            .collect();
        (replies.len() == 2).then_some(replies)
    });
    assert_eq!(replies[0]["data"]["reply"], "\x1b[3;7R");
    assert_eq!(replies[1]["data"]["reply"], "\x1b[?62;22c");
}

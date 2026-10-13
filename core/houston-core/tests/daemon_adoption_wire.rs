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
        path: None,
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
        serde_json::to_string(&proto::ClientMsg::SessionRename {
            session: origin,
            title: "Manual handoff title".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::SessionRenamed {
            session,
            title_source,
            ..
        } = common::next_control(&mut ws).await
        {
            if session == origin {
                assert_eq!(title_source, proto::TitleSource::User);
                break;
            }
        }
    }
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
    assert_eq!(replacement.title, "Manual handoff title");
    assert_eq!(replacement.title_source, proto::TitleSource::User);
    assert_eq!(replacement.session_origin, Some(origin));
    let session_id = replacement.id;
    let ownership_before = ownership_receipt(&channel_dir, session_id);

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
    assert_eq!(
        ownership_receipt(&channel_dir, session_id),
        ownership_before,
        "successful adoption must preserve the committed ownership receipt exactly"
    );
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
            assert_eq!(adopted.title, "Manual handoff title");
            assert_eq!(adopted.title_source, proto::TitleSource::User);
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

    ws2.send(Message::Binary(
        proto::encode_stdin_frame(session_id, b"\x1b]2;Later native title\x07\n").into(),
    ))
    .await
    .unwrap();
    collect_output_until(&mut ws2, session_id, "Later native title").await;
    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionList).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::SessionList { sessions } = common::next_control(&mut ws2).await {
            let pane = sessions.iter().find(|pane| pane.id == session_id).unwrap();
            assert_eq!(pane.title, "Manual handoff title");
            assert_eq!(pane.title_source, proto::TitleSource::User);
            break;
        }
    }

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

fn ownership_receipt(channel: &std::path::Path, session: u32) -> String {
    rusqlite::Connection::open_with_flags(
        channel.join("houston.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
    .query_row(
        "SELECT process_identity FROM sessions WHERE id=?1",
        [session],
        |row| row.get(0),
    )
    .unwrap()
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
            path: None,
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
    let ownership_before = ownership_receipt(&channel_dir, session_id);

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
    assert_eq!(
        ownership_receipt(&channel_dir, session_id),
        ownership_before,
        "failed adoption must preserve the old ownership receipt exactly"
    );
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
    for _ in 0..3 {
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
    }
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
        Self::new_with_approval(provider, child_steps, wait_transport, Some(false)).await
    }

    async fn new_with_approval(
        provider: &str,
        child_steps: serde_json::Value,
        wait_transport: Option<&str>,
        auto_approve: Option<bool>,
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
        for name in ["claude", "codex", "grok", "opencode"] {
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
        let mut args = json!({"kind":provider,"prompt":format!("@fake:{}",child_script.display()),"reusable":true,"role":"worker"});
        if let Some(auto_approve) = auto_approve {
            args["auto_approve"] = json!(auto_approve);
        }
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
        let rig = Self {
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
        };
        rig.wait_for_child_startup().await;
        rig
    }

    async fn wait_for_child_startup(&self) {
        let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
        loop {
            // Spawn returns before the child emits its startup hooks. The gate receipt
            // proves both helpers finished; their drops must also be consumed before
            // injecting a permission that a later initial prompt would legitimately clear.
            let at_gate = Self::read_log(&self.log).iter().any(|row| {
                row["seed"] == 2 && row["event"] == "step" && row["data"]["op"] == "wait_file"
            });
            let pending = std::fs::read_dir(houston_core::hook_drop::drop_dir(
                self.cfg.parent().unwrap(),
            ))
            .unwrap()
            .any(|entry| {
                let name = entry.unwrap().file_name();
                name.to_str()
                    .and_then(houston_core::hook_drop::parse_drop_name)
                    .is_some_and(|drop| drop.session == self.child)
            });
            if at_gate && !pending {
                assert_eq!(
                    self.session().await.status,
                    Some(proto::AgentStatus::Working),
                    "startup hooks must report a working child before native input is injected"
                );
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "child startup did not reach its gate with hooks consumed: {:?}",
                Self::read_log(&self.log)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn read_log(path: &std::path::Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn db(&self) -> houston_core::db::Db {
        houston_core::db::Db::open(&self.cfg.parent().unwrap().join("houston.db")).unwrap()
    }

    fn input(&self) -> Option<proto::ChildInputRequest> {
        self.db().child_input_request(self.child).unwrap()
    }

    async fn native_drop(&self, mut drop: houston_core::hook_drop::HookDrop) {
        drop.session = self.child;
        let path = houston_core::hook_drop::write_drop(
            &houston_core::hook_drop::drop_dir(self.cfg.parent().unwrap()),
            &drop,
            houston_core::daemon::now_ms(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
        while path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "hook not applied: {drop:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(target_os = "linux")]
    fn parent_token(&self) -> String {
        let pid = Self::read_log(&self.log)
            .into_iter()
            .find(|row| row["seed"] == 1 && row["event"] == "start")
            .unwrap()["data"]["pid"]
            .as_u64()
            .unwrap();
        let environment = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
        environment
            .split(|byte| *byte == 0)
            .find_map(|item| {
                std::str::from_utf8(item)
                    .ok()?
                    .strip_prefix("HOUSTON_MCP_TOKEN=")
            })
            .expect("the fixture parent's scoped credential")
            .to_string()
    }

    #[cfg(target_os = "linux")]
    async fn child_detail(&self) -> serde_json::Value {
        let current = read_daemon_json(&self.cfg).unwrap();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "http://127.0.0.1:{}/orchestrate/get?session={}",
                current.port, self.child
            ))
            .bearer_auth(self.parent_token())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let detail: serde_json::Value = response.json().await.unwrap();
        assert_eq!(status, 200, "{detail}");
        detail
    }

    #[cfg(target_os = "linux")]
    async fn parent_post(&self, verb: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
        let current = read_daemon_json(&self.cfg).unwrap();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!(
                "http://127.0.0.1:{}/orchestrate/{verb}",
                current.port
            ))
            .bearer_auth(self.parent_token())
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }

    async fn operator_input(&self, bytes: &[u8]) {
        let current = read_daemon_json(&self.cfg).unwrap();
        let mut ws = connect_when_ready(
            format!("127.0.0.1:{}", current.port).parse().unwrap(),
            &current.token,
        )
        .await;
        let _ = common::next_control(&mut ws).await;
        ws.send(Message::Binary(
            proto::encode_stdin_frame(self.child, bytes).into(),
        ))
        .await
        .unwrap();
        // A control reply on the same connection proves the binary input was processed first.
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionList).unwrap(),
        ))
        .await
        .unwrap();
        while !matches!(
            common::next_control(&mut ws).await,
            proto::ServerMsg::SessionList { .. }
        ) {}
    }

    async fn session(&self) -> proto::SessionInfo {
        let current = read_daemon_json(&self.cfg).unwrap();
        let mut ws = connect_when_ready(
            format!("127.0.0.1:{}", current.port).parse().unwrap(),
            &current.token,
        )
        .await;
        let proto::ServerMsg::HelloOk { sessions, .. } = common::next_control(&mut ws).await else {
            panic!("expected session snapshot")
        };
        sessions
            .into_iter()
            .find(|session| session.id == self.child)
            .unwrap()
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
async fn l1_manual_grok_child_gets_only_the_local_dialogue_and_input_permissions() {
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

fn native_fingerprint(command: &str) -> String {
    use sha2::{Digest, Sha256};
    let canonical = serde_json::to_vec(&serde_json::json!({"command":command})).unwrap();
    format!("{:x}", Sha256::digest(canonical))
}

fn native_permission(provider: &str, id: Option<&str>) -> houston_core::hook_drop::HookDrop {
    houston_core::hook_drop::HookDrop {
        agent: Some(provider.into()),
        event: if provider == "opencode" {
            "permission.asked"
        } else {
            "PermissionRequest"
        }
        .into(),
        tool_name: Some("Bash".into()),
        tool_use_id: id.map(str::to_string),
        request_id: id.map(str::to_string),
        permission_command: Some("echo fixture".into()),
        permission_block_reason: Some("Provider requests consent".into()),
        ..Default::default()
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_native_permission_keeps_exact_id_denies_once_and_resolves_only_matching_proof() {
    let rig = OrchestrationHandoff::new(
        "claude",
        serde_json::json!([
            {"op":"read_bytes","count":1}, {"op":"read_bytes","count":1}
        ]),
        None,
    )
    .await;
    std::fs::write(&rig.child_gate, "").unwrap();
    let root_prompt = houston_core::hook_drop::HookDrop {
        agent: Some("claude".into()),
        event: "UserPromptSubmit".into(),
        prompt_id: Some("adopted-root-turn".into()),
        ..Default::default()
    };
    rig.native_drop(root_prompt.clone()).await;
    rig.native_drop(native_permission("claude", Some("adopted-permission")))
        .await;
    let input = rig.input().unwrap();
    assert_eq!(rig.child_detail().await["turn_end_source"], "stop-hook");
    rig.handoff().await;
    assert_eq!(rig.input(), Some(input.clone()));
    assert_eq!(rig.child_detail().await["turn_end_source"], "stop-hook");
    rig.native_drop(root_prompt).await;
    assert_eq!(
        rig.input(),
        Some(input.clone()),
        "a replayed root prompt cannot clear adopted input"
    );
    let deny = serde_json::json!({"child":rig.child,"episode_id":input.id});
    let (status, reply) = rig.parent_post("deny", deny.clone()).await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["denial_sent"], true);
    assert_eq!(reply["pending"], true);
    let receipt = poll_until(POLL_TIMEOUT, || {
        OrchestrationHandoff::read_log(&rig.log)
            .into_iter()
            .find(|row| row["seed"] == 2 && row["event"] == "input_bytes")
    });
    assert_eq!(receipt["data"]["bytes"], serde_json::json!([27]));
    assert_eq!(rig.input(), Some(input.clone()));

    // A second real adoption also retains the durable attempted-denial latch.
    let current = read_daemon_json(&rig.cfg).unwrap();
    let result = daemon_handoff(current.port, &current.token).await;
    assert!(result.accepted, "{result:?}");
    poll_until(POLL_TIMEOUT, || {
        read_daemon_json(&rig.cfg).filter(|file| file.pid != current.pid)
    });
    let (status, duplicate) = rig.parent_post("deny", deny).await;
    assert_eq!(status, 200, "{duplicate}");
    assert_eq!(duplicate["already_attempted"], true);
    assert_eq!(duplicate["denial_sent"], false);
    assert_eq!(
        OrchestrationHandoff::read_log(&rig.log)
            .iter()
            .filter(|row| row["seed"] == 2 && row["event"] == "input_bytes")
            .count(),
        1
    );
    let (status, refused) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["error"]
        .as_str()
        .unwrap()
        .contains("only the operator may approve"));

    let mut proof = native_permission("claude", Some("unmatched-permission"));
    proof.event = "PostToolUse".into();
    rig.native_drop(proof.clone()).await;
    assert_eq!(rig.input(), Some(input));
    proof.tool_use_id = Some("adopted-permission".into());
    rig.native_drop(proof).await;
    assert_eq!(rig.input(), None);
    assert_eq!(
        rig.session().await.status,
        Some(proto::AgentStatus::Working)
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn native_proof_queued_during_handoff_resolves_after_commit_and_input_is_fenced() {
    let rig = OrchestrationHandoff::new(
        "claude",
        serde_json::json!([{"op":"read_bytes","count":1}]),
        None,
    )
    .await;
    std::fs::write(&rig.child_gate, "").unwrap();
    rig.native_drop(native_permission("claude", Some("queued-permission")))
        .await;
    let input = rig.input().unwrap();
    let marker = rig._home.path().join("candidate-started");
    let release = rig._home.path().join("candidate-release");
    let candidate = rig._home.path().join("delayed-candidate");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    // Hold the candidate before Hello so the old generation is deterministically handing off.
    std::fs::write(&candidate, format!(
        "#!/bin/sh\n: > {}\ni=0\nwhile [ ! -e {} ] && [ \"$i\" -lt 250 ]; do sleep 0.02; i=$((i+1)); done\nexec {} \"$@\"\n",
        quote(&marker.to_string_lossy()), quote(&release.to_string_lossy()), quote(core_bin()),
    )).unwrap();
    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o755)).unwrap();
    let before = rig.before.clone();
    let candidate_path = candidate.to_string_lossy().into_owned();
    let handoff = tokio::spawn(async move {
        daemon_handoff_to(before.port, &before.token, Some(&candidate_path)).await
    });
    let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
    while !marker.exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    rig.operator_input(b"\r").await;
    let (status, refusal) = rig
        .parent_post(
            "deny",
            serde_json::json!({
                "child":rig.child, "episode_id":input.id,
            }),
        )
        .await;
    assert!(status >= 400, "{refusal}");
    assert!(!rig
        .db()
        .child_permission_deny_attempted(rig.child, &input.id)
        .unwrap());
    let proof = houston_core::hook_drop::HookDrop {
        session: rig.child,
        agent: Some("claude".into()),
        event: "PostToolUse".into(),
        tool_use_id: Some("queued-permission".into()),
        tool_name: Some("Bash".into()),
        ..Default::default()
    };
    let path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(rig.cfg.parent().unwrap()),
        &proof,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    assert_eq!(rig.input(), Some(input));
    std::fs::write(&release, "").unwrap();
    let result = handoff.await.unwrap();
    assert!(result.accepted, "{result:?}");
    while path.exists() || rig.input().is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "queued proof was not resolved"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!OrchestrationHandoff::read_log(&rig.log)
        .iter()
        .any(|row| row["event"] == "input_bytes"));
    assert_eq!(
        rig.session().await.status,
        Some(proto::AgentStatus::Working)
    );
    // Refused old-generation input did not create an intervention or deliver bytes later.
    rig.operator_input(b"\r").await;
    let receipt = poll_until(POLL_TIMEOUT, || {
        OrchestrationHandoff::read_log(&rig.log)
            .into_iter()
            .find(|row| row["seed"] == 2 && row["event"] == "input_bytes")
    });
    assert_eq!(receipt["data"]["bytes"], serde_json::json!([13]));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_generated_codex_permissions_keep_counters_digests_and_deny_cardinality() {
    let rig = OrchestrationHandoff::new("codex", serde_json::json!([]), None).await;
    let mut permission = native_permission("codex", None);
    permission.prompt_id = Some("adopted-turn".into());
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-digest-a"));
    rig.native_drop(permission.clone()).await;
    let input = rig.input().unwrap();
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-digest-b"));
    rig.native_drop(permission.clone()).await;
    rig.handoff().await;
    assert_eq!(rig.input(), Some(input.clone()));
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-digest-c"));
    rig.native_drop(permission.clone()).await;
    let sources = rig
        .db()
        .child_input_pending_provider_sources(rig.child)
        .unwrap();
    assert_eq!(sources.len(), 3, "{sources:?}");
    assert!(
        sources
            .iter()
            .any(|source| source.contains("generation: 2")),
        "{sources:?}"
    );
    let (status, refusal) = rig
        .parent_post(
            "deny",
            serde_json::json!({"child":rig.child,"episode_id":input.id}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    assert!(refusal["error"]
        .as_str()
        .unwrap()
        .contains("3 live provider prompts"));
    assert!(!rig
        .db()
        .child_permission_deny_attempted(rig.child, &input.id)
        .unwrap());

    permission.event = "PostToolUse".into();
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-digest-a"));
    permission.prompt_id = Some("unrelated-turn".into());
    rig.native_drop(permission.clone()).await;
    assert_eq!(rig.input(), Some(input.clone()));
    permission.prompt_id = Some("adopted-turn".into());
    permission.tool_input_fingerprint = None;
    rig.native_drop(permission.clone()).await;
    assert_eq!(rig.input(), Some(input.clone()));
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-digest-a"));
    rig.native_drop(permission.clone()).await;
    assert!(rig
        .db()
        .child_input_request_by_id(rig.child, &input.id)
        .unwrap()
        .is_none());
    for fingerprint in [
        native_fingerprint("echo fixture-digest-b"),
        native_fingerprint("echo fixture-digest-c"),
    ] {
        permission.tool_input_fingerprint = Some(fingerprint);
        rig.native_drop(permission.clone()).await;
    }
    assert_eq!(rig.input(), None);
    assert_eq!(
        rig.session().await.status,
        Some(proto::AgentStatus::Working)
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_question_keeps_operator_intervention_fence_until_matching_proof() {
    let rig = OrchestrationHandoff::new("claude", serde_json::json!([]), None).await;
    let question = houston_core::hook_drop::HookDrop {
        agent: Some("claude".into()),
        event: "PreToolUse".into(),
        tool_name: Some("AskUserQuestion".into()),
        tool_use_id: Some("adopted-question".into()),
        ..Default::default()
    };
    rig.native_drop(question.clone()).await;
    let input = rig.input().unwrap();
    assert_eq!(input.kind, proto::ChildInputKind::Question);
    rig.operator_input(b"\r").await;
    rig.handoff().await;
    assert_eq!(rig.input(), Some(input.clone()));
    let (status, refusal) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    assert!(refusal["error"]
        .as_str()
        .unwrap()
        .contains("operator intervention"));
    let mut proof = question;
    proof.event = "PostToolUse".into();
    proof.tool_use_id = Some("unrelated-question".into());
    rig.native_drop(proof.clone()).await;
    assert_eq!(rig.input(), Some(input));
    proof.tool_use_id = Some("adopted-question".into());
    rig.native_drop(proof).await;
    assert_eq!(rig.input(), None);
    let (status, reply) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_escalated_permission_remains_operator_owned() {
    let rig = OrchestrationHandoff::new("claude", serde_json::json!([]), None).await;
    rig.native_drop(native_permission("claude", Some("adopted-user-owned")))
        .await;
    let (status, reply) = rig
        .parent_post(
            "escalate",
            serde_json::json!({"child":rig.child,"reason":"Operator decision required"}),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let input = rig.input().unwrap();
    assert_eq!(input.owner, proto::ChildInputOwner::User);
    rig.handoff().await;
    assert_eq!(rig.input(), Some(input.clone()));
    let (status, refusal) = rig
        .parent_post(
            "deny",
            serde_json::json!({"child":rig.child,"episode_id":input.id}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    assert!(refusal["error"]
        .as_str()
        .unwrap()
        .contains("belongs to the operator"));
    assert!(!rig
        .db()
        .child_permission_deny_attempted(rig.child, &input.id)
        .unwrap());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_codex_auto_review_keeps_strict_pending_evidence_without_a_human_ask() {
    let rig =
        OrchestrationHandoff::new_with_approval("codex", serde_json::json!([]), None, None).await;
    let mut permission = native_permission("codex", None);
    permission.prompt_id = Some("adopted-auto-turn".into());
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-auto-digest"));
    rig.native_drop(permission.clone()).await;
    assert_eq!(rig.input(), None);
    assert_eq!(
        rig.session().await.status,
        Some(proto::AgentStatus::Working)
    );
    rig.handoff().await;
    assert_eq!(rig.child_detail().await["turn_end_source"], "stop-hook");
    let (status, refusal) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    permission.event = "PostToolUse".into();
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-unmatched-digest"));
    rig.native_drop(permission.clone()).await;
    let (status, refusal) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    permission.tool_input_fingerprint = Some(native_fingerprint("echo fixture-auto-digest"));
    rig.native_drop(permission).await;
    let (status, reply) = rig
        .parent_post(
            "keys",
            serde_json::json!({"session":rig.child,"keys":["enter"]}),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(rig.input(), None);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn adopted_opencode_permission_retains_request_reply_correlation_and_unsupported_deny() {
    let rig = OrchestrationHandoff::new("opencode", serde_json::json!([]), None).await;
    rig.native_drop(native_permission(
        "opencode",
        Some("adopted-opencode-request"),
    ))
    .await;
    let input = rig.input().unwrap();
    rig.handoff().await;
    assert_eq!(rig.input(), Some(input.clone()));
    let (status, refusal) = rig
        .parent_post(
            "deny",
            serde_json::json!({"child":rig.child,"episode_id":input.id}),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    assert!(refusal["error"].as_str().unwrap().contains("OpenCode"));
    assert!(!rig
        .db()
        .child_permission_deny_attempted(rig.child, &input.id)
        .unwrap());
    let mut proof = native_permission("opencode", Some("unmatched-request"));
    proof.event = "permission.replied".into();
    rig.native_drop(proof.clone()).await;
    assert_eq!(rig.input(), Some(input));
    proof.request_id = Some("adopted-opencode-request".into());
    rig.native_drop(proof).await;
    assert_eq!(rig.input(), None);
    assert_eq!(
        rig.session().await.status,
        Some(proto::AgentStatus::Working)
    );
}

#[tokio::test]
async fn legacy_native_needs_input_without_snapshot_refuses_prepare_and_keeps_old_pty() {
    legacy_native_input_without_snapshot(proto::AgentStatus::NeedsInput, false);
}

#[tokio::test]
async fn legacy_working_without_native_request_can_prepare_without_snapshot() {
    legacy_native_input_without_snapshot(proto::AgentStatus::Working, false);
}

#[tokio::test]
async fn legacy_working_with_durable_native_request_without_snapshot_refuses_prepare() {
    legacy_native_input_without_snapshot(proto::AgentStatus::Working, true);
}

fn legacy_native_input_without_snapshot(status: proto::AgentStatus, pending_source: bool) {
    use std::io::{Read, Write};
    use std::os::fd::FromRawFd;
    let home = tempfile::tempdir().unwrap();
    let (sock_path, listener) = fake_old_daemon(home.path());
    let child = spawn_candidate(home.path(), &sock_path);
    let (mut sock, _) = listener.accept().unwrap();
    let hello = read_hello(&mut sock);
    assert!(hello.native_input_snapshot);
    let (mut master_fd, mut slave_fd) = (-1, -1);
    let result = unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    let mut master = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let mut slave = unsafe { std::fs::File::from_raw_fd(slave_fd) };
    let session = adoption::SessionManifest {
        title_source: Default::default(),
        session_id: 130,
        pid: None,
        cols: 80,
        rows: 24,
        output_offset: 0,
        state: proto::SessionState::Running,
        status: Some(status),
        hidden: false,
        project_dir: home.path().display().to_string(),
        cwd: home.path().display().to_string(),
        title: "legacy native input".into(),
        codename: "legacy".into(),
        tags: vec![],
        agent: proto::AgentKind::Claude,
        swarm_agent: None,
        hook_cwd: None,
        mcp_cred: None,
        native_input: None,
        vt_snapshot: vec![],
        vt_format_version: 0,
    };
    let channel_dir = home.path().join(".houston-dev");
    let db = houston_core::db::Db::open(&channel_dir.join("houston.db")).unwrap();
    let mut child_info: proto::SessionInfo = serde_json::from_value(serde_json::json!({
        "id": session.session_id, "agent": "claude", "project_dir": session.project_dir,
        "cwd": session.cwd, "state": "running", "status": session.status,
        "title": session.title
    }))
    .unwrap();
    // Every transferred live PTY has a session row in the retiring daemon's database.
    if pending_source {
        let mut parent = child_info.clone();
        parent.id = 129;
        parent.title = "legacy parent".into();
        parent.status = Some(proto::AgentStatus::Working);
        child_info.spawned_by = Some(parent.id);
        db.insert_session(&parent).unwrap();
    }
    db.insert_session(&child_info).unwrap();
    let durable_input = if pending_source {
        db.delegation_create(129, 130, None, "native input fixture", 1)
            .unwrap();
        Some(
            db.child_input_open_provider(
                130,
                "ToolUseId(\"legacy-permission\")",
                proto::ChildInputKind::Permission,
                proto::ChildInputOwner::Orchestrator,
                None,
                2,
            )
            .unwrap()
            .0,
        )
    } else {
        None
    };
    drop(db);
    let manifest = adoption::Manifest {
        version: 2,
        generation: 2,
        token: "legacy-adoption-token".into(),
        sessions: vec![session],
    };
    let serialized = serde_json::to_string(&manifest).unwrap();
    assert!(
        !serialized.contains("native_input"),
        "old manifests omit the optional field"
    );
    adoption::write_frame(&mut sock, &FromOld::Manifest(manifest)).unwrap();
    let transferred = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let lock = houston_core::lock::acquire_exclusive(&channel_dir).unwrap();
    adoption::send_fds(
        sock.as_raw_fd(),
        &[
            master.as_raw_fd(),
            transferred.as_raw_fd(),
            lock.as_raw_fd(),
        ],
    )
    .unwrap();
    let reply = adoption::read_frame::<_, FromNew>(&mut sock).unwrap();
    if status == proto::AgentStatus::NeedsInput || pending_source {
        let FromNew::PrepareFailed { reason } = reply else {
            panic!("legacy input must refuse before Prepared and Commit")
        };
        assert!(
            reason.contains("native input handoff refused for session 130"),
            "{reason}"
        );
        assert!(reason.contains("no recovery snapshot"), "{reason}");
    } else {
        assert!(
            matches!(reply, FromNew::Prepared),
            "legacy Working without input is adoptable: {reply:?}"
        );
    }
    drop(sock);
    assert!(!child.wait_with_output().unwrap().status.success());
    assert!(
        !channel_dir.join("daemon.json").exists(),
        "no new owner was committed"
    );
    assert!(
        houston_core::lock::acquire_exclusive(&channel_dir).is_err(),
        "the original owner retains the daemon lock"
    );
    if let Some(input) = durable_input {
        let db = houston_core::db::Db::open(&channel_dir.join("houston.db")).unwrap();
        assert_eq!(db.child_input_request(130).unwrap(), Some(input));
    }
    slave.write_all(b"old-owner-alive\n").unwrap();
    let mut buffer = [0; 64];
    let count = master.read(&mut buffer).unwrap();
    assert!(String::from_utf8_lossy(&buffer[..count]).contains("old-owner-alive"));
}

#[cfg(target_os = "linux")]
fn read_syscalls(pid: u32) -> u64 {
    let io = std::fs::read_to_string(format!("/proc/{pid}/io")).expect("reading /proc/<pid>/io");
    io.lines()
        .find_map(|line| line.strip_prefix("syscr: "))
        .and_then(|value| value.trim().parse().ok())
        .expect("syscr line in /proc/<pid>/io")
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_adopted_session_in_a_git_checkout_leaves_the_head_watcher_idle() {
    let git = |dir: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {output:?}");
    };
    let home = tempfile::tempdir().unwrap();
    let channel_dir = home.path().join(".houston-dev");
    let _channel_guard = ChannelGuard(channel_dir.clone());
    let mut guard = spawn_supervised_daemon(home.path(), &channel_dir);
    let project = tempfile::tempdir().unwrap();
    git(project.path(), &["init", "-b", "main"]);
    git(
        project.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    git(project.path(), &["config", "user.name", "Test"]);
    git(
        project.path(),
        &["commit", "--allow-empty", "-m", "initial"],
    );
    let cfg_path = channel_dir.join("daemon.json");
    let (before, session_id, ws) = supervised_daemon_with_session(
        home.path(),
        &channel_dir,
        project.path(),
        vec!["sh", "-c", "cat"],
    )
    .await;
    drop(ws);

    let result = daemon_handoff(before.port, &before.token).await;
    assert!(result.accepted, "handoff must be accepted: {result:?}");
    let generation = result
        .generation
        .expect("accepted handoff names a generation");
    let after = poll_until(POLL_TIMEOUT, || {
        let f = read_daemon_json(&cfg_path)?;
        (f.pid != before.pid && f.generation == Some(generation)).then_some(f)
    });
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", after.port).parse().unwrap();
    let mut ws = connect_when_ready(addr, &after.token).await;
    match common::next_control(&mut ws).await {
        proto::ServerMsg::HelloOk { sessions, .. } => {
            let adopted = sessions.iter().find(|s| s.id == session_id).unwrap();
            let checkout = adopted
                .checkout
                .as_ref()
                .expect("adopted checkout metadata");
            assert_eq!(checkout.branch.as_deref(), Some("main"));
        }
        other => panic!("expected HelloOk, got {other:?}"),
    }

    // Each HEAD read used to wake the watcher again, so an adopted pane drove
    // tens of thousands of reads per second; a settled watcher wakes once a second.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let window = Duration::from_secs(3);
    let start = read_syscalls(after.pid);
    tokio::time::sleep(window).await;
    let reads = read_syscalls(after.pid) - start;
    assert!(
        reads < 3_000,
        "adopted daemon issued {reads} read syscalls in {window:?}; expected fewer than 3000"
    );

    git(project.path(), &["switch", "-c", "x"]);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let proto::ServerMsg::SessionCheckout { id, checkout } =
                common::next_control(&mut ws).await
            {
                if id == session_id
                    && checkout.as_ref().and_then(|c| c.branch.as_deref()) == Some("x")
                {
                    return;
                }
            }
        }
    })
    .await
    .expect("a branch switch in the adopted checkout must broadcast SessionCheckout");
    drop(ws);

    manage_shutdown(after.port, &after.token).await;
    poll_until(POLL_TIMEOUT, || {
        guard.0.try_wait().expect("poll supervisor exit")
    });
}

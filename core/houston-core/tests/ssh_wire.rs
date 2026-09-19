mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use russh::keys::PrivateKey;
use russh::server::{Auth, Handler, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct ExecRecord {
    command: String,
    stdin: Vec<u8>,
}

#[derive(Clone, Default)]
struct EchoServer {
    exec: Arc<std::sync::Mutex<ExecRecord>>,
}

impl russh::server::Server for EchoServer {
    type Handler = EchoHandler;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> EchoHandler {
        EchoHandler {
            exec: Arc::clone(&self.exec),
            exec_channel: None,
        }
    }
}

struct EchoHandler {
    exec: Arc<std::sync::Mutex<ExecRecord>>,
    exec_channel: Option<ChannelId>,
}

const FAKE_REMOTE_PATH: &str = "/home/remote/.houston/uploads/notes.txt";

impl Handler for EchoHandler {
    type Error = russh::Error;

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.exec_channel = Some(channel);
        self.exec.lock().unwrap().command = String::from_utf8_lossy(data).to_string();
        session.channel_success(channel)?;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.exec_channel != Some(channel) {
            return Ok(());
        }
        session.data(channel, format!("{FAKE_REMOTE_PATH}\n").into_bytes())?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, b"REMOTE-SHELL-READY\r\n".to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.exec_channel == Some(channel) {
            self.exec.lock().unwrap().stdin.extend_from_slice(data);
            return Ok(());
        }
        let echoed: Vec<u8> = data.iter().map(|b| b.to_ascii_uppercase()).collect();
        session.data(channel, echoed)?;
        Ok(())
    }
}

async fn start_ssh_server() -> std::net::SocketAddr {
    start_ssh_server_recording().await.0
}

async fn start_ssh_server_recording() -> (std::net::SocketAddr, Arc<std::sync::Mutex<ExecRecord>>) {
    let key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let exec = Arc::new(std::sync::Mutex::new(ExecRecord::default()));
    let server_exec = Arc::clone(&exec);
    tokio::spawn(async move {
        let mut server = EchoServer { exec: server_exec };
        let _ = server.run_on_socket(config, &listener).await;
    });
    (addr, exec)
}

fn write_client_key(dir: &std::path::Path) -> String {
    use russh::keys::ssh_key::LineEnding;
    let key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let path = dir.join("id_ed25519");
    std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    path.display().to_string()
}

async fn daemon_ws(state: &std::path::Path) -> WsStream {
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.join("test.db"),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    ws
}

fn connect_msg(request: u32, addr: std::net::SocketAddr, key_path: &str) -> String {
    serde_json::to_string(&proto::ClientMsg::SshConnect {
        request,
        host: addr.ip().to_string(),
        port: Some(addr.port()),
        user: "tester".into(),
        auth: proto::SshAuth::IdentityFile {
            path: key_path.into(),
            passphrase_profile: None,
        },
        cols: Some(80),
        rows: Some(24),
        profile: None,
    })
    .unwrap()
}

async fn expect_host_key(ws: &mut WsStream) -> (u32, bool) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SshHostKey {
                request,
                changed,
                fingerprint,
                randomart,
                ..
            } => {
                assert!(fingerprint.starts_with("SHA256:"), "fp: {fingerprint}");
                assert!(randomart.contains("+--"), "randomart border: {randomart}");
                return (request, changed);
            }
            proto::ServerMsg::Error { message, .. } => panic!("unexpected error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn ssh_connect_tofu_accept_then_echo() {
    let addr = start_ssh_server().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;

    ws.send(Message::text(connect_msg(1, addr, &key_path)))
        .await
        .unwrap();

    let (request, changed) = expect_host_key(&mut ws).await;
    assert_eq!(request, 1);
    assert!(
        !changed,
        "first connection is a new host, not a changed key"
    );

    let answer = serde_json::to_string(&proto::ClientMsg::SshHostKeyAnswer {
        request: 1,
        accept: true,
    })
    .unwrap();
    ws.send(Message::text(answer)).await.unwrap();

    let info = expect_created(&mut ws).await;
    assert_eq!(info.agent, proto::AgentKind::Ssh);
    assert!(
        info.ssh_host.as_deref().unwrap().starts_with("tester@"),
        "ssh_host: {:?}",
        info.ssh_host
    );

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: info.id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    collect_output_until(&mut ws, info.id, "REMOTE-SHELL-READY").await;

    ws.send(Message::binary(proto::encode_stdin_frame(
        info.id, b"ping\n",
    )))
    .await
    .unwrap();
    collect_output_until(&mut ws, info.id, "PING").await;
}

#[tokio::test]
async fn ssh_host_key_reject_fails_the_connect() {
    let addr = start_ssh_server().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;

    ws.send(Message::text(connect_msg(7, addr, &key_path)))
        .await
        .unwrap();
    let (request, _) = expect_host_key(&mut ws).await;
    assert_eq!(request, 7);

    let answer = serde_json::to_string(&proto::ClientMsg::SshHostKeyAnswer {
        request: 7,
        accept: false,
    })
    .unwrap();
    ws.send(Message::text(answer)).await.unwrap();

    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("tester@"),
                    "error names the target: {message}"
                );
                break;
            }
            proto::ServerMsg::SessionCreated { .. } => {
                panic!("a rejected host key must not create a session")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn second_connect_to_trusted_host_skips_the_prompt() {
    let addr = start_ssh_server().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;

    ws.send(Message::text(connect_msg(1, addr, &key_path)))
        .await
        .unwrap();
    let _ = expect_host_key(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshHostKeyAnswer {
            request: 1,
            accept: true,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let first = expect_created(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionKill {
            session: first.id,
            confirm_children: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    ws.send(Message::text(connect_msg(2, addr, &key_path)))
        .await
        .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionCreated { info } if info.agent == proto::AgentKind::Ssh => {
                break
            }
            proto::ServerMsg::SshHostKey { .. } => {
                panic!("a trusted host must not prompt again")
            }
            proto::ServerMsg::Error { message, .. } => panic!("connect error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn ssh_profiles_roundtrip() {
    let state = tempfile::tempdir().unwrap();
    let mut ws = daemon_ws(state.path()).await;

    let profile = proto::SshProfile {
        name: "prod".into(),
        host: "example.com".into(),
        port: 2222,
        user: "deploy".into(),
        auth: proto::SshAuth::Agent,
        default_dir: None,
        startup_cmd: None,
        last_used_at: None,
        has_credential: false,
    };
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshProfileSave {
            profile: profile.clone(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let profiles = expect_profiles(&mut ws).await;
    assert_eq!(profiles, vec![profile]);

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshProfileDelete {
            name: "prod".into(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let profiles = expect_profiles(&mut ws).await;
    assert!(profiles.is_empty(), "profile deleted: {profiles:?}");
}

#[tokio::test]
async fn changed_host_key_prompts_with_changed_flag() {
    let addr = start_ssh_server().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());

    let host_key = format!("[{}]:{}", addr.ip(), addr.port());
    std::fs::write(
        state.path().join("known_hosts"),
        format!("{host_key} ssh-ed25519 AAAAstalekeydoesnotmatch\n"),
    )
    .unwrap();

    let mut ws = daemon_ws(state.path()).await;
    ws.send(Message::text(connect_msg(1, addr, &key_path)))
        .await
        .unwrap();
    let (request, changed) = expect_host_key(&mut ws).await;
    assert_eq!(request, 1);
    assert!(changed, "a different recorded key must set changed=true");

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshHostKeyAnswer {
            request: 1,
            accept: true,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let first = expect_created(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionKill {
            session: first.id,
            confirm_children: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    ws.send(Message::text(connect_msg(2, addr, &key_path)))
        .await
        .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionCreated { info } if info.agent == proto::AgentKind::Ssh => {
                break
            }
            proto::ServerMsg::SshHostKey { .. } => {
                panic!("the overwritten key is now trusted — no second prompt")
            }
            proto::ServerMsg::Error { message, .. } => panic!("connect error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn ssh_husks_are_deferred_never_auto_reconnected() {
    let state = tempfile::tempdir().unwrap();
    {
        let db = houston_core::db::Db::open(&state.path().join("test.db")).unwrap();
        db.insert_session(&proto::SessionInfo {
            id: 1,
            agent: proto::AgentKind::Ssh,
            project_dir: "tester@example.com".into(),
            cwd: "tester@example.com".into(),
            state: proto::SessionState::Running,
            title: "Remote".into(),
            codename: "Remote".into(),
            detected_agent: None,
            hidden: false,
            ssh_host: Some("tester@example.com".into()),
            restore_deferred: None,
            status: None,
            swarm_agent: None,
            spawned_by: None,
            acp: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: vec![],
        })
        .unwrap();
        std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();
    }

    let mut ws = daemon_ws(state.path()).await;
    let sessions = {
        let list = serde_json::to_string(&proto::ClientMsg::SessionList).unwrap();
        ws.send(Message::text(list)).await.unwrap();
        loop {
            match next_control(&mut ws).await {
                proto::ServerMsg::SessionList { sessions } => break sessions,
                _ => continue,
            }
        }
    };
    let ssh = sessions.iter().find(|s| s.id == 1).expect("husk present");
    assert_eq!(ssh.restore_deferred, Some(proto::RestoreReason::Ssh));
    assert_ne!(
        ssh.restore_deferred,
        Some(proto::RestoreReason::InvalidCwd),
        "user@host cwd must not be read as invalid-cwd"
    );
}

async fn expect_profiles(ws: &mut WsStream) -> Vec<proto::SshProfile> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SshProfiles { profiles, .. } => return profiles,
            proto::ServerMsg::Error { message, .. } => panic!("error: {message}"),
            _ => continue,
        }
    }
}

#[test]
fn profile_wishes_persist_and_last_used_is_daemon_owned() {
    let state = tempfile::tempdir().unwrap();
    let db = houston_core::db::Db::open(&state.path().join("t.db")).unwrap();

    let mut p = proto::SshProfile {
        name: "prod".into(),
        host: "example.com".into(),
        port: 2222,
        user: "deploy".into(),
        auth: proto::SshAuth::Agent,
        has_credential: false,
        default_dir: Some("/srv/app".into()),
        startup_cmd: Some("tmux attach".into()),
        last_used_at: Some(999),
    };
    db.save_ssh_profile(&p).unwrap();

    let got = db.list_ssh_profiles().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].default_dir.as_deref(), Some("/srv/app"));
    assert_eq!(got[0].startup_cmd.as_deref(), Some("tmux attach"));
    assert_eq!(
        got[0].last_used_at, None,
        "a client cannot assert when it last connected"
    );

    db.touch_ssh_profile("prod").unwrap();
    let stamped = db.list_ssh_profiles().unwrap()[0].last_used_at;
    assert!(stamped.is_some(), "touch records the connection");

    p.default_dir = Some("/srv/other".into());
    p.last_used_at = None;
    db.save_ssh_profile(&p).unwrap();
    let after = &db.list_ssh_profiles().unwrap()[0];
    assert_eq!(after.default_dir.as_deref(), Some("/srv/other"));
    assert_eq!(
        after.last_used_at, stamped,
        "editing a profile keeps its history"
    );
}

#[test]
fn touching_a_deleted_profile_is_not_an_error() {
    let state = tempfile::tempdir().unwrap();
    let db = houston_core::db::Db::open(&state.path().join("t.db")).unwrap();
    db.touch_ssh_profile("never-existed").unwrap();
}

async fn connect_ssh_session(
    ws: &mut WsStream,
    addr: std::net::SocketAddr,
    key_path: &str,
    request: u32,
) -> proto::SessionInfo {
    ws.send(Message::text(connect_msg(request, addr, key_path)))
        .await
        .unwrap();
    let _ = expect_host_key(ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshHostKeyAnswer {
            request,
            accept: true,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    expect_created(ws).await
}

#[tokio::test]
async fn ssh_upload_sends_the_file_and_reports_the_remote_path() {
    let (addr, exec) = start_ssh_server_recording().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;
    let info = connect_ssh_session(&mut ws, addr, &key_path, 1).await;

    let body: Vec<u8> = (0..80_000u32).map(|i| (i % 251) as u8).collect();
    let local = keydir.path().join("notes.txt");
    std::fs::write(&local, &body).unwrap();

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshUploadTerminalFile {
            request: 9,
            session: info.id,
            local_path: local.display().to_string(),
            remote_name: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    let (request, session, remote_path, bytes) = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SshUploadDone {
                request,
                session,
                remote_path,
                bytes,
            } => break (request, session, remote_path, bytes),
            proto::ServerMsg::Error { message, .. } => panic!("upload error: {message}"),
            _ => continue,
        }
    };
    assert_eq!((request, session), (9, info.id));
    assert_eq!(bytes, body.len() as u64);
    assert_eq!(
        remote_path, FAKE_REMOTE_PATH,
        "the reported path is the one the FAR SIDE printed, not one predicted here"
    );

    let record = exec.lock().unwrap();
    assert_eq!(record.stdin, body, "every byte arrived, in order");
    assert!(
        record.command.contains("b='notes.txt'"),
        "command: {}",
        record.command
    );
    assert!(
        record.command.contains("while [ -e \"$p\" ]"),
        "no-clobber loop is part of what the remote side runs: {}",
        record.command
    );
}

#[tokio::test]
async fn ssh_upload_renames_on_the_way_over_when_asked() {
    let (addr, exec) = start_ssh_server_recording().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;
    let info = connect_ssh_session(&mut ws, addr, &key_path, 1).await;

    let local = keydir.path().join("tauri-drop-1234.bin");
    std::fs::write(&local, b"hi").unwrap();
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshUploadTerminalFile {
            request: 3,
            session: info.id,
            local_path: local.display().to_string(),
            remote_name: Some("relatório final.pdf".into()),
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SshUploadDone { .. } => break,
            proto::ServerMsg::Error { message, .. } => panic!("upload error: {message}"),
            _ => continue,
        }
    }
    assert!(
        exec.lock()
            .unwrap()
            .command
            .contains("b='relatório final.pdf'"),
        "command: {}",
        exec.lock().unwrap().command
    );
}

#[tokio::test]
async fn ssh_upload_refuses_a_local_session_and_a_path_shaped_name() {
    let (addr, _exec) = start_ssh_server_recording().await;
    let state = tempfile::tempdir().unwrap();
    let keydir = tempfile::tempdir().unwrap();
    let key_path = write_client_key(keydir.path());
    let mut ws = daemon_ws(state.path()).await;
    let info = connect_ssh_session(&mut ws, addr, &key_path, 1).await;
    let local = keydir.path().join("notes.txt");
    std::fs::write(&local, b"x").unwrap();

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshUploadTerminalFile {
            request: 4,
            session: info.id,
            local_path: local.display().to_string(),
            remote_name: Some("../../.ssh/authorized_keys".into()),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let message = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => break message,
            proto::ServerMsg::SshUploadDone { remote_path, .. } => {
                panic!("a path-shaped name must not upload (landed at {remote_path})")
            }
            _ => continue,
        }
    };
    assert!(message.contains("path separator"), "message: {message}");
    assert!(
        message.contains("authorized_keys"),
        "the refusal names the offending value: {message}"
    );

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshUploadTerminalFile {
            request: 5,
            session: info.id,
            local_path: keydir.path().join("gone.txt").display().to_string(),
            remote_name: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let message = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => break message,
            proto::ServerMsg::SshUploadDone { .. } => panic!("a missing file must not upload"),
            _ => continue,
        }
    };
    assert!(message.contains("gone.txt"), "message: {message}");

    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "sleep 30"],
        state.path(),
    )))
    .await
    .unwrap();
    let shell = expect_created(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SshUploadTerminalFile {
            request: 6,
            session: shell.id,
            local_path: local.display().to_string(),
            remote_name: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let message = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => break message,
            proto::ServerMsg::SshUploadDone { .. } => panic!("a local pane must not upload"),
            _ => continue,
        }
    };
    assert!(message.contains("not an SSH session"), "message: {message}");
}

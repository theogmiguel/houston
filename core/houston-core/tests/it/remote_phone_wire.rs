#![cfg(unix)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::db::Db;
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use proto::RemoteTier;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.body))
    }

    fn error(&self) -> String {
        self.json()["error"]
            .as_str()
            .unwrap_or_else(|| panic!("no error in {}", self.body))
            .to_string()
    }
}

async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Reply {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: {addr}\r\n");
    if let Some(token) = token {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(body) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(body) = body {
        req.push_str(body);
    }
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(20), stream.read_to_end(&mut raw))
        .await
        .expect("response within 20 s")
        .unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").expect("a complete response");
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    Reply { status, body }
}

fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        body = &rest[n + 2..];
    }
    out
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn enable(daemon: &Daemon) -> SocketAddr {
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{}", free_port())),
            ..Default::default()
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(addr) = daemon.remote_listen_state().listening {
            return addr;
        }
        assert!(tokio::time::Instant::now() < deadline, "no listener");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A daemon with remote access on and one paired device at `tier`.
async fn phone(tier: RemoteTier) -> (Arc<Daemon>, SocketAddr, String, i64, tempfile::TempDir) {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Test phone" }).to_string();
    let reply = request(addr, "POST", "/api/pair", None, Some(&body)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let token = reply.json()["token"].as_str().unwrap().to_string();
    let id = reply.json()["device_id"].as_i64().unwrap();
    daemon.remote_device_set_tier(id, tier).unwrap();
    (daemon, addr, token, id, state)
}

fn pane(daemon: &Arc<Daemon>, cmd: &[&str]) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
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
    (info, dir)
}

#[test]
fn devices_paired_before_tiers_existed_migrate_to_drive() {
    let state = tempfile::tempdir().unwrap();
    let path = state.path().join("legacy.db");
    drop(Db::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE remote_devices DROP COLUMN tier;
             INSERT INTO remote_devices (name, token_hash, created_at, last_seen_at)
             VALUES ('Old phone', 'hash-old', 1, 1);",
        )
        .unwrap();
    }
    let db = Db::open(&path).unwrap();
    let devices = db.remote_devices().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "Old phone");
    assert_eq!(devices[0].tier, RemoteTier::Drive);
    let id = db.remote_device_insert("New phone", "hash-new", 2).unwrap();
    let fresh = db.remote_device_by_hash("hash-new").unwrap().unwrap();
    assert_eq!((fresh.id, fresh.tier), (id, RemoteTier::Drive));
}

#[tokio::test]
async fn a_new_pairing_is_drive_and_me_reports_the_tier() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let _state = state;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Fresh" }).to_string();
    let reply = request(addr, "POST", "/api/pair", None, Some(&body)).await;
    let token = reply.json()["token"].as_str().unwrap().to_string();
    let me = request(addr, "GET", "/api/me", Some(&token), None).await;
    assert_eq!(me.status, 200, "{}", me.body);
    assert_eq!(me.json()["tier"], "drive");
    match daemon.remote_state_msg() {
        proto::ServerMsg::RemoteState { remote } => {
            assert_eq!(remote.devices[0].tier, RemoteTier::Drive)
        }
        other => panic!("expected remote_state, got {other:?}"),
    }
}

#[tokio::test]
async fn observe_reads_but_is_refused_input_decisions_and_dictation() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = pane(&daemon, &["sh", "-c", "echo ready; sleep 30"]);
    let id = info.id;
    for path in ["/api/me", "/api/sessions", "/api/activity"] {
        let reply = request(addr, "GET", path, Some(&token), None).await;
        assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    }
    let screen = request(
        addr,
        "GET",
        &format!("/api/sessions/{id}/screen"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(screen.status, 200, "{}", screen.body);

    let attempts = [
        (
            format!("/api/sessions/{id}/input"),
            r#"{"text":"echo nope"}"#,
        ),
        (
            format!("/api/sessions/{id}/decide"),
            r#"{"epoch":"x","entry_seq":1,"choice":"approve"}"#,
        ),
        (format!("/api/sessions/{id}/dictate"), ""),
    ];
    for (path, body) in attempts {
        let reply = request(addr, "POST", &path, Some(&token), Some(body)).await;
        assert_eq!(reply.status, 403, "{path}: {}", reply.body);
        let message = reply.error();
        assert!(
            message.contains("paired as observe")
                && message.contains(&format!("POST {}", path.replace(&id.to_string(), "{id}")))
                && message.contains("needs drive")
                && message.contains("Settings > Phone & remote access > Paired devices"),
            "{message}"
        );
    }
    let screen = request(
        addr,
        "GET",
        &format!("/api/sessions/{id}/screen?lines=40"),
        Some(&token),
        None,
    )
    .await;
    assert!(
        !screen.body.contains("nope"),
        "a refused input reached the pane: {}",
        screen.body
    );
}

#[tokio::test]
async fn a_tier_change_applies_to_the_devices_next_request_and_reverses() {
    let (daemon, addr, token, id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = pane(
        &daemon,
        &["sh", "-c", "read line; echo got:$line; sleep 30"],
    );
    let path = format!("/api/sessions/{}/input", info.id);
    let body = r#"{"text":"hello"}"#;
    assert_eq!(
        request(addr, "POST", &path, Some(&token), Some(body))
            .await
            .status,
        403
    );
    daemon
        .remote_device_set_tier(id, RemoteTier::Drive)
        .unwrap();
    let sent = request(addr, "POST", &path, Some(&token), Some(body)).await;
    assert_eq!(sent.status, 200, "{}", sent.body);
    daemon
        .remote_device_set_tier(id, RemoteTier::Observe)
        .unwrap();
    assert_eq!(
        request(addr, "POST", &path, Some(&token), Some(body))
            .await
            .status,
        403
    );
    let err = daemon
        .remote_device_set_tier(id + 100, RemoteTier::Manage)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(&format!("{}", id + 100)) && err.contains("device list"),
        "{err}"
    );
}

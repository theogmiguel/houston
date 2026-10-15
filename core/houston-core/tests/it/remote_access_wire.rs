#![cfg(unix)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Reply {
    status: u16,
    headers: String,
    body: String,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.body))
    }
}

/// A raw HTTP/1.1 exchange, so a test controls every header the client sends.
async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Reply {
    let body = body.map(|b| ("application/json", b.as_bytes()));
    exchange(addr, method, path, headers, body).await
}

async fn exchange(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<(&str, &[u8])>,
) -> Reply {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        req.push_str(&format!("Host: {addr}\r\n"));
    }
    // An empty value omits the header, so a test can send a request with no Host.
    for (k, v) in headers.iter().filter(|(_, v)| !v.is_empty()) {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    let declared = headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
    if let Some((content_type, body)) = body {
        req.push_str(&format!("Content-Type: {content_type}\r\n"));
        if !declared {
            req.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
    }
    req.push_str("\r\n");
    let mut raw_req = req.into_bytes();
    if let Some((_, body)) = body {
        raw_req.extend_from_slice(body);
    }
    stream.write_all(&raw_req).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut raw))
        .await
        .expect("response within 10 s")
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
    Reply {
        status,
        headers: head.to_string(),
        body,
    }
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

async fn wait_listening(daemon: &Daemon) -> SocketAddr {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let state = daemon.remote_listen_state();
        if let Some(addr) = state.listening {
            return addr;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "remote listener never came up: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A daemon with remote access on at a free loopback port.
async fn remote_daemon() -> (Arc<Daemon>, SocketAddr, tempfile::TempDir) {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let port = free_port();
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{port}")),
            ..Default::default()
        })
        .unwrap();
    let addr = wait_listening(&daemon).await;
    (daemon, addr, state)
}

async fn pair(daemon: &Daemon, addr: SocketAddr) -> (String, i64) {
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Test phone" }).to_string();
    let reply = request(addr, "POST", "/api/pair", &[], Some(&body)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let v = reply.json();
    (
        v["token"].as_str().unwrap().to_string(),
        v["device_id"].as_i64().unwrap(),
    )
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

async fn screen_until(addr: SocketAddr, token: &str, id: u32, needle: &str) -> String {
    let auth = format!("Bearer {token}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let reply = request(
            addr,
            "GET",
            &format!("/api/sessions/{id}/screen?lines=40"),
            &[("Authorization", &auth)],
            None,
        )
        .await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        let text = reply.json()["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if text.contains(needle) {
            return text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{needle:?} never appeared on pane {id}'s screen: {text:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn the_listener_is_off_by_default_and_follows_the_setting() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!daemon.remote_config().enabled);
    assert_eq!(daemon.remote_listen_state().listening, None);

    let port = free_port();
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{port}")),
            ..Default::default()
        })
        .unwrap();
    let addr = wait_listening(&daemon).await;
    assert_eq!(addr.port(), port);

    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(false),
            ..Default::default()
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while daemon.remote_listen_state().listening.is_some()
        || tokio::net::TcpStream::connect(addr).await.is_ok()
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "turning remote access off left {addr} accepting connections"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn invalid_settings_are_refused_with_the_value_and_shape() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some("127.0.0.1:0".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("127.0.0.1:0") && err.contains("port 0"),
        "{err}"
    );
    assert!(
        !daemon.remote_config().enabled,
        "a refused patch changes nothing, including its valid fields"
    );
    let err = daemon
        .remote_configure(ConfigPatch {
            public_url: Some("https://box.ts.net/path".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(err.contains("box.ts.net/path"), "{err}");
}

#[tokio::test]
async fn the_web_client_is_served_with_a_strict_policy() {
    let (_daemon, addr, _state) = remote_daemon().await;
    let reply = request(addr, "GET", "/", &[], None).await;
    assert_eq!(reply.status, 200);
    assert!(reply.body.contains("Connect your phone"));
    let headers = reply.headers.to_ascii_lowercase();
    assert!(headers.contains(
        "content-security-policy: default-src 'none'; script-src 'self'; style-src 'self';"
    ));
    assert!(headers.contains("x-frame-options: deny"));
    for (path, kind) in [("/app.js", "text/javascript"), ("/app.css", "text/css")] {
        let asset = request(addr, "GET", path, &[], None).await;
        assert_eq!(asset.status, 200, "{path}");
        assert!(
            asset
                .headers
                .to_ascii_lowercase()
                .contains(&format!("content-type: {kind}")),
            "{path}: {}",
            asset.headers
        );
    }
    let manifest = request(addr, "GET", "/manifest.webmanifest", &[], None).await;
    assert_eq!(manifest.status, 200);
    assert_eq!(manifest.json()["display"], "standalone");
    assert_eq!(
        request(addr, "GET", "/icon-192.png", &[], None)
            .await
            .status,
        200
    );
    assert_eq!(
        request(addr, "GET", "/apple-touch-icon.png", &[], None)
            .await
            .status,
        200
    );
    let font = request(addr, "GET", "/fonts/sans-400.woff2", &[], None).await;
    assert_eq!(font.status, 200);
    assert!(font
        .headers
        .to_ascii_lowercase()
        .contains("content-type: font/woff2"));
    assert_eq!(
        request(addr, "GET", "/fonts/other.woff2", &[], None)
            .await
            .status,
        404
    );
    assert_eq!(request(addr, "GET", "/ws", &[], None).await.status, 404);
    assert_eq!(
        request(addr, "GET", "/orchestrate/list", &[], None)
            .await
            .status,
        404
    );
}

#[tokio::test]
async fn a_pairing_code_pairs_once_and_the_token_authenticates() {
    let (daemon, addr, _state) = remote_daemon().await;
    let pairing = daemon.remote_pair_start();
    assert!(pairing.url.ends_with(&format!("/#pair={}", pairing.code)));
    assert_eq!(pairing.code.len(), 32);

    let body = serde_json::json!({ "code": pairing.code, "device_name": "  Pixel  " }).to_string();
    let first = request(addr, "POST", "/api/pair", &[], Some(&body)).await;
    assert_eq!(first.status, 200, "{}", first.body);
    let token = first.json()["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64, "256 bits in hex");

    let again = request(addr, "POST", "/api/pair", &[], Some(&body)).await;
    assert_eq!(again.status, 401, "a code works once: {}", again.body);

    let auth = format!("Bearer {token}");
    let me = request(addr, "GET", "/api/me", &[("Authorization", &auth)], None).await;
    assert_eq!(me.status, 200, "{}", me.body);
    assert_eq!(me.json()["name"], "Pixel");

    let devices = daemon.remote_devices().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "Pixel");
}

#[tokio::test]
async fn an_expired_pairing_code_is_refused() {
    let (daemon, addr, _state) = remote_daemon().await;
    let code = daemon.remote_pair_start().code;
    daemon.remote.expire_pairing_for_test();
    let body = serde_json::json!({ "code": code, "device_name": "Late" }).to_string();
    let reply = request(addr, "POST", "/api/pair", &[], Some(&body)).await;
    assert_eq!(reply.status, 401);
    assert!(reply.body.contains("expired"), "{}", reply.body);
    assert!(daemon.remote_devices().unwrap().is_empty());
}

#[tokio::test]
async fn the_api_refuses_a_missing_or_revoked_token() {
    let (daemon, addr, _state) = remote_daemon().await;
    let none = request(addr, "GET", "/api/sessions", &[], None).await;
    assert_eq!(none.status, 401);
    assert!(none.body.contains("Authorization: Bearer"), "{}", none.body);

    let (token, id) = pair(&daemon, addr).await;
    let auth = format!("Bearer {token}");
    let ok = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(ok.status, 200, "{}", ok.body);

    daemon.remote_device_revoke(id).unwrap();
    let revoked = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(revoked.status, 401, "{}", revoked.body);
    let err = daemon.remote_device_revoke(id).unwrap_err().to_string();
    assert!(err.contains(&id.to_string()), "{err}");
}

#[tokio::test]
async fn a_foreign_host_or_origin_is_refused() {
    let (daemon, addr, _state) = remote_daemon().await;
    let rebound = request(addr, "GET", "/", &[("Host", "attacker.example:80")], None).await;
    assert_eq!(rebound.status, 421, "{}", rebound.body);
    assert!(
        rebound.body.contains("attacker.example"),
        "{}",
        rebound.body
    );

    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "x" }).to_string();
    let cross = request(
        addr,
        "POST",
        "/api/pair",
        &[("Origin", "https://attacker.example")],
        Some(&body),
    )
    .await;
    assert_eq!(cross.status, 403, "{}", cross.body);

    daemon
        .remote_configure(ConfigPatch {
            public_url: Some("https://box.tail1.ts.net".into()),
            ..Default::default()
        })
        .unwrap();
    let proxied = request(
        addr,
        "POST",
        "/api/pair",
        &[
            ("Host", "box.tail1.ts.net"),
            ("Origin", "https://box.tail1.ts.net"),
        ],
        Some(&body),
    )
    .await;
    assert_eq!(proxied.status, 200, "{}", proxied.body);
}

#[tokio::test]
async fn repeated_failures_lock_authentication_out() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    for _ in 0..houston_core::remote::AUTH_FAILURE_LIMIT {
        let reply = request(
            addr,
            "GET",
            "/api/sessions",
            &[("Authorization", "Bearer wrong")],
            None,
        )
        .await;
        assert_eq!(reply.status, 401);
    }
    let auth = format!("Bearer {token}");
    let valid = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(
        valid.status, 200,
        "a paired device keeps working during a lockout: {}",
        valid.body
    );
    let locked = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", "Bearer wrong")],
        None,
    )
    .await;
    assert_eq!(locked.status, 429, "{}", locked.body);
    assert!(
        locked.body.contains("limit is 10 per 60 s"),
        "the refusal names the limit: {}",
        locked.body
    );
    assert!(locked.headers.to_ascii_lowercase().contains("retry-after:"));
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "x" }).to_string();
    let pairing = request(addr, "POST", "/api/pair", &[], Some(&body)).await;
    assert_eq!(pairing.status, 429, "pairing shares the lockout");
}

#[tokio::test]
async fn oversized_bodies_and_missing_hosts_are_refused() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let auth = format!("Bearer {token}");
    let (info, _dir) = pane(&daemon, &["cat"]);
    let huge = serde_json::json!({ "text": "x".repeat(40 * 1024) }).to_string();
    let reply = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", info.id),
        &[("Authorization", &auth)],
        Some(&huge),
    )
    .await;
    assert_eq!(reply.status, 413, "{}", reply.body);

    let hostless = request(addr, "GET", "/", &[("Host", "")], None).await;
    assert_eq!(hostless.status, 421, "{}", hostless.body);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn an_origin_on_another_port_is_refused() {
    let (daemon, addr, _state) = remote_daemon().await;
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "x" }).to_string();
    let other_port = request(
        addr,
        "POST",
        "/api/pair",
        &[("Origin", "http://localhost:3000")],
        Some(&body),
    )
    .await;
    assert_eq!(other_port.status, 403, "{}", other_port.body);
    let same = request(
        addr,
        "POST",
        "/api/pair",
        &[("Origin", &format!("http://127.0.0.1:{}", addr.port()))],
        Some(&body),
    )
    .await;
    assert_eq!(same.status, 200, "{}", same.body);
}

#[tokio::test]
async fn binding_every_interface_needs_a_public_url() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .remote_configure(ConfigPatch {
            bind: Some("0.0.0.0:47999".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("0.0.0.0:47999") && err.contains("public URL"),
        "{err}"
    );
    daemon
        .remote_configure(ConfigPatch {
            bind: Some("0.0.0.0:47999".into()),
            public_url: Some("https://192.168.1.20:47999".into()),
            ..Default::default()
        })
        .unwrap();
}

#[tokio::test]
async fn multi_line_text_needs_the_program_to_accept_a_paste() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let auth = format!("Bearer {token}");
    let (plain, _d1) = pane(&daemon, &["sh", "-c", "echo PLAIN-READY; exec cat"]);
    screen_until(addr, &token, plain.id, "PLAIN-READY").await;
    let two_lines = serde_json::json!({ "text": "line-one\nline-two" }).to_string();
    let refused = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", plain.id),
        &[("Authorization", &auth)],
        Some(&two_lines),
    )
    .await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert!(refused.body.contains("bracketed paste"), "{}", refused.body);

    let (pasting, _d2) = pane(
        &daemon,
        &[
            "sh",
            "-c",
            "printf '\\033[?2004h'; echo PASTE-READY; exec cat",
        ],
    );
    screen_until(addr, &token, pasting.id, "PASTE-READY").await;
    let accepted = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", pasting.id),
        &[("Authorization", &auth)],
        Some(&two_lines),
    )
    .await;
    assert_eq!(accepted.status, 200, "{}", accepted.body);
    screen_until(addr, &token, pasting.id, "line-two").await;
    daemon.kill(plain.id).ok();
    daemon.kill(pasting.id).ok();
}

#[tokio::test]
async fn sessions_list_needs_input_first() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (idle, _d1) = pane(&daemon, &["sleep", "30"]);
    let (waiting, _d2) = pane(&daemon, &["sleep", "30"]);
    let (working, _d3) = pane(&daemon, &["sleep", "30"]);
    daemon.handle_hook(idle.id, "Stop", None);
    daemon.handle_hook(working.id, "UserPromptSubmit", None);
    daemon.handle_hook(waiting.id, "UserPromptSubmit", None);
    daemon.handle_hook(waiting.id, "PermissionRequest", None);
    assert_eq!(
        daemon.session_status(waiting.id).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );

    let auth = format!("Bearer {token}");
    let reply = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let v = reply.json();
    let list = v["sessions"].as_array().unwrap();
    let ids: Vec<u64> = list.iter().map(|s| s["id"].as_u64().unwrap()).collect();
    assert_eq!(
        ids,
        vec![waiting.id as u64, working.id as u64, idle.id as u64]
    );
    assert_eq!(list[0]["status"], "needs-input");
    assert!(list[0]["status_since"].as_u64().is_some());
    assert!(list[0]["workspace"]["path"].as_str().is_some());
    assert!(list[0]["workspace"]["name"].as_str().is_some());
    assert_eq!(list[0]["kind"], "custom");
    for info in [idle, waiting, working] {
        daemon.kill(info.id).ok();
    }
}

#[tokio::test]
async fn input_reaches_the_pty_and_the_screen_shows_it() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sh", "-c", "echo REMOTE-READY; exec cat"]);
    screen_until(addr, &token, info.id, "REMOTE-READY").await;

    let auth = format!("Bearer {token}");
    let body = serde_json::json!({ "text": "hello-from-phone", "keys": ["enter"] }).to_string();
    let reply = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", info.id),
        &[("Authorization", &auth)],
        Some(&body),
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    // The tty echo lands before cat's copy; wait for both lines, not the first.
    let text = screen_until(addr, &token, info.id, "hello-from-phone\nhello-from-phone").await;
    assert!(
        text.matches("hello-from-phone").count() >= 2,
        "the tty echoes the line and cat repeats it after Enter: {text:?}"
    );

    let escape = serde_json::json!({ "text": "\u{1b}[201~" }).to_string();
    let refused = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", info.id),
        &[("Authorization", &auth)],
        Some(&escape),
    )
    .await;
    assert_eq!(refused.status, 400, "{}", refused.body);

    let bad_key = serde_json::json!({ "keys": ["f13"] }).to_string();
    let refused = request(
        addr,
        "POST",
        &format!("/api/sessions/{}/input", info.id),
        &[("Authorization", &auth)],
        Some(&bad_key),
    )
    .await;
    assert_eq!(refused.status, 400);
    assert!(refused.body.contains("f13"), "{}", refused.body);

    let unknown = request(
        addr,
        "GET",
        "/api/sessions/999999/screen",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(unknown.status, 404);
    let too_many = request(
        addr,
        "GET",
        &format!("/api/sessions/{}/screen?lines=500", info.id),
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(too_many.status, 400);
    assert!(too_many.body.contains("500"), "{}", too_many.body);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn me_describes_the_host_and_configured_connection() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let auth = format!("Bearer {token}");
    let me = request(addr, "GET", "/api/me", &[("Authorization", &auth)], None).await;
    assert_eq!(me.status, 200);
    let me = me.json();
    assert_eq!(me["name"], "Test phone");
    assert_eq!(me["host"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(!me["host"]["name"].as_str().unwrap().is_empty());
    assert!(me["host"]["name"].as_str().unwrap().chars().count() <= 128);
    assert_eq!(
        me["connection"],
        serde_json::json!({"url":format!("http://{addr}"),"https":false})
    );
    daemon
        .remote_configure(ConfigPatch {
            public_url: Some("https://box.tail1.ts.net".into()),
            ..Default::default()
        })
        .unwrap();
    let me = request(addr, "GET", "/api/me", &[("Authorization", &auth)], None)
        .await
        .json();
    assert_eq!(
        me["connection"],
        serde_json::json!({"url":"https://box.tail1.ts.net","https":true})
    );
}

#[tokio::test]
async fn sessions_expose_null_orchestration_fields_for_root_panes() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let auth = format!("Bearer {token}");
    let response = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(response.status, 200);
    let page = response.json();
    let row = page["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == info.id)
        .unwrap();
    assert_eq!(row.get("parent"), Some(&serde_json::Value::Null));
    assert_eq!(row.get("role"), Some(&serde_json::Value::Null));
    daemon.kill(info.id).unwrap();
}

#[tokio::test]
async fn sessions_carry_the_published_grids_restricted_to_listed_panes() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (first, _d1) = pane(&daemon, &["sleep", "30"]);
    let (second, _d2) = pane(&daemon, &["sleep", "30"]);
    let grid = |id: &str, name: &str, sessions: Vec<u32>| proto::RemoteGrid {
        workspace: "/projects/api".into(),
        id: id.into(),
        name: name.into(),
        sessions,
    };
    daemon
        .remote_grids_publish(vec![
            // A pane closed since the publish is dropped from the grid.
            grid("g1", "Auth work", vec![first.id, 9999, second.id]),
            // A pane already placed stays in the first grid, leaving this one empty.
            grid("g2", "Duplicate", vec![second.id]),
            grid("g3", "Gone", vec![9998]),
        ])
        .unwrap();

    let auth = format!("Bearer {token}");
    let reply = request(
        addr,
        "GET",
        "/api/sessions",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let grids = reply.json()["grids"].clone();
    assert_eq!(
        grids,
        serde_json::json!([{
            "workspace": "/projects/api",
            "id": "g1",
            "name": "Auth work",
            "sessions": [first.id, second.id],
        }])
    );
    for info in [first, second] {
        daemon.kill(info.id).ok();
    }
}

/// `secs` of a 440 Hz tone at `amplitude`, as the dictation route takes it.
fn pcm16(secs: f32, amplitude: f32) -> Vec<u8> {
    let n = (secs * 16_000.0) as usize;
    (0..n)
        .flat_map(|i| {
            let t = i as f32 / 16_000.0;
            let v = (t * 440.0 * std::f32::consts::TAU).sin() * amplitude;
            ((v * 32767.0) as i16).to_le_bytes()
        })
        .collect()
}

async fn dictate(addr: SocketAddr, token: &str, id: u32, pcm: &[u8]) -> Reply {
    let auth = format!("Bearer {token}");
    exchange(
        addr,
        "POST",
        &format!("/api/sessions/{id}/dictate"),
        &[("Authorization", &auth)],
        Some(("application/octet-stream", pcm)),
    )
    .await
}

fn allow_dictation(daemon: &Daemon) {
    daemon
        .remote_configure(ConfigPatch {
            dictation: Some(true),
            ..Default::default()
        })
        .unwrap();
}

/// The settings check only asks that a model file is on disk; it is never loaded
/// by these tests, which stop at a refusal or the speech gate.
fn install_placeholder_model(daemon: &Daemon) {
    let dir = daemon.voice_models_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ggml-small.bin"), vec![7u8; 4096]).unwrap();
}

#[tokio::test]
async fn dictation_is_refused_until_the_operator_allows_it() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["cat"]);
    let auth = format!("Bearer {token}");

    let me = request(addr, "GET", "/api/me", &[("Authorization", &auth)], None).await;
    assert_eq!(me.json()["dictation"], false, "{}", me.body);
    let reply = dictate(addr, &token, info.id, &pcm16(1.0, 0.5)).await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    assert!(
        reply.body.contains("Allow dictation from paired devices"),
        "the refusal names the setting: {}",
        reply.body
    );

    allow_dictation(&daemon);
    let me = request(addr, "GET", "/api/me", &[("Authorization", &auth)], None).await;
    assert_eq!(me.json()["dictation"], true, "{}", me.body);

    let unpaired = exchange(
        addr,
        "POST",
        &format!("/api/sessions/{}/dictate", info.id),
        &[],
        Some(("application/octet-stream", &pcm16(1.0, 0.5))),
    )
    .await;
    assert_eq!(unpaired.status, 401, "{}", unpaired.body);
    let missing = dictate(addr, &token, 999_999, &pcm16(1.0, 0.5)).await;
    assert_eq!(missing.status, 404, "{}", missing.body);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn dictation_names_a_missing_model_or_key() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["cat"]);
    allow_dictation(&daemon);

    let reply = dictate(addr, &token, info.id, &pcm16(1.0, 0.5)).await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert!(reply.body.contains("ggml-small"), "{}", reply.body);

    daemon
        .voice_settings_set(&proto::VoiceSettings {
            engine: proto::VoiceEngine::Cloud {
                provider: proto::CloudStt::Groq,
            },
            mic_policy: proto::MicPolicy::OnKeypress,
            ..proto::VoiceSettings::default()
        })
        .unwrap();
    let reply = dictate(addr, &token, info.id, &pcm16(1.0, 0.5)).await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert!(reply.body.contains("no Groq API key"), "{}", reply.body);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn dictation_refuses_a_recording_over_two_minutes_before_reading_it() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["cat"]);
    allow_dictation(&daemon);
    install_placeholder_model(&daemon);

    let auth = format!("Bearer {token}");
    let declared = (120 * 16_000 * 2 + 2).to_string();
    let reply = exchange(
        addr,
        "POST",
        &format!("/api/sessions/{}/dictate", info.id),
        &[("Authorization", &auth), ("Content-Length", &declared)],
        Some(("application/octet-stream", &[])),
    )
    .await;
    assert_eq!(reply.status, 413, "{}", reply.body);
    assert!(
        reply.body.contains("3840002 bytes") && reply.body.contains("120 s"),
        "the refusal names the value and the limit: {}",
        reply.body
    );

    let odd = dictate(addr, &token, info.id, &[1, 2, 3]).await;
    assert_eq!(odd.status, 400, "{}", odd.body);
    assert!(odd.body.contains("3 bytes"), "{}", odd.body);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_silent_recording_stops_at_the_speech_gate_without_the_host_microphone() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["cat"]);
    allow_dictation(&daemon);
    install_placeholder_model(&daemon);

    let quiet = dictate(addr, &token, info.id, &pcm16(1.0, 0.0)).await;
    assert_eq!(quiet.status, 422, "{}", quiet.body);
    assert!(quiet.body.contains("too quiet"), "{}", quiet.body);
    let short = dictate(addr, &token, info.id, &pcm16(0.1, 0.5)).await;
    assert_eq!(short.status, 422, "{}", short.body);
    assert!(short.body.contains("too short"), "{}", short.body);

    assert!(
        !daemon.voice.is_open(),
        "remote dictation never opens this computer's microphone"
    );
    assert_eq!(daemon.voice.listening_for(), None);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_remote_recording_waits_while_the_desktop_transcribes() {
    let (daemon, addr, _state) = remote_daemon().await;
    let (token, _) = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["cat"]);
    allow_dictation(&daemon);
    install_placeholder_model(&daemon);

    let desktop = daemon.voice.claim_engine_desktop();
    let reply = dictate(addr, &token, info.id, &pcm16(1.0, 0.5)).await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert!(
        reply.body.contains("desktop is transcribing"),
        "{}",
        reply.body
    );
    drop(desktop);

    let reply = dictate(addr, &token, info.id, &pcm16(1.0, 0.0)).await;
    assert_eq!(
        reply.status, 422,
        "with the engine free the recording reaches the gate: {}",
        reply.body
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn the_recorder_worklet_is_served_from_the_listener() {
    let (_daemon, addr, _state) = remote_daemon().await;
    let reply = request(addr, "GET", "/pcm-worklet.js", &[], None).await;
    assert_eq!(reply.status, 200);
    assert!(reply
        .headers
        .to_ascii_lowercase()
        .contains("content-type: text/javascript"));
    assert!(reply.body.contains("registerProcessor(\"pcm-capture\""));
}

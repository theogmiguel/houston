#![cfg(unix)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let exe = dir.join("codex");
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    })
    .clone()
}

async fn send(ws: &mut common::WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

#[tokio::test]
async fn get_resolves_claude_as_default_and_names_every_refusal() {
    let _guard = SERIAL.lock().await;
    let prior_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", "");

    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    send(&mut ws, &proto::ClientMsg::HeadlessRolesGet).await;
    let reply = next_control(&mut ws).await;

    std::env::set_var("PATH", prior_path);

    let proto::ServerMsg::HeadlessRoles { writer } = reply else {
        panic!("expected headless_roles, got {reply:?}");
    };

    let view = &writer;
    assert_eq!(view.engine, proto::AgentKind::Claude);
    assert!(view.engine_is_default);
    assert!(view.model.is_none());
    assert!(view.model_is_default);

    let claude = view
        .engines
        .iter()
        .find(|o| o.engine == proto::AgentKind::Claude)
        .expect("Claude is always a row");
    assert!(!claude.enabled, "no engine binary was left on PATH");
    assert_eq!(claude.reason.as_deref(), Some("not found on PATH"));

    let antigravity = view
        .engines
        .iter()
        .find(|o| o.engine == proto::AgentKind::Antigravity)
        .expect("Antigravity is always a row");
    assert!(!antigravity.enabled);
    assert!(
        antigravity
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("Google")),
        "{:?}",
        antigravity.reason
    );

    let cursor = view
        .engines
        .iter()
        .find(|o| o.engine == proto::AgentKind::Cursor)
        .expect("Cursor is always a row");
    assert!(!cursor.enabled);
    assert_eq!(
        cursor.reason.as_deref(),
        Some("Panes only. No verified headless stream.")
    );
}

#[tokio::test]
async fn set_to_an_installed_codex_with_no_model_is_accepted_and_broadcast() {
    let _guard = SERIAL.lock().await;
    let dir = shim_dir();
    let prior_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", dir.display().to_string());

    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::HeadlessRoleSet {
            role: proto::HeadlessRoleKind::Writer,
            engine: Some(proto::AgentKind::Codex),
            model: None,
        },
    )
    .await;
    let reply = next_control(&mut ws).await;

    std::env::set_var("PATH", prior_path);

    let proto::ServerMsg::HeadlessRoles { writer } = reply else {
        panic!("expected headless_roles broadcast, got {reply:?}");
    };
    assert_eq!(writer.engine, proto::AgentKind::Codex);
    assert!(!writer.engine_is_default);
    assert!(writer.model.is_none());
}

#[tokio::test]
async fn set_to_antigravity_is_refused_naming_the_reason() {
    let _guard = SERIAL.lock().await;
    let prior_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", "");

    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::HeadlessRoleSet {
            role: proto::HeadlessRoleKind::Writer,
            engine: Some(proto::AgentKind::Antigravity),
            model: None,
        },
    )
    .await;
    let reply = next_control(&mut ws).await;

    std::env::set_var("PATH", prior_path);

    let proto::ServerMsg::Error { message, .. } = reply else {
        panic!("expected error, got {reply:?}");
    };
    assert!(
        message.contains("Antigravity") || message.contains("antigravity"),
        "{message}"
    );
    assert!(message.contains("Google"), "{message}");
}

#[tokio::test]
async fn set_a_model_off_claudes_list_is_refused_naming_the_list() {
    let _guard = SERIAL.lock().await;
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::HeadlessRoleSet {
            role: proto::HeadlessRoleKind::Writer,
            engine: None,
            model: Some("gpt-5".to_string()),
        },
    )
    .await;
    let reply = next_control(&mut ws).await;
    let proto::ServerMsg::Error { message, .. } = reply else {
        panic!("expected error, got {reply:?}");
    };
    assert!(message.contains("gpt-5"), "{message}");
    assert!(message.contains("sonnet"), "{message}");
}

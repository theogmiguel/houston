#![cfg(unix)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const PROGRAM: &str = r#"
import os, select, sys, tty
sys.stdin.buffer.readline()
tty.setraw(0)
os.write(1, b'\x1b]7501;?\x1b\\')
reply = b''
while len(reply) < 10:
    if not select.select([0], [], [], 10)[0]:
        raise RuntimeError('program status support probe unanswered')
    reply += os.read(0, 10 - len(reply))
assert reply == b'\x1b]7501;?\x1b\\', repr(reply)
os.write(1, b'\x1b]7501;state=working:app=fixture\x07')
while True:
    body = b''
    while not body.endswith(b'\n'):
        body += os.read(0, 1)
    os.write(1, b'\x1b]7501;' + body.rstrip(b'\n') + b'\x07')
    os.write(1, b'processed\r\n')
"#;

fn spawn(daemon: &Arc<Daemon>, project: &std::path::Path) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: project.to_owned(),
            cmd: Some(vec![
                "python3".into(),
                "-u".into(),
                "-c".into(),
                PROGRAM.into(),
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
        .unwrap()
        .id
}

async fn wait_status(daemon: &Daemon, id: u32, wanted: proto::AgentStatus) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while daemon.session_status(id).unwrap() != Some(wanted) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "session {id}: expected {wanted:?}, got {:?}",
            daemon.session_status(id)
        )
    });
}

async fn probe_and_reports(watched: bool) {
    let (addr, tmp, daemon) = start_daemon_with_handle().await;
    let id = spawn(&daemon, tmp.path());
    let mut ws = connect_and_hello(addr, TOKEN).await;
    assert!(matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::HelloOk { .. }
    ));
    if watched {
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionAttach {
                session: id,
                replay_bytes: None,
                snapshot: None,
                from_offset: None,
                generation: None,
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        loop {
            if matches!(next_control(&mut ws).await, proto::ServerMsg::Scrollback { session, .. } if session == id)
            {
                break;
            }
        }
    }
    daemon.write_stdin(id, b"start\n").unwrap();
    wait_status(&daemon, id, proto::AgentStatus::Working).await;
    loop {
        if matches!(next_control(&mut ws).await, proto::ServerMsg::AgentStatus { session, status: proto::AgentStatus::Working } if session == id)
        {
            break;
        }
    }
    for (body, wanted) in [
        (
            "state=blocked:kind=permission",
            proto::AgentStatus::NeedsInput,
        ),
        ("state=working", proto::AgentStatus::Working),
        ("state=done", proto::AgentStatus::Idle),
        (
            "state=blocked:kind=question",
            proto::AgentStatus::NeedsInput,
        ),
        ("state=error", proto::AgentStatus::Idle),
        ("state=clear", proto::AgentStatus::Unavailable),
    ] {
        daemon
            .write_stdin(id, format!("{body}\n").as_bytes())
            .unwrap();
        wait_status(&daemon, id, wanted).await;
    }
    daemon.kill(id).unwrap();
}

#[tokio::test]
async fn a_detached_program_negotiates_support_and_reports_status() {
    probe_and_reports(false).await;
}

#[tokio::test]
async fn a_watched_program_negotiates_support_without_a_renderer_reply() {
    probe_and_reports(true).await;
}

#[tokio::test]
async fn hooks_take_precedence_over_program_status_until_respawn() {
    let (_addr, tmp, daemon) = start_daemon_with_handle().await;
    let id = spawn(&daemon, tmp.path());
    daemon.write_stdin(id, b"start\n").unwrap();
    wait_status(&daemon, id, proto::AgentStatus::Working).await;
    daemon.handle_hook(id, "PermissionRequest", None);
    wait_status(&daemon, id, proto::AgentStatus::NeedsInput).await;
    daemon.write_stdin(id, b"state=idle\n").unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let replay = daemon.scrollback(id, None).unwrap();
            if String::from_utf8_lossy(&replay.data).contains("processed") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );
    daemon.kill(id).unwrap();
}

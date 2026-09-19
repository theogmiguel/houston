#![cfg(unix)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

const FAKE_GIT_SLEEP_SECS: u32 = 3;

fn install_slow_git() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let bin = tempfile::tempdir().unwrap();
    let git = bin.path().join("git");
    std::fs::write(
        &git,
        format!("#!/bin/sh\nsleep {FAKE_GIT_SLEEP_SECS}\nexit 0\n"),
    )
    .unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", bin.path().display()));
    bin
}

#[tokio::test]
#[cfg(unix)]
async fn a_slow_control_handler_does_not_hold_a_resize_ack() {
    let (addr, _state) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let work = tempfile::tempdir().unwrap();
    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "sleep 30"],
        work.path(),
    )))
    .await
    .unwrap();
    let info = expect_created(&mut ws).await;

    let _bin = install_slow_git();
    let git_status = serde_json::to_string(&proto::ClientMsg::GitStatus {
        dir: work.path().display().to_string(),
        base: None,
    })
    .unwrap();
    let resize = serde_json::to_string(&proto::ClientMsg::SessionResize {
        session: info.id,
        cols: 120,
        rows: 40,
    })
    .unwrap();
    ws.send(Message::text(git_status)).await.unwrap();
    let asked = Instant::now();
    ws.send(Message::text(resize)).await.unwrap();

    let budget = Duration::from_millis(1_000);
    let acked = tokio::time::timeout(budget, async {
        loop {
            match next_control(&mut ws).await {
                proto::ServerMsg::SessionResized {
                    session,
                    cols,
                    rows,
                } if session == info.id => {
                    assert_eq!((cols, rows), (120, 40), "the ack echoes what the PTY took");
                    break asked.elapsed();
                }
                proto::ServerMsg::GitStatus { .. } => {
                    panic!("the slow git status answered before the resize it was sent ahead of")
                }
                _ => continue,
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "no resize ack within {budget:?} while a {FAKE_GIT_SLEEP_SECS}s git status was \
             in flight — a control handler is holding the connection loop"
        )
    });
    assert!(
        acked < budget,
        "the ack came back inside the window it was read in: {acked:?}"
    );
}

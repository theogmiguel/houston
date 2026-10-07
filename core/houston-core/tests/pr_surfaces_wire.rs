#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn batch_status_and_failed_action_logs_are_bounded_wire_replies() {
    let _guard = SERIAL.lock().await;
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    let repo = state.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    let bin = state.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = state.path().join("gh.log");
    let gh = bin.join("gh");
    std::fs::write(&gh, format!(r#"#!/bin/sh
echo "$*" >> '{}'
case "$1" in
  --version) echo 'gh version 2.0.0'; exit 0;;
  auth) exit 0;;
  api) echo theo; exit 0;;
  pr) echo '{{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","title":"Change","headRefName":"feature","additions":2,"deletions":1,"isDraft":false}}'; exit 0;;
  run) i=0; while [ "$i" -lt 50 ]; do echo "failed-line-$i"; i=$((i + 1)); done; exit 0;;
esac
exit 1
"#, log.display())).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let previous_path = std::env::var_os("PATH");
    std::env::set_var(
        "PATH",
        format!(
            "{}:{}",
            bin.display(),
            previous_path
                .as_deref()
                .unwrap_or_default()
                .to_string_lossy()
        ),
    );

    let mut ws = connect_and_hello(addr, TOKEN).await;
    while !matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::HelloOk { .. }
    ) {}
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::PrStatusBatch {
            dirs: vec![repo.display().to_string(), repo.display().to_string()],
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    for _ in 0..2 {
        loop {
            match next_control(&mut ws).await {
                proto::ServerMsg::PrStatus { pr: Some(pr), .. } => {
                    assert_eq!(pr.title, "Change");
                    assert_eq!((pr.additions, pr.deletions), (2, 1));
                    break;
                }
                _ => continue,
            }
        }
    }
    let gh_calls = std::fs::read_to_string(&log).unwrap();
    assert_eq!(
        gh_calls.matches("pr view").count(),
        1,
        "the second batch item should use the daemon cache"
    );

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::PrCheckLog {
            dir: repo.display().to_string(),
            run_id: 42,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::PrCheckLog {
                run_id,
                lines,
                truncated,
                available,
                ..
            } => {
                assert_eq!(run_id, 42);
                assert_eq!(lines.len(), 40);
                assert_eq!(lines.first().map(String::as_str), Some("failed-line-10"));
                assert!(truncated && available);
                break;
            }
            _ => continue,
        }
    }
    if let Some(path) = previous_path {
        std::env::set_var("PATH", path);
    } else {
        std::env::remove_var("PATH");
    }
}

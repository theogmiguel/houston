//! Live handoffs keep their prompt and result files under the workspace's
//! `.houston/`; the workspace's own `git status` must never see them.

#![allow(clippy::disallowed_methods)]

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use tokio_tungstenite::tungstenite::Message;

fn run_git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn source_argv() -> Vec<&'static str> {
    #[cfg(unix)]
    {
        vec!["sh", "-c", "echo src; sleep 600"]
    }
    #[cfg(windows)]
    {
        vec!["cmd", "/C", "echo src & ping -n 601 127.0.0.1 > nul"]
    }
}

fn generator_argv() -> Vec<&'static str> {
    #[cfg(unix)]
    {
        vec![
            "sh",
            "-c",
            "printf '<<<START>>>\\n## Summary\\ngenerated-handoff-body\\n<<<END>>>\\n'",
            "sh",
        ]
    }
    #[cfg(windows)]
    {
        vec![
            "powershell",
            "-NoProfile",
            "-Command",
            "Write-Output '<<<START>>>', '## Summary', 'generated-handoff-body', '<<<END>>>'",
        ]
    }
}

async fn generate(ws: &mut WsStream, session: u32, cmd: Vec<&str>) {
    let msg = serde_json::to_string(&proto::ClientMsg::HandoffGenerate {
        session,
        provider: proto::AgentKind::Custom,
        cmd: Some(cmd.into_iter().map(String::from).collect()),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
}

#[tokio::test]
async fn a_finished_live_handoff_leaves_nothing_untracked_in_the_workspace() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    run_git(project.path(), &["init", "-b", "main"]);
    run_git(project.path(), &["config", "core.autocrlf", "false"]);
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        source_argv(),
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "src").await;

    generate(&mut ws, source, generator_argv()).await;
    let request = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffStarted { request, .. } => break request,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    };
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffDone { request: r, .. } if r == request => break,
            proto::ServerMsg::HandoffError { message, .. } => {
                panic!("handoff failed: {message}")
            }
            _ => continue,
        }
    }

    let status = git_out(project.path(), &["status", "--porcelain"]);
    assert!(
        !status.contains(".houston"),
        "the workspace's git status must not list Houston's handoff files: {status:?}"
    );
}

#[tokio::test]
async fn an_orphaned_handoff_prompt_older_than_a_day_is_swept_at_boot() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let add = serde_json::to_string(&proto::ClientMsg::WorkspaceAdd {
        path: project.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(add)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { .. } => break,
            _ => continue,
        }
    }

    let tr_dir = project.path().join(".houston");
    std::fs::create_dir_all(&tr_dir).unwrap();
    let orphan = tr_dir.join("handoff-prompt-1000000000.md");
    std::fs::write(&orphan, b"orphaned prompt").unwrap();
    let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 24 * 60 * 60);
    let file = std::fs::File::options().write(true).open(&orphan).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(stale))
        .unwrap();
    // A prompt younger than the stale age belongs to a handoff that may still run.
    let fresh = tr_dir.join("handoff-prompt-1999999999.md");
    std::fs::write(&fresh, b"live prompt").unwrap();

    daemon.sweep_orphan_handoff_prompts();

    assert!(
        !orphan.exists(),
        "a day-old orphaned prompt must be swept: {}",
        orphan.display()
    );
    assert!(
        fresh.exists(),
        "a live handoff's prompt must survive the sweep: {}",
        fresh.display()
    );
}

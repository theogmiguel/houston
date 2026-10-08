#![cfg(target_os = "linux")]
#![allow(clippy::disallowed_methods)]

mod common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use common::{connect_and_hello, next_control, start_daemon_with_handle, WsStream, TOKEN};

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "test@example.invalid"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README.md"), "checkout identity\n").unwrap();
    git(dir, &["add", "README.md"]);
    git(dir, &["commit", "-m", "initial"]);
}

fn shell_session(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.to_path_buf(),
            cmd: Some(vec!["sh".into(), "-c".into(), "sleep 60".into()]),
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
}

async fn wait_for_branch(ws: &mut WsStream, id: u32, expected: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match next_control(ws).await {
                proto::ServerMsg::SessionCheckout {
                    id: event_id,
                    checkout,
                } if event_id == id
                    && checkout.as_ref().and_then(|value| value.branch.as_deref())
                        == Some(expected) =>
                {
                    return
                }
                _ => {}
            }
        }
    })
    .await
    .expect("checkout branch update should arrive within two seconds");
}

#[tokio::test]
async fn reports_primary_checkout_and_live_branch_switches() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(houston_core::checkout_watch::checkout_watch_loop(
        daemon.clone(),
    ));
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let session = shell_session(&daemon, repo.path());
    assert!(matches!(
        session.checkout.as_ref().map(|checkout| &checkout.kind),
        Some(proto::CheckoutKind::Primary)
    ));

    git(repo.path(), &["switch", "-c", "x"]);
    wait_for_branch(&mut ws, session.id, "x").await;
    daemon.kill(session.id).ok();
}

#[tokio::test]
async fn identifies_a_managed_worktree_by_its_slug() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let worktree = daemon
        .git_worktree_create(repo.path(), "checkout-slug", None)
        .unwrap();
    let session = shell_session(&daemon, &worktree.path);
    assert!(matches!(
        session.checkout.as_ref().map(|checkout| &checkout.kind),
        Some(proto::CheckoutKind::Worktree { slug }) if slug == "checkout-slug"
    ));
    daemon.kill(session.id).ok();
}

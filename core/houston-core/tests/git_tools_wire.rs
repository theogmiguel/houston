#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use tokio_tungstenite::tungstenite::Message;

fn git(dir: &Path, args: &[&str]) {
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

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

/// The next control message, whatever it is. Tests that expect a specific one
/// match on it; a reply the test did not expect panics rather than hangs.
async fn next(ws: &mut WsStream) -> proto::ServerMsg {
    next_control(ws).await
}

fn no_error(msg: proto::ServerMsg) -> proto::ServerMsg {
    if let proto::ServerMsg::Error { message, .. } = &msg {
        panic!("daemon error: {message}");
    }
    msg
}

async fn expect_error(ws: &mut WsStream) -> String {
    for _ in 0..8 {
        if let proto::ServerMsg::Error { message, .. } = next(ws).await {
            return message;
        }
    }
    panic!("no error arrived")
}

async fn expect_branches(ws: &mut WsStream) -> proto::ServerMsg {
    loop {
        match no_error(next(ws).await) {
            m @ proto::ServerMsg::GitBranches { .. } => return m,
            _ => continue,
        }
    }
}

async fn expect_worktrees(ws: &mut WsStream) -> proto::ServerMsg {
    loop {
        match no_error(next(ws).await) {
            m @ proto::ServerMsg::GitWorktrees { .. } => return m,
            _ => continue,
        }
    }
}

async fn expect_checkpoints(ws: &mut WsStream) -> Vec<proto::GitCheckpointInfo> {
    loop {
        match no_error(next(ws).await) {
            proto::ServerMsg::GitCheckpoints { checkpoints, .. } => return checkpoints,
            _ => continue,
        }
    }
}

fn branch_names(msg: &proto::ServerMsg) -> Vec<String> {
    match msg {
        proto::ServerMsg::GitBranches { branches, .. } => {
            branches.iter().map(|b| b.name.clone()).collect()
        }
        other => panic!("expected git_branches, got {other:?}"),
    }
}

fn worktrees(msg: &proto::ServerMsg) -> Vec<proto::GitWorktreeInfo> {
    match msg {
        proto::ServerMsg::GitWorktrees { worktrees, .. } => worktrees.clone(),
        other => panic!("expected git_worktrees, got {other:?}"),
    }
}

fn worktree_message(msg: &proto::ServerMsg) -> Option<String> {
    match msg {
        proto::ServerMsg::GitWorktrees { message, .. } => message.clone(),
        other => panic!("expected git_worktrees, got {other:?}"),
    }
}

/// The `git_status` that follows every branch mutation, so a test can prove the
/// daemon pushed the working state as well as the list.
async fn expect_status(ws: &mut WsStream) {
    loop {
        match no_error(next(ws).await) {
            proto::ServerMsg::GitStatus { .. } => return,
            _ => continue,
        }
    }
}

#[tokio::test]
async fn branches_worktrees_and_checkpoints_read_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, &proto::ClientMsg::GitBranches { dir: dir.clone() }).await;
    let msg = expect_branches(&mut ws).await;
    assert_eq!(branch_names(&msg), vec!["main".to_string()]);
    match msg {
        proto::ServerMsg::GitBranches {
            default_branch,
            truncated,
            remotes,
            ..
        } => {
            assert_eq!(default_branch.as_deref(), Some("main"));
            assert!(!truncated);
            assert!(remotes.is_empty(), "no remote configured yet");
        }
        _ => unreachable!(),
    }

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktrees { dir: dir.clone() },
    )
    .await;
    let list = worktrees(&expect_worktrees(&mut ws).await);
    assert_eq!(list.len(), 1);
    assert!(list[0].is_main);
    assert_eq!(list[0].branch.as_deref(), Some("main"));

    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpoints { dir: dir.clone() },
    )
    .await;
    assert!(expect_checkpoints(&mut ws).await.is_empty());
}

#[tokio::test]
async fn a_branch_is_created_switched_renamed_and_deleted_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitBranchCreate {
            dir: dir.clone(),
            name: "feat/wire".to_string(),
            base: None,
            switch_to: true,
        },
    )
    .await;
    let msg = expect_branches(&mut ws).await;
    expect_status(&mut ws).await;
    match &msg {
        proto::ServerMsg::GitBranches { branches, .. } => {
            let created = branches.iter().find(|b| b.name == "feat/wire").unwrap();
            assert!(created.current, "switch_to checked the new branch out");
        }
        _ => unreachable!(),
    }

    send(
        &mut ws,
        &proto::ClientMsg::GitBranchSwitch {
            dir: dir.clone(),
            name: "main".to_string(),
        },
    )
    .await;
    let _ = expect_branches(&mut ws).await;
    expect_status(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitBranchRename {
            dir: dir.clone(),
            from: "feat/wire".to_string(),
            to: "feat/renamed".to_string(),
        },
    )
    .await;
    let names = branch_names(&expect_branches(&mut ws).await);
    expect_status(&mut ws).await;
    assert!(names.contains(&"feat/renamed".to_string()));
    assert!(!names.contains(&"feat/wire".to_string()));

    // Unmerged work refuses without `force`, naming the branch.
    std::fs::write(repo.path().join("work.txt"), "w\n").unwrap();
    git(
        repo.path(),
        &["checkout", "-b", "feat/unmerged", "feat/renamed"],
    );
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-m", "unmerged work"]);
    git(repo.path(), &["checkout", "main"]);
    send(
        &mut ws,
        &proto::ClientMsg::GitBranchDelete {
            dir: dir.clone(),
            name: "feat/unmerged".to_string(),
            force: false,
        },
    )
    .await;
    let err = expect_error(&mut ws).await;
    assert!(err.contains("feat/unmerged"), "{err}");

    send(
        &mut ws,
        &proto::ClientMsg::GitBranchDelete {
            dir: dir.clone(),
            name: "feat/unmerged".to_string(),
            force: true,
        },
    )
    .await;
    let names = branch_names(&expect_branches(&mut ws).await);
    expect_status(&mut ws).await;
    assert!(!names.contains(&"feat/unmerged".to_string()));
}

#[tokio::test]
async fn worktree_create_list_and_remove_over_the_wire() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreeCreate {
            dir: dir.clone(),
            name: "review".to_string(),
            base: None,
        },
    )
    .await;
    let msg = expect_worktrees(&mut ws).await;
    let created = worktree_message(&msg).expect("the create reply names its worktree");
    assert!(created.contains("houston/review"), "{created}");

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktrees { dir: dir.clone() },
    )
    .await;
    let list = worktrees(&expect_worktrees(&mut ws).await);
    let wt = list
        .iter()
        .find(|w| w.branch.as_deref() == Some("houston/review"))
        .expect("the new worktree is listed");
    assert!(!wt.is_main);
    assert!(!wt.dirty);
    let wt_path = wt.path.clone();

    std::fs::write(Path::new(&wt_path).join("scratch.txt"), "x\n").unwrap();
    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreeRemove {
            dir: dir.clone(),
            path: wt_path.clone(),
            force: false,
        },
    )
    .await;
    let err = expect_error(&mut ws).await;
    assert!(err.contains("uncommitted changes"), "{err}");

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreeRemove {
            dir: dir.clone(),
            path: wt_path.clone(),
            force: true,
        },
    )
    .await;
    let msg = expect_worktrees(&mut ws).await;
    assert!(worktree_message(&msg).unwrap().contains("Removed"));

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreePrune { dir: dir.clone() },
    )
    .await;
    let _ = expect_worktrees(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktrees { dir: dir.clone() },
    )
    .await;
    let list = worktrees(&expect_worktrees(&mut ws).await);
    assert!(
        !list
            .iter()
            .any(|w| w.branch.as_deref() == Some("houston/review")),
        "the removed worktree is gone from the list"
    );
    drop(daemon);
}

#[tokio::test]
async fn checkpoints_capture_inspect_restore_and_delete_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    std::fs::write(repo.path().join("README.md"), "hello\ncheckpoint\n").unwrap();
    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpointCreate {
            dir: dir.clone(),
            label: "first".to_string(),
        },
    )
    .await;
    let list = expect_checkpoints(&mut ws).await;
    assert_eq!(list.len(), 1);
    let cp = list[0].clone();
    assert_eq!(cp.label, "first");
    assert_eq!(cp.owner, "manual");
    assert!(cp.created_ms.is_some(), "the ref's own timestamp is listed");
    assert!(
        cp.r#ref.starts_with("refs/houston/checkpoints/"),
        "the reply carries the real ref: {}",
        cp.r#ref
    );

    // The same label again gets a free name instead of destroying the first.
    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpointCreate {
            dir: dir.clone(),
            label: "first".to_string(),
        },
    )
    .await;
    let list = expect_checkpoints(&mut ws).await;
    assert_eq!(list.len(), 2, "{list:?}");

    std::fs::write(repo.path().join("README.md"), "hello\ncheckpoint\nmore\n").unwrap();
    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpointDiff {
            dir: dir.clone(),
            r#ref: cp.r#ref.clone(),
            against: proto::GitCheckpointAgainst::Working,
        },
    )
    .await;
    let patch = loop {
        match no_error(next(&mut ws).await) {
            proto::ServerMsg::GitCheckpointDiff { patch, .. } => break patch,
            _ => continue,
        }
    };
    assert!(patch.contains("+more"), "{patch}");

    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpointRestore {
            dir: dir.clone(),
            r#ref: cp.r#ref.clone(),
        },
    )
    .await;
    let _ = expect_checkpoints(&mut ws).await;
    expect_status(&mut ws).await;
    assert_eq!(
        std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
        "hello\ncheckpoint\n",
        "the restore brought the snapshot back"
    );

    send(
        &mut ws,
        &proto::ClientMsg::GitCheckpointDelete {
            dir: dir.clone(),
            r#ref: cp.r#ref.clone(),
        },
    )
    .await;
    let list = expect_checkpoints(&mut ws).await;
    assert!(!list.iter().any(|c| c.r#ref == cp.r#ref), "{list:?}");
    assert_eq!(list.len(), 1);
}

#[tokio::test]
async fn pull_and_fetch_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let root = tempfile::tempdir().unwrap();
    let origin = root.path().join("origin.git");
    let out = Command::new("git")
        .args(["init", "--bare", origin.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());

    // The seed repository publishes the first commit before the second clone
    // exists, so both share one history.
    let repo = root.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "t@t.local"]);
    git(&repo, &["config", "user.name", "t"]);
    std::fs::write(repo.join("seed.txt"), "seed\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-m", "seed"]);
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&repo, &["push", "-u", "origin", "main"]);
    // The bare repo's HEAD defaults to whatever the machine's init branch is;
    // point it at main so the second clone checks out the same branch.
    git(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);

    let other = root.path().join("other");
    let out = Command::new("git")
        .args(["clone", origin.to_str().unwrap(), other.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    git(&other, &["config", "user.email", "t@t.local"]);
    git(&other, &["config", "user.name", "t"]);

    // The second clone publishes one commit the first one does not have.
    std::fs::write(other.join("new.txt"), "from elsewhere\n").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-m", "elsewhere"]);
    git(&other, &["push", "origin", "main"]);

    let dir = repo.display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, &proto::ClientMsg::GitFetch { dir: dir.clone() }).await;
    let summary = loop {
        match no_error(next(&mut ws).await) {
            proto::ServerMsg::GitFetch { summary, .. } => break summary,
            _ => continue,
        }
    };
    assert!(!summary.is_empty());

    send(&mut ws, &proto::ClientMsg::GitPull { dir: dir.clone() }).await;
    let status = loop {
        match no_error(next(&mut ws).await) {
            proto::ServerMsg::GitPull { status, .. } => break status,
            _ => continue,
        }
    };
    assert_eq!(status, proto::GitPullStatus::Pulled);
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).unwrap(),
        "from elsewhere\n"
    );

    send(&mut ws, &proto::ClientMsg::GitPull { dir: dir.clone() }).await;
    let status = loop {
        match no_error(next(&mut ws).await) {
            proto::ServerMsg::GitPull { status, .. } => break status,
            _ => continue,
        }
    };
    assert_eq!(status, proto::GitPullStatus::UpToDate);

    // A checkout with no upstream refuses by name instead of guessing.
    git(&repo, &["checkout", "-b", "detached-work"]);
    send(&mut ws, &proto::ClientMsg::GitPull { dir: dir.clone() }).await;
    let err = expect_error(&mut ws).await;
    assert!(err.contains("upstream"), "{err}");
}



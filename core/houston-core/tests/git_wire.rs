#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
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

fn git_stdout(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8(out.stdout).unwrap().trim().to_string()
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

struct StatusReply {
    dir: String,
    files: Vec<proto::GitFileStatus>,
    upstream: Option<String>,
    ahead: u32,
}

async fn expect_git_status(ws: &mut WsStream) -> StatusReply {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitStatus {
                dir,
                files,
                upstream,
                ahead,
                ..
            } => {
                return StatusReply {
                    dir,
                    files,
                    upstream,
                    ahead,
                }
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_git_commit(ws: &mut WsStream) -> (String, String) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitCommit { sha, summary, .. } => return (sha, summary),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_git_diff(ws: &mut WsStream) -> (Option<String>, String, bool) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitDiff {
                path,
                patch,
                truncated,
                ..
            } => return (path, patch, truncated),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[derive(Debug)]
struct BranchReply {
    dir: String,
    branch: Option<String>,
    toplevel: Option<String>,
    common_dir: Option<String>,
}

async fn expect_git_branch(ws: &mut WsStream) -> BranchReply {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitBranch {
                dir,
                branch,
                toplevel,
                common_dir,
            } => {
                return BranchReply {
                    dir,
                    branch,
                    toplevel,
                    common_dir,
                }
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn request_git_branch_commits(ws: &mut WsStream, dir: String) -> proto::ServerMsg {
    send(ws, &proto::ClientMsg::GitBranchCommits { dir }).await;
    loop {
        match next_control(ws).await {
            reply @ proto::ServerMsg::GitBranchCommits { .. }
            | reply @ proto::ServerMsg::Error { .. } => return reply,
            _ => continue,
        }
    }
}

// A read that cannot answer replies with nulls; an `error` envelope after it
// would be a second, contradictory answer. Nothing else is in flight in these
// tests, so a short quiet window is the evidence that no second answer came.
async fn expect_no_further_message(ws: &mut WsStream) {
    let quiet = tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => break t,
                Some(Ok(_)) => continue,
                other => panic!("socket ended while checking for a stray error: {other:?}"),
            }
        }
    })
    .await;
    assert!(
        quiet.is_err(),
        "expected no control message after the reply, got {quiet:?}"
    );
}

#[tokio::test]
async fn git_branch_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let reply = expect_git_branch(&mut ws).await;
    assert_eq!(reply.dir, dir);
    assert_eq!(reply.branch.as_deref(), Some("main"));
    let root = std::fs::canonicalize(repo.path()).unwrap();
    assert_eq!(
        reply
            .toplevel
            .as_deref()
            .map(|p| std::fs::canonicalize(p).unwrap()),
        Some(root.clone()),
        "the reply must carry the work tree's root"
    );
    let common = std::fs::canonicalize(root.join(".git")).unwrap();
    assert_eq!(
        reply
            .common_dir
            .as_deref()
            .map(|p| std::fs::canonicalize(p).unwrap()),
        Some(common),
        "the reply must carry the repository's common dir"
    );
}

#[tokio::test]
async fn git_branch_commits_over_the_wire_are_newest_first() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(repo.path(), &["checkout", "-b", "feature"]);
    for subject in ["first feature commit", "second feature commit"] {
        std::fs::write(repo.path().join("README.md"), format!("{subject}\n")).unwrap();
        git(repo.path(), &["add", "README.md"]);
        git(repo.path(), &["commit", "-m", subject]);
    }
    git(
        repo.path(),
        &["branch", "--set-upstream-to=main", "feature"],
    );

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();
    let reply = request_git_branch_commits(&mut ws, dir.clone()).await;
    let proto::ServerMsg::GitBranchCommits {
        dir: reply_dir,
        commits,
        total,
        truncated,
    } = reply
    else {
        panic!("expected branch commits reply, got {reply:?}");
    };
    assert_eq!(reply_dir, dir);
    assert_eq!(total, 2);
    assert!(!truncated);
    assert_eq!(
        commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>(),
        ["second feature commit", "first feature commit"]
    );
    assert!(commits.iter().all(|commit| commit.author_time_ms > 0));
}

#[tokio::test]
async fn git_branch_commits_report_when_the_cap_trims_the_reply() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(repo.path(), &["checkout", "-b", "feature"]);
    git(
        repo.path(),
        &["branch", "--set-upstream-to=main", "feature"],
    );

    let tree = git_stdout(repo.path(), &["rev-parse", "HEAD^{tree}"]);
    let mut parent = git_stdout(repo.path(), &["rev-parse", "HEAD"]);
    let total = houston_core::git::GIT_BRANCH_COMMITS_CAP + 1;
    for index in 0..total {
        parent = git_stdout(
            repo.path(),
            &[
                "commit-tree",
                &tree,
                "-p",
                &parent,
                "-m",
                &format!("commit {index}"),
            ],
        );
    }
    git(repo.path(), &["update-ref", "refs/heads/feature", &parent]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();
    let reply = request_git_branch_commits(&mut ws, dir).await;
    let proto::ServerMsg::GitBranchCommits {
        commits,
        total: actual,
        truncated,
        ..
    } = reply
    else {
        panic!("expected branch commits reply, got {reply:?}");
    };
    assert_eq!(actual, total as u64);
    assert_eq!(commits.len(), houston_core::git::GIT_BRANCH_COMMITS_CAP);
    assert!(truncated);
}

#[tokio::test]
async fn git_branch_commits_refuse_a_non_git_directory_by_name() {
    let (addr, _state) = start_daemon().await;
    let plain = tempfile::tempdir().unwrap();
    let dir = plain.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let reply = request_git_branch_commits(&mut ws, dir.clone()).await;
    let proto::ServerMsg::Error { message, .. } = reply else {
        panic!("expected a refused non-git directory, got {reply:?}");
    };
    assert!(message.contains(&dir), "error must name {dir:?}: {message}");
    assert!(message.contains("not a git repository"), "{message}");
}

#[tokio::test]
async fn git_branch_is_none_for_non_repo_and_does_not_error() {
    let (addr, _state) = start_daemon().await;
    let plain = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = plain.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let reply = expect_git_branch(&mut ws).await;
    assert_eq!(reply.dir, dir);
    assert_eq!(reply.branch, None);
    assert_eq!(reply.toplevel, None);
    assert_eq!(reply.common_dir, None);
    expect_no_further_message(&mut ws).await;
}

#[tokio::test]
async fn git_branch_over_the_wire_detached_head_keeps_identity() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(repo.path(), &["checkout", "--detach", "HEAD"]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let reply = expect_git_branch(&mut ws).await;
    assert_eq!(reply.dir, dir);
    assert_eq!(reply.branch, None, "a detached HEAD has no branch name");
    assert!(
        reply.toplevel.is_some(),
        "a detached HEAD is still inside a work tree: {reply:?}"
    );
    assert!(
        reply.common_dir.is_some(),
        "a detached HEAD still belongs to a repository: {reply:?}"
    );
}

#[tokio::test]
async fn git_branch_names_an_unborn_branch() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-b", "main"]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let reply = expect_git_branch(&mut ws).await;
    assert_eq!(reply.dir, dir);
    assert_eq!(
        reply.branch.as_deref(),
        Some("main"),
        "an unborn HEAD names the branch it points at"
    );
    assert!(
        reply.toplevel.is_some(),
        "an unborn repository is inside a work tree: {reply:?}"
    );
    assert!(
        reply.common_dir.is_some(),
        "an unborn repository has a common dir: {reply:?}"
    );
}

#[tokio::test]
async fn git_branch_separates_a_worktree_from_its_main_checkout() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let worktree = repo.path().join("wt");
    git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature/wt",
            worktree.to_str().unwrap(),
        ],
    );

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let main_dir = repo.path().display().to_string();
    let wt_dir = worktree.display().to_string();
    for dir in [&main_dir, &wt_dir] {
        let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
        ws.send(Message::text(msg)).await.unwrap();
    }
    let mut replies = Vec::new();
    for _ in 0..2 {
        replies.push(expect_git_branch(&mut ws).await);
    }

    let main = replies.iter().find(|r| r.dir == main_dir).unwrap();
    let wt = replies.iter().find(|r| r.dir == wt_dir).unwrap();
    assert_eq!(main.branch.as_deref(), Some("main"));
    assert_eq!(wt.branch.as_deref(), Some("feature/wt"));
    assert_eq!(
        main.common_dir, wt.common_dir,
        "a worktree shares the repository's common dir"
    );
    assert_ne!(
        main.toplevel, wt.toplevel,
        "a worktree is a separate checkout of the same repository"
    );
}

#[tokio::test]
async fn git_status_and_diff_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(repo.path().join("new.txt"), "brand new\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let status = serde_json::to_string(&proto::ClientMsg::GitStatus {
        dir: dir.clone(),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(status)).await.unwrap();
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.dir, dir);
    let readme = st.files.iter().find(|f| f.path == "README.md").unwrap();
    assert_eq!(readme.status, proto::GitFileState::Modified);
    assert_eq!(readme.added, Some(1));
    let new = st.files.iter().find(|f| f.path == "new.txt").unwrap();
    assert_eq!(new.status, proto::GitFileState::Untracked);

    let full = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: dir.clone(),
        path: None,
        base: None,
    })
    .unwrap();
    ws.send(Message::text(full)).await.unwrap();
    let (path, patch, truncated) = expect_git_diff(&mut ws).await;
    assert_eq!(path, None);
    assert!(!truncated);
    assert!(patch.contains("+world"));
    assert!(patch.contains("+brand new"));

    let single = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: dir.clone(),
        path: Some("new.txt".into()),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(single)).await.unwrap();
    let (path, patch, _) = expect_git_diff(&mut ws).await;
    assert_eq!(path.as_deref(), Some("new.txt"));
    assert!(patch.contains("+brand new"));
    assert!(!patch.contains("+world"));
}

#[tokio::test]
async fn oversized_diff_sets_the_truncation_flag() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(
        repo.path().join("big.txt"),
        "filler line for a very large diff\n".repeat(20_000),
    )
    .unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: repo.path().display().to_string(),
        path: None,
        base: None,
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let (_, patch, truncated) = expect_git_diff(&mut ws).await;
    assert!(truncated);
    assert!(patch.len() <= 512 * 1024);
}

// A directory without git is a normal workspace, not a failure: an error
// envelope here surfaces as an app-wide error on every Changes refresh.
#[tokio::test]
async fn non_git_dir_replies_not_a_repo_status() {
    let (addr, _state) = start_daemon().await;
    let plain = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::GitStatus {
        dir: plain.path().display().to_string(),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::GitStatus {
                not_a_repo, files, ..
            } => {
                assert!(not_a_repo, "a plain directory must reply not_a_repo");
                assert!(files.is_empty(), "a non-repo has no files: {files:?}");
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("unexpected error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_status_preserves_failure_for_a_broken_gitfile() {
    let (addr, _state) = start_daemon().await;
    let workspace = tempfile::tempdir().unwrap();
    let missing_git_dir = workspace.path().join("missing-metadata");
    std::fs::write(
        workspace.path().join(".git"),
        format!("gitdir: {}\n", missing_git_dir.display()),
    )
    .unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: workspace.path().display().to_string(),
            base: None,
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("not a git repository"),
                    "unexpected error: {message}"
                );
                break;
            }
            proto::ServerMsg::GitStatus { .. } => {
                panic!("a broken .git pointer must preserve Git's error")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_status_preserves_failure_for_an_empty_git_marker() {
    let (addr, _state) = start_daemon().await;
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join(".git")).unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: workspace.path().display().to_string(),
            base: None,
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("not a git repository"),
                    "unexpected error: {message}"
                );
                break;
            }
            proto::ServerMsg::GitStatus { .. } => {
                panic!("an empty .git marker must preserve Git's error")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_status_for_a_missing_directory_remains_an_error() {
    let (addr, _state) = start_daemon().await;
    let parent = tempfile::tempdir().unwrap();
    let missing = parent.path().join("missing-workspace");

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: missing.display().to_string(),
            base: None,
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, context } => {
                assert!(
                    message.contains("git target is not a directory"),
                    "unexpected error: {message}"
                );
                assert_eq!(context.as_deref(), Some("git_status"));
                break;
            }
            proto::ServerMsg::GitStatus { .. } => {
                panic!("a missing directory must remain an error")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_stage_and_commit_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("feature.txt"), "work\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: dir.clone(),
            base: None,
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    let f = st.files.iter().find(|f| f.path == "feature.txt").unwrap();
    assert!(!f.staged);
    assert_eq!(f.status, proto::GitFileState::Untracked);

    send(
        &mut ws,
        &proto::ClientMsg::GitStage {
            dir: dir.clone(),
            paths: vec!["feature.txt".into()],
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    let f = st.files.iter().find(|f| f.path == "feature.txt").unwrap();
    assert!(f.staged, "expected feature.txt staged");
    assert_eq!(f.status, proto::GitFileState::Added);

    send(
        &mut ws,
        &proto::ClientMsg::GitCommit {
            dir: dir.clone(),
            message: "add feature".into(),
        },
    )
    .await;
    let (sha, _summary) = expect_git_commit(&mut ws).await;
    assert!(sha.len() >= 7, "short sha: {sha}");
    let st = expect_git_status(&mut ws).await;
    assert!(st.files.is_empty(), "tree should be clean after commit");
}

#[tokio::test]
async fn git_push_to_bare_remote_clears_ahead() {
    let (addr, _state) = start_daemon().await;
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            &remote.path().display().to_string(),
        ],
    );
    git(repo.path(), &["push", "-u", "origin", "main"]);
    std::fs::write(repo.path().join("second.txt"), "more\n").unwrap();
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-m", "second"]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: dir.clone(),
            base: None,
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(st.ahead, 1);

    send(&mut ws, &proto::ClientMsg::GitPush { dir: dir.clone() }).await;
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.ahead, 0, "push should clear the ahead count");
}

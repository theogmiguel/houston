#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `shared.txt`'s ten lines with `edits` applied; edits several lines apart merge clean.
fn shared(edits: &[(usize, &str)]) -> String {
    (1..=10)
        .map(|n| match edits.iter().find(|(line, _)| *line == n) {
            Some((_, text)) => format!("{text}\n"),
            None => format!("line {n}\n"),
        })
        .collect()
}

fn commit_file(tree: &Path, file: &str, content: &str, message: &str) {
    std::fs::write(tree.join(file), content).unwrap();
    git(tree, &["add", file]);
    git(tree, &["commit", "-q", "-m", message]);
}

/// A live orchestrator pane, so its notes stay addressed to it.
fn orchestrator(daemon: &Arc<Daemon>, dir: &Path) -> u32 {
    #[cfg(unix)]
    let cmd = vec!["sh".into(), "-c".into(), "sleep 600".into()];
    // Childless, so closing the pane needs no descendant cleanup.
    #[cfg(windows)]
    let cmd = vec!["ping".into(), "-n".into(), "601".into(), "127.0.0.1".into()];
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd),
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

struct Repo {
    dir: PathBuf,
    common: String,
}

fn repo(root: &Path) -> Repo {
    let dir = root.join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "t@t.local"]);
    git(&dir, &["config", "user.name", "t"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    commit_file(&dir, "shared.txt", &shared(&[]), "init");
    let common = git(
        &dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    Repo { dir, common }
}

fn worktree(db: &rusqlite::Connection, repo: &Repo, slug: &str, creator: Option<u32>) -> PathBuf {
    let path = repo.dir.join(".houston").join("worktrees").join(slug);
    let branch = format!("houston/{slug}");
    git(
        &repo.dir,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            &branch,
            path.to_str().unwrap(),
        ],
    );
    db.execute(
        "INSERT INTO managed_worktrees
            (path, repo_common_dir, branch, base_branch, provenance, created_by_session, created_at_ms)
         VALUES (?1, ?2, ?3, 'main', 'pane_spawn', ?4, 0)",
        rusqlite::params![path.display().to_string(), repo.common, branch, creator],
    )
    .unwrap();
    path
}

/// Every conflict note in the inbox, as (recipient, summary, body).
fn notes(db: &rusqlite::Connection) -> Vec<(u32, String, String)> {
    let mut stmt = db
        .prepare(
            "SELECT to_session, summary, body FROM pane_inbox
             WHERE kind = 'operator_note' AND summary LIKE 'Predicted conflict:%' ORDER BY id",
        )
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

async fn tick(daemon: &Arc<Daemon>) {
    let daemon = daemon.clone();
    tokio::task::spawn_blocking(move || daemon.conflict_prediction_tick())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_new_conflict_between_worktrees_notes_its_orchestrator_once() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let a = worktree(&db, &repo, "a", Some(parent));
    let b = worktree(&db, &repo, "b", Some(parent));
    let c = worktree(&db, &repo, "c", Some(parent));
    commit_file(&a, "shared.txt", &shared(&[(1, "A")]), "a");
    commit_file(&b, "shared.txt", &shared(&[(1, "B")]), "b");
    commit_file(&c, "c.txt", "c\n", "c");

    tick(&daemon).await;
    let first = notes(&db);
    assert_eq!(
        first.len(),
        1,
        "only a and b touch the same line: {first:#?}"
    );
    let (to, summary, body) = &first[0];
    assert_eq!(*to, parent);
    assert_eq!(summary, "Predicted conflict: houston/a with houston/b");
    assert!(
        body.contains("would conflict in 1 file:\n- shared.txt"),
        "{body}"
    );

    tick(&daemon).await;
    commit_file(&b, "b.txt", "more\n", "b moves on, still conflicting");
    tick(&daemon).await;
    assert_eq!(notes(&db).len(), 1, "a persisting conflict is noted once");

    commit_file(&b, "shared.txt", &shared(&[(1, "A")]), "b takes a's line");
    tick(&daemon).await;
    assert_eq!(notes(&db).len(), 1);
    commit_file(&b, "shared.txt", &shared(&[(1, "C")]), "b diverges again");
    tick(&daemon).await;
    let recurred = notes(&db);
    assert_eq!(
        recurred.len(),
        2,
        "a conflict that cleared and recurs is noted again"
    );
    assert_eq!(
        recurred[1].1,
        "Predicted conflict: houston/a with houston/b"
    );

    commit_file(&repo.dir, "c.txt", "main's c\n", "main adds c.txt");
    tick(&daemon).await;
    let based = notes(&db);
    assert_eq!(based.len(), 3, "{based:#?}");
    assert_eq!(based[2].1, "Predicted conflict: houston/c into main");
    assert!(based[2].2.contains("into its base main"), "{}", based[2].2);

    let _ = daemon.kill(parent);
    let _ = daemon.close(parent);
}

#[tokio::test]
async fn worktrees_without_a_live_orchestrator_or_a_conflict_note_nothing() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let a = worktree(&db, &repo, "a", Some(parent));
    let b = worktree(&db, &repo, "b", Some(parent));
    let x = worktree(&db, &repo, "x", None);
    let y = worktree(&db, &repo, "y", None);
    // Created by a pane that is gone, with no live ancestor to inherit its notes.
    let p = worktree(&db, &repo, "p", Some(9999));
    let q = worktree(&db, &repo, "q", Some(9999));
    commit_file(&a, "shared.txt", &shared(&[(1, "A")]), "a");
    commit_file(
        &b,
        "shared.txt",
        &shared(&[(10, "B")]),
        "b edits another line",
    );
    commit_file(&x, "shared.txt", &shared(&[(1, "X")]), "x");
    commit_file(&y, "shared.txt", &shared(&[(1, "Y")]), "y");
    commit_file(&p, "shared.txt", &shared(&[(5, "P")]), "p");
    commit_file(&q, "shared.txt", &shared(&[(5, "Q")]), "q");

    // Two ticks: the first is capped below the pair count.
    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    // a conflicts with x and y; only those pairs have a live orchestrator to tell.
    assert_eq!(found.len(), 2, "{found:#?}");
    assert!(found.iter().all(|(to, _, _)| *to == parent));
    assert!(
        !found.iter().any(|(_, s, _)| s.contains("houston/b")),
        "b merges clean with everyone: {found:#?}"
    );
    assert!(
        !found
            .iter()
            .any(|(_, s, _)| s.contains("houston/x") && s.contains("houston/y")),
        "x and y conflict, but no orchestrator created either: {found:#?}"
    );
    assert!(
        !found
            .iter()
            .any(|(_, s, _)| s.contains("houston/p") && s.contains("houston/q")),
        "p and q conflict, but their orchestrator is closed: {found:#?}"
    );

    let _ = daemon.kill(parent);
    let _ = daemon.close(parent);
}

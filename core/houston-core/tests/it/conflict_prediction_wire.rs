#![allow(clippy::disallowed_methods)]

use crate::common;

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

/// Git before 2.38 has no `merge-tree --write-tree` (Ubuntu 22.04 ships 2.34); there the
/// daemon refuses by name, so each test checks that refusal instead of the predictions.
fn merge_tree_supported() -> bool {
    use houston_core::conflict_prediction as cp;
    cp::require_merge_tree(cp::git_version()).is_ok()
}

/// The old-Git refusal reaches the live orchestrator once, naming both versions.
async fn assert_refused_once(daemon: &Arc<Daemon>, db: &rusqlite::Connection, parent: u32) {
    let refusals = || -> Vec<(u32, String)> {
        let mut stmt = db
            .prepare(
                "SELECT to_session, body FROM pane_inbox
                 WHERE kind = 'operator_note' AND summary = 'Conflict prediction is unavailable'",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    tick(daemon).await;
    tick(daemon).await;
    let found = refusals();
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(found[0].0, parent);
    assert!(found[0].1.contains("is installed"), "{}", found[0].1);
    assert!(
        found[0].1.contains("needs Git 2.38 or newer"),
        "{}",
        found[0].1
    );
    assert!(notes(db).is_empty(), "an old Git predicts nothing");
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
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        let _ = daemon.kill(parent);
        let _ = daemon.close(parent);
        return;
    }

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
    // Worktrees with no creator are compared only while a session runs in them.
    let x_session = orchestrator(&daemon, &x);
    let y_session = orchestrator(&daemon, &y);
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
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        let _ = daemon.kill(parent);
        let _ = daemon.close(parent);
        return;
    }

    // Two ticks: the first is capped below the pair count.
    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    // a conflicts with x and y, which are the only pairs with a live orchestrator to tell:
    // one note to the orchestrator, listing both.
    assert_eq!(found.len(), 1, "{found:#?}");
    let (to, summary, body) = &found[0];
    assert_eq!(*to, parent);
    assert_eq!(
        summary,
        "Predicted conflict: houston/a with 2 other branches"
    );
    for listed in ["houston/x (", "houston/y ("] {
        assert!(body.contains(&format!("- {listed}")), "{body}");
    }
    for absent in ["houston/b", "houston/p", "houston/q"] {
        assert!(
            !body.contains(absent),
            "{absent} merges clean or has no live orchestrator: {body}"
        );
    }

    for session in [parent, x_session, y_session] {
        let _ = daemon.kill(session);
        let _ = daemon.close(session);
    }
}

/// Ends the panes a test started, whether or not it ran to the end.
fn end(daemon: &Arc<Daemon>, panes: &[u32]) {
    for pane in panes {
        let _ = daemon.kill(*pane);
        let _ = daemon.close(*pane);
    }
}

/// Notes that name two branches, as opposed to a branch and its base.
fn pair_notes(db: &rusqlite::Connection) -> Vec<(u32, String, String)> {
    notes(db)
        .into_iter()
        .filter(|(_, summary, _)| !summary.contains(" into "))
        .collect()
}

#[tokio::test]
async fn an_ended_orchestrators_worktree_and_a_new_empty_one_note_nothing() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let ended = orchestrator(&daemon, &repo.dir);
    let old = worktree(&db, &repo, "old", Some(ended));
    commit_file(&old, "shared.txt", &shared(&[(1, "OLD")]), "old");
    end(&daemon, &[ended]);
    commit_file(
        &repo.dir,
        "shared.txt",
        &shared(&[(1, "MAIN")]),
        "main moves",
    );
    let live = orchestrator(&daemon, &repo.dir);
    let _fresh = worktree(&db, &repo, "fresh", Some(live));
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, live).await;
        end(&daemon, &[live]);
        return;
    }

    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    assert!(found.is_empty(), "{found:#?}");

    end(&daemon, &[live]);
}

#[tokio::test]
async fn an_empty_worktree_beside_a_live_conflicting_sibling_has_no_pair_note() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let busy = worktree(&db, &repo, "busy", Some(parent));
    commit_file(&busy, "shared.txt", &shared(&[(1, "BUSY")]), "busy");
    commit_file(
        &repo.dir,
        "shared.txt",
        &shared(&[(1, "MAIN")]),
        "main moves",
    );
    let _fresh = worktree(&db, &repo, "fresh", Some(parent));
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        end(&daemon, &[parent]);
        return;
    }

    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    assert_eq!(
        found.iter().map(|(_, s, _)| s.as_str()).collect::<Vec<_>>(),
        vec!["Predicted conflict: houston/busy into main"],
        "busy still conflicts with its base, but an empty sibling adds no pair: {found:#?}"
    );

    end(&daemon, &[parent]);
}

#[tokio::test]
async fn a_squash_merged_sibling_notes_nothing() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let squashed = worktree(&db, &repo, "squashed", Some(parent));
    commit_file(&squashed, "shared.txt", &shared(&[(1, "SQ")]), "squashed 1");
    commit_file(&squashed, "extra.txt", "extra\n", "squashed 2");
    git(&repo.dir, &["merge", "--squash", "houston/squashed"]);
    git(&repo.dir, &["commit", "-q", "-m", "squash merge"]);
    commit_file(
        &repo.dir,
        "shared.txt",
        &shared(&[(1, "SQ"), (5, "MAIN5")]),
        "main moves",
    );
    let other = worktree(&db, &repo, "other", Some(parent));
    commit_file(
        &other,
        "shared.txt",
        &shared(&[(1, "OTHER"), (5, "MAIN5")]),
        "other",
    );
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        end(&daemon, &[parent]);
        return;
    }

    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    assert!(found.is_empty(), "{found:#?}");

    end(&daemon, &[parent]);
}

#[tokio::test]
async fn two_live_siblings_editing_the_same_line_note_exactly_once() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let first = orchestrator(&daemon, &repo.dir);
    let a = worktree(&db, &repo, "a", Some(parent));
    let b = worktree(&db, &repo, "b", Some(first));
    commit_file(&a, "shared.txt", &shared(&[(1, "A")]), "a");
    commit_file(&b, "shared.txt", &shared(&[(1, "B")]), "b");
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        end(&daemon, &[parent, first]);
        return;
    }

    tick(&daemon).await;
    tick(&daemon).await;
    let found = notes(&db);
    let mut recipients: Vec<u32> = found.iter().map(|(to, _, _)| *to).collect();
    recipients.sort();
    let mut expected = vec![parent, first];
    expected.sort();
    assert_eq!(
        recipients, expected,
        "one note per creating pane, none repeated: {found:#?}"
    );
    assert!(found
        .iter()
        .all(|(_, s, _)| s == "Predicted conflict: houston/a with houston/b"));

    end(&daemon, &[parent, first]);
}

#[tokio::test]
async fn a_branch_conflicting_with_several_siblings_gets_one_note_naming_them() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let parent = orchestrator(&daemon, &repo.dir);
    let hub = worktree(&db, &repo, "hub", Some(parent));
    let b = worktree(&db, &repo, "b", Some(parent));
    let c = worktree(&db, &repo, "c", Some(parent));
    commit_file(
        &hub,
        "shared.txt",
        &shared(&[(1, "HUB"), (10, "HUB")]),
        "hub",
    );
    commit_file(&b, "shared.txt", &shared(&[(1, "B")]), "b");
    commit_file(&c, "shared.txt", &shared(&[(10, "C")]), "c");
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        end(&daemon, &[parent]);
        return;
    }

    tick(&daemon).await;
    let found = notes(&db);
    assert_eq!(found.len(), 1, "{found:#?}");
    let (to, summary, body) = &found[0];
    assert_eq!(*to, parent);
    assert_eq!(
        summary,
        "Predicted conflict: houston/hub with 2 other branches"
    );
    for branch in ["houston/b", "houston/c"] {
        assert!(body.contains(&format!("- {branch} (")), "{body}");
    }
    assert!(body.contains("shared.txt"), "{body}");

    tick(&daemon).await;
    assert_eq!(
        notes(&db).len(),
        1,
        "a persisting conflict is not noted again"
    );

    end(&daemon, &[parent]);
}

#[tokio::test]
async fn a_note_reports_each_branch_tip_at_prediction_time() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let repo = repo(state.path());
    let base = git(&repo.dir, &["rev-parse", "--short=10", "main"]);
    let parent = orchestrator(&daemon, &repo.dir);
    let a = worktree(&db, &repo, "a", Some(parent));
    let b = worktree(&db, &repo, "b", Some(parent));
    commit_file(&a, "shared.txt", &shared(&[(1, "A")]), "a");
    commit_file(&b, "shared.txt", &shared(&[(1, "B")]), "b");
    if !merge_tree_supported() {
        assert_refused_once(&daemon, &db, parent).await;
        end(&daemon, &[parent]);
        return;
    }

    tick(&daemon).await;
    let found = pair_notes(&db);
    assert_eq!(found.len(), 1, "{found:#?}");
    let body = &found[0].2;
    for (branch, tree) in [("houston/a", &a), ("houston/b", &b)] {
        let tip = git(tree, &["rev-parse", "--short=10", "HEAD"]);
        assert_eq!(tip, git(&repo.dir, &["rev-parse", "--short=10", branch]));
        assert!(
            body.contains(&format!("{branch} ({tip}, worktree")),
            "{body}"
        );
    }
    assert!(
        !body.contains(&base),
        "the base commit is not a branch tip: {body}"
    );

    end(&daemon, &[parent]);
}

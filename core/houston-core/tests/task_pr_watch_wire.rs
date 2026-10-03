#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_protocol as proto;
use std::path::{Path, PathBuf};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The PATH before any test replaced it, so a test that needs `git` beside its
/// `gh` stub can still find it.
static ORIGINAL_PATH: std::sync::OnceLock<std::ffi::OsString> = std::sync::OnceLock::new();

struct Rig {
    daemon: std::sync::Arc<houston_core::daemon::Daemon>,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str) -> Rig {
    ORIGINAL_PATH.get_or_init(|| std::env::var_os("PATH").unwrap_or_default());
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws_dir = ws_dir.canonicalize().unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    Rig {
        daemon,
        state,
        ws_dir,
    }
}

impl Rig {
    fn workspace(&self) -> String {
        self.ws_dir.display().to_string()
    }

    fn db_path(&self) -> PathBuf {
        self.state.path().join("test.db")
    }

    /// A task in review with one handed-back run whose branch has a worktree
    /// directory to run `gh` in.
    fn in_review_task(&self, title: &str) -> (i64, i64, PathBuf) {
        let proto::ServerMsg::TaskChanged { id, .. } = self
            .daemon
            .task_save(
                &self.workspace(),
                None,
                None,
                proto::TaskPatch {
                    title: Some(title.to_string()),
                    ..Default::default()
                },
            )
            .unwrap()
        else {
            panic!("expected TaskChanged");
        };
        let proto::ServerMsg::TaskChanged { revision, .. } = self
            .daemon
            .task_save(
                &self.workspace(),
                Some(id),
                Some(1),
                proto::TaskPatch {
                    status: Some(proto::TaskStatus::InReview),
                    ..Default::default()
                },
            )
            .unwrap()
        else {
            panic!("expected TaskChanged");
        };
        let worktree = self.state.path().join(format!("tree-{id}"));
        std::fs::create_dir_all(&worktree).unwrap();
        let worktree = worktree.canonicalize().unwrap();
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.execute(
            "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, \
                 worktree_path, branch, initial_revision, summary, reason, started_at, ended_at) \
             VALUES (?1, 1, 'implementation', 'handed_back', 'grok', ?2, ?3, ?4, 'done', NULL, 0, \
                 1)",
            rusqlite::params![
                id,
                worktree.display().to_string(),
                "houston/task/hou-1-watched",
                1
            ],
        )
        .unwrap();
        let run_id = conn.last_insert_rowid();
        let _ = revision;
        (id, run_id, worktree)
    }

    fn task_status(&self, id: i64) -> String {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.query_row(
            "SELECT status FROM backlog_tasks WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn run_reason(&self, run_id: i64) -> Option<String> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.query_row(
            "SELECT reason FROM backlog_task_runs WHERE id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn history_actions(&self, task_id: i64) -> Vec<(String, String)> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT actor, action FROM backlog_task_history WHERE task_id = ?1 ORDER BY id",
            )
            .unwrap();
        stmt.query_map([task_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
}

fn write_stub_gh(dir: &Path, merged: bool) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("gh");
    let state = if merged { "MERGED" } else { "OPEN" };
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
               --version) echo 'gh version 2.0.0'; exit 0;;\n\
               auth) exit 0;;\n\
             esac\n\
             if [ \"$1\" = pr ] && [ \"$2\" = view ]; then\n\
               echo '{{\"number\":7,\"state\":\"{state}\",\"mergedAt\":\"2026-10-02T00:00:00Z\",\
             \"headRefOid\":\"abc123\",\"url\":\"https://example.test/pr/7\"}}'\n\
               exit 0\n\
             fi\n\
             exit 1\n"
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn a_merged_pull_request_closes_an_in_review_task() {
    let _guard = SERIAL.lock().await;
    let r = rig("pr-merged").await;
    let (id, run_id, _worktree) = r.in_review_task("Ship it");

    let bin = tempfile::tempdir().unwrap();
    write_stub_gh(bin.path(), true);
    std::env::set_var("PATH", bin.path());
    r.daemon.task_pr_watch_tick();

    assert_eq!(r.task_status(id), "done");
    assert!(
        r.history_actions(id)
            .iter()
            .any(|(actor, action)| actor == "houston:pr-merged" && action == "pr_merged"),
        "{:?}",
        r.history_actions(id)
    );
    // A merged PR clears a reason a previous tick may have left.
    assert_eq!(r.run_reason(run_id), None);
}

#[tokio::test]
async fn a_missing_gh_leaves_the_task_in_review_with_a_visible_reason() {
    let _guard = SERIAL.lock().await;
    let r = rig("pr-missing").await;
    let (id, run_id, _worktree) = r.in_review_task("No gh here");

    let empty = tempfile::tempdir().unwrap();
    std::env::set_var("PATH", empty.path());
    // Never panics, never closes the task.
    r.daemon.task_pr_watch_tick();
    r.daemon.task_pr_watch_tick();

    assert_eq!(r.task_status(id), "in_review");
    let reason = r.run_reason(run_id).expect("the run carries the reason");
    assert!(reason.contains("gh"), "{reason}");
    assert!(
        !r.history_actions(id)
            .iter()
            .any(|(actor, _)| actor == "houston:pr-merged"),
        "no merge is recorded without gh"
    );
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
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

/// A `gh` stub that reports a merged PR and logs each call, on a PATH that
/// still has `git`.
fn merged_gh_logging_calls(bin: &Path) -> PathBuf {
    write_stub_gh(bin, true);
    let real = bin.join("gh");
    let logged = bin.join("gh-real");
    std::fs::rename(&real, &logged).unwrap();
    let log = bin.join("calls.log");
    std::fs::write(
        &real,
        format!(
            "#!/bin/sh\necho \"$*\" >> {}\nexec {} \"$@\"\n",
            log.display(),
            logged.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut path = std::ffi::OsString::from(bin);
    path.push(":");
    path.push(ORIGINAL_PATH.get().expect("rig captured PATH"));
    std::env::set_var("PATH", path);
    log
}

#[tokio::test]
async fn a_bitbucket_worktree_is_not_asked_of_gh() {
    let _guard = SERIAL.lock().await;
    let r = rig("pr-bitbucket").await;
    let (id, run_id, worktree) = r.in_review_task("On Bitbucket");
    let bin = tempfile::tempdir().unwrap();
    let log = merged_gh_logging_calls(bin.path());
    git(&worktree, &["init", "-q"]);
    git(
        &worktree,
        &["remote", "add", "origin", "git@bitbucket.org:ws/repo.git"],
    );

    r.daemon.task_pr_watch_tick();

    assert_eq!(r.task_status(id), "in_review");
    let reason = r.run_reason(run_id).expect("the run carries the reason");
    assert!(reason.contains("Bitbucket Cloud"), "{reason}");
    assert!(!log.exists(), "gh was run for a Bitbucket worktree");
}

#[tokio::test]
async fn a_github_ssh_alias_worktree_is_still_watched_through_gh() {
    let _guard = SERIAL.lock().await;
    let r = rig("pr-alias").await;
    let (id, _run_id, worktree) = r.in_review_task("Through an alias");
    let bin = tempfile::tempdir().unwrap();
    let log = merged_gh_logging_calls(bin.path());
    git(&worktree, &["init", "-q"]);
    git(
        &worktree,
        &[
            "remote",
            "add",
            "origin",
            "git@github.com-work:owner/repo.git",
        ],
    );

    r.daemon.task_pr_watch_tick();

    assert_eq!(r.task_status(id), "done");
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("pr view"), "{calls}");
}

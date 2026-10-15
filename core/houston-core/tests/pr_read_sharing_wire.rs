#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::CreateParams;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn git_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q"][..],
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ][..],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
    }
}

/// gh answers from files in `bin`: `pr.json` for `pr view`, a rate-limit
/// failure while `limited` exists, `rate_limit.json` for `api rate_limit`. Every
/// call is appended to `gh.log`.
fn write_fake_gh(bin: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).unwrap();
    let dir = bin.display();
    let script = format!(
        "#!/bin/sh\n\
         printf '%s\\n' \"$*\" >> '{dir}/gh.log'\n\
         case \"$1\" in\n\
           --version) echo 'gh version 2.0.0'; exit 0;;\n\
           auth) exit 0;;\n\
         esac\n\
         if [ \"$1\" = api ] && [ \"$2\" = rate_limit ]; then cat '{dir}/rate_limit.json'; exit 0; fi\n\
         if [ \"$1\" = api ]; then echo watcher; exit 0; fi\n\
         if [ \"$1\" = pr ] && [ \"$2\" = view ]; then\n\
           if [ -f '{dir}/limited' ]; then\n\
             echo 'GraphQL: API rate limit exceeded for user ID 1.' >&2; exit 1\n\
           fi\n\
           cat '{dir}/pr.json'; exit 0\n\
         fi\n\
         exit 1\n"
    );
    let path = bin.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn pr(state: &str, conclusion: &str) -> String {
    format!(
        r#"{{"number":7,"url":"https://github.com/owner/repo/pull/7","state":"{state}","mergedAt":{},"headRefOid":"abc","title":"Change","author":{{"login":"author"}},"baseRefName":"main","headRefName":"feature","mergeable":"MERGEABLE","statusCheckRollup":[{{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"{conclusion}"}}],"comments":[],"reviews":[]}}"#,
        if state == "MERGED" {
            "\"2026-10-04T00:00:00Z\""
        } else {
            "null"
        }
    )
}

/// Takes the calls gh received since the last take.
fn take_calls(bin: &Path, prefix: &str) -> usize {
    let log = bin.join("gh.log");
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    std::fs::write(&log, "").unwrap();
    calls.lines().filter(|l| l.starts_with(prefix)).count()
}

fn pane(daemon: &houston_core::daemon::Daemon, workspace: &Path) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: workspace.to_path_buf(),
            cmd: Some(vec!["/bin/sh".into(), "-c".into(), "exec sleep 60".into()]),
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

/// An in-review task whose run branch is the watched PR's head branch.
fn in_review_task(
    daemon: &houston_core::daemon::Daemon,
    db_path: &Path,
    workspace: &str,
    worktree: &Path,
) -> (i64, i64) {
    let proto::ServerMsg::TaskChanged { id, .. } = daemon
        .task_save(
            workspace,
            None,
            None,
            proto::TaskPatch {
                title: Some("Ship it".into()),
                ..Default::default()
            },
        )
        .unwrap()
    else {
        panic!("expected TaskChanged");
    };
    daemon
        .task_save(
            workspace,
            Some(id),
            Some(1),
            proto::TaskPatch {
                status: Some(proto::TaskStatus::InReview),
                ..Default::default()
            },
        )
        .unwrap();
    let conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute(
        "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, \
             worktree_path, branch, initial_revision, summary, reason, started_at, ended_at) \
         VALUES (?1, 1, 'implementation', 'handed_back', 'grok', ?2, 'feature', 1, 'done', NULL, \
             0, 1)",
        rusqlite::params![id, worktree.display().to_string()],
    )
    .unwrap();
    (id, conn.last_insert_rowid())
}

fn column(db_path: &Path, sql: &str, id: i64) -> Option<String> {
    rusqlite::Connection::open(db_path)
        .unwrap()
        .query_row(sql, [id], |r| r.get(0))
        .unwrap()
}

fn assert_paused_text(text: &str) {
    let at = text
        .find("paused until ")
        .unwrap_or_else(|| panic!("no pause in {text:?}"));
    let clock = &text.as_bytes()[at + "paused until ".len()..][..5];
    assert!(
        clock[..2].iter().chain(&clock[3..]).all(u8::is_ascii_digit) && clock[2] == b':',
        "expected HH:MM in {text:?}"
    );
}

#[tokio::test]
async fn watches_of_one_pr_share_a_read_and_a_rate_limit_pauses_them_until_the_reset() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let db_path: PathBuf = state.path().join("test.db");
    let workspace = state.path().join("workspace");
    git_repo(&workspace);
    let workspace = workspace.canonicalize().unwrap();
    let workspace_name = workspace.display().to_string();
    daemon.workspace_add(&workspace_name).unwrap();
    let worktree = state.path().join("task-tree");
    git_repo(&worktree);

    let bin = state.path().join("bin");
    write_fake_gh(&bin);
    std::fs::write(bin.join("pr.json"), pr("OPEN", "SUCCESS")).unwrap();
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

    let first = pane(&daemon, &workspace);
    let second = pane(&daemon, &workspace);
    daemon.pr_watch_start(first, "7").unwrap();
    daemon
        .pr_watch_start(second, "https://github.com/owner/repo/pull/7")
        .unwrap();
    let (task, run) = in_review_task(&daemon, &db_path, &workspace_name, &worktree);
    take_calls(&bin, "");

    // Two watches of one PR: one read per tick, fanned out to both panes.
    std::fs::write(bin.join("pr.json"), pr("OPEN", "FAILURE")).unwrap();
    daemon.pr_watch_tick();
    assert_eq!(take_calls(&bin, "pr view"), 1);
    for pane in [first, second] {
        let rows = daemon.inbox_rows_for_test(pane);
        assert_eq!(rows.len(), 1, "pane {pane} is woken by the shared read");
        assert!(rows[0].body.contains("build (failure)"));
    }
    daemon.pr_watch_tick();
    assert_eq!(take_calls(&bin, "pr view"), 1, "each tick reads again");

    // The task watch reuses the pane watches' read of the same branch.
    daemon.task_pr_watch_tick();
    assert_eq!(take_calls(&bin, "pr view"), 0);
    let run_reason = "SELECT reason FROM backlog_task_runs WHERE id = ?1";
    assert_eq!(column(&db_path, run_reason, run), None);

    // A rate limit pauses every read until GitHub's reset; it is not a failure.
    let reset_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3;
    std::fs::write(
        bin.join("rate_limit.json"),
        format!(
            r#"{{"resources":{{"core":{{"limit":5000,"remaining":4000,"reset":{reset_secs}}},"graphql":{{"limit":5000,"remaining":0,"reset":{reset_secs}}}}}}}"#
        ),
    )
    .unwrap();
    std::fs::write(bin.join("limited"), "").unwrap();
    daemon.pr_watch_tick();
    let calls = std::fs::read_to_string(bin.join("gh.log")).unwrap();
    assert_eq!(take_calls(&bin, "pr view"), 1, "{calls}");
    assert_eq!(
        calls.lines().filter(|l| *l == "api rate_limit").count(),
        1,
        "the reset is asked for once: {calls}"
    );
    daemon.pr_watch_tick();
    daemon.task_pr_watch_tick();
    assert_eq!(take_calls(&bin, ""), 0, "no gh call while paused");
    let reopened = houston_core::db::Db::open(&db_path).unwrap();
    let watches = reopened.pr_watch_list(None).unwrap();
    assert_eq!(watches.len(), 2, "a rate limit ends no watch");
    assert!(watches.iter().all(|w| w.state.read_failures == 0));
    for pane in [first, second] {
        assert_eq!(
            daemon.inbox_rows_for_test(pane).len(),
            1,
            "no wake for a pause"
        );
    }
    assert_paused_text(&column(&db_path, run_reason, run).expect("the run names the pause"));
    let third = pane(&daemon, &workspace);
    let refused = daemon.pr_watch_start(third, "7").unwrap_err().to_string();
    assert_paused_text(&refused);
    assert_eq!(take_calls(&bin, ""), 0);

    // After the reset, reads resume.
    std::fs::remove_file(bin.join("limited")).unwrap();
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    while std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        <= u128::from(reset_secs) * 1_000
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::fs::write(bin.join("pr.json"), pr("MERGED", "SUCCESS")).unwrap();
    daemon.pr_watch_tick();
    assert_eq!(take_calls(&bin, "pr view"), 1);
    assert!(
        daemon.pr_watch_infos().unwrap().is_empty(),
        "the merge ends both watches"
    );
    daemon.task_pr_watch_tick();
    assert_eq!(take_calls(&bin, "pr view"), 0);
    let task_status = "SELECT status FROM backlog_tasks WHERE id = ?1";
    assert_eq!(column(&db_path, task_status, task).as_deref(), Some("done"));
    assert_eq!(column(&db_path, run_reason, run), None);

    if let Some(path) = previous_path {
        std::env::set_var("PATH", path);
    }
    for pane in [first, second, third] {
        let _ = daemon.kill(pane);
        let _ = daemon.close(pane);
    }
}

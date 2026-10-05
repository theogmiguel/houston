#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'CWD:%s\\n' \"$PWD\"\n\
                 printf 'TASK:%s\\n' \"$HOUSTON_TASK\"\necho FIXTURE-READY\nexec cat\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

fn git(dir: &Path, args: &[&str]) -> String {
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

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str, with_git: bool) -> Rig {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    if with_git {
        init_repo(&ws_dir);
    }
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

    fn pane(&self) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PANE-UP; exec cat".into(),
                ]),
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
            .expect("fixture pane spawns")
            .id
    }

    fn create_task(&self, title: &str) -> i64 {
        match self
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
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }

    fn task_row(&self, id: i64) -> (String, i64) {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.query_row(
            "SELECT status, revision FROM backlog_tasks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn runs(&self, task_id: i64) -> Vec<Run> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, attempt, state, session_id, worktree_path, branch, \
                        initial_revision, summary, reason FROM backlog_task_runs \
                 WHERE task_id = ?1 ORDER BY id",
            )
            .unwrap();
        stmt.query_map([task_id], |r| {
            Ok(Run {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt: r.get(2)?,
                state: r.get(3)?,
                session_id: r.get(4)?,
                worktree_path: r.get(5)?,
                branch: r.get(6)?,
                initial_revision: r.get(7)?,
                summary: r.get(8)?,
                reason: r.get(9)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn insert_run(&self, task_id: i64, session: u32, initial_revision: i64, reason: Option<&str>) {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.execute(
            "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, session_id, \
                 initial_revision, summary, reason, started_at, ended_at) \
             VALUES (?1, 1, 'implementation', 'running', 'custom', ?2, ?3, NULL, ?4, 0, NULL)",
            rusqlite::params![task_id, session, initial_revision, reason],
        )
        .unwrap();
    }

    fn insert_run_on_worktree(
        &self,
        task_id: i64,
        session: u32,
        branch: &str,
        worktree: &Path,
        initial_revision: i64,
    ) -> i64 {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.execute(
            "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, session_id, \
                 worktree_path, branch, initial_revision, summary, reason, started_at, ended_at) \
             VALUES (?1, 1, 'implementation', 'running', 'grok', ?2, ?3, ?4, ?5, NULL, NULL, 0, \
                 NULL)",
            rusqlite::params![
                task_id,
                session,
                worktree.display().to_string(),
                branch,
                initial_revision
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
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

    async fn wait_for_run_state(&self, run_id: i64, state: proto::TaskRunState) -> Run {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let conn = rusqlite::Connection::open(self.db_path()).unwrap();
            let row: Option<String> = conn
                .query_row(
                    "SELECT state FROM backlog_task_runs WHERE id = ?1",
                    [run_id],
                    |r| r.get(0),
                )
                .ok();
            let wanted = serde_json::to_value(state)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            if row.as_deref() == Some(wanted.as_str()) {
                return self
                    .runs_by_id()
                    .into_iter()
                    .find(|r| r.id == run_id)
                    .expect("run exists");
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "run {run_id} never reached {state:?}: {row:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn runs_by_id(&self) -> Vec<Run> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, attempt, state, session_id, worktree_path, branch, \
                        initial_revision, summary, reason FROM backlog_task_runs ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Run {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt: r.get(2)?,
                state: r.get(3)?,
                session_id: r.get(4)?,
                worktree_path: r.get(5)?,
                branch: r.get(6)?,
                initial_revision: r.get(7)?,
                summary: r.get(8)?,
                reason: r.get(9)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    async fn await_output(&self, session: u32, needle: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let replay = self.daemon.scrollback(session, None).unwrap();
            let text = String::from_utf8_lossy(&replay.data).into_owned();
            if text.contains(needle) {
                return text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "session {session} never printed {needle:?}: {text:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Run {
    id: i64,
    task_id: i64,
    attempt: u32,
    state: String,
    session_id: Option<u32>,
    worktree_path: Option<String>,
    branch: Option<String>,
    initial_revision: i64,
    summary: Option<String>,
    reason: Option<String>,
}

#[tokio::test]
async fn a_working_pane_moves_its_task_to_in_progress_unless_the_user_did() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-working", false).await;
    let pane = r.pane();
    let id = r.create_task("Follow me");
    r.insert_run(id, pane, 1, None);

    r.daemon
        .handle_hook_from(pane, proto::AgentKind::Claude, "UserPromptSubmit", None);
    assert_eq!(r.task_row(id).0, "in_progress");
    assert!(
        r.history_actions(id)
            .iter()
            .any(|(actor, action)| actor == "houston:pane-working" && action == "pane_working"),
        "{:?}",
        r.history_actions(id)
    );

    // The user sets the status back; the next Working pulse must not touch it.
    let (_, revision) = r.task_row(id);
    r.daemon
        .task_save(
            &r.workspace(),
            Some(id),
            Some(revision),
            proto::TaskPatch {
                status: Some(proto::TaskStatus::Backlog),
                ..Default::default()
            },
        )
        .unwrap();
    r.daemon
        .handle_hook_from(pane, proto::AgentKind::Claude, "UserPromptSubmit", None);
    assert_eq!(
        r.task_row(id).0,
        "backlog",
        "a status the user set after the run started wins"
    );
}

#[tokio::test]
async fn needs_input_flags_the_run_and_handback_moves_it_to_review() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-handback", false).await;
    let pane = r.pane();
    let id = r.create_task("Review me");
    r.insert_run(id, pane, 1, None);

    r.daemon
        .handle_hook_from(pane, proto::AgentKind::Claude, "Notification", None);
    let run = r.runs(id).pop().unwrap();
    assert_eq!(run.state, "waiting_for_input");
    let proto::ServerMsg::TaskSnapshot { tasks, .. } =
        r.daemon.task_snapshot(&r.workspace()).unwrap()
    else {
        panic!("expected TaskSnapshot");
    };
    let summary = tasks.iter().find(|t| t.id == id).unwrap();
    assert_eq!(
        summary.open_run.as_ref().map(|run| run.state),
        Some(proto::TaskRunState::WaitingForInput),
        "the snapshot carries the needs-you flag"
    );

    let handed = r
        .daemon
        .task_handback(
            &r.workspace(),
            id,
            "Finished the work",
            pane,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    assert!(matches!(handed, proto::ServerMsg::TaskChanged { .. }));
    assert_eq!(r.task_row(id).0, "in_review");
    let run = r.runs(id).pop().unwrap();
    assert_eq!(run.state, "handed_back");
    assert_eq!(run.summary.as_deref(), Some("Finished the work"));
    assert!(run.reason.is_none());
}

#[tokio::test]
async fn a_handback_after_the_task_changed_carries_the_drift_warning() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-drift", false).await;
    let pane = r.pane();
    let id = r.create_task("Drift");
    r.insert_run(id, pane, 1, None);

    let (_, revision) = r.task_row(id);
    r.daemon
        .task_save(
            &r.workspace(),
            Some(id),
            Some(revision),
            proto::TaskPatch {
                title: Some("Drift edited".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
    r.daemon
        .task_handback(
            &r.workspace(),
            id,
            "All done",
            pane,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();

    let proto::ServerMsg::TaskDetail { comments, .. } = r.daemon.task_get(id).unwrap() else {
        panic!("expected TaskDetail");
    };
    let comment = &comments[0].body;
    assert!(comment.contains("All done"), "{comment}");
    assert!(
        comment.contains("task changed during run"),
        "the drift guard warns in the handback comment: {comment}"
    );
}

#[tokio::test]
async fn a_claim_binds_a_run_and_a_second_claimant_is_refused_with_the_holder() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-claim", false).await;
    let first = r.pane();
    let second = r.pane();
    let id = r.create_task("Claimed");

    let claimed = r
        .daemon
        .task_claim(
            &r.workspace(),
            id,
            first,
            "agent:one (operator)",
            "task_claim",
        )
        .unwrap();
    assert!(matches!(claimed, proto::ServerMsg::TaskChanged { .. }));
    assert_eq!(r.task_row(id).0, "in_progress");
    let run = r.runs(id).pop().unwrap();
    assert_eq!(run.session_id, Some(first));
    assert_eq!(run.state, "running");
    assert!(
        run.worktree_path.is_none() && run.branch.is_none(),
        "{run:?}"
    );

    let refused = r
        .daemon
        .task_claim(
            &r.workspace(),
            id,
            second,
            "agent:two (operator)",
            "task_claim",
        )
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = refused else {
        panic!("expected TaskRefused, got {refused:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Busy);
    assert!(message.contains(&format!("pane {first}")), "{message}");
    assert_eq!(r.runs(id).len(), 1, "the refusal records no second run");

    // The holder hands back; the run follows the task.
    r.daemon
        .task_handback(
            &r.workspace(),
            id,
            "Claimed work done",
            first,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    assert_eq!(r.runs(id).pop().unwrap().state, "handed_back");
}

#[tokio::test]
async fn a_pane_exit_without_handback_interrupts_the_run_and_keeps_the_task_open() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-exit", false).await;
    let pane = r.pane();
    let id = r.create_task("Exit");
    r.insert_run(id, pane, 1, None);

    r.daemon.session_kill_checked(pane, false).unwrap();
    let run = r
        .wait_for_run_state(r.runs(id)[0].id, proto::TaskRunState::Interrupted)
        .await;
    assert!(
        run.reason
            .as_deref()
            .is_some_and(|reason| reason.contains("without handing")),
        "{run:?}"
    );
    assert_eq!(
        r.task_row(id).0,
        "backlog",
        "the task never moved by itself"
    );
}

#[tokio::test]
async fn a_restart_interrupts_a_dead_run_and_resume_opens_the_next_attempt() {
    let _guard = SERIAL.lock().await;
    let r = rig("run-resume", true).await;
    let worktree = r.state.path().join("resume-tree");
    git(
        &r.ws_dir,
        &[
            "worktree",
            "add",
            "-b",
            "houston/task/hou-1-demo",
            worktree.to_str().unwrap(),
        ],
    );
    let worktree = worktree.canonicalize().unwrap();
    let id = r.create_task("Resume me");
    let run_id = r.insert_run_on_worktree(id, 424_242, "houston/task/hou-1-demo", &worktree, 1);

    r.daemon.reconcile_task_runs();
    let run = r
        .wait_for_run_state(run_id, proto::TaskRunState::Interrupted)
        .await;
    assert!(
        run.reason.as_deref().unwrap().contains("daemon restarted"),
        "{run:?}"
    );

    let resumed = r
        .daemon
        .task_run_control(run_id, proto::TaskRunAction::Resume)
        .unwrap();
    assert!(matches!(resumed, proto::ServerMsg::TaskChanged { .. }));
    let runs = r.runs(id);
    assert_eq!(runs.len(), 2, "{runs:?}");
    let next = &runs[1];
    assert_eq!(next.attempt, 2);
    assert_eq!(next.branch.as_deref(), Some("houston/task/hou-1-demo"));
    assert_eq!(
        next.worktree_path.as_deref(),
        Some(worktree.display().to_string().as_str())
    );
    assert_eq!(next.state, "running");
    let session = next.session_id.expect("resume spawns a pane");
    r.await_output(session, "FIXTURE-READY").await;
    assert_eq!(r.task_row(id).0, "in_progress");
}

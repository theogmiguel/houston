#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::{start_daemon_with_handle, TOKEN};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::{Db, TaskRunWrite, TaskWrite};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'ARG:%s\\n' \"$@\"\n\
                 echo FIXTURE-READY\nexec cat\n",
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

async fn rig(name: &str) -> Rig {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    init_repo(&ws_dir);
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

    fn parent(&self) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PARENT-UP; exec cat".into(),
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

    fn create_task(&self) -> i64 {
        let patch = proto::TaskPatch {
            title: Some("Fix login".to_string()),
            description: Some("The login page crashes on an empty password.".to_string()),
            status: Some(proto::TaskStatus::Todo),
            acceptance: Some(vec!["Login no longer crashes".to_string()]),
            ..Default::default()
        };
        match self
            .daemon
            .task_save(&self.workspace(), None, None, patch)
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }

    fn run_rows(&self) -> Vec<Run> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, attempt, kind, state, session_id, \
                        worktree_path, branch, summary FROM backlog_task_runs ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Run {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt: r.get(2)?,
                kind: r.get(3)?,
                state: r.get(4)?,
                session_id: r.get(5)?,
                worktree_path: r.get(6)?,
                branch: r.get(7)?,
                summary: r.get(8)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn open_run_of(&self, kind: &str) -> Run {
        self.run_rows()
            .into_iter()
            .rfind(|run| {
                run.kind == kind
                    && matches!(
                        run.state.as_str(),
                        "preparing" | "running" | "waiting_for_input" | "validating"
                    )
            })
            .unwrap_or_else(|| panic!("no open {kind} run; runs: {:?}", self.run_rows()))
    }

    fn latest_run_of(&self, kind: &str) -> Run {
        self.run_rows()
            .into_iter()
            .rfind(|run| run.kind == kind)
            .unwrap_or_else(|| panic!("no {kind} run recorded"))
    }

    fn task_status(&self, id: i64) -> String {
        let proto::ServerMsg::TaskDetail { task, .. } = self.daemon.task_get(id).unwrap() else {
            panic!("expected TaskDetail");
        };
        format!("{:?}", task.status).to_lowercase()
    }

    fn comments(&self, id: i64) -> Vec<String> {
        let proto::ServerMsg::TaskDetail { comments, .. } = self.daemon.task_get(id).unwrap()
        else {
            panic!("expected TaskDetail");
        };
        comments.into_iter().map(|comment| comment.body).collect()
    }

    fn history_actors(&self, id: i64) -> Vec<String> {
        let proto::ServerMsg::TaskDetail { history, .. } = self.daemon.task_get(id).unwrap() else {
            panic!("expected TaskDetail");
        };
        history.into_iter().map(|entry| entry.actor).collect()
    }

    fn start_execute(&self, id: i64, parent: u32, reviewer: Option<proto::AgentKind>) -> Run {
        self.daemon
            .task_execute(
                &self.workspace(),
                id,
                parent,
                proto::AgentKind::Grok,
                reviewer,
                "task_execute",
            )
            .unwrap();
        self.open_run_of("implementation")
    }

    fn submit(&self, child: u32, body: &str) {
        self.daemon
            .orchestrate_submit(child, body.to_string().into())
            .unwrap();
    }

    fn submit_complete(&self, child: u32) {
        self.submit(
            child,
            "Implemented the fix.\n{\"task_result\":{\"status\":\"complete\",\"summary\":\
             \"guarded the empty password\",\"checks\":[{\"name\":\"Login no longer \
             crashes\",\"passed\":true,\"evidence\":\"tests/login.rs\"}]}}",
        );
        // The child's turn is over: end its pane so the next attempt's role and
        // slot are free, as they are once a real CLI child exits.
        let _ = self.daemon.session_kill_checked(child, false);
    }

    fn submit_fail(&self, child: u32) {
        self.submit(
            child,
            "Found a problem.\n{\"task_review\":{\"verdict\":\"fail\",\"findings\":\
             [\"Bug: the empty password still panics in src/login.rs:42\"],\"checks\":\
             [{\"name\":\"Login no longer crashes\",\"passed\":false,\"evidence\":\
             \"src/login.rs:42\"}]}}",
        );
        let _ = self.daemon.session_kill_checked(child, false);
    }
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
struct Run {
    id: i64,
    task_id: i64,
    attempt: u32,
    kind: String,
    state: String,
    session_id: Option<u32>,
    worktree_path: Option<String>,
    branch: Option<String>,
    summary: Option<String>,
}

#[tokio::test]
async fn a_failed_review_leaves_the_findings_as_a_comment_and_the_run_needing_review() {
    let _guard = SERIAL.lock().await;
    let r = rig("review-fail").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let id = r.create_task();

    let impl_run = r.start_execute(id, parent, Some(proto::AgentKind::Grok));
    r.submit_complete(impl_run.session_id.unwrap());
    assert_eq!(r.task_status(id), "inreview");

    let review_run = r.open_run_of("review");
    r.submit_fail(review_run.session_id.unwrap());

    let impl_after = r.latest_run_of("implementation");
    assert_eq!(impl_after.state, "needs_review");
    let review_after = r.latest_run_of("review");
    assert_eq!(review_after.state, "needs_review");
    assert_eq!(r.task_status(id), "inreview");
    let comments = r.comments(id);
    assert!(
        comments
            .iter()
            .any(|comment| comment.contains("Review verdict: fail")),
        "{comments:?}"
    );
    assert!(
        comments
            .iter()
            .any(|comment| comment.contains("src/login.rs:42")),
        "{comments:?}"
    );
}

#[tokio::test]
async fn retry_with_findings_opens_attempt_n_plus_one_in_the_same_worktree() {
    let _guard = SERIAL.lock().await;
    let r = rig("review-retry").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let id = r.create_task();

    let impl_run = r.start_execute(id, parent, Some(proto::AgentKind::Grok));
    let first_tree = impl_run.worktree_path.clone().unwrap();
    r.submit_complete(impl_run.session_id.unwrap());
    let review_run = r.open_run_of("review");
    r.submit_fail(review_run.session_id.unwrap());

    let failed = r.latest_run_of("implementation");
    let latest_attempt = r
        .run_rows()
        .iter()
        .map(|run| run.attempt)
        .max()
        .expect("the task has runs");
    let reply = r
        .daemon
        .task_run_control(failed.id, proto::TaskRunAction::Retry)
        .unwrap();
    assert!(
        matches!(reply, proto::ServerMsg::TaskChanged { .. }),
        "{reply:?}"
    );

    let retried = r.open_run_of("implementation");
    assert_eq!(
        retried.attempt,
        latest_attempt + 1,
        "attempts number the whole task, so the retry follows the review run: {:?}",
        r.run_rows()
    );
    assert_eq!(retried.worktree_path.as_deref(), Some(first_tree.as_str()));
    assert_eq!(retried.branch, failed.branch);
    assert_eq!(r.task_status(id), "inprogress");

    let out = {
        let session = retried.session_id.unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let replay = r.daemon.scrollback(session, None).unwrap();
            let text = String::from_utf8_lossy(&replay.data).into_owned();
            if text.contains("Bug: the empty password still panics") {
                break text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the retry brief never carried the findings: {text:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    assert!(out.contains("Reviewer findings"), "{out:?}");
}

#[tokio::test]
async fn automatic_rework_stops_at_the_configured_cap() {
    let _guard = SERIAL.lock().await;
    let r = rig("review-auto-rework").await;
    r.daemon.orchestration_set(true).unwrap();
    r.daemon
        .tasks_review_settings_set(&r.workspace(), Some(proto::AgentKind::Grok), 1)
        .unwrap();
    let parent = r.parent();
    let id = r.create_task();

    let impl_one = r.start_execute(id, parent, None);
    r.submit_complete(impl_one.session_id.unwrap());
    let review_one = r.open_run_of("review");
    r.submit_fail(review_one.session_id.unwrap());

    let impl_two = r.open_run_of("implementation");
    assert_eq!(
        impl_two.attempt,
        3,
        "impl 1, review 2, rework 3: {:?}",
        r.run_rows()
    );
    r.submit_complete(impl_two.session_id.unwrap());
    let review_two = r.open_run_of("review");
    r.submit_fail(review_two.session_id.unwrap());

    let implementations = r
        .run_rows()
        .into_iter()
        .filter(|run| run.kind == "implementation")
        .count();
    assert_eq!(implementations, 2, "the cap stops the third attempt");
    assert_eq!(
        r.history_actors(id)
            .into_iter()
            .filter(|actor| actor == "houston:auto-rework")
            .count(),
        1
    );
    assert!(
        r.comments(id)
            .iter()
            .any(|comment| comment.contains("stopped at the cap")),
        "{:?}",
        r.comments(id)
    );
}

#[tokio::test]
async fn review_settings_default_off_and_refuse_the_cap_and_a_dead_provider() {
    let _guard = SERIAL.lock().await;
    let r = rig("review-settings").await;
    let proto::ServerMsg::TaskReviewSettings {
        reviewer,
        rework_rounds,
        ..
    } = r.daemon.tasks_review_settings_state(&r.workspace())
    else {
        panic!("expected TaskReviewSettings");
    };
    assert_eq!(reviewer, None, "review is off by default");
    assert_eq!(rework_rounds, 0);

    let msg = r
        .daemon
        .tasks_review_settings_set(&r.workspace(), Some(proto::AgentKind::Grok), 2)
        .unwrap();
    let proto::ServerMsg::TaskReviewSettings {
        reviewer,
        rework_rounds,
        ..
    } = msg
    else {
        panic!("expected TaskReviewSettings, got {msg:?}");
    };
    assert_eq!(reviewer, Some(proto::AgentKind::Grok));
    assert_eq!(rework_rounds, 2);

    let msg = r
        .daemon
        .tasks_review_settings_set(&r.workspace(), Some(proto::AgentKind::Droid), 2)
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(message.to_lowercase().contains("droid"), "{message}");

    let msg = r
        .daemon
        .tasks_review_settings_set(
            &r.workspace(),
            Some(proto::AgentKind::Grok),
            proto::TASKS_REWORK_ROUNDS_MAX + 1,
        )
        .unwrap();
    let proto::ServerMsg::TaskRefused {
        kind,
        limit,
        requested,
        message,
        ..
    } = msg
    else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Limit);
    assert_eq!(limit, Some(proto::TASKS_REWORK_ROUNDS_MAX));
    assert_eq!(
        requested,
        Some(u64::from(proto::TASKS_REWORK_ROUNDS_MAX + 1))
    );
    assert!(message.contains("rework rounds"), "{message}");
}

#[test]
fn a_restored_task_child_flips_its_interrupted_run_back_to_running() {
    let _env = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_RESTORE_BUDGET");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    shim_dir();

    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let project_str = project.path().display().to_string();
    let db_path = state.path().join("task-review.db");
    let run_id;
    let task_id;
    {
        let db = Db::open(&db_path).unwrap();
        seed_session(&db, 1, project.path(), proto::AgentKind::Claude, None);
        seed_session(&db, 2, project.path(), proto::AgentKind::Codex, Some(1));
        let transcript = project.path().join("conv-2.jsonl");
        std::fs::write(&transcript, "conversation metadata\n").unwrap();
        db.set_session_resume_handle(2, Some(("conv-2", Some(transcript.to_str().unwrap()))))
            .unwrap();
        let delegation = db
            .delegation_create_with_lifecycle(1, 2, Some("hou-1"), "brief", false, 1)
            .unwrap();
        let task = db
            .create_task(&TaskWrite {
                workspace: Some(&project_str),
                title: "Seeded",
                description: "",
                status: proto::TaskStatus::Todo,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: "user",
                now_ms: 1,
                acceptance: &[],
            })
            .unwrap();
        task_id = task.id;
        let run = db
            .create_task_run(&TaskRunWrite {
                task_id: task.id,
                kind: proto::TaskRunKind::Implementation,
                state: proto::TaskRunState::Running,
                provider: proto::AgentKind::Codex,
                reviewer: None,
                session_id: Some(2),
                delegation_id: Some(delegation as u32),
                worktree_path: Some(&project_str),
                branch: Some("houston/task/hou-1-seeded"),
                base_commit: None,
                initial_revision: 1,
                started_at_ms: 1,
            })
            .unwrap();
        run_id = run.id;
    }
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let _daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();

    let db = Db::open(&db_path).unwrap();
    let run = db.task_run(run_id).unwrap().expect("the run survives");
    assert_eq!(
        run.state,
        proto::TaskRunState::Running,
        "a resumed task child's run flips back"
    );
    assert_ne!(
        run.session_id,
        Some(2),
        "the run follows the respawned session id"
    );
    assert!(
        db.task_history(task_id, proto::TASK_HISTORY_PAGE)
            .unwrap()
            .iter()
            .any(|entry| entry.actor == "houston:resumed"),
        "the restart resume is in history"
    );
}

fn seed_session(db: &Db, id: u32, dir: &Path, agent: proto::AgentKind, spawned_by: Option<u32>) {
    db.insert_session(&proto::SessionInfo {
        checkout: None,
        activity: None,
        id,
        agent,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Running,
        title: format!("Husk-{id}"),
        codename: format!("Husk-{id}"),
        detected_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
    })
    .unwrap();
}

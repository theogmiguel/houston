#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::Daemon;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static SHIM: OnceLock<PathBuf> = OnceLock::new();

const STALE: &str = "planning proposal is not approved for the current task revision";

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\necho FIXTURE-READY\nexec cat\n",
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

fn proposal() -> proto::TaskPlanProposal {
    proto::TaskPlanProposal {
        description: "Planned description".into(),
        acceptance: vec![
            "The planned change passes `cargo test -p planned`".into(),
            "The planned change is documented".into(),
        ],
        pointers: vec!["core/houston-core/src/daemon/tasks.rs".into()],
        out_of_scope: Vec::new(),
        questions: Vec::new(),
    }
}

struct Rig {
    daemon: Arc<Daemon>,
    _state: tempfile::TempDir,
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
        _state: state,
        ws_dir,
    }
}

impl Rig {
    fn workspace(&self) -> String {
        self.ws_dir.display().to_string()
    }

    fn detail(&self, id: i64) -> (proto::Task, Vec<proto::TaskAcceptanceItem>) {
        match self.daemon.task_get(id).unwrap() {
            proto::ServerMsg::TaskDetail {
                task, acceptance, ..
            } => (task, acceptance),
            other => panic!("expected TaskDetail, got {other:?}"),
        }
    }

    fn domain(&self, id: i64) -> proto::TaskDomain {
        match self.daemon.task_domain_state(id).unwrap() {
            proto::ServerMsg::TaskDomainState { domain } => domain,
            other => panic!("expected TaskDomainState, got {other:?}"),
        }
    }

    fn open_run(&self, id: i64) -> proto::TaskRun {
        let proto::ServerMsg::TaskDetail { runs, .. } = self.daemon.task_get(id).unwrap() else {
            panic!("expected TaskDetail");
        };
        runs.into_iter().next().expect("the task has a run")
    }

    /// A task whose plan went through a read-only planning pane, the typed
    /// submit, and the user's approval: the state the Plan button produces.
    async fn approved_task(&self, title: &str) -> i64 {
        let id = match self
            .daemon
            .task_save(
                &self.workspace(),
                None,
                None,
                proto::TaskPatch {
                    title: Some(title.to_string()),
                    acceptance: Some(vec!["The task passes `cargo test`".to_string()]),
                    ..Default::default()
                },
            )
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        };
        let revision = self.detail(id).0.revision;
        let session = match self
            .daemon
            .task_plan_start(id, revision, proto::AgentKind::Claude)
            .unwrap()
        {
            proto::ServerMsg::TaskPlanStarted { session_id, .. } => session_id,
            other => panic!("expected TaskPlanStarted, got {other:?}"),
        };
        let submitted = self.daemon.task_plan_submit(session, proposal()).unwrap();
        assert!(
            matches!(
                submitted,
                proto::ServerMsg::TaskPlanChanged { revision: 1, .. }
            ),
            "{submitted:?}"
        );
        self.wait_for_planning_settlement(id, session).await;
        let revision = self.detail(id).0.revision;
        let approved = self.daemon.task_plan_approve(id, revision, 1).unwrap();
        assert!(
            matches!(approved, proto::ServerMsg::TaskPlanChanged { .. }),
            "{approved:?}"
        );
        let domain = self.domain(id);
        assert!(
            domain.readiness.ready,
            "a freshly approved plan is ready: {:?}",
            domain.readiness.reasons
        );
        id
    }

    async fn wait_for_planning_settlement(&self, id: i64, session_id: u32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let stopped = self
                .daemon
                .list()
                .iter()
                .find(|session| session.id == session_id)
                .is_none_or(|session| session.state == proto::SessionState::Killed);
            if stopped && self.domain(id).planning_session_id.is_none() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "planning session {session_id} did not settle"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn assert_ready(domain: &proto::TaskDomain, after: &str) {
    assert!(
        domain.readiness.ready && domain.plan.as_ref().unwrap().approved_revision.is_some(),
        "an approved plan stays approved after {after}: ready={} approved_revision={:?} reasons={:?}",
        domain.readiness.ready,
        domain.plan.as_ref().unwrap().approved_revision,
        domain.readiness.reasons
    );
}

fn assert_not_stale(msg: &proto::ServerMsg, operation: &str) {
    if let proto::ServerMsg::TaskRefused { message, .. } = msg {
        assert!(
            !message.contains(STALE),
            "{operation} of a planned task is refused as unapproved: {message}"
        );
    }
    assert!(
        matches!(msg, proto::ServerMsg::TaskChanged { .. }),
        "{operation} of a planned task succeeds: {msg:?}"
    );
}

#[tokio::test]
async fn an_approved_plan_stays_approved_after_start() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-start").await;
    let id = r.approved_task("Planned start").await;

    let started = r
        .daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    assert!(
        matches!(started, proto::ServerMsg::TaskChanged { .. }),
        "{started:?}"
    );
    assert_eq!(r.detail(id).0.status, proto::TaskStatus::InProgress);
    assert_ready(&r.domain(id), "Start");
    let _ = r.daemon.kill(r.open_run(id).session_id.unwrap());
}

#[tokio::test]
async fn resume_and_retry_of_a_planned_task_are_not_refused_as_unapproved() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-resume").await;
    let id = r.approved_task("Planned resume").await;
    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let first = r.open_run(id);
    let stopped = r
        .daemon
        .task_run_control(first.id, proto::TaskRunAction::Stop)
        .unwrap();
    assert!(
        matches!(stopped, proto::ServerMsg::TaskChanged { .. }),
        "{stopped:?}"
    );

    let resumed = r
        .daemon
        .task_run_control(first.id, proto::TaskRunAction::Resume)
        .unwrap();
    assert_not_stale(&resumed, "Resume");

    let second = r.open_run(id);
    r.daemon
        .task_run_control(second.id, proto::TaskRunAction::Stop)
        .unwrap();
    let retried = r
        .daemon
        .task_run_control(second.id, proto::TaskRunAction::Retry)
        .unwrap();
    assert_not_stale(&retried, "Retry");
    let _ = r.daemon.kill(r.open_run(id).session_id.unwrap());
}

#[tokio::test]
async fn a_comment_or_acceptance_tick_keeps_an_approved_plan_ready() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-comment").await;
    let id = r.approved_task("Planned comment").await;

    // Before Start, so a Start-only defect cannot mask these two paths.
    let commented = r.daemon.task_comment(id, "Reviewed the plan").unwrap();
    assert!(
        matches!(commented, proto::ServerMsg::TaskChanged { .. }),
        "{commented:?}"
    );
    assert_ready(&r.domain(id), "a comment");

    let item = r.detail(id).1[0].id;
    let checked = r.daemon.task_check(id, item, true).unwrap();
    assert!(
        matches!(checked, proto::ServerMsg::TaskChanged { .. }),
        "{checked:?}"
    );
    assert_ready(&r.domain(id), "an acceptance tick");
}

#[tokio::test]
async fn re_approving_the_same_plan_keeps_acceptance_ticks() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-reapprove").await;
    let id = r.approved_task("Planned reapproval").await;
    let item = r.detail(id).1[0].id;
    r.daemon.task_check(id, item, true).unwrap();
    assert!(r.detail(id).1[0].checked_at_ms.is_some());

    // The task panel offers Approve again once the approval reads stale.
    let revision = r.detail(id).0.revision;
    let reapproved = r.daemon.task_plan_approve(id, revision, 1).unwrap();
    assert!(
        matches!(reapproved, proto::ServerMsg::TaskPlanChanged { .. }),
        "{reapproved:?}"
    );
    let acceptance = r.detail(id).1;
    assert_eq!(acceptance.len(), 2, "{acceptance:?}");
    assert!(
        acceptance[0].checked_at_ms.is_some(),
        "re-approving the same plan keeps the tick on {:?}: {acceptance:?}",
        acceptance[0].text
    );
}

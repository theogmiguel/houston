#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{Daemon, TaskProofInput};
use houston_core::slack::form::QuestionForm;
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
    git(&ws_dir, &["init", "-b", "main"]);
    git(&ws_dir, &["config", "user.email", "t@t.local"]);
    git(&ws_dir, &["config", "user.name", "t"]);
    std::fs::write(ws_dir.join("README.md"), "hello\n").unwrap();
    git(&ws_dir, &["add", "-A"]);
    git(&ws_dir, &["commit", "-m", "init"]);
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

    fn create(&self, title: &str, acceptance: &[&str]) -> i64 {
        match self
            .daemon
            .task_save(
                &self.workspace(),
                None,
                None,
                proto::TaskPatch {
                    title: Some(title.to_string()),
                    acceptance: Some(acceptance.iter().map(|s| s.to_string()).collect()),
                    ..Default::default()
                },
            )
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }

    fn detail(&self, id: i64) -> (proto::Task, Vec<proto::TaskComment>, Vec<proto::TaskRun>) {
        match self.daemon.task_get(id).unwrap() {
            proto::ServerMsg::TaskDetail {
                task,
                comments,
                runs,
                ..
            } => (task, comments, runs),
            other => panic!("expected TaskDetail, got {other:?}"),
        }
    }

    fn domain(&self, id: i64) -> proto::TaskDomain {
        match self.daemon.task_domain_state(id).unwrap() {
            proto::ServerMsg::TaskDomainState { domain } => domain,
            other => panic!("expected TaskDomainState, got {other:?}"),
        }
    }

    fn summary(&self, id: i64) -> proto::TaskSummary {
        match self.daemon.task_snapshot(&self.workspace()).unwrap() {
            proto::ServerMsg::TaskSnapshot { tasks, .. } => tasks
                .into_iter()
                .find(|t| t.id == id)
                .expect("the task is listed"),
            other => panic!("expected TaskSnapshot, got {other:?}"),
        }
    }

    /// Starts the task and returns the pane holding its run.
    fn start(&self, id: i64) -> u32 {
        let started = self
            .daemon
            .task_start(id, proto::AgentKind::Grok, None)
            .unwrap();
        assert!(
            matches!(started, proto::ServerMsg::TaskChanged { .. }),
            "{started:?}"
        );
        self.detail(id).2[0].session_id.expect("the run has a pane")
    }

    async fn settle_planning(&self, id: i64, session_id: u32) {
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

    /// Submits `proposal` through a planning pane and returns its plan revision.
    async fn propose(&self, id: i64, proposal: proto::TaskPlanProposal) -> i64 {
        let revision = self.detail(id).0.revision;
        let session = match self
            .daemon
            .task_plan_start(id, revision, proto::AgentKind::Claude)
            .unwrap()
        {
            proto::ServerMsg::TaskPlanStarted { session_id, .. } => session_id,
            other => panic!("expected TaskPlanStarted, got {other:?}"),
        };
        let submitted = self.daemon.task_plan_submit(session, proposal).unwrap();
        let proto::ServerMsg::TaskPlanChanged { revision, .. } = submitted else {
            panic!("expected TaskPlanChanged, got {submitted:?}");
        };
        self.settle_planning(id, session).await;
        revision
    }
}

fn proposal(description: &str) -> proto::TaskPlanProposal {
    proto::TaskPlanProposal {
        description: description.into(),
        acceptance: vec!["The change passes `cargo test -p planned`".into()],
        pointers: vec!["core/houston-core/src/planned.rs".into()],
        out_of_scope: vec!["Renaming the planned module".into()],
        questions: Vec::new(),
    }
}

fn proof(value: serde_json::Value) -> TaskProofInput {
    serde_json::from_value(value).expect("a well-formed proof")
}

#[tokio::test]
async fn readiness_needs_an_executable_acceptance_item() {
    let _guard = SERIAL.lock().await;
    let r = rig("ready-executable").await;
    let text_only = r.create("Text only", &["The page looks right"]);
    let domain = r.domain(text_only);
    assert!(!domain.readiness.ready);
    assert_eq!(domain.readiness.acceptance_executable, 0);
    assert!(
        domain
            .readiness
            .reasons
            .iter()
            .any(|reason| reason.contains("executable acceptance item")),
        "{:?}",
        domain.readiness.reasons
    );
    let refused = r
        .daemon
        .task_start(text_only, proto::AgentKind::Grok, None)
        .unwrap();
    assert!(
        matches!(&refused, proto::ServerMsg::TaskRefused { message, .. } if message.contains("executable")),
        "{refused:?}"
    );
    let anyway = r
        .daemon
        .task_start_with_override(text_only, proto::AgentKind::Grok, None, None, true)
        .unwrap();
    assert!(
        matches!(anyway, proto::ServerMsg::TaskChanged { .. }),
        "Start anyway still starts a text-only task: {anyway:?}"
    );

    let executable = r.create(
        "Executable",
        &["The page looks right", "The suite passes: `cargo test`"],
    );
    let domain = r.domain(executable);
    assert!(domain.readiness.ready, "{:?}", domain.readiness.reasons);
    assert_eq!(domain.readiness.acceptance_executable, 1);
}

#[tokio::test]
async fn a_handback_records_its_proof_on_the_run() {
    let _guard = SERIAL.lock().await;
    let r = rig("handback-proof").await;
    let id = r.create("Proof", &["The suite passes: `cargo test`"]);
    let session = r.start(id);
    let run = r.detail(id).2[0].clone();
    let worktree = PathBuf::from(run.worktree_path.as_deref().unwrap());
    std::fs::write(worktree.join("shot.png"), b"png").unwrap();

    let handed = r
        .daemon
        .task_handback_from(
            &r.workspace(),
            id,
            Some("Implemented the change"),
            None,
            Some(proof(serde_json::json!({
                "pr": "https://github.com/acme/app/pull/7",
                "pushed_sha": "ABCDEF1234",
                "verification": [{
                    "command": "cargo test",
                    "output": format!("{}\ntest result: ok", "x".repeat(proto::TASK_VERIFICATION_OUTPUT_MAX_BYTES)),
                    "passed": true
                }],
                "capture_path": "shot.png",
                "permanent": ["Adds the column `users.team`"]
            }))),
            session,
            "agent",
            "task_handback",
        )
        .unwrap();
    assert!(
        matches!(handed, proto::ServerMsg::TaskChanged { .. }),
        "{handed:?}"
    );
    let (task, comments, runs) = r.detail(id);
    assert_eq!(task.status, proto::TaskStatus::InReview);
    let run = &runs[0];
    assert_eq!(run.pr_number, Some(7));
    assert_eq!(
        run.pr_url.as_deref(),
        Some("https://github.com/acme/app/pull/7")
    );
    assert_eq!(run.pushed_sha.as_deref(), Some("abcdef1234"));
    let evidence = run.evidence.as_ref().expect("the run keeps its evidence");
    assert_eq!(evidence.verification.len(), 1);
    assert!(evidence.verification[0].passed);
    assert!(
        evidence.verification[0].output.ends_with("test result: ok")
            && evidence.verification[0]
                .output
                .contains("earlier bytes trimmed"),
        "the tail is kept: {:?}",
        &evidence.verification[0].output[..80]
    );
    assert_eq!(
        evidence.capture_path.as_deref(),
        Some(
            worktree
                .join("shot.png")
                .canonicalize()
                .unwrap()
                .display()
                .to_string()
                .as_str()
        )
    );
    assert_eq!(evidence.permanent, vec!["Adds the column `users.team`"]);
    assert!(
        comments
            .iter()
            .all(|c| !c.body.contains("[no verification]")),
        "{comments:?}"
    );
    let summary = r.summary(id);
    assert_eq!(summary.pr_number, Some(7));
}

#[tokio::test]
async fn a_handback_without_verification_is_marked_and_bad_proof_is_refused() {
    let _guard = SERIAL.lock().await;
    let r = rig("handback-missing").await;
    let id = r.create("Missing proof", &["The suite passes: `cargo test`"]);
    let session = r.start(id);

    let bad = r.daemon.task_handback_from(
        &r.workspace(),
        id,
        Some("done"),
        None,
        Some(proof(serde_json::json!({ "pushed_sha": "not-a-sha" }))),
        session,
        "agent",
        "task_handback",
    );
    let error = format!("{:#}", bad.expect_err("a malformed SHA is refused"));
    assert!(error.contains("pushed_sha"), "{error}");
    assert_eq!(r.detail(id).0.status, proto::TaskStatus::InProgress);

    r.daemon
        .task_handback_from(
            &r.workspace(),
            id,
            Some("done without running anything"),
            None,
            None,
            session,
            "agent",
            "task_handback",
        )
        .unwrap();
    let (task, comments, _) = r.detail(id);
    assert_eq!(task.status, proto::TaskStatus::InReview);
    assert!(
        comments
            .iter()
            .any(|c| c.body.contains("[no verification]") && c.body.contains("`cargo test`")),
        "the missing verification is named: {comments:?}"
    );
}

#[tokio::test]
async fn an_agent_question_is_answered_from_the_app() {
    let _guard = SERIAL.lock().await;
    let r = rig("task-ask").await;
    let id = r.create("Ask", &["The suite passes: `cargo test`"]);
    let session = r.start(id);
    let refused = r.daemon.task_ask(
        99_999,
        QuestionForm {
            context: None,
            question: "Which?".into(),
            options: vec!["A".into(), "B".into()],
            recommended: Some(1),
            why: None,
        },
    );
    assert!(refused.is_err(), "a pane without a task run cannot ask");

    let asked = r
        .daemon
        .task_ask(
            session,
            QuestionForm {
                context: Some("Two layouts fit".into()),
                question: "Which layout?".into(),
                options: vec!["Grid".into(), "List".into()],
                recommended: Some(2),
                why: Some("Lists scan faster".into()),
            },
        )
        .unwrap();
    assert!(asked.contains("Houston"), "{asked}");
    let question = r.summary(id).open_question.expect("the question is open");
    assert_eq!(question.question, "Which layout?");
    assert_eq!(question.options, vec!["Grid", "List"]);
    assert_eq!(question.recommended, Some(2));
    assert_eq!(question.session_id, session);
    let second = r.daemon.task_ask(
        session,
        QuestionForm {
            context: None,
            question: "Another?".into(),
            options: vec!["A".into(), "B".into()],
            recommended: Some(1),
            why: None,
        },
    );
    assert!(second.is_err(), "one open question per task");

    let answered = r.daemon.task_question_answer(question.id, "List").unwrap();
    assert!(
        matches!(answered, proto::ServerMsg::TaskChanged { .. }),
        "{answered:?}"
    );
    assert!(r.summary(id).open_question.is_none());
    let again = r.daemon.task_question_answer(question.id, "Grid").unwrap();
    assert!(
        matches!(again, proto::ServerMsg::TaskRefused { .. }),
        "the first answer wins: {again:?}"
    );
}

#[tokio::test]
async fn rejecting_a_plan_keeps_the_task_and_records_the_reason() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-reject").await;
    let id = r.create("Reject", &["The suite passes: `cargo test`"]);
    let plan_revision = r.propose(id, proposal("A rewrite nobody asked for")).await;
    let revision = r.detail(id).0.revision;

    let stale = r
        .daemon
        .task_plan_reject(id, revision, plan_revision + 1, "wrong plan")
        .unwrap();
    assert!(
        matches!(stale, proto::ServerMsg::TaskRefused { .. }),
        "{stale:?}"
    );
    let empty = r
        .daemon
        .task_plan_reject(id, revision, plan_revision, "  ")
        .unwrap();
    assert!(
        matches!(empty, proto::ServerMsg::TaskRefused { .. }),
        "{empty:?}"
    );
    let rejected = r
        .daemon
        .task_plan_reject(id, revision, plan_revision, "Too broad; keep the API")
        .unwrap();
    assert!(
        matches!(rejected, proto::ServerMsg::TaskPlanChanged { .. }),
        "{rejected:?}"
    );
    let (task, comments, _) = r.detail(id);
    assert_eq!(task.description, "", "the definition is unchanged");
    assert!(comments
        .iter()
        .any(|c| c.body.contains("rejected: Too broad; keep the API")));
    let domain = r.domain(id);
    assert!(domain.plan.is_none());
    assert!(domain.readiness.ready, "{:?}", domain.readiness.reasons);
}

#[tokio::test]
async fn the_brief_carries_the_approved_plan_context() {
    let _guard = SERIAL.lock().await;
    let r = rig("plan-brief").await;
    let id = r.create("Brief", &["The suite passes: `cargo test`"]);
    // A long description sends the brief through a prompt file the test reads.
    let long = "z".repeat(proto::TASK_BRIEF_MAX_BYTES - 4_000);
    let plan_revision = r.propose(id, proposal(&long)).await;
    let revision = r.detail(id).0.revision;
    let approved = r
        .daemon
        .task_plan_approve(id, revision, plan_revision)
        .unwrap();
    assert!(
        matches!(approved, proto::ServerMsg::TaskPlanChanged { .. }),
        "{approved:?}"
    );
    r.start(id);
    let file = r
        .ws_dir
        .join(".houston")
        .join("prompts")
        .join("prompt-task-hou-1-attempt-1.md");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !file.is_file() {
        assert!(tokio::time::Instant::now() < deadline, "no prompt file");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let brief = std::fs::read_to_string(&file).unwrap();
    for expected in [
        "approved_plan",
        "core/houston-core/src/planned.rs",
        "Renaming the planned module",
        "hs-task ask",
        "--verify",
    ] {
        assert!(brief.contains(expected), "the brief carries {expected:?}");
    }
}

#[tokio::test]
async fn factory_caps_bound_live_runs_and_are_validated() {
    let _guard = SERIAL.lock().await;
    let r = rig("factory-caps").await;
    let state = r.daemon.factory_settings_state().unwrap();
    assert!(
        matches!(
            state,
            proto::ServerMsg::FactorySettings {
                live_runs_max: proto::FACTORY_LIVE_RUNS_DEFAULT,
                needs_you_max: proto::FACTORY_NEEDS_YOU_DEFAULT,
                live_runs: 0,
                needs_you: 0,
            }
        ),
        "{state:?}"
    );
    let invalid = r.daemon.factory_settings_set(0, 3).unwrap();
    assert!(
        matches!(&invalid, proto::ServerMsg::TaskRefused { message, .. } if message.contains("live_runs_max is 0")),
        "{invalid:?}"
    );
    let over = r
        .daemon
        .factory_settings_set(1, proto::FACTORY_CAP_MAX + 1)
        .unwrap();
    assert!(
        matches!(over, proto::ServerMsg::TaskRefused { .. }),
        "{over:?}"
    );
    r.daemon.factory_settings_set(1, 2).unwrap();

    let first = r.create("First", &["`true`"]);
    let second = r.create("Second", &["`true`"]);
    r.start(first);
    let refused = r
        .daemon
        .task_start(second, proto::AgentKind::Grok, None)
        .unwrap();
    match refused {
        proto::ServerMsg::TaskRefused {
            kind,
            limit,
            requested,
            message,
            ..
        } => {
            assert_eq!(kind, proto::TaskErrorKind::Limit);
            assert_eq!(limit, Some(1));
            assert_eq!(requested, Some(2));
            assert!(message.contains("limit of 1"), "{message}");
        }
        other => panic!("a second live run passes the cap of 1: {other:?}"),
    }
    let state = r.daemon.factory_settings_state().unwrap();
    assert!(
        matches!(
            state,
            proto::ServerMsg::FactorySettings {
                live_runs_max: 1,
                needs_you_max: 2,
                live_runs: 1,
                needs_you: 0,
            }
        ),
        "{state:?}"
    );
}

#[tokio::test]
async fn a_question_closes_with_its_run() {
    let _guard = SERIAL.lock().await;
    let r = rig("task-ask-closed").await;
    let id = r.create("Ask then stop", &["The suite passes: `cargo test`"]);
    let session = r.start(id);
    let form = || QuestionForm {
        context: None,
        question: "Which layout?".into(),
        options: vec!["Grid".into(), "List".into()],
        recommended: Some(1),
        why: None,
    };
    r.daemon.task_ask(session, form()).unwrap();
    assert!(matches!(
        r.daemon.factory_settings_state().unwrap(),
        proto::ServerMsg::FactorySettings { needs_you: 1, .. }
    ));
    let run = r.detail(id).2[0].id;
    r.daemon
        .task_run_control(run, proto::TaskRunAction::Stop)
        .unwrap();
    assert!(r.summary(id).open_question.is_none());
    assert!(matches!(
        r.daemon.factory_settings_state().unwrap(),
        proto::ServerMsg::FactorySettings { needs_you: 0, .. }
    ));
    let resumed = r
        .daemon
        .task_run_control(run, proto::TaskRunAction::Resume)
        .unwrap();
    assert!(
        matches!(resumed, proto::ServerMsg::TaskChanged { .. }),
        "{resumed:?}"
    );
    let next = r.detail(id).2[0].session_id.unwrap();
    r.daemon
        .task_ask(next, form())
        .expect("a new run can ask again");
}

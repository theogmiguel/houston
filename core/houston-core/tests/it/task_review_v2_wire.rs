//! Task review modes, structured findings, head pinning and the delivery of
//! findings to the implementing pane. The child panes use a fake provider, so
//! the daemon paths run for real without a CLI installed on the test machine.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, commit, git, Rig, SERIAL};

use houston_protocol as proto;
use serde_json::json;
use std::path::{Path, PathBuf};

fn install_fake_provider(rig: &Rig) {
    let provider = rig
        .bin
        .join(format!("claude{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_fake_agent"), &provider).unwrap();
    rig.daemon.orchestration_set(true).unwrap();
}

fn create_task(rig: &Rig, title: &str) -> i64 {
    let patch = proto::TaskPatch {
        title: Some(title.into()),
        acceptance: Some(vec!["the change works".into()]),
        ..Default::default()
    };
    let msg = rig
        .daemon
        .task_save(&rig.workspace, None, None, patch)
        .unwrap();
    match msg {
        proto::ServerMsg::TaskChanged { id, .. } => id,
        other => panic!("not a task change: {other:?}"),
    }
}

fn runs(rig: &Rig, task_id: i64) -> Vec<proto::TaskRun> {
    let proto::ServerMsg::TaskDetail { runs, .. } = rig.daemon.task_get(task_id).unwrap() else {
        panic!("not a task detail");
    };
    runs
}

fn latest_implementation(rig: &Rig, task_id: i64) -> proto::TaskRun {
    runs(rig, task_id)
        .into_iter()
        .find(|run| run.kind == proto::TaskRunKind::Implementation)
        .expect("an implementation run")
}

fn latest_review(rig: &Rig, task_id: i64) -> Option<proto::TaskRun> {
    runs(rig, task_id)
        .into_iter()
        .find(|run| run.kind == proto::TaskRunKind::Review)
}

fn comments(rig: &Rig, task_id: i64) -> Vec<String> {
    let proto::ServerMsg::TaskDetail { comments, .. } = rig.daemon.task_get(task_id).unwrap()
    else {
        panic!("not a task detail");
    };
    comments.into_iter().map(|comment| comment.body).collect()
}

fn start_implementation(rig: &Rig, task_id: i64, caller: u32) -> (u32, PathBuf, String) {
    start_implementation_with(rig, task_id, caller, Some(proto::AgentKind::Claude))
}

fn start_implementation_with(
    rig: &Rig,
    task_id: i64,
    caller: u32,
    reviewer: Option<proto::AgentKind>,
) -> (u32, PathBuf, String) {
    install_fake_provider(rig);
    let msg = rig
        .daemon
        .task_execute(
            &rig.workspace,
            task_id,
            caller,
            proto::AgentKind::Claude,
            reviewer,
            "task_execute",
        )
        .unwrap();
    assert!(
        matches!(msg, proto::ServerMsg::TaskChanged { .. }),
        "{msg:?}"
    );
    let run = latest_implementation(rig, task_id);
    (
        run.session_id.expect("the implementation session"),
        PathBuf::from(run.worktree_path.expect("the implementation worktree")),
        run.branch.expect("the implementation branch"),
    )
}

fn hand_back(rig: &Rig, child: u32) {
    let body = format!(
        "Implemented the task.\n{}",
        json!({"task_result": {
            "status": "complete",
            "summary": "the change is in",
            "checks": [{"name": "the change works", "passed": true}]
        }})
    );
    rig.daemon.orchestrate_submit(child, body.into()).unwrap();
}

fn review_body(verdict: &str) -> String {
    format!(
        "Reviewed the branch.\n{}",
        json!({"task_review": {
            "verdict": verdict,
            "findings": [{
                "path": "src/lib.rs",
                "line": 12,
                "severity": "high",
                "category": "bug",
                "message": "the guard is inverted"
            }],
            "checks": [{"name": "the change works", "passed": true}]
        }})
    )
}

fn set_review(
    rig: &Rig,
    reviewer: Option<proto::AgentKind>,
    mode: proto::TaskReviewMode,
    focus: proto::TaskReviewFocus,
) {
    set_review_rounds(rig, reviewer, 0, mode, focus);
}

fn set_review_rounds(
    rig: &Rig,
    reviewer: Option<proto::AgentKind>,
    rounds: u32,
    mode: proto::TaskReviewMode,
    focus: proto::TaskReviewFocus,
) {
    rig.daemon
        .tasks_review_settings_set(&rig.workspace, reviewer, rounds, mode, focus)
        .unwrap();
}

fn large_change(worktree: &Path) {
    let content = (1..=80)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    commit(worktree, "review.txt", &content, "implementation");
}

#[tokio::test]
async fn a_handback_review_pins_the_head_delivers_findings_and_marks_a_new_push_outdated() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Review this change");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::Handback,
        proto::TaskReviewFocus::Bugs,
    );
    let (impl_session, worktree, _branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);

    let review = latest_review(&rig, task).expect("the handback started a review");
    let session = review.session_id.expect("the review pane");
    let head = git(&worktree, &["rev-parse", "HEAD"]);

    rig.daemon
        .orchestrate_submit(session, review_body("fail").into())
        .unwrap();
    let reviewed = latest_review(&rig, task).expect("the review run");
    let verdict = reviewed.review.expect("the stored verdict");
    assert_eq!(verdict.verdict, proto::TaskReviewOutcome::Fail);
    assert_eq!(verdict.focus, proto::TaskReviewFocus::Bugs);
    assert_eq!(verdict.findings.len(), 1);
    assert_eq!(verdict.findings[0].path, "src/lib.rs");
    assert_eq!(verdict.findings[0].line, 12);
    assert_eq!(
        verdict.findings[0].severity,
        proto::TaskReviewSeverity::High
    );
    assert_eq!(verdict.findings[0].category, proto::TaskReviewCategory::Bug);
    assert_eq!(verdict.head_sha, head);
    assert!(!verdict.outdated);

    let rows = rig.daemon.inbox_rows_for_test(impl_session);
    let delivered = rows
        .iter()
        .find(|row| row.reason.as_deref() == Some("task_review_findings"))
        .expect("one inbox row reaches the implementing pane");
    assert_eq!(
        rows.iter()
            .filter(|row| row.reason.as_deref() == Some("task_review_findings"))
            .count(),
        1
    );
    assert!(
        delivered.body.contains("src/lib.rs:12 [high bug]"),
        "{}",
        delivered.body
    );
    assert!(delivered.body.contains(&head), "{}", delivered.body);
    assert!(
        delivered.body.contains("operator to decide"),
        "{}",
        delivered.body
    );
    assert!(
        delivered.body.contains("Do not change the branch"),
        "{}",
        delivered.body
    );
    assert!(
        !delivered.body.contains("one commit each"),
        "{}",
        delivered.body
    );

    commit(&worktree, "review.txt", "one more line\n", "new push");
    let after = latest_review(&rig, task)
        .expect("the review run")
        .review
        .expect("the stored verdict");
    assert!(after.outdated, "a new branch tip makes the review outdated");
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn manual_mode_never_starts_a_review_on_handback() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "No automatic review");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::Manual,
        proto::TaskReviewFocus::Bugs,
    );
    let (impl_session, worktree, _branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    assert!(
        latest_review(&rig, task).is_none(),
        "manual mode waits for task_review"
    );
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn every_push_skips_a_small_docs_diff_and_records_the_numbers() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Small docs change");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::EveryPush,
        proto::TaskReviewFocus::Full,
    );
    let (impl_session, worktree, branch) = start_implementation(&rig, task, caller);
    commit(&worktree, "note.md", "a note\n", "docs only");
    hand_back(&rig, impl_session);
    assert!(
        latest_review(&rig, task).is_none(),
        "every_push does not review before a push"
    );
    git(&worktree, &["push", "-q", "origin", &branch]);
    rig.pr(99, &branch);
    rig.daemon.pr_watch_start(caller, "99").unwrap();
    rig.daemon.task_pr_watch_tick();

    let review = latest_review(&rig, task).expect("the pushed head is reviewed");
    let verdict = review.review.expect("a skipped verdict is still a verdict");
    assert_eq!(verdict.verdict, proto::TaskReviewOutcome::Skipped);
    assert_eq!(verdict.focus, proto::TaskReviewFocus::Full);
    let skip = verdict.skipped_reason.expect("the numbers are recorded");
    assert!(
        skip.contains("changed line(s)") && skip.contains("skip caps"),
        "{skip}"
    );
    assert!(review.session_id.is_none(), "a skip spawns no reviewer");
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn the_review_attempt_cap_names_the_limit_the_attempts_and_the_sha() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Review twice");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::Manual,
        proto::TaskReviewFocus::Bugs,
    );
    let (impl_session, worktree, _branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);

    for attempt in 0..proto::TASK_REVIEW_ATTEMPTS_PER_SHA {
        let msg = rig
            .daemon
            .task_review(
                &rig.workspace,
                task,
                caller,
                proto::AgentKind::Claude,
                "task_review",
            )
            .unwrap();
        assert!(
            matches!(msg, proto::ServerMsg::TaskChanged { .. }),
            "{msg:?}"
        );
        let review = latest_review(&rig, task).expect("a review run");
        let session = review.session_id.expect("the review pane");
        rig.daemon
            .orchestrate_submit(session, review_body("pass").into())
            .unwrap();
        let _ = attempt;
    }
    let err = rig
        .daemon
        .task_review(
            &rig.workspace,
            task,
            caller,
            proto::AgentKind::Claude,
            "task_review",
        )
        .unwrap();
    let proto::ServerMsg::TaskRefused { message, .. } = err else {
        panic!("the third review was allowed: {err:?}");
    };
    assert!(
        message.contains("TASK_REVIEW_ATTEMPTS_PER_SHA is 2"),
        "{message}"
    );
    assert!(message.contains("2 review attempt"), "{message}");
    assert!(
        message.contains(&git(&worktree, &["rev-parse", "HEAD"])),
        "{message}"
    );
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn every_push_reviews_the_pushed_head_not_unpushed_local_commits() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Review only what was pushed");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::EveryPush,
        proto::TaskReviewFocus::Full,
    );
    let (impl_session, worktree, branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    git(&worktree, &["push", "-q", "origin", &branch]);
    rig.pr(99, &branch);
    rig.daemon.pr_watch_start(caller, "99").unwrap();
    let pushed = git(&worktree, &["rev-parse", "HEAD"]);
    let content = (1..=81)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    commit(&worktree, "review.txt", &content, "unpushed");
    let local = git(&worktree, &["rev-parse", "HEAD"]);
    assert_ne!(local, pushed);

    rig.daemon.task_pr_watch_tick();
    let review = latest_review(&rig, task).expect("the pushed head is reviewed");
    let session = review.session_id.expect("the review pane");
    let tree = PathBuf::from(review.worktree_path.expect("the review worktree"));
    assert_eq!(
        git(&tree, &["rev-parse", "HEAD"]),
        pushed,
        "the reviewer sees the pushed head, not the local unpushed commit"
    );
    rig.daemon
        .orchestrate_submit(session, review_body("pass").into())
        .unwrap();
    let reviewed = latest_review(&rig, task).expect("the review run");
    let verdict = reviewed.review.expect("the stored verdict");
    assert_eq!(verdict.head_sha, pushed);
    assert_ne!(verdict.head_sha, local);
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn every_push_does_not_comment_while_its_review_is_open() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "One review per pushed head");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::EveryPush,
        proto::TaskReviewFocus::Full,
    );
    let (impl_session, worktree, branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    git(&worktree, &["push", "-q", "origin", &branch]);
    rig.pr(99, &branch);
    rig.daemon.pr_watch_start(caller, "99").unwrap();
    rig.daemon.task_pr_watch_tick();
    assert!(
        latest_review(&rig, task)
            .and_then(|run| run.session_id)
            .is_some(),
        "the pushed head opens a review"
    );
    let notes = |rig: &Rig| {
        comments(rig, task)
            .into_iter()
            .filter(|body| body.contains("every-push review not started"))
            .count()
    };
    assert_eq!(notes(&rig), 0);
    for _ in 0..3 {
        rig.daemon.task_pr_watch_tick();
    }
    assert_eq!(notes(&rig), 0, "an open review is not refused every tick");
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn every_push_records_a_refusal_note_once_per_head_and_reason() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "A refused every-push review");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::EveryPush,
        proto::TaskReviewFocus::Full,
    );
    let (impl_session, worktree, branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    git(&worktree, &["push", "-q", "origin", &branch]);
    rig.pr(99, &branch);
    rig.daemon.pr_watch_start(caller, "99").unwrap();
    rig.daemon.orchestration_set(false).unwrap();
    for _ in 0..3 {
        rig.daemon.task_pr_watch_tick();
    }
    let notes = comments(&rig, task)
        .into_iter()
        .filter(|body| body.contains("every-push review not started"))
        .collect::<Vec<_>>();
    assert_eq!(notes.len(), 1, "{notes:?}");
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn a_configured_reviewer_without_a_mode_keeps_the_handback_review() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "A workspace from before review modes");
    rig.db()
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            rusqlite::params![
                format!("tasks_default_reviewer:{}", rig.workspace),
                "claude"
            ],
        )
        .unwrap();
    let proto::ServerMsg::TaskReviewSettings { reviewer, mode, .. } =
        rig.daemon.tasks_review_settings_state(&rig.workspace)
    else {
        panic!("not a review settings state");
    };
    assert_eq!(reviewer, Some(proto::AgentKind::Claude));
    assert_eq!(
        mode,
        proto::TaskReviewMode::Handback,
        "a configured reviewer keeps the previous automatic review"
    );

    let (impl_session, worktree, _branch) = start_implementation_with(&rig, task, caller, None);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    assert!(
        latest_review(&rig, task)
            .and_then(|run| run.session_id)
            .is_some(),
        "the reviewer still runs on handback"
    );
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn an_explicit_task_execute_reviewer_starts_the_handback_review() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "A reviewer chosen at execution");
    let (impl_session, worktree, _branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    assert!(
        latest_review(&rig, task)
            .and_then(|run| run.session_id)
            .is_some(),
        "the per-run reviewer starts the review"
    );
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn an_auto_rework_is_the_only_delivery_of_its_findings() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Rework carries the findings");
    set_review_rounds(
        &rig,
        Some(proto::AgentKind::Claude),
        1,
        proto::TaskReviewMode::Handback,
        proto::TaskReviewFocus::Bugs,
    );
    let (impl_session, worktree, _branch) = start_implementation(&rig, task, caller);
    let original = latest_implementation(&rig, task);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    let _ = rig.daemon.kill(impl_session);
    let review = latest_review(&rig, task).expect("the handback review");
    let review_session = review.session_id.expect("the review pane");
    rig.daemon
        .orchestrate_submit(review_session, review_body("fail").into())
        .unwrap();

    let reworked = latest_implementation(&rig, task);
    assert_ne!(reworked.id, original.id, "auto-rework starts a new run");
    let rework_session = reworked.session_id.unwrap_or_else(|| {
        panic!(
            "the rework pane: runs {:?}, comments {:?}",
            runs(&rig, task),
            comments(&rig, task)
        )
    });
    let rows = rig.daemon.inbox_rows_for_test(impl_session);
    assert!(
        rows.iter()
            .all(|row| row.reason.as_deref() != Some("task_review_findings")),
        "the rework brief is the only delivery: {rows:?}"
    );
    let _ = rig.daemon.kill(rework_session);
    let _ = rig.daemon.kill(review_session);
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

#[tokio::test]
async fn every_push_does_not_review_uncommitted_worktree_changes() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let caller = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let task = create_task(&rig, "Review only committed work");
    set_review(
        &rig,
        Some(proto::AgentKind::Claude),
        proto::TaskReviewMode::EveryPush,
        proto::TaskReviewFocus::Full,
    );
    let (impl_session, worktree, branch) = start_implementation(&rig, task, caller);
    large_change(&worktree);
    hand_back(&rig, impl_session);
    git(&worktree, &["push", "-q", "origin", &branch]);
    rig.pr(99, &branch);
    rig.daemon.pr_watch_start(caller, "99").unwrap();
    let pushed = git(&worktree, &["rev-parse", "HEAD"]);
    std::fs::write(worktree.join("review.txt"), "uncommitted change\n").unwrap();

    rig.daemon.task_pr_watch_tick();
    let review = latest_review(&rig, task).expect("the pushed head is reviewed");
    let session = review.session_id.expect("the review pane");
    let tree = PathBuf::from(review.worktree_path.expect("the review worktree"));
    assert_ne!(tree, worktree, "a dirty implementation tree is not reused");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), pushed);
    assert_eq!(
        std::fs::read_to_string(tree.join("review.txt"))
            .unwrap()
            .lines()
            .count(),
        80,
        "the reviewer sees the pushed commit, not the uncommitted edit"
    );
    let _ = rig.daemon.kill(session);
    let _ = rig.daemon.kill(impl_session);
    let _ = rig.daemon.kill(caller);
}

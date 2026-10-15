#![cfg(unix)]

use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::{db, db::Db};
use houston_protocol as proto;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

struct Fixture {
    _state: TempDir,
    db_path: PathBuf,
    workspace: PathBuf,
    daemon: Arc<Daemon>,
    review_id: u32,
}

fn finding(key: &str) -> db::HarnessFindingWrite {
    db::HarnessFindingWrite {
        key: key.into(),
        title: "Denied git push".into(),
        category: "permissions".into(),
        confidence: "high".into(),
        sessions: vec!["session-1".into()],
        count: 1,
        quotes: vec!["permission denied".into()],
        recommendation_kind: "settings-allow".into(),
        target: ".claude/settings.json".into(),
        recommendation: "Allow pushes to the fork".into(),
        apply_prompt: "Add the narrow permission rule".into(),
    }
}

fn fixture(keys: &[&str]) -> Fixture {
    let state = tempfile::tempdir().unwrap();
    let workspace = state.path().join("project");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = std::fs::canonicalize(workspace).unwrap();
    let db_path = state.path().join("test.db");
    let daemon = Daemon::new(DaemonConfig {
        token: "test-token".into(),
        db_path: db_path.clone(),
    })
    .unwrap();
    daemon
        .workspace_add(&workspace.display().to_string())
        .unwrap();
    let database = Db::open(&db_path).unwrap();
    let review_id = database
        .create_harness_review(
            &workspace.display().to_string(),
            1,
            101,
            "/tmp/harness/r101",
            10,
        )
        .unwrap();
    let findings: Vec<_> = keys.iter().map(|key| finding(key)).collect();
    database
        .publish_harness_review(
            review_id,
            &db::HarnessPublication {
                window: Some(("2026-09-01", "2026-09-14")),
                sessions: Some(3),
                prompts: Some(10),
                cost_usd: None,
                summary: "seed review",
                findings: &findings,
                verifications: &[],
            },
            20,
        )
        .unwrap();
    Fixture {
        _state: state,
        db_path,
        workspace,
        daemon,
        review_id,
    }
}

fn create_fix(f: &Fixture, key: &str) -> i64 {
    match f
        .daemon
        .harness_fix_task(&f.workspace.display().to_string(), key, None, false, None)
        .unwrap()
    {
        proto::ServerMsg::TaskChanged { id, .. } => id,
        other => panic!("fix task creation answers TaskChanged, got {other:?}"),
    }
}

fn finding_from_state(daemon: &Daemon, workspace: &Path, key: &str) -> proto::HarnessFinding {
    let proto::ServerMsg::HarnessState { findings, .. } = daemon
        .harness_state(&workspace.display().to_string())
        .unwrap()
    else {
        panic!("harness_state answers HarnessState")
    };
    findings
        .into_iter()
        .find(|finding| finding.key == key)
        .unwrap()
}

fn set_task_done(db_path: &Path, id: i64, at_ms: i64) {
    let database = Db::open(db_path).unwrap();
    let row = database.task(id).unwrap().unwrap();
    assert!(database
        .update_task(&db::TaskUpdate {
            workspace: row.workspace.as_deref(),
            id,
            expected_revision: row.revision,
            title: &row.title,
            description: &row.description,
            status: proto::TaskStatus::Done,
            priority: row.priority,
            parent_id: row.parent_id,
            ref_url: row.ref_url.as_deref(),
            acceptance: None,
            actor: "user",
            action: "update",
            changes: "{\"status\":{\"from\":\"todo\",\"to\":\"done\"}}",
            now_ms: at_ms,
        })
        .unwrap());
}

fn create_review_run(f: &Fixture) -> (u32, u32, PathBuf) {
    let proto::ServerMsg::Routines { routines, .. } = f
        .daemon
        .harness_routine_create(
            &f.workspace.display().to_string(),
            proto::AgentKind::Claude,
            None,
            None,
            proto::Cadence::Clock {
                hour: 9,
                minute: 0,
                weekdays: Some(vec![1]),
            },
            false,
        )
        .unwrap()
    else {
        panic!("harness_routine_create answers Routines")
    };
    let routine = routines
        .into_iter()
        .find(|r| r.name.starts_with("Harness review"))
        .unwrap();
    f.daemon
        .set_routine_pane_cmd_for_test(vec!["sh".into(), "-c".into(), "sleep 30".into()]);
    f.daemon.routine_run_now(routine.id).unwrap();
    let proto::ServerMsg::RoutineRuns { runs } = f.daemon.routine_runs_list(Some(routine.id))
    else {
        panic!("routine_runs_list answers RoutineRuns")
    };
    let run = runs.first().unwrap();
    let pane = run.session_id.unwrap();
    let review = Db::open(&f.db_path)
        .unwrap()
        .harness_review_by_run(run.id)
        .unwrap()
        .unwrap();
    (run.id, pane, PathBuf::from(review.run_dir))
}

#[test]
fn prepare_fix_creates_a_linked_task_in_the_findings_workspace() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    let task = match f.daemon.task_get(id).unwrap() {
        proto::ServerMsg::TaskDetail { task, .. } => task,
        other => panic!("task_get answers TaskDetail, got {other:?}"),
    };
    assert_eq!(
        task.workspace.as_deref(),
        Some(f.workspace.to_str().unwrap())
    );
    assert_eq!(task.created_by, "houston:harness");
    assert!(
        matches!(task.origin, Some(proto::TaskOrigin::HarnessFinding { review_id, .. }) if review_id == f.review_id)
    );
    assert!(!task.description.contains("permission denied"));
    let finding = finding_from_state(&f.daemon, &f.workspace, "denied-push");
    assert_eq!(finding.phase, proto::HarnessFindingPhase::Fixing);
    assert_eq!(finding.task.unwrap().task_id, id);
}

#[test]
fn a_finding_with_an_open_fix_task_refuses_a_second_one_naming_it() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    let key = match f.daemon.task_get(id).unwrap() {
        proto::ServerMsg::TaskDetail { task, .. } => task.key,
        _ => unreachable!(),
    };
    let msg = f
        .daemon
        .harness_fix_task(
            &f.workspace.display().to_string(),
            "denied-push",
            None,
            false,
            None,
        )
        .unwrap();
    assert!(
        matches!(msg, proto::ServerMsg::TaskRefused { kind: proto::TaskErrorKind::Busy, message, .. } if message.contains(&key))
    );
}

#[test]
fn a_fix_task_is_refused_when_tasks_access_is_off_naming_the_setting() {
    let f = fixture(&["denied-push"]);
    Db::open(&f.db_path)
        .unwrap()
        .set_setting(&format!("tasks_access:{}", f.workspace.display()), "off")
        .unwrap();
    assert_eq!(
        f.daemon.tasks_access(&f.workspace.display().to_string()),
        proto::TasksAccess::Off
    );
    let msg = f
        .daemon
        .harness_fix_task(
            &f.workspace.display().to_string(),
            "denied-push",
            None,
            false,
            None,
        )
        .unwrap();
    assert!(
        matches!(msg, proto::ServerMsg::TaskRefused { kind: proto::TaskErrorKind::AccessOff, message, .. } if message.contains("Settings ▸ Tasks") && message.contains("off"))
    );
}

#[test]
fn the_next_review_run_directory_lists_each_findings_linked_task_and_landing_time() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    set_task_done(&f.db_path, id, 30);
    let pane_dir = f._state.path().join("pane");
    std::fs::create_dir_all(&pane_dir).unwrap();
    let dir = f
        .daemon
        .harness_prepare_run_dir(&f.workspace.display().to_string(), &pane_dir, 102)
        .unwrap();
    let decisions: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("decisions.json")).unwrap()).unwrap();
    assert_eq!(
        decisions["minimum_sessions_after_landing"],
        houston_core::harness::findings::MIN_SESSIONS_AFTER_LANDING
    );
    assert_eq!(decisions["findings"][0]["linked_tasks"][0]["task"], "HOU-1");
    assert_eq!(
        decisions["findings"][0]["linked_tasks"][0]["landed_at_ms"],
        30
    );
}

#[tokio::test]
async fn a_gone_verdict_resolves_the_finding_and_comments_on_its_task() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    set_task_done(&f.db_path, id, 30);
    Db::open(&f.db_path)
        .unwrap()
        .set_setting(&format!("tasks_access:{}", f.workspace.display()), "off")
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        - 5_000;
    let conn = rusqlite::Connection::open(&f.db_path).unwrap();
    for session in 90_001..=90_003 {
        conn.execute("INSERT INTO sessions (id, agent, project_dir, cwd, state, created_at) VALUES (?1, 'claude', ?2, ?2, 'idle', ?3)", rusqlite::params![session, f.workspace.display().to_string(), now + session as i64]).unwrap();
    }
    drop(conn);
    let (addr, _server) =
        houston_core::server::start(f.daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    f.daemon.set_port(addr.port());
    let (_run, pane, dir) = create_review_run(&f);
    std::fs::write(dir.join("report.md"), "Verified finding as gone.\n").unwrap();
    std::fs::write(
        dir.join("findings.json"),
        json!({
            "schema": 1,
            "run": { "workspace": f.workspace, "sessions": 3, "prompts": 10 },
            "findings": [],
            "verifications": [{
                "key": "denied-push", "task": "HOU-1", "verdict": "gone",
                "sessions_after": 3, "quotes": ["no repeated denial"]
            }]
        })
        .to_string(),
    )
    .unwrap();
    f.daemon
        .harness_publish(pane, Some("verified".into()))
        .unwrap();
    let finding = finding_from_state(&f.daemon, &f.workspace, "denied-push");
    assert_eq!(finding.phase, proto::HarnessFindingPhase::Resolved);
    assert_eq!(finding.state, proto::HarnessFindingState::Resolved);
    assert!(finding.decided_at_ms.unwrap() >= now);
    let database = Db::open(&f.db_path).unwrap();
    let decisions = database
        .harness_decisions(&f.workspace.display().to_string())
        .unwrap();
    assert_eq!(
        decisions[0].decided_by,
        format!("review:{}", finding.verification.unwrap().review_id)
    );
    let comments = database.task_comments(id, 10).unwrap();
    assert!(comments.iter().any(|comment| comment
        .body
        .contains("verified finding denied-push as gone")
        && comment.author == "houston:harness"));
}

#[test]
fn a_still_present_verdict_reopens_the_finding_with_evidence() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    set_task_done(&f.db_path, id, 30);
    let database = Db::open(&f.db_path).unwrap();
    let review_id = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            100,
        )
        .unwrap();
    database
        .publish_harness_review(
            review_id,
            &db::HarnessPublication {
                window: None,
                sessions: Some(3),
                prompts: None,
                cost_usd: None,
                summary: "still present",
                findings: &[],
                verifications: &[db::HarnessVerificationWrite {
                    key: "denied-push".into(),
                    task_id: id,
                    verdict: proto::HarnessVerdict::StillPresent,
                    sessions_after: 3,
                    evidence: vec!["same denial returned".into()],
                }],
            },
            110,
        )
        .unwrap();
    let finding = finding_from_state(&f.daemon, &f.workspace, "denied-push");
    assert_eq!(finding.phase, proto::HarnessFindingPhase::Open);
    assert_eq!(finding.state, proto::HarnessFindingState::Open);
    assert_eq!(finding.quotes, ["same denial returned"]);
}

#[test]
fn a_verdict_for_an_unlinked_key_is_refused_naming_the_key() {
    let body = json!({"schema": 1, "findings": [], "verifications": [{
        "key": "unknown-key", "task": "HOU-1", "verdict": "gone", "sessions_after": 3
    }]});
    let error = houston_core::harness::findings::parse_with_links(
        &body.to_string(),
        &std::collections::HashMap::new(),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("unknown-key"));
    assert!(error.contains("verifications[0].task"));
}

#[test]
fn a_finding_and_a_gone_verdict_for_the_same_key_is_refused() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    let tasks = Db::open(&f.db_path)
        .unwrap()
        .harness_finding_tasks(&f.workspace.display().to_string(), "denied-push")
        .unwrap();
    let links =
        std::collections::HashMap::from([("denied-push".into(), vec![("HOU-1".into(), id, 3)])]);
    let body = json!({
        "schema": 1,
        "findings": [{"key":"denied-push", "title":"Denied", "evidence":{}, "recommendation":{}}],
        "verifications": [{"key":"denied-push", "task":"HOU-1", "verdict":"gone", "sessions_after":3}]
    });
    assert_eq!(tasks[0].task_id, id);
    let error = houston_core::harness::findings::parse_with_links(&body.to_string(), &links)
        .unwrap_err()
        .to_string();
    assert!(error.contains("both a finding and a gone verification"));
}

#[test]
fn links_and_verdicts_survive_reopening_the_daemon() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    set_task_done(&f.db_path, id, now + 10);
    let database = Db::open(&f.db_path).unwrap();
    let review_id = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            now + 20,
        )
        .unwrap();
    database
        .publish_harness_review(
            review_id,
            &db::HarnessPublication {
                window: None,
                sessions: None,
                prompts: None,
                cost_usd: None,
                summary: "inconclusive",
                findings: &[],
                verifications: &[db::HarnessVerificationWrite {
                    key: "denied-push".into(),
                    task_id: id,
                    verdict: proto::HarnessVerdict::Inconclusive,
                    sessions_after: 0,
                    evidence: vec![],
                }],
            },
            now + 30,
        )
        .unwrap();
    drop(database);
    drop(f.daemon);
    let reopened = Daemon::new(DaemonConfig {
        token: "test-token".into(),
        db_path: f.db_path.clone(),
    })
    .unwrap();
    let finding = finding_from_state(&reopened, &f.workspace, "denied-push");
    assert_eq!(
        finding.phase,
        proto::HarnessFindingPhase::AwaitingVerification
    );
    assert_eq!(finding.task.unwrap().task_id, id);
    assert_eq!(finding.verification.unwrap().review_id, review_id);
}

#[test]
fn harness_overview_counts_open_reopened_and_awaiting_review() {
    let f = fixture(&["open-one", "fix-one", "await-one"]);
    let id = create_fix(&f, "await-one");
    set_task_done(&f.db_path, id, 30);
    create_fix(&f, "fix-one");
    let proto::ServerMsg::HarnessOverview { rows } = f.daemon.harness_overview().unwrap() else {
        panic!("harness_overview answers HarnessOverview")
    };
    assert_eq!(rows[0].open, 1);
    assert_eq!(rows[0].fixing, 1);
    assert_eq!(rows[0].awaiting_verification, 1);
    assert_eq!(rows[0].attention, 2);
}

#[test]
fn a_finding_the_latest_review_did_not_raise_is_not_seen() {
    let f = fixture(&["old-key"]);
    let database = Db::open(&f.db_path).unwrap();
    let next = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            100,
        )
        .unwrap();
    database
        .publish_harness_review(
            next,
            &db::HarnessPublication {
                window: None,
                sessions: None,
                prompts: None,
                cost_usd: None,
                summary: "omitted",
                findings: &[],
                verifications: &[],
            },
            110,
        )
        .unwrap();
    let finding = finding_from_state(&f.daemon, &f.workspace, "old-key");
    assert_eq!(finding.phase, proto::HarnessFindingPhase::NotSeen);
    assert_eq!(finding.last_seen_review_id, next);
}

#[test]
fn a_later_omission_supersedes_an_older_still_present_verification() {
    let f = fixture(&["denied-push"]);
    let id = create_fix(&f, "denied-push");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    set_task_done(&f.db_path, id, now + 10);
    let database = Db::open(&f.db_path).unwrap();
    let verification_review_id = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            now + 20,
        )
        .unwrap();
    database
        .publish_harness_review(
            verification_review_id,
            &db::HarnessPublication {
                window: None,
                sessions: None,
                prompts: None,
                cost_usd: None,
                summary: "still present",
                findings: &[],
                verifications: &[db::HarnessVerificationWrite {
                    key: "denied-push".into(),
                    task_id: id,
                    verdict: proto::HarnessVerdict::StillPresent,
                    sessions_after: 3,
                    evidence: vec!["push remains denied".into()],
                }],
            },
            now + 30,
        )
        .unwrap();
    let later_review_id = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            103,
            "/tmp/harness/r103",
            now + 40,
        )
        .unwrap();
    database
        .publish_harness_review(
            later_review_id,
            &db::HarnessPublication {
                window: None,
                sessions: None,
                prompts: None,
                cost_usd: None,
                summary: "omitted",
                findings: &[],
                verifications: &[],
            },
            now + 50,
        )
        .unwrap();
    assert_eq!(
        finding_from_state(&f.daemon, &f.workspace, "denied-push").phase,
        proto::HarnessFindingPhase::NotSeen
    );
}

#[test]
fn the_seen_cursor_survives_reopening_the_daemon_and_never_moves_backwards() {
    let f = fixture(&["old-key"]);
    let db = Db::open(&f.db_path).unwrap();
    assert!(
        db.advance_harness_seen_review_id(f.workspace.to_str().unwrap(), 9)
            .unwrap()
            >= 9
    );
    assert_eq!(
        db.advance_harness_seen_review_id(f.workspace.to_str().unwrap(), 3)
            .unwrap(),
        9
    );
    drop(db);
    drop(f.daemon);
    let reopened = Db::open(&f.db_path).unwrap();
    assert_eq!(
        reopened
            .harness_seen_review_id(f.workspace.to_str().unwrap())
            .unwrap(),
        9
    );
}

#[test]
fn a_new_fix_task_after_a_still_present_verdict_is_allowed_and_names_the_previous_task() {
    let f = fixture(&["denied-push"]);
    let previous = create_fix(&f, "denied-push");
    set_task_done(&f.db_path, previous, 30);
    let database = Db::open(&f.db_path).unwrap();
    let review_id = database
        .create_harness_review(
            &f.workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            100,
        )
        .unwrap();
    database
        .publish_harness_review(
            review_id,
            &db::HarnessPublication {
                window: None,
                sessions: Some(3),
                prompts: None,
                cost_usd: None,
                summary: "still present",
                findings: &[],
                verifications: &[db::HarnessVerificationWrite {
                    key: "denied-push".into(),
                    task_id: previous,
                    verdict: proto::HarnessVerdict::StillPresent,
                    sessions_after: 3,
                    evidence: vec!["same denial".into()],
                }],
            },
            110,
        )
        .unwrap();
    let next = create_fix(&f, "denied-push");
    let task = match f.daemon.task_get(next).unwrap() {
        proto::ServerMsg::TaskDetail { task, .. } => task,
        _ => unreachable!(),
    };
    assert!(task.description.contains("Previous fix task: HOU-1"));
    assert_eq!(
        finding_from_state(&f.daemon, &f.workspace, "denied-push").phase,
        proto::HarnessFindingPhase::Fixing
    );
}

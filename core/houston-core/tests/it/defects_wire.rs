//! Suspected defects: agent findings, the daemon detectors, decisions and the
//! explicit issue draft/file flow against the fake `gh`.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, commit, git, Rig, SERIAL};

use houston_core::orchestrate::{ReportKind, WorkerReply, WorkerReport};
use houston_protocol as proto;
use serde_json::json;
use std::path::Path;

fn finding(
    title: &str,
    destination: proto::DefectDestination,
    evidence: Vec<&str>,
) -> WorkerReport {
    WorkerReport {
        kind: ReportKind::Finding,
        body: "The worker saw this while reading the daemon's state.".into(),
        request_id: 1,
        title: Some(title.into()),
        destination: Some(destination),
        evidence: evidence.into_iter().map(str::to_string).collect(),
        client_request_id: None,
    }
}

fn report(kind: ReportKind, body: &str) -> WorkerReport {
    WorkerReport {
        kind,
        body: body.into(),
        request_id: 1,
        title: None,
        destination: None,
        evidence: Vec::new(),
        client_request_id: None,
    }
}

fn key_of(result: &serde_json::Value) -> String {
    result["key"].as_str().expect("a recorded key").to_string()
}

/// A real orchestrated child: the launch records the parent and the delegation,
/// while the fake provider keeps the pane alive without a CLI on this machine.
fn spawn_worker(rig: &Rig, parent: u32) -> u32 {
    let script = rig.state.path().join("worker-agent.json");
    std::fs::write(
        &script,
        json!({
            "provider": "claude",
            "seed": 11,
            "home": rig.state.path(),
            "helper": env!("CARGO_BIN_EXE_tr-helper"),
            "fixtures": Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hooks"),
            "log": rig.state.path().join("worker-agent.jsonl"),
            "steps": [{"op": "think", "ms": 600_000}]
        })
        .to_string(),
    )
    .unwrap();
    let provider = rig
        .bin
        .join(format!("claude{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_fake_agent"), &provider).unwrap();
    rig.daemon.orchestration_set(true).unwrap();
    rig.daemon
        .orchestrate_spawn(
            parent,
            proto::AgentKind::Claude,
            None,
            None,
            format!("@fake:{}", script.display()).into(),
            None,
            None,
            Some("worker".into()),
        )
        .unwrap()
        .id
}

fn detector_row<'a>(
    rows: &'a [proto::SuspectedDefect],
    detector: &str,
) -> &'a proto::SuspectedDefect {
    rows.iter()
        .find(|row| row.detector.as_deref() == Some(detector))
        .unwrap_or_else(|| panic!("no {detector} row in {rows:?}"))
}

#[tokio::test]
async fn an_agent_finding_is_recorded_and_deduped_without_an_inbox_row() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));

    let first = rig
        .daemon
        .orchestrate_report(
            pane,
            finding(
                "A delivered reply lost its body",
                proto::DefectDestination::Houston,
                vec!["question #12", "reply #15"],
            ),
        )
        .unwrap();
    assert_eq!(first["recorded"], true);
    assert_eq!(first["count"], 1);
    let key = key_of(&first);
    assert!(key.starts_with("defect-agent-"), "{key}");

    let second = rig
        .daemon
        .orchestrate_report(
            pane,
            finding(
                "a DELIVERED reply lost its body",
                proto::DefectDestination::Houston,
                vec!["question #12"],
            ),
        )
        .unwrap();
    assert_eq!(second["count"], 2, "the same title and destination dedupe");
    assert_eq!(key_of(&second), key);

    let rows = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].count, 2);
    assert_eq!(rows[0].source, proto::DefectSource::Agent);
    assert_eq!(rows[0].state, proto::HarnessFindingState::Open);
    assert_eq!(rows[0].evidence, ["question #12", "reply #15"]);
    assert!(
        rig.daemon.inbox_rows_for_test(pane).is_empty(),
        "a finding opens no inbox row"
    );
    let proto::ServerMsg::HarnessOverview { rows } = rig.daemon.harness_overview().unwrap() else {
        panic!("harness_overview answers HarnessOverview");
    };
    let attention = rows
        .iter()
        .find(|row| row.workspace == rig.workspace)
        .expect("a workspace with defects appears in the overview");
    assert_eq!(attention.suspected_defects, 1);
    assert!(attention.attention >= 1);
    let day: String = rig
        .db()
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [format!("defect_notice_day:{}", rig.workspace)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        day,
        houston_core::daemon::defect_detectors::utc_day(houston_core::daemon::now_unix_ms())
    );
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn an_agent_finding_is_stored_and_served_without_secrets_or_the_home_path() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let github = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let anthropic = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    let home = rig
        .daemon
        .env()
        .home_dir()
        .expect("the rig has a home directory")
        .display()
        .to_string();
    let mut report = finding(
        &format!("Leaked {github} in a title"),
        proto::DefectDestination::Workspace,
        vec![
            &format!("GITHUB_TOKEN={github}"),
            &format!("curl -H 'x-api-key: {anthropic}' {home}/.config/a"),
            &format!("file {}/src/a.rs", rig.workspace),
        ],
    );
    report.body = format!("The worker printed ANTHROPIC_API_KEY={anthropic} from {home}/.zshrc");
    rig.daemon.orchestrate_report(pane, report).unwrap();

    let rows = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    let wire = serde_json::to_string(&json!({
        "title": rows[0].title,
        "evidence": rows[0].evidence,
    }))
    .unwrap();
    let stored: String = rig
        .db()
        .query_row(
            "SELECT title || description || evidence FROM suspected_defects",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for (what, text) in [("wire reply", &wire), ("database row", &stored)] {
        for secret in [github, anthropic, home.as_str(), rig.workspace.as_str()] {
            assert!(!text.contains(secret), "{what} holds {secret:?}: {text}");
        }
    }
    assert!(rows[0]
        .evidence
        .iter()
        .any(|e| e.contains("<workspace>/src/a.rs")));
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn the_workspace_defect_limit_is_named_in_the_refusal() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    for n in 0..proto::SUSPECTED_DEFECTS_PER_WORKSPACE_MAX {
        rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    &format!("defect number {n}"),
                    proto::DefectDestination::Houston,
                    Vec::new(),
                ),
            )
            .unwrap();
    }
    let err = rig
        .daemon
        .orchestrate_report(
            pane,
            finding(
                "one defect too many",
                proto::DefectDestination::Houston,
                Vec::new(),
            ),
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("limit is 200"), "{err}");
    assert!(err.contains("holds 200 defects"), "{err}");
    assert!(err.contains("pane_report finding"), "{err}");
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn a_dismissed_defect_that_recurs_is_open_again_and_recurred() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let report = finding(
        "A conflict note named a merged branch",
        proto::DefectDestination::Houston,
        Vec::new(),
    );
    let key = key_of(&rig.daemon.orchestrate_report(pane, report.clone()).unwrap());
    rig.daemon
        .defect_decide(&rig.workspace, &key, proto::DefectDecision::Dismiss)
        .unwrap();
    let dismissed = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    assert_eq!(dismissed[0].state, proto::HarnessFindingState::Dismissed);
    std::thread::sleep(std::time::Duration::from_millis(3));

    rig.daemon.orchestrate_report(pane, report).unwrap();
    let recurred = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    assert_eq!(
        recurred[0].state,
        proto::HarnessFindingState::Open,
        "{recurred:?}"
    );
    assert!(recurred[0].recurred, "{recurred:?}");
    assert_eq!(recurred[0].count, 2);
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn a_delivered_reply_followed_by_the_same_question_records_the_reasked_detector() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let worker = spawn_worker(&rig, parent);
    let question = "Where is the deployment key?";

    let asked = rig
        .daemon
        .orchestrate_report(worker, report(ReportKind::Question, question))
        .unwrap();
    let message_id = asked["message_id"].as_i64().unwrap();
    rig.daemon
        .orchestrate_reply(
            parent,
            WorkerReply {
                message_id,
                text: "in the vault".into(),
                client_request_id: None,
            },
        )
        .unwrap();
    let reply_id: i64 = rig
        .db()
        .query_row(
            "SELECT id FROM pane_inbox WHERE reply_to = ?1",
            [message_id],
            |r| r.get(0),
        )
        .unwrap();
    rig.db()
        .execute(
            "UPDATE pane_inbox SET delivered_at = 1, delivered_via = 'wait' WHERE id = ?1",
            [reply_id],
        )
        .unwrap();
    let delivered: i64 = rig
        .db()
        .query_row(
            "SELECT COUNT(*) FROM pane_inbox r JOIN pane_inbox q ON q.id = r.reply_to
             WHERE r.to_session = ?1 AND r.kind = 'reply' AND r.delivered_at IS NOT NULL
             AND q.from_session = ?1 AND q.kind IN ('question', 'blocked')",
            [worker],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(delivered, 1, "the response query sees the delivered reply");
    let workspace = rig.daemon.orchestrate_whoami(worker).unwrap().project_dir;

    for _ in 0..10 {
        rig.daemon
            .orchestrate_report(worker, report(ReportKind::Question, question))
            .unwrap();
    }
    let rows = rig.daemon.suspected_defect_rows(&workspace).unwrap();
    let reasked = detector_row(&rows, "reply_reasked");
    assert_eq!(reasked.source, proto::DefectSource::Detector);
    assert_eq!(reasked.destination, proto::DefectDestination::Houston);
    assert_eq!(
        reasked.count,
        houston_core::daemon::defect_detectors::DEFECT_DETECTOR_DAILY_CAP,
        "eleven reports record one first occurrence and four more today"
    );
    assert!(
        reasked
            .evidence
            .iter()
            .any(|item| item == &format!("delivered reply #{reply_id}")),
        "{:?}",
        reasked.evidence
    );
    let _ = rig.daemon.kill(worker);
    let _ = rig.daemon.kill(parent);
}

#[tokio::test]
async fn a_reply_to_an_answered_question_records_the_refused_detector() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let worker = spawn_worker(&rig, parent);

    let asked = rig
        .daemon
        .orchestrate_report(worker, report(ReportKind::Question, "Which fixture?"))
        .unwrap();
    let message_id = asked["message_id"].as_i64().unwrap();
    rig.daemon
        .orchestrate_reply(
            parent,
            WorkerReply {
                message_id,
                text: "the existing one".into(),
                client_request_id: None,
            },
        )
        .unwrap();
    for _ in 0..10 {
        let refused = rig
            .daemon
            .orchestrate_reply(
                parent,
                WorkerReply {
                    message_id,
                    text: "the existing one".into(),
                    client_request_id: None,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(refused.contains("not an unresolved question"), "{refused}");
    }
    let workspace = rig.daemon.orchestrate_whoami(worker).unwrap().project_dir;
    let rows = rig.daemon.suspected_defect_rows(&workspace).unwrap();
    let refused = detector_row(&rows, "reply_refused_resolved");
    assert_eq!(
        refused.count,
        houston_core::daemon::defect_detectors::DEFECT_DETECTOR_DAILY_CAP
    );
    assert!(
        refused
            .evidence
            .iter()
            .any(|item| item == &format!("message #{message_id}")),
        "{:?}",
        refused.evidence
    );
    let _ = rig.daemon.kill(worker);
    let _ = rig.daemon.kill(parent);
}

#[tokio::test]
async fn a_conflict_note_for_a_merged_branch_records_the_conflict_detector() {
    use houston_core::conflict_prediction as cp;

    let _serial = SERIAL.lock().await;
    if cp::require_merge_tree(cp::git_version()).is_err() {
        return;
    }
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let _first = rig.change(1, "one", "app.txt", "A\ntwo\nthree\n");
    let sibling = rig.change(2, "two", "app.txt", "B\ntwo\nthree\n");
    rig.db()
        .execute(
            "UPDATE managed_worktrees SET created_by_session = ?1
             WHERE branch IN ('houston/one', 'houston/two')",
            [pane],
        )
        .unwrap();
    // The shared reader records the branch state before it refuses a watch on a
    // pull request that is no longer open; the conflict note then sees it cached.
    rig.pr_set(1, "state", json!("MERGED"));

    for occurrence in 0..6 {
        if occurrence > 0 {
            // Take the other branch's line so the pair merges clean and the row
            // clears; only a conflict that recurs is noted again.
            commit(
                &sibling,
                "app.txt",
                "A\ntwo\nthree\n",
                "sibling takes the same line",
            );
            git(&sibling, &["push", "-q", "origin", "houston/two"]);
            let daemon = rig.daemon.clone();
            tokio::task::spawn_blocking(move || daemon.conflict_prediction_tick())
                .await
                .unwrap();
            commit(
                &sibling,
                "app.txt",
                &format!("B{occurrence}\ntwo\nthree\n"),
                "sibling moves its line",
            );
            git(&sibling, &["push", "-q", "origin", "houston/two"]);
        }
        let _ = rig.daemon.pr_watch_start(pane, "1");
        let daemon = rig.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.conflict_prediction_tick())
            .await
            .unwrap();
    }

    let notes: i64 = rig
        .db()
        .query_row(
            "SELECT COUNT(*) FROM pane_inbox
             WHERE kind = 'operator_note' AND summary LIKE 'Predicted conflict:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(notes >= 6, "each fresh conflict noted: {notes}");
    let rows = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    let conflict = detector_row(&rows, "conflict_note_merged_branch");
    assert_eq!(
        conflict.count,
        houston_core::daemon::defect_detectors::DEFECT_DETECTOR_DAILY_CAP
    );
    assert!(
        conflict
            .evidence
            .iter()
            .any(|item| item == "branch houston/one, PR #1"),
        "{:?}",
        conflict.evidence
    );
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn an_agent_finding_counts_toward_the_worker_report_cap() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let worker = spawn_worker(&rig, parent);
    let workspace = rig.daemon.orchestrate_whoami(worker).unwrap().project_dir;
    for n in 0..houston_core::orchestrate::WORKER_REPORT_PENDING_MAX {
        rig.daemon
            .orchestrate_report(
                worker,
                report(ReportKind::Question, &format!("question {n}")),
            )
            .unwrap();
    }
    let err = rig
        .daemon
        .orchestrate_report(
            worker,
            finding(
                "A defect past the report cap",
                proto::DefectDestination::Houston,
                Vec::new(),
            ),
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("WORKER_REPORT_PENDING_MAX is 64"), "{err}");
    assert!(err.contains("64 pending reports"), "{err}");
    assert!(err.contains("pane_report finding"), "{err}");
    assert!(
        rig.daemon
            .suspected_defect_rows(&workspace)
            .unwrap()
            .is_empty(),
        "the refused finding records nothing"
    );
    let _ = rig.daemon.kill(worker);
    let _ = rig.daemon.kill(parent);
}

#[tokio::test]
async fn a_draft_makes_one_search_call_and_redacts_the_issue_text() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    rig.flag("configured-login", "octocat");
    rig.flag(
        "issues-search.json",
        &json!([
            {"number": 31, "title": "The same defect", "url": "https://github.com/owner/repo/issues/31"}
        ])
        .to_string(),
    );
    let raw_title = "Reply lost its body GITHUB_TOKEN=secret-value";
    let key = key_of(
        &rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    raw_title,
                    proto::DefectDestination::Workspace,
                    vec![&format!("file {}/src/a.rs", rig.workspace)],
                ),
            )
            .unwrap(),
    );
    let msg = rig
        .daemon
        .defect_issue_draft(&rig.workspace, &key, 7)
        .unwrap();
    let proto::ServerMsg::DefectIssueDraft {
        request,
        destination_repo,
        account,
        title,
        body,
        transmits,
        duplicates,
        note,
        ..
    } = msg
    else {
        panic!("not a draft: {msg:?}");
    };
    assert_eq!(request, 7);
    assert_eq!(destination_repo, "owner/repo");
    assert_eq!(account.as_deref(), Some("octocat"));
    assert!(title.starts_with("fix(harness): "), "{title}");
    assert!(title.contains("<redacted>"), "{title}");
    assert!(!title.contains("secret-value"), "{title}");
    assert!(body.contains("<workspace>"), "{body}");
    assert!(!body.contains(&rig.workspace), "{body}");
    assert!(transmits.contains("github.com/owner/repo"), "{transmits}");
    assert!(transmits.contains("octocat"), "{transmits}");
    assert_eq!(duplicates.len(), 1);
    assert_eq!(duplicates[0].number, 31);
    assert!(note.is_none(), "{note:?}");
    let search_calls = rig.calls("search issues");
    assert_eq!(search_calls.len(), 1);
    assert!(
        !search_calls[0].contains("secret-value"),
        "the query carries the redacted title: {}",
        search_calls[0]
    );
    assert!(
        rig.calls("api user").is_empty(),
        "the account comes from local gh config, not a network call"
    );
    assert!(
        rig.calls("issue create").is_empty(),
        "a draft files nothing"
    );
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn a_rate_limited_search_returns_no_duplicates_and_says_so() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    rig.flag("configured-login", "octocat");
    rig.flag(
        "issues-search-error",
        "HTTP 403: API rate limit exceeded for user",
    );
    let key = key_of(
        &rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    "A defect during a rate limit",
                    proto::DefectDestination::Workspace,
                    Vec::new(),
                ),
            )
            .unwrap(),
    );
    let proto::ServerMsg::DefectIssueDraft {
        duplicates, note, ..
    } = rig
        .daemon
        .defect_issue_draft(&rig.workspace, &key, 9)
        .unwrap()
    else {
        panic!("not a draft");
    };
    assert!(duplicates.is_empty(), "{duplicates:?}");
    let note = note.expect("the pause is visible");
    assert!(note.contains("paused"), "{note}");
    assert_eq!(rig.calls("search issues").len(), 1);
    assert!(rig.calls("api user").is_empty());
    assert!(rig.calls("issue create").is_empty());
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn filing_creates_the_issue_once_after_the_explicit_message_and_resolves_the_defect() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    rig.flag("configured-login", "octocat");
    rig.flag("issues-search.json", "[]");
    let key = key_of(
        &rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    "A conflict note named a merged branch",
                    proto::DefectDestination::Workspace,
                    vec!["branch houston/one, PR #7"],
                ),
            )
            .unwrap(),
    );
    let proto::ServerMsg::DefectIssueDraft { title, body, .. } = rig
        .daemon
        .defect_issue_draft(&rig.workspace, &key, 1)
        .unwrap()
    else {
        panic!("not a draft");
    };
    assert_eq!(
        rig.calls("issue create").len(),
        0,
        "the draft files nothing"
    );

    let msg = rig
        .daemon
        .defect_issue_file(&rig.workspace, &key, 2, &title, &body, "owner/repo", None)
        .unwrap();
    let proto::ServerMsg::DefectIssueFiled {
        request,
        number,
        issue_url,
        ..
    } = msg
    else {
        panic!("not a filed reply: {msg:?}");
    };
    assert_eq!(request, 2);
    assert_eq!(number, 42);
    assert!(issue_url.ends_with("/issues/42"), "{issue_url}");
    assert_eq!(rig.calls("issue create").len(), 1);

    let created: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(rig.bin.join("created-issue.json")).unwrap())
            .unwrap();
    assert_eq!(created["repo"], "owner/repo");
    assert_eq!(created["title"], title);
    assert_eq!(created["body"], body.trim());

    let rows = rig.daemon.suspected_defect_rows(&rig.workspace).unwrap();
    assert_eq!(rows[0].state, proto::HarnessFindingState::Resolved);
    assert_eq!(rows[0].issue_url.as_deref(), Some(issue_url.as_str()));
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn a_workspace_on_another_forge_is_refused_by_name_before_any_gh_call() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    git(
        Path::new(&rig.workspace),
        &[
            "config",
            "remote.origin.url",
            "git@bitbucket.org:ws/repo.git",
        ],
    );
    let key = key_of(
        &rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    "A defect in this workspace",
                    proto::DefectDestination::Workspace,
                    Vec::new(),
                ),
            )
            .unwrap(),
    );
    let err = rig
        .daemon
        .defect_issue_draft(&rig.workspace, &key, 1)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Bitbucket Cloud"), "{err}");
    assert!(err.contains("github.com only"), "{err}");
    assert!(
        rig.calls("search issues").is_empty(),
        "{:?}",
        rig.calls("search issues")
    );
    assert!(rig.calls("issue create").is_empty());
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn filing_redacts_client_text_and_can_comment_instead_of_creating() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    rig.flag("issues-search.json", "[]");
    let key = key_of(
        &rig.daemon
            .orchestrate_report(
                pane,
                finding(
                    "A defect to comment on",
                    proto::DefectDestination::Workspace,
                    Vec::new(),
                ),
            )
            .unwrap(),
    );
    let msg = rig
        .daemon
        .defect_issue_file(
            &rig.workspace,
            &key,
            3,
            "fix(harness): leaks GITHUB_TOKEN=abc123",
            "The body says SECRET=hello",
            "owner/repo",
            Some(31),
        )
        .unwrap();
    let proto::ServerMsg::DefectIssueFiled {
        number,
        issue_url,
        note,
        ..
    } = msg
    else {
        panic!("not a filed reply: {msg:?}");
    };
    assert_eq!(number, 31);
    assert_eq!(issue_url, "https://github.com/owner/repo/issues/31");
    assert!(note.as_deref().is_some_and(|n| n.contains("#31")));
    assert_eq!(rig.calls("issue create").len(), 0);
    assert_eq!(rig.calls("issue comment").len(), 1);
    let commented: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(rig.bin.join("commented-issue.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(commented["number"], "31");
    assert!(commented["body"].as_str().unwrap().contains("<redacted>"));
    assert!(!commented["body"].as_str().unwrap().contains("hello"));
    let _ = rig.daemon.kill(pane);
}

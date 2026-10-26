//! The review-request queue: opt-in polling, first-run absorb, head dedupe,
//! triage reasons, pause and credential visibility, and read-only pane spawn.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, git, Rig, SERIAL};

use houston_core::daemon::Outbound;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::Path;

fn install_fake_provider(rig: &Rig) {
    let provider = rig
        .bin
        .join(format!("claude{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_fake_agent"), &provider).unwrap();
}

fn search(rig: &Rig, entries: &[(&str, u32, &str, &str)]) {
    let rows: Vec<Value> = entries
        .iter()
        .map(|(repo, number, head, title)| {
            json!({
                "number": number,
                "title": title,
                "url": format!("https://github.com/{repo}/pull/{number}"),
                "repository": {"nameWithOwner": repo},
                "author": {"login": "author"},
                "headRefOid": head,
                "isDraft": false
            })
        })
        .collect();
    rig.flag("review-requested-prs.json", &Value::Array(rows).to_string());
}

fn pr(rig: &Rig, number: u32, branch: &str, files: Value, base: &str, green: bool) {
    rig.pr(number, branch);
    rig.pr_set(number, "files", files);
    rig.pr_set(number, "baseRefName", json!(base));
    rig.pr_set(
        number,
        "statusCheckRollup",
        if green {
            json!([{"conclusion": "SUCCESS"}])
        } else {
            json!([])
        },
    );
}

fn state(
    rig: &Rig,
) -> (
    proto::ReviewRequestMode,
    Vec<proto::ReviewRequest>,
    Option<String>,
) {
    let proto::ServerMsg::ReviewRequests {
        mode,
        items,
        note,
        paused_until_ms,
    } = rig.daemon.review_requests_state()
    else {
        panic!("not a review-requests state");
    };
    assert!(
        paused_until_ms.is_none() || note.is_some(),
        "a pause must be visible"
    );
    (mode, items, note)
}

fn notices(rx: &mut tokio::sync::broadcast::Receiver<Outbound>) -> Vec<proto::ServerMsg> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let Outbound::Control(text) = event {
            if let Ok(msg) = serde_json::from_str::<proto::ServerMsg>(&text) {
                if matches!(msg, proto::ServerMsg::ReviewRequestNotice { .. }) {
                    out.push(msg);
                }
            }
        }
    }
    out
}

#[tokio::test]
async fn off_makes_no_request_and_shows_the_off_value() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let (mode, items, _) = state(&rig);
    assert_eq!(mode, proto::ReviewRequestMode::Off);
    assert!(items.is_empty());
    rig.daemon.review_request_tick();
    assert!(rig.calls("search prs").is_empty(), "off is zero network");
}

#[tokio::test]
async fn the_first_tick_absorbs_then_a_new_head_is_triaged_notified_and_deduped() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let _pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let branch = "houston/review-one";
    search(&rig, &[("owner/repo", 1, "head-a", "Old request")]);
    pr(
        &rig,
        1,
        branch,
        json!([{"path": "src/lib.rs", "additions": 2, "deletions": 1}]),
        "main",
        true,
    );
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    let before = rig.calls("pr view").len();
    rig.daemon.review_request_tick();
    assert_eq!(
        rig.calls("pr view").len(),
        before,
        "absorbing makes no triage call"
    );
    let (_, items, _) = state(&rig);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].state, proto::ReviewRequestState::New);
    assert!(items[0]
        .reasons
        .iter()
        .any(|reason| reason.contains("absorbed")));
    assert!(
        notices(&mut rig.daemon.subscribe()).is_empty(),
        "absorbing sends no notice"
    );

    let mut updates = rig.daemon.subscribe();
    search(&rig, &[("owner/repo", 1, "head-b", "New push")]);
    pr(
        &rig,
        1,
        branch,
        json!([{"path": "migrations/007.sql", "additions": 4, "deletions": 0}]),
        "main",
        true,
    );
    rig.daemon.review_request_tick();
    let found = notices(&mut updates);
    let (_, items, _) = state(&rig);
    assert_eq!(items.len(), 2, "a new head is a new request");
    let new = items.iter().find(|item| item.head_sha == "head-b").unwrap();
    assert_eq!(new.tier, proto::ReviewTier::C);
    assert!(new
        .reasons
        .iter()
        .any(|reason| reason.contains("migrations/007.sql")));
    assert_eq!(found.len(), 1, "{found:?}");
    let proto::ServerMsg::ReviewRequestNotice {
        id, number, tier, ..
    } = &found[0]
    else {
        unreachable!()
    };
    assert_eq!(*id, new.id);
    assert_eq!(*number, 1);
    assert_eq!(*tier, proto::ReviewTier::C);

    let triage_calls = rig.calls("pr view").len();
    rig.daemon.review_request_tick();
    assert_eq!(
        rig.calls("pr view").len(),
        triage_calls,
        "same head is not re-triaged"
    );
    assert_eq!(state(&rig).1.len(), 2);

    search(&rig, &[("owner/repo", 1, "head-c", "Another push")]);
    rig.daemon.review_request_tick();
    let (_, items, _) = state(&rig);
    assert_eq!(items.len(), 3);
    assert!(items.iter().any(|item| item.head_sha == "head-c"));
}

#[tokio::test]
async fn a_rate_limit_pause_and_a_bad_credential_are_visible() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    search(&rig, &[]);
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    rig.daemon.review_request_tick();
    rig.flag(
        "review-requested-prs-error",
        "HTTP 403: API rate limit exceeded for user",
    );
    rig.daemon.review_request_tick();
    let (_, _, note) = state(&rig);
    assert!(note.unwrap_or_default().contains("paused"));

    let rig = Rig::new().await;
    search(&rig, &[]);
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    rig.daemon.review_request_tick();
    rig.flag(
        "review-requested-prs-error",
        "HTTP 401: Bad credentials - gh auth login",
    );
    rig.daemon.review_request_tick();
    let (_, _, note) = state(&rig);
    let note = note.expect("the credential problem is visible");
    assert!(note.contains("credential invalid or expired"), "{note}");
    assert!(note.contains("HTTP 401"), "{note}");
}

#[tokio::test]
async fn review_mode_opens_one_read_only_pane_and_notify_opens_none() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    install_fake_provider(&rig);
    let _pane = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let first =
        crate::merge_queue_rig::commit(&rig.root, "app.txt", "one\ntwo\nthree\nfour\n", "base");
    search(&rig, &[("owner/repo", 1, first.as_str(), "Absorbed")]);
    pr(
        &rig,
        1,
        "houston/review-one",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Review)
        .unwrap();
    rig.daemon.review_request_tick();
    assert_eq!(
        state(&rig).1[0].state,
        proto::ReviewRequestState::New,
        "absorbed rows are not reviewed"
    );
    let sessions_before = rig.daemon.list().len();
    let second = crate::merge_queue_rig::commit(
        &rig.root,
        "app.txt",
        "one\ntwo\nthree\nfour\nfive\n",
        "new head",
    );
    git(&rig.root, &["push", "-q", "origin", "main"]);
    git(&rig.origin, &["update-ref", "refs/pull/1/head", &second]);
    search(&rig, &[("owner/repo", 1, second.as_str(), "Review this")]);
    rig.daemon.review_request_tick();
    let (_, items, _) = state(&rig);
    let row = items.iter().find(|item| item.head_sha == second).unwrap();
    assert_eq!(row.state, proto::ReviewRequestState::Reviewing);
    let sessions_after = rig.daemon.list().len();
    assert_eq!(
        sessions_after,
        sessions_before + 1,
        "exactly one review pane"
    );
    let reviewing = rig
        .db()
        .query_row(
            "SELECT session_id FROM review_requests WHERE head_sha = ?1",
            [&second],
            |row| row.get::<_, Option<u32>>(0),
        )
        .unwrap();
    assert!(reviewing.is_some());
    rig.daemon.review_request_tick();
    assert_eq!(rig.daemon.list().len(), sessions_after, "no second pane");

    let rig = Rig::new().await;
    search(&rig, &[]);
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    rig.daemon.review_request_tick();
    search(&rig, &[("owner/repo", 2, "head-c", "Notify only")]);
    pr(
        &rig,
        2,
        "houston/review-two",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    rig.daemon.review_request_tick();
    let (_, items, _) = state(&rig);
    let row = items.iter().find(|item| item.head_sha == "head-c").unwrap();
    assert_eq!(row.state, proto::ReviewRequestState::New);
    assert!(
        rig.daemon
            .list()
            .iter()
            .all(|session| session.agent != proto::AgentKind::Claude),
        "notify opens no review pane"
    );
}

#[tokio::test]
async fn a_bitbucket_workspace_is_refused_by_name() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    git(
        Path::new(&rig.workspace),
        &[
            "config",
            "remote.origin.url",
            "git@bitbucket.org:ws/repo.git",
        ],
    );
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    rig.daemon.review_request_tick();
    let (_, items, note) = state(&rig);
    assert!(items.is_empty());
    let note = note.expect("the refusal is visible");
    assert!(note.contains("Bitbucket"), "{note}");
    assert!(note.contains("GitHub only"), "{note}");
    assert!(rig.calls("search prs").is_empty(), "no Bitbucket request");
}

#[tokio::test]
async fn dismiss_and_reopen_are_visible_decisions() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    search(&rig, &[]);
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    rig.daemon.review_request_tick();
    search(&rig, &[("owner/repo", 3, "head-d", "Dismiss me")]);
    pr(
        &rig,
        3,
        "houston/review-three",
        json!([{"path": "src/lib.rs", "additions": 300, "deletions": 50}]),
        "main",
        true,
    );
    rig.daemon.review_request_tick();
    let (_, items, _) = state(&rig);
    let id = items[0].id;
    let proto::ServerMsg::ReviewRequests { items, .. } = rig
        .daemon
        .review_request_decide(id, proto::ReviewRequestState::Dismissed)
        .unwrap()
    else {
        panic!("not a state")
    };
    assert_eq!(items[0].state, proto::ReviewRequestState::Dismissed);
    let proto::ServerMsg::ReviewRequests { items, .. } = rig
        .daemon
        .review_request_decide(id, proto::ReviewRequestState::New)
        .unwrap()
    else {
        panic!("not a state")
    };
    assert_eq!(items[0].state, proto::ReviewRequestState::New);
}

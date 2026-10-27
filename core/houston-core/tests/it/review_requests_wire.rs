//! The review-request queue: opt-in polling, first-run absorb, head dedupe,
//! triage reasons, pause and credential visibility, and read-only pane spawn.
#![allow(clippy::disallowed_methods)]

use crate::common;
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
        .map(|(repo, number, updated_at, title)| {
            json!({
                "number": number,
                "title": title,
                "url": format!("https://github.com/{repo}/pull/{number}"),
                "repository": {"nameWithOwner": repo},
                "author": {"login": "author"},
                "isDraft": false,
                "updatedAt": updated_at
            })
        })
        .collect();
    rig.flag("review-requested-prs.json", &Value::Array(rows).to_string());
}

fn head(rig: &Rig, number: u32, sha: &str) {
    rig.pr_set(number, "headRefOid", json!(sha));
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
    search(
        &rig,
        &[("owner/repo", 1, "2026-10-26T00:00:00Z", "Old request")],
    );
    pr(
        &rig,
        1,
        branch,
        json!([{"path": "src/lib.rs", "additions": 2, "deletions": 1}]),
        "main",
        true,
    );
    head(&rig, 1, "head-a");
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Notify)
        .unwrap();
    let before = rig.calls("pr view").len();
    rig.daemon.review_request_tick();
    assert_eq!(
        rig.calls("pr view").len(),
        before + 1,
        "the first tick resolves the head"
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
    search(
        &rig,
        &[("owner/repo", 1, "2026-10-26T00:01:00Z", "New push")],
    );
    pr(
        &rig,
        1,
        branch,
        json!([{"path": "migrations/007.sql", "additions": 4, "deletions": 0}]),
        "main",
        true,
    );
    head(&rig, 1, "head-b");
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

    let reads = rig.calls("pr view").len();
    rig.daemon.review_request_tick();
    assert_eq!(
        rig.calls("pr view").len(),
        reads,
        "an unchanged updatedAt is not re-read"
    );
    assert_eq!(state(&rig).1.len(), 2);

    search(
        &rig,
        &[("owner/repo", 1, "2026-10-26T00:02:00Z", "Another push")],
    );
    head(&rig, 1, "head-c");
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
    search(
        &rig,
        &[("owner/repo", 1, "2026-10-26T00:00:00Z", "Absorbed")],
    );
    pr(
        &rig,
        1,
        "houston/review-one",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    head(&rig, 1, &first);
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
    search(
        &rig,
        &[("owner/repo", 1, "2026-10-26T00:01:00Z", "Review this")],
    );
    head(&rig, 1, &second);
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
    search(
        &rig,
        &[("owner/repo", 2, "2026-10-26T00:02:00Z", "Notify only")],
    );
    pr(
        &rig,
        2,
        "houston/review-two",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    head(&rig, 2, "head-c");
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
async fn a_stale_review_worktree_is_cleaned_before_the_retry() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    install_fake_provider(&rig);
    let pushed = crate::merge_queue_rig::commit(
        &rig.root,
        "app.txt",
        "one\ntwo\nthree\nfour\nfive\n",
        "review me",
    );
    git(&rig.root, &["push", "-q", "origin", "main"]);
    git(&rig.origin, &["update-ref", "refs/pull/9/head", &pushed]);
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Review)
        .unwrap();
    // Prime the queue with an empty search, so this request is not absorbed.
    search(&rig, &[]);
    rig.daemon.review_request_tick();
    search(
        &rig,
        &[("owner/repo", 9, "2026-10-26T00:00:00Z", "Retry me")],
    );
    pr(
        &rig,
        9,
        "houston/review-nine",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    head(&rig, 9, &pushed);
    let slug = format!(
        "review-{}-9-{}",
        houston_core::git::ref_slug("owner/repo"),
        &pushed[..8]
    );
    let stale =
        houston_core::worktrees::default_path(rig.daemon.state_dir(), &rig.workspace, &slug);
    houston_core::worktrees::create_detached(Path::new(&rig.workspace), &pushed, &stale).unwrap();

    rig.daemon.review_request_tick();
    let (_, items, note) = state(&rig);
    let row = items
        .iter()
        .find(|item| item.head_sha == pushed)
        .expect("the request");
    assert_eq!(
        row.state,
        proto::ReviewRequestState::Reviewing,
        "the stale attempt's worktree is cleaned before the retry: {note:?}"
    );
    let sessions = rig.daemon.list();
    assert_eq!(sessions.len(), 1, "exactly one review pane on the retry");
    for session in sessions {
        let _ = rig.daemon.kill(session.id);
    }
}

#[tokio::test]
async fn a_head_that_moved_after_triage_opens_no_review_pane() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    install_fake_provider(&rig);
    let triaged = crate::merge_queue_rig::commit(
        &rig.root,
        "app.txt",
        "one\ntwo\nthree\nfour\nfive\n",
        "triaged head",
    );
    let pushed_since = crate::merge_queue_rig::commit(
        &rig.root,
        "app.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\n",
        "pushed after triage",
    );
    git(&rig.root, &["push", "-q", "origin", "main"]);
    git(
        &rig.origin,
        &["update-ref", "refs/pull/11/head", &pushed_since],
    );
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Review)
        .unwrap();
    search(&rig, &[]);
    rig.daemon.review_request_tick();
    search(&rig, &[("owner/repo", 11, "2026-10-26T00:00:00Z", "Moved")]);
    pr(
        &rig,
        11,
        "houston/review-eleven",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    head(&rig, 11, &triaged);

    rig.daemon.review_request_tick();
    let (_, items, note) = state(&rig);
    let row = items
        .iter()
        .find(|item| item.head_sha == triaged)
        .expect("the request");
    assert_eq!(row.state, proto::ReviewRequestState::New, "{note:?}");
    assert!(rig.daemon.list().is_empty(), "no review pane opened");
    let note = note.expect("the refusal is visible");
    assert!(
        note.contains(&pushed_since) && note.contains(&triaged),
        "the note names both heads: {note}"
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
    search(
        &rig,
        &[("owner/repo", 3, "2026-10-26T00:03:00Z", "Dismiss me")],
    );
    pr(
        &rig,
        3,
        "houston/review-three",
        json!([{"path": "src/lib.rs", "additions": 300, "deletions": 50}]),
        "main",
        true,
    );
    head(&rig, 3, "head-d");
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

/// A `claude` on PATH that records its argv. The daemon captures PATH when it starts, so
/// the directory must be on PATH before `Rig::new`; the returned guard restores PATH.
fn argv_recording_claude() -> (tempfile::TempDir, common::PathPrepend, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("claude.argv");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nstty -echo 2>/dev/null\nexec cat\n",
        record.display()
    );
    let path = dir.path().join("claude");
    std::fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let guard = common::prepend_path(dir.path());
    (dir, guard, record)
}

fn open_review_pane(rig: &Rig, number: u32) -> Value {
    let pushed = crate::merge_queue_rig::commit(
        &rig.root,
        "app.txt",
        "one\ntwo\nthree\nfour\nfive\n",
        "review me",
    );
    git(&rig.root, &["push", "-q", "origin", "main"]);
    git(
        &rig.origin,
        &["update-ref", &format!("refs/pull/{number}/head"), &pushed],
    );
    rig.daemon
        .review_requests_set(proto::ReviewRequestMode::Review)
        .unwrap();
    search(rig, &[]);
    rig.daemon.review_request_tick();
    search(
        rig,
        &[("owner/repo", number, "2026-10-26T00:00:00Z", "Restrict me")],
    );
    pr(
        rig,
        number,
        "houston/review-restricted",
        json!([{"path": "src/lib.rs", "additions": 30, "deletions": 0}]),
        "main",
        true,
    );
    head(rig, number, &pushed);
    rig.daemon.review_request_tick();
    json!(state(rig).2)
}

#[tokio::test]
async fn the_claude_review_pane_launches_read_only_without_project_configuration() {
    let _serial = SERIAL.lock().await;
    let (_shim, _path, record) = argv_recording_claude();
    let rig = Rig::new().await;
    let anchor = agent_pane(&rig.daemon, Path::new(&rig.workspace));
    let note = open_review_pane(&rig, 21);
    let sessions: Vec<_> = rig
        .daemon
        .list()
        .into_iter()
        .filter(|session| session.id != anchor)
        .collect();
    assert_eq!(sessions.len(), 1, "one review pane opened: {note}");
    let mut argv = String::new();
    for _ in 0..300 {
        argv = std::fs::read_to_string(&record).unwrap_or_default();
        if !argv.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let args: Vec<&str> = argv.lines().collect();
    for required in [
        "--setting-sources=user",
        "--strict-mcp-config",
        "--tools=Read,Grep,Glob",
        "--disallowedTools=Edit,Write,NotebookEdit,Bash,PowerShell",
        "--permission-mode=default",
        "--mcp-config",
    ] {
        assert!(
            args.contains(&required),
            "review pane argv lacks {required}: {args:?}"
        );
    }
    assert!(
        !args.iter().any(|arg| arg.contains("bypassPermissions")
            || arg.contains("--dangerously-skip-permissions")),
        "a review pane never bypasses permissions: {args:?}"
    );
    assert!(
        argv.contains("Diff against") && argv.contains("HOUSTON-REVIEW-DIFF"),
        "the brief carries the diff because the pane has no shell: {argv}"
    );
    for session in sessions {
        let _ = rig.daemon.kill(session.id);
    }
    let _ = rig.daemon.kill(anchor);
}

#[tokio::test]
async fn a_provider_without_launch_restrictions_is_refused_for_review_by_name() {
    let _serial = SERIAL.lock().await;
    for agent in [
        proto::AgentKind::Antigravity,
        proto::AgentKind::Opencode,
        proto::AgentKind::Zcode,
    ] {
        let rig = Rig::new().await;
        rig.daemon
            .tasks_start_settings_set(&rig.workspace, agent, proto::TaskPromptDelivery::Send)
            .unwrap();
        let _anchor = agent_pane(&rig.daemon, Path::new(&rig.workspace));
        let note = open_review_pane(&rig, 22);
        assert_eq!(
            rig.daemon.list().len(),
            1,
            "only the anchor pane for {agent:?}"
        );
        let note = note.as_str().unwrap_or_default().to_string();
        assert!(
            note.contains(&format!("{agent:?}")) && note.contains("read-only review pane"),
            "the refusal names the provider and the pane: {note}"
        );
    }
}

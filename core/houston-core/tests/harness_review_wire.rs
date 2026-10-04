#![cfg(unix)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if f() {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn weekly() -> proto::Cadence {
    proto::Cadence::Clock {
        hour: 9,
        minute: 0,
        weekdays: Some(vec![1]),
    }
}

fn review_routine(daemon: &Daemon, ws: &Path) -> proto::Routine {
    let proto::ServerMsg::Routines { routines, .. } = daemon
        .harness_routine_create(
            &ws.display().to_string(),
            proto::AgentKind::Claude,
            None,
            None,
            weekly(),
            false,
        )
        .expect("the preset creates")
    else {
        panic!("harness_routine_create answers Routines");
    };
    routines
        .into_iter()
        .find(|r| r.name.starts_with("Harness review"))
        .expect("the review routine is listed")
}

fn workspace(state: &Path) -> std::path::PathBuf {
    let ws = state.join("project");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::canonicalize(ws).unwrap()
}

/// Runs the review routine now with `cmd` standing in for the CLI, and returns
/// the run id and its pane.
async fn run_now(daemon: &Arc<Daemon>, routine: u32, cmd: Vec<String>) -> (u32, u32) {
    daemon.set_routine_pane_cmd_for_test(cmd);
    daemon.routine_run_now(routine).expect("run now");
    let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(routine)) else {
        panic!("routine_runs_list answers RoutineRuns");
    };
    let run = runs.first().expect("run now records a run");
    (run.id, run.session_id.expect("the run opened a pane"))
}

fn sleeper() -> Vec<String> {
    vec!["sh".into(), "-c".into(), "sleep 30".into()]
}

fn state(
    daemon: &Daemon,
    ws: &Path,
) -> (
    Option<proto::Routine>,
    Vec<proto::HarnessReview>,
    Vec<proto::HarnessFinding>,
) {
    match daemon.harness_state(&ws.display().to_string()).unwrap() {
        proto::ServerMsg::HarnessState {
            routine,
            reviews,
            findings,
            ..
        } => (routine, reviews, findings),
        other => panic!("harness_state answers HarnessState, not {other:?}"),
    }
}

#[test]
fn harness_state_returns_native_models_from_the_cached_catalog() {
    let state = tempfile::tempdir().unwrap();
    let cache = json!({
        "fetched_at_ms": 1,
        "source": houston_core::model_catalog::CATALOG_URL,
        "document": {
            "claude-sonnet-5": {"litellm_provider": "anthropic", "mode": "chat", "max_input_tokens": 200_000},
            "gpt-5-codex": {"litellm_provider": "openai", "mode": "responses", "max_input_tokens": 200_000},
            "bedrock/anthropic.claude-sonnet-5": {"litellm_provider": "bedrock", "mode": "chat"},
            "text-embedding-3-large": {"litellm_provider": "openai", "mode": "embedding"}
        }
    });
    std::fs::create_dir_all(state.path().join("usage")).unwrap();
    std::fs::write(
        houston_core::model_catalog::cache_path(state.path()),
        cache.to_string(),
    )
    .unwrap();
    let daemon = Daemon::new(houston_core::daemon::DaemonConfig {
        token: "test-token".into(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();

    let proto::ServerMsg::HarnessState { models, .. } =
        daemon.harness_state("/tmp/project").unwrap()
    else {
        panic!("harness_state answers HarnessState");
    };
    assert_eq!(
        models,
        vec![
            proto::HarnessModelOption {
                provider: proto::AgentKind::Claude,
                id: "claude-sonnet-5".into(),
            },
            proto::HarnessModelOption {
                provider: proto::AgentKind::Codex,
                id: "gpt-5-codex".into(),
            },
        ]
    );
}

#[tokio::test]
async fn a_harness_review_routine_cannot_move_to_another_workspace() {
    let (_addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let other = workspace(&state_dir.path().join("other"));
    let routine = review_routine(&daemon, &ws);

    let error = daemon
        .routine_update_full(
            routine.id,
            &routine.revision,
            houston_core::daemon::RoutinePatch {
                workspace_id: Some(Some(other.display().to_string())),
                ..Default::default()
            },
        )
        .expect_err("a Harness routine is bound to its workspace");
    assert!(
        error.to_string().contains(&ws.display().to_string()),
        "{error}"
    );
    assert!(
        error.to_string().contains(&other.display().to_string()),
        "{error}"
    );

    let unchanged = daemon
        .routine_update_full(
            routine.id,
            &routine.revision,
            houston_core::daemon::RoutinePatch {
                workspace_id: Some(Some(ws.display().to_string())),
                ..Default::default()
            },
        )
        .expect("the current workspace is allowed");
    assert!(matches!(unchanged, proto::ServerMsg::Routines { .. }));
}

#[test]
fn reopening_the_daemon_fails_interrupted_harness_reviews_and_keeps_published_ones() {
    let state_dir = tempfile::tempdir().unwrap();
    let workspace = state_dir.path().join("project");
    std::fs::create_dir_all(&workspace).unwrap();
    let db_path = state_dir.path().join("test.db");
    let db = houston_core::db::Db::open(&db_path).unwrap();
    let stale_id = db
        .create_harness_review(
            &workspace.display().to_string(),
            1,
            101,
            "/tmp/harness/r101",
            1,
        )
        .unwrap();
    let published_id = db
        .create_harness_review(
            &workspace.display().to_string(),
            1,
            102,
            "/tmp/harness/r102",
            2,
        )
        .unwrap();
    db.publish_harness_review(
        published_id,
        &houston_core::db::HarnessPublication {
            window: None,
            sessions: None,
            prompts: None,
            cost_usd: None,
            summary: "published before restart",
            findings: &[],
            verifications: &[],
        },
        3,
    )
    .unwrap();
    drop(db);

    let daemon = Daemon::new(houston_core::daemon::DaemonConfig {
        token: "test-token".into(),
        db_path,
    })
    .unwrap();
    let (_, reviews, _) = state(&daemon, &workspace);
    let stale = reviews.iter().find(|review| review.id == stale_id).unwrap();
    assert_eq!(stale.status, proto::HarnessReviewStatus::Failed);
    assert!(stale.ended_at_ms.is_some());
    assert!(stale.error.as_deref().unwrap().contains("daemon stopped"));
    let published = reviews
        .iter()
        .find(|review| review.id == published_id)
        .unwrap();
    assert_eq!(published.status, proto::HarnessReviewStatus::Published);
    assert!(published.error.is_none());
}

fn plain_pane(daemon: &Arc<Daemon>, ws: &Path) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: ws.to_path_buf(),
            cmd: Some(sleeper()),
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

fn token(daemon: &Daemon, pane: u32, ws: &Path) -> String {
    daemon.mcp_creds.issue(McpScope {
        session_id: pane,
        workspace_id: ws.display().to_string(),
    })
}

/// One POST with a bearer token; answers the status and the JSON body.
async fn post(addr: std::net::SocketAddr, path: &str, token: &str, body: Value) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         Authorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").expect("an HTTP response");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .expect("a status code");
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut rest = body;
        while let Some((size, after)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            out.push_str(&after[..size]);
            rest = &after[size + 2..];
        }
        out
    } else {
        body.to_string()
    };
    let json =
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("body is not JSON ({e}): {body:?}"));
    (status, json)
}

async fn mcp(addr: std::net::SocketAddr, token: &str, method: &str, params: Value) -> Value {
    let (status, v) = post(
        addr,
        "/mcp",
        token,
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    v
}

async fn tool_names(addr: std::net::SocketAddr, token: &str) -> Vec<String> {
    mcp(addr, token, "tools/list", json!({})).await["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

async fn publish(addr: std::net::SocketAddr, token: &str, summary: &str) -> Value {
    mcp(
        addr,
        token,
        "tools/call",
        json!({ "name": "harness_publish", "arguments": { "summary": summary } }),
    )
    .await
}

fn findings_json(keys: &[&str]) -> String {
    let findings: Vec<Value> = keys
        .iter()
        .enumerate()
        .map(|(i, key)| {
            json!({
                "id": format!("F{}", i + 1), "key": key, "category": "permissions",
                "title": format!("Finding {key}"),
                "evidence": { "sessions": ["s1", "s2"], "count": 2, "quotes": ["why?"] },
                "recommendation": {
                    "kind": "settings-allow", "target": ".claude/settings.json",
                    "summary": "Allow it", "apply_prompt": format!("Fix {key}")
                },
                "confidence": "high", "source": "digest", "recurrence_of": null
            })
        })
        .collect();
    json!({
        "schema": 1,
        "run": { "workspace": "/ws", "window": ["2026-09-01", "2026-09-15"],
                 "sessions": 7, "providers": ["claude"], "prompts": 40, "cost_usd": 1.25 },
        "findings": findings,
    })
    .to_string()
}

/// Writes a finished run's two files where its review expects them.
fn write_result(review: &proto::HarnessReview, keys: &[&str]) {
    let dir = Path::new(&review.run_dir);
    std::fs::write(dir.join("report.md"), "# Report\n\nOne finding.\n").unwrap();
    std::fs::write(dir.join("findings.json"), findings_json(keys)).unwrap();
}

#[tokio::test]
async fn preset_creates_a_paused_manual_review_routine() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let r = review_routine(&daemon, &ws);
    assert_eq!(r.name, "Harness review · project");
    assert!(!r.enabled, "a review spends tokens, so it starts paused");
    assert_eq!(
        r.cadence,
        proto::Cadence::Clock {
            hour: 9,
            minute: 0,
            weekdays: Some(vec![1])
        }
    );
    assert_eq!(r.engine, proto::AgentKind::Claude);
    assert_eq!(r.model, None);
    assert_eq!(r.effort, None);
    assert_eq!(r.permission_mode, proto::ChatPermissionMode::AcceptEdits);
    assert!(!r.isolate);
    assert_eq!(r.workspace_id.as_deref(), Some(ws.to_str().unwrap()));
    assert_eq!(r.prompt, houston_core::routines::HARNESS_REVIEW_PROMPT);
}

#[tokio::test]
async fn routine_pane_sees_its_run_id() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let r = review_routine(&daemon, &ws);
    let out = ws.join("run-env.txt");
    let cmd = vec![
        "sh".into(),
        "-c".into(),
        format!(
            "printf '%s' \"$HOUSTON_ROUTINE_RUN\" > '{}'; sleep 30",
            out.display()
        ),
    ];
    let (run_id, _) = run_now(&daemon, r.id, cmd).await;
    wait_until("the pane to write its env", || {
        std::fs::read_to_string(&out).is_ok_and(|s| !s.is_empty())
    })
    .await;
    assert_eq!(std::fs::read_to_string(&out).unwrap(), run_id.to_string());
}

#[tokio::test]
async fn hs_harness_wrapper_sits_beside_hs_pane() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let r = review_routine(&daemon, &ws);
    run_now(&daemon, r.id, sleeper()).await;
    let bin = ws.join(".houston/orchestration/bin");
    let wrapper = bin.join("hs-harness");
    assert!(bin.join("hs-pane").is_file());
    let script = std::fs::read_to_string(&wrapper).expect("the hs-harness wrapper exists");
    assert!(script.contains("exec "), "{script}");
    assert!(script.trim_end().ends_with("hs-harness \"$@\""), "{script}");
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&wrapper).unwrap().permissions().mode();
    assert_eq!(mode & 0o111, 0o111, "the wrapper is executable");
}

#[tokio::test]
async fn a_workspace_has_one_review_routine_until_it_is_deleted() {
    let (_addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let r = review_routine(&daemon, &ws);
    assert_eq!(state(&daemon, &ws).0.map(|r| r.id), Some(r.id));
    let err = daemon
        .harness_routine_create(
            &ws.display().to_string(),
            proto::AgentKind::Codex,
            None,
            None,
            weekly(),
            true,
        )
        .expect_err("a second routine for the same workspace is refused")
        .to_string();
    assert!(
        err.contains(&format!(
            "already has its Harness review routine (routine {})",
            r.id
        )),
        "{err}"
    );
    daemon.routine_delete(r.id, &r.revision).unwrap();
    assert!(state(&daemon, &ws).0.is_none());
    review_routine(&daemon, &ws);
}

#[tokio::test]
async fn a_review_pane_discovers_harness_publish_over_mcp_whether_orchestration_is_on_or_off() {
    let (addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let r = review_routine(&daemon, &ws);
    let (_, pane) = run_now(&daemon, r.id, sleeper()).await;
    let review_token = token(&daemon, pane, &ws);
    let other = plain_pane(&daemon, &ws);
    let other_token = token(&daemon, other, &ws);

    for on in [false, true] {
        daemon.orchestration_set(on).unwrap();
        let names = tool_names(addr, &review_token).await;
        assert!(
            names.iter().any(|n| n == "harness_publish"),
            "orchestration {on}: the review pane lists harness_publish in {names:?}"
        );
        let names = tool_names(addr, &other_token).await;
        assert!(
            !names.iter().any(|n| n == "harness_publish"),
            "orchestration {on}: an ordinary pane is not offered harness_publish: {names:?}"
        );
        let refused = publish(addr, &other_token, "x").await.to_string();
        assert!(
            refused.contains(&format!(
                "harness_publish refused: pane {other} is not a Harness review run in flight"
            )),
            "orchestration {on}: {refused}"
        );
    }

    let err = daemon
        .orchestrate_submit(pane, "a result".to_string().into())
        .expect_err("a review pane hands back through harness_publish")
        .to_string();
    assert!(
        err.contains("publishes its result with harness_publish"),
        "{err}"
    );
}

#[tokio::test]
async fn a_published_review_is_stored_per_workspace_with_its_findings_and_report() {
    let (addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let r = review_routine(&daemon, &ws);
    let (run_id, pane) = run_now(&daemon, r.id, sleeper()).await;
    let (_, reviews, _) = state(&daemon, &ws);
    let review = &reviews[0];
    assert_eq!(review.status, proto::HarnessReviewStatus::Running);
    assert_eq!(review.run_id, run_id);
    assert_eq!(review.session_id, Some(pane));
    assert_eq!(
        Path::new(&review.run_dir),
        ws.join(format!(".houston/harness/r{run_id}"))
    );
    write_result(review, &["denied-push", "stale-rule"]);

    let res = publish(
        addr,
        &token(&daemon, pane, &ws),
        "Harness review: 2 findings",
    )
    .await;
    assert!(res.to_string().contains("published 2 findings"), "{res}");

    let (_, reviews, findings) = state(&daemon, &ws);
    let review = &reviews[0];
    assert_eq!(review.status, proto::HarnessReviewStatus::Published);
    assert_eq!(review.finding_count, 2);
    assert_eq!(
        review.summary.as_deref(),
        Some("Harness review: 2 findings")
    );
    assert_eq!(
        review.window,
        Some(("2026-09-01".to_string(), "2026-09-15".to_string()))
    );
    assert_eq!((review.sessions, review.prompts), (Some(7), Some(40)));
    let keys: Vec<&str> = findings.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, ["denied-push", "stale-rule"]);
    assert!(findings
        .iter()
        .all(|f| f.state == proto::HarnessFindingState::Open));
    assert_eq!(findings[0].apply_prompt, "Fix denied-push");

    let proto::ServerMsg::HarnessReport {
        markdown,
        truncated,
        ..
    } = daemon.harness_report(review.id).unwrap()
    else {
        panic!("harness_report answers HarnessReport");
    };
    assert_eq!(markdown, "# Report\n\nOne finding.\n");
    assert!(!truncated);

    let elsewhere = state_dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (routine, reviews, findings) = state(&daemon, &elsewhere);
    assert!(routine.is_none() && reviews.is_empty() && findings.is_empty());

    daemon.routine_pane_exited_for_test(pane);
    let (_, reviews, _) = state(&daemon, &ws);
    assert_eq!(
        reviews[0].status,
        proto::HarnessReviewStatus::Published,
        "the run ending after it published keeps the review"
    );
}

#[tokio::test]
async fn decisions_outlive_their_review_and_a_recurrence_reopens_them() {
    let (addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let w = ws.display().to_string();
    let r = review_routine(&daemon, &ws);
    let (_, pane) = run_now(&daemon, r.id, sleeper()).await;
    write_result(&state(&daemon, &ws).1[0], &["denied-push", "stale-rule"]);
    publish(addr, &token(&daemon, pane, &ws), "2 findings").await;
    daemon.routine_pane_exited_for_test(pane);

    daemon
        .harness_decide(&w, "denied-push", proto::HarnessFindingState::Dismissed)
        .unwrap();
    daemon
        .harness_decide(&w, "stale-rule", proto::HarnessFindingState::Resolved)
        .unwrap();
    let find = |key: &str| {
        state(&daemon, &ws)
            .2
            .into_iter()
            .find(|f| f.key == key)
            .unwrap()
    };
    assert_eq!(
        find("denied-push").state,
        proto::HarnessFindingState::Dismissed
    );
    assert!(find("denied-push").decided_at_ms.is_some());
    daemon
        .harness_decide(&w, "denied-push", proto::HarnessFindingState::Open)
        .unwrap();
    assert_eq!(find("denied-push").state, proto::HarnessFindingState::Open);
    daemon
        .harness_decide(&w, "denied-push", proto::HarnessFindingState::Dismissed)
        .unwrap();
    let err = daemon
        .harness_decide(&w, "no-such-key", proto::HarnessFindingState::Dismissed)
        .expect_err("a decision needs a finding")
        .to_string();
    assert!(err.contains("no finding with key \"no-such-key\""), "{err}");

    let (_, second) = run_now(&daemon, r.id, sleeper()).await;
    let review = state(&daemon, &ws).1[0].clone();
    let decisions: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(&review.run_dir).join("decisions.json")).unwrap(),
    )
    .unwrap();
    let states: Vec<(String, String)> = decisions["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["key"].as_str().unwrap().into(),
                f["state"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        states,
        [
            ("denied-push".to_string(), "dismissed".to_string()),
            ("stale-rule".to_string(), "resolved".to_string())
        ],
        "the next run is told what the operator decided"
    );

    write_result(&review, &["stale-rule"]);
    publish(addr, &token(&daemon, second, &ws), "1 finding").await;
    let findings = state(&daemon, &ws).2;
    assert_eq!(
        findings.len(),
        2,
        "only the newest row for each key is returned"
    );
    assert_eq!(
        findings
            .iter()
            .filter(|finding| finding.key == "stale-rule")
            .count(),
        1
    );
    let stale = find("stale-rule");
    assert_eq!(stale.state, proto::HarnessFindingState::Open);
    assert!(stale.recurred, "raised again after it was resolved");
    assert_eq!(stale.review_id, review.id);
    let push = find("denied-push");
    assert_eq!(push.state, proto::HarnessFindingState::Dismissed);
    assert!(!push.recurred);
}

#[tokio::test]
async fn a_run_that_ends_without_publishing_leaves_a_failed_review() {
    let (_addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let r = review_routine(&daemon, &ws);
    let (_, pane) = run_now(&daemon, r.id, sleeper()).await;
    daemon.routine_pane_exited_for_test(pane);
    let review = &state(&daemon, &ws).1[0];
    assert_eq!(review.status, proto::HarnessReviewStatus::Failed);
    assert_eq!(
        review.error.as_deref(),
        Some("the run ended without publishing: its agent never called harness_publish")
    );
}

#[tokio::test]
async fn hs_harness_publish_reaches_the_daemon_over_its_http_door() {
    let (addr, state_dir, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state_dir.path());
    let r = review_routine(&daemon, &ws);
    let (_, pane) = run_now(&daemon, r.id, sleeper()).await;
    let review = state(&daemon, &ws).1[0].clone();

    let (status, body) = post(
        addr,
        "/harness/publish",
        &token(&daemon, pane, &ws),
        json!({}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("report.md does not exist"),
        "{body}"
    );

    write_result(&review, &["denied-push"]);
    let (status, body) = post(
        addr,
        "/harness/publish",
        &token(&daemon, pane, &ws),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        state(&daemon, &ws).1[0].summary.as_deref(),
        Some("1 findings")
    );
}

#[tokio::test]
async fn parentless_non_routine_submit_is_still_refused() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let pane = plain_pane(&daemon, &ws);
    let err = daemon
        .orchestrate_submit(pane, "a result".to_string().into())
        .expect_err("a pane nobody spawned has nobody to submit to")
        .to_string();
    assert!(
        err.contains("was not spawned by an agent — nothing to submit to"),
        "{err}"
    );
}

#[tokio::test]
async fn hook_drop_links_session_to_its_transcript() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: ws,
            cmd: Some(sleeper()),
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
        .unwrap();
    let db_path = state.path().join("test.db");
    // The two link columns first, then every other column of the row as text.
    // `detected_agent` is left out: any Claude hook drop marks it, link or not.
    let row = |id: u32| -> Vec<Option<String>> {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let mut cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('sessions')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .filter(|c| {
                !["transcript_path", "native_session_id", "detected_agent"].contains(&c.as_str())
            })
            .collect();
        cols.insert(0, "native_session_id".into());
        cols.insert(0, "transcript_path".into());
        let select = cols
            .iter()
            .map(|c| format!("CAST({c} AS TEXT)"))
            .collect::<Vec<_>>()
            .join(", ");
        conn.query_row(
            &format!("SELECT {select} FROM sessions WHERE id = ?1"),
            [id],
            |r| {
                (0..cols.len())
                    .map(|i| r.get::<_, Option<String>>(i))
                    .collect()
            },
        )
        .unwrap()
    };
    let before = row(info.id);
    assert_eq!(before[0], None);
    assert_eq!(before[1], None);

    let drop = HookDrop {
        v: hook_drop::DROP_V,
        event: "SessionStart".into(),
        session: info.id,
        transcript_path: Some("/home/u/.claude/projects/-ws/abc.jsonl".into()),
        session_id: Some("abc-native".into()),
        ..Default::default()
    };
    let path = hook_drop::write_drop(
        &hook_drop::drop_dir(state.path()),
        &drop,
        hook_drop::now_ms(),
    )
    .unwrap();
    wait_until("the drop to be applied", || !path.exists()).await;
    wait_until("the link to be stored", || row(info.id)[0].is_some()).await;

    let after = row(info.id);
    assert_eq!(
        after[0].as_deref(),
        Some("/home/u/.claude/projects/-ws/abc.jsonl")
    );
    assert_eq!(after[1].as_deref(), Some("abc-native"));
    assert_eq!(
        after[2..],
        before[2..],
        "no other column of the row changed"
    );
}

#[tokio::test]
async fn a_sub_agent_drop_never_replaces_the_root_conversation_link() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    let db_path = state.path().join("test.db");
    let link = |id: u32| -> (Option<String>, Option<String>) {
        rusqlite::Connection::open(&db_path)
            .unwrap()
            .query_row(
                "SELECT transcript_path, native_session_id FROM sessions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    };
    let apply = |session: u32, agent: &str, event: &str, id: &str, path: Option<&str>| {
        let drop = HookDrop {
            v: hook_drop::DROP_V,
            agent: Some(agent.into()),
            event: event.into(),
            session,
            session_id: Some(id.into()),
            transcript_path: path.map(str::to_string),
            ..Default::default()
        };
        hook_drop::write_drop(
            &hook_drop::drop_dir(state.path()),
            &drop,
            hook_drop::now_ms(),
        )
        .unwrap()
    };
    let pane = |daemon: &Arc<Daemon>| {
        daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: ws.clone(),
                cmd: Some(sleeper()),
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
    };

    // OpenCode: a child session's permission prompt and its SubagentStop carry
    // the child's id (fixtures opencode-1.18.27-04 and -05).
    let opencode = pane(&daemon);
    let p = apply(opencode, "opencode", "session.created", "ses_root01", None);
    wait_until("the root drop", || !p.exists()).await;
    assert_eq!(link(opencode).1.as_deref(), Some("ses_root01"));
    for event in ["permission.asked", "SubagentStop"] {
        let p = apply(opencode, "opencode", event, "ses_child01", None);
        wait_until("the child drop", || !p.exists()).await;
        assert_eq!(
            link(opencode).1.as_deref(),
            Some("ses_root01"),
            "OpenCode {event} for a child session replaced the root id"
        );
    }

    // Antigravity: a sub-agent's drops carry its own conversationId and
    // transcript (fixtures antigravity-1.1.26-07 and -08).
    let agy = pane(&daemon);
    let p = apply(
        agy,
        "antigravity",
        "SessionStart",
        "conv-root-1",
        Some("/t/root.jsonl"),
    );
    wait_until("the root drop", || !p.exists()).await;
    for event in ["SessionStart", "Stop"] {
        let p = apply(
            agy,
            "antigravity",
            event,
            "conv-sub-1",
            Some("/t/sub.jsonl"),
        );
        wait_until("the sub-agent drop", || !p.exists()).await;
        assert_eq!(
            link(agy),
            (Some("/t/root.jsonl".into()), Some("conv-root-1".into())),
            "Antigravity sub-agent {event} replaced the root link"
        );
    }
}

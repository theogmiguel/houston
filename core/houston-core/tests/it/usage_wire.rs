use crate::common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn future_window() -> (i64, i64) {
    let start = now_ms() + DAY_MS;
    (start, start + DAY_MS)
}

fn seed_rate_table(state_dir: &std::path::Path) {
    let dir = state_dir.join("usage");
    std::fs::create_dir_all(&dir).unwrap();
    let body = serde_json::json!({
        "fetched_at_ms": now_ms(),
        "source": "seeded by usage_wire.rs",
        "document": {
            "claude-opus-5": { "input_cost_per_token": 1.0e-5, "output_cost_per_token": 1.0e-4 }
        }
    });
    std::fs::write(dir.join("model-prices.json"), body.to_string()).unwrap();
}

#[tokio::test]
async fn a_valid_window_gets_a_direct_reply_naming_every_place_it_looked() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    seed_rate_table(state.path());
    let (since_ms, until_ms) = future_window();

    let proto::ServerMsg::UsageSummary {
        since_ms: echoed_since,
        until_ms: echoed_until,
        read_at_ms,
        buckets,
        sources,
        pricing,
        untracked_agents,
        ..
    } = daemon
        .usage_summary(since_ms, until_ms, false)
        .expect("valid window")
    else {
        panic!("expected UsageSummary");
    };

    assert_eq!(
        echoed_since, since_ms,
        "the reply echoes the window it answered"
    );
    assert_eq!(echoed_until, until_ms);
    assert!(read_at_ms > 0);
    assert!(
        buckets.is_empty(),
        "a window that starts tomorrow can contain nothing"
    );

    assert!(sources
        .iter()
        .any(|s| s.provider == proto::UsageProvider::Claude));
    assert!(sources
        .iter()
        .any(|s| s.provider == proto::UsageProvider::Codex));
    for source in &sources {
        assert_eq!(source.scanned_files, 0, "the prefilter opened nothing");
        assert_eq!(source.failed_files, 0);
        assert!(
            matches!(
                source.status,
                proto::UsageSourceStatus::Ok | proto::UsageSourceStatus::Missing
            ),
            "a home that exists but has nothing in the window is Ok; one that does not is \
             Missing — neither is a failure: {source:?}"
        );
    }

    assert_eq!(pricing.status, proto::UsagePricingStatus::Cached);
    assert_eq!(pricing.known_models, 1);

    assert!(untracked_agents.contains(&proto::AgentKind::Antigravity));
    assert!(untracked_agents.contains(&proto::AgentKind::Opencode));
    assert!(untracked_agents.contains(&proto::AgentKind::Cursor));
    assert!(untracked_agents.contains(&proto::AgentKind::Grok));
    assert!(!untracked_agents.contains(&proto::AgentKind::Claude));
    assert!(!untracked_agents.contains(&proto::AgentKind::Codex));
}

#[tokio::test]
async fn an_empty_window_is_refused_and_says_what_it_needed() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    seed_rate_table(state.path());
    let now = now_ms();

    let err = daemon
        .usage_summary(now, now, false)
        .expect_err("until == since is empty");
    let text = format!("{err:#}");
    assert!(
        text.starts_with(proto::USAGE_WINDOW_REFUSED),
        "the renderer routes this refusal by its marker, not by prose: {text}"
    );
    assert!(text.contains("until_ms > since_ms"), "got: {text}");
    assert!(
        text.contains(&now.to_string()),
        "names the values asked for: {text}"
    );

    assert!(
        daemon.usage_summary(now, now - 1, false).is_err(),
        "a reversed window is refused, not silently swapped"
    );
}

#[tokio::test]
async fn a_window_past_the_cap_is_refused_naming_the_cap_and_the_ask() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    seed_rate_table(state.path());
    let now = now_ms();
    let over = i64::from(proto::USAGE_MAX_WINDOW_DAYS) * DAY_MS + 1;

    let err = daemon
        .usage_summary(now - over, now, false)
        .expect_err("wider than the cap");
    let text = format!("{err:#}");
    assert!(text.starts_with(proto::USAGE_WINDOW_REFUSED), "got: {text}");
    assert!(
        text.contains(&proto::USAGE_MAX_WINDOW_DAYS.to_string()),
        "names the limit: {text}"
    );
    assert!(text.contains("limit is"), "got: {text}");
    assert!(
        text.contains(&over.to_string()),
        "names what was asked for: {text}"
    );

    let at_cap = i64::from(proto::USAGE_MAX_WINDOW_DAYS) * DAY_MS;
    let future = now + 400 * DAY_MS;
    assert!(
        daemon.usage_summary(future, future + at_cap, false).is_ok(),
        "the cap itself is a legal window"
    );
}

#[tokio::test]
async fn the_reply_goes_only_to_the_asking_client_never_as_a_broadcast() {
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    seed_rate_table(state.path());
    let (since_ms, until_ms) = future_window();

    let mut asker = connect_and_hello(addr, TOKEN).await;
    let mut bystander = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut asker).await;
    let _ = next_control(&mut bystander).await;

    asker
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::UsageSummaryGet {
                since_ms,
                until_ms,
                refresh_pricing: false,
                workspace: None,
            })
            .unwrap(),
        ))
        .await
        .unwrap();

    let reply = next_control(&mut asker).await;
    assert!(
        matches!(reply, proto::ServerMsg::UsageSummary { .. }),
        "the asking client gets the summary, got {reply:?}"
    );

    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        next_control(&mut bystander),
    )
    .await;
    assert!(
        quiet.is_err(),
        "a second window must not receive the summary: {quiet:?}"
    );
}

#[tokio::test]
async fn a_refused_window_travels_back_as_an_error_not_an_empty_summary() {
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    seed_rate_table(state.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let now = now_ms();

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageSummaryGet {
            since_ms: now,
            until_ms: now - 1,
            refresh_pricing: false,
            workspace: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    match next_control(&mut ws).await {
        proto::ServerMsg::Error { message, context } => {
            assert_eq!(context.as_deref(), Some("usage_summary"));
            assert!(
                message.starts_with(proto::USAGE_WINDOW_REFUSED),
                "the marker is what routes this to the Usage section: {message}"
            );
        }
        other => panic!("expected an Error, got {other:?}"),
    }
}

#[test]
fn workspace_filter_counts_only_sessions_in_that_workspace() {
    use houston_core::usage::{scan, ScanRequest, SourceSpec};
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("projects");
    std::fs::create_dir_all(&root).unwrap();
    for (session, workspace) in [("s1", "/project/one"), ("s2", "/project/two")] {
        let record = serde_json::json!({
            "type": "assistant", "timestamp": "2026-08-27T10:00:00Z",
            "sessionId": session, "cwd": workspace, "requestId": session,
            "message": {"id": session, "model": "claude-opus-5",
                "usage": {"input_tokens": 10, "output_tokens": 50}}
        });
        std::fs::write(root.join(format!("{session}.jsonl")), format!("{record}\n")).unwrap();
    }
    let mut request = ScanRequest {
        since_ms: 0,
        until_ms: i64::MAX / 2,
        catalog: houston_core::model_catalog::ModelCatalog::new(state.path()).load(false, false),
        state_dir: state.path().to_path_buf(),
        sources: vec![SourceSpec {
            provider: proto::UsageProvider::Claude,
            root,
            profile_name: None,
        }],
        workspaces: vec!["/project/one".into(), "/project/two".into()],
        workspace_filter: Some("/project/one".into()),
    };
    let out = scan(&request);
    assert_eq!(out.buckets.len(), 1);
    assert_eq!(out.sources[0].distinct_sessions, 1);
    // Repeat from the transcript cache with a different selection.
    request.workspace_filter = Some("/project/missing".into());
    assert_eq!(scan(&request).sources[0].distinct_sessions, 0);
    request.workspace_filter = None;
    assert_eq!(scan(&request).sources[0].distinct_sessions, 2);
}

#[tokio::test]
async fn a_refused_year_window_has_an_activity_error_context() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let now = now_ms();
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageActivitySummaryGet {
            since_ms: now,
            until_ms: now - 1,
            workspace: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    match next_control(&mut ws).await {
        proto::ServerMsg::Error { context, .. } => {
            assert_eq!(context.as_deref(), Some("usage_activity"));
        }
        other => panic!("expected an Error, got {other:?}"),
    }
}

#[test]
fn model_sessions_are_distinct_across_hours_days_and_workspace_filtered() {
    use houston_core::usage::{scan, ScanRequest, SourceSpec};
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("transcripts");
    let workspace = state.path().join("project");
    let other = state.path().join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    seed_rate_table(state.path());
    let stamp = |day: u32, hour: u32| format!("2026-10-{day:02}T{hour:02}:00:00Z");
    let local_day = |value: &str| {
        houston_core::usage::time::local_date_from_ms(
            houston_core::usage::time::parse_rfc3339_ms(value).unwrap(),
        )
    };
    let hour = (0..20)
        .find(|hour| local_day(&stamp(5, *hour)) == local_day(&stamp(5, *hour + 4)))
        .unwrap();
    let stamps = [
        stamp(5, hour),
        stamp(5, hour + 1),
        stamp(5, hour + 2),
        stamp(6, hour),
        stamp(5, hour + 3),
        stamp(5, hour + 4),
    ];
    let mut lines = Vec::new();
    for (id, session, stamp, cwd, model) in [
        ("1", "session-a", &stamps[0], &workspace, "claude-opus-5"),
        ("2", "session-a", &stamps[1], &workspace, "claude-opus-5"),
        ("3", "session-b", &stamps[2], &workspace, "claude-opus-5"),
        ("4", "session-a", &stamps[3], &workspace, "claude-opus-5"),
        ("5", "session-b", &stamps[4], &workspace, "claude-sonnet-5"),
        ("6", "session-c", &stamps[5], &other, "claude-opus-5"),
    ] {
        lines.push(
            serde_json::json!({
                "type": "assistant", "timestamp": stamp, "sessionId": session,
                "cwd": cwd, "requestId": format!("request-{id}"),
                "message": { "id": format!("message-{id}"), "model": model,
                    "usage": { "input_tokens": 100, "output_tokens": 50 } }
            })
            .to_string(),
        );
    }
    std::fs::write(root.join("sessions.jsonl"), lines.join("\n")).unwrap();
    let workspace_path = std::fs::canonicalize(&workspace)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let other_path = std::fs::canonicalize(&other)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let request = ScanRequest {
        since_ms: houston_core::usage::time::parse_rfc3339_ms("2026-10-04T00:00:00Z").unwrap(),
        until_ms: houston_core::usage::time::parse_rfc3339_ms("2026-10-08T00:00:00Z").unwrap(),
        catalog: houston_core::model_catalog::ModelCatalog::new(state.path()).load(false, false),
        state_dir: state.path().to_path_buf(),
        sources: vec![SourceSpec {
            provider: proto::UsageProvider::Claude,
            root,
            profile_name: None,
        }],
        workspaces: vec![workspace_path.clone(), other_path],
        workspace_filter: Some(workspace_path),
    };
    let first_day = local_day(&stamps[0]);
    let second_day = local_day(&stamps[3]);
    for _ in 0..2 {
        let outcome = scan(&request);
        let model = outcome
            .session_counts
            .models
            .iter()
            .find(|row| row.model == "claude-opus-5")
            .unwrap();
        assert_eq!(
            model.sessions, 2,
            "one session crossing hours and days counts once in the window"
        );
        assert_eq!(
            model
                .days
                .iter()
                .find(|day| day.day == first_day)
                .unwrap()
                .sessions,
            2
        );
        assert_eq!(
            model
                .days
                .iter()
                .find(|day| day.day == second_day)
                .unwrap()
                .sessions,
            1
        );
        assert_eq!(outcome.session_counts.models.len(), 2);
        assert_eq!(
            outcome
                .session_counts
                .days
                .iter()
                .find(|day| day.day == first_day)
                .unwrap()
                .sessions,
            2,
            "switching model must not overcount a daily session"
        );
        assert_eq!(
            outcome
                .session_counts
                .days
                .iter()
                .find(|day| day.day == second_day)
                .unwrap()
                .sessions,
            1
        );
        assert_eq!(
            outcome
                .buckets
                .iter()
                .map(|bucket| bucket.sessions)
                .sum::<u32>(),
            5,
            "the fixture demonstrates why hourly counts cannot be summed"
        );
        let reply = proto::ServerMsg::UsageSummary {
            since_ms: request.since_ms,
            until_ms: request.until_ms,
            read_at_ms: now_ms(),
            buckets: outcome.buckets,
            sources: outcome.sources,
            pricing: outcome.pricing,
            untracked_agents: houston_core::usage::untracked_agents(),
            scan_duration_ms: outcome.scan_duration_ms,
            session_counts: Some(outcome.session_counts),
        };
        let mut value = serde_json::to_value(reply).unwrap();
        let decoded: proto::ServerMsg = serde_json::from_value(value.clone()).unwrap();
        assert!(matches!(
            decoded,
            proto::ServerMsg::UsageSummary {
                session_counts: Some(_),
                ..
            }
        ));
        value.as_object_mut().unwrap().remove("session_counts");
        let older: proto::ServerMsg = serde_json::from_value(value).unwrap();
        assert!(matches!(
            older,
            proto::ServerMsg::UsageSummary {
                session_counts: None,
                ..
            }
        ));
    }
}

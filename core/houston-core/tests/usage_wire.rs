mod common;

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
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    match next_control(&mut ws).await {
        proto::ServerMsg::Error { message, .. } => {
            assert!(
                message.starts_with(proto::USAGE_WINDOW_REFUSED),
                "the marker is what routes this to the Usage section: {message}"
            );
        }
        other => panic!("expected an Error, got {other:?}"),
    }
}

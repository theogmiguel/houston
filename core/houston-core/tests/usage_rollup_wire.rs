mod common;

use common::{connect_and_hello, next_control};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

const DAY_MS: i64 = 86_400_000;
const TOKEN: &str = "test-token-0000-0000-000000000000";

struct HomeRestore {
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
}

impl HomeRestore {
    fn use_temp(path: &std::path::Path) -> Self {
        let restore = Self {
            home: std::env::var_os("HOME"),
            userprofile: std::env::var_os("USERPROFILE"),
        };
        std::env::set_var("HOME", path);
        std::env::set_var("USERPROFILE", path);
        restore
    }
}

impl Drop for HomeRestore {
    fn drop(&mut self) {
        if let Some(value) = self.home.take() {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(value) = self.userprofile.take() {
            std::env::set_var("USERPROFILE", value);
        } else {
            std::env::remove_var("USERPROFILE");
        }
    }
}

async fn start(
    state_dir: &std::path::Path,
) -> (
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
    std::sync::Arc<Daemon>,
) {
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.into(),
        db_path: state_dir.join("houston.db"),
    })
    .unwrap();
    let (addr, server_task) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    (addr, server_task, daemon)
}

fn write_usage(path: &std::path::Path, cwd: &str, id: &str, timestamp: i64, speed: &str) {
    let stamp = chrono_free_rfc3339(timestamp);
    let value = serde_json::json!({
        "type": "assistant",
        "timestamp": stamp,
        "cwd": cwd,
        "sessionId": id,
        "requestId": format!("request-{id}"),
        "speed": speed,
        "message": {
            "id": format!("message-{id}"),
            "model": "claude-opus-5",
            "usage": {
                "input_tokens": 100,
                "cache_read_input_tokens": 20,
                "cache_creation_input_tokens": 10,
                "output_tokens": 50
            }
        }
    });
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    use std::io::Write;
    writeln!(file, "{value}").unwrap();
}

fn chrono_free_rfc3339(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let day_ms = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_ms / 3_600_000,
        (day_ms / 60_000) % 60,
        (day_ms / 1_000) % 60,
        day_ms % 1_000
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn seed_prices(state_dir: &std::path::Path) {
    let usage = state_dir.join("usage");
    std::fs::create_dir_all(&usage).unwrap();
    std::fs::write(
        usage.join("model-prices.json"),
        serde_json::json!({
            "fetched_at_ms": 1_800_000_000_000_i64,
            "source": "fixture",
            "document": {
                "claude-opus-5": {
                    "input_cost_per_token": 0.00001,
                    "output_cost_per_token": 0.0001,
                    "provider_specific_entry": { "fast": 1.5 }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn usage_rollup_is_workspace_filtered_durable_and_bounded_on_the_wire() {
    let home = tempfile::tempdir().unwrap();
    let _restore = HomeRestore::use_temp(home.path());
    let state = tempfile::tempdir().unwrap();
    seed_prices(state.path());

    let workspace = home.path().join("project");
    let worktree = workspace.join(".houston/worktrees/review");
    let other = home.path().join("other-project");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let (addr, mut server_task, daemon) = start(state.path()).await;
    daemon.workspace_add(workspace.to_str().unwrap()).unwrap();
    daemon.workspace_add(other.to_str().unwrap()).unwrap();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let transcript = home.path().join(".claude/projects/demo/session.jsonl");
    write_usage(
        &transcript,
        worktree.to_str().unwrap(),
        "fast",
        now - 300,
        "fast",
    );
    write_usage(
        &transcript,
        other.to_str().unwrap(),
        "standard",
        now - 200,
        "standard",
    );

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageSummaryGet {
            since_ms: now - 1_000,
            until_ms: now + 1,
            refresh_pricing: false,
            workspace: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let proto::ServerMsg::UsageSummary { buckets, .. } = next_control(&mut ws).await else {
        panic!("expected UsageSummary");
    };
    assert_eq!(buckets.len(), 2);
    let fast = buckets
        .iter()
        .find(|bucket| bucket.fast_cost_usd > 0.0)
        .unwrap();
    let split_cost = fast.category_cost_usd.input_usd
        + fast.category_cost_usd.cache_read_usd
        + fast.category_cost_usd.cache_write_usd
        + fast.category_cost_usd.output_usd
        + fast.category_cost_usd.other_usd;
    assert!((split_cost - fast.cost_usd).abs() < 1e-12);
    assert!(fast.speed_premium_usd > 0.0);
    assert!(fast.speed_rate_available);

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageSummaryGet {
            since_ms: now - 1_000,
            until_ms: now + 1,
            refresh_pricing: false,
            workspace: Some(workspace.to_string_lossy().into_owned()),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let proto::ServerMsg::UsageSummary { buckets, .. } = next_control(&mut ws).await else {
        panic!("expected filtered UsageSummary");
    };
    assert_eq!(buckets.len(), 1);
    assert_eq!(
        buckets[0].workspace_path.as_deref(),
        Some(workspace.to_str().unwrap())
    );

    let since_ms = now - i64::from(proto::USAGE_ACTIVITY_MAX_DAYS - 1) * DAY_MS;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageActivitySummaryGet {
            since_ms,
            until_ms: now + 1,
            workspace: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let proto::ServerMsg::UsageActivitySummary { days, .. } = next_control(&mut ws).await else {
        panic!("expected UsageActivitySummary");
    };
    assert!(days.len() <= proto::USAGE_ACTIVITY_MAX_DAYS as usize);
    let recorded_day = days.iter().find(|day| day.cost_usd > 0.0).cloned().unwrap();

    assert!(
        daemon
            .usage_activity_summary(
                now - i64::from(proto::USAGE_ACTIVITY_MAX_DAYS) * DAY_MS,
                now + 1,
                None
            )
            .is_err(),
        "the request refuses a window spanning more than 365 local days"
    );

    std::fs::remove_file(&transcript).unwrap();
    drop(ws);
    server_task.abort();
    let _ = (&mut server_task).await;
    drop(daemon);

    let (addr, mut server_task, restarted) = start(state.path()).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::UsageActivitySummaryGet {
            since_ms,
            until_ms: now + 1,
            workspace: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let proto::ServerMsg::UsageActivitySummary { days, .. } = next_control(&mut ws).await else {
        panic!("expected persisted UsageActivitySummary after restart");
    };
    let after_restart = days.iter().find(|day| day.day == recorded_day.day).unwrap();
    assert_eq!(after_restart, &recorded_day);
    drop(ws);
    server_task.abort();
    let _ = (&mut server_task).await;
    drop(restarted);
}

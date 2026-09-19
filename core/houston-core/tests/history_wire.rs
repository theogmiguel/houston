mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

fn seed_command_history(db_path: &std::path::Path, workspace: &str, n: usize) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    for i in 0..n {
        conn.execute(
            "INSERT INTO command_history
             (workspace, session_id, cwd, cmd, exit_code, shell, git_branch, started_at, ended_at)
             VALUES (?1, 1, ?2, ?3, 0, 'bash', NULL, 0, 1)",
            rusqlite::params![workspace, workspace, format!("echo {i}")],
        )
        .unwrap();
    }
}

async fn drain_hello(ws: &mut WsStream) {
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(ws).await {
            break;
        }
    }
}

async fn start_daemon_with_db_path() -> (std::net::SocketAddr, tempfile::TempDir, std::path::PathBuf)
{
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let daemon = houston_core::daemon::Daemon::new(houston_core::daemon::DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let (addr, _handle) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());
    (addr, state_dir, db_path)
}

#[tokio::test]
async fn history_count_reports_seeded_rows_across_every_workspace() {
    let (addr, _state_dir, db_path) = start_daemon_with_db_path().await;
    seed_command_history(&db_path, "/ws/a", 3);
    seed_command_history(&db_path, "/ws/b", 5);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    drain_hello(&mut ws).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::HistoryCount).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HistoryCount { count } => {
                assert_eq!(
                    count, 8,
                    "the count is app-wide, the same rows Clear removes"
                );
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn history_count_with_no_history_is_zero_not_an_error() {
    let (addr, _state_dir, _db_path) = start_daemon_with_db_path().await;

    let mut ws = connect_and_hello(addr, TOKEN).await;
    drain_hello(&mut ws).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::HistoryCount).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HistoryCount { count } => {
                assert_eq!(count, 0);
                break;
            }
            proto::ServerMsg::Error { message, .. } => {
                panic!("an empty ledger must reply 0, not error: {message}")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn clearing_removes_every_workspaces_history() {
    let (addr, _state_dir, db_path) = start_daemon_with_db_path().await;
    seed_command_history(&db_path, "/ws/a", 4);
    seed_command_history(&db_path, "/ws/b", 6);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    drain_hello(&mut ws).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::HistoryClear { workspace: None }).unwrap(),
    ))
    .await
    .unwrap();

    let mut cleared = false;
    for _ in 0..50 {
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::HistoryCount).unwrap(),
        ))
        .await
        .unwrap();
        match next_control(&mut ws).await {
            proto::ServerMsg::HistoryCount { count } => {
                if count == 0 {
                    cleared = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    assert!(cleared, "both workspaces' rows must be gone");
}

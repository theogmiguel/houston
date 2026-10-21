use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

const BALLAST_BYTES: u64 = 4 * 1024 * 1024;

/// Writes and drops 4 MiB through a second connection, leaving those pages on the
/// database's freelist the way deleted history does.
fn bloat(db: &Path) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute_batch("CREATE TABLE ballast (b BLOB)").unwrap();
    for _ in 0..BALLAST_BYTES / 65_536 {
        conn.execute("INSERT INTO ballast VALUES (zeroblob(65536))", [])
            .unwrap();
    }
    conn.execute_batch("DROP TABLE ballast").unwrap();
    let _: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .unwrap();
}

fn free_bytes(daemon: &Daemon) -> u64 {
    let proto::ServerMsg::HostInfo {
        session_db_free_bytes,
        ..
    } = daemon.host_info()
    else {
        panic!("expected HostInfo");
    };
    session_db_free_bytes
}

async fn reclaim(ws: &mut WsStream) -> (u64, u64, Option<String>) {
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::StorageReclaim).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(ws).await {
            proto::ServerMsg::StorageReclaimed {
                before_bytes,
                after_bytes,
                refusal,
            } => return (before_bytes, after_bytes, refusal),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn next_host_info(ws: &mut WsStream) -> proto::ServerMsg {
    loop {
        match next_control(ws).await {
            m @ proto::ServerMsg::HostInfo { .. } => return m,
            _ => continue,
        }
    }
}

fn live_session(daemon: &Arc<Daemon>, dir: &Path) -> u32 {
    #[cfg(unix)]
    let cmd = vec!["sh".into(), "-c".into(), "sleep 600".into()];
    #[cfg(windows)]
    let cmd = vec!["ping".into(), "-n".into(), "601".into(), "127.0.0.1".into()];
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd),
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

#[tokio::test]
async fn host_info_reports_scrollback_and_log_totals() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let logs = state.path().join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("daemon.log"), [b'x'; 1000]).unwrap();
    std::fs::write(state.path().join("scrollback").join("7.bin"), [0u8; 500]).unwrap();
    let proto::ServerMsg::HostInfo {
        logs_bytes,
        scrollback_bytes,
        session_db_bytes,
        ..
    } = daemon.host_info()
    else {
        panic!("expected HostInfo");
    };
    assert_eq!(logs_bytes, 1000);
    assert_eq!(scrollback_bytes, 500);
    assert!(session_db_bytes > 0);
}

fn logs_bytes(daemon: &Daemon) -> u64 {
    let proto::ServerMsg::HostInfo { logs_bytes, .. } = daemon.host_info() else {
        panic!("expected HostInfo");
    };
    logs_bytes
}

#[tokio::test]
async fn host_info_polls_reuse_storage_totals_until_a_reclaim_measures_them() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let logs = state.path().join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("a.log"), [b'x'; 1000]).unwrap();
    assert_eq!(logs_bytes(&daemon), 1000);
    std::fs::write(logs.join("b.log"), [b'x'; 24]).unwrap();
    assert_eq!(
        logs_bytes(&daemon),
        1000,
        "a poll within the interval does not walk the directories again"
    );

    let mut asker = connect_and_hello(addr, TOKEN).await;
    let mut other = connect_and_hello(addr, TOKEN).await;
    let (_, _, refusal) = reclaim(&mut asker).await;
    assert_eq!(refusal, None);
    let proto::ServerMsg::HostInfo { logs_bytes, .. } = next_host_info(&mut other).await else {
        unreachable!()
    };
    assert_eq!(
        logs_bytes, 1024,
        "a reclaim reports freshly measured totals"
    );
}

#[tokio::test]
async fn reclaim_returns_free_pages_to_the_disk_and_rebroadcasts_host_info() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    bloat(&state.path().join("test.db"));
    assert!(
        free_bytes(&daemon) >= BALLAST_BYTES,
        "the dropped table's pages are reported as reclaimable"
    );
    let mut asker = connect_and_hello(addr, TOKEN).await;
    let mut other = connect_and_hello(addr, TOKEN).await;

    let (before, after, refusal) = reclaim(&mut asker).await;
    assert_eq!(refusal, None);
    assert!(
        before >= after + BALLAST_BYTES * 3 / 4,
        "VACUUM must shrink the database: {before} -> {after} bytes"
    );
    let proto::ServerMsg::HostInfo {
        session_db_free_bytes,
        session_db_wal_bytes,
        session_db_bytes,
        ..
    } = next_host_info(&mut other).await
    else {
        unreachable!()
    };
    assert_eq!(session_db_free_bytes, 0);
    assert_eq!(
        session_db_wal_bytes, 0,
        "the final checkpoint truncates the WAL"
    );
    assert_eq!(session_db_bytes, after);
}

#[tokio::test]
async fn reclaim_is_refused_while_a_session_is_live_and_changes_nothing() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    bloat(&state.path().join("test.db"));
    let project = houston_core::fixture_dirs::tempdir_outside_git();
    let id = live_session(&daemon, project.path());
    let mut ws = connect_and_hello(addr, TOKEN).await;

    let (before, after, refusal) = reclaim(&mut ws).await;
    let refusal = refusal.expect("a live session refuses the reclaim");
    assert!(refusal.contains("1 live session"), "{refusal}");
    assert!(
        refusal.contains("0 live sessions"),
        "names the limit: {refusal}"
    );
    assert_eq!(before, after);
    assert!(free_bytes(&daemon) >= BALLAST_BYTES, "nothing was vacuumed");

    daemon.session_close_checked(id, false).unwrap();
}

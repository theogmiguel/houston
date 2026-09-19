mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

fn create_custom_session(daemon: &Arc<Daemon>, dir: &std::path::Path, cmd: Vec<&str>) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd.into_iter().map(String::from).collect()),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap()
        .id
}

#[tokio::test]
async fn output_frames_carry_contiguous_stream_offsets() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();

    let id = create_custom_session(
        &daemon,
        tmp.path(),
        vec![
            "sh",
            "-c",
            "printf 'one\\n'; printf 'two\\n'; printf 'end\\n'",
        ],
    );

    let mut next_offset = 0u64;
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !acc.contains("end") {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("timed out waiting for output");
        let out = match tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out")
        {
            Ok(o) => o,
            Err(RecvError::Lagged(n)) => panic!(
                "broadcast receiver lagged by {n} messages -- the offset stream under test \
                 may have skipped frames rather than genuinely having none to skip"
            ),
            Err(RecvError::Closed) => panic!("daemon broadcast closed unexpectedly"),
        };
        if let Outbound::Frame(buf) = out {
            if let Some((s, offset, payload)) = proto::decode_output_frame(&buf) {
                if s == id {
                    assert_eq!(
                        offset, next_offset,
                        "frame offsets must be contiguous (expected {next_offset}, got {offset})"
                    );
                    next_offset = offset + payload.len() as u64;
                    acc.push_str(&String::from_utf8_lossy(payload));
                }
            }
        }
    }

    loop {
        match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
            Err(_) => break,
            Ok(Ok(Outbound::Frame(buf))) => {
                if let Some((s, offset, payload)) = proto::decode_output_frame(&buf) {
                    if s == id {
                        assert_eq!(
                            offset, next_offset,
                            "late frame offsets must stay contiguous \
                             (expected {next_offset}, got {offset})"
                        );
                        next_offset = offset + payload.len() as u64;
                    }
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(RecvError::Lagged(n))) => panic!(
                "broadcast receiver lagged by {n} messages while draining -- the offset \
                 stream under test may have skipped frames rather than genuinely having none"
            ),
            Ok(Err(RecvError::Closed)) => break,
        }
    }

    let replay = daemon.scrollback(id, None).unwrap();
    assert_eq!(replay.generation, 1);
    assert_eq!(
        replay.bytes_seen, next_offset,
        "bytes_seen equals total frame bytes"
    );
    assert_eq!(
        replay.replayed_bytes, replay.bytes_seen,
        "untrimmed ring replays the whole stream"
    );
    assert_eq!(replay.data.len() as u64, replay.replayed_bytes);

    daemon.kill(id).ok();
}

#[tokio::test]
async fn capped_scrollback_replays_a_tail() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let mut rx = daemon.observe();

    let id = create_custom_session(
        &daemon,
        tmp.path(),
        vec![
            "sh",
            "-c",
            "i=0; while [ $i -lt 1000 ]; do printf 'line-%04d----------------------------------\\n' $i; i=$((i+1)); done; printf 'flood-done\\n'",
        ],
    );
    collect_broadcast_until(&mut rx, id, "flood-done").await;

    let replay = daemon.scrollback(id, Some(2048)).unwrap();
    assert!(
        replay.replayed_bytes <= 2048,
        "cap respected, got {}",
        replay.replayed_bytes
    );
    assert!(
        replay.bytes_seen > 30_000,
        "the session produced far more than the cap"
    );
    let text = String::from_utf8_lossy(&replay.data);
    assert!(
        text.contains("flood-done"),
        "tail includes the newest output"
    );
    assert!(
        replay.data.starts_with(b"\x1b[0m"),
        "a partial replay is prefixed with an SGR reset"
    );

    daemon.kill(id).ok();
}

#[tokio::test]
async fn scrollback_survives_a_daemon_restart_for_live_sessions() {
    std::env::set_var("HOUSTON_SAFE_MODE", "1");
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let tmp = tempfile::tempdir().unwrap();

    let (id, seen_before) = {
        let daemon = Daemon::new(DaemonConfig {
            token: TOKEN.to_string(),
            db_path: db_path.clone(),
        })
        .unwrap();
        let mut rx = daemon.observe();
        let id = create_custom_session(
            &daemon,
            tmp.path(),
            vec!["sh", "-c", "echo persist-me-marker; sleep 600"],
        );
        collect_broadcast_until(&mut rx, id, "persist-me-marker").await;

        let seen = daemon.scrollback(id, None).unwrap().bytes_seen;
        daemon.persist_all();
        (id, seen)
    };

    {
        let conn = rusqlite_open(&db_path);
        conn.execute("UPDATE sessions SET agent = 'shell' WHERE id = ?1", [id])
            .unwrap();
    }
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let s = daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .expect("husk restored");
    assert_eq!(s.state, proto::SessionState::Interrupted);

    let replay = daemon.scrollback(id, None).unwrap();
    assert_eq!(replay.generation, 1);
    assert_eq!(
        replay.bytes_seen, seen_before,
        "stream accounting survives the restart"
    );
    assert_eq!(replay.replayed_bytes, replay.bytes_seen);
    assert!(
        String::from_utf8_lossy(&replay.data).contains("persist-me-marker"),
        "husk replays the persisted scrollback"
    );
}

#[tokio::test]
async fn closing_a_husk_removes_its_persisted_scrollback() {
    std::env::set_var("HOUSTON_SAFE_MODE", "1");
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let tmp = tempfile::tempdir().unwrap();

    let id = {
        let daemon = Daemon::new(DaemonConfig {
            token: TOKEN.to_string(),
            db_path: db_path.clone(),
        })
        .unwrap();
        let mut rx = daemon.observe();
        let id = create_custom_session(
            &daemon,
            tmp.path(),
            vec!["sh", "-c", "echo gone-soon; sleep 600"],
        );
        collect_broadcast_until(&mut rx, id, "gone-soon").await;
        daemon.persist_all();
        id
    };
    {
        let conn = rusqlite_open(&db_path);
        conn.execute("UPDATE sessions SET agent = 'shell' WHERE id = ?1", [id])
            .unwrap();
    }

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let ring = state_dir
        .path()
        .join("scrollback")
        .join(format!("{id}.bin"));
    assert!(ring.exists(), "persisted ring survives the restart GC");
    daemon.close(id).unwrap();
    assert!(!ring.exists(), "close deletes the persisted ring");
}

#[tokio::test]
async fn corrupt_persisted_ring_degrades_to_empty_replay() {
    std::env::set_var("HOUSTON_SAFE_MODE", "1");
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let tmp = tempfile::tempdir().unwrap();

    let id = {
        let daemon = Daemon::new(DaemonConfig {
            token: TOKEN.to_string(),
            db_path: db_path.clone(),
        })
        .unwrap();
        let mut rx = daemon.observe();
        let id = create_custom_session(
            &daemon,
            tmp.path(),
            vec!["sh", "-c", "echo will-corrupt; sleep 600"],
        );
        collect_broadcast_until(&mut rx, id, "will-corrupt").await;
        daemon.persist_all();
        id
    };
    {
        let conn = rusqlite_open(&db_path);
        conn.execute("UPDATE sessions SET agent = 'shell' WHERE id = ?1", [id])
            .unwrap();
    }
    let ring = state_dir
        .path()
        .join("scrollback")
        .join(format!("{id}.bin"));
    std::fs::write(&ring, b"Houston").unwrap();

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let replay = daemon.scrollback(id, None).unwrap();
    assert!(
        replay.data.is_empty(),
        "corrupt ring replays empty, not an error"
    );
    assert_eq!(replay.replayed_bytes, 0);
    assert_eq!(replay.bytes_seen, 0);
}

fn rusqlite_open(path: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}

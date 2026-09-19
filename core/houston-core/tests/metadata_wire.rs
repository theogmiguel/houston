mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

fn create_custom_session(
    daemon: &std::sync::Arc<Daemon>,
    dir: &std::path::Path,
    cmd: Vec<&str>,
) -> proto::SessionInfo {
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
}

#[tokio::test]
async fn session_cwds_batches_and_never_fails_whole() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp_a = tempfile::tempdir().unwrap();
    let tmp_b = tempfile::tempdir().unwrap();

    let a = create_custom_session(&daemon, tmp_a.path(), vec!["sleep", "30"]);
    let b = create_custom_session(&daemon, tmp_b.path(), vec!["sleep", "30"]);

    let entries = daemon.session_cwds(&[a.id, b.id, 9999]);
    assert_eq!(entries.len(), 3);
    let canon = |p: &str| std::fs::canonicalize(p).unwrap();
    assert_eq!(
        canon(entries[0].cwd.as_deref().unwrap()),
        canon(&tmp_a.path().display().to_string())
    );
    assert_eq!(
        canon(entries[1].cwd.as_deref().unwrap()),
        canon(&tmp_b.path().display().to_string())
    );
    assert_eq!(
        entries[2],
        proto::SessionCwdEntry {
            session: 9999,
            cwd: None
        }
    );

    daemon.kill(a.id).ok();
    daemon.kill(b.id).ok();
}

#[tokio::test]
async fn running_procs_is_a_process_tree_fact() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    #[cfg(unix)]
    let (with_child_argv, childless_argv): (Vec<&str>, Vec<&str>) =
        (vec!["sh", "-c", "sleep 30"], vec!["sleep", "30"]);
    #[cfg(windows)]
    let (with_child_argv, childless_argv): (Vec<&str>, Vec<&str>) = (
        vec!["cmd", "/C", "cmd /C ping -n 31 127.0.0.1 > nul"],
        vec!["ping", "-n", "31", "127.0.0.1"],
    );
    let with_child = create_custom_session(&daemon, tmp.path(), with_child_argv);
    let childless = create_custom_session(&daemon, tmp.path(), childless_argv);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let entries = daemon.session_running_procs(&[with_child.id, childless.id, 9999]);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].has_procs, None, "unknown id must be null");
        if entries[0].has_procs == Some(true) {
            assert_eq!(entries[1].has_procs, Some(false));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "sh child never observed: {entries:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    daemon.kill(with_child.id).ok();
    daemon.kill(childless.id).ok();
}

#[tokio::test]
async fn visibility_filters_frames_per_connection() {
    let (addr, _state) = start_daemon().await;
    let tmp = tempfile::tempdir().unwrap();
    let mut a = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut a).await;
    let mut b = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut b).await;

    #[cfg(unix)]
    let tick_argv: Vec<&str> = vec!["sh", "-c", "while true; do echo TICK; sleep 0.05; done"];
    #[cfg(windows)]
    let tick_argv: Vec<&str> = vec![
        "powershell",
        "-NoProfile",
        "-Command",
        "while($true){ Write-Output TICK; Start-Sleep -Milliseconds 50 }",
    ];
    a.send(Message::text(create_custom_msg(tick_argv, tmp.path())))
        .await
        .unwrap();
    let info = expect_created(&mut a).await;

    send(
        &mut a,
        &proto::ClientMsg::SessionVisibility {
            session: info.id,
            visible: false,
        },
    )
    .await;
    send(&mut a, &proto::ClientMsg::SessionList).await;
    loop {
        if let proto::ServerMsg::SessionList { .. } = next_control(&mut a).await {
            break;
        }
    }

    send(
        &mut b,
        &proto::ClientMsg::SessionVisibility {
            session: info.id,
            visible: true,
        },
    )
    .await;
    collect_output_until(&mut b, info.id, "TICK").await;

    let quiet = tokio::time::timeout(Duration::from_millis(600), async {
        loop {
            match a
                .next()
                .await
                .expect("socket closed")
                .expect("socket error")
            {
                Message::Binary(buf) => {
                    if let Some((id, _, _)) = proto::decode_output_frame(&buf) {
                        if id == info.id {
                            return;
                        }
                    }
                }
                _ => continue,
            }
        }
    })
    .await;
    assert!(
        quiet.is_err(),
        "hidden session leaked an output frame to the hiding client"
    );

    send(
        &mut a,
        &proto::ClientMsg::SessionVisibility {
            session: info.id,
            visible: true,
        },
    )
    .await;
    collect_output_until(&mut a, info.id, "TICK").await;
}

#[tokio::test]
async fn wait_for_idle_answers_quiet_busy_dead_and_unknown() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();
    let quiet_session = create_custom_session(&daemon, tmp.path(), vec!["sleep", "30"]);
    daemon
        .wait_for_idle(1, quiet_session.id, Some(5_000), Some(100))
        .unwrap();
    assert!(
        expect_broadcast_idle(&mut rx, 1).await,
        "silent session must be idle"
    );

    let mut rx = daemon.observe();
    #[cfg(unix)]
    let busy_argv: Vec<&str> = vec!["sh", "-c", "while true; do echo BUSY; sleep 0.05; done"];
    #[cfg(windows)]
    let busy_argv: Vec<&str> = vec![
        "powershell",
        "-NoProfile",
        "-Command",
        "while($true){ Write-Output BUSY; Start-Sleep -Milliseconds 50 }",
    ];
    let busy_session = create_custom_session(&daemon, tmp.path(), busy_argv);
    collect_broadcast_until(&mut rx, busy_session.id, "BUSY").await;
    daemon
        .wait_for_idle(2, busy_session.id, Some(400), Some(5_000))
        .unwrap();
    assert!(
        !expect_broadcast_idle(&mut rx, 2).await,
        "a session printing every 50ms cannot satisfy a 5s quiet window"
    );

    #[cfg(unix)]
    let dead_argv: Vec<&str> = vec!["sh", "-c", "exit 0"];
    #[cfg(windows)]
    let dead_argv: Vec<&str> = vec!["cmd", "/C", "exit 0"];
    let dead_session = create_custom_session(&daemon, tmp.path(), dead_argv);
    wait_for_state(&daemon, dead_session.id, proto::SessionState::Exited).await;
    let mut rx = daemon.observe();
    daemon
        .wait_for_idle(3, dead_session.id, Some(5_000), Some(60_000))
        .unwrap();
    assert!(
        expect_broadcast_idle(&mut rx, 3).await,
        "a dead session is idle"
    );

    let err = daemon.wait_for_idle(4, 9999, None, None).unwrap_err();
    assert!(
        err.to_string().contains("9999"),
        "error must name the id: {err}"
    );
}

async fn expect_broadcast_idle(rx: &mut houston_core::frame_queue::Observer, request: u32) -> bool {
    loop {
        match next_broadcast_control(rx).await {
            proto::ServerMsg::Idle {
                request: r, idle, ..
            } if r == request => return idle,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

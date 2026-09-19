mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;

#[tokio::test]
async fn hello_with_wrong_token_is_rejected() {
    let (addr, _state) = start_daemon().await;
    let mut ws = connect_and_hello(addr, "wrong-token-0000-0000-000000000000").await;
    match next_control(&mut ws).await {
        proto::ServerMsg::Error { message, .. } => assert!(message.contains("invalid token")),
        other => panic!("expected error, got {other:?}"),
    }
}

#[tokio::test]
async fn session_runs_and_exits() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();

    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            #[cfg(windows)]
            cmd: Some(vec!["cmd".into(), "/c".into(), "echo TRACER_OK".into()]),
            #[cfg(not(windows))]
            cmd: Some(vec!["bash".into(), "-lc".into(), "echo TRACER_OK".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    assert_eq!(info.state, proto::SessionState::Running);

    let out = collect_broadcast_until(&mut rx, info.id, "TRACER_OK").await;
    assert!(out.contains("TRACER_OK"));

    wait_for_state(&daemon, info.id, proto::SessionState::Exited).await;
}

#[tokio::test]
async fn stdin_reaches_the_pty_and_kill_works() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            cmd: Some(vec!["cat".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    let id = info.id;

    let mut rx = daemon.observe();
    daemon.write_stdin(id, b"ping-tracer\n").unwrap();

    let out = collect_broadcast_until(&mut rx, id, "ping-tracer").await;
    assert!(out.contains("ping-tracer"));

    daemon.kill(id).unwrap();
    wait_for_state(&daemon, id, proto::SessionState::Killed).await;
}

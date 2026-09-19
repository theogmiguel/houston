#![cfg_attr(windows, allow(dead_code))]

mod common;

use common::*;
#[cfg(unix)]
use futures_util::SinkExt as _;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;

const DA1_REPLY_HEX: &str = "1b5b3f36323b323263";

const FIXTURE: &str = r#"printf 'READY\n'
head -n 1 >/dev/null
stty raw -echo min 0 time 20
printf '\033[c'
reply=''
i=0
while [ $i -lt 3 ]; do
  reply="$reply$(dd bs=64 count=1 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  i=$((i+1))
done
stty sane
printf 'DA1=[%s]\r\n' "$reply"
sleep 5
"#;

fn spawn_test_daemon() -> (Arc<Daemon>, tempfile::TempDir) {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    (daemon, state_dir)
}

fn spawn_fixture(daemon: &Arc<Daemon>, dir: &std::path::Path) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(vec![
                "sh".to_string(),
                "-c".to_string(),
                FIXTURE.to_string(),
            ]),
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

fn ring(daemon: &Daemon, id: u32) -> String {
    String::from_utf8_lossy(&daemon.scrollback(id, None).unwrap().data).into_owned()
}

async fn wait_for_ring(daemon: &Daemon, id: u32, needle: &str, within: Duration) -> String {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let seen = ring(daemon, id);
        if seen.contains(needle) {
            return seen;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("{needle:?} never reached session {id}'s ring within {within:?}; ring holds: {seen:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_pane_nobody_is_watching_gets_its_terminal_question_answered() {
    let (daemon, tmp) = spawn_test_daemon();
    let id = spawn_fixture(&daemon, tmp.path());

    wait_for_ring(&daemon, id, "READY", Duration::from_secs(15)).await;
    daemon.write_stdin(id, b"\n").unwrap();

    let seen = wait_for_ring(&daemon, id, "DA1=[", Duration::from_secs(20)).await;
    assert!(
        seen.contains(&format!("DA1=[{DA1_REPLY_HEX}")),
        "an unwatched pane must get the daemon's device-attributes reply \
         ({DA1_REPLY_HEX}); its ring holds: {seen:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_pane_a_ws_client_is_watching_is_answered_by_that_client_not_the_daemon() {
    let (addr, tmp, daemon) = start_daemon_with_handle().await;
    let id = spawn_fixture(&daemon, tmp.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let hello = next_control(&mut ws).await;
    assert!(matches!(hello, proto::ServerMsg::HelloOk { .. }));
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session: id,
            replay_bytes: None,
            snapshot: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Scrollback { session, .. } = next_control(&mut ws).await {
            if session == id {
                break;
            }
        }
    }

    wait_for_ring(&daemon, id, "READY", Duration::from_secs(15)).await;
    daemon.write_stdin(id, b"\n").unwrap();

    let seen = wait_for_ring(&daemon, id, "DA1=[", Duration::from_secs(20)).await;
    assert!(
        seen.contains("DA1=[]"),
        "a watched pane must be answered by its client's engine, not the \
         daemon; its ring holds: {seen:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn an_unwatched_pane_gets_a_cursor_position_report_only_an_emulator_can_give() {
    const CURSOR_FIXTURE: &str = r#"printf 'READY\n'
head -n 1 >/dev/null
stty raw -echo min 0 time 20
printf '\033[3;7H\033[6n'
reply=''
i=0
while [ $i -lt 3 ]; do
  reply="$reply$(dd bs=64 count=1 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  i=$((i+1))
done
stty sane
printf 'CPR=[%s]\r\n' "$reply"
sleep 5
"#;
    let (daemon, tmp) = spawn_test_daemon();
    let id = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            cmd: Some(vec![
                "sh".to_string(),
                "-c".to_string(),
                CURSOR_FIXTURE.to_string(),
            ]),
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
        .id;

    wait_for_ring(&daemon, id, "READY", Duration::from_secs(15)).await;
    daemon.write_stdin(id, b"\n").unwrap();

    let seen = wait_for_ring(&daemon, id, "CPR=[", Duration::from_secs(20)).await;
    assert!(
        seen.contains("CPR=[1b5b333b3752"),
        "an unwatched pane must get the emulator's cursor-position report \
         (ESC [ 3 ; 7 R = 1b5b333b3752); its ring holds: {seen:?}"
    );
}

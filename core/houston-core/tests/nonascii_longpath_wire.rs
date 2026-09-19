mod common;

use common::{collect_output_until, connect_and_hello, next_control, try_expect_created, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig, SafeModeFlags};
use houston_core::server;
use houston_protocol as proto;

use tokio_tungstenite::tungstenite::Message;

const MARKER: &str = "Houston-PATH-FIXTURE-ECHO";

fn no_auto_restore() -> SafeModeFlags {
    SafeModeFlags {
        disable_auto_restore: true,
        ..Default::default()
    }
}

fn create_shell_msg(dir: &std::path::Path) -> String {
    serde_json::to_string(&proto::ClientMsg::SessionCreate {
        agent: proto::AgentKind::Shell,
        project_dir: dir.display().to_string(),
        cmd: None,
        cols: Some(80),
        rows: Some(24),
        cwd_from: None,
        shell_integration: Some(false),
        auto_approve: None,
        acp: None,
        profile: None,
        prompt: None,
    })
    .unwrap()
}

async fn drive_spawn_persist_reopen(
    db_path: std::path::PathBuf,
    workspace: &std::path::Path,
) -> Result<(), String> {
    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: TOKEN.to_string(),
            db_path: db_path.clone(),
        },
        no_auto_restore(),
    )
    .unwrap();
    let (addr, server_handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_shell_msg(workspace)))
        .await
        .unwrap();
    let info = match try_expect_created(&mut ws).await {
        Ok(info) => info,
        Err(message) => {
            drop(ws);
            server_handle.abort();
            drop(daemon);
            return Err(message);
        }
    };

    assert_eq!(
        info.project_dir,
        workspace.display().to_string(),
        "project_dir must round-trip the wire unmangled"
    );
    assert_eq!(
        info.cwd,
        workspace.display().to_string(),
        "spawn cwd must round-trip the wire unmangled"
    );

    let keystrokes = format!("echo {MARKER}\n");
    ws.send(Message::Binary(
        proto::encode_stdin_frame(info.id, keystrokes.as_bytes()).into(),
    ))
    .await
    .unwrap();
    collect_output_until(&mut ws, info.id, MARKER).await;

    let seen_before = daemon.scrollback(info.id, None).unwrap().bytes_seen;
    drop(ws);
    server_handle.abort();
    daemon.persist_all();
    drop(daemon);

    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: TOKEN.to_string(),
            db_path,
        },
        no_auto_restore(),
    )
    .unwrap();

    let husk = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must come back as a husk");
    assert_eq!(husk.state, proto::SessionState::Interrupted);
    assert_eq!(
        husk.project_dir,
        workspace.display().to_string(),
        "husked project_dir must survive the restart unmangled"
    );
    assert_eq!(
        husk.cwd,
        workspace.display().to_string(),
        "husked cwd must survive the restart unmangled"
    );

    let replay = daemon.scrollback(info.id, None).unwrap();
    assert_eq!(replay.generation, 1);
    assert_eq!(
        replay.bytes_seen, seen_before,
        "stream accounting must survive the restart"
    );
    assert_eq!(replay.replayed_bytes, replay.bytes_seen);
    assert!(
        String::from_utf8_lossy(&replay.data).contains(MARKER),
        "husk must replay the persisted scrollback"
    );

    daemon.close(info.id).unwrap();
    Ok(())
}

#[tokio::test]
async fn shell_session_survives_an_accented_project_dir_end_to_end() {
    let state = tempfile::tempdir().unwrap();
    let workspace = state.path().join("ação");
    std::fs::create_dir_all(&workspace).unwrap();
    drive_spawn_persist_reopen(state.path().join("test.db"), &workspace)
        .await
        .expect("an accented project dir must spawn");
}

#[cfg(windows)]
#[tokio::test]
async fn shell_session_survives_a_project_dir_longer_than_max_path() {
    let state = tempfile::tempdir().unwrap();
    let mut workspace = state.path().to_path_buf();
    for _ in 0..60 {
        workspace.push("ação");
    }
    if let Err(err) = std::fs::create_dir_all(&workspace) {
        eprintln!(
            "skipping >260 scenario: filesystem refused to create the deep \
             tree ({err}); expected until the installer's manifest declares \
             longPathAware"
        );
        return;
    }
    assert!(
        workspace.as_os_str().len() > 260,
        "fixture must actually exceed MAX_PATH, got {}",
        workspace.display()
    );
    match drive_spawn_persist_reopen(state.path().join("test.db"), &workspace).await {
        Ok(()) => {}
        Err(message) if message.contains("has no bootstrap entry to cd into it") => {
            assert!(
                message.contains("powershell/pwsh/cmd"),
                "the refusal must name the supported shells: {message}"
            );
            eprintln!(
                "skipping >260 scenario: this box's default shell has no \
                 over-long-dir bootstrap ({message}); supported shells are \
                 powershell/pwsh/cmd"
            );
        }
        Err(message) => panic!("daemon error: {message}"),
    }
}

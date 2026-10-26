#![allow(clippy::disallowed_methods)]

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::db::Db;
use houston_core::host_env::HostEnv;
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

fn pane(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    #[cfg(unix)]
    let cmd = vec!["sleep".into(), "60".into()];
    #[cfg(windows)]
    let cmd = vec!["ping".into(), "-n".into(), "61".into(), "127.0.0.1".into()];
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
}

async fn post(base: &str, token: &str, payload: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(format!("{base}/orchestrate/note"))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn next_note(ws: &mut WsStream, session: u32) -> Option<proto::PaneNote> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SessionNote { session: s, note } if s == session => return note,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

fn listed_note(daemon: &Daemon, session: u32) -> Option<proto::PaneNote> {
    daemon
        .list()
        .into_iter()
        .find(|info| info.id == session)
        .expect("the pane is listed")
        .note
}

#[tokio::test]
async fn an_agent_posts_a_note_the_rail_lists_and_the_user_clears() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = state.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    daemon
        .workspace_add(&workspace.display().to_string())
        .unwrap();
    let info = pane(&daemon, &workspace);
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: info.id,
        workspace_id: workspace.display().to_string(),
    });
    let base = format!("http://{addr}");
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let env = HostEnv::from_pairs([
        ("HOUSTON_SESSION", info.id.to_string()),
        ("HOUSTON_MCP_URL", format!("{base}/mcp")),
        ("HOUSTON_MCP_TOKEN", token.clone()),
    ]);
    let args: Vec<String> = [
        "note",
        "fix",
        "implemented;\nrunning",
        "tests",
        "--phase",
        "in_progress",
    ]
    .map(String::from)
    .to_vec();
    let code = tokio::task::spawn_blocking(move || {
        houston_core::orchestrate::run_pane_cli_in(&env, &args)
    })
    .await
    .unwrap();
    assert_eq!(code, 0, "hs-pane note exits cleanly");
    let note = next_note(&mut ws, info.id)
        .await
        .expect("the write is broadcast");
    assert_eq!(note.text, "fix implemented; running tests");
    assert_eq!(note.phase, Some(proto::PanePhase::InProgress));
    assert_eq!(listed_note(&daemon, info.id), Some(note.clone()));

    let oversized = "x".repeat(proto::PANE_NOTE_MAX_BYTES + 1);
    let (status, body) = post(&base, &token, json!({"text": oversized})).await;
    assert!(
        status >= 400,
        "an oversized note is refused, got {status}: {body}"
    );
    let error = body.to_string();
    assert!(
        error.contains("513 bytes") && error.contains("the limit is 512 bytes"),
        "{error}"
    );
    assert_eq!(
        listed_note(&daemon, info.id),
        Some(note),
        "a refused note keeps the last one"
    );

    let (status, body) = post(&base, &token, json!({"text": "x", "clear": true})).await;
    assert!(status >= 400, "text with clear is refused: {body}");

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionNoteClear { session: info.id }).unwrap(),
    ))
    .await
    .unwrap();
    assert_eq!(next_note(&mut ws, info.id).await, None);
    assert_eq!(listed_note(&daemon, info.id), None);
    daemon.kill(info.id).ok();
}

#[test]
fn a_note_round_trips_on_its_session_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(&dir.path().join("test.db")).unwrap();
    let path = dir.path().display().to_string();
    let info: proto::SessionInfo = serde_json::from_value(json!({
        "id": 7, "agent": "custom", "project_dir": path, "cwd": path,
        "state": "running", "title": "Max",
    }))
    .unwrap();
    db.insert_session(&info).unwrap();
    let note = proto::PaneNote {
        text: "in review".into(),
        phase: Some(proto::PanePhase::InReview),
        at_ms: 1_800_000_000_000,
    };
    db.update_session_note(7, Some(&note)).unwrap();
    assert_eq!(db.session_notes().unwrap(), vec![(7, note)]);
    db.update_session_note(7, None).unwrap();
    assert!(db.session_notes().unwrap().is_empty());
    let error = db.update_session_note(9, None).unwrap_err().to_string();
    assert!(error.contains("no session row with id 9"), "{error}");
}

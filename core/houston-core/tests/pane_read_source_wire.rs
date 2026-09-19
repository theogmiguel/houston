#![cfg(unix)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

const REPAINTING: &str = "#!/bin/sh\nstty -echo 2>/dev/null\n\
    printf '\\033[2J\\033[1;1HSCREEN-ALPHA\\033[3;7HSCREEN-BETA indented\\033[5;1HSCREEN-OMEGA'\n\
    exec cat > /dev/null\n";
const LINE_PRINTING: &str = "#!/bin/sh\nstty -echo 2>/dev/null\n\
    printf 'LINE-ONE\\nLINE-TWO\\nLINE-THREE\\n'\n\
    exec cat > /dev/null\n";

static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for (name, body) in [("grok", REPAINTING), ("codex", LINE_PRINTING)] {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

async fn http_json(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let (method, path, token) = (method.to_string(), path.to_string(), token.to_string());
    tokio::task::spawn_blocking(move || {
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            addr,
            payload.len()
        );
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("http status line");
        let value: serde_json::Value =
            serde_json::from_str(resp.trim_start()).unwrap_or(serde_json::Value::Null);
        (status, value)
    })
    .await
    .unwrap()
}

struct Rig {
    daemon: Arc<Daemon>,
    addr: SocketAddr,
    _state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str) -> Rig {
    shim_dir();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    Rig {
        daemon,
        addr,
        _state: state,
        ws_dir,
    }
}

impl Rig {
    fn parent(&self) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PANE-UP; exec cat".into(),
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
            .expect("fixture pane spawns")
    }

    fn token_for(&self, session: u32) -> String {
        self.daemon.mcp_creds.issue(McpScope {
            session_id: session,
            workspace_id: self.ws_dir.display().to_string(),
        })
    }

    async fn spawn_child(&self, token: &str, kind: &str) -> u32 {
        let (status, body) = http_json(
            self.addr,
            "POST",
            "/orchestrate/spawn",
            token,
            Some(serde_json::json!({"kind": kind, "prompt": "stand there"})),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        body["session_id"].as_u64().unwrap() as u32
    }

    async fn read(&self, token: &str, child: u32, source: &str, marker: &str) -> Vec<String> {
        let mut last = Vec::new();
        for _ in 0..200 {
            let (status, body) = http_json(
                self.addr,
                "GET",
                &format!("/orchestrate/read?session={child}&lines=50&source={source}"),
                token,
                None,
            )
            .await;
            assert_eq!(status, 200, "read body: {body}");
            last = body["lines"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(|v| v.as_str())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if last.iter().any(|l| l.contains(marker)) {
                return last;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{source} never showed {marker}: {last:?}");
    }
}

#[tokio::test]
async fn screen_and_tail_disagree_on_a_pane_that_repaints() {
    let _guard = serial().await;
    let r = rig("read-source-repaint").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    let child = r.spawn_child(&token, "grok").await;

    let screen = r.read(&token, child, "screen", "SCREEN-OMEGA").await;
    assert!(
        screen.contains(&"SCREEN-ALPHA".to_string()),
        "the first row is its own line: {screen:?}"
    );
    assert!(
        screen.contains(&"      SCREEN-BETA indented".to_string()),
        "an indent drawn with cursor motion survives: {screen:?}"
    );
    assert!(
        screen.contains(&"SCREEN-OMEGA".to_string()),
        "and so does the last row: {screen:?}"
    );

    let tail = r.read(&token, child, "tail", "SCREEN-OMEGA").await;
    assert_eq!(
        tail.len(),
        1,
        "no newline in the ring, so one line: {tail:?}"
    );
    assert!(
        tail[0].contains("SCREEN-ALPHASCREEN-BETA"),
        "tail runs the rows together, indent gone: {tail:?}"
    );
    assert_ne!(screen, tail);
}

#[tokio::test]
async fn screen_and_tail_agree_on_a_pane_that_prints_lines() {
    let _guard = serial().await;
    let r = rig("read-source-lines").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    let child = r.spawn_child(&token, "codex").await;

    let screen = r.read(&token, child, "screen", "LINE-THREE").await;
    let tail = r.read(&token, child, "tail", "LINE-THREE").await;
    assert_eq!(screen, vec!["LINE-ONE", "LINE-TWO", "LINE-THREE"]);
    assert_eq!(screen, tail);
}

#[tokio::test]
async fn a_read_that_names_no_source_gets_the_screen() {
    let _guard = serial().await;
    let r = rig("read-source-default").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    let child = r.spawn_child(&token, "grok").await;
    r.read(&token, child, "screen", "SCREEN-OMEGA").await;

    let (status, body) = http_json(
        r.addr,
        "GET",
        &format!("/orchestrate/read?session={child}&lines=50"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    let lines: Vec<String> = body["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .map(str::to_string)
        .collect();
    assert!(
        lines.contains(&"      SCREEN-BETA indented".to_string()),
        "the default is the screen: {lines:?}"
    );
}

#[tokio::test]
async fn an_unknown_source_is_refused_by_name() {
    let _guard = serial().await;
    let r = rig("read-source-refusal").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    let child = r.spawn_child(&token, "codex").await;

    let (status, body) = http_json(
        r.addr,
        "GET",
        &format!("/orchestrate/read?session={child}&source=raw"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 400, "body: {body}");
    let err = body["error"].as_str().unwrap();
    assert!(err.contains("raw"), "names what it got: {err}");
    assert!(err.contains("screen"), "names the values: {err}");
    assert!(err.contains("tail"), "names the values: {err}");
}

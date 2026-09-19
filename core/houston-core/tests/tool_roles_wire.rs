#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

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
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nif [ -z \"$FIXTURE_SILENT\" ]; then\nprintf 'ARGV:%s\\n' \"$*\"\necho FIXTURE-READY\nfi\nstty -echo 2>/dev/null\nexec cat\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}{sep}{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
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
    Rig {
        daemon,
        addr,
        _state: state,
        ws_dir,
    }
}

impl Rig {
    fn pane(&self) -> proto::SessionInfo {
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

    async fn mcp(&self, token: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
        let (token, method, params) = (token.to_string(), method.to_string(), params);
        let addr = self.addr;
        tokio::task::spawn_blocking(move || {
            let payload = serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
            })
            .to_string();
            let req = format!(
                "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let mut stream = std::net::TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(req.as_bytes()).unwrap();
            let mut raw = String::new();
            stream.read_to_string(&mut raw).unwrap();
            let (_, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
            serde_json::from_str(resp.trim_start()).unwrap()
        })
        .await
        .unwrap()
    }

    async fn tools_list(&self, token: &str) -> Vec<serde_json::Value> {
        let body = self.mcp(token, "tools/list", serde_json::json!({})).await;
        body["result"]["tools"].as_array().unwrap().clone()
    }

    async fn spawn_child(&self, parent_token: &str, prompt: &str) -> u32 {
        let (parent_token, prompt) = (parent_token.to_string(), prompt.to_string());
        let addr = self.addr;
        let (status, body): (u16, serde_json::Value) =
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::json!({"kind": "grok", "prompt": prompt}).to_string();
                let req = format!(
                    "POST /orchestrate/spawn HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {parent_token}\r\n\
                     Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
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
            .unwrap();
        assert_eq!(status, 200, "spawn failed: {body}");
        body["session_id"].as_u64().unwrap() as u32
    }
}

fn tool_names(tools: &[serde_json::Value]) -> Vec<String> {
    let mut names: Vec<String> = tools
        .iter()
        .map(|t| t["name"].as_str().unwrap_or_default().to_string())
        .collect();
    names.sort();
    names
}

fn response_bytes(tools: &[serde_json::Value]) -> usize {
    serde_json::json!({ "tools": tools }).to_string().len()
}

#[tokio::test]
async fn a_leaf_child_sees_exactly_two_tools_with_every_provider_registered() {
    let _guard = serial().await;
    let r = rig("leaf-two-tools").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.pane();
    let parent_token = r.token_for(parent.id);
    let child = r.spawn_child(&parent_token, "leaf brief").await;
    let child_token = r.token_for(child);

    let tools = r.tools_list(&child_token).await;
    let names = tool_names(&tools);
    assert_eq!(
        names,
        vec!["pane_submit".to_string(), "workspace_info".to_string()],
        "a leaf child must see exactly its handback and its identity: {names:?}"
    );

    let leaf_bytes = response_bytes(&tools);
    let parent_tools = r.tools_list(&parent_token).await;
    let orchestrator_bytes = response_bytes(&parent_tools);

    r.daemon.orchestration_set(false).unwrap();
    let operator = r.pane();
    let operator_tools = r.tools_list(&r.token_for(operator.id)).await;
    let operator_bytes = response_bytes(&operator_tools);
    assert!(
        operator_tools.iter().all(|t| {
            let n = t["name"].as_str().unwrap_or_default();
            !n.starts_with("pane_")
        }),
        "an operator pane with the switch off sees no pane tool: {:?}",
        tool_names(&operator_tools)
    );

    eprintln!(
        "tool_roles bytes: leaf {leaf_bytes} B / orchestrator {orchestrator_bytes} B / \
         operator {operator_bytes} B"
    );
    assert!(
        leaf_bytes < 2_000,
        "the plan's leaf target is under 2 000 bytes; measured {leaf_bytes} B"
    );
}

#[tokio::test]
async fn a_hidden_tool_is_a_refused_tool() {
    let _guard = serial().await;
    let r = rig("hidden-refused").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.pane();
    let parent_token = r.token_for(parent.id);
    let child = r.spawn_child(&parent_token, "leaf brief").await;
    let child_token = r.token_for(child);

    let refused = r
        .mcp(
            &child_token,
            "tools/call",
            serde_json::json!({ "name": "pane_read", "arguments": { "session": child } }),
        )
        .await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    let message = refused["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.contains("leaf"), "{message}");
    assert!(message.contains("pane_read"), "{message}");
    assert!(message.contains("pane_submit"), "{message}");
    assert!(message.contains("workspace_info"), "{message}");

    let info = r
        .mcp(
            &child_token,
            "tools/call",
            serde_json::json!({ "name": "workspace_info" }),
        )
        .await;
    assert_eq!(info["result"]["isError"], false, "{info}");

    let read = r
        .mcp(
            &parent_token,
            "tools/call",
            serde_json::json!({ "name": "pane_read", "arguments": { "session": child } }),
        )
        .await;
    assert_eq!(read["result"]["isError"], false, "{read}");
}

async fn open_listen_stream(addr: SocketAddr, token: &str) -> tokio::net::TcpStream {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "GET /mcp HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\n\
         Authorization: Bearer {token}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut seen = Vec::new();
    let mut byte = [0u8; 1];
    while !seen.ends_with(b"\r\n\r\n") {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
            .await
            .expect("timed out reading the listening stream's head")
            .unwrap();
        assert!(n == 1, "listening stream closed before its head");
        seen.push(byte[0]);
    }
    stream
}

async fn listen_until(stream: &mut tokio::net::TcpStream, needle: &str) {
    let mut acc = String::new();
    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_else(|| panic!("timed out waiting for {needle:?}; read so far: {acc:?}"));
        let n = tokio::time::timeout(remaining, stream.read(&mut buf))
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; read so far: {acc:?}"))
            .unwrap();
        assert!(n > 0, "stream closed while waiting for {needle:?}: {acc:?}");
        acc.push_str(&String::from_utf8_lossy(&buf[..n]));
        if acc.contains(needle) {
            return;
        }
    }
}

#[tokio::test]
async fn a_role_change_pushes_tools_list_changed() {
    let _guard = serial().await;
    let r = rig("role-change").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.pane();
    let parent_token = r.token_for(parent.id);
    let child = r.spawn_child(&parent_token, "leaf brief").await;
    let child_token = r.token_for(child);

    let names = tool_names(&r.tools_list(&child_token).await);
    assert_eq!(
        names,
        vec!["pane_submit".to_string(), "workspace_info".to_string()],
        "starts a leaf: {names:?}"
    );

    let mut listening = open_listen_stream(r.addr, &child_token).await;

    r.daemon.set_orchestration_caps(4, 2).unwrap();

    listen_until(&mut listening, "notifications/tools/list_changed").await;

    let names = tool_names(&r.tools_list(&child_token).await);
    for must in ["pane_spawn", "pane_submit", "pane_list", "workspace_info"] {
        assert!(
            names.iter().any(|n| n == must),
            "now an orchestrator: {names:?}"
        );
    }
}

#[tokio::test]
async fn an_orchestrator_out_of_slots_keeps_its_management_verbs() {
    let _guard = serial().await;
    let r = rig("out-of-slots").await;
    r.daemon.orchestration_set(true).unwrap();
    r.daemon.set_orchestration_caps(1, 1).unwrap();
    let parent = r.pane();
    let parent_token = r.token_for(parent.id);
    r.spawn_child(&parent_token, "only slot").await;

    let names = tool_names(&r.tools_list(&parent_token).await);
    assert!(
        !names.iter().any(|n| n == "pane_spawn"),
        "no slot left, so no spawn verb: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n == "pane_submit"),
        "no parent means nothing to hand back to: {names:?}"
    );
    for kept in [
        "pane_list",
        "pane_get",
        "pane_read",
        "pane_prompt",
        "pane_wait",
        "pane_send_keys",
        "pane_kill",
        "workspace_info",
    ] {
        assert!(
            names.iter().any(|n| n == kept),
            "only the spawn verb drops: {names:?}"
        );
    }
}

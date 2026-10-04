#![cfg(unix)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_core::remote::feed::from_hook;
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN_IN_PROMPT: &str = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.body))
    }
}

async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Reply {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: {addr}\r\n");
    if let Some(token) = token {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(body) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(body) = body {
        req.push_str(body);
    }
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut raw))
        .await
        .expect("response within 10 s")
        .unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").expect("a complete response");
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    Reply { status, body }
}

fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        body = &rest[n + 2..];
    }
    out
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn enable(daemon: &Daemon) -> SocketAddr {
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{}", free_port())),
            ..Default::default()
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(addr) = daemon.remote_listen_state().listening {
            return addr;
        }
        assert!(tokio::time::Instant::now() < deadline, "no listener");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn pair(daemon: &Daemon, addr: SocketAddr) -> String {
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Test phone" }).to_string();
    let reply = request(addr, "POST", "/api/pair", None, Some(&body)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.json()["token"].as_str().unwrap().to_string()
}

fn pane(daemon: &Arc<Daemon>, cmd: &[&str]) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
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
    (info, dir)
}

/// A drop as the hook client writes it: the feed summary comes from the payload.
fn hook(agent: Option<&str>, event: &str, session: u32, payload: &serde_json::Value) -> HookDrop {
    let provider = match agent {
        Some("codex") => proto::AgentKind::Codex,
        _ => proto::AgentKind::Claude,
    };
    let text = payload.to_string();
    let prompt = payload["prompt"].as_str();
    HookDrop {
        v: hook_drop::DROP_V,
        event: event.into(),
        session,
        agent: agent.map(str::to_string),
        tool_name: payload["tool_name"].as_str().map(str::to_string),
        tool_use_id: payload["tool_use_id"].as_str().map(str::to_string),
        prompt: prompt.map(str::to_string),
        last_message: payload["last_assistant_message"]
            .as_str()
            .map(str::to_string),
        feed: from_hook(provider, event, &text, prompt),
        ..Default::default()
    }
}

async fn apply(state: &Path, d: &HookDrop) {
    let path = hook_drop::write_drop(&hook_drop::drop_dir(state), d, hook_drop::now_ms()).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never applied {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn fixture(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/claude")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn question_payload(options: usize) -> serde_json::Value {
    serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "AskUserQuestion",
        "tool_use_id": "toolu-question-feed",
        "tool_input": {"questions": [{
            "header": "Storage",
            "question": "Which store should the cache use?",
            "multiSelect": false,
            "options": (1..=options).map(|i| serde_json::json!({
                "label": format!("Store {i}"),
                "description": format!("Option number {i}")
            })).collect::<Vec<_>>()
        }]}
    })
}

async fn feed(addr: SocketAddr, token: &str, id: u32, after: u64) -> serde_json::Value {
    let reply = request(
        addr,
        "GET",
        &format!("/api/sessions/{id}/feed?after={after}"),
        Some(token),
        None,
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.json()
}

async fn session_row(addr: SocketAddr, token: &str, id: u32) -> serde_json::Value {
    let reply = request(addr, "GET", "/api/sessions", Some(token), None).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.json()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("pane {id} is not listed: {}", reply.body))
}

/// A decision in the feed's current epoch, read the way a device learns it.
async fn decide(addr: SocketAddr, token: &str, id: u32, seq: u64, choice: &str) -> Reply {
    let epoch = feed(addr, token, id, u64::MAX).await["epoch"]
        .as_str()
        .unwrap()
        .to_string();
    decide_in(addr, token, id, &epoch, seq, choice).await
}

async fn decide_in(
    addr: SocketAddr,
    token: &str,
    id: u32,
    epoch: &str,
    seq: u64,
    choice: &str,
) -> Reply {
    let body =
        serde_json::json!({ "epoch": epoch, "entry_seq": seq, "choice": choice }).to_string();
    request(
        addr,
        "POST",
        &format!("/api/sessions/{id}/decide"),
        Some(token),
        Some(&body),
    )
    .await
}

async fn screen_until(addr: SocketAddr, token: &str, id: u32, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let reply = request(
            addr,
            "GET",
            &format!("/api/sessions/{id}/screen?lines=40"),
            Some(token),
            None,
        )
        .await;
        let text = reply.json()["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if text.contains(needle) {
            return text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{needle:?} never appeared on pane {id}'s screen: {text:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn hook_payloads_become_a_masked_feed_with_a_pending_card() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let id = info.id;

    let mut prompt = fixture("claude-2.1.263-02-UserPromptSubmit.json");
    prompt["prompt"] = serde_json::json!(format!("deploy with token {TOKEN_IN_PROMPT}"));
    apply(state.path(), &hook(None, "UserPromptSubmit", id, &prompt)).await;
    let step = serde_json::json!({
        "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_use_id": "toolu-read",
        "tool_input": {"file_path": "/work/src/main.rs"}, "tool_response": {"content": "fn main() {}"}
    });
    apply(state.path(), &hook(None, "PostToolUse", id, &step)).await;
    let permission = fixture("claude-2.1.263-08-PermissionRequest.json");
    apply(
        state.path(),
        &hook(None, "PermissionRequest", id, &permission),
    )
    .await;

    let row = session_row(addr, &token, id).await;
    assert_eq!(row["kind"], "claude");
    assert_eq!(row["status"], "needs-input");
    assert_eq!(row["pending"]["type"], "permission");
    assert_eq!(row["pending"]["title"], "Bash");
    assert_eq!(row["pending"]["detail"], "touch probe-b.txt");
    assert_eq!(row["pending"]["decidable"], true);
    assert_eq!(row["last_step"], "Read /work/src/main.rs");
    assert!(row["waiting_since"].as_u64().is_some());

    let page = feed(addr, &token, id, 0).await;
    let types: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["prompt", "step", "permission"], "{page}");
    let text = page.to_string();
    assert!(
        !text.contains(TOKEN_IN_PROMPT),
        "the token is masked: {text}"
    );
    assert!(text.contains("[redacted:github_token]"), "{text}");
    assert!(
        !text.contains("Create probe-b.txt") && !text.contains("fn main"),
        "only the target leaves the tool input: {text}"
    );
    assert_eq!(page["pending"]["seq"], page["entries"][2]["seq"]);

    let last = page["last_seq"].as_u64().unwrap();
    let mut stop = fixture("claude-2.1.263-05-Stop.json");
    stop["last_assistant_message"] = serde_json::json!("## Done\nAll **green**.");
    apply(state.path(), &hook(None, "Stop", id, &stop)).await;
    let page = feed(addr, &token, id, last).await;
    let entries = page["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{page}");
    assert_eq!(entries[0]["type"], "reply");
    assert_eq!(entries[0]["text"], "## Done\nAll **green**.");
    assert_eq!(entries[1]["type"], "status");
    assert_eq!(entries[1]["status"], "finished");
    assert!(
        page["pending"].is_null(),
        "the card cleared once the turn ended"
    );
    let row = session_row(addr, &token, id).await;
    assert_eq!(row["last_reply_excerpt"], "## Done All **green**.");
    daemon.kill(id).ok();
}

#[tokio::test]
async fn decide_types_the_option_key_and_refuses_stale_or_unmapped_requests() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(
        &daemon,
        &[
            "sh",
            "-c",
            "stty raw -echo; printf 'KEYS-READY\\r\\n'; exec cat -v",
        ],
    );
    let id = info.id;
    screen_until(addr, &token, id, "KEYS-READY").await;

    let permission = fixture("claude-2.1.263-08-PermissionRequest.json");
    apply(
        state.path(),
        &hook(None, "PermissionRequest", id, &permission),
    )
    .await;
    let seq = session_row(addr, &token, id).await["pending"]["seq"]
        .as_u64()
        .unwrap();
    let stale = decide(addr, &token, id, seq + 7, "approve").await;
    assert_eq!(stale.status, 409, "{}", stale.body);
    assert!(
        stale.body.contains(&format!("entry {}", seq + 7)),
        "{}",
        stale.body
    );
    let unknown = decide(addr, &token, id, seq, "maybe").await;
    assert_eq!(unknown.status, 400, "{}", unknown.body);

    let approved = decide(addr, &token, id, seq, "approve").await;
    assert_eq!(approved.status, 200, "{}", approved.body);
    screen_until(addr, &token, id, "KEYS-READY\n1").await;
    let again = decide(addr, &token, id, seq, "deny").await;
    assert_eq!(
        again.status, 409,
        "a second tap waits for the agent: {}",
        again.body
    );
    assert_eq!(session_row(addr, &token, id).await["pending"]["sent"], true);

    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "go on"});
    apply(state.path(), &hook(None, "UserPromptSubmit", id, &prompt)).await;
    assert!(session_row(addr, &token, id).await["pending"].is_null());
    apply(
        state.path(),
        &hook(None, "PermissionRequest", id, &permission),
    )
    .await;
    let seq = session_row(addr, &token, id).await["pending"]["seq"]
        .as_u64()
        .unwrap();
    assert_eq!(decide(addr, &token, id, seq, "deny").await.status, 200);
    screen_until(addr, &token, id, "1^[").await;

    apply(state.path(), &hook(None, "UserPromptSubmit", id, &prompt)).await;
    apply(
        state.path(),
        &hook(None, "PreToolUse", id, &question_payload(3)),
    )
    .await;
    let row = session_row(addr, &token, id).await;
    assert_eq!(row["pending"]["type"], "question");
    assert_eq!(row["pending"]["title"], "Which store should the cache use?");
    let seq = row["pending"]["seq"].as_u64().unwrap();
    let out_of_range = decide(addr, &token, id, seq, "4").await;
    assert_eq!(out_of_range.status, 400, "{}", out_of_range.body);
    assert_eq!(decide(addr, &token, id, seq, "2").await.status, 200);
    screen_until(addr, &token, id, "1^[2").await;
    let mut answered = question_payload(3);
    answered["hook_event_name"] = serde_json::json!("PostToolUse");
    answered["tool_response"] =
        serde_json::json!({"answers": {"Which store should the cache use?": "Store 2"}});
    apply(state.path(), &hook(None, "PostToolUse", id, &answered)).await;
    let page = feed(addr, &token, id, seq).await;
    assert_eq!(page["entries"][0]["type"], "answer", "{page}");
    assert_eq!(page["entries"][0]["answers"][0], "Store 2");

    let (codex, _dir2) = pane(&daemon, &["sleep", "30"]);
    let request_payload = serde_json::json!({
        "hook_event_name": "PermissionRequest", "tool_name": "shell",
        "tool_input": {"command": ["cargo", "test"]}
    });
    apply(
        state.path(),
        &hook(
            Some("codex"),
            "PermissionRequest",
            codex.id,
            &request_payload,
        ),
    )
    .await;
    let row = session_row(addr, &token, codex.id).await;
    assert_eq!(row["pending"]["detail"], "cargo test");
    assert_eq!(row["pending"]["decidable"], false);
    let seq = row["pending"]["seq"].as_u64().unwrap();
    let refused = decide(addr, &token, codex.id, seq, "approve").await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert!(refused.body.contains("codex"), "{}", refused.body);
    daemon.kill(id).ok();
    daemon.kill(codex.id).ok();
}

/// Reads an open event stream until `needle` arrives.
async fn read_until(stream: &mut tokio::net::TcpStream, seen: &mut String, needle: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut buf = [0u8; 4096];
    while !seen.contains(needle) {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let n = tokio::time::timeout(left, stream.read(&mut buf))
            .await
            .unwrap_or_else(|_| panic!("{needle:?} never arrived on the event stream: {seen:?}"))
            .unwrap();
        assert!(n > 0, "the event stream closed before {needle:?}: {seen:?}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
}

async fn open_events(addr: SocketAddr, token: &str) -> (tokio::net::TcpStream, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /api/events HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nAccept: text/event-stream\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut seen = String::new();
    read_until(&mut stream, &mut seen, "\r\n\r\n").await;
    (stream, seen)
}

#[tokio::test]
async fn the_event_stream_announces_feed_and_session_changes() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);

    let unauthenticated = request(addr, "GET", "/api/events", None, None).await;
    assert_eq!(unauthenticated.status, 401);

    let (mut stream, mut seen) = open_events(addr, &token).await;
    assert!(seen.starts_with("HTTP/1.1 200"), "{seen}");
    assert!(
        seen.to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "{seen}"
    );
    read_until(&mut stream, &mut seen, "event: ready").await;

    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello"});
    apply(
        state.path(),
        &hook(None, "UserPromptSubmit", info.id, &prompt),
    )
    .await;
    read_until(
        &mut stream,
        &mut seen,
        &format!("event: feed\ndata: {{\"id\":{},\"seq\":1}}", info.id),
    )
    .await;
    read_until(
        &mut stream,
        &mut seen,
        &format!("event: session\ndata: {{\"id\":{}}}", info.id),
    )
    .await;

    let mut held = vec![stream];
    for _ in 1..houston_core::remote::EVENT_STREAMS_MAX {
        let (mut s, mut seen) = open_events(addr, &token).await;
        read_until(&mut s, &mut seen, "event: ready").await;
        held.push(s);
    }
    let over = request(addr, "GET", "/api/events", Some(&token), None).await;
    assert_eq!(over.status, 503, "{}", over.body);
    assert!(
        over.body
            .contains(&houston_core::remote::EVENT_STREAMS_MAX.to_string()),
        "{}",
        over.body
    );
    drop(held);
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn nothing_is_collected_while_remote_access_is_off() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "private"});
    apply(
        state.path(),
        &hook(None, "UserPromptSubmit", info.id, &prompt),
    )
    .await;
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let page = feed(addr, &token, info.id, 0).await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 0, "{page}");
    assert_eq!(page["last_seq"], 0);
    daemon.kill(info.id).ok();
}

/// Reads an event stream until the server ends it: the last chunk or EOF.
async fn read_to_end(stream: &mut tokio::net::TcpStream, seen: &mut String) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut buf = [0u8; 4096];
    loop {
        if seen.ends_with("\r\n0\r\n\r\n") {
            return;
        }
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let n = tokio::time::timeout(left, stream.read(&mut buf))
            .await
            .unwrap_or_else(|_| panic!("the event stream is still open: {seen:?}"))
            .unwrap_or(0);
        if n == 0 {
            return;
        }
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
}

async fn listening(daemon: &Daemon, want: bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while daemon.remote_listen_state().listening.is_some() != want {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the listener never became {}: {:?}",
            if want { "active" } else { "idle" },
            daemon.remote_listen_state()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn permission_card(addr: SocketAddr, token: &str, state: &Path, id: u32) -> u64 {
    let permission = fixture("claude-2.1.263-08-PermissionRequest.json");
    apply(state, &hook(None, "PermissionRequest", id, &permission)).await;
    session_row(addr, token, id).await["pending"]["seq"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn an_approved_card_takes_no_second_tap_while_the_tool_runs() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let id = info.id;
    let seq = permission_card(addr, &token, state.path(), id).await;
    assert_eq!(decide(addr, &token, id, seq, "approve").await.status, 200);
    // The pane keeps needing input until the approved tool finishes; no hook
    // reports the grant, so the card must not reopen on a timer.
    tokio::time::sleep(Duration::from_millis(10_500)).await;
    let again = decide(addr, &token, id, seq, "deny").await;
    assert_eq!(again.status, 409, "{}", again.body);
    let row = session_row(addr, &token, id).await;
    assert_eq!(row["pending"]["sent"], true, "{row}");
    daemon.kill(id).ok();
}

#[tokio::test]
async fn a_card_answered_in_the_terminal_takes_no_tap() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let id = info.id;
    let seq = permission_card(addr, &token, state.path(), id).await;
    daemon.note_operator_keystroke(id, b"1");
    let row = session_row(addr, &token, id).await;
    assert_eq!(row["pending"]["answered_elsewhere"], true, "{row}");
    assert_eq!(row["pending"]["sent"], false, "{row}");
    let refused = decide(addr, &token, id, seq, "deny").await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert!(refused.body.contains("terminal"), "{}", refused.body);
    daemon.kill(id).ok();
}

#[tokio::test]
async fn turning_remote_access_off_ends_streams_rebinds_and_forgets_the_feed() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let id = info.id;
    let seq = permission_card(addr, &token, state.path(), id).await;
    let epoch = feed(addr, &token, id, 0).await["epoch"]
        .as_str()
        .unwrap()
        .to_string();
    let (mut stream, mut seen) = open_events(addr, &token).await;
    read_until(&mut stream, &mut seen, "event: ready").await;

    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(false),
            ..Default::default()
        })
        .unwrap();
    read_to_end(&mut stream, &mut seen).await;
    listening(&daemon, false).await;

    // A hook applied while off is not collected.
    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "private"});
    apply(state.path(), &hook(None, "UserPromptSubmit", id, &prompt)).await;

    let addr = enable(&daemon).await;
    let page = feed(addr, &token, id, 0).await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 0, "{page}");
    assert!(page["pending"].is_null(), "{page}");
    assert_ne!(page["epoch"], epoch.as_str());
    let stale = decide_in(addr, &token, id, &epoch, seq, "approve").await;
    assert_eq!(stale.status, 409, "{}", stale.body);
    assert!(stale.body.contains("earlier feed"), "{}", stale.body);
    daemon.kill(id).ok();
}

#[tokio::test]
async fn revoking_a_device_ends_its_event_stream() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let me = request(addr, "GET", "/api/me", Some(&token), None).await;
    let device = me.json()["device_id"].as_i64().unwrap();
    let (mut stream, mut seen) = open_events(addr, &token).await;
    read_until(&mut stream, &mut seen, "event: ready").await;
    daemon.remote_device_revoke(device).unwrap();
    read_to_end(&mut stream, &mut seen).await;
}

#[tokio::test]
async fn a_feed_page_after_the_largest_sequence_is_empty() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let token = pair(&daemon, addr).await;
    let (info, _dir) = pane(&daemon, &["sleep", "30"]);
    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hi"});
    apply(
        state.path(),
        &hook(None, "UserPromptSubmit", info.id, &prompt),
    )
    .await;
    let page = feed(addr, &token, info.id, u64::MAX).await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 0, "{page}");
    // The feed still serves after that request.
    assert_eq!(feed(addr, &token, info.id, 0).await["last_seq"], 1);
    daemon.kill(info.id).ok();
}

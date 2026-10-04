#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static CLI_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn workspace(state: &Path) -> PathBuf {
    let ws = state.join("project");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::canonicalize(ws).unwrap()
}

fn plain_pane(daemon: &Arc<Daemon>, ws: &Path) -> u32 {
    daemon.workspace_add(&ws.display().to_string()).unwrap();
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: ws.to_path_buf(),
            cmd: Some(vec!["sh".into(), "-c".into(), "sleep 30".into()]),
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

fn token(daemon: &Daemon, pane: u32, ws: &Path) -> String {
    daemon.mcp_creds.issue(McpScope {
        session_id: pane,
        workspace_id: ws.display().to_string(),
    })
}

/// One request with a bearer token; answers the status and the JSON body.
async fn request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         Authorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").expect("an HTTP response");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .expect("a status code");
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut rest = body;
        while let Some((size, after)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            out.push_str(&after[..size]);
            rest = &after[size + 2..];
        }
        out
    } else {
        body.to_string()
    };
    let json =
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("body is not JSON ({e}): {body:?}"));
    (status, json)
}

async fn post(addr: std::net::SocketAddr, path: &str, token: &str, body: Value) -> (u16, Value) {
    request(addr, "POST", path, token, Some(body)).await
}

async fn mcp(addr: std::net::SocketAddr, token: &str, method: &str, params: Value) -> Value {
    let (status, v) = post(
        addr,
        "/mcp",
        token,
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    v
}

async fn tool_names(addr: std::net::SocketAddr, token: &str) -> Vec<String> {
    mcp(addr, token, "tools/list", json!({})).await["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

async fn call(addr: std::net::SocketAddr, token: &str, name: &str, args: Value) -> Value {
    mcp(
        addr,
        token,
        "tools/call",
        json!({ "name": name, "arguments": args }),
    )
    .await
}

/// The structured result of a tool that must succeed.
async fn ok_call(addr: std::net::SocketAddr, token: &str, name: &str, args: Value) -> Value {
    let result = call(addr, token, name, args).await;
    assert_eq!(result["result"]["isError"], false, "{name}: {result}");
    result["result"]["structuredContent"].clone()
}

/// The error text of a tool that must be refused.
async fn refused(addr: std::net::SocketAddr, token: &str, name: &str, args: Value) -> String {
    let result = call(addr, token, name, args).await;
    assert_eq!(result["result"]["isError"], true, "{name}: {result}");
    result["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string()
}

fn task_detail(
    msg: proto::ServerMsg,
) -> (
    proto::Task,
    Vec<proto::TaskComment>,
    Vec<proto::TaskHistoryEntry>,
) {
    let proto::ServerMsg::TaskDetail {
        task,
        comments,
        history,
        ..
    } = msg
    else {
        panic!("expected TaskDetail, got {msg:?}");
    };
    (task, comments, history)
}

struct Rig {
    daemon: Arc<Daemon>,
    addr: std::net::SocketAddr,
    _state: tempfile::TempDir,
    ws: PathBuf,
}

async fn rig() -> Rig {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws = workspace(state.path());
    Rig {
        daemon,
        addr,
        _state: state,
        ws,
    }
}

impl Rig {
    fn pane(&self) -> u32 {
        plain_pane(&self.daemon, &self.ws)
    }

    fn token_for(&self, pane: u32) -> String {
        token(&self.daemon, pane, &self.ws)
    }

    fn workspace(&self) -> String {
        self.ws.display().to_string()
    }
}

async fn open_listen_stream(addr: std::net::SocketAddr, token: &str) -> tokio::net::TcpStream {
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
async fn agents_create_get_update_and_list_tasks_with_attribution() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    let actor = r.daemon.task_actor(pane).unwrap();

    let created = ok_call(
        r.addr,
        &token,
        "task_create",
        json!({
            "title": "First agent task",
            "description": "written by an agent",
            "priority": "urgent",
            "acceptance": ["one", "two"],
        }),
    )
    .await;
    assert_eq!(created["key"], "HOU-1", "{created}");

    let listed = ok_call(r.addr, &token, "task_list", json!({})).await;
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed["tasks"][0]["key"], "HOU-1");
    assert_eq!(listed["tasks"][0]["created_by"], actor, "{listed}");

    let detail = ok_call(r.addr, &token, "task_get", json!({ "id": 1 })).await;
    assert_eq!(detail["task"]["description"], "written by an agent");
    assert_eq!(detail["acceptance"].as_array().unwrap().len(), 2);
    assert!(
        detail["task"]["created_by"]
            .as_str()
            .unwrap()
            .contains(&actor),
        "{detail}"
    );

    let stale = call(
        r.addr,
        &token,
        "task_update",
        json!({ "id": 1, "expected_revision": 99, "title": "stale" }),
    )
    .await;
    assert_eq!(stale["result"]["isError"], true, "{stale}");
    let text = stale["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("HOU-1"), "{text}");
    assert!(text.contains("expected revision 99"), "{text}");
    assert!(text.contains("actual revision 1"), "{text}");

    let updated = ok_call(
        r.addr,
        &token,
        "task_update",
        json!({
            "id": 1,
            "expected_revision": created["revision"],
            "status": "todo",
            "title": "First agent task, edited",
        }),
    )
    .await;
    assert_eq!(updated["revision"], 2, "{updated}");

    let (task, _, history) = task_detail(r.daemon.task_get(1).unwrap());
    assert_eq!(task.status, proto::TaskStatus::Todo);
    assert_eq!(task.title, "First agent task, edited");
    assert!(
        history
            .iter()
            .any(|entry| entry.actor == actor && entry.action == "create"),
        "the create is attributed to the pane: {history:?}"
    );
    assert!(
        history
            .iter()
            .any(|entry| entry.actor == actor && entry.action == "update"),
        "{history:?}"
    );
    assert_eq!(task.created_by, actor);
}

#[tokio::test]
async fn claim_check_and_handback_move_the_task_with_the_panes_provenance() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    let actor = r.daemon.task_actor(pane).unwrap();
    assert_eq!(
        actor,
        format!(
            "agent:{} (operator)",
            r.daemon.orchestrate_whoami(pane).unwrap().codename
        )
    );

    let created = ok_call(
        r.addr,
        &token,
        "task_create",
        json!({ "title": "Claim me", "status": "todo", "acceptance": ["item one"] }),
    )
    .await;
    let id = created["id"].as_i64().unwrap();

    let claimed = ok_call(r.addr, &token, "task_claim", json!({ "id": id })).await;
    assert_eq!(claimed["status"], "in_progress", "{claimed}");
    let (task, _, history) = task_detail(r.daemon.task_get(id).unwrap());
    assert_eq!(task.status, proto::TaskStatus::InProgress);
    let claim = history
        .iter()
        .find(|entry| entry.action == "claim" && entry.actor == actor)
        .expect("the claim is recorded");
    assert!(
        claim.changes.contains(&format!("\"session\":{pane}")),
        "the claim names the pane's session: {}",
        claim.changes
    );

    let again = ok_call(r.addr, &token, "task_claim", json!({ "id": id })).await;
    assert_eq!(again["status"], "in_progress", "{again}");
    assert_eq!(
        again["revision"], claimed["revision"],
        "a claim is idempotent"
    );

    let detail = ok_call(r.addr, &token, "task_get", json!({ "id": id })).await;
    let item = detail["acceptance"][0]["id"].as_i64().unwrap();
    ok_call(
        r.addr,
        &token,
        "task_check",
        json!({ "id": id, "item": item, "checked": true }),
    )
    .await;
    let (_, _, history) = task_detail(r.daemon.task_get(id).unwrap());
    assert!(
        history
            .iter()
            .any(|entry| entry.action == "check" && entry.actor == actor),
        "{history:?}"
    );

    let handed = ok_call(
        r.addr,
        &token,
        "task_handback",
        json!({ "id": id, "summary": "done, tests pass" }),
    )
    .await;
    assert_eq!(handed["status"], "in_review", "{handed}");
    let (task, comments, history) = task_detail(r.daemon.task_get(id).unwrap());
    assert_eq!(task.status, proto::TaskStatus::InReview);
    let comment = comments
        .iter()
        .find(|comment| comment.body == "done, tests pass")
        .expect("the summary is a comment");
    assert_eq!(comment.author, actor);
    assert!(
        history
            .iter()
            .any(|entry| entry.action == "handback" && entry.actor == actor),
        "{history:?}"
    );
}

#[tokio::test]
async fn ready_tasks_order_by_priority_and_next_returns_the_first() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    for (title, status, priority) in [
        ("low", "todo", "low"),
        ("urgent", "todo", "urgent"),
        ("high", "todo", "high"),
        ("none", "todo", "none"),
        ("backlog", "backlog", "urgent"),
    ] {
        ok_call(
            r.addr,
            &token,
            "task_create",
            json!({ "title": title, "status": status, "priority": priority }),
        )
        .await;
    }

    let listed = ok_call(r.addr, &token, "task_list", json!({ "ready": true })).await;
    let mut keys: Vec<String> = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["key"].as_str().unwrap().to_string())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["HOU-1", "HOU-2", "HOU-3", "HOU-4"],
        "every todo task is ready, the backlog one is not: {listed}"
    );

    let next = ok_call(r.addr, &token, "task_next", json!({})).await;
    assert_eq!(next["task"]["key"], "HOU-2", "urgent first: {next}");

    // A blocker with an unfinished status removes a ready task; slice 2 has no
    // wire for blockers, so write the row straight into the fixture's database.
    let conn = rusqlite::Connection::open(r._state.path().join("test.db")).unwrap();
    conn.execute(
        "INSERT INTO backlog_task_blocks (task_id, blocked_by_id) VALUES (2, 3)",
        [],
    )
    .unwrap();
    drop(conn);
    let listed = ok_call(r.addr, &token, "task_list", json!({ "ready": true })).await;
    let mut keys: Vec<String> = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["key"].as_str().unwrap().to_string())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["HOU-1", "HOU-3", "HOU-4"],
        "the blocked task is not ready: {listed}"
    );
    let next = ok_call(r.addr, &token, "task_next", json!({})).await;
    assert_eq!(
        next["task"]["key"], "HOU-3",
        "the blocked urgent one is skipped: {next}"
    );
}

#[tokio::test]
async fn tasks_access_gates_advertisement_and_calls() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);

    let names = tool_names(r.addr, &token).await;
    for name in [
        "task_list",
        "task_get",
        "task_next",
        "task_create",
        "task_update",
        "task_comment",
        "task_check",
        "task_claim",
        "task_handback",
    ] {
        assert!(
            names.contains(&name.to_string()),
            "{name} at write access: {names:?}"
        );
    }

    r.daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Read)
        .unwrap();
    let names = tool_names(r.addr, &token).await;
    assert!(names.contains(&"task_list".to_string()), "{names:?}");
    assert!(names.contains(&"task_next".to_string()), "{names:?}");
    for write in [
        "task_create",
        "task_update",
        "task_comment",
        "task_check",
        "task_claim",
        "task_handback",
    ] {
        assert!(
            !names.contains(&write.to_string()),
            "{write} at read access: {names:?}"
        );
    }
    let text = refused(r.addr, &token, "task_create", json!({ "title": "no" })).await;
    assert!(text.contains("Settings ▸ Tasks"), "{text}");

    r.daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Off)
        .unwrap();
    let names = tool_names(r.addr, &token).await;
    assert!(
        names.iter().all(|name| !name.starts_with("task_")),
        "no task tool at off: {names:?}"
    );
    let text = refused(r.addr, &token, "task_list", json!({})).await;
    assert!(text.contains("Settings ▸ Tasks"), "{text}");
    assert!(text.contains("off"), "{text}");

    r.daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Write)
        .unwrap();
    let names = tool_names(r.addr, &token).await;
    assert!(names.contains(&"task_create".to_string()), "{names:?}");
}

#[tokio::test]
async fn a_task_access_change_pushes_tools_list_changed() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    assert!(tool_names(r.addr, &token)
        .await
        .contains(&"task_create".to_string()));

    let mut listening = open_listen_stream(r.addr, &token).await;
    r.daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Read)
        .unwrap();
    listen_until(&mut listening, "notifications/tools/list_changed").await;
}

#[tokio::test]
async fn hs_task_next_claim_and_handback_work_over_the_http_door() {
    let _guard = CLI_ENV.lock().await;
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    ok_call(
        r.addr,
        &token,
        "task_create",
        json!({ "title": "CLI work", "status": "todo" }),
    )
    .await;
    let id = r
        .daemon
        .task_id_for_key(&r.workspace(), "HOU-1")
        .unwrap()
        .unwrap();

    let base = format!("http://{}", r.addr);
    std::env::set_var("HOUSTON_MCP_URL", &base);
    std::env::set_var("HOUSTON_MCP_TOKEN", &token);
    std::env::remove_var("HOUSTON_TASK");

    // The CLI blocks on its own TCP socket, so it must not run on the test
    // runtime's single worker thread: the daemon's HTTP server is a task on it.
    let run = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        tokio::task::spawn_blocking(move || houston_core::tasks_cli::run_cli(&args))
    };
    assert_eq!(run(&["next"]).await.unwrap(), 0, "hs-task next");
    assert_eq!(run(&["claim", "HOU-1"]).await.unwrap(), 0, "hs-task claim");
    std::env::set_var("HOUSTON_TASK", "HOU-1");
    assert_eq!(
        run(&["handback", "--summary", "finished from the CLI"])
            .await
            .unwrap(),
        0,
        "hs-task handback with $HOUSTON_TASK"
    );
    std::env::remove_var("HOUSTON_MCP_URL");
    std::env::remove_var("HOUSTON_MCP_TOKEN");
    std::env::remove_var("HOUSTON_TASK");

    let (task, comments, _) = task_detail(r.daemon.task_get(id).unwrap());
    assert_eq!(task.status, proto::TaskStatus::InReview);
    assert!(
        comments
            .iter()
            .any(|comment| comment.body == "finished from the CLI"),
        "{comments:?}"
    );
}

#[tokio::test]
async fn a_task_key_that_does_not_exist_is_refused_naming_the_key() {
    let r = rig().await;
    let pane = r.pane();
    let token = r.token_for(pane);
    let (status, body) = request(r.addr, "GET", "/task/get?key=HOU-99", &token, None).await;
    assert_eq!(status, 409, "{body}");
    let message = body["error"].as_str().unwrap();
    assert!(message.contains("HOU-99"), "{message}");
    assert!(
        message.contains("expected an existing HOU-<number>"),
        "{message}"
    );
}

/// Global keys stay distinct while agent access follows the configured scope.
#[tokio::test]
async fn task_tools_read_globally_and_write_only_own_workspace() {
    let r = rig().await;
    let other_ws = {
        let dir = r.ws.parent().unwrap().join("project2");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    };
    r.daemon
        .workspace_add(&other_ws.display().to_string())
        .unwrap();
    let first = r.token_for(r.pane());
    for title in ["first one", "first two", "first three"] {
        ok_call(r.addr, &first, "task_create", json!({ "title": title })).await;
    }
    let pane = plain_pane(&r.daemon, &other_ws);
    let token = token(&r.daemon, pane, &other_ws);
    let one = ok_call(
        r.addr,
        &token,
        "task_create",
        json!({ "title": "second one" }),
    )
    .await;
    let two = ok_call(
        r.addr,
        &token,
        "task_create",
        json!({ "title": "second two" }),
    )
    .await;
    assert_eq!(
        (one["key"].as_str(), one["id"].as_i64()),
        (Some("HOU-4"), Some(4))
    );
    assert_eq!(
        (two["key"].as_str(), two["id"].as_i64()),
        (Some("HOU-5"), Some(5))
    );

    for reference in [json!("HOU-4"), json!("hou-4"), json!(4)] {
        let detail = ok_call(r.addr, &token, "task_get", json!({ "id": reference })).await;
        assert_eq!(
            detail["task"]["title"], "second one",
            "{reference}: {detail}"
        );
    }

    let updated = ok_call(
        r.addr,
        &token,
        "task_update",
        json!({ "id": "HOU-4", "expected_revision": one["revision"], "title": "renamed" }),
    )
    .await;
    assert_eq!(updated["id"], 4, "{updated}");

    let claimed = ok_call(r.addr, &token, "task_claim", json!({ "id": "HOU-5" })).await;
    assert_eq!(claimed["id"], 5, "{claimed}");
    let handed = ok_call(
        r.addr,
        &token,
        "task_handback",
        json!({ "id": "HOU-5", "summary": "done" }),
    )
    .await;
    assert_eq!(handed["status"], "in_review", "{handed}");
    let claimed = ok_call(r.addr, &token, "task_claim", json!({ "id": 4 })).await;
    assert_eq!(claimed["key"], "HOU-4", "{claimed}");

    ok_call(r.addr, &first, "task_claim", json!({ "id": "HOU-1" })).await;
    for reference in [json!(1), json!("HOU-1"), json!("HOU-3")] {
        let detail = ok_call(r.addr, &token, "task_get", json!({ "id": reference })).await;
        assert_eq!(detail["task"]["workspace"], r.workspace());
    }
    let (status, body) = request(r.addr, "GET", "/task/get?id=1", &token, None).await;
    assert_eq!(status, 200, "{body}");
    let listed = ok_call(r.addr, &token, "task_list", json!({})).await;
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 5);
    let detail = ok_call(r.addr, &token, "task_get", json!({ "id": "HOU-1" })).await;
    assert_eq!(detail["task"]["status"], "in_progress");
    r.daemon.orchestration_set(true).unwrap();
    for (name, args) in [
        (
            "task_update",
            json!({ "id": "HOU-1", "expected_revision": detail["task"]["revision"], "title": "forbidden" }),
        ),
        (
            "task_comment",
            json!({ "id": "HOU-1", "body": "forbidden" }),
        ),
        ("task_check", json!({ "id": "HOU-1", "item": 1 })),
        ("task_claim", json!({ "id": "HOU-1" })),
        (
            "task_handback",
            json!({ "id": "HOU-1", "summary": "forbidden" }),
        ),
        ("task_execute", json!({ "id": "HOU-1", "agent": "claude" })),
    ] {
        let text = refused(r.addr, &token, name, args).await;
        assert!(
            text.contains("HOU-1")
                && text.contains(&r.workspace())
                && text.contains("tasks of another workspace are read-only to agents"),
            "{name}: {text}"
        );
    }
    let (status, body) = post(
        r.addr,
        "/task/comment",
        &token,
        json!({ "id": 1, "body": "forbidden" }),
    )
    .await;
    assert_ne!(status, 200, "{body}");
    assert!(
        body.to_string()
            .contains("tasks of another workspace are read-only to agents"),
        "{body}"
    );
    r.daemon
        .tasks_access_set(&other_ws.display().to_string(), proto::TasksAccess::Off)
        .unwrap();
    let text = refused(r.addr, &token, "task_get", json!({ "id": "HOU-1" })).await;
    assert!(text.contains("off"), "{text}");
    r.daemon
        .tasks_access_set(&other_ws.display().to_string(), proto::TasksAccess::Write)
        .unwrap();
    let text = refused(r.addr, &token, "task_get", json!({ "id": "TSK-1" })).await;
    assert!(
        text.contains("\"TSK-1\"") && text.contains("HOU-"),
        "{text}"
    );
}

#[tokio::test]
async fn unassigned_tasks_are_visible_and_claim_assigns_the_callers_workspace() {
    let r = rig().await;
    let token = r.token_for(r.pane());
    let created = ok_call(
        r.addr,
        &token,
        "task_create",
        json!({ "title": "unassigned", "workspace": null }),
    )
    .await;
    let id = created["id"].as_i64().unwrap();
    let listed = ok_call(r.addr, &token, "task_list", json!({})).await;
    assert_eq!(listed["tasks"][0]["workspace"], Value::Null);
    ok_call(r.addr, &token, "task_claim", json!({ "id": id })).await;
    let (task, _, history) = task_detail(r.daemon.task_get(id).unwrap());
    assert_eq!(task.workspace.as_deref(), Some(r.workspace().as_str()));
    assert!(history
        .iter()
        .any(|entry| entry.action == "houston:claim-assign"));
}

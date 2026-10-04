#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

//! ZCode as a spawnable provider: its argv, the first prompt pasted once its TUI
//! is up, the refused model, hook-driven status and resume by session id.

mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::hook_drop::HookDrop;
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Records its argv and the MCP URL variable per pane, then draws a line and
/// echoes whatever is typed or pasted into it.
const FAKE_ZCODE: &str = r#"#!/bin/sh
out="$ZCODE_ARGV_DIR/$HOUSTON_SESSION"
: > "$out.tmp"
for a in "$@"; do printf '%s\n' "$a" >> "$out.tmp"; done
env | grep -e '^ZCODE_HOUSTON_MCP_URL' -e '^ZCODE_DISABLE_UPDATE_CHECK' | sed 's/^/env:/' >> "$out.tmp"
mv "$out.tmp" "$out"
echo FAKE-ZCODE-READY
stty -echo 2>/dev/null
exec cat
"#;

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let path = dir.join("zcode");
        std::fs::write(&path, FAKE_ZCODE).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        dir
    })
    .clone()
}

struct Env {
    _serial: tokio::sync::MutexGuard<'static, ()>,
    argv: tempfile::TempDir,
    state: tempfile::TempDir,
}

async fn setup() -> Env {
    let serial = SERIAL.lock().await;
    shim_dir();
    let argv = tempfile::tempdir().unwrap();
    std::env::set_var("ZCODE_ARGV_DIR", argv.path());
    for var in [
        "HOUSTON_RESTORE_BUDGET",
        "HOUSTON_SAFE_MODE",
        "HOUSTON_DISABLE_AUTO_RESTORE",
    ] {
        std::env::remove_var(var);
    }
    Env {
        _serial: serial,
        argv,
        state: tempfile::tempdir().unwrap(),
    }
}

fn boot(env: &Env) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: env.state.path().join("test.db"),
    })
    .unwrap()
}

async fn serve(daemon: &Arc<Daemon>) -> SocketAddr {
    let (addr, _handle) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());
    addr
}

async fn argv_of(env: &Env, id: u32) -> Vec<String> {
    let path = env.argv.path().join(id.to_string());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(s) = std::fs::read_to_string(&path) {
            return s.lines().map(String::from).collect();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "session {id} never launched zcode"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn flag(argv: &[String], name: &str) -> Option<String> {
    argv.iter()
        .position(|a| a == name)
        .and_then(|i| argv.get(i + 1).cloned())
}

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/zcode")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

/// Runs the real hook helper on a ZCode payload, as ZCode's command hook would.
async fn run_hook(event: &str, session: u32, stdin: String) -> HookDrop {
    let home = tempfile::tempdir().unwrap();
    let event = event.to_string();
    let home_path = home.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut cmd = houston_core::spawn::command(env!("CARGO_BIN_EXE_houston-core"));
        cmd.args(["hook", &event, "--agent", "zcode", "--houston-managed"]);
        cmd.env_clear();
        cmd.env("HOME", &home_path);
        cmd.env("HOUSTON_CHANNEL", "zcodetest");
        cmd.env("TR_SESSION", session.to_string());
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawning the hook helper");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "hook {event}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let dir = houston_core::hook_drop::drop_dir(&home_path.join(".houston-zcodetest"));
        let names: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| houston_core::hook_drop::parse_drop_name(n).is_some())
            })
            .collect();
        assert_eq!(names.len(), 1, "one drop per hook: {names:?}");
        serde_json::from_slice(&std::fs::read(&names[0]).unwrap()).expect("the drop parses")
    })
    .await
    .expect("the helper run must not panic")
}

/// Feeds one fixture for `session`, speaking from the pane's own directory.
async fn drive(state: &Path, daemon: &Arc<Daemon>, event: &str, session: u32, name: &str) {
    let cwd = daemon
        .list()
        .into_iter()
        .find(|s| s.id == session)
        .map(|s| s.cwd)
        .expect("the pane is listed");
    let mut payload: serde_json::Value = serde_json::from_str(&fixture(name)).unwrap();
    payload["cwd"] = cwd.into();
    let drop = run_hook(event, session, payload.to_string()).await;
    let path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(state),
        &drop,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{event} drop never applied"
        );
        daemon.hook_drop_tick_for_test();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn zcode_pane(daemon: &Arc<Daemon>, dir: &Path, prompt: Option<&str>) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Zcode,
            project_dir: dir.to_path_buf(),
            cmd: None,
            cols: 100,
            rows: 30,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: prompt.map(String::from),
        })
        .expect("a ZCode pane spawns")
}

fn status(daemon: &Daemon, id: u32) -> Option<proto::AgentStatus> {
    daemon.session_status(id).unwrap()
}

async fn screen_shows(daemon: &Daemon, id: u32, needle: &str) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let screen = daemon.session_screen_for_test(id);
        if screen.iter().any(|l| l.contains(needle)) {
            return screen;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pane {id} never showed {needle:?}: {screen:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn http_json(
    addr: SocketAddr,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let (path, token) = (path.to_string(), token.to_string());
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let payload = body.to_string();
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
             Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n",
            payload.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(payload.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("http status line");
        let value = serde_json::from_str(resp.trim_start()).unwrap_or(serde_json::Value::Null);
        (status, value)
    })
    .await
    .unwrap()
}

/// A parent pane with orchestration on, and the bearer token it would call with.
fn parent(daemon: &Arc<Daemon>, dir: &Path) -> (proto::SessionInfo, String) {
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(vec!["sleep".into(), "60".into()]),
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
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: info.id,
        workspace_id: info.project_dir.clone(),
    });
    (info, token)
}

#[tokio::test]
async fn a_spawned_zcode_child_gets_its_mode_its_mcp_url_and_its_brief_pasted() {
    let env = setup().await;
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    let dir = tempfile::tempdir().unwrap();
    let (_parent, token) = parent(&daemon, dir.path());

    let (code, body) = http_json(
        addr,
        "/orchestrate/spawn",
        &token,
        serde_json::json!({"kind": "zcode", "prompt": "ZCODE-BRIEF-MARKER count the files"}),
    )
    .await;
    assert_eq!(code, 200, "spawn body: {body}");
    let child = body["session_id"].as_u64().unwrap() as u32;

    let argv = argv_of(&env, child).await;
    assert_eq!(flag(&argv, "--mode").as_deref(), Some("edit"), "{argv:?}");
    assert!(
        !argv.iter().any(|a| a.contains("ZCODE-BRIEF-MARKER")),
        "ZCode reads a positional as a subcommand; the brief must not ride argv: {argv:?}"
    );
    assert!(
        argv.iter().any(|a| a == "env:ZCODE_DISABLE_UPDATE_CHECK=1"),
        "ZCode's own update check is off in a pane: {argv:?}"
    );
    let url = argv
        .iter()
        .filter_map(|a| a.strip_prefix("env:"))
        .find(|a| a.starts_with("ZCODE_HOUSTON_MCP_URL"))
        .unwrap_or_else(|| panic!("the pane carries the plugin's URL variable: {argv:?}"));
    assert!(
        url.starts_with("ZCODE_HOUSTON_MCP_URL") && url.ends_with("/mcp"),
        "{url}"
    );

    screen_shows(&daemon, child, "ZCODE-BRIEF-MARKER").await;
}

#[tokio::test]
async fn an_operator_zcode_pane_gets_its_prompt_pasted_and_bypass_as_yolo() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Zcode,
            project_dir: dir.path().to_path_buf(),
            cmd: None,
            cols: 100,
            rows: 30,
            cwd_from: None,
            shell_integration: false,
            auto_approve: true,
            acp: None,
            profile: None,
            prompt: Some("OPERATOR-PROMPT-MARKER".into()),
        })
        .unwrap();
    let argv = argv_of(&env, info.id).await;
    assert_eq!(flag(&argv, "--mode").as_deref(), Some("yolo"), "{argv:?}");
    assert!(!argv.iter().any(|a| a.contains("OPERATOR-PROMPT-MARKER")));
    screen_shows(&daemon, info.id, "OPERATOR-PROMPT-MARKER").await;
}

#[tokio::test]
async fn a_zcode_model_is_refused_naming_why() {
    let env = setup().await;
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    let dir = tempfile::tempdir().unwrap();
    let (parent, token) = parent(&daemon, dir.path());
    let (code, body) = http_json(
        addr,
        "/orchestrate/spawn",
        &token,
        serde_json::json!({"kind": "zcode", "prompt": "x", "model": "glm-5.3"}),
    )
    .await;
    assert_ne!(
        code, 200,
        "a model ZCode cannot take must not spawn: {body}"
    );
    let text = body.to_string();
    assert!(
        text.contains("glm-5.3") && text.contains("/model"),
        "the refusal names the model and where to choose it: {text}"
    );
    assert!(
        daemon
            .list()
            .iter()
            .all(|s| s.spawned_by != Some(parent.id)),
        "nothing was spawned"
    );
}

#[tokio::test]
async fn zcode_hooks_drive_status_through_a_turn_its_questions_and_permissions() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let info = zcode_pane(&daemon, dir.path(), None);
    let id = info.id;
    let state = env.state.path();
    use proto::AgentStatus::*;

    drive(
        state,
        &daemon,
        "SessionStart",
        id,
        "zcode-src-01-SessionStart.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Idle));
    drive(
        state,
        &daemon,
        "UserPromptSubmit",
        id,
        "zcode-src-02-UserPromptSubmit.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Working));

    drive(
        state,
        &daemon,
        "PreToolUse",
        id,
        "zcode-src-04-PreToolUse-AskUserQuestion.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(NeedsInput),
        "AskUserQuestion asks the operator"
    );
    drive(
        state,
        &daemon,
        "PostToolUse",
        id,
        "zcode-src-05-PostToolUse-AskUserQuestion.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(Working),
        "the answer resumes the turn"
    );

    drive(
        state,
        &daemon,
        "PermissionRequest",
        id,
        "zcode-src-06-PermissionRequest-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(NeedsInput));
    drive(
        state,
        &daemon,
        "PostToolUse",
        id,
        "zcode-src-07-PostToolUse-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Working), "the approved tool ran");

    drive(state, &daemon, "Stop", id, "zcode-src-03-Stop.json").await;
    assert_eq!(status(&daemon, id), Some(Idle));
    assert_eq!(
        daemon.agent_kind_of(id),
        Some(proto::AgentKind::Zcode),
        "hooks identify the pane"
    );
}

#[tokio::test]
async fn an_interrupted_zcode_tool_ends_the_turn() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let id = zcode_pane(&daemon, dir.path(), None).id;
    let state = env.state.path();
    drive(
        state,
        &daemon,
        "UserPromptSubmit",
        id,
        "zcode-src-02-UserPromptSubmit.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "PermissionRequest",
        id,
        "zcode-src-06-PermissionRequest-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(proto::AgentStatus::NeedsInput));
    drive(
        state,
        &daemon,
        "PostToolUseFailure",
        id,
        "zcode-src-08-PostToolUseFailure-interrupt.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(proto::AgentStatus::Idle),
        "ZCode runs no Stop after an interrupt; the aborted tool ends the turn"
    );
}

#[tokio::test]
async fn a_restored_zcode_pane_resumes_its_session_by_id() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let info = zcode_pane(&daemon, dir.path(), None);
    let first = argv_of(&env, info.id).await;
    assert_eq!(flag(&first, "--resume"), None, "{first:?}");
    let state = env.state.path();
    drive(
        state,
        &daemon,
        "SessionStart",
        info.id,
        "zcode-src-01-SessionStart.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "UserPromptSubmit",
        info.id,
        "zcode-src-02-UserPromptSubmit.json",
    )
    .await;
    drive(state, &daemon, "Stop", info.id, "zcode-src-03-Stop.json").await;

    daemon.checkpoint_scrollback().unwrap();
    daemon.mark_clean_shutdown().unwrap();
    let after = boot(&env);
    let restored = after
        .list()
        .into_iter()
        .filter(|s| s.session_origin == Some(info.id))
        .max_by_key(|s| s.id)
        .unwrap_or_else(|| panic!("session {} was not restored", info.id));
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(
        flag(&argv, "--resume").as_deref(),
        Some("sess_01J9ZCDEMO0000000000000000"),
        "{argv:?}"
    );
    drive(
        state,
        &after,
        "SessionStart",
        restored.id,
        "zcode-src-09-SessionStart-resume.json",
    )
    .await;
    assert_eq!(
        status(&after, restored.id),
        Some(proto::AgentStatus::Idle),
        "the resumed session's own SessionStart settles it"
    );
}

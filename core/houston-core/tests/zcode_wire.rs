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
    apply(state, daemon, &drop).await;
}

/// Hands one hook drop to the daemon and waits until it is applied.
async fn apply(state: &Path, daemon: &Arc<Daemon>, drop: &HookDrop) {
    let event = &drop.event;
    let path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(state),
        drop,
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
            model: None,
            effort: None,
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
            model: None,
            effort: None,
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
            model: None,
            effort: None,
        })
        .unwrap();
    let argv = argv_of(&env, info.id).await;
    assert_eq!(flag(&argv, "--mode").as_deref(), Some("yolo"), "{argv:?}");
    assert!(!argv.iter().any(|a| a.contains("OPERATOR-PROMPT-MARKER")));
    screen_shows(&daemon, info.id, "OPERATOR-PROMPT-MARKER").await;
}

/// ZCode status hooks installed for this daemon in a scratch `HOME`: only hooks ZCode
/// runs can confirm a paste. `HOME` comes back when the guard drops.
struct HooksOn {
    _home: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}

impl Drop for HooksOn {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
    }
}

fn zcode_hooks_on(daemon: &Arc<Daemon>) -> HooksOn {
    let home = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", home.path());
    let guard = HooksOn {
        _home: home,
        previous,
    };
    let rows = daemon.agent_hooks_set(proto::AgentKind::Zcode, true);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(row.installed && row.error.is_none(), "{row:?}");
    guard
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn a_pasted_first_prompt_stays_pending_until_its_own_prompt_hook_confirms_it() {
    let env = setup().await;
    let daemon = boot(&env);
    let _hooks = zcode_hooks_on(&daemon);
    let dir = tempfile::tempdir().unwrap();
    let marker = "CONFIRM-MARKER fix the parser";
    let id = zcode_pane(&daemon, dir.path(), Some(marker)).id;
    screen_shows(&daemon, id, "CONFIRM-MARKER").await;
    assert_eq!(
        daemon.first_prompt_pending_for_test(id),
        Some(true),
        "a paste alone is not a delivery"
    );

    let cwd = daemon.list().into_iter().find(|s| s.id == id).unwrap().cwd;
    let mut other: serde_json::Value =
        serde_json::from_str(&fixture("zcode-3.14.3-src-02-UserPromptSubmit.json")).unwrap();
    other["cwd"] = cwd.clone().into();
    let drop = run_hook("UserPromptSubmit", id, other.to_string()).await;
    apply(env.state.path(), &daemon, &drop).await;
    assert_eq!(
        daemon.first_prompt_pending_for_test(id),
        Some(true),
        "another prompt does not confirm this one"
    );

    let mut own = other;
    own["prompt"] = marker.into();
    let drop = run_hook("UserPromptSubmit", id, own.to_string()).await;
    apply(env.state.path(), &daemon, &drop).await;
    wait_for("the delivery to settle", || {
        daemon.first_prompt_pending_for_test(id).is_none()
    })
    .await;
    let screen = daemon.session_screen_for_test(id).join("\n");
    assert_eq!(screen.matches("CONFIRM-MARKER").count(), 1, "{screen}");
}

#[tokio::test]
async fn an_unconfirmed_first_prompt_gets_one_more_enter_never_a_second_paste() {
    let env = setup().await;
    let daemon = boot(&env);
    let _hooks = zcode_hooks_on(&daemon);
    daemon.set_first_prompt_confirm_for_test(Duration::from_millis(300));
    let addr = serve(&daemon).await;
    let dir = tempfile::tempdir().unwrap();
    let (parent, token) = parent(&daemon, dir.path());
    let (code, body) = http_json(
        addr,
        "/orchestrate/spawn",
        &token,
        serde_json::json!({"kind": "zcode", "prompt": "UNCONFIRMED-MARKER secret mission"}),
    )
    .await;
    assert_eq!(code, 200, "spawn body: {body}");
    let child = body["session_id"].as_u64().unwrap() as u32;

    wait_for("the sender to hear the prompt is unconfirmed", || {
        daemon
            .inbox_rows_for_test(parent.id)
            .iter()
            .any(|row| row.summary.contains("prompt_failed"))
    })
    .await;
    let note = daemon
        .inbox_rows_for_test(parent.id)
        .into_iter()
        .find(|row| row.summary.contains("prompt_failed"))
        .unwrap();
    let text = format!("{note:?}");
    assert!(
        text.contains("not pasted again") && !text.contains("secret mission"),
        "the note explains without carrying the prompt: {text}"
    );
    let screen = daemon.session_screen_for_test(child).join("\n");
    assert_eq!(
        screen.matches("UNCONFIRMED-MARKER").count(),
        1,
        "pasted once: {screen}"
    );
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
        "zcode-3.14.3-src-01-SessionStart.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Idle));
    drive(
        state,
        &daemon,
        "UserPromptSubmit",
        id,
        "zcode-3.14.3-src-02-UserPromptSubmit.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Working));

    drive(
        state,
        &daemon,
        "PreToolUse",
        id,
        "zcode-3.14.3-src-04-PreToolUse-AskUserQuestion.json",
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
        "zcode-3.14.3-src-05-PostToolUse-AskUserQuestion.json",
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
        "zcode-3.14.3-src-06-PermissionRequest-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(NeedsInput));
    drive(
        state,
        &daemon,
        "PostToolUse",
        id,
        "zcode-3.14.3-src-07-PostToolUse-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(Working), "the approved tool ran");

    drive(state, &daemon, "Stop", id, "zcode-3.14.3-src-03-Stop.json").await;
    assert_eq!(status(&daemon, id), Some(Idle));
    assert_eq!(
        daemon.agent_kind_of(id),
        Some(proto::AgentKind::Zcode),
        "hooks identify the pane"
    );
}

/// What is proven is the parsing: if ZCode delivers an `is_interrupt` failure, it
/// closes the request of the tool it names. ZCode cancels its hook runner with an
/// interrupted turn, so a real Esc usually reports nothing at all.
#[tokio::test]
async fn an_is_interrupt_failure_that_arrives_closes_only_its_own_request() {
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
        "zcode-3.14.3-src-02-UserPromptSubmit.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "PermissionRequest",
        id,
        "zcode-3.14.3-src-06-PermissionRequest-Bash.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(proto::AgentStatus::NeedsInput));
    drive(
        state,
        &daemon,
        "PostToolUseFailure",
        id,
        "zcode-3.14.3-src-08-PostToolUseFailure-interrupt.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(proto::AgentStatus::Working),
        "a cancelled tool ends its own request, not the turn; Stop ends the turn"
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
        "zcode-3.14.3-src-01-SessionStart.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "UserPromptSubmit",
        info.id,
        "zcode-3.14.3-src-02-UserPromptSubmit.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "Stop",
        info.id,
        "zcode-3.14.3-src-03-Stop.json",
    )
    .await;

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
        "zcode-3.14.3-src-09-SessionStart-resume.json",
    )
    .await;
    assert_eq!(
        status(&after, restored.id),
        Some(proto::AgentStatus::Idle),
        "the resumed session's own SessionStart settles it"
    );
}

#[tokio::test]
async fn an_unprompted_zcode_pane_stays_starting_past_the_spawn_grace() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let id = zcode_pane(&daemon, dir.path(), None).id;
    assert_eq!(status(&daemon, id), Some(proto::AgentStatus::Spawning));
    daemon.expire_spawn_grace_for_test(id);
    assert_eq!(
        status(&daemon, id),
        Some(proto::AgentStatus::Spawning),
        "ZCode reports its start only with its first turn; silence is not broken hooks"
    );
    drive(
        env.state.path(),
        &daemon,
        "SessionStart",
        id,
        "zcode-3.14.3-src-01-SessionStart.json",
    )
    .await;
    assert_eq!(status(&daemon, id), Some(proto::AgentStatus::Idle));
}

/// Tools run in parallel: a `Read` finishing must not close a question or a permission
/// still open. Each closes on the result with its own `tool_use_id`; a permission the
/// operator denied fires no hook and stays open until the turn ends.
#[tokio::test]
async fn a_parallel_tool_result_leaves_open_questions_and_permissions_pending() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = tempfile::tempdir().unwrap();
    let id = zcode_pane(&daemon, dir.path(), None).id;
    let state = env.state.path();
    use proto::AgentStatus::*;
    for (event, name) in [
        (
            "UserPromptSubmit",
            "zcode-3.14.3-src-02-UserPromptSubmit.json",
        ),
        (
            "PreToolUse",
            "zcode-3.14.3-src-04-PreToolUse-AskUserQuestion.json",
        ),
        ("PostToolUse", "zcode-3.14.3-src-10-PostToolUse-Read.json"),
    ] {
        drive(state, &daemon, event, id, name).await;
    }
    assert_eq!(
        status(&daemon, id),
        Some(NeedsInput),
        "the question is still open after an unrelated Read"
    );
    drive(
        state,
        &daemon,
        "PostToolUse",
        id,
        "zcode-3.14.3-src-05-PostToolUse-AskUserQuestion.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(Working),
        "its own answer closes it"
    );

    drive(
        state,
        &daemon,
        "PermissionRequest",
        id,
        "zcode-3.14.3-src-06-PermissionRequest-Bash.json",
    )
    .await;
    drive(
        state,
        &daemon,
        "PostToolUse",
        id,
        "zcode-3.14.3-src-10-PostToolUse-Read.json",
    )
    .await;
    assert_eq!(
        status(&daemon, id),
        Some(NeedsInput),
        "the permission is still open after an unrelated Read"
    );
    drive(state, &daemon, "Stop", id, "zcode-3.14.3-src-03-Stop.json").await;
    assert_eq!(
        status(&daemon, id),
        Some(Idle),
        "a denied permission fires no hook; the turn's end closes it"
    );
}

/// The Agent setup toggle on a `dev` channel daemon: the plugin is written and listed,
/// both carry the channel's name, the pane gets that channel's URL, and off removes all.
#[tokio::test]
async fn the_zcode_toggle_writes_and_removes_the_channels_plugin() {
    let env = setup().await;
    let home = tempfile::tempdir().unwrap();
    let state_dir = env.state.path().join(".houston-dev");
    std::fs::create_dir_all(&state_dir).unwrap();
    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", home.path());
    std::env::set_var("ZCODE_HOUSTON_MCP_URL", "http://127.0.0.1:1/mcp");
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap();
    let _addr = serve(&daemon).await;

    let rows = daemon.agent_hooks_set(proto::AgentKind::Zcode, true);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(row.installed && row.error.is_none(), "{row:?}");
    let plugin = state_dir.join("zcode-plugin");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(plugin.join(".zcode-plugin/plugin.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["name"], "houston-dev");
    let servers: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        servers["mcpServers"]["houston"]["url"],
        "${ZCODE_HOUSTON_MCP_URL_DEV}"
    );
    let config_path = home.path().join(".zcode/cli/config.json");
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(
        config["plugins"]["dirs"],
        serde_json::json!([plugin.display().to_string()])
    );
    assert_eq!(config["hooks"]["enabled"], true);

    let dir = tempfile::tempdir().unwrap();
    let pane = zcode_pane(&daemon, dir.path(), None);
    let argv = argv_of(&env, pane.id).await;
    let urls: Vec<&str> = argv
        .iter()
        .filter_map(|a| a.strip_prefix("env:ZCODE_HOUSTON_MCP_URL"))
        .collect();
    assert_eq!(
        urls.len(),
        1,
        "only this channel's URL reaches the pane: {argv:?}"
    );
    assert!(urls[0].starts_with("_DEV=http://127.0.0.1:"), "{argv:?}");

    let rows = daemon.agent_hooks_set(proto::AgentKind::Zcode, false);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(!row.installed && row.error.is_none(), "{row:?}");
    assert!(!plugin.exists(), "the plugin goes with the toggle");
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(
        config,
        serde_json::json!({}),
        "nothing of Houston's is left"
    );

    std::env::remove_var("ZCODE_HOUSTON_MCP_URL");
    match previous_home {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
}

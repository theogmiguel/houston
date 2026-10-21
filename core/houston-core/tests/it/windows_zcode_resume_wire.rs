#![cfg(windows)]
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

//! A ZCode pane records the session id its hook payloads carry and, after a daemon
//! restart, relaunches `zcode --resume <sessionId>` instead of reporting
//! "no resume handle" for its conversation.

use crate::common;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::hook_drop::HookDrop;
use houston_protocol as proto;
use serde_json::Value;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Records argv per pane, then waits like a TUI; the ConPTY close ends it.
const FAKE_ZCODE: &str = r#"@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0zcode-fixture.ps1" %*
"#;

const FIXTURE_PS1: &str = r#"$ErrorActionPreference='Stop'
if(-not $env:HOUSTON_SESSION -or $args -contains '--version'){exit 0}
@{cwd=(Get-Location).Path;session=[int]$env:HOUSTON_SESSION;argv=@($args)} | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $env:HOUSTON_LAUNCH_FIXTURE ('receipt-'+$env:HOUSTON_SESSION+'.txt'))
Write-Output 'FIXTURE-READY'
while($true){$line=[Console]::In.ReadLine();if($null -eq $line){Start-Sleep -Milliseconds 50}else{Write-Output $line}}
"#;

struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl Drop for Environment {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

fn zcode_fixture(root: &Path) -> PathBuf {
    std::fs::write(root.join("zcode-fixture.ps1"), FIXTURE_PS1).unwrap();
    for name in ["zcode", "claude"] {
        std::fs::write(
            root.join(format!("{name}.cmd")),
            FAKE_ZCODE.replace('\n', "\r\n"),
        )
        .unwrap();
    }
    root.join("zcode.cmd")
}

struct Rig {
    daemon: Arc<Daemon>,
    state: PathBuf,
    _state: tempfile::TempDir,
    _shim: tempfile::TempDir,
    _home: tempfile::TempDir,
    receipts: tempfile::TempDir,
    project: PathBuf,
    _environment: Environment,
}

impl Rig {
    fn new(name: &str) -> Self {
        let state = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let receipts = tempfile::tempdir().unwrap();
        let shim = tempfile::tempdir().unwrap();
        zcode_fixture(shim.path());
        let saved: Vec<(&'static str, Option<std::ffi::OsString>)> =
            ["PATH", "HOME", "USERPROFILE", "HOUSTON_LAUNCH_FIXTURE"]
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect();
        let environment = Environment(saved);
        let inherited = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{};{inherited}", shim.path().display()));
        std::env::set_var("HOME", home.path());
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOUSTON_LAUNCH_FIXTURE", receipts.path());
        let project = state.path().join(name);
        std::fs::create_dir_all(&project).unwrap();
        let daemon = Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            state.path().join("test.db"),
            common::base_env(),
        ))
        .unwrap();
        daemon.workspace_add(project.to_str().unwrap()).unwrap();
        Rig {
            daemon,
            state: state.path().to_path_buf(),
            _state: state,
            _shim: shim,
            _home: home,
            receipts,
            project,
            _environment: environment,
        }
    }

    fn spawn_zcode(&self) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Zcode,
                project_dir: self.project.clone(),
                cmd: None,
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

    fn spawn_claude(&self) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Claude,
                project_dir: self.project.clone(),
                cmd: None,
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
}

fn parse_receipt(text: &str, path: &Path) -> Vec<String> {
    let recorded: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .unwrap_or_else(|e| panic!("receipt {path:?}: {e}: {text}"));
    recorded["argv"]
        .as_array()
        .expect("the fixture records argv")
        .iter()
        .map(|a| a.as_str().expect("an argv entry is a string").to_string())
        .collect()
}

async fn argv_of(rig: &Rig, id: u32) -> Vec<String> {
    let path = rig.receipts.path().join(format!("receipt-{id}.txt"));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return parse_receipt(&text, &path);
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "session {id} never launched its CLI; scrollback: {:?}",
            rig.daemon
                .scrollback(id, None)
                .map(|replay| String::from_utf8_lossy(&replay.data).into_owned())
                .unwrap_or_else(|e| format!("unavailable: {e}"))
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Runs the installed hook entry's command on a recorded payload, as the CLI runs
/// it: the real helper, the payload on stdin, the pane id in TR_SESSION.
async fn run_hook_entry(event: &str, agent: &str, session: u32, payload: String) -> HookDrop {
    let home = tempfile::tempdir().unwrap();
    let home_path = home.path().to_path_buf();
    let event = event.to_string();
    let agent = agent.to_string();
    tokio::task::spawn_blocking(move || {
        let mut cmd = houston_core::spawn::command(env!("CARGO_BIN_EXE_tr-helper"));
        cmd.arg("hook")
            .arg(&event)
            .arg("--houston-managed")
            .arg("--agent")
            .arg(&agent);
        cmd.env_clear();
        for name in ["PATH", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                cmd.env(name, value);
            }
        }
        cmd.env("HOME", &home_path);
        cmd.env("USERPROFILE", &home_path);
        cmd.env("HOUSTON_CHANNEL", "zcoderesume");
        cmd.env("TR_SESSION", session.to_string());
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawning the hook helper");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "hook {event}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let dir = houston_core::hook_drop::drop_dir(&home_path.join(".houston-zcoderesume"));
        let name = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .find(|n| houston_core::hook_drop::parse_drop_name(n).is_some())
            .expect("the helper writes a drop");
        serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap()
    })
    .await
    .unwrap()
}

async fn apply_drop(state: &Path, daemon: &Arc<Daemon>, drop: HookDrop) {
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
            "drop for session {} never applied",
            drop.session
        );
        daemon.hook_drop_tick_for_test();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The recorded 3.14.3 UserPromptSubmit payload, speaking from the pane's folder.
fn zcode_payload(project: &Path) -> String {
    let raw = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/hooks/zcode/zcode-3.14.3-src-02-UserPromptSubmit.json"),
    )
    .unwrap();
    let mut payload: Value = serde_json::from_str(&raw).unwrap();
    payload["cwd"] = project.display().to_string().into();
    payload["transcript_path"] = project
        .join("transcript.jsonl")
        .display()
        .to_string()
        .into();
    payload.to_string()
}

fn handle_of(state_dir: &Path, id: u32) -> Option<(String, Option<String>)> {
    Db::open(&state_dir.join("test.db"))
        .unwrap()
        .session_resume_handle(id)
        .unwrap()
}

#[tokio::test]
async fn zcode_pane_restores_its_recorded_conversation_with_resume() {
    let rig = Rig::new("zcode-resume-project");
    let pane = rig.spawn_zcode();
    let argv = argv_of(&rig, pane.id).await;
    assert!(
        !argv.iter().any(|a| a == "--resume"),
        "a fresh ZCode pane launches without a resume flag: {argv:?}"
    );

    let drop = run_hook_entry(
        "UserPromptSubmit",
        "zcode",
        pane.id,
        zcode_payload(&rig.project),
    )
    .await;
    assert_eq!(
        drop.session_id.as_deref(),
        Some("sess_01J9ZCDEMO0000000000000000"),
        "the helper forwards ZCode's session id: {drop:?}"
    );
    apply_drop(&rig.state, &rig.daemon, drop).await;
    let state_dir = rig.state.clone();
    let bound = handle_of(&state_dir, pane.id);
    assert_eq!(
        bound
            .as_ref()
            .map(|(conversation, _)| conversation.as_str()),
        Some("sess_01J9ZCDEMO0000000000000000"),
        "the pane binds the conversation its hook reported"
    );
    assert!(
        Db::open(&state_dir.join("test.db"))
            .unwrap()
            .session_has_bound_resume_handle(pane.id)
            .unwrap(),
        "the handle is bound to this provider and folder"
    );

    rig.daemon.manage_shutdown().unwrap();
    let restored_daemon = Arc::new(
        Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            state_dir.join("test.db"),
            common::base_env(),
        ))
        .unwrap(),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let argv: Vec<String> = loop {
        let Some(restored) = restored_daemon
            .list()
            .into_iter()
            .find(|info| info.id != pane.id && info.agent == proto::AgentKind::Zcode)
        else {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the ZCode pane was never restored"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let path = rig
            .receipts
            .path()
            .join(format!("receipt-{}.txt", restored.id));
        let Ok(text) = std::fs::read_to_string(&path) else {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the restored ZCode pane never launched"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        break parse_receipt(&text, &path);
    };
    let resume = argv
        .iter()
        .position(|a| a == "--resume")
        .and_then(|i| argv.get(i + 1).cloned());
    assert_eq!(
        resume.as_deref(),
        Some("sess_01J9ZCDEMO0000000000000000"),
        "the restored ZCode pane must reopen its own conversation: {argv:?}"
    );
    let _ = restored_daemon.manage_shutdown();
}

/// A recorded provider payload speaking for `session` from `project`.
fn claude_payload(
    event_fixture: &str,
    project: &Path,
    conversation: &str,
    transcript: &Path,
) -> String {
    let raw = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/hooks/claude")
            .join(event_fixture),
    )
    .unwrap();
    let mut payload: Value = serde_json::from_str(&raw).unwrap();
    payload["cwd"] = project.display().to_string().into();
    payload["session_id"] = conversation.into();
    payload["transcript_path"] = transcript.display().to_string().into();
    payload.to_string()
}

fn transcript_file(dir: &Path, conversation: &str) -> PathBuf {
    let path = dir.join(format!("{conversation}.jsonl"));
    std::fs::write(&path, b"{}\n").unwrap();
    path
}

async fn wait_for(
    daemon: &Daemon,
    pick: impl Fn(&proto::SessionInfo) -> bool,
    what: &str,
) -> proto::SessionInfo {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(info) = daemon.list().into_iter().find(|info| pick(info)) {
            return info.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what} never appeared"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn deadline_secs(seconds: u64) -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_secs(seconds)
}

async fn wait_receipt(rig: &Rig, id: u32, what: &str) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let path = rig.receipts.path().join(format!("receipt-{id}.txt"));
        if let Ok(text) = std::fs::read_to_string(&path) {
            return parse_receipt(&text, &path);
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what} never launched"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn zcode_delegation_child_restores_with_its_own_conversation() {
    let rig = Rig::new("zcode-child-project");
    rig.daemon.orchestration_set(true).unwrap();
    let parent = rig.spawn_claude();
    let parent_argv = wait_receipt(&rig, parent.id, "the parent").await;
    let pick = |argv: &[String], name: &str| {
        argv.iter()
            .position(|a| a == name)
            .and_then(|i| argv.get(i + 1).cloned())
    };
    let parent_conversation = pick(&parent_argv, "--session-id")
        .expect("a fresh Claude pane launches with a pre-assigned id");
    let parent_transcript = transcript_file(&rig.project, &parent_conversation);
    for (event, fixture) in [
        ("SessionStart", "claude-2.1.263-01-SessionStart.json"),
        (
            "UserPromptSubmit",
            "claude-2.1.263-02-UserPromptSubmit.json",
        ),
    ] {
        let drop = run_hook_entry(
            event,
            "claude",
            parent.id,
            claude_payload(
                fixture,
                &rig.project,
                &parent_conversation,
                &parent_transcript,
            ),
        )
        .await;
        apply_drop(&rig.state, &rig.daemon, drop).await;
    }
    assert!(
        handle_of(&rig.state, parent.id).is_some(),
        "the parent binds its own conversation"
    );

    let child = rig
        .daemon
        .orchestrate_spawn(
            parent.id,
            proto::AgentKind::Zcode,
            None,
            None,
            houston_core::orchestrate::Brief::from("restore a ZCode delegation child".to_string()),
            Some(false),
            None,
            Some("zcode-child".to_string()),
        )
        .unwrap();
    let child_argv = wait_receipt(&rig, child.id, "the ZCode child").await;
    assert!(
        !child_argv.iter().any(|a| a == "--resume"),
        "a fresh ZCode child launches without a resume flag: {child_argv:?}"
    );
    let drop = run_hook_entry(
        "UserPromptSubmit",
        "zcode",
        child.id,
        zcode_payload(&rig.project),
    )
    .await;
    apply_drop(&rig.state, &rig.daemon, drop).await;
    assert_eq!(
        handle_of(&rig.state, child.id)
            .expect("the ZCode child binds the conversation its hook reported")
            .0,
        "sess_01J9ZCDEMO0000000000000000"
    );

    rig.daemon.manage_shutdown().unwrap();
    let restored_daemon = Arc::new(
        Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            rig.state.join("test.db"),
            common::base_env(),
        ))
        .unwrap(),
    );
    let restored_parent = wait_for(
        &restored_daemon,
        |info| info.agent == proto::AgentKind::Claude && info.id != parent.id,
        "the restored parent",
    )
    .await;
    let restored_child = wait_for(
        &restored_daemon,
        |info| info.agent == proto::AgentKind::Zcode,
        "the restored ZCode child",
    )
    .await;
    let child_argv = wait_receipt(&rig, restored_child.id, "the restored ZCode child").await;
    let resume = pick(&child_argv, "--resume");
    assert_eq!(
        resume.as_deref(),
        Some("sess_01J9ZCDEMO0000000000000000"),
        "the restored ZCode child must reopen its own conversation, not a fresh CLI: {child_argv:?}"
    );
    let notices: Vec<Value> = rusqlite::Connection::open(rig.state.join("test.db"))
        .unwrap()
        .query_row(
            "SELECT body FROM pane_inbox WHERE to_session = ?1 \
             AND summary = 'Children restored after daemon restart' \
             ORDER BY id DESC LIMIT 1",
            [restored_parent.id],
            |row| row.get::<_, String>(0),
        )
        .map(|body| serde_json::from_str(&body).unwrap())
        .unwrap_or_default();
    let zcode_notice = notices
        .iter()
        .find(|notice| notice["provider"] == "zcode")
        .expect("the restore row reports the ZCode child");
    assert_eq!(
        zcode_notice["resumed"], true,
        "the ZCode child must be reported resumed: {zcode_notice}"
    );
    let _ = restored_daemon.manage_shutdown();
}

/// A resumable child restored without a conversation says why: hooks that were
/// never installed differ from hooks that ran without reporting an id.
#[tokio::test]
async fn zcode_child_without_a_reported_conversation_names_why() {
    let rig = Rig::new("zcode-unbound-project");
    rig.daemon.orchestration_set(true).unwrap();
    let parent = rig.spawn_claude();
    let parent_argv = wait_receipt(&rig, parent.id, "the parent").await;
    let pick = |argv: &[String], name: &str| {
        argv.iter()
            .position(|a| a == name)
            .and_then(|i| argv.get(i + 1).cloned())
    };
    let parent_conversation = pick(&parent_argv, "--session-id")
        .expect("a fresh Claude pane launches with a pre-assigned id");
    let parent_transcript = transcript_file(&rig.project, &parent_conversation);
    for (event, fixture) in [
        ("SessionStart", "claude-2.1.263-01-SessionStart.json"),
        (
            "UserPromptSubmit",
            "claude-2.1.263-02-UserPromptSubmit.json",
        ),
    ] {
        let drop = run_hook_entry(
            event,
            "claude",
            parent.id,
            claude_payload(
                fixture,
                &rig.project,
                &parent_conversation,
                &parent_transcript,
            ),
        )
        .await;
        apply_drop(&rig.state, &rig.daemon, drop).await;
    }

    let silent_child = rig
        .daemon
        .orchestrate_spawn(
            parent.id,
            proto::AgentKind::Zcode,
            None,
            None,
            houston_core::orchestrate::Brief::from("a child whose hooks never ran".to_string()),
            Some(false),
            None,
            Some("zcode-silent".to_string()),
        )
        .unwrap();
    wait_receipt(&rig, silent_child.id, "the silent ZCode child").await;

    rig.daemon.manage_shutdown().unwrap();
    let second_daemon = Arc::new(
        Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            rig.state.join("test.db"),
            common::base_env(),
        ))
        .unwrap(),
    );
    let second_parent = wait_for(
        &second_daemon,
        |info| info.agent == proto::AgentKind::Claude && info.id != parent.id,
        "the restored parent",
    )
    .await;
    let reason = |daemon: &rusqlite::Connection, to: u32| {
        daemon
            .query_row(
                "SELECT body FROM pane_inbox WHERE to_session = ?1 \
                 AND summary = 'Children restored after daemon restart' \
                 ORDER BY id DESC LIMIT 1",
                [to],
                |row| row.get::<_, String>(0),
            )
            .map(|body| serde_json::from_str::<Vec<Value>>(&body).unwrap())
            .unwrap_or_default()
    };
    let conn = rusqlite::Connection::open(rig.state.join("test.db")).unwrap();
    let notices = loop {
        let found = reason(&conn, second_parent.id);
        if !found.is_empty() {
            break found;
        }
        assert!(
            tokio::time::Instant::now() < deadline_secs(30),
            "the first restore row never appeared"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let silent = notices
        .iter()
        .find(|notice| notice["child"] == silent_child.id)
        .unwrap_or_else(|| panic!("no notice for child {}: {notices:?}", silent_child.id));
    assert_eq!(silent["resumed"], false, "{silent}");
    assert!(
        silent["reason"]
            .as_str()
            .unwrap()
            .contains("zcode lifecycle hooks are not installed"),
        "{silent}"
    );

    let rows = second_daemon.agent_hooks_set(proto::AgentKind::Zcode, true);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(row.installed && row.error.is_none(), "{row:?}");
    houston_core::claude_hooks::point_launcher(
        &rig.state,
        Path::new(env!("CARGO_BIN_EXE_tr-helper")),
    )
    .unwrap();
    let unreported_child = second_daemon
        .orchestrate_spawn(
            second_parent.id,
            proto::AgentKind::Zcode,
            None,
            None,
            houston_core::orchestrate::Brief::from(
                "a child whose hooks never reported".to_string(),
            ),
            Some(false),
            None,
            Some("zcode-unreported".to_string()),
        )
        .unwrap();
    wait_receipt(&rig, unreported_child.id, "the unreported ZCode child").await;

    second_daemon.manage_shutdown().unwrap();
    let third_daemon = Arc::new(
        Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            rig.state.join("test.db"),
            common::base_env(),
        ))
        .unwrap(),
    );
    let third_parent = wait_for(
        &third_daemon,
        |info| info.agent == proto::AgentKind::Claude && info.id != second_parent.id,
        "the twice-restored parent",
    )
    .await;
    let notices = loop {
        let found = reason(&conn, third_parent.id);
        if !found.is_empty() {
            break found;
        }
        assert!(
            tokio::time::Instant::now() < deadline_secs(30),
            "the second restore row never appeared"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let unreported = notices
        .iter()
        .find(|notice| notice["child"] == unreported_child.id)
        .unwrap_or_else(|| panic!("no notice for child {}: {notices:?}", unreported_child.id));
    assert_eq!(unreported["resumed"], false, "{unreported}");
    assert!(
        unreported["reason"]
            .as_str()
            .unwrap()
            .contains("zcode reported no conversation id for this pane"),
        "{unreported}"
    );
    for info in third_daemon.list() {
        let _ = third_daemon.close(info.id);
    }
}

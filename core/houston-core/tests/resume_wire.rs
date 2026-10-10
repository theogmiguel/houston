#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

//! A restored or restarted Claude pane resumes the conversation it was running,
//! by exact id, and falls back to a fresh CLI with a reason when it cannot.

mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::hook_drop::HookDrop;
use houston_protocol as proto;
use serde_json::Value;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Records its argv (and the profile env) per pane, then waits like a CLI; with
/// `RESUME_FAKE_EXIT` set, a `--resume` launch exits with that code instead.
const FAKE_CLI: &str = r#"#!/bin/sh
if [ "$RESUME_IGNORE_TERM" = "1" ]; then trap '' TERM; fi
if [ "$RESUME_FAKE_DESCENDANT" = "1" ]; then sleep 60 & fi
if [ "$RESUME_BLOCK_STDIN" = "1" ]; then stty raw -echo; fi
out="$RESUME_ARGV_DIR/$HOUSTON_SESSION"
: > "$out.tmp"
for a in "$@"; do printf '%s\n' "$a" >> "$out.tmp"; done
printf 'env:CLAUDE_CONFIG_DIR=%s\n' "$CLAUDE_CONFIG_DIR" >> "$out.tmp"
printf 'env:CODEX_HOME=%s\n' "$CODEX_HOME" >> "$out.tmp"
mv "$out.tmp" "$out"
case " $* " in
  *" --resume "*) [ -n "$RESUME_FAKE_EXIT" ] && exit "$RESUME_FAKE_EXIT" ;;
esac
if [ "$RESUME_BLOCK_STDIN" = "1" ]; then
  while [ ! -f "$RESUME_STDIN_RELEASE" ]; do sleep 0.05; done
fi
exec cat
"#;

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["claude", "codex", "zcode"] {
            let path = dir.join(name);
            std::fs::write(&path, FAKE_CLI).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
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

impl Env {
    fn db_path(&self) -> PathBuf {
        self.state.path().join("test.db")
    }
}

async fn setup() -> Env {
    let serial = SERIAL.lock().await;
    shim_dir();
    let argv = tempfile::tempdir().unwrap();
    std::env::set_var("RESUME_ARGV_DIR", argv.path());
    std::env::set_var("SHELL", "/bin/sh");
    for var in [
        "RESUME_FAKE_EXIT",
        "RESUME_IGNORE_TERM",
        "RESUME_FAKE_DESCENDANT",
        "RESUME_BLOCK_STDIN",
        "RESUME_STDIN_RELEASE",
        "HOUSTON_RESTORE_BUDGET",
        "HOUSTON_SAFE_MODE",
        "HOUSTON_DISABLE_AUTO_RESTORE",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
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
        db_path: env.db_path(),
    })
    .unwrap()
}

async fn serve(daemon: &Arc<Daemon>) -> std::net::SocketAddr {
    let (addr, _handle) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());
    addr
}

/// The orderly-shutdown half of SIGTERM, then a new daemon on the same state dir.
fn reboot(env: &Env, before: &Daemon) -> Arc<Daemon> {
    before.checkpoint_scrollback().unwrap();
    before.mark_clean_shutdown().unwrap();
    boot(env)
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
            "session {id} never launched its CLI"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn flag(argv: &[String], name: &str) -> Option<String> {
    argv.iter()
        .position(|a| a == name)
        .and_then(|i| argv.get(i + 1).cloned())
}

fn resume_of(argv: &[String]) -> Option<String> {
    flag(argv, "--resume").or_else(|| flag(argv, "resume"))
}

fn config_dir_of(argv: &[String]) -> String {
    argv.iter()
        .find_map(|a| a.strip_prefix("env:CLAUDE_CONFIG_DIR="))
        .expect("the fake CLI records its config dir")
        .to_string()
}

fn codex_home_of(argv: &[String]) -> String {
    argv.iter()
        .find_map(|a| a.strip_prefix("env:CODEX_HOME="))
        .expect("the fake CLI records its Codex home")
        .to_string()
}

fn handle_in(env: &Env, id: u32) -> Option<(String, Option<String>)> {
    Db::open(&env.db_path())
        .unwrap()
        .session_resume_handle(id)
        .unwrap()
}

fn native_in(env: &Env, id: u32) -> Option<String> {
    Db::open(&env.db_path())
        .unwrap()
        .session_transcript_link(id)
        .unwrap()
        .1
}

fn project(env: &Env, name: &str) -> PathBuf {
    let dir = env.state.path().join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn transcript(env: &Env, conversation: &str, bytes: &[u8]) -> String {
    let dir = env.state.path().join("transcripts");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{conversation}.jsonl"));
    std::fs::write(&path, bytes).unwrap();
    path.display().to_string()
}

fn claude_pane(daemon: &Arc<Daemon>, dir: &Path, profile: Option<u32>) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: dir.to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: profile.map(|id| proto::ProfileChoice::Profile { id }),
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap()
}

fn shell_pane(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.to_path_buf(),
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

fn restored_from(sessions: &[proto::SessionInfo], old: u32) -> &proto::SessionInfo {
    sessions
        .iter()
        .filter(|s| s.session_origin == Some(old))
        .max_by_key(|s| s.id)
        .unwrap_or_else(|| panic!("session {old} was not restored: {sessions:?}"))
}

async fn wait_restored_child(daemon: &Arc<Daemon>, old: u32) -> proto::SessionInfo {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(child) = daemon
            .list()
            .into_iter()
            .find(|info| info.id != old && info.session_origin == Some(old) && info.state.is_live())
        {
            return child;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "child {old} did not restore"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn close_after_shell_restore(daemon: &Arc<Daemon>, parent: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match daemon.close(parent) {
            Ok(()) => return,
            Err(error) => {
                assert!(
                    error
                        .to_string()
                        .contains("restoring orchestration children"),
                    "{error:#}"
                );
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "parent {parent} recovery did not finish"
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn fixture(name: &str, conversation: &str, transcript: &str, cwd: &Path) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/claude")
        .join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let mut v: Value = serde_json::from_str(&raw).unwrap();
    v["session_id"] = conversation.into();
    v["transcript_path"] = transcript.into();
    v["cwd"] = cwd.display().to_string().into();
    v.to_string()
}

/// Runs the real hook helper on a Claude payload, as the CLI's hook would.
async fn run_hook(event: &str, session: u32, stdin: String) -> HookDrop {
    run_hook_as(event, session, stdin, None).await
}

async fn run_hook_as(event: &str, session: u32, stdin: String, agent: Option<&str>) -> HookDrop {
    run_hook_with_profile(event, session, stdin, agent, None).await
}

async fn run_hook_with_profile(
    event: &str,
    session: u32,
    stdin: String,
    agent: Option<&str>,
    profile_dir: Option<String>,
) -> HookDrop {
    let home = tempfile::tempdir().unwrap();
    let event = event.to_string();
    let home_path = home.path().to_path_buf();
    let agent = agent.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let mut cmd = houston_core::spawn::command(env!("CARGO_BIN_EXE_houston-core"));
        cmd.arg("hook").arg(&event).arg("--houston-managed");
        if let Some(agent) = &agent {
            cmd.arg("--agent").arg(agent);
        }
        cmd.env_clear();
        cmd.env("HOME", &home_path);
        cmd.env("HOUSTON_CHANNEL", "resumetest");
        cmd.env("TR_SESSION", session.to_string());
        for name in ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
            if let Ok(value) = std::env::var(name) {
                cmd.env(name, value);
            }
        }
        if let Some(directory) = profile_dir {
            cmd.env("CLAUDE_CONFIG_DIR", directory);
        }
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
        let dir = houston_core::hook_drop::drop_dir(&home_path.join(".houston-resumetest"));
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

async fn apply_drop(env: &Env, daemon: &Arc<Daemon>, drop: HookDrop) {
    let path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(env.state.path()),
        &drop,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(tokio::time::Instant::now() < deadline, "drop never applied");
        daemon.hook_drop_tick_for_test();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Feeds one Claude 2.1.x fixture for `session`, speaking as `conversation`.
#[allow(clippy::too_many_arguments)]
async fn hook(
    env: &Env,
    daemon: &Arc<Daemon>,
    session: u32,
    event: &str,
    fixture_name: &str,
    conversation: &str,
    transcript: &str,
    cwd: &Path,
) {
    let stdin = fixture(fixture_name, conversation, transcript, cwd);
    let selected_profile = daemon.list().iter().any(|info| {
        info.id == session && info.agent == proto::AgentKind::Claude && info.profile_label.is_some()
    });
    let profile_dir = if selected_profile {
        Some(config_dir_of(&argv_of(env, session).await))
    } else {
        None
    };
    let drop = run_hook_with_profile(event, session, stdin, None, profile_dir).await;
    apply_drop(env, daemon, drop).await;
}

async fn hook_as(
    env: &Env,
    daemon: &Arc<Daemon>,
    session: u32,
    agent: &str,
    event: &str,
    stdin: String,
) {
    let drop = run_hook_as(event, session, stdin, Some(agent)).await;
    apply_drop(env, daemon, drop).await;
}

/// A ZCode payload for `session` (its hook stdin carries no transcript Houston keeps).
fn zcode_fixture(name: &str, conversation: &str, cwd: &Path) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/zcode")
        .join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let mut v: Value = serde_json::from_str(&raw).unwrap();
    v["session_id"] = conversation.into();
    v["sessionId"] = conversation.into();
    v["cwd"] = cwd.display().to_string().into();
    v.to_string()
}

const START: &str = "claude-2.1.263-01-SessionStart.json";
const PROMPT: &str = "claude-2.1.263-02-UserPromptSubmit.json";

#[tokio::test]
async fn shell_hosted_claude_hook_is_recorded_and_restart_resumes_inside_shell() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-parent");
    let hook_cwd = dir.join("nested");
    std::fs::create_dir_all(&hook_cwd).unwrap();
    let hook_cwd = std::fs::canonicalize(hook_cwd).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let conversation = "00000000-0000-4000-8000-000000000078";
    let transcript = transcript(&env, conversation, b"transcript fixture\n");

    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        conversation,
        &transcript,
        &hook_cwd,
    )
    .await;
    assert_eq!(
        handle_in(&env, shell.id),
        Some((conversation.into(), Some(transcript)))
    );

    let restarted = reboot(&env, &daemon);
    let restored = restored_from(&restarted.list(), shell.id).clone();
    assert_eq!(restored.agent, proto::AgentKind::Shell);
    assert_eq!(restored.session_origin, Some(shell.id));
    assert_eq!(restored.cwd, hook_cwd.display().to_string());
    assert_eq!(restored.detected_agent, Some(proto::AgentKind::Claude));
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(
        resume_of(&argv).as_deref(),
        Some(conversation),
        "the restored shell must relaunch the exact Claude conversation"
    );
    let settings_file = flag(&argv, "--settings").expect(
        "shell recovery must carry pane identity in Claude arguments, even if its daemon drops env",
    );
    let settings: Value = serde_json::from_slice(&std::fs::read(&settings_file).unwrap()).unwrap();
    assert_eq!(settings["env"]["TR_SESSION"], restored.id.to_string());
    assert_eq!(settings["env"]["HOUSTON_SESSION"], restored.id.to_string());
    let home = tempfile::tempdir().unwrap();
    let mut hook = houston_core::spawn::command(env!("CARGO_BIN_EXE_houston-core"));
    hook.args(["hook", "UserPromptSubmit"])
        .env_clear()
        .env("HOME", home.path());
    for (key, value) in settings["env"].as_object().unwrap() {
        hook.env(key, value.as_str().unwrap());
    }
    hook.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = hook.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::json!({
                "session_id": conversation, "cwd": hook_cwd, "prompt": "resume work"
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let channel =
        houston_core::paths::validate_channel(settings["env"]["HOUSTON_CHANNEL"].as_str().unwrap())
            .unwrap();
    let drops = houston_core::hook_drop::drop_dir(&houston_core::paths::dir_for(
        home.path(),
        channel.as_deref(),
    ));
    let drop = std::fs::read_dir(drops)
        .unwrap()
        .flatten()
        .find(|entry| {
            houston_core::hook_drop::parse_drop_name(&entry.file_name().to_string_lossy()).is_some()
        })
        .unwrap();
    let drop: HookDrop = serde_json::from_slice(&std::fs::read(drop.path()).unwrap()).unwrap();
    assert_eq!(drop.session, restored.id);
    apply_drop(&env, &restarted, drop).await;
    assert_eq!(
        restarted
            .list()
            .into_iter()
            .find(|pane| pane.id == restored.id)
            .unwrap()
            .status,
        Some(proto::AgentStatus::Working)
    );
    daemon.close(shell.id).unwrap();
    restarted.close(restored.id).unwrap();
}

#[tokio::test]
async fn shell_hook_profile_is_captured_and_reused_when_daemon_profile_switches() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-profile");
    let profile = env.state.path().join("claude-manual-account");
    std::fs::create_dir_all(&profile).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &profile);
    let shell = shell_pane(&daemon, &dir);
    let conversation = "00000000-0000-4000-8000-000000000079";
    let transcript = transcript(&env, conversation, b"transcript fixture\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        conversation,
        &transcript,
        &dir,
    )
    .await;
    assert_eq!(
        Db::open(&env.db_path())
            .unwrap()
            .session_profile_config_dir(shell.id)
            .unwrap()
            .as_deref(),
        Some(profile.to_str().unwrap()),
    );

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let restarted = reboot(&env, &daemon);
    let restored = restored_from(&restarted.list(), shell.id).clone();
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(resume_of(&argv).as_deref(), Some(conversation));
    assert_eq!(config_dir_of(&argv), profile.display().to_string());
    daemon.close(shell.id).unwrap();
    restarted.close(restored.id).unwrap();
}

#[tokio::test]
async fn deleted_manual_shell_profile_is_reported_and_does_not_resume_elsewhere() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-profile-deleted");
    let profile = env.state.path().join("claude-deleted-account");
    std::fs::create_dir_all(&profile).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &profile);
    let shell = shell_pane(&daemon, &dir);
    let conversation = "00000000-0000-4000-8000-000000000080";
    let transcript = transcript(&env, conversation, b"transcript fixture\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        conversation,
        &transcript,
        &dir,
    )
    .await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::fs::remove_dir_all(&profile).unwrap();

    let restarted = reboot(&env, &daemon);
    let restored = restored_from(&restarted.list(), shell.id).clone();
    assert!(restored
        .resume_notice
        .as_deref()
        .unwrap_or_default()
        .contains("profile directory"));
    daemon.close(shell.id).unwrap();
    restarted.close(restored.id).unwrap();
}

#[tokio::test]
async fn shell_hook_captures_and_reuses_codex_home_for_exact_thread_resume() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-codex-profile");
    let profile = env.state.path().join("codex-manual-account");
    std::fs::create_dir_all(&profile).unwrap();
    std::env::set_var("CODEX_HOME", &profile);
    let shell = shell_pane(&daemon, &dir);
    let conversation = "019a0000-0000-4000-8000-000000000082";
    let transcript = transcript(&env, conversation, b"codex transcript fixture\n");
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/codex/codex-0.153.4-03-Stop.json");
    let mut payload: Value = serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    payload["session_id"] = conversation.into();
    payload["transcript_path"] = transcript.into();
    payload["cwd"] = dir.display().to_string().into();
    hook_as(
        &env,
        &daemon,
        shell.id,
        "codex",
        "Stop",
        payload.to_string(),
    )
    .await;
    std::env::remove_var("CODEX_HOME");

    let restarted = reboot(&env, &daemon);
    let restored = restored_from(&restarted.list(), shell.id).clone();
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(resume_of(&argv).as_deref(), Some(conversation));
    assert_eq!(codex_home_of(&argv), profile.display().to_string());
    assert_eq!(restored.agent, proto::AgentKind::Shell);
    assert_eq!(restored.detected_agent, Some(proto::AgentKind::Codex));
    daemon.close(shell.id).unwrap();
    restarted.close(restored.id).unwrap();
}

#[tokio::test]
async fn shell_children_stay_deferred_when_the_resumed_cli_exits_before_root_hook() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-child-recovery");
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    daemon.set_orchestration_caps(4, 2).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let child = daemon
        .orchestrate_spawn(
            shell.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("child result stays held".to_string()),
            Some(false),
            None,
            Some("recovery-child".to_string()),
        )
        .unwrap();
    let child_conversation = flag(&argv_of(&env, child.id).await, "--session-id").unwrap();
    let child_transcript = transcript(&env, &child_conversation, b"child transcript\n");
    hook(
        &env,
        &daemon,
        child.id,
        "UserPromptSubmit",
        PROMPT,
        &child_conversation,
        &child_transcript,
        &dir,
    )
    .await;
    let nested = daemon
        .orchestrate_spawn(
            child.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("nested result remains held".to_string()),
            Some(false),
            None,
            Some("nested-recovery-child".to_string()),
        )
        .unwrap();
    let nested_conversation = flag(&argv_of(&env, nested.id).await, "--session-id").unwrap();
    let nested_transcript = transcript(&env, &nested_conversation, b"nested transcript\n");
    hook(
        &env,
        &daemon,
        nested.id,
        "UserPromptSubmit",
        PROMPT,
        &nested_conversation,
        &nested_transcript,
        &dir,
    )
    .await;
    let root_conversation = "00000000-0000-4000-8000-000000000081";
    let root_transcript = transcript(&env, root_conversation, b"root transcript\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        root_conversation,
        &root_transcript,
        &dir,
    )
    .await;

    std::env::set_var("RESUME_FAKE_EXIT", "1");
    let restarted = reboot(&env, &daemon);
    let sessions = restarted.list();
    let restored_parent = restored_from(&sessions, shell.id);
    assert!(restarted
        .inbox_rows_for_test(restored_parent.id)
        .iter()
        .any(|row| row.summary.contains("child recovery deferred")
            || row.body.contains("child recovery is deferred")));
    assert!(sessions.iter().all(|session| {
        (session.session_origin != Some(child.id) && session.session_origin != Some(nested.id))
            || !session.state.is_live()
    }));
    assert_eq!(
        sessions
            .iter()
            .find(|session| session.id == nested.id)
            .unwrap()
            .restore_deferred,
        Some(proto::RestoreReason::SpawnFailed),
    );
    for child_id in [child.id, nested.id] {
        let deferred = sessions
            .iter()
            .find(|session| session.id == child_id)
            .unwrap();
        assert_eq!(deferred.state, proto::SessionState::Interrupted);
        assert_eq!(
            deferred.restore_deferred,
            Some(proto::RestoreReason::SpawnFailed)
        );
    }
    assert_eq!(
        resume_of(&argv_of(&env, restored_parent.id).await).as_deref(),
        Some(root_conversation)
    );
    daemon.close(shell.id).unwrap();
    restarted.close(restored_parent.id).unwrap();
}

#[tokio::test]
async fn shell_without_a_root_handle_names_the_failure_and_defers_children() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-without-root-handle");
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let child = daemon
        .orchestrate_spawn(
            shell.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("remain held".to_string()),
            Some(false),
            None,
            Some("no-root-child".to_string()),
        )
        .unwrap();
    let restarted = reboot(&env, &daemon);
    let sessions = restarted.list();
    let parent = restored_from(&sessions, shell.id);
    assert!(parent
        .resume_notice
        .as_deref()
        .unwrap_or_default()
        .contains("no validated root conversation handle"));
    let deferred_child = sessions
        .iter()
        .find(|session| session.id == child.id)
        .unwrap();
    assert_eq!(deferred_child.state, proto::SessionState::Interrupted);
    assert_eq!(
        deferred_child.restore_deferred,
        Some(proto::RestoreReason::SpawnFailed)
    );
    daemon.close(shell.id).unwrap();
    restarted.close(parent.id).unwrap();
}

#[tokio::test]
async fn shell_children_resume_only_after_the_matching_root_native_resume_hook() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-child-confirmed");
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let child = daemon
        .orchestrate_spawn(
            shell.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("restore after parent".to_string()),
            Some(false),
            None,
            Some("confirmed-child".to_string()),
        )
        .unwrap();
    let child_conversation = flag(&argv_of(&env, child.id).await, "--session-id").unwrap();
    let child_transcript = transcript(&env, &child_conversation, b"child transcript\n");
    hook(
        &env,
        &daemon,
        child.id,
        "UserPromptSubmit",
        PROMPT,
        &child_conversation,
        &child_transcript,
        &dir,
    )
    .await;
    let root_conversation = "00000000-0000-4000-8000-000000000083";
    let root_transcript = transcript(&env, root_conversation, b"root transcript\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        root_conversation,
        &root_transcript,
        &dir,
    )
    .await;

    let restarted = reboot(&env, &daemon);
    let parent = restored_from(&restarted.list(), shell.id).clone();
    let child_placeholder = restarted
        .list()
        .into_iter()
        .find(|session| session.id == child.id)
        .unwrap();
    assert_eq!(child_placeholder.state, proto::SessionState::Interrupted);
    assert_eq!(
        child_placeholder.restore_deferred,
        Some(proto::RestoreReason::SpawnFailed)
    );
    hook(
        &env,
        &restarted,
        parent.id,
        "SessionStart",
        RESUMED,
        "00000000-0000-4000-8000-000000000099",
        &root_transcript,
        &dir,
    )
    .await;
    let child_placeholder = restarted
        .list()
        .into_iter()
        .find(|session| session.id == child.id)
        .unwrap();
    assert_eq!(child_placeholder.state, proto::SessionState::Interrupted);
    assert_eq!(
        child_placeholder.restore_deferred,
        Some(proto::RestoreReason::SpawnFailed)
    );
    hook(
        &env,
        &restarted,
        parent.id,
        "SessionStart",
        RESUMED,
        root_conversation,
        &root_transcript,
        &dir,
    )
    .await;
    assert!(wait_restored_child(&restarted, child.id).await.resumable);
    daemon.close(shell.id).unwrap();
    close_after_shell_restore(&restarted, parent.id).await;
}

/// ZCode run by hand inside a shell pane orchestrates a child; after a restart the
/// shell relaunches `zcode --resume <id>` and restores the child only once the root's
/// own resumed SessionStart names that conversation.
#[tokio::test]
async fn shell_hosted_zcode_resumes_by_id_and_restores_its_children_after_its_resume_hook() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-zcode-parent");
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let child = daemon
        .orchestrate_spawn(
            shell.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("restore after a ZCode parent".to_string()),
            Some(false),
            None,
            Some("zcode-child".to_string()),
        )
        .unwrap();
    let child_conversation = flag(&argv_of(&env, child.id).await, "--session-id").unwrap();
    let child_transcript = transcript(&env, &child_conversation, b"child transcript\n");
    hook(
        &env,
        &daemon,
        child.id,
        "UserPromptSubmit",
        PROMPT,
        &child_conversation,
        &child_transcript,
        &dir,
    )
    .await;
    let root = "sess_01J9ZCSHELL00000000000000";
    hook_as(
        &env,
        &daemon,
        shell.id,
        "zcode",
        "UserPromptSubmit",
        zcode_fixture("zcode-3.14.3-src-02-UserPromptSubmit.json", root, &dir),
    )
    .await;
    assert_eq!(
        handle_in(&env, shell.id),
        Some((root.to_string(), None)),
        "the shell records ZCode's conversation from its hook"
    );

    let restarted = reboot(&env, &daemon);
    let parent = restored_from(&restarted.list(), shell.id).clone();
    assert_eq!(parent.agent, proto::AgentKind::Shell);
    assert_eq!(parent.detected_agent, Some(proto::AgentKind::Zcode));
    let argv = argv_of(&env, parent.id).await;
    assert_eq!(flag(&argv, "--resume").as_deref(), Some(root), "{argv:?}");
    let deferred = |daemon: &Arc<Daemon>| {
        daemon
            .list()
            .into_iter()
            .find(|session| session.id == child.id)
            .unwrap()
            .restore_deferred
    };
    assert_eq!(
        deferred(&restarted),
        Some(proto::RestoreReason::SpawnFailed)
    );
    hook_as(
        &env,
        &restarted,
        parent.id,
        "zcode",
        "SessionStart",
        zcode_fixture("zcode-3.14.3-src-01-SessionStart.json", root, &dir),
    )
    .await;
    assert_eq!(
        deferred(&restarted),
        Some(proto::RestoreReason::SpawnFailed),
        "a fresh start is not the resumed conversation"
    );
    hook_as(
        &env,
        &restarted,
        parent.id,
        "zcode",
        "SessionStart",
        zcode_fixture("zcode-3.14.3-src-09-SessionStart-resume.json", root, &dir),
    )
    .await;
    assert!(wait_restored_child(&restarted, child.id).await.resumable);
    daemon.close(shell.id).unwrap();
    close_after_shell_restore(&restarted, parent.id).await;
}

#[tokio::test]
async fn delayed_shell_child_recovery_does_not_block_unrelated_pane_input() {
    let env = setup().await;
    let daemon = boot(&env);
    let dir = project(&env, "shell-child-recovery-input");
    daemon.workspace_add(&dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let shell = shell_pane(&daemon, &dir);
    let child = daemon
        .orchestrate_spawn(
            shell.id,
            proto::AgentKind::Claude,
            None,
            None,
            houston_core::orchestrate::Brief::from("restore a delayed child".to_string()),
            Some(false),
            None,
            Some("delayed-recovery-child".to_string()),
        )
        .unwrap();
    let child_conversation = flag(&argv_of(&env, child.id).await, "--session-id").unwrap();
    let child_transcript = transcript(&env, &child_conversation, b"child transcript\n");
    hook(
        &env,
        &daemon,
        child.id,
        "UserPromptSubmit",
        PROMPT,
        &child_conversation,
        &child_transcript,
        &dir,
    )
    .await;
    let root_conversation = "00000000-0000-4000-8000-000000000084";
    let root_transcript = transcript(&env, root_conversation, b"root transcript\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        root_conversation,
        &root_transcript,
        &dir,
    )
    .await;

    let restarted = reboot(&env, &daemon);
    let parent = restored_from(&restarted.list(), shell.id).clone();
    let unrelated = shell_pane(&restarted, &dir);
    let marker = env.argv.path().join("delayed-child-resume-started");
    let restore_marker = marker.clone();
    restarted.set_shell_child_restore_observer_for_test(Arc::new(move |_| {
        std::fs::write(&restore_marker, b"started").unwrap();
        std::thread::sleep(Duration::from_secs(2));
    }));
    let drop = run_hook(
        "SessionStart",
        parent.id,
        fixture(RESUMED, root_conversation, &root_transcript, &dir),
    )
    .await;
    houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(env.state.path()),
        &drop,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    let applying_daemon = restarted.clone();
    let applying = tokio::task::spawn_blocking(move || applying_daemon.hook_drop_tick_for_test());
    let marker_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            tokio::time::Instant::now() < marker_deadline,
            "restored child did not reach the delayed launch"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let started = std::time::Instant::now();
    restarted
        .write_stdin(unrelated.id, b"input during child recovery\n")
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "unrelated pane input waited for restored child recovery"
    );
    let hook_conversation = "00000000-0000-4000-8000-000000000085";
    let hook_transcript = transcript(&env, hook_conversation, b"unrelated hook fixture\n");
    let hook_started = std::time::Instant::now();
    hook(
        &env,
        &restarted,
        unrelated.id,
        "UserPromptSubmit",
        PROMPT,
        hook_conversation,
        &hook_transcript,
        &dir,
    )
    .await;
    assert!(
        hook_started.elapsed() < Duration::from_secs(1),
        "unrelated hook waited for restored child recovery"
    );
    for error in [
        restarted.kill(parent.id).unwrap_err().to_string(),
        restarted.close(parent.id).unwrap_err().to_string(),
        restarted
            .respawn(parent.id, true, None, None, false)
            .unwrap_err()
            .to_string(),
    ] {
        assert!(
            error.contains("restoring orchestration children"),
            "{error}"
        );
    }
    applying.await.unwrap();
    assert!(wait_restored_child(&restarted, child.id).await.resumable);
    daemon.close(shell.id).unwrap();
    restarted.close(unrelated.id).unwrap();
    close_after_shell_restore(&restarted, parent.id).await;
}
const STOP: &str = "claude-2.1.263-05-Stop.json";
const CLEAR: &str = "claude-2.1.284-02-SessionStart-clear.json";
const RESUMED: &str = "claude-2.1.284-01-SessionStart-resume.json";

/// A live Claude pane that has had one turn in its pre-assigned conversation.
async fn pane_with_a_turn(
    env: &Env,
    daemon: &Arc<Daemon>,
    dir: &Path,
    profile: Option<u32>,
) -> (proto::SessionInfo, String, String) {
    let info = claude_pane(daemon, dir, profile);
    let conversation = flag(&argv_of(env, info.id).await, "--session-id")
        .expect("a fresh Claude pane launches with a pre-assigned id");
    let path = transcript(env, &conversation, b"{}\n");
    hook(
        env,
        daemon,
        info.id,
        "SessionStart",
        START,
        &conversation,
        &path,
        dir,
    )
    .await;
    hook(
        env,
        daemon,
        info.id,
        "UserPromptSubmit",
        PROMPT,
        &conversation,
        &path,
        dir,
    )
    .await;
    hook(
        env,
        daemon,
        info.id,
        "Stop",
        STOP,
        &conversation,
        &path,
        dir,
    )
    .await;
    (info, conversation, path)
}

/// A seeded `running` Claude row, as an orderly shutdown leaves it.
fn seed_claude(env: &Env, id: u32, dir: &Path, cwd: &Path, handle: Option<(&str, Option<&str>)>) {
    let db = Db::open(&env.db_path()).unwrap();
    db.insert_session(&proto::SessionInfo {
        checkout: None,
        activity: None,
        id,
        agent: proto::AgentKind::Claude,
        project_dir: dir.display().to_string(),
        cwd: cwd.display().to_string(),
        state: proto::SessionState::Running,
        title: format!("Pane-{id}"),
        codename: format!("Pane-{id}"),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by: None,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
    })
    .unwrap();
    db.set_session_resume_handle(id, handle).unwrap();
}

fn clean_shutdown(env: &Env) {
    std::fs::write(env.state.path().join("clean-shutdown"), b"").unwrap();
}

#[tokio::test]
async fn an_orderly_restore_resumes_each_claude_pane_in_its_own_conversation() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let (a, conv_a, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let (b, conv_b, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    assert_ne!(conv_a, conv_b);

    let after = reboot(&env, &daemon);
    let sessions = after.list();
    for (old, conversation) in [(a.id, &conv_a), (b.id, &conv_b)] {
        let argv = argv_of(&env, restored_from(&sessions, old).id).await;
        assert_eq!(resume_of(&argv).as_ref(), Some(conversation), "{argv:?}");
        for banned in ["--session-id", "--continue", "-c"] {
            assert!(!argv.iter().any(|a| a == banned), "{banned} in {argv:?}");
        }
    }
}

#[tokio::test]
async fn a_fresh_claude_pane_launches_with_a_preassigned_session_id() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let info = claude_pane(&daemon, &ws, None);
    assert!(
        native_in(&env, info.id).is_some(),
        "the id is stored before any hook"
    );
    let argv = argv_of(&env, info.id).await;
    let id = flag(&argv, "--session-id").expect("--session-id <uuid>");
    assert_eq!(
        uuid::Uuid::parse_str(&id).unwrap().get_version_num(),
        4,
        "{id}"
    );
    assert_eq!(native_in(&env, info.id).as_deref(), Some(id.as_str()));
    assert!(resume_of(&argv).is_none());
}

#[tokio::test]
async fn a_turn_promotes_the_root_id_to_the_resume_handle() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    for (event, fixture_name) in [("UserPromptSubmit", PROMPT), ("Stop", STOP)] {
        let info = claude_pane(&daemon, &ws, None);
        let conversation = flag(&argv_of(&env, info.id).await, "--session-id").unwrap();
        let path = transcript(&env, &conversation, b"{}\n");
        hook(
            &env,
            &daemon,
            info.id,
            "SessionStart",
            START,
            &conversation,
            &path,
            &ws,
        )
        .await;
        assert_eq!(handle_in(&env, info.id), None, "{event}: not before a turn");
        hook(
            &env,
            &daemon,
            info.id,
            event,
            fixture_name,
            &conversation,
            &path,
            &ws,
        )
        .await;
        assert_eq!(
            handle_in(&env, info.id),
            Some((conversation.clone(), Some(path.clone()))),
            "{event} promotes the root id"
        );
    }
}

#[tokio::test]
async fn a_pane_that_never_had_a_turn_restores_fresh() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let info = claude_pane(&daemon, &ws, None);
    let conversation = flag(&argv_of(&env, info.id).await, "--session-id").unwrap();
    let path = transcript(&env, &conversation, b"{}\n");
    hook(
        &env,
        &daemon,
        info.id,
        "SessionStart",
        START,
        &conversation,
        &path,
        &ws,
    )
    .await;

    let after = reboot(&env, &daemon);
    let restored = restored_from(&after.list(), info.id).clone();
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(resume_of(&argv), None, "{argv:?}");
    assert_eq!(restored.resume_notice, None);
}

#[tokio::test]
async fn a_cleared_conversation_keeps_the_old_handle_until_its_first_turn() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let (info, first, first_path) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let cleared = "e32a88ea-7f35-48fb-80fc-4ac5c2f7fd2e";
    let cleared_path = transcript(&env, cleared, b"{}\n");

    hook(
        &env,
        &daemon,
        info.id,
        "SessionStart",
        CLEAR,
        cleared,
        &cleared_path,
        &ws,
    )
    .await;
    assert_eq!(
        handle_in(&env, info.id),
        Some((first.clone(), Some(first_path))),
        "/clear without a turn keeps the previous handle"
    );
    hook(
        &env,
        &daemon,
        info.id,
        "UserPromptSubmit",
        PROMPT,
        cleared,
        &cleared_path,
        &ws,
    )
    .await;
    assert_eq!(
        handle_in(&env, info.id).map(|h| h.0).as_deref(),
        Some(cleared)
    );

    let after = reboot(&env, &daemon);
    let argv = argv_of(&env, restored_from(&after.list(), info.id).id).await;
    assert_eq!(resume_of(&argv).as_deref(), Some(cleared), "{argv:?}");
}

#[tokio::test]
async fn a_killed_or_closed_pane_loses_its_handle() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let (killed, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let (closed, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;

    daemon.kill(killed.id).unwrap();
    wait_for_state(&daemon, killed.id, proto::SessionState::Killed).await;
    assert_eq!(handle_in(&env, killed.id), None);
    let restarted = daemon.respawn(killed.id, false, None, None, false).unwrap();
    assert!(!restarted.resumable);
    assert_eq!(resume_of(&argv_of(&env, restarted.id).await), None);

    daemon.close(closed.id).unwrap();
    assert_eq!(handle_in(&env, closed.id), None);
}

#[tokio::test]
async fn the_handle_survives_consecutive_restores() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-h", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-h", Some(&path))));
    clean_shutdown(&env);

    let first = boot(&env);
    let once = restored_from(&first.list(), 5).clone();
    assert_eq!(
        resume_of(&argv_of(&env, once.id).await).as_deref(),
        Some("conv-h")
    );
    assert_eq!(
        handle_in(&env, once.id).map(|h| h.0).as_deref(),
        Some("conv-h")
    );

    let second = reboot(&env, &first);
    let twice = restored_from(&second.list(), 5).clone();
    assert_eq!(
        resume_of(&argv_of(&env, twice.id).await).as_deref(),
        Some("conv-h")
    );
}

#[tokio::test]
async fn with_restore_resume_off_every_pane_restores_fresh() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-off", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-off", Some(&path))));
    Db::open(&env.db_path())
        .unwrap()
        .set_setting("restore_resume", "0")
        .unwrap();
    clean_shutdown(&env);

    let daemon = boot(&env);
    let restored = restored_from(&daemon.list(), 5).clone();
    assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
    let restarted = daemon
        .respawn(restored.id, false, None, None, true)
        .unwrap();
    assert_eq!(
        resume_of(&argv_of(&env, restarted.id).await).as_deref(),
        Some("conv-off"),
        "disabling boot resume keeps a valid handle for an explicit restart"
    );
}

fn upsert_profile(daemon: &Daemon, name: &str, dir: &str) -> u32 {
    std::fs::create_dir_all(dir).unwrap();
    let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon
        .agent_profile_upsert(None, proto::AgentKind::Claude, name, dir)
        .unwrap()
    else {
        panic!("agent_profile_upsert answers with the profile state");
    };
    profiles.iter().find(|p| p.name == name).unwrap().id
}

#[tokio::test]
async fn a_resumed_pane_runs_on_its_profile_config_dir() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let work = env.state.path().join("work-config").display().to_string();
    let profile = upsert_profile(&daemon, "work", &work);
    let (info, conversation, _) = pane_with_a_turn(&env, &daemon, &ws, Some(profile)).await;

    let after = reboot(&env, &daemon);
    let argv = argv_of(&env, restored_from(&after.list(), info.id).id).await;
    assert_eq!(resume_of(&argv), Some(conversation), "{argv:?}");
    assert_eq!(config_dir_of(&argv), work);
}

#[tokio::test]
async fn a_deleted_profile_falls_back_naming_it() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let work = env.state.path().join("work-config").display().to_string();
    let profile = upsert_profile(&daemon, "work", &work);
    let (info, _, _) = pane_with_a_turn(&env, &daemon, &ws, Some(profile)).await;
    daemon.agent_profile_delete(profile).unwrap();

    let after = reboot(&env, &daemon);
    let restored = restored_from(&after.list(), info.id).clone();
    assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
    let notice = restored.resume_notice.expect("a fallback says why");
    assert!(notice.contains("\"work\""), "{notice}");
}

#[tokio::test]
async fn two_panes_never_resume_the_same_conversation() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-shared", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-shared", Some(&path))));
    seed_claude(&env, 6, &ws, &ws, Some(("conv-shared", Some(&path))));
    clean_shutdown(&env);

    let daemon = boot(&env);
    let sessions = daemon.list();
    let a = restored_from(&sessions, 5).clone();
    let b = restored_from(&sessions, 6).clone();
    let (resumed, fresh) = match (
        resume_of(&argv_of(&env, a.id).await),
        resume_of(&argv_of(&env, b.id).await),
    ) {
        (Some(_), None) => (a, b),
        (None, Some(_)) => (b, a),
        other => panic!("exactly one pane resumes conv-shared: {other:?}"),
    };
    let notice = fresh.resume_notice.expect("the other pane says why");
    assert!(
        notice.contains(&format!("session {}", resumed.id)),
        "{notice}"
    );
}

#[tokio::test]
async fn a_missing_or_empty_transcript_falls_back_with_its_reason() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let missing = env.state.path().join("gone.jsonl").display().to_string();
    let empty = transcript(&env, "conv-empty", b"");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-gone", Some(&missing))));
    seed_claude(&env, 6, &ws, &ws, Some(("conv-empty", Some(&empty))));
    clean_shutdown(&env);

    let daemon = boot(&env);
    let sessions = daemon.list();
    for (old, conversation, path, word) in [
        (5, "conv-gone", &missing, "missing"),
        (6, "conv-empty", &empty, "empty"),
    ] {
        let restored = restored_from(&sessions, old).clone();
        assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
        let notice = restored.resume_notice.expect("a fallback says why");
        assert!(
            notice.contains(path.as_str()) && notice.contains(word),
            "{notice}"
        );
        assert_eq!(
            handle_in(&env, restored.id).map(|h| h.0).as_deref(),
            Some(conversation),
            "the handle is kept for the next attempt"
        );
    }
}

#[tokio::test]
async fn the_transcript_check_reads_metadata_only() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-locked", b"0123456789");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    seed_claude(&env, 5, &ws, &ws, Some(("conv-locked", Some(&path))));
    clean_shutdown(&env);

    let daemon = boot(&env);
    let restored = restored_from(&daemon.list(), 5).clone();
    assert_eq!(
        resume_of(&argv_of(&env, restored.id).await).as_deref(),
        Some("conv-locked"),
        "{:?}",
        restored.resume_notice
    );
}

#[tokio::test]
async fn a_vanished_cwd_falls_back_with_its_path() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let sub = ws.join("worktree");
    std::fs::create_dir_all(&sub).unwrap();
    let path = transcript(&env, "conv-cwd", b"{}\n");
    seed_claude(&env, 5, &ws, &sub, Some(("conv-cwd", Some(&path))));
    std::fs::remove_dir(&sub).unwrap();
    clean_shutdown(&env);

    let daemon = boot(&env);
    let restored = restored_from(&daemon.list(), 5).clone();
    assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
    let notice = restored.resume_notice.expect("a fallback says why");
    assert!(notice.contains(&sub.display().to_string()), "{notice}");
}

async fn wait_for_session(daemon: &Daemon, what: &str, f: impl Fn(&proto::SessionInfo) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !daemon.list().iter().any(&f) {
        assert!(tokio::time::Instant::now() < deadline, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_resume_that_exits_early_relaunches_fresh_once() {
    let env = setup().await;
    std::env::set_var("RESUME_FAKE_EXIT", "1");
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-rejected", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-rejected", Some(&path))));
    clean_shutdown(&env);
    let resumed_id = Db::open(&env.db_path()).unwrap().next_session_id().unwrap();

    let daemon = boot(&env);
    assert_eq!(
        resume_of(&argv_of(&env, resumed_id).await).as_deref(),
        Some("conv-rejected")
    );
    wait_for_session(&daemon, "the fresh relaunch", |s| {
        s.session_origin == Some(5) && s.id != resumed_id
    })
    .await;
    let fallback = restored_from(&daemon.list(), 5).clone();
    assert_eq!(resume_of(&argv_of(&env, fallback.id).await), None);
    let notice = fallback
        .resume_notice
        .clone()
        .expect("the relaunch says why");
    assert!(
        notice.contains("code 1") && notice.contains("10 s"),
        "{notice}"
    );
    assert_eq!(
        handle_in(&env, fallback.id).map(|h| h.0).as_deref(),
        Some("conv-rejected")
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !daemon
            .list()
            .iter()
            .any(|s| s.session_origin == Some(5) && s.id != fallback.id),
        "one fallback, never a loop"
    );
}

#[tokio::test]
async fn a_resumed_cli_that_exits_cleanly_is_not_relaunched() {
    let env = setup().await;
    std::env::set_var("RESUME_FAKE_EXIT", "0");
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-quit", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-quit", Some(&path))));
    clean_shutdown(&env);

    let daemon = boot(&env);
    let resumed = restored_from(&daemon.list(), 5).clone();
    assert_eq!(
        resume_of(&argv_of(&env, resumed.id).await).as_deref(),
        Some("conv-quit")
    );
    wait_for_state(&daemon, resumed.id, proto::SessionState::Exited).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !daemon
            .list()
            .iter()
            .any(|s| s.session_origin == Some(5) && s.id != resumed.id),
        "a clean exit is the user's"
    );
}

#[tokio::test]
async fn a_codex_pane_restores_its_exact_thread_id() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Codex,
            project_dir: ws.clone(),
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
        .unwrap();
    argv_of(&env, info.id).await;
    let path = transcript(&env, "codex-thread", b"{}\n");
    for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
        apply_drop(
            &env,
            &daemon,
            HookDrop {
                v: houston_core::hook_drop::DROP_V,
                event: event.into(),
                session: info.id,
                agent: Some("codex".into()),
                session_id: Some("codex-thread".into()),
                transcript_path: Some(path.clone()),
                ..Default::default()
            },
        )
        .await;
    }
    assert_eq!(
        handle_in(&env, info.id),
        Some(("codex-thread".into(), Some(path)))
    );

    let after = reboot(&env, &daemon);
    let restored = restored_from(&after.list(), info.id).clone();
    let argv = argv_of(&env, restored.id).await;
    assert_eq!(resume_of(&argv).as_deref(), Some("codex-thread"));
    assert!(!argv.iter().any(|a| a == "--last"), "{argv:?}");
    assert_eq!(
        native_in(&env, restored.id).as_deref(),
        Some("codex-thread")
    );
    assert!(restored.resumable);
    assert_eq!(restored.resume_notice, None);
}

async fn respawn_over_the_wire(
    addr: std::net::SocketAddr,
    session: u32,
    fresh: Option<bool>,
) -> proto::SessionInfo {
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let msg = proto::ClientMsg::SessionRespawn {
        session,
        shell_integration: Some(false),
        cwd: None,
        shell: None,
        force: Some(true),
        fresh,
    };
    ws.send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
        .await
        .unwrap();
    expect_created(&mut ws).await
}

#[tokio::test]
async fn restart_over_the_wire_resumes_by_default() {
    let env = setup().await;
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    daemon.set_restore_resume(false).unwrap();
    let ws = project(&env, "ws");
    let (live, conversation, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;

    let restarted = respawn_over_the_wire(addr, live.id, None).await;
    assert_eq!(
        resume_of(&argv_of(&env, restarted.id).await),
        Some(conversation.clone())
    );
    assert!(restarted.resumable);
    assert_eq!(
        handle_in(&env, restarted.id).map(|h| h.0),
        Some(conversation),
        "the forced kill does not clear the handle it carries"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_survives_boot_and_wake_resumes_the_exact_conversation() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "sleep-wake");
    let (pane, conversation, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    apply_drop(
        &env,
        &daemon,
        HookDrop {
            v: houston_core::hook_drop::DROP_V,
            event: "UserPromptSubmit".into(),
            session: pane.id,
            agent: Some("claude".into()),
            prompt: Some("Keep this bounded sleep cue".into()),
            ..Default::default()
        },
    )
    .await;
    hook(
        &env,
        &daemon,
        pane.id,
        "Stop",
        STOP,
        &conversation,
        &transcript(&env, &conversation, b"{}\n"),
        &ws,
    )
    .await;

    daemon.sleep_session(pane.id).unwrap();
    let asleep = daemon
        .list()
        .into_iter()
        .find(|info| info.id == pane.id)
        .unwrap();
    assert_eq!(asleep.state, proto::SessionState::Sleeping);
    assert_eq!(
        asleep.latest_prompt.as_deref(),
        Some("Keep this bounded sleep cue")
    );
    assert_eq!(
        asleep.last_agent_message.as_deref(),
        Some("Agent launched in background. Waiting for completion.")
    );
    assert!(asleep.slept_at_ms.is_some());
    assert_eq!(
        handle_in(&env, pane.id).map(|h| h.0),
        Some(conversation.clone())
    );

    let restored = reboot(&env, &daemon);
    let asleep_after_boot = restored
        .list()
        .into_iter()
        .find(|info| info.id == pane.id)
        .unwrap();
    assert_eq!(asleep_after_boot.state, proto::SessionState::Sleeping);
    assert_eq!(asleep_after_boot.latest_prompt, asleep.latest_prompt);
    assert_eq!(
        asleep_after_boot.last_agent_message,
        asleep.last_agent_message
    );
    assert_eq!(asleep_after_boot.context, asleep.context);
    assert!(asleep_after_boot.slept_at_ms.is_some());

    let awake = restored.wake_session(pane.id).unwrap();
    assert_eq!(
        resume_of(&argv_of(&env, awake.id).await).as_deref(),
        Some(conversation.as_str())
    );
    assert!(restored.list().iter().all(|info| info.id != pane.id));
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_a_shell_that_has_detected_claude() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "shell-sleep-refusal");
    let shell = shell_pane(&daemon, &ws);
    let conversation = "00000000-0000-4000-8000-000000000078";
    let transcript = transcript(&env, conversation, b"transcript fixture\n");
    hook(
        &env,
        &daemon,
        shell.id,
        "UserPromptSubmit",
        PROMPT,
        conversation,
        &transcript,
        &ws,
    )
    .await;

    let error = daemon.sleep_session(shell.id).unwrap_err().to_string();
    assert!(error.contains("provider Shell is unsupported"), "{error}");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|info| info.id == shell.id)
            .unwrap()
            .state,
        proto::SessionState::Running
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_pending_stdin_without_blocking_other_panes() {
    let env = setup().await;
    let release = env.state.path().join("release-stdin");
    std::env::set_var("RESUME_BLOCK_STDIN", "1");
    std::env::set_var("RESUME_STDIN_RELEASE", &release);
    let daemon = boot(&env);
    let ws = project(&env, "sleep-pending-stdin");
    let (pane, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    std::env::remove_var("RESUME_BLOCK_STDIN");
    std::env::remove_var("RESUME_STDIN_RELEASE");
    let unrelated = shell_pane(&daemon, &ws);

    let writer_daemon = daemon.clone();
    let session_id = pane.id;
    let writing =
        std::thread::spawn(move || writer_daemon.write_stdin(session_id, &vec![b'x'; 1024 * 1024]));
    let admission_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !daemon.stdin_write_in_progress_for_test(pane.id) {
        if tokio::time::Instant::now() >= admission_deadline {
            std::fs::write(&release, b"release").unwrap();
            writing.join().unwrap().unwrap();
            panic!("stdin delivery was not admitted");
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    let sleeping_daemon = daemon.clone();
    let (refusal_tx, refusal_rx) = std::sync::mpsc::channel();
    let sleeping = std::thread::spawn(move || {
        let _ = refusal_tx.send(sleeping_daemon.sleep_session(session_id));
    });
    let unrelated_daemon = daemon.clone();
    let unrelated_id = unrelated.id;
    let (input_tx, input_rx) = std::sync::mpsc::channel();
    let independent_input = std::thread::spawn(move || {
        let _ = input_tx.send(unrelated_daemon.write_stdin(unrelated_id, b"independent input\n"));
    });
    let refusal = refusal_rx.recv_timeout(Duration::from_secs(2));
    let input = input_rx.recv_timeout(Duration::from_secs(2));
    std::fs::write(&release, b"release").unwrap();
    sleeping.join().unwrap();
    independent_input.join().unwrap();
    writing.join().unwrap().unwrap();
    let error = refusal
        .expect("Sleep must refuse pending stdin without waiting for the PTY writer")
        .unwrap_err()
        .to_string();
    assert!(error.contains("stdin delivery"), "{error}");
    assert!(!daemon.stdin_write_in_progress_for_test(pane.id));
    input
        .expect("pending stdin must not block input to an unrelated pane")
        .unwrap();
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|info| info.id == pane.id)
            .unwrap()
            .state,
        proto::SessionState::Running
    );
    daemon.sleep_session(pane.id).unwrap();
    daemon.close(pane.id).unwrap();
    daemon.close(unrelated.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_timeout_keeps_pty_usable_without_blocking_other_sessions() {
    let env = setup().await;
    std::env::set_var("RESUME_IGNORE_TERM", "1");
    let daemon = boot(&env);
    let ws = project(&env, "sleep-timeout");
    let (pane, conversation, transcript_path) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let unrelated = shell_pane(&daemon, &ws);

    let sleeping_daemon = daemon.clone();
    let session_id = pane.id;
    let started = std::time::Instant::now();
    let sleep = tokio::task::spawn_blocking(move || sleeping_daemon.sleep_session(session_id));
    tokio::time::sleep(Duration::from_millis(250)).await;
    let pending_hook_path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(env.state.path()),
        &HookDrop {
            v: houston_core::hook_drop::DROP_V,
            event: "UserPromptSubmit".into(),
            session: pane.id,
            agent: Some("claude".into()),
            session_id: Some(conversation.clone()),
            transcript_path: Some(transcript_path),
            prompt: Some("This hook must wait for Sleep".into()),
            ..Default::default()
        },
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    daemon.hook_drop_tick_for_test();
    assert!(
        pending_hook_path.exists(),
        "hooks for a sleeping session must be retried"
    );
    let same_session_write = daemon
        .write_stdin(pane.id, b"wait for Sleep")
        .unwrap_err()
        .to_string();
    assert!(
        same_session_write.contains("Sleep transition"),
        "{same_session_write}"
    );
    let kill = daemon.kill(pane.id).unwrap_err().to_string();
    assert!(kill.contains("Sleep transition"), "{kill}");
    let close = daemon.close(pane.id).unwrap_err().to_string();
    assert!(close.contains("Sleep transition"), "{close}");
    let wake = daemon.wake_session(pane.id).unwrap_err().to_string();
    assert!(wake.contains("Sleep transition"), "{wake}");
    let input_started = std::time::Instant::now();
    daemon
        .write_stdin(unrelated.id, b"independent input\n")
        .unwrap();
    assert!(input_started.elapsed() < Duration::from_secs(1));

    let error = sleep.await.unwrap().unwrap_err().to_string();
    daemon.hook_drop_tick_for_test();
    assert!(
        !pending_hook_path.exists(),
        "the retried hook should apply after Sleep releases"
    );
    assert!(error.contains("timed out after 15 seconds"), "{error}");
    assert!(started.elapsed() >= Duration::from_secs(15));
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|session| session.id == pane.id)
            .unwrap()
            .state,
        proto::SessionState::Running
    );
    assert_eq!(
        handle_in(&env, pane.id).map(|handle| handle.0),
        Some(conversation)
    );
    daemon
        .write_stdin(pane.id, b"usable after timeout\n")
        .unwrap();
    daemon.close(pane.id).unwrap();
    daemon.close(unrelated.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_an_external_running_descendant() {
    let env = setup().await;
    std::env::set_var("RESUME_FAKE_DESCENDANT", "1");
    let daemon = boot(&env);
    let ws = project(&env, "sleep-descendant-refusal");
    let (pane, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;

    let error = daemon.sleep_session(pane.id).unwrap_err().to_string();
    assert!(
        error.contains("external child processes are still running"),
        "{error}"
    );
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|session| session.id == pane.id)
            .unwrap()
            .state,
        proto::SessionState::Running
    );
    daemon.close(pane.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_missing_resume_handle_and_a_busy_agent() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "sleep-eligibility-refusal");
    let pane = claude_pane(&daemon, &ws, None);
    argv_of(&env, pane.id).await;

    let missing = daemon.sleep_session(pane.id).unwrap_err().to_string();
    assert!(
        missing.contains("no validated conversation handle"),
        "{missing}"
    );
    daemon.close(pane.id).unwrap();

    let (pane, conversation, path) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let mut busy_prompt: Value =
        serde_json::from_str(&fixture(PROMPT, &conversation, &path, &ws)).unwrap();
    busy_prompt["prompt_id"] = "resume-wire-sleep-busy".into();
    let drop = run_hook("UserPromptSubmit", pane.id, busy_prompt.to_string()).await;
    apply_drop(&env, &daemon, drop).await;
    let busy = daemon.sleep_session(pane.id).unwrap_err().to_string();
    assert!(busy.contains("agent status is not idle"), "{busy}");
    daemon.close(pane.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_a_routine_run_pane() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "sleep-routine-refusal");
    let proto::ServerMsg::Routines { routines, .. } = daemon
        .routine_create_for_test(
            "sleep-refusal",
            "do the thing",
            proto::Cadence::Interval { seconds: 86_400 },
            Some(ws.display().to_string()),
            proto::AgentKind::Claude,
            None,
            None,
        )
        .unwrap()
    else {
        panic!("routine_create answers Routines");
    };
    daemon.set_routine_pane_cmd_for_test(vec![shim_dir().join("claude").display().to_string()]);
    daemon.routine_run_now(routines[0].id).unwrap();
    let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(routines[0].id))
    else {
        panic!("routine_runs_list answers RoutineRuns");
    };
    let pane_id = runs[0].session_id.expect("routine run opened a pane");
    argv_of(&env, pane_id).await;

    let error = daemon.sleep_session(pane_id).unwrap_err().to_string();
    assert!(
        error.contains("custom-command, routine, and harness sessions are unsupported"),
        "{error}"
    );
    daemon.close(pane_id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn sleep_refuses_an_orchestration_child_session() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "sleep-child-refusal");
    daemon.orchestration_set(true).unwrap();
    let (parent, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let child = daemon
        .orchestrate_spawn(
            parent.id,
            proto::AgentKind::Claude,
            None,
            None,
            "sleep refusal child".to_string().into(),
            Some(false),
            None,
            Some("sleep-refusal-child".into()),
        )
        .unwrap();
    argv_of(&env, child.id).await;

    let error = daemon.sleep_session(child.id).unwrap_err().to_string();
    assert!(
        error.contains("orchestration child sessions must be closed through their parent"),
        "{error}"
    );
    daemon.close(parent.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn wake_with_an_expired_transcript_keeps_the_placeholder_and_never_starts_fresh() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "expired-sleep");
    let (pane, conversation, path) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    daemon.sleep_session(pane.id).unwrap();
    std::fs::remove_file(path).unwrap();

    let error = daemon.wake_session(pane.id).unwrap_err().to_string();
    assert!(error.contains("Wake refused"), "{error}");
    assert!(error.contains("Choose fresh explicitly"), "{error}");
    let retained = daemon
        .list()
        .into_iter()
        .find(|info| info.id == pane.id)
        .unwrap();
    assert_eq!(retained.state, proto::SessionState::Sleeping);
    assert!(retained
        .sleep_notice
        .as_deref()
        .is_some_and(|notice| notice.contains("Wake refused")));
    assert_eq!(handle_in(&env, pane.id).map(|h| h.0), Some(conversation));
    assert_eq!(
        daemon.list().len(),
        1,
        "Wake validation must not spawn a fresh pane"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn an_early_wake_exit_returns_to_sleep_without_a_fresh_fallback() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "wake-early-exit");
    let (pane, conversation, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    daemon.sleep_session(pane.id).unwrap();
    std::env::set_var("RESUME_FAKE_EXIT", "1");

    let waking = daemon.wake_session(pane.id).unwrap();
    assert_eq!(
        resume_of(&argv_of(&env, waking.id).await).as_deref(),
        Some(conversation.as_str())
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(info) = daemon.list().into_iter().find(|info| info.id == waking.id) {
            if info.state == proto::SessionState::Sleeping {
                assert!(info
                    .sleep_notice
                    .as_deref()
                    .is_some_and(|notice| notice.contains("Wake failed")));
                assert_eq!(
                    handle_in(&env, waking.id).map(|handle| handle.0),
                    Some(conversation)
                );
                assert_eq!(
                    daemon.list().len(),
                    1,
                    "an early Wake error must not launch a fresh session"
                );
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "failed Wake did not return to Sleep"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn start_fresh_over_the_wire_drops_the_handle() {
    let env = setup().await;
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    let ws = project(&env, "ws");
    let (live, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;

    let restarted = respawn_over_the_wire(addr, live.id, Some(true)).await;
    assert_eq!(resume_of(&argv_of(&env, restarted.id).await), None);
    assert!(!restarted.resumable);
    assert_eq!(handle_in(&env, restarted.id), None);
}

#[tokio::test]
async fn a_pane_left_by_a_crash_automatically_restores_its_exact_conversation() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-crash", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-crash", Some(&path))));

    let daemon = boot(&env);
    let restored = restored_from(&daemon.list(), 5).clone();
    assert_eq!(restored.restore_deferred, None);
    assert!(restored.resumable);
    assert_eq!(
        resume_of(&argv_of(&env, restored.id).await).as_deref(),
        Some("conv-crash")
    );
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::Text(serde_json::to_string(msg).unwrap().into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn restore_resume_defaults_on_and_persists() {
    let env = setup().await;
    let host = |d: &Daemon| match d.host_info() {
        proto::ServerMsg::HostInfo { restore_resume, .. } => restore_resume,
        other => panic!("host_info answers HostInfo, not {other:?}"),
    };
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    assert!(host(&daemon), "on by default");

    let mut ws = connect_and_hello(addr, TOKEN).await;
    send(
        &mut ws,
        &proto::ClientMsg::RestoreResumeSet { enabled: false },
    )
    .await;
    let broadcast = loop {
        if let proto::ServerMsg::HostInfo { restore_resume, .. } = next_control(&mut ws).await {
            break restore_resume;
        }
    };
    assert!(
        !broadcast,
        "restore_resume_set answers with host_info carrying the new value"
    );
    assert!(!host(&daemon));
    assert!(!host(&boot(&env)), "the choice survives a restart");
}

#[tokio::test]
async fn a_live_pane_broadcasts_when_it_gains_and_loses_its_handle() {
    let env = setup().await;
    let daemon = boot(&env);
    let addr = serve(&daemon).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let ws_dir = project(&env, "ws");
    let (pane, _, _) = pane_with_a_turn(&env, &daemon, &ws_dir, None).await;
    let resumable_of = |msg: proto::ServerMsg| match msg {
        proto::ServerMsg::SessionResumable { session, resumable } if session == pane.id => {
            Some(resumable)
        }
        _ => None,
    };
    let gained = loop {
        if let Some(r) = resumable_of(next_control(&mut ws).await) {
            break r;
        }
    };
    assert!(gained, "the first turn broadcasts resumable: true");

    daemon.kill(pane.id).unwrap();
    let lost = loop {
        if let Some(r) = resumable_of(next_control(&mut ws).await) {
            break r;
        }
    };
    assert!(!lost, "a kill broadcasts resumable: false");
}

#[tokio::test]
async fn routine_and_harness_panes_never_resume() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let proto::ServerMsg::Routines { routines, .. } = daemon
        .routine_create_for_test(
            "nightly",
            "do the thing",
            proto::Cadence::Interval { seconds: 86_400 },
            Some(ws.display().to_string()),
            proto::AgentKind::Claude,
            None,
            None,
        )
        .unwrap()
    else {
        panic!("routine_create answers Routines");
    };
    let plain = routines[0].id;
    let proto::ServerMsg::Routines { routines, .. } = daemon
        .harness_routine_create(
            &ws.display().to_string(),
            proto::AgentKind::Claude,
            None,
            None,
            proto::Cadence::Interval { seconds: 86_400 },
            false,
        )
        .unwrap()
    else {
        panic!("harness_routine_create answers Routines");
    };
    let review = routines
        .iter()
        .find(|r| r.name.starts_with("Harness review"))
        .unwrap()
        .id;
    let cli = shim_dir().join("claude").display().to_string();
    let mut panes = Vec::new();
    for (routine, conversation) in [(plain, "routine-conv"), (review, "review-conv")] {
        daemon.set_routine_pane_cmd_for_test(vec![cli.clone()]);
        daemon.routine_run_now(routine).unwrap();
        let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(routine)) else {
            panic!("routine_runs_list answers RoutineRuns");
        };
        let pane = runs[0].session_id.expect("the run opened a pane");
        argv_of(&env, pane).await;
        let path = transcript(&env, conversation, b"{}\n");
        hook(
            &env,
            &daemon,
            pane,
            "SessionStart",
            START,
            conversation,
            &path,
            &ws,
        )
        .await;
        hook(
            &env,
            &daemon,
            pane,
            "UserPromptSubmit",
            PROMPT,
            conversation,
            &path,
            &ws,
        )
        .await;
        assert_eq!(
            native_in(&env, pane).as_deref(),
            Some(conversation),
            "the turn carried the pane's root id"
        );
        assert_eq!(handle_in(&env, pane), None, "{conversation}");
        panes.push(pane);
    }

    let after = reboot(&env, &daemon);
    let sessions = after.list();
    for pane in panes {
        let restored = restored_from(&sessions, pane);
        assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
    }
}

#[tokio::test]
async fn a_resumed_pane_keeps_its_id_through_a_resume_hook() {
    let env = setup().await;
    let ws = project(&env, "ws");
    let path = transcript(&env, "conv-r", b"{}\n");
    seed_claude(&env, 5, &ws, &ws, Some(("conv-r", Some(&path))));
    clean_shutdown(&env);

    let daemon = boot(&env);
    let restored = restored_from(&daemon.list(), 5).clone();
    assert_eq!(native_in(&env, restored.id).as_deref(), Some("conv-r"));
    hook(
        &env,
        &daemon,
        restored.id,
        "SessionStart",
        RESUMED,
        "conv-r",
        &path,
        &ws,
    )
    .await;
    hook(
        &env,
        &daemon,
        restored.id,
        "UserPromptSubmit",
        PROMPT,
        "conv-r",
        &path,
        &ws,
    )
    .await;
    assert_eq!(
        handle_in(&env, restored.id),
        Some(("conv-r".to_string(), Some(path)))
    );
}

#[tokio::test]
async fn a_late_stop_after_kill_does_not_recreate_the_resume_handle() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let (pane, conversation, path) = pane_with_a_turn(&env, &daemon, &ws, None).await;
    let pending = run_hook("Stop", pane.id, fixture(STOP, &conversation, &path, &ws)).await;

    daemon.kill(pane.id).unwrap();
    wait_for_state(&daemon, pane.id, proto::SessionState::Killed).await;
    assert_eq!(handle_in(&env, pane.id), None);
    apply_drop(&env, &daemon, pending).await;
    assert_eq!(
        handle_in(&env, pane.id),
        None,
        "a queued Stop must not undo Kill"
    );
}

#[tokio::test]
async fn a_second_restart_does_not_resume_in_a_relocated_folder() {
    for resume_on_restore in [true, false] {
        let env = setup().await;
        let ws = project(&env, "ws");
        let sub = ws.join("worktree");
        std::fs::create_dir_all(&sub).unwrap();
        let path = transcript(&env, "conv-cwd", b"{}\n");
        seed_claude(&env, 5, &ws, &sub, Some(("conv-cwd", Some(&path))));
        Db::open(&env.db_path())
            .unwrap()
            .set_setting("restore_resume", if resume_on_restore { "1" } else { "0" })
            .unwrap();
        std::fs::remove_dir(&sub).unwrap();
        clean_shutdown(&env);

        let daemon = boot(&env);
        let restored = restored_from(&daemon.list(), 5).clone();
        assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
        assert_eq!(restored.cwd, ws.display().to_string());
        let next = daemon
            .respawn(restored.id, false, None, None, true)
            .unwrap();
        assert_eq!(
            resume_of(&argv_of(&env, next.id).await),
            None,
            "restore_resume={resume_on_restore}: a second restart must not resume the worktree conversation in the workspace"
        );
        assert!(!restored.resumable);
        assert_eq!(handle_in(&env, next.id), None);
    }
}

#[tokio::test]
async fn a_second_restart_does_not_resume_on_a_deleted_profiles_default_account() {
    for resume_on_restore in [true, false] {
        let env = setup().await;
        let daemon = boot(&env);
        daemon.set_restore_resume(resume_on_restore).unwrap();
        let ws = project(&env, "ws");
        let work = env.state.path().join("work-config").display().to_string();
        let profile = upsert_profile(&daemon, "work", &work);
        let (pane, _, _) = pane_with_a_turn(&env, &daemon, &ws, Some(profile)).await;
        daemon.agent_profile_delete(profile).unwrap();

        let after = reboot(&env, &daemon);
        let restored = restored_from(&after.list(), pane.id).clone();
        assert_eq!(resume_of(&argv_of(&env, restored.id).await), None);
        assert_eq!(restored.profile_label, None);
        let next = after.respawn(restored.id, false, None, None, true).unwrap();
        assert_eq!(
            resume_of(&argv_of(&env, next.id).await),
            None,
            "restore_resume={resume_on_restore}: a second restart must not resume the profile conversation on the default account"
        );
        assert!(!restored.resumable);
        assert_eq!(handle_in(&env, next.id), None);
    }
}

#[tokio::test]
async fn restarting_in_another_existing_folder_discards_the_previous_conversation() {
    let env = setup().await;
    let daemon = boot(&env);
    let ws = project(&env, "ws");
    let other = project(&env, "other");
    let (pane, _, _) = pane_with_a_turn(&env, &daemon, &ws, None).await;

    let moved = daemon
        .respawn(pane.id, false, Some(other.clone()), None, true)
        .unwrap();
    assert_eq!(resume_of(&argv_of(&env, moved.id).await), None);
    assert!(!moved.resumable);
    let notice = moved.resume_notice.expect("the changed folder says why");
    assert!(
        notice.contains(&ws.display().to_string()) && notice.contains(&other.display().to_string()),
        "{notice}"
    );
    assert!(!notice.contains("no longer exists"), "{notice}");

    let next = daemon.respawn(moved.id, false, None, None, true).unwrap();
    assert_eq!(resume_of(&argv_of(&env, next.id).await), None);
    assert_eq!(handle_in(&env, next.id), None);
}

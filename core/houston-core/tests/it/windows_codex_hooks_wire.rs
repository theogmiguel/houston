#![cfg(windows)]
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

use crate::common;
use houston_core::agent_hooks::{self, CodexHookTrust, ConfigHome};
use houston_core::claude_hooks::{executable_launcher, point_launcher, sentinel_for};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::hook_drop::{drop_dir, parse_drop_name};
use houston_protocol::AgentKind;
use serde_json::{json, Value};
use std::io::Write as _;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Output, Stdio};

const CHANNEL: &str = "wincodexhooks";
// The daemon installation fixture changes process-wide configuration directories.
static CONFIG_ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct ConfigEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl ConfigEnvironment {
    fn isolated(home: &Path) -> Self {
        let names = [
            "HOME",
            "USERPROFILE",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
        ];
        let saved = names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect();
        for name in names {
            let value = match name {
                "CODEX_HOME" => home.join(".codex"),
                "CLAUDE_CONFIG_DIR" => home.join(".claude"),
                "XDG_CONFIG_HOME" => home.join(".config"),
                _ => home.to_path_buf(),
            };
            std::env::set_var(name, value);
        }
        Self(saved)
    }
}

impl Drop for ConfigEnvironment {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

#[test]
fn codex_consent_and_startup_prepare_the_launcher_with_claude_hooks_disabled() {
    let _serial = CONFIG_ENVIRONMENT.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let state = home.join(format!(".houston-{CHANNEL}"));
    std::fs::create_dir_all(&state).unwrap();
    let _environment = ConfigEnvironment::isolated(&home);
    let daemon = Daemon::new(DaemonConfig::new(
        "windows-codex-launcher-test".into(),
        state.join("test.db"),
        common::base_env(),
    ))
    .unwrap();
    daemon.agent_hooks_set(AgentKind::Claude, false);
    assert!(!daemon.hook_consent(AgentKind::Claude));
    let launcher = executable_launcher(&houston_core::claude_hooks::launcher_path(&state));
    daemon.agent_hooks_set(AgentKind::Codex, true);
    assert!(
        launcher.is_file(),
        "Codex consent must prepare its own native launcher"
    );
    houston_core::claude_hooks::wait_for_launcher_prewarm();
    std::fs::remove_file(&launcher).unwrap();
    daemon.install_consented_agent_hooks();
    assert!(
        launcher.is_file(),
        "startup must restore the consented Codex launcher"
    );
    assert!(!daemon.hook_consent(AgentKind::Claude));
}

fn run_hook(command: &str, home: &Path, session: Option<u32>, input: &str) -> Output {
    let mut process = houston_core::spawn::command("cmd.exe");
    process.env_clear();
    for name in [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SystemDrive",
        "windir",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            process.env(name, value);
        }
    }
    // Codex passes the whole hook command as one raw, quoted cmd.exe argument.
    process
        .args(["/C"])
        .raw_arg(format!("\"{command}\""))
        .env("USERPROFILE", home)
        .env("HOUSTON_CHANNEL", CHANNEL)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(session) = session {
        process.env("TR_SESSION", session.to_string());
    }
    let mut child = process.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn run_powershell_hook(command: &str, home: &Path, session: Option<u32>, input: &str) -> Output {
    let mut process = houston_core::spawn::command("powershell.exe");
    process.env_clear();
    for name in [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SystemDrive",
        "windir",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            process.env(name, value);
        }
    }
    process
        .args(["-NoProfile", "-NonInteractive", "-Command", command])
        .env("USERPROFILE", home)
        .env("HOUSTON_CHANNEL", CHANNEL)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(session) = session {
        process.env("TR_SESSION", session.to_string());
    }
    let mut child = process.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn drops(state: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(drop_dir(state)) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .filter(|entry| parse_drop_name(&entry.file_name().to_string_lossy()).is_some())
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .collect()
}

#[test]
fn installed_codex_hooks_deliver_events_through_cmd_and_survive_refresh() {
    let _serial = CONFIG_ENVIRONMENT.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jo's Home (ação) & code");
    let state = home.join(format!(".houston-{CHANNEL}"));
    let config_home = ConfigHome {
        home: home.clone(),
        xdg_config: None,
    };
    let launcher = point_launcher(&state, Path::new(env!("CARGO_BIN_EXE_tr-helper"))).unwrap();
    let sentinel = sentinel_for(Some(CHANNEL));
    let hooks = agent_hooks::install(AgentKind::Codex, &config_home, &launcher, &sentinel).unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status_at(&hooks, &sentinel),
        CodexHookTrust::SomeTrusted
    );
    let original = std::fs::read(&hooks).unwrap();
    agent_hooks::install(AgentKind::Codex, &config_home, &launcher, &sentinel).unwrap();
    assert_eq!(std::fs::read(&hooks).unwrap(), original);
    let written: Value = serde_json::from_slice(&original).unwrap();
    let groups = written["hooks"].as_object().unwrap();
    let command_of = |event: &str| groups[event][0]["hooks"][0]["command"].as_str().unwrap();
    let input = |event: &str| {
        json!({
            "session_id": "codex-native-thread",
            "hook_event_name": event,
            "cwd": home,
            "prompt": "Preserve ação and quoted paths",
        })
        .to_string()
    };
    let outside = run_hook(
        command_of("SessionStart"),
        &home,
        None,
        &input("SessionStart"),
    );
    assert!(
        outside.status.success(),
        "outside Houston: {}",
        String::from_utf8_lossy(&outside.stderr)
    );
    assert!(drops(&state).is_empty());

    let powershell = run_powershell_hook(
        command_of("SessionStart"),
        &home,
        Some(42),
        &input("SessionStart"),
    );
    assert!(
        powershell.status.success(),
        "PowerShell: {}",
        String::from_utf8_lossy(&powershell.stderr)
    );
    let powershell_drops = drops(&state);
    assert_eq!(
        powershell_drops.len(),
        1,
        "PowerShell command {}: stdout={} stderr={}",
        command_of("SessionStart"),
        String::from_utf8_lossy(&powershell.stdout),
        String::from_utf8_lossy(&powershell.stderr)
    );
    assert_eq!(powershell_drops[0]["cwd"], home.to_string_lossy().as_ref());
    assert_eq!(powershell_drops[0]["session"], 42);
    for entry in std::fs::read_dir(drop_dir(&state)).unwrap().flatten() {
        std::fs::remove_file(entry.path()).unwrap();
    }

    for event in groups.keys() {
        let output = run_hook(command_of(event), &home, Some(42), &input(event));
        assert!(
            output.status.success(),
            "{event} through cmd.exe: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let delivered = drops(&state);
    assert_eq!(delivered.len(), groups.len());
    for drop in &delivered {
        assert_eq!(drop["session"], 42);
        assert_eq!(drop["agent"], "codex");
        assert_eq!(drop["cwd"], home.to_string_lossy().as_ref());
    }
    let mut events: Vec<_> = delivered
        .iter()
        .map(|drop| drop["event"].as_str().unwrap())
        .collect();
    events.sort_unstable();
    assert_eq!(
        events,
        groups.keys().map(String::as_str).collect::<Vec<_>>()
    );

    houston_core::claude_hooks::wait_for_launcher_prewarm();
    std::fs::remove_file(executable_launcher(&launcher)).unwrap();
    let missing = run_hook(
        command_of("SessionStart"),
        &home,
        Some(43),
        &input("SessionStart"),
    );
    assert!(missing.status.success());
    assert!(missing.stderr.is_empty());
    assert_eq!(drops(&state).len(), delivered.len());
}

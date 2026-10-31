//! Removes a channel's v1 `--houston-managed` hook and MCP entries from the agent CLIs'
//! configs, with v1's own uninstall rules; Codex and ZCode exec the v1 launcher directly.
//! The channel directory is only read: a live v1 daemon there reinstalls them at boot.

mod claude_mcp;
mod files;
mod providers;
mod v1_daemon;
mod zcode;

use crate::sys::host_env::HostEnv;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Guards the host's call: the cleanup runs once per host process.
pub static HOST_START: AtomicBool = AtomicBool::new(false);

/// Where one channel's v1 entries live.
#[derive(Debug, Clone)]
pub struct Target {
    home: PathBuf,
    xdg_config: Option<PathBuf>,
    claude_config_dir: Option<PathBuf>,
    channel: Option<String>,
    channel_dir: PathBuf,
    env: HostEnv,
}

impl Target {
    /// `channel` is `None` for release. `env` supplies `XDG_CONFIG_HOME`,
    /// `CLAUDE_CONFIG_DIR` and the `PATH` the `claude` CLI is resolved from.
    pub fn from_env(env: &HostEnv, home: &Path, channel: Option<&str>) -> Self {
        let dir = |name: &str| {
            env.var_os(name)
                .filter(|value| !value.to_string_lossy().trim().is_empty())
                .map(PathBuf::from)
        };
        Self {
            home: home.to_path_buf(),
            xdg_config: dir("XDG_CONFIG_HOME"),
            claude_config_dir: dir("CLAUDE_CONFIG_DIR"),
            channel: channel.map(str::to_string),
            channel_dir: crate::sys::paths::dir_for(home, channel),
            env: env.clone(),
        }
    }
}

/// What one run did. Every `log` line is also written to the host log.
#[derive(Debug, Default)]
pub struct Outcome {
    pub changed: Vec<PathBuf>,
    pub log: Vec<String>,
    pub stood_down: bool,
}

impl Outcome {
    fn note(&mut self, line: String) {
        tracing::info!("v1 cleanup: {line}");
        self.log.push(line);
    }

    fn apply(&mut self, path: PathBuf, result: anyhow::Result<bool>) {
        match result {
            Ok(false) => {}
            Ok(true) => {
                self.note(format!(
                    "removed this channel's v1 Houston entries from {}",
                    path.display()
                ));
                self.changed.push(path);
            }
            Err(e) => self.note(format!("left {} unchanged: {e:#}", path.display())),
        }
    }
}

/// One provider file's removal: whether it changed the file, or why it was left.
type Remover = fn(&Path, &str) -> anyhow::Result<bool>;

/// v1's sentinel stem; a channel's is `--houston-managed=<channel>`.
const SENTINEL: &str = "--houston-managed";

pub fn run(target: &Target) -> Outcome {
    let mut outcome = Outcome::default();
    if let Some((pid, record)) = v1_daemon::running(&target.channel_dir) {
        outcome.stood_down = true;
        outcome.note(format!(
            "stood down: houston-core (pid {pid}, named by {}) still runs this channel's v1 \
             daemon, which reinstalls its entries at boot; no agent CLI config was changed",
            record.display()
        ));
        return outcome;
    }
    let sentinel = match &target.channel {
        None => SENTINEL.to_string(),
        Some(c) => format!("{SENTINEL}={c}"),
    };
    let home = &target.home;
    let claude_dir = target
        .claude_config_dir
        .clone()
        .unwrap_or_else(|| home.join(".claude"));
    let codex = home.join(".codex");
    let config = target
        .xdg_config
        .clone()
        .unwrap_or_else(|| home.join(".config"));
    let steps: Vec<(PathBuf, Remover)> = vec![
        (claude_dir.join("settings.json"), providers::claude_settings),
        (codex.join("hooks.json"), providers::nested_hooks),
        (codex.join("config.toml"), providers::codex_config),
        (
            config
                .join("opencode")
                .join("plugins")
                .join("houston-notify.js"),
            providers::opencode,
        ),
        (
            home.join(".gemini").join("config").join("hooks.json"),
            providers::antigravity,
        ),
    ];
    for (path, step) in steps {
        let result = step(&path, &sentinel);
        outcome.apply(path, result);
    }
    let channel_dir_name = target
        .channel_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    for path in zcode::settings_files(home) {
        let result = zcode::uninstall(&path, &sentinel, &channel_dir_name);
        outcome.apply(path, result);
    }
    let claude_json = target
        .claude_config_dir
        .clone()
        .unwrap_or_else(|| home.clone())
        .join(".claude.json");
    match other_channel_daemon(target) {
        Some((pid, record)) if claude_json.exists() => outcome.note(format!(
            "left the shared v1 Claude MCP entry `houston`: houston-core (pid {pid}, named by \
             {}) of another channel still uses it",
            record.display()
        )),
        _ => {
            if let Some(line) = claude_mcp::remove(&claude_json, &target.env) {
                outcome.note(line);
            }
        }
    }
    outcome
}

/// A live v1 daemon of another channel (`~/.houston` or `~/.houston-<name>`), which still
/// uses the Claude MCP entry every channel shares.
fn other_channel_daemon(target: &Target) -> Option<(u32, PathBuf)> {
    std::fs::read_dir(&target.home)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| *dir != target.channel_dir)
        .filter(|dir| {
            dir.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == ".houston" || n.starts_with(".houston-"))
        })
        .find_map(|dir| v1_daemon::running(&dir))
}

/// Runs the cleanup on its own thread the first time `guard` is passed; later calls
/// return `None`.
pub fn start(
    guard: &'static AtomicBool,
    target: Target,
) -> Option<std::thread::JoinHandle<Outcome>> {
    if guard.swap(true, Ordering::SeqCst) {
        return None;
    }
    std::thread::Builder::new()
        .name("v1-cleanup".to_string())
        .spawn(move || run(&target))
        .map_err(|e| tracing::warn!("v1 cleanup: could not start its thread: {e}"))
        .ok()
}

#[cfg(test)]
mod fixtures;

#[cfg(test)]
use fixtures::*;

#[test]
fn removes_each_provider_block_keeps_user_bytes() {
    let home = TestHome::new();
    home.install_all(&[DEV]);
    let outcome = run(&home.target(Some("dev")));
    assert!(!outcome.stood_down, "{:?}", outcome.log);
    for provider in PROVIDERS {
        home.assert_only(provider, &[]);
    }
    assert!(
        !home.opencode_plugin().exists(),
        "OpenCode's Houston plugin file is Houston's alone and leaves whole"
    );
    assert_eq!(
        home.read(&home.opencode_user_plugin()),
        OPENCODE_USER_PLUGIN,
        "a user's own OpenCode plugin stays"
    );
    assert_eq!(
        sorted(&outcome.changed),
        home.managed_files(),
        "{:?}",
        outcome.log
    );
}

#[test]
fn other_channel_block_stays() {
    let home = TestHome::new();
    home.install_all(&[RELEASE, DEV]);
    run(&home.target(Some("dev")));
    for provider in PROVIDERS {
        home.assert_only(provider, &[RELEASE]);
    }

    // Release's sentinel is a prefix of every channel's: its cleanup keeps dev's entries.
    let home = TestHome::new();
    home.install_all(&[RELEASE, DEV]);
    let dev_before = home.sentinel_count(DEV);
    assert!(dev_before > 0 && home.sentinel_count(RELEASE) > 0);
    run(&home.target(None));
    assert_eq!(home.sentinel_count(DEV), dev_before);
    assert_eq!(home.sentinel_count(RELEASE), 0);
}

#[test]
fn config_without_block_is_untouched() {
    let home = TestHome::new();
    home.install_all(&[]);
    home.age_everything();
    let before = home.snapshot();
    let outcome = run(&home.target(Some("dev")));
    assert_eq!(home.snapshot(), before, "{:?}", outcome.log);
    assert!(outcome.changed.is_empty(), "{:?}", outcome.changed);
}

#[test]
fn unparsable_config_is_left_and_logged() {
    let home = TestHome::new();
    home.install_all(&[DEV]);
    let broken = home.claude_settings();
    let text = format!("{{ \"hooks\": {} --houston-managed=dev", "{");
    std::fs::write(&broken, &text).expect("write broken settings");
    let outcome = run(&home.target(Some("dev")));
    assert_eq!(
        home.read(&broken),
        text,
        "an unparsable file keeps its bytes"
    );
    for provider in PROVIDERS.into_iter().filter(|p| *p != Provider::Claude) {
        home.assert_only(provider, &[]);
    }
    let shown = broken.display().to_string();
    let lines: Vec<&String> = outcome
        .log
        .iter()
        .filter(|line| line.contains(&shown))
        .collect();
    assert_eq!(lines.len(), 1, "one line names the file: {:?}", outcome.log);
    assert!(
        lines[0].contains("not valid JSON") && lines[0].contains("line 1"),
        "the line carries the parse error: {}",
        lines[0]
    );
}

#[test]
fn second_run_changes_nothing() {
    let home = TestHome::new();
    home.install_all(&[RELEASE, DEV]);
    let target = home.target(Some("dev"));
    run(&target);
    home.age_everything();
    let after_first = home.snapshot();
    let second = run(&target);
    assert_eq!(home.snapshot(), after_first, "{:?}", second.log);
    assert!(second.changed.is_empty(), "{:?}", second.changed);
}

#[test]
fn claude_mcp_entry_removed_through_cli() {
    let home = TestHome::new();
    home.write_claude_mcp_entry();
    let before = home.read(&home.claude_json());
    let bin = home.fake_claude();
    let outcome = run(&home.target_with_path(Some("dev"), &bin));
    let calls = home.fake_claude_calls(&bin);
    assert_eq!(
        calls,
        vec!["mcp remove --scope user houston".to_string()],
        "{:?}",
        outcome.log
    );
    assert_eq!(
        home.read(&home.claude_json()),
        before,
        "Houston never writes ~/.claude.json itself"
    );
    assert!(
        outcome.log.iter().any(|l| l.contains("claude mcp remove")),
        "{:?}",
        outcome.log
    );
}

#[test]
fn missing_claude_cli_leaves_registration() {
    let home = TestHome::new();
    home.write_claude_mcp_entry();
    let before = home.read(&home.claude_json());
    let empty = home.root().join("empty-path");
    std::fs::create_dir_all(&empty).expect("empty PATH dir");
    let outcome = run(&home.target_with_path(Some("dev"), &empty));
    assert_eq!(home.read(&home.claude_json()), before);
    let lines: Vec<&String> = outcome
        .log
        .iter()
        .filter(|line| line.contains("`claude`") && line.contains("PATH"))
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "one line names the missing CLI: {:?}",
        outcome.log
    );
}

#[test]
fn live_v1_daemon_stands_down() {
    // No daemon.json, a dead PID and a live PID of another program: the cleanup runs.
    let dead = exited_pid();
    let scratch = tempfile::tempdir().expect("scratch dir");
    let other = FakeDaemon::spawn(scratch.path(), "other-program");
    for record in [None, Some(dead), Some(other.pid())] {
        let home = TestHome::new();
        home.install_all(&[DEV]);
        if let Some(pid) = record {
            home.write_daemon_json(Some("dev"), pid);
        }
        let outcome = run(&home.target(Some("dev")));
        assert!(!outcome.stood_down, "pid {record:?}: {:?}", outcome.log);
        home.assert_only(Provider::Codex, &[]);
    }

    // A live houston-core named by the channel's daemon.json: nothing changes.
    let home = TestHome::new();
    home.install_all(&[DEV]);
    let daemon = FakeDaemon::spawn(&home.root().join("fake-daemon"), "houston-core");
    home.write_daemon_json(Some("dev"), daemon.pid());
    let before = home.snapshot();
    let outcome = run(&home.target(Some("dev")));
    assert!(outcome.stood_down);
    assert_eq!(home.snapshot(), before, "{:?}", outcome.log);
    let named: Vec<&String> = outcome
        .log
        .iter()
        .filter(|line| line.contains(&daemon.pid().to_string()))
        .collect();
    assert_eq!(named.len(), 1, "one line names the PID: {:?}", outcome.log);
}

#[test]
fn host_start_runs_cleanup_once() {
    static GUARD: AtomicBool = AtomicBool::new(false);
    let home = TestHome::new();
    home.install_all(&[DEV]);
    let first = start(&GUARD, home.target(Some("dev"))).expect("the first start runs");
    assert_ne!(first.thread().id(), std::thread::current().id());
    assert_eq!(first.thread().name(), Some("v1-cleanup"));
    assert!(
        start(&GUARD, home.target(Some("dev"))).is_none(),
        "a second start in the same host process runs nothing"
    );
    let outcome = first.join().expect("cleanup thread");
    assert_eq!(
        sorted(&outcome.changed),
        home.managed_files(),
        "{:?}",
        outcome.log
    );
    home.assert_only(Provider::Codex, &[]);
}

#[test]
fn v1_state_dir_untouched() {
    let home = TestHome::new();
    home.install_all(&[DEV]);
    let channel_dir = home.channel_dir(Some("dev"));
    home.write_daemon_json(Some("dev"), exited_pid());
    std::fs::write(channel_dir.join("houston.db"), b"SQLite format 3\0v1").expect("db");
    std::fs::create_dir_all(channel_dir.join("bin")).expect("bin");
    std::fs::write(channel_dir.join("bin").join("claude-hook"), b"#!/bin/sh\n").expect("hook");
    home.age_everything();
    // Read-only: an open for writing, or a delete on Windows, fails instead of passing.
    set_readonly_tree(&channel_dir, true);
    let before = snapshot_of(&channel_dir);
    let outcome = run(&home.target(Some("dev")));
    let after = snapshot_of(&channel_dir);
    set_readonly_tree(&channel_dir, false);
    assert_eq!(
        sorted(&outcome.changed),
        home.managed_files(),
        "{:?}",
        outcome.log
    );
    let outside_v2 = |snap: &Snapshot| -> Snapshot {
        snap.iter()
            .filter(|(path, _)| !path.starts_with(channel_dir.join("v2")))
            .map(|(p, v)| (p.clone(), v.clone()))
            .collect()
    };
    assert_eq!(outside_v2(&after), outside_v2(&before));
}

//! Removes a channel's v1 `--houston-managed` hook and MCP entries from the agent CLIs'
//! configs, with v1's own uninstall rules; Codex and ZCode exec the v1 launcher directly.
//! The channel directory is only read: a live v1 daemon there reinstalls them at boot.

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

pub fn run(target: &Target) -> Outcome {
    let _ = target;
    Outcome::default()
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
        .spawn(move || {
            let _ = target;
            Outcome::default()
        })
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
    for record in [None, Some(dead), Some(std::process::id())] {
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
    let daemon = FakeDaemon::spawn(&home.root().join("fake-daemon"));
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

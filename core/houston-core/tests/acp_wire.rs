#![cfg(unix)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::db::Db;
use houston_protocol as proto;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        #[cfg(windows)]
        {
            let ps1 = r#"$ErrorActionPreference = 'Stop'
Write-Output ("ARGV:" + ($args -join ' '))
# Not JSON-RPC, and an empty line: the driver must skip both and keep going.
Write-Output ''
Write-Output 'not json at all'
# In-turn progress: documented, but NOT a status change.
Write-Output '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk"}}'
# The agent asks the client to decide -> NeedsInput.
Write-Output '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}'
# Wait for a line on stdin, then end the turn -> Idle; then stay alive
# (the sh fixture's `exec cat`), until the pane is torn down. The reader
# binds the STD INPUT HANDLE (the pipe ConPTY hands the child), not the
# console input buffer - [Console]::In sees key events, not written bytes.
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput())
$line = $reader.ReadLine()
if ($null -ne $line) {
    Write-Output '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
}
while ($true) { Start-Sleep -Seconds 3600 }
"#;
            std::fs::write(dir.join("opencode.ps1"), ps1).unwrap();
            std::fs::write(
                dir.join("opencode.cmd"),
                "@powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0opencode.ps1\" %*\r\n",
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            let path = dir.join("opencode");
            std::fs::write(
                &path,
                r#"#!/bin/sh
# ARGV FIRST, and it is not decoration: the argv is the thing that broke.
# `AgentKind::Opencode`'s arm in `spawn_session` matches `(kind, _)` and
# throws `custom_cmd` away, so before the dedicated ACP arm existed this
# fixture was launched as plain `opencode` - right binary, wrong mode - and
# a shim that only echoes stdin cannot tell the two apart.
echo "ARGV:$*"
# Not JSON-RPC, and an empty line: the driver must skip both and keep going.
echo ''
echo 'not json at all'
# In-turn progress: documented, but NOT a status change.
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk"}}'
# The agent asks the client to decide -> NeedsInput.
echo '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}'
# Wait for a line on stdin, then end the turn -> Idle.
read _line
echo '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
exec cat
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}{sep}{path_env}", dir.display()));
        dir
    })
    .clone()
}

fn acp_session(daemon: &Arc<Daemon>, dir: &std::path::Path, slug: &str) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Opencode,
            project_dir: dir.to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: Some(slug.to_string()),
            profile: None,
            prompt: None,
        })
        .expect("acp session spawns")
}

#[tokio::test]
async fn an_acp_stream_drives_agent_status_without_hooks_or_scraping() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let pane = acp_session(&daemon, state.path(), "acp-opencode");

    let mut needs_input = false;
    for _ in 0..200 {
        if daemon.session_status(pane.id).ok().flatten() == Some(proto::AgentStatus::NeedsInput) {
            needs_input = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        needs_input,
        "session/request_permission must surface as NeedsInput; status was {:?}",
        daemon.session_status(pane.id)
    );

    daemon
        .write_stdin(
            pane.id,
            if cfg!(windows) {
                b"go\r\n" as &[u8]
            } else {
                b"go\n"
            },
        )
        .expect("write to the fixture");
    let mut idle = false;
    for _ in 0..200 {
        if daemon.session_status(pane.id).ok().flatten() == Some(proto::AgentStatus::Idle) {
            idle = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        idle,
        "a stopReason must settle the pane; status was {:?}",
        daemon.session_status(pane.id)
    );
}

#[tokio::test]
async fn an_unknown_acp_slug_is_refused_by_name_with_the_roster_listed() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let err = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Opencode,
            project_dir: state.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: Some("acp-nonesuch".into()),
            profile: None,
            prompt: None,
        })
        .expect_err("an unknown slug must be refused, not silently downgraded");
    let text = format!("{err:#}");
    assert!(text.contains("acp-nonesuch"), "names the value: {text}");
    assert!(text.contains("acp-opencode"), "lists the roster: {text}");
}

#[tokio::test]
async fn acp_mode_and_an_explicit_cmd_cannot_both_be_given() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let err = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Opencode,
            project_dir: state.path().to_path_buf(),
            cmd: Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: Some("acp-opencode".into()),
            profile: None,
            prompt: None,
        })
        .expect_err("two argv authorities must be refused, not silently ranked");
    assert!(format!("{err:#}").contains("cannot both be given"));
}

#[tokio::test]
async fn the_roster_the_daemon_offers_is_the_roster_it_accepts() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    let proto::ServerMsg::OrchestrationState { acp_agents, .. } = daemon.orchestration_state()
    else {
        panic!("orchestration_state must answer with OrchestrationState");
    };
    assert!(
        !acp_agents.is_empty(),
        "this build ships an ACP roster; an empty one would silently hide the feature"
    );
    for row in &acp_agents {
        let known = houston_core::acp::find_known_acp_agent(&row.slug)
            .unwrap_or_else(|| panic!("offered slug {:?} is not in the table", row.slug));
        assert_eq!(row.command, known.argv.join(" "), "{:?}", row.slug);
        assert_eq!(row.agent, houston_core::acp::agent_kind_for(known));
    }
    let ws = _state.path().to_path_buf();
    for row in &acp_agents {
        if row.command.starts_with("opencode ") {
            let info = daemon
                .create_session(CreateParams {
                    agent: row.agent,
                    project_dir: ws.clone(),
                    cmd: None,
                    cols: 80,
                    rows: 24,
                    cwd_from: None,
                    shell_integration: false,
                    auto_approve: false,
                    acp: Some(row.slug.clone()),
                    profile: None,
                    prompt: None,
                })
                .unwrap_or_else(|e| panic!("offered slug {:?} was refused: {e:#}", row.slug));
            daemon.close(info.id).ok();
        }
    }
}

#[tokio::test]
async fn an_acp_pane_launches_the_rosters_argv_not_the_plain_cli() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let pane = acp_session(&daemon, state.path(), "acp-opencode");

    let mut argv = None;
    for _ in 0..200 {
        let replay = daemon.scrollback(pane.id, None).expect("scrollback");
        let text = String::from_utf8_lossy(&replay.data).into_owned();
        if let Some(line) = text.lines().find(|l| l.contains("ARGV:")) {
            argv = Some(line.trim().to_string());
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let argv = argv.expect("the fixture prints its argv on the first line");
    assert!(
        argv.contains("ARGV:acp"),
        "an acp-opencode pane must run `opencode acp`; it ran with argv {argv:?}"
    );
}

#[tokio::test]
async fn a_restored_acp_pane_comes_back_in_acp_mode() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let pane = acp_session(&daemon, state.path(), "acp-opencode");
    assert_eq!(
        pane.acp.as_deref(),
        Some("acp-opencode"),
        "spawn records it"
    );

    let db = Db::open(&state.path().join("test.db")).expect("open the daemon's db");
    db.mark_live_as_interrupted().expect("mark interrupted");
    let restored = db.list_interrupted().expect("list interrupted");
    let row = restored
        .iter()
        .find(|r| r.id == pane.id)
        .unwrap_or_else(|| panic!("session {} missing from the restore list", pane.id));
    assert_eq!(
        row.acp.as_deref(),
        Some("acp-opencode"),
        "the restore row must carry the slug, or the respawn cannot rebuild the argv"
    );
}

#![cfg(unix)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
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
            let ps1 = "$ErrorActionPreference = 'Stop'\n\
                       Write-Output ('ARGV:' + ($args -join '|'))\n\
                       while ($true) { Start-Sleep -Seconds 3600 }\n";
            std::fs::write(dir.join("claude.ps1"), ps1).unwrap();
            std::fs::write(
                dir.join("claude.cmd"),
                "@powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0claude.ps1\" %*\r\n",
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            let path = dir.join("claude");
            std::fs::write(
                &path,
                "#!/bin/sh\nprintf 'ARGV:'\nfor a in \"$@\"; do printf '%s|' \"$a\"; done\nprintf '\\n'\nexec cat\n",
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

fn params(dir: &std::path::Path, agent: proto::AgentKind, prompt: Option<&str>) -> CreateParams {
    CreateParams {
        agent,
        project_dir: dir.to_path_buf(),
        cmd: None,
        cols: 120,
        rows: 40,
        cwd_from: None,
        shell_integration: false,
        auto_approve: false,
        acp: None,
        profile: None,
        prompt: prompt.map(str::to_string),
    }
}

async fn argv_of(daemon: &Arc<Daemon>, id: u32) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let replay = daemon.scrollback(id, None).expect("scrollback");
        let text = String::from_utf8_lossy(&replay.data).into_owned();
        if let Some(start) = text.find("ARGV:") {
            if let Some(end) = text[start..].find('\n') {
                return text[start..start + end].trim().to_string();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the fixture never printed its argv for session {id}");
}

#[tokio::test]
async fn a_prompt_reaches_the_cli_as_one_argv_element() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let pane = daemon
        .create_session(params(
            state.path(),
            proto::AgentKind::Claude,
            Some("Fix the parser, then run the tests"),
        ))
        .expect("a prompted session spawns");

    let argv = argv_of(&daemon, pane.id).await;
    assert!(
        argv.contains("ARGV:Fix the parser, then run the tests|"),
        "the prompt must arrive as ONE argv element, spaces intact; got {argv:?}"
    );
}

#[tokio::test]
async fn no_prompt_means_no_positional_at_all_not_an_empty_one() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let pane = daemon
        .create_session(params(state.path(), proto::AgentKind::Claude, None))
        .expect("an unprompted session spawns");

    let argv = argv_of(&daemon, pane.id).await;
    assert!(
        argv.starts_with("ARGV:--"),
        "an absent prompt must produce no positional argument, and above all \
         not an empty one (`claude ''` starts a turn with an empty message); \
         got {argv:?}"
    );
    assert!(
        !argv.starts_with("ARGV:|"),
        "an empty positional was passed; got {argv:?}"
    );
}

#[tokio::test]
async fn a_blank_prompt_is_treated_as_absent() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let pane = daemon
        .create_session(params(
            state.path(),
            proto::AgentKind::Claude,
            Some("   \n"),
        ))
        .expect("a whitespace-only prompt spawns like no prompt");

    let argv = argv_of(&daemon, pane.id).await;
    assert!(
        argv.starts_with("ARGV:--"),
        "a whitespace-only prompt must be treated as absent; got {argv:?}"
    );
}

#[tokio::test]
async fn a_prompt_on_a_shell_is_refused_by_name_never_silently_dropped() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;

    let err = daemon
        .create_session(params(state.path(), proto::AgentKind::Shell, Some("do it")))
        .expect_err("a prompt on a shell must be refused, not dropped");
    let msg = err.to_string();
    assert!(
        msg.contains("Shell") && msg.contains("not spawnable"),
        "the refusal must name the offending kind and the expected ones; got {msg:?}"
    );
}

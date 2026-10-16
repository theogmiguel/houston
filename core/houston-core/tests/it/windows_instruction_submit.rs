#![cfg(windows)]

use crate::common;

use houston_core::daemon::CreateParams;
use houston_core::{db::Db, hook_drop};
use houston_protocol as proto;
use std::time::Duration;

#[tokio::test]
async fn steer_submits_after_the_console_paste_guard() {
    let (_, state, daemon) = common::start_daemon_with_handle().await;
    let workspace = tempfile::tempdir().unwrap();
    let ready = workspace.path().join("ready");
    let submitted = workspace.path().join("submitted");
    let script = workspace.path().join("composer.ps1");
    std::fs::write(&script, r#"
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = -1000
$text = ''
# A console CLI is ready when its input loop is running. Pay the first-use
# costs (console input handle, file write, string ops) before announcing it:
# otherwise a loaded runner is still initialising when the paste arrives, drains
# paste and Enter back to back, and measures an interval the daemon's wait
# before Enter cannot influence.
[void][Console]::KeyAvailable
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'warm'), [string]$clock.ElapsedMilliseconds)
[void]$text.Contains('SUBMIT-ME')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'), 'ready')
while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'enter-ms'), [string]($clock.ElapsedMilliseconds - $last))
        if (($clock.ElapsedMilliseconds - $last) -ge 120 -and $text.Contains('SUBMIT-ME')) {
            [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'submitted'), $text)
        }
    } else {
        $text += $key.KeyChar
        $last = $clock.ElapsedMilliseconds
    }
}
"#).unwrap();
    let pane = |agent, cmd| {
        daemon
            .create_session(CreateParams {
                agent,
                project_dir: workspace.path().to_path_buf(),
                cmd: Some(cmd),
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
    };
    let parent = pane(
        proto::AgentKind::Custom,
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-Command".into(),
            "Start-Sleep -Seconds 60".into(),
        ],
    );
    let child = pane(
        proto::AgentKind::Codex,
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-File".into(),
            script.display().to_string(),
        ],
    );
    Db::open(&state.path().join("test.db"))
        .unwrap()
        .delegation_create(
            parent.id,
            child.id,
            Some("paste-fixture"),
            "task",
            hook_drop::now_ms(),
        )
        .unwrap();
    daemon.orchestration_set(true).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !ready.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "console fixture did not start"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    daemon
        .orchestrate_instruction_request(parent.id, child.id, "SUBMIT-ME", None, Some("steer"))
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !submitted.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let result = std::fs::read_to_string(submitted);
    let enter_ms = std::fs::read_to_string(workspace.path().join("enter-ms"));
    daemon.close(child.id).unwrap();
    daemon.close(parent.id).unwrap();
    assert!(result.is_ok(), "the instruction remained in the console composer: {result:?}; paste-to-Enter ms: {enter_ms:?}");
}

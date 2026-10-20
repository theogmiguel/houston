#![cfg(windows)]

use crate::common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp::MCP_TOOLS;
use houston_core::orchestrate::request_header_for;
use houston_core::{db::Db, hook_drop};
use houston_protocol as proto;
use std::sync::Arc;
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

const COMPOSER: &str = r#"
$ErrorActionPreference = 'Stop'
# Warm the console input handle before announcing ready, so the first
# paste cannot drain while the reader is still initialising.
[void][Console]::KeyAvailable
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'), 'ready')
$text = ''
$round = 0
while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.KeyChar -eq [char]13) {
        $round++
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot ("submit-{0}.txt" -f $round)), $text)
        $text = ''
    } elseif ($key.KeyChar -eq [char]10) {
        # ConPTY shows a paste's line feeds as Enter-like keys; only the
        # daemon's carriage return submits.
        $text += "`n"
    } else {
        $text += $key.KeyChar
    }
}
"#;

struct SpellingFixture {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    workspace: tempfile::TempDir,
}

impl SpellingFixture {
    async fn new() -> Self {
        let (_, state, daemon) = common::start_daemon_with_handle().await;
        let workspace = tempfile::tempdir().unwrap();
        Self {
            daemon,
            state,
            workspace,
        }
    }

    fn pane(&self, agent: proto::AgentKind, cmd: Vec<String>) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent,
                project_dir: self.workspace.path().to_path_buf(),
                cmd: Some(cmd),
                cols: 160,
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
            .id
    }

    fn parent(&self) -> u32 {
        self.pane(
            proto::AgentKind::Custom,
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 120".into(),
            ],
        )
    }

    fn child(&self, agent: proto::AgentKind) -> u32 {
        let script = self.workspace.path().join("composer.ps1");
        std::fs::write(&script, COMPOSER).unwrap();
        self.pane(
            agent,
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-File".into(),
                script.display().to_string(),
            ],
        )
    }

    fn delegate(&self, parent: u32, child: u32) {
        Db::open(&self.state.path().join("test.db"))
            .unwrap()
            .delegation_create(
                parent,
                child,
                Some("header-spelling"),
                "task",
                hook_drop::now_ms(),
            )
            .unwrap();
    }

    async fn await_state(
        &self,
        caller: u32,
        child: u32,
        id: &str,
        wanted: proto::InstructionState,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let detail = self
                .daemon
                .instruction_get(Some(caller), child, id)
                .unwrap();
            if detail.instruction.state == wanted {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "instruction {id} never reached {wanted:?}: state={:?}, hold_reason={:?}",
                detail.instruction.state,
                detail.instruction.hold_reason
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn await_submit(&self, round: u32) -> String {
        let path = self.workspace.path().join(format!("submit-{round}.txt"));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                return text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the composer never submitted round {round}: {:?}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for SpellingFixture {
    fn drop(&mut self) {
        for session in self.daemon.list() {
            let _ = self.daemon.close(session.id);
        }
    }
}

/// Steer one instruction into an idle child, adopt it, then queue a second
/// one behind a working child and release it with a turn end. Returns the
/// composer-captured bytes of both deliveries, in round order. The composer
/// never echoes, so the captured files — not the scrollback — are the proof.
async fn captured_rounds(
    fixture: &SpellingFixture,
    child: u32,
    steer_body: &str,
    queue_body: &str,
) -> (String, String) {
    let parent = fixture.parent();
    fixture.delegate(parent, child);
    let ready = fixture.workspace.path().join("ready");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !ready.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the composer fixture did not start"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fixture.daemon.orchestration_set(true).unwrap();
    let (steer, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, steer_body, None, Some("steer"))
        .unwrap();
    let steer_text = fixture.await_submit(1).await;
    assert!(
        steer_text.contains(steer_body),
        "the steer arrived without its body: {steer_text:?}"
    );
    fixture
        .await_state(
            parent,
            child,
            &steer.instruction_id,
            proto::InstructionState::Delivered,
        )
        .await;
    fixture.daemon.handle_hook(child, "UserPromptSubmit", None);
    let (queued, _, held) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, queue_body, None, Some("queue"))
        .unwrap();
    assert_eq!(
        queued.state,
        proto::InstructionState::Queued,
        "{queue_body} must wait while the child is working"
    );
    assert!(held.is_some(), "{queue_body} must report why it is waiting");
    fixture.daemon.handle_hook(child, "Stop", None);
    let queue_text = fixture.await_submit(2).await;
    assert!(
        queue_text.contains(queue_body),
        "the queued instruction arrived without its body: {queue_text:?}"
    );
    fixture
        .await_state(
            parent,
            child,
            &queued.instruction_id,
            proto::InstructionState::Delivered,
        )
        .await;
    (steer_text, queue_text)
}

#[tokio::test]
async fn steered_and_queued_instructions_to_a_zcode_child_carry_the_hs_pane_header() {
    let fixture = SpellingFixture::new().await;
    let child = fixture.child(proto::AgentKind::Zcode);
    let (steer_text, queue_text) =
        captured_rounds(&fixture, child, "ZCODE-STEER-BODY", "ZCODE-QUEUE-BODY").await;
    assert!(
        !MCP_TOOLS.contains(&proto::AgentKind::Zcode),
        "the fixture premise is a CLI-only child"
    );
    for (round, text) in [(1, steer_text), (2, queue_text)] {
        assert!(
            text.contains(&request_header_for(round, false)),
            "round {round} must carry the hs-pane spelling: {text:?}"
        );
        assert!(
            !text.contains("pane_submit"),
            "a ZCode child has no pane_* MCP tools, round {round}: {text:?}"
        );
    }
}

#[tokio::test]
async fn steered_and_queued_instructions_to_a_claude_child_keep_the_mcp_header() {
    let fixture = SpellingFixture::new().await;
    let child = fixture.child(proto::AgentKind::Claude);
    let (steer_text, queue_text) =
        captured_rounds(&fixture, child, "CLAUDE-STEER-BODY", "CLAUDE-QUEUE-BODY").await;
    for (round, text) in [(1, steer_text), (2, queue_text)] {
        assert!(
            text.contains(&request_header_for(round, true)),
            "round {round} must carry the pane_submit spelling: {text:?}"
        );
        assert!(
            !text.contains("hs-pane submit"),
            "an MCP child must not be told the CLI spelling, round {round}: {text:?}"
        );
    }
}

#![cfg(unix)]

mod common;

use common::{hermetic_command, start_daemon_with_handle};
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::db::Db;
use houston_core::hook_drop;
use houston_core::mcp_creds::McpScope;
use houston_core::orchestrate::request_header;
use houston_protocol as proto;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct ProviderFixture {
    daemon: Arc<Daemon>,
    addr: SocketAddr,
    credentials: HashMap<u32, String>,
    turn_ids: HashMap<u32, String>,
    state: tempfile::TempDir,
    home: PathBuf,
    workspace: PathBuf,
    previous_env: Vec<(&'static str, Option<OsString>)>,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl ProviderFixture {
    async fn new() -> Self {
        let serial = SERIAL.lock().await;
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let home = state.path().join("home");
        let workspace = state.path().join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let mut fixture_command = hermetic_command("/bin/true", &home);
        assert!(fixture_command.status().unwrap().success());
        let shims = home.join("provider-shims");
        let codex = shims.join("codex");
        std::fs::write(
            &codex,
            "#!/bin/sh\nstty -echo\necho QUEUE-FIXTURE-READY\nexec /bin/cat\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(codex, std::fs::Permissions::from_mode(0o700)).unwrap();
        let previous_env = ["HOME", "PATH", "SHELL", "CODEX_HOME"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", format!("{}:/usr/bin:/bin", shims.display()));
        std::env::set_var("SHELL", shims.join("login-shell"));
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::env::set_var("CODEX_HOME", home.join(".codex"));
        // Register directly so this fixture does not install provider configuration.
        Db::open(&state.path().join("test.db"))
            .unwrap()
            .add_workspace(workspace.to_str().unwrap(), "instruction-queue")
            .unwrap();
        Self {
            daemon,
            addr,
            credentials: HashMap::new(),
            turn_ids: HashMap::new(),
            state,
            home,
            workspace,
            previous_env,
            _serial: serial,
        }
    }

    fn spawn_child(&mut self, parent: u32) -> u32 {
        self.spawn_child_with_lifecycle(parent, true)
    }

    fn spawn_child_with_lifecycle(&mut self, parent: u32, reusable: bool) -> u32 {
        self.daemon.orchestration_set(true).unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "kind":"codex", "prompt":"task A", "role":"worker", "reusable":reusable, "auto_approve":false,
        })).unwrap();
        let child = self
            .daemon
            .orchestrate_spawn_request(parent, request)
            .unwrap()
            .session
            .id;
        let token = self.daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: self.workspace.display().to_string(),
        });
        self.credentials.insert(child, token);
        child
    }

    fn pane(&mut self, agent: proto::AgentKind) -> u32 {
        let session = self
            .daemon
            .create_session(CreateParams {
                agent,
                project_dir: self.workspace.clone(),
                cmd: Some(vec![
                    "/usr/bin/env".into(),
                    "-i".into(),
                    format!("HOME={}", self.home.display()),
                    "PATH=/usr/bin:/bin".into(),
                    "/bin/sh".into(),
                    "-c".into(),
                    "stty -echo; echo QUEUE-FIXTURE-READY; exec cat".into(),
                ]),
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
            .id;
        let token = self.daemon.mcp_creds.issue(McpScope {
            session_id: session,
            workspace_id: self.workspace.display().to_string(),
        });
        self.credentials.insert(session, token);
        session
    }

    async fn codex_hook(&mut self, session: u32, fixture: &str, prompt: Option<&str>) {
        let payload: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let event = payload["hook_event_name"].as_str().unwrap().to_string();
        let mut payload = payload;
        if let Some(prompt) = prompt {
            payload["prompt"] = serde_json::json!(prompt);
            self.turn_ids.insert(session, format!("queue-{prompt}"));
        }
        if let Some(turn_id) = self.turn_ids.get(&session) {
            payload["turn_id"] = serde_json::json!(turn_id);
        }
        let home = self.home.clone();
        let workspace = self.workspace.clone();
        let mcp_url = format!("http://{}/mcp", self.addr);
        let mcp_token = self.credentials.get(&session).unwrap().clone();
        tokio::task::spawn_blocking(move || {
            let mut cmd = hermetic_command(env!("CARGO_BIN_EXE_houston-core"), &home);
            let mut child = cmd
                .args(["hook", &event, "--agent", "codex", "--houston-managed"])
                .env("HOUSTON_CHANNEL", "instruction-queue-test")
                .env("HOUSTON_SESSION", session.to_string())
                .env("TR_SESSION", session.to_string())
                .env("HOUSTON_MCP_URL", mcp_url)
                .env("HOUSTON_MCP_TOKEN", mcp_token)
                .current_dir(workspace)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{output:?}");
            assert!(output.stderr.is_empty(), "{output:?}");
        })
        .await
        .unwrap();
        let source = hook_drop::drop_dir(&self.home.join(".houston-instruction-queue-test"));
        let target = hook_drop::drop_dir(self.state.path());
        hook_drop::ensure_drop_dir(&target).unwrap();
        let files: Vec<_> = std::fs::read_dir(source).unwrap().collect();
        assert_eq!(files.len(), 1, "each fixture emits one authoritative hook");
        let file = files.into_iter().next().unwrap().unwrap();
        std::fs::rename(file.path(), target.join(file.file_name())).unwrap();
        assert_eq!(self.daemon.hook_drop_tick_for_test(), 1);
    }

    fn output(&self, session: u32) -> String {
        String::from_utf8_lossy(&self.daemon.scrollback(session, None).unwrap().data).into_owned()
    }

    async fn await_output(&self, session: u32, needle: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let output = self.output(session);
            if output.contains(needle) {
                return output;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "missing {needle:?}: {output:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for ProviderFixture {
    fn drop(&mut self) {
        for session in self.daemon.list() {
            let _ = self.daemon.close(session.id);
        }
        for (key, value) in &self.previous_env {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

const PROMPT: &str = include_str!("fixtures/hooks/codex/codex-0.153.4-02-UserPromptSubmit.json");
const STOP: &str = include_str!("fixtures/hooks/codex/codex-0.153.4-03-Stop.json");

#[tokio::test]
async fn instructions_before_the_first_prompt_hook_use_the_reserved_spawn_request() {
    let mut fixture = ProviderFixture::new().await;
    let parent = fixture.pane(proto::AgentKind::Custom);
    let child = fixture.spawn_child(parent);
    fixture.await_output(child, "QUEUE-FIXTURE-READY").await;
    fixture
        .codex_hook(
            child,
            include_str!("fixtures/hooks/codex/codex-0.153.4-01-SessionStart.json"),
            None,
        )
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(1));
    for text in ["BOOT-INSTRUCTION-ONE", "BOOT-INSTRUCTION-TWO"] {
        fixture
            .daemon
            .orchestrate_prompt_request(parent, child, text, None, Some("queue"))
            .unwrap();
    }
    let output = fixture.await_output(child, "BOOT-INSTRUCTION-ONE").await;
    assert!(output.contains(request_header(1).as_str()), "{output:?}");
    assert!(!output.contains("BOOT-INSTRUCTION-TWO"));
    fixture
        .codex_hook(child, PROMPT, Some("BOOT-INSTRUCTION-ONE"))
        .await;
    fixture.codex_hook(child, STOP, None).await;
    let output = fixture.await_output(child, "BOOT-INSTRUCTION-TWO").await;
    assert!(output.contains(request_header(2).as_str()), "{output:?}");
    fixture
        .codex_hook(child, PROMPT, Some("BOOT-INSTRUCTION-TWO"))
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(2));
}

#[tokio::test]
async fn queued_codex_instructions_receive_distinct_request_ids_when_dispatched() {
    let mut fixture = ProviderFixture::new().await;
    let parent = fixture.pane(proto::AgentKind::Custom);
    let child = fixture.spawn_child(parent);
    fixture.await_output(child, "QUEUE-FIXTURE-READY").await;
    fixture.daemon.orchestration_set(true).unwrap();
    fixture.codex_hook(child, PROMPT, Some("task A")).await;
    assert_eq!(
        fixture.daemon.session_status(child).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(1));

    for text in ["QUEUE-TASK-B", "QUEUE-TASK-C"] {
        let (_, _, held) = fixture
            .daemon
            .orchestrate_prompt_request(parent, child, text, None, Some("queue"))
            .unwrap();
        assert!(held.is_some(), "{text} must wait for round 1 to finish");
        assert!(!fixture.output(child).contains(text));
    }
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(1));

    fixture.codex_hook(child, STOP, None).await;
    let output = fixture.await_output(child, "QUEUE-TASK-B").await;
    assert!(
        output.contains(&format!("{}\r\n\r\nQUEUE-TASK-B", request_header(2))),
        "{output:?}"
    );
    fixture
        .codex_hook(child, PROMPT, Some("QUEUE-TASK-B"))
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(2));
    fixture.codex_hook(child, STOP, None).await;
    let output = fixture.await_output(child, "QUEUE-TASK-C").await;
    assert!(
        output.contains(&format!("{}\r\n\r\nQUEUE-TASK-C", request_header(3))),
        "C was accepted during round 1 but must be framed at dispatch for request 3: {output:?}"
    );
    fixture
        .codex_hook(child, PROMPT, Some("QUEUE-TASK-C"))
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(3));
}

async fn working_child(fixture: &mut ProviderFixture) -> (u32, u32) {
    let parent = fixture.pane(proto::AgentKind::Custom);
    let child = fixture.spawn_child(parent);
    fixture.await_output(child, "QUEUE-FIXTURE-READY").await;
    fixture.daemon.orchestration_set(true).unwrap();
    fixture.codex_hook(child, PROMPT, Some("task A")).await;
    (parent, child)
}

#[tokio::test]
async fn accepted_queue_retry_returns_same_intent_and_current_state_without_replaying() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    let (accepted, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RETRY-QUEUED-BODY",
            Some("queued-retry"),
            Some("queue"),
        )
        .unwrap();
    let (repeated, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RETRY-QUEUED-BODY",
            Some("queued-retry"),
            Some("queue"),
        )
        .unwrap();
    assert_eq!(accepted.instruction_id, repeated.instruction_id);
    assert_eq!(
        fixture
            .daemon
            .instruction_queue(Some(parent), child)
            .unwrap()
            .queued_count,
        1
    );
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &accepted.instruction_id)
            .unwrap()
            .body,
        "RETRY-QUEUED-BODY"
    );
    fixture
        .daemon
        .instruction_cancel(Some(parent), child, &accepted.instruction_id)
        .unwrap();
    let (cancelled, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RETRY-QUEUED-BODY",
            Some("queued-retry"),
            Some("queue"),
        )
        .unwrap();
    assert_eq!(cancelled.instruction_id, accepted.instruction_id);
    assert_eq!(cancelled.state, proto::InstructionState::Cancelled);
    assert!(!fixture.output(child).contains("RETRY-QUEUED-BODY"));
    assert!(fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "CHANGED-BODY",
            Some("queued-retry"),
            Some("queue")
        )
        .is_err());
}

#[tokio::test]
async fn uncertain_paste_retains_full_body_and_blocks_later_instructions_until_cancelled() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    fixture
        .daemon
        .fail_next_stdin_write_after_for_test(child, 8);
    let (first, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "UNCERTAIN-BODY-RETAINED",
            Some("partial-paste"),
            Some("steer"),
        )
        .unwrap();
    assert_eq!(first.state, proto::InstructionState::Uncertain);
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &first.instruction_id)
            .unwrap()
            .body,
        "UNCERTAIN-BODY-RETAINED"
    );
    let (second, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, "BLOCKED-LATER-BODY", None, Some("queue"))
        .unwrap();
    fixture.codex_hook(child, STOP, None).await;
    let (retry, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "UNCERTAIN-BODY-RETAINED",
            Some("partial-paste"),
            Some("steer"),
        )
        .unwrap();
    assert_eq!(retry.instruction_id, first.instruction_id);
    assert_eq!(retry.state, proto::InstructionState::Uncertain);
    assert!(!fixture.output(child).contains("BLOCKED-LATER-BODY"));
    assert!(fixture
        .daemon
        .instruction_resume(Some(parent), child, &first.instruction_id)
        .is_err());
    fixture
        .daemon
        .instruction_cancel(Some(parent), child, &first.instruction_id)
        .unwrap();
    fixture.await_output(child, "BLOCKED-LATER-BODY").await;
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &second.instruction_id)
            .unwrap()
            .instruction
            .state,
        proto::InstructionState::Delivered
    );
}

#[tokio::test]
async fn steer_adoption_releases_the_old_staged_result_as_interrupted_without_a_prompt_hook() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    fixture
        .daemon
        .orchestrate_submit(
            child,
            houston_core::orchestrate::Submission {
                body: "STAGED-OLD-BODY".into(),
                summary: None,
                artifacts: Vec::new(),
                request_id: Some(1),
            },
        )
        .unwrap();
    let (accepted, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, "STEER-REPLACEMENT", None, Some("steer"))
        .unwrap();
    assert_eq!(accepted.request_id, Some(2));
    fixture
        .daemon
        .orchestrate_report(
            child,
            houston_core::orchestrate::WorkerReport {
                kind: houston_core::orchestrate::ReportKind::Progress,
                body: "Adopted replacement".into(),
                request_id: 2,
                client_request_id: None,
            },
        )
        .unwrap();
    let rows = fixture.daemon.inbox_rows_for_test(parent);
    let old = rows
        .iter()
        .find(|row| row.body.contains("STAGED-OLD-BODY"))
        .unwrap();
    assert_eq!(old.request_id, Some(1));
    assert_eq!(old.reason.as_deref(), Some("interrupted"));
    assert!(
        old.ready_at.is_some(),
        "old staged body must remain eligible: {old:?}"
    );
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(2));
}

#[tokio::test]
async fn instruction_inspection_and_controls_refuse_peers_and_wrong_targets() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    let peer = fixture.pane(proto::AgentKind::Custom);
    let (accepted, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, "SCOPED-BODY", None, Some("queue"))
        .unwrap();
    for caller in [Some(peer), Some(child)] {
        assert!(fixture.daemon.instruction_queue(caller, child).is_err());
        assert!(fixture
            .daemon
            .instruction_get(caller, child, &accepted.instruction_id)
            .is_err());
        assert!(fixture
            .daemon
            .instruction_cancel(caller, child, &accepted.instruction_id)
            .is_err());
        assert!(fixture
            .daemon
            .instruction_resume(caller, child, &accepted.instruction_id)
            .is_err());
    }
    assert!(fixture
        .daemon
        .instruction_get(None, peer, &accepted.instruction_id)
        .is_err());
    assert_eq!(
        fixture
            .daemon
            .instruction_get(None, child, &accepted.instruction_id)
            .unwrap()
            .body,
        "SCOPED-BODY"
    );
}

#[tokio::test]
async fn recovery_holds_untouched_bodies_and_never_replays_uncertain_writes() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    fixture
        .daemon
        .fail_next_stdin_write_after_for_test(child, 8);
    let (uncertain, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RECOVERY-PARTIAL",
            Some("recovery-partial"),
            Some("steer"),
        )
        .unwrap();
    let (untouched, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RECOVERY-UNTOUCHED",
            Some("recovery-queued"),
            Some("queue"),
        )
        .unwrap();
    // Reopen the durable database and run the same recovery transaction as boot.
    // The live fixture represents PTYs adopted after a daemon handoff.
    let db = Db::open(&fixture.state.path().join("test.db")).unwrap();
    let original_profile = db.session_profile_config_dir(child).unwrap();
    db.instruction_recover(hook_drop::now_ms()).unwrap();
    let (held, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RECOVERY-UNTOUCHED",
            Some("recovery-queued"),
            Some("queue"),
        )
        .unwrap();
    assert_eq!(held.instruction_id, untouched.instruction_id);
    assert_eq!(held.state, proto::InstructionState::HeldAfterRecovery);
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &held.instruction_id)
            .unwrap()
            .body,
        "RECOVERY-UNTOUCHED"
    );
    fixture.codex_hook(child, STOP, None).await;
    assert!(!fixture.output(child).contains("RECOVERY-UNTOUCHED"));
    assert!(fixture
        .daemon
        .instruction_resume(Some(parent), child, &uncertain.instruction_id)
        .is_err());
    db.set_session_profile_config_dir(child, Some("changed-profile-context"))
        .unwrap();
    let refusal = fixture
        .daemon
        .instruction_resume(Some(parent), child, &held.instruction_id)
        .unwrap_err()
        .to_string();
    assert!(
        refusal.contains("context") || refusal.contains("profile"),
        "{refusal}"
    );
    db.set_session_profile_config_dir(child, original_profile.as_deref())
        .unwrap();
    fixture
        .daemon
        .instruction_cancel(Some(parent), child, &uncertain.instruction_id)
        .unwrap();
    fixture
        .daemon
        .instruction_resume(Some(parent), child, &held.instruction_id)
        .unwrap();
    fixture.await_output(child, "RECOVERY-UNTOUCHED").await;
    let (delivered, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RECOVERY-UNTOUCHED",
            Some("recovery-queued"),
            Some("queue"),
        )
        .unwrap();
    assert_eq!(delivered.instruction_id, held.instruction_id);
    assert_eq!(delivered.state, proto::InstructionState::Delivered);
}

#[tokio::test]
async fn an_old_stop_cannot_dispatch_c_before_b_has_started() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    let (b, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, "B-AWAITING-ADOPTION", None, Some("queue"))
        .unwrap();
    let (c, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, "C-BEHIND-B-START", None, Some("queue"))
        .unwrap();
    fixture.codex_hook(child, STOP, None).await;
    fixture.await_output(child, "B-AWAITING-ADOPTION").await;
    // A duplicate authoritative idle for A does not prove B was adopted.
    fixture.codex_hook(child, STOP, None).await;
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &b.instruction_id)
            .unwrap()
            .instruction
            .state,
        proto::InstructionState::Delivered
    );
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &c.instruction_id)
            .unwrap()
            .instruction
            .state,
        proto::InstructionState::Queued
    );
    assert!(!fixture.output(child).contains("C-BEHIND-B-START"));
    fixture
        .daemon
        .orchestrate_report(
            child,
            houston_core::orchestrate::WorkerReport {
                kind: houston_core::orchestrate::ReportKind::Progress,
                body: "B adopted without a prompt hook".into(),
                request_id: 2,
                client_request_id: None,
            },
        )
        .unwrap();
    assert!(!fixture.output(child).contains("C-BEHIND-B-START"));
    fixture
        .turn_ids
        .insert(child, "queue-B-AWAITING-ADOPTION".into());
    fixture.codex_hook(child, STOP, None).await;
    fixture.await_output(child, "C-BEHIND-B-START").await;
    let c = fixture
        .daemon
        .instruction_get(Some(parent), child, &c.instruction_id)
        .unwrap();
    assert_eq!(c.instruction.request_id, Some(3));
}

#[tokio::test]
async fn restart_interrupts_once_and_waits_for_authoritative_completion_before_delivery() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    let (accepted, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RESTART-AFTER-STOP",
            Some("restart-once"),
            Some("restart"),
        )
        .unwrap();
    assert_eq!(accepted.state, proto::InstructionState::Queued);
    assert_eq!(accepted.request_id, None);
    assert!(!fixture.output(child).contains("RESTART-AFTER-STOP"));
    let (retried, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "RESTART-AFTER-STOP",
            Some("restart-once"),
            Some("restart"),
        )
        .unwrap();
    assert_eq!(accepted.instruction_id, retried.instruction_id);
    assert_eq!(
        fixture.daemon.session_status(child).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    fixture.codex_hook(child, STOP, None).await;
    let output = fixture.await_output(child, "RESTART-AFTER-STOP").await;
    // The PTY fixture buffers the interrupt until the subsequent paste's newline.
    assert!(
        output.contains("\u{1b}\u{1b}[200~"),
        "missing verified interrupt before replacement paste: {output:?}"
    );
    assert!(
        !output.contains("\u{1b}\u{1b}\u{1b}[200~"),
        "retry sent the interrupt twice: {output:?}"
    );
    // PTY output can precede the durable commit after the Enter write receipt.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let detail = loop {
        let detail = fixture
            .daemon
            .instruction_get(Some(parent), child, &accepted.instruction_id)
            .unwrap();
        if detail.instruction.state == proto::InstructionState::Delivered {
            break detail;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "instruction {} did not reach Delivered: state={:?}, hold_reason={:?}",
            accepted.instruction_id,
            detail.instruction.state,
            detail.instruction.hold_reason
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(detail.instruction.request_id, Some(2));
    fixture
        .codex_hook(child, PROMPT, Some("RESTART-AFTER-STOP"))
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(2));
}

#[tokio::test]
async fn pending_replacement_protects_a_temporary_child_from_old_round_cleanup() {
    let mut fixture = ProviderFixture::new().await;
    let parent = fixture.pane(proto::AgentKind::Custom);
    let child = fixture.spawn_child_with_lifecycle(parent, false);
    fixture.await_output(child, "QUEUE-FIXTURE-READY").await;
    fixture.codex_hook(child, PROMPT, Some("task A")).await;
    fixture
        .daemon
        .orchestrate_submit(child, "TEMPORARY-FIRST-RESULT".to_string().into())
        .unwrap();
    let (replacement, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "PROTECTED-REPLACEMENT",
            None,
            Some("queue"),
        )
        .unwrap();
    fixture.codex_hook(child, STOP, None).await;
    fixture
        .daemon
        .delegation_watch_tick_at(hook_drop::now_ms() + 60_000);
    assert!(fixture
        .daemon
        .list()
        .iter()
        .any(|session| session.id == child && session.state == proto::SessionState::Running));
    fixture.await_output(child, "PROTECTED-REPLACEMENT").await;
    assert_eq!(
        fixture
            .daemon
            .instruction_get(Some(parent), child, &replacement.instruction_id)
            .unwrap()
            .instruction
            .request_id,
        Some(2)
    );
    fixture
        .codex_hook(child, PROMPT, Some("PROTECTED-REPLACEMENT"))
        .await;
    assert_eq!(fixture.daemon.delegation_round_of(child), Some(2));
}

#[tokio::test]
async fn queue_limits_body_bytes_and_active_origin_and_bounds_snapshot_history() {
    let mut fixture = ProviderFixture::new().await;
    let (parent, child) = working_child(&mut fixture).await;
    let body = "é".repeat(32_768);
    let (accepted, _, _) = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, &body, None, Some("queue"))
        .unwrap();
    let detail = fixture
        .daemon
        .instruction_get(Some(parent), child, &accepted.instruction_id)
        .unwrap();
    assert_eq!(detail.body.len(), 65_536);
    assert_eq!(detail.instruction.preview.chars().count(), 480);
    let oversized = format!("{body}x");
    let error = fixture
        .daemon
        .orchestrate_instruction_request(parent, child, &oversized, None, Some("queue"))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("65537") && error.contains("65536"),
        "{error}"
    );
    for _ in 1..16 {
        fixture
            .daemon
            .orchestrate_instruction_request(
                parent,
                child,
                "bounded instruction",
                None,
                Some("queue"),
            )
            .unwrap();
    }
    let error = fixture
        .daemon
        .orchestrate_instruction_request(
            parent,
            child,
            "seventeenth instruction",
            None,
            Some("queue"),
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("16") && error.contains("limit"), "{error}");
    for item in fixture
        .daemon
        .instruction_queue(Some(parent), child)
        .unwrap()
        .items
    {
        fixture
            .daemon
            .instruction_cancel(Some(parent), child, &item.id)
            .unwrap();
    }
    for _ in 0..40 {
        let (intent, _, _) = fixture
            .daemon
            .orchestrate_instruction_request(parent, child, "history", None, Some("queue"))
            .unwrap();
        fixture
            .daemon
            .instruction_cancel(Some(parent), child, &intent.instruction_id)
            .unwrap();
    }
    let snapshot = fixture
        .daemon
        .instruction_queue(Some(parent), child)
        .unwrap();
    assert_eq!(snapshot.items.len(), 32);
    assert!(snapshot.truncated);
}

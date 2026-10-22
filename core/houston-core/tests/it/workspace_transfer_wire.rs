#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

//! Workspace transfer over the wire between two daemons, each with its own state
//! directory, provider homes and clone of one origin: two computers in one process.

use crate::common;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use proto::TransferRefusalCode as Code;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
const PASSPHRASE: &str = "correct horse battery staple";

/// Records argv per pane and reports a version; prints the mode sequences of a composer
/// that takes pasted input, then echoes stdin like an idle CLI.
const FAKE_CLI: &str = r#"#!/bin/sh
case "$(basename "$0")" in
  claude) version="$FAKE_CLAUDE_VERSION" ;;
  *) version="$FAKE_CODEX_VERSION" ;;
esac
case "$1" in
  --version) echo "$version"; exit 0 ;;
  mcp|--help) exit 0 ;;
esac
out="$TRANSFER_ARGV_DIR/$HOUSTON_SESSION"
: > "$out.tmp"
for arg in "$@"; do printf '%s\n' "$arg" >> "$out.tmp"; done
printf 'cwd:%s\n' "$PWD" >> "$out.tmp"
mv "$out.tmp" "$out"
printf '\033[?2004h\033[?25h> '
exec cat
"#;

fn shim_dir() {
    SHIM.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap().keep();
        for name in ["claude", "codex"] {
            let path = directory.join(name);
            std::fs::write(&path, FAKE_CLI).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let inherited = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{inherited}", directory.display()));
        std::env::set_var("SHELL", "/bin/sh");
        for key in [
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "HOUSTON_RESTORE_BUDGET",
            "HOUSTON_SAFE_MODE",
            "HOUSTON_DISABLE_AUTO_RESTORE",
        ] {
            std::env::remove_var(key);
        }
        directory
    });
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Transfer Test",
            "-c",
            "user.email=transfer@test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A bare origin with one commit on `main`.
fn origin(root: &Path) -> PathBuf {
    let origin = root.join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    let seed = root.join("seed");
    git(root, &["clone", "-q", origin.to_str().unwrap(), "seed"]);
    write(&seed.join("README.md"), "first\n");
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "first"]);
    git(&seed, &["push", "-q", "origin", "HEAD:main"]);
    origin
}

struct Computer {
    _root: tempfile::TempDir,
    state: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    argv: PathBuf,
    workspace: PathBuf,
    daemon: Arc<Daemon>,
    ws: common::WsStream,
    next_request: u32,
}

impl Computer {
    async fn new(origin: &Path, claude_version: &str, codex_version: &str) -> Self {
        shim_dir();
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let state = base.join("state");
        let claude = base.join("home/.claude");
        let codex = base.join("home/.codex");
        let argv = base.join("argv");
        for dir in [&state, &claude, &codex, &argv] {
            std::fs::create_dir_all(dir).unwrap();
        }
        git(&base, &["clone", "-q", origin.to_str().unwrap(), "project"]);
        let workspace = base.join("project");
        let env = common::base_env()
            .with("HOME", Some(base.join("home")))
            .with("CLAUDE_CONFIG_DIR", Some(&claude))
            .with("CODEX_HOME", Some(&codex))
            .with("TRANSFER_ARGV_DIR", Some(&argv))
            .with("FAKE_CLAUDE_VERSION", Some(claude_version))
            .with("FAKE_CODEX_VERSION", Some(codex_version))
            .with("GIT_AUTHOR_NAME", Some("Transfer Test"))
            .with("GIT_AUTHOR_EMAIL", Some("transfer@test"))
            .with("GIT_COMMITTER_NAME", Some("Transfer Test"))
            .with("GIT_COMMITTER_EMAIL", Some("transfer@test"));
        let daemon = Daemon::new(DaemonConfig::new(
            common::TOKEN.to_string(),
            state.join("test.db"),
            env,
        ))
        .unwrap();
        let (addr, _handle) =
            houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
                .await
                .unwrap();
        daemon.set_port(addr.port());
        daemon.workspace_add(workspace.to_str().unwrap()).unwrap();
        let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
        let _ = common::next_control(&mut ws).await;
        Self {
            _root: root,
            state,
            claude,
            codex,
            argv,
            workspace,
            daemon,
            ws,
            next_request: 1,
        }
    }

    fn pane(&self, agent: proto::AgentKind, project_dir: &Path) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent,
                project_dir: project_dir.to_path_buf(),
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

    async fn argv(&self, session: u32) -> Vec<String> {
        let path = self.argv.join(session.to_string());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                return contents.lines().map(str::to_string).collect();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "pane {session} never launched its CLI"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn hook(
        &self,
        pane: u32,
        agent: proto::AgentKind,
        event: &str,
        id: &str,
        transcript: &Path,
        cwd: &Path,
    ) {
        let drop = HookDrop {
            event: event.into(),
            session: pane,
            agent: Some(houston_core::agent_hooks::provider_slug(agent).into()),
            session_id: Some(id.into()),
            transcript_path: Some(transcript.display().to_string()),
            cwd: Some(cwd.display().to_string()),
            ..HookDrop::default()
        };
        let written = hook_drop::write_drop(
            &hook_drop::drop_dir(&self.state),
            &drop,
            hook_drop::now_ms(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while written.exists() {
            assert!(tokio::time::Instant::now() < deadline, "hook never applied");
            self.daemon.hook_drop_tick_for_test();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A turn that ends: the pane has a bound conversation and is idle.
    async fn finished_turn(
        &self,
        pane: u32,
        agent: proto::AgentKind,
        id: &str,
        transcript: &Path,
        cwd: &Path,
    ) {
        for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
            self.hook(pane, agent, event, id, transcript, cwd).await;
        }
    }

    /// A Claude pane with a conversation and a subagent transcript beside it.
    async fn claude_pane(&self, project_dir: &Path) -> (proto::SessionInfo, String, PathBuf) {
        let pane = self.pane(proto::AgentKind::Claude, project_dir);
        let argv = self.argv(pane.id).await;
        let id = argv
            .windows(2)
            .find(|pair| pair[0] == "--session-id")
            .map(|pair| pair[1].clone())
            .expect("Claude panes start with a preassigned session id");
        let folder = self.claude.join("projects").join(
            houston_core::transfer::transcripts::claude_project_folder(project_dir),
        );
        let transcript = folder.join(format!("{id}.jsonl"));
        write(&transcript, "{\"turn\":\"from A\"}\n");
        write(&folder.join(&id).join("subagents/agent-1.jsonl"), "{}\n");
        self.finished_turn(
            pane.id,
            proto::AgentKind::Claude,
            &id,
            &transcript,
            project_dir,
        )
        .await;
        (pane, id, transcript)
    }

    async fn codex_pane(&self, project_dir: &Path) -> (proto::SessionInfo, String, PathBuf) {
        let pane = self.pane(proto::AgentKind::Codex, project_dir);
        self.argv(pane.id).await;
        let id = uuid::Uuid::new_v4().to_string();
        let transcript = self.codex.join(format!(
            "sessions/2026/10/21/rollout-2026-10-21T00-00-00-{id}.jsonl"
        ));
        write(&transcript, "{\"turn\":\"codex on A\"}\n");
        self.finished_turn(
            pane.id,
            proto::AgentKind::Codex,
            &id,
            &transcript,
            project_dir,
        )
        .await;
        (pane, id, transcript)
    }

    async fn send(&mut self, msg: proto::ClientMsg) {
        self.ws
            .send(Message::text(serde_json::to_string(&msg).unwrap()))
            .await
            .unwrap();
    }

    /// The reply to one transfer request, skipping progress and broadcasts.
    async fn reply(&mut self, request: u32) -> proto::ServerMsg {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "no reply to transfer request {request}"
            );
            match common::next_control(&mut self.ws).await {
                proto::ServerMsg::TransferProgress { .. } => {}
                msg @ (proto::ServerMsg::TransferExported { request: r, .. }
                | proto::ServerMsg::TransferInspected { request: r, .. }
                | proto::ServerMsg::TransferImported { request: r, .. }
                | proto::ServerMsg::TransferRefused { request: r, .. })
                    if r == request =>
                {
                    return msg
                }
                proto::ServerMsg::Error { message, context }
                    if context.as_deref() == Some(&format!("transfer:{request}")) =>
                {
                    panic!("transfer request {request} failed: {message}")
                }
                _ => {}
            }
        }
    }

    fn request(&mut self) -> u32 {
        self.next_request += 1;
        self.next_request
    }

    async fn export(
        &mut self,
        file: &Path,
        grids: &str,
    ) -> Result<proto::TransferExportSummary, proto::TransferRefusal> {
        let request = self.request();
        self.send(proto::ClientMsg::TransferExport {
            request,
            workspace: self.workspace.display().to_string(),
            destination: file.display().to_string(),
            passphrase: proto::TransferPassphrase::new(PASSPHRASE),
            grids: grids.to_string(),
        })
        .await;
        match self.reply(request).await {
            proto::ServerMsg::TransferExported { summary, .. } => Ok(summary),
            proto::ServerMsg::TransferRefused { refusal, .. } => Err(refusal),
            other => panic!("unexpected reply {other:?}"),
        }
    }

    async fn inspect(
        &mut self,
        file: &Path,
        passphrase: &str,
    ) -> Result<proto::TransferFileSummary, proto::TransferRefusal> {
        let request = self.request();
        self.send(proto::ClientMsg::TransferInspect {
            request,
            path: file.display().to_string(),
            passphrase: proto::TransferPassphrase::new(passphrase),
        })
        .await;
        match self.reply(request).await {
            proto::ServerMsg::TransferInspected { summary, .. } => Ok(summary),
            proto::ServerMsg::TransferRefused { refusal, .. } => Err(refusal),
            other => panic!("unexpected reply {other:?}"),
        }
    }

    async fn import(
        &mut self,
        file: &Path,
    ) -> Result<proto::TransferImportResult, proto::TransferRefusal> {
        let request = self.request();
        self.send(proto::ClientMsg::TransferImport {
            request,
            path: file.display().to_string(),
            passphrase: proto::TransferPassphrase::new(PASSPHRASE),
            workspace: self.workspace.display().to_string(),
            profiles: Vec::new(),
        })
        .await;
        match self.reply(request).await {
            proto::ServerMsg::TransferImported { result, .. } => Ok(result),
            proto::ServerMsg::TransferRefused { refusal, .. } => Err(refusal),
            other => panic!("unexpected reply {other:?}"),
        }
    }

    fn info(&self, id: u32) -> proto::SessionInfo {
        self.daemon
            .list()
            .into_iter()
            .find(|info| info.id == id)
            .unwrap_or_else(|| panic!("pane {id} is not listed"))
    }

    async fn screen_contains(&self, id: u32, needle: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let text = self
                .daemon
                .scrollback(id, Some(64 * 1024))
                .map(|replay| String::from_utf8_lossy(&replay.data).into_owned())
                .unwrap_or_default();
            if text.contains(needle) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "pane {id} never showed {needle:?}: {text:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Computer {
    fn drop(&mut self) {
        for pane in self.daemon.list() {
            let _ = self.daemon.close(pane.id);
        }
    }
}

/// Computer A's workspace: a local commit on `feature`, an edited tracked file, an
/// untracked file, and a Houston worktree with its own local commit.
fn work_on_a(a: &Computer) -> PathBuf {
    git(&a.workspace, &["checkout", "-q", "-b", "feature"]);
    write(&a.workspace.join("src/lib.rs"), "pub fn a() {}\n");
    git(&a.workspace, &["add", "."]);
    git(&a.workspace, &["commit", "-q", "-m", "local work on A"]);
    write(&a.workspace.join("README.md"), "first\nedited on A\n");
    write(&a.workspace.join("notes/todo.txt"), "untracked on A\n");
    let worktrees = a.workspace.join(".houston/worktrees");
    write(&worktrees.join(".gitignore"), "*\n");
    git(
        &a.workspace,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "houston/wt",
            ".houston/worktrees/wt",
        ],
    );
    let tree = worktrees.join("wt").canonicalize().unwrap();
    write(&tree.join("wt.rs"), "fn wt() {}\n");
    git(&tree, &["add", "."]);
    git(&tree, &["commit", "-q", "-m", "worktree work"]);
    write(&tree.join("scratch.txt"), "untracked in the worktree\n");
    tree
}

fn mapped(result: &[proto::TransferSessionMapping], from: u32) -> u32 {
    result
        .iter()
        .find(|m| m.from == from)
        .unwrap_or_else(|| panic!("pane {from} is not mapped: {result:?}"))
        .to
}

#[tokio::test]
async fn a_workspace_moves_to_another_computer_and_returns_in_place() {
    let _serial = SERIAL.lock().await;
    let world = tempfile::tempdir().unwrap();
    let origin = origin(world.path());
    let mut a = Computer::new(&origin, "2.1.310 (Claude Code)", "codex-cli 0.142.3").await;
    let mut b = Computer::new(&origin, "2.1.310 (Claude Code)", "codex-cli 0.142.3").await;
    let tree = work_on_a(&a);
    let (claude_a, claude_id, claude_transcript_a) = a.claude_pane(&a.workspace).await;
    let (codex_a, codex_id, _) = a.codex_pane(&tree).await;
    let shell = a.pane(proto::AgentKind::Shell, &a.workspace);
    // The Changes panel makes its worktrees in Houston's state directory, outside the workspace.
    let (side, _) = a
        .daemon
        .git_worktree_create(&a.workspace, "side", None)
        .unwrap();
    let (changes_pane, _, _) = a.claude_pane(&side.path.canonicalize().unwrap()).await;
    let a_head = git(&a.workspace, &["rev-parse", "HEAD"]);
    let tree_head = git(&tree, &["rev-parse", "HEAD"]);

    let file = world.path().join("work.houston-transfer");
    let grids = r#"{"tr-grids":"opaque"}"#;
    let exported = a.export(&file, grids).await.expect("export");
    assert_eq!(exported.panes.len(), 2, "{exported:?}");
    assert!(
        exported
            .skipped
            .iter()
            .any(|s| s.session == shell.id && s.reason == "shell pane"),
        "{:?}",
        exported.skipped
    );
    assert!(
        exported.skipped.iter().any(|s| s.session == changes_pane.id
            && s.reason
                == "worktree created from the Changes panel lives outside the workspace; \
                    this version moves only .houston/worktrees worktrees"),
        "a pane in a Changes-panel worktree is listed, never dropped: {:?}",
        exported.skipped
    );
    assert!(
        a.info(changes_pane.id).state.is_live(),
        "a skipped pane keeps running"
    );
    for pane in [claude_a.id, codex_a.id] {
        let info = a.info(pane);
        assert_eq!(
            info.state,
            proto::SessionState::Exited,
            "pane {pane} stops after export"
        );
        assert!(
            info.transferred_at_ms.is_some(),
            "pane {pane} carries the transferred marker"
        );
        assert!(
            info.resumable,
            "pane {pane} keeps its conversation for a fork or a return"
        );
    }

    let summary = b.inspect(&file, PASSPHRASE).await.expect("inspect");
    assert_eq!(
        summary.proposed_workspace.as_deref(),
        Some(b.workspace.to_str().unwrap())
    );
    assert!(!summary.return_trip);
    assert_eq!(summary.source_os, std::env::consts::OS);
    assert!(
        summary
            .cli_versions
            .iter()
            .any(|v| v.provider == proto::AgentKind::Claude
                && v.version.as_deref() == Some("2.1.310"))
    );

    let imported = b.import(&file).await.expect("import");
    assert_eq!(imported.grids.as_deref(), Some(grids));
    assert!(imported.updated_in_place.is_empty());
    assert_eq!(git(&b.workspace, &["rev-parse", "HEAD"]), a_head);
    assert_eq!(git(&b.workspace, &["branch", "--show-current"]), "feature");
    assert_eq!(
        std::fs::read_to_string(b.workspace.join("README.md")).unwrap(),
        "first\nedited on A\n"
    );
    assert_eq!(
        std::fs::read_to_string(b.workspace.join("notes/todo.txt")).unwrap(),
        "untracked on A\n"
    );
    let b_tree = b.workspace.join(".houston/worktrees/wt");
    assert_eq!(git(&b_tree, &["rev-parse", "HEAD"]), tree_head);
    assert_eq!(git(&b_tree, &["branch", "--show-current"]), "houston/wt");
    assert!(b_tree.join("scratch.txt").is_file());

    let claude_b = mapped(&imported.sessions, claude_a.id);
    let codex_b = mapped(&imported.sessions, codex_a.id);
    let claude_argv = b.argv(claude_b).await;
    assert!(
        claude_argv
            .windows(2)
            .any(|p| p[0] == "--resume" && p[1] == claude_id),
        "{claude_argv:?}"
    );
    let codex_argv = b.argv(codex_b).await;
    assert_eq!(&codex_argv[..2], ["resume".to_string(), codex_id.clone()]);
    assert!(codex_argv.contains(&format!("cwd:{}", b_tree.canonicalize().unwrap().display())));
    let claude_folder =
        b.claude
            .join("projects")
            .join(houston_core::transfer::transcripts::claude_project_folder(
                &b.workspace,
            ));
    let claude_transcript_b = claude_folder.join(format!("{claude_id}.jsonl"));
    assert_eq!(
        std::fs::read(&claude_transcript_b).unwrap(),
        std::fs::read(&claude_transcript_a).unwrap(),
        "transcripts are copied byte for byte"
    );
    assert!(claude_folder
        .join(&claude_id)
        .join("subagents/agent-1.jsonl")
        .is_file());
    assert!(b
        .codex
        .join(format!(
            "sessions/2026/10/21/rollout-2026-10-21T00-00-00-{codex_id}.jsonl"
        ))
        .is_file());
    b.screen_contains(claude_b, "this project moved from").await;

    // B continues: a new turn, a commit and an untracked file.
    std::fs::write(
        &claude_transcript_b,
        "{\"turn\":\"from A\"}\n{\"turn\":\"on B\"}\n",
    )
    .unwrap();
    b.finished_turn(
        claude_b,
        proto::AgentKind::Claude,
        &claude_id,
        &claude_transcript_b,
        &b.workspace,
    )
    .await;
    let codex_rollout_b = b.codex.join(format!(
        "sessions/2026/10/21/rollout-2026-10-21T00-00-00-{codex_id}.jsonl"
    ));
    b.finished_turn(
        codex_b,
        proto::AgentKind::Codex,
        &codex_id,
        &codex_rollout_b,
        &b_tree.canonicalize().unwrap(),
    )
    .await;
    git(&b.workspace, &["commit", "-q", "-am", "work on B"]);
    write(&b.workspace.join("from-b.txt"), "untracked on B\n");
    let b_head = git(&b.workspace, &["rev-parse", "HEAD"]);

    let back = world.path().join("back.houston-transfer");
    b.export(&back, "{}").await.expect("export from B");
    let summary = a.inspect(&back, PASSPHRASE).await.expect("inspect on A");
    assert!(summary.return_trip);
    assert_eq!(
        summary.proposed_workspace.as_deref(),
        Some(a.workspace.to_str().unwrap())
    );

    let returned = a.import(&back).await.expect("return trip");
    assert!(returned.sessions.is_empty(), "{returned:?}");
    assert_eq!(returned.grids, None);
    assert_eq!(returned.updated_in_place.len(), 2);
    assert_eq!(git(&a.workspace, &["rev-parse", "HEAD"]), b_head);
    assert_eq!(
        std::fs::read_to_string(a.workspace.join("README.md")).unwrap(),
        "first\nedited on A\n"
    );
    assert!(a.workspace.join("from-b.txt").is_file());
    assert!(a.workspace.join("notes/todo.txt").is_file());
    assert_eq!(
        std::fs::read_to_string(&claude_transcript_a).unwrap(),
        "{\"turn\":\"from A\"}\n{\"turn\":\"on B\"}\n",
        "the return trip writes the newer transcript where A's pane reads it"
    );
    let resumed = mapped(&returned.updated_in_place, claude_b);
    let info = a.info(resumed);
    assert_eq!(info.transferred_at_ms, None);
    assert!(!info.transfer_fork);
    let argv = a.argv(resumed).await;
    assert!(
        argv.windows(2)
            .any(|p| p[0] == "--resume" && p[1] == claude_id),
        "{argv:?}"
    );
}

#[tokio::test]
async fn a_respawned_transferred_pane_is_a_fork_and_blocks_the_return_trip() {
    let _serial = SERIAL.lock().await;
    let world = tempfile::tempdir().unwrap();
    let origin = origin(world.path());
    let mut a = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let mut b = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let (claude_a, id, _) = a.claude_pane(&a.workspace).await;
    let file = world.path().join("t.houston-transfer");
    a.export(&file, "{}").await.unwrap();
    let imported = b.import(&file).await.unwrap();
    let claude_b = mapped(&imported.sessions, claude_a.id);
    b.argv(claude_b).await;
    let transcript = b
        .claude
        .join("projects")
        .join(houston_core::transfer::transcripts::claude_project_folder(
            &b.workspace,
        ))
        .join(format!("{id}.jsonl"));
    b.finished_turn(
        claude_b,
        proto::AgentKind::Claude,
        &id,
        &transcript,
        &b.workspace,
    )
    .await;

    let fork = a
        .daemon
        .respawn(claude_a.id, false, None, None, false)
        .unwrap();
    assert!(
        fork.transfer_fork,
        "a respawned transferred pane continues a fork"
    );
    let back = world.path().join("back.houston-transfer");
    b.export(&back, "{}").await.expect("export from B");
    let refusal = a
        .import(&back)
        .await
        .expect_err("the fork blocks the return trip");
    assert_eq!(refusal.code, Code::ReturnForked);
    assert!(
        refusal.items[0].contains(&format!("pane {}", fork.id)),
        "{refusal:?}"
    );
    assert!(refusal.steps[0].contains("Close or kill"), "{refusal:?}");

    // Killing the fork gives its conversation up: the returning one opens in a new pane.
    a.daemon.kill(fork.id).unwrap();
    let returned = a
        .import(&back)
        .await
        .expect("import after the fork is killed");
    assert_eq!(returned.sessions.len(), 1, "{returned:?}");
    assert!(returned.updated_in_place.is_empty());
}

#[tokio::test]
async fn refusals_name_what_is_wrong_and_the_steps_that_remove_it() {
    let _serial = SERIAL.lock().await;
    let world = tempfile::tempdir().unwrap();
    let origin = origin(world.path());
    let mut a = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let mut b = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let mut old = Computer::new(&origin, "2.1.100", "0.142.3").await;
    let file = world.path().join("t.houston-transfer");

    // Busy: a turn in progress names the pane and its status.
    let busy = a.pane(proto::AgentKind::Claude, &a.workspace);
    let argv = a.argv(busy.id).await;
    let id = argv.windows(2).find(|p| p[0] == "--session-id").unwrap()[1].clone();
    let transcript = a
        .claude
        .join("projects")
        .join(houston_core::transfer::transcripts::claude_project_folder(
            &a.workspace,
        ))
        .join(format!("{id}.jsonl"));
    write(&transcript, "{}\n");
    for event in ["SessionStart", "UserPromptSubmit"] {
        a.hook(
            busy.id,
            proto::AgentKind::Claude,
            event,
            &id,
            &transcript,
            &a.workspace,
        )
        .await;
    }
    let refusal = a.export(&file, "{}").await.unwrap_err();
    assert_eq!(refusal.code, Code::BusyPanes);
    assert_eq!(
        refusal.items,
        vec![format!("{} (pane {}): working", busy.title, busy.id)]
    );
    a.hook(
        busy.id,
        proto::AgentKind::Claude,
        "Stop",
        &id,
        &transcript,
        &a.workspace,
    )
    .await;

    // A commit the other computer lacks: pushed after B cloned, then built on locally.
    write(
        &a.workspace.join("pushed.txt"),
        "pushed
",
    );
    git(&a.workspace, &["add", "."]);
    git(&a.workspace, &["commit", "-q", "-m", "pushed later"]);
    git(&a.workspace, &["push", "-q", "origin", "HEAD:main"]);
    let pushed = git(&a.workspace, &["rev-parse", "HEAD"]);
    write(
        &a.workspace.join("local.txt"),
        "local
",
    );
    git(&a.workspace, &["add", "."]);
    git(&a.workspace, &["commit", "-q", "-m", "local"]);
    write(
        &a.workspace.join("build.log"),
        "A's log
",
    );
    a.export(&file, "{}").await.expect("export");
    // B ignores a build.log of its own where the transfer carries an untracked one.
    write(
        &b.workspace.join(".git/info/exclude"),
        "build.log
",
    );
    write(
        &b.workspace.join("build.log"),
        "B's log
",
    );

    let refusal = b.inspect(&file, "not the passphrase").await.unwrap_err();
    assert_eq!(refusal.code, Code::WrongPassphrase);
    assert_eq!(
        refusal.problem,
        "The passphrase is wrong or the file is damaged."
    );

    let refusal = old.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::CliTooOld);
    assert!(
        refusal.problem.contains("2.1.100") && refusal.problem.contains("2.1.307"),
        "{refusal:?}"
    );

    let refusal = b.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::MissingCommits);
    assert_eq!(refusal.items, vec![pushed.clone()]);
    assert!(
        refusal.steps[0].starts_with("Run git fetch in"),
        "{refusal:?}"
    );
    git(&b.workspace, &["fetch", "-q", "origin"]);

    write(
        &b.workspace.join("README.md"),
        "dirty on B
",
    );
    let refusal = b.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::DirtyCheckout);
    assert_eq!(refusal.items, vec!["README.md".to_string()]);
    assert!(
        refusal.steps[0].contains("Commit, stash or discard"),
        "{refusal:?}"
    );
    git(&b.workspace, &["checkout", "-q", "--", "README.md"]);

    git(
        &b.workspace,
        &["commit", "-q", "--allow-empty", "-m", "B only"],
    );
    let refusal = b.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::BranchDiverged);
    assert!(refusal.items[0].starts_with("main:"), "{refusal:?}");
    git(&b.workspace, &["checkout", "-q", "--detach"]);
    git(&b.workspace, &["branch", "-q", "-D", "main"]);

    let refusal = b.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::PathsExist);
    assert_eq!(refusal.items, vec!["build.log".to_string()]);
    assert_eq!(
        std::fs::read_to_string(b.workspace.join("build.log")).unwrap(),
        "B's log
"
    );
    std::fs::remove_file(b.workspace.join("build.log")).unwrap();

    let imported = b.import(&file).await.expect("import after every fix");
    assert_eq!(imported.sessions.len(), 1);
    assert_eq!(
        git(&b.workspace, &["rev-parse", "HEAD"]),
        git(&a.workspace, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        std::fs::read_to_string(b.workspace.join("build.log")).unwrap(),
        "A's log
"
    );
    let refusal = b.import(&file).await.unwrap_err();
    assert_eq!(refusal.code, Code::ConversationOpen, "{refusal:?}");

    // A file from another operating system is refused by name.
    let mut manifest = houston_core::transfer::archive::read_manifest(&file, PASSPHRASE).unwrap();
    manifest.source_os = "plan9".into();
    let foreign = world.path().join("foreign.houston-transfer");
    houston_core::transfer::archive::write(&foreign, PASSPHRASE, &manifest, &[]).unwrap();
    let refusal = old.import(&foreign).await.unwrap_err();
    assert_eq!(refusal.code, Code::OtherOperatingSystem);
    assert!(refusal.problem.contains("plan9"), "{refusal:?}");
}

#[tokio::test]
async fn a_changed_tree_on_the_exporting_computer_blocks_the_return_trip() {
    let _serial = SERIAL.lock().await;
    let world = tempfile::tempdir().unwrap();
    let origin = origin(world.path());
    let mut a = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let mut b = Computer::new(&origin, "2.1.307", "0.142.3").await;
    let (claude_a, id, _) = a.claude_pane(&a.workspace).await;
    let file = world.path().join("t.houston-transfer");
    a.export(&file, "{}").await.unwrap();
    let imported = b.import(&file).await.unwrap();
    let claude_b = mapped(&imported.sessions, claude_a.id);
    b.argv(claude_b).await;
    let transcript = b
        .claude
        .join("projects")
        .join(houston_core::transfer::transcripts::claude_project_folder(
            &b.workspace,
        ))
        .join(format!("{id}.jsonl"));
    b.finished_turn(
        claude_b,
        proto::AgentKind::Claude,
        &id,
        &transcript,
        &b.workspace,
    )
    .await;
    let back = world.path().join("back.houston-transfer");
    b.export(&back, "{}").await.unwrap();

    write(
        &a.workspace.join("README.md"),
        "edited on A after the export\n",
    );
    let refusal = a.import(&back).await.unwrap_err();
    assert_eq!(refusal.code, Code::ReturnTreeChanged);
    assert_eq!(
        refusal.items,
        vec!["README.md (changed after the export)".to_string()]
    );
    assert!(
        refusal.steps[1].contains("another workspace"),
        "{refusal:?}"
    );
}

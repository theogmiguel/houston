#![cfg(unix)]

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn shim_dir() {
    SHIM.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap().keep();
        for name in ["claude", "codex"] {
            let path = directory.join(name);
            std::fs::write(
                &path,
                r#"#!/bin/sh
out="$PROFILE_RESUME_ARGV_DIR/$HOUSTON_SESSION"
: > "$out.tmp"
for arg in "$@"; do printf '%s\n' "$arg" >> "$out.tmp"; done
printf 'env:CLAUDE_CONFIG_DIR=%s\n' "$CLAUDE_CONFIG_DIR" >> "$out.tmp"
printf 'env:CODEX_HOME=%s\n' "$CODEX_HOME" >> "$out.tmp"
mv "$out.tmp" "$out"
exec cat
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let inherited = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{inherited}", directory.display()));
        directory
    });
}

struct Fixture {
    state: tempfile::TempDir,
    argv: tempfile::TempDir,
    daemon: Arc<Daemon>,
    workspace: PathBuf,
    original: PathBuf,
    replacement: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        shim_dir();
        let state = tempfile::tempdir().unwrap();
        let argv = tempfile::tempdir().unwrap();
        std::env::set_var("PROFILE_RESUME_ARGV_DIR", argv.path());
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
        let workspace = state.path().join("workspace");
        let original = state.path().join("profile-original");
        let replacement = state.path().join("profile-replacement");
        for path in [&workspace, &original, &replacement] {
            std::fs::create_dir_all(path).unwrap();
        }
        let daemon = Daemon::new(DaemonConfig {
            token: "profile-resume-test-token".into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        Self {
            state,
            argv,
            daemon,
            workspace,
            original,
            replacement,
        }
    }

    fn db(&self) -> Db {
        Db::open(&self.state.path().join("test.db")).unwrap()
    }

    fn profile(&self, agent: proto::AgentKind, id: Option<u32>, directory: &Path) -> u32 {
        let proto::ServerMsg::AgentProfileState { profiles, .. } = self
            .daemon
            .agent_profile_upsert(id, agent, "work", directory.to_str().unwrap())
            .unwrap()
        else {
            panic!("upsert must return profile state");
        };
        profiles
            .iter()
            .find(|profile| profile.agent == agent && profile.name == "work")
            .unwrap()
            .id
    }

    async fn argv(&self, session: u32) -> Vec<String> {
        let path = self.argv.path().join(session.to_string());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                return contents.lines().map(str::to_string).collect();
            }
            assert!(tokio::time::Instant::now() < deadline, "CLI never launched");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn hook(&self, pane: u32, agent: proto::AgentKind, event: &str, id: &str, path: &Path) {
        let drop = HookDrop {


            event: event.into(),
            session: pane,
            agent: Some(houston_core::agent_hooks::provider_slug(agent).into()),
            session_id: Some(id.into()),
            transcript_path: Some(path.display().to_string()),
            cwd: Some(self.workspace.display().to_string()),
            ..HookDrop::default()
        };
        let written = hook_drop::write_drop(
            &hook_drop::drop_dir(self.state.path()),
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for pane in self.daemon.list() {
            let _ = self.daemon.close(pane.id);
        }
    }
}

async fn changed_profile_does_not_resume(recreate: bool) {
    for agent in [proto::AgentKind::Claude, proto::AgentKind::Codex] {
        let fixture = Fixture::new();
        let profile = fixture.profile(agent, None, &fixture.original);
        let pane = fixture
            .daemon
            .create_session(CreateParams {
                agent,
                project_dir: fixture.workspace.clone(),
                cmd: None,
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: Some(proto::ProfileChoice::Profile { id: profile }),
                prompt: None,
                model: None,
                effort: None,
            })
            .unwrap();
        let argv = fixture.argv(pane.id).await;
        let conversation = argv
            .windows(2)
            .find(|pair| pair[0] == "--session-id")
            .map(|pair| pair[1].clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let transcript_directory = fixture.original.join(match agent {
            proto::AgentKind::Claude => "projects/workspace",
            proto::AgentKind::Codex => "sessions",
            _ => unreachable!(),
        });
        std::fs::create_dir_all(&transcript_directory).unwrap();
        let transcript = transcript_directory.join(format!("{conversation}.jsonl"));
        std::fs::write(&transcript, b"{}\n").unwrap();
        fixture
            .hook(pane.id, agent, "SessionStart", &conversation, &transcript)
            .await;
        fixture
            .hook(
                pane.id,
                agent,
                "UserPromptSubmit",
                &conversation,
                &transcript,
            )
            .await;
        assert!(fixture
            .db()
            .session_resume_handle(pane.id)
            .unwrap()
            .is_some());

        if recreate {
            fixture.daemon.agent_profile_delete(profile).unwrap();
        }
        fixture.profile(agent, (!recreate).then_some(profile), &fixture.replacement);

        // The old CLI can finish another turn after the profile configuration changes.
        for event in ["UserPromptSubmit", "Stop"] {
            fixture
                .hook(pane.id, agent, event, &conversation, &transcript)
                .await;
        }
        let restarted = fixture
            .daemon
            .respawn(pane.id, false, None, None, true)
            .unwrap();
        let argv = fixture.argv(restarted.id).await;
        assert!(
            !argv.iter().any(|arg| arg == "resume" || arg == "--resume"),
            "{agent:?}: changing the profile namespace must start fresh: {argv:?}"
        );
        assert!(!restarted.resumable);
        assert!(fixture
            .db()
            .session_resume_handle(restarted.id)
            .unwrap()
            .is_none());
        let expected = match agent {
            proto::AgentKind::Claude => "CLAUDE_CONFIG_DIR",
            proto::AgentKind::Codex => "CODEX_HOME",
            _ => unreachable!(),
        };
        assert!(argv.contains(&format!("env:{expected}={}", fixture.replacement.display())));

        let next = fixture
            .daemon
            .respawn(restarted.id, false, None, None, true)
            .unwrap();
        assert!(
            !fixture
                .argv(next.id)
                .await
                .iter()
                .any(|arg| arg == "resume" || arg == "--resume"),
            "a second restart must not recover the discarded namespace"
        );
    }
}

#[tokio::test]
async fn editing_a_profiles_directory_discards_the_original_conversation() {
    let _serial = SERIAL.lock().await;
    changed_profile_does_not_resume(false).await;
}

#[tokio::test]
async fn recreating_a_profile_name_in_another_directory_discards_the_original_conversation() {
    let _serial = SERIAL.lock().await;
    changed_profile_does_not_resume(true).await;
}

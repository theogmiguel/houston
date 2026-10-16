#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
#[cfg(unix)]
use crate::common;
use houston_core::{db::Db, generated_title};
use houston_protocol::{AgentKind, TitleSource};

#[test]
fn excerpt_redacts_short_structured_credentials_before_truncation() {
    for (input, secret) in [
        ("password=hunter2", "hunter2"),
        ("token=abc", "abc"),
        ("https://user:urlpass@example.invalid/task", "urlpass"),
        ("Authorization: Bearer shortauth", "shortauth"),
    ] {
        for (first_prompt, first_reply) in [(input, "reply"), ("prompt", input)] {
            let prompt = generated_title::prompt(first_prompt, first_reply);
            assert!(!prompt.contains(secret), "unredacted credential: {input}");
            assert!(prompt.contains("[redacted:"));
        }
    }
    let prompt = generated_title::prompt(&format!("{}password=hunter2", "x ".repeat(235)), "reply");
    assert!(!prompt.contains("hunter"));
}

#[test]
fn generator_contract_is_bounded_redacted_and_refuses_unverified_providers() {
    let prompt = generated_title::prompt(
        &format!("token ghp_{} {}", "a".repeat(36), "é".repeat(2000)),
        "Reply",
    );
    assert!(!prompt.contains(&format!("ghp_{}", "a".repeat(36))));
    let excerpt = prompt
        .split("<excerpt>\n")
        .nth(1)
        .unwrap()
        .split("\n</excerpt>")
        .next()
        .unwrap();
    assert!(excerpt.len() <= 1024);
    for provider in [
        AgentKind::Codex,
        AgentKind::Opencode,
        AgentKind::Cursor,
        AgentKind::Grok,
        AgentKind::Antigravity,
        AgentKind::Zcode,
    ] {
        assert!(generated_title::argv(provider, prompt.clone())
            .unwrap_err()
            .to_string()
            .contains(&format!("{provider:?}")));
    }
    let argv = generated_title::argv(AgentKind::Claude, prompt).unwrap();
    assert!(argv.windows(2).any(|pair| pair == ["--tools", ""]));
    for flag in [
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ] {
        assert!(argv.iter().any(|arg| arg == flag));
    }
    assert!(TitleSource::Prompt < TitleSource::Auto && TitleSource::Auto < TitleSource::Role);
    assert_eq!(TitleSource::parse("auto"), Some(TitleSource::Auto));
    assert!(generated_title::parse("one\ntwo").is_err());
    assert!(generated_title::parse(&"x".repeat(41)).is_err());
    assert_eq!(
        generated_title::parse("Repair parser\r\n").unwrap(),
        "Repair parser"
    );
}

#[test]
fn missing_or_closed_sessions_cannot_claim_a_generation_slot() {
    let state = tempfile::tempdir().unwrap();
    let db = Db::open(&state.path().join("test.db")).unwrap();
    assert!(!db.claim_title_generation(999).unwrap());
    assert!(!db.claim_title_first_turn(999).unwrap());
}

#[test]
fn a_rename_reset_close_or_stronger_source_discards_a_pending_result() {
    use houston_protocol::SessionState;
    assert!(generated_title::accepts_result(
        1,
        1,
        TitleSource::Prompt,
        SessionState::Running
    ));
    // A user rename followed by reset can restore the same prompt while advancing the revision.
    assert!(!generated_title::accepts_result(
        1,
        3,
        TitleSource::Prompt,
        SessionState::Running
    ));
    for source in [
        TitleSource::Auto,
        TitleSource::Role,
        TitleSource::Cli,
        TitleSource::Task,
        TitleSource::User,
    ] {
        assert!(!generated_title::accepts_result(
            1,
            1,
            source,
            SessionState::Running
        ));
    }
    for state in [
        SessionState::Exited,
        SessionState::Killed,
        SessionState::Sleeping,
        SessionState::Interrupted,
    ] {
        assert!(!generated_title::accepts_result(
            1,
            1,
            TitleSource::Prompt,
            state
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn hook_only_generation_preserves_source_priority_and_freezes_the_generated_title() {
    use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
    use houston_core::hook_drop::{self, HookDrop};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    let state = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let shim = state.path().join("claude");
    std::fs::write(&shim, "#!/bin/sh\nsleep 0.2\nprintf 'Repair parser\\n'\n").unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", state.path().display()));
    let daemon = Daemon::new(DaemonConfig::new(
        "generated-title-test".into(),
        state.path().join("test.db"),
        common::base_env(),
    ))
    .unwrap();
    assert!(!daemon.generated_titles_enabled());
    let mut rx = daemon.subscribe();
    let session = daemon
        .create_session(CreateParams {
            agent: AgentKind::Custom,
            project_dir: workspace.path().into(),
            cmd: Some(vec!["sleep".into(), "30".into()]),
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
        .unwrap();
    for (event, prompt, last_message) in [
        ("UserPromptSubmit", Some("Fix parser"), None),
        ("Stop", None, Some("Parser fixed")),
    ] {
        let drop = HookDrop {
            agent: Some("claude".into()),
            event: event.into(),
            session: session.id,
            prompt: prompt.map(str::to_string),
            last_message: last_message.map(str::to_string),
            ..HookDrop::default()
        };
        let file = hook_drop::write_drop(
            &hook_drop::drop_dir(state.path()),
            &drop,
            hook_drop::now_ms(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while file.exists() {
            assert!(tokio::time::Instant::now() < deadline);
            daemon.hook_drop_tick_for_test();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    daemon.generate_title(session.id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let Outbound::Control(json) = rx.recv().await.unwrap() else {
                continue;
            };
            if let Ok(houston_protocol::ServerMsg::SessionRenamed {
                session: changed,
                title_source: TitleSource::Auto,
                ..
            }) = serde_json::from_str(&json)
            {
                if changed == session.id {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    let current = daemon
        .list()
        .into_iter()
        .find(|info| info.id == session.id)
        .unwrap();
    assert_eq!(current.title, "Repair parser");
    assert_eq!(current.title_source, TitleSource::Auto);
    daemon.rename(session.id, "Operator choice").unwrap();
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|info| info.id == session.id)
            .unwrap()
            .title,
        "Operator choice"
    );
    daemon.reset_title(session.id).unwrap();
    assert!(daemon
        .generate_title(session.id)
        .unwrap_err()
        .to_string()
        .contains("outranks"));
    daemon.close(session.id).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_claude_started_inside_a_shell_pane_gets_a_generated_title_after_its_first_turn() {
    use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
    use houston_core::hook_drop::{self, HookDrop};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    let state = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let shim = state.path().join("claude");
    std::fs::write(&shim, "#!/bin/sh\nprintf 'Repair parser\\n'\n").unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    let env = common::base_env();
    let path = env.var("PATH").unwrap_or_default();
    let daemon = Daemon::new(DaemonConfig::new(
        "generated-title-shell-test".into(),
        state.path().join("test.db"),
        env.with("PATH", Some(format!("{}:{path}", state.path().display()))),
    ))
    .unwrap();
    daemon.set_generated_titles(true).unwrap();
    let mut rx = daemon.subscribe();
    let session = daemon
        .create_session(CreateParams {
            agent: AgentKind::Shell,
            project_dir: workspace.path().into(),
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
        .unwrap();
    for (event, prompt, last_message) in [
        ("SessionStart", None, None),
        ("UserPromptSubmit", Some("Fix parser"), None),
        ("Stop", None, Some("Parser fixed")),
    ] {
        let drop = HookDrop {
            agent: Some("claude".into()),
            event: event.into(),
            session: session.id,
            prompt: prompt.map(str::to_string),
            last_message: last_message.map(str::to_string),
            ..HookDrop::default()
        };
        let file = hook_drop::write_drop(
            &hook_drop::drop_dir(state.path()),
            &drop,
            hook_drop::now_ms(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while file.exists() {
            assert!(tokio::time::Instant::now() < deadline);
            daemon.hook_drop_tick_for_test();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let renamed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let Outbound::Control(json) = rx.recv().await.unwrap() else {
                continue;
            };
            if let Ok(houston_protocol::ServerMsg::SessionRenamed {
                session: changed,
                title,
                title_source: TitleSource::Auto,
            }) = serde_json::from_str(&json)
            {
                if changed == session.id {
                    break title;
                }
            }
        }
    })
    .await;
    let current = daemon
        .list()
        .into_iter()
        .find(|info| info.id == session.id)
        .unwrap();
    assert_eq!(current.detected_agent, Some(AgentKind::Claude));
    assert_eq!(
        renamed.ok().as_deref(),
        Some("Repair parser"),
        "shell-hosted Claude kept title {:?} from source {:?}; expected a generated title",
        current.title,
        current.title_source
    );
    daemon.close(session.id).unwrap();
}

#[cfg(unix)]
mod failed_generation {
    use super::*;
    use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
    use houston_core::hook_drop::{self, HookDrop};
    use houston_protocol::ServerMsg;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::time::Duration;

    /// A shell pane whose hosted Claude finished its first turn, with a title generator that
    /// prints 43 characters (the limit is 40) and then drops `generator-ran`.
    struct Rig {
        daemon: Arc<Daemon>,
        state: tempfile::TempDir,
        session: u32,
        rx: tokio::sync::broadcast::Receiver<Outbound>,
        _workspace: tempfile::TempDir,
    }

    async fn rig(automatic: bool) -> Rig {
        let state = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let shim = state.path().join("claude");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '{}\\n'\ntouch '{}'\n",
                "x".repeat(43),
                state.path().join("generator-ran").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = common::base_env();
        let path = env.var("PATH").unwrap_or_default();
        let daemon = Daemon::new(DaemonConfig::new(
            "generated-title-failure-test".into(),
            state.path().join("test.db"),
            env.with("PATH", Some(format!("{}:{path}", state.path().display()))),
        ))
        .unwrap();
        daemon.set_generated_titles(automatic).unwrap();
        let rx = daemon.subscribe();
        let session = daemon
            .create_session(CreateParams {
                agent: AgentKind::Shell,
                project_dir: workspace.path().into(),
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
            .id;
        for (event, prompt, last_message) in [
            ("SessionStart", None, None),
            ("UserPromptSubmit", Some("Fix parser"), None),
            ("Stop", None, Some("Parser fixed")),
        ] {
            let drop = HookDrop {
                agent: Some("claude".into()),
                event: event.into(),
                session,
                prompt: prompt.map(str::to_string),
                last_message: last_message.map(str::to_string),
                ..HookDrop::default()
            };
            let file = hook_drop::write_drop(
                &hook_drop::drop_dir(state.path()),
                &drop,
                hook_drop::now_ms(),
            )
            .unwrap();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while file.exists() {
                assert!(tokio::time::Instant::now() < deadline);
                daemon.hook_drop_tick_for_test();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        Rig {
            daemon,
            state,
            session,
            rx,
            _workspace: workspace,
        }
    }

    fn title(daemon: &Daemon, session: u32) -> String {
        daemon
            .list()
            .into_iter()
            .find(|info| info.id == session)
            .unwrap()
            .title
    }

    async fn generator_ran(state: &std::path::Path) {
        let marker = state.join("generator-ran");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "generator never ran"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn title_errors(rx: &mut tokio::sync::broadcast::Receiver<Outbound>) -> Vec<String> {
        let mut errors = Vec::new();
        while let Ok(outbound) = rx.try_recv() {
            let Outbound::Control(json) = outbound else {
                continue;
            };
            if let Ok(ServerMsg::Error { message, context }) = serde_json::from_str(&json) {
                if context.as_deref() == Some("session_title_generate") {
                    errors.push(message);
                }
            }
        }
        errors
    }

    #[tokio::test]
    async fn an_automatic_title_that_is_too_long_keeps_the_title_and_shows_no_error() {
        let mut r = rig(true).await;
        let before = title(&r.daemon, r.session);
        generator_ran(r.state.path()).await;
        // The completion path runs on the daemon's own thread after the generator exits.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(title(&r.daemon, r.session), before);
        let errors = title_errors(&mut r.rx);
        assert!(errors.is_empty(), "the operator was shown {errors:?}");
        r.daemon.close(r.session).unwrap();
    }

    #[tokio::test]
    async fn a_manual_title_that_is_too_long_names_the_limit_and_the_actual_length() {
        let mut r = rig(false).await;
        r.daemon.generate_title(r.session).unwrap();
        generator_ran(r.state.path()).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let errors = loop {
            let errors = title_errors(&mut r.rx);
            if !errors.is_empty() {
                break errors;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "a failed manual generation reported nothing"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(
            errors[0].contains("43 characters") && errors[0].contains("1–40"),
            "{errors:?}"
        );
        r.daemon.close(r.session).unwrap();
    }
}

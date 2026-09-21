#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{hermetic_command, next_broadcast_control, start_daemon_with_handle};

fn a_pane(daemon: &std::sync::Arc<Daemon>) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec!["sleep".into(), "30".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    (info, dir)
}

fn drop_for(event: &str, session: u32) -> HookDrop {
    HookDrop {
        v: hook_drop::DROP_V,
        event: event.to_string(),
        session,
        ..Default::default()
    }
}

async fn drop_and_await_apply(state: &Path, d: &HookDrop) {
    let path = hook_drop::write_drop(&hook_drop::drop_dir(state), d, hook_drop::now_ms()).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never applied {} — the drop file is still on disk",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn expect_context(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
) -> proto::SessionContext {
    loop {
        match next_broadcast_control(rx).await {
            proto::ServerMsg::SessionContext {
                session: s,
                context,
            } if s == session => {
                return context.expect("a SessionContext delta carries a value");
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

fn transcript(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    path
}

fn stop_with_transcript(session: u32, path: &Path) -> HookDrop {
    HookDrop {
        transcript_path: Some(path.display().to_string()),
        ..drop_for("Stop", session)
    }
}

mod context_indicator {
    use super::*;

    #[tokio::test]
    async fn changing_model_resolves_its_context_variant_without_respawning() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        for (model, window, percent) in [
            ("claude-sonnet-5[1m]", Some(1_000_000), Some(10)),
            ("claude-sonnet-5", Some(1_000_000), Some(10)),
            ("claude-haiku-4-5", Some(200_000), Some(50)),
            ("claude-unknown-custom-model", None, None),
        ] {
            let line = serde_json::json!({
                "type": "assistant",
                "message": { "model": model, "usage": { "input_tokens": 100_000 } }
            })
            .to_string();
            let path = transcript(dir.path(), "switch.jsonl", &[&line]);
            drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &path)).await;
            let context = expect_context(&mut rx, info.id).await;
            assert_eq!(context.window_tokens, window, "{model}");
            assert_eq!(context.used_percent, percent, "{model}");
        }
        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn codex_updates_the_reported_window_and_preserves_it_while_working() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();
        for (window, percent) in [(200_000, 50), (1_000_000, 10)] {
            let line = serde_json::json!({"type": "event_msg", "payload": {
                "type": "token_count", "info": {
                    "last_token_usage": {"total_tokens": 100_000},
                    "total_token_usage": {"total_tokens": 9_000_000},
                    "model_context_window": window
                }
            }})
            .to_string();
            let path = transcript(dir.path(), "codex.jsonl", &[&line]);
            let drop = HookDrop {
                agent: Some("codex".into()),
                ..stop_with_transcript(info.id, &path)
            };
            drop_and_await_apply(state.path(), &drop).await;
            let context = expect_context(&mut rx, info.id).await;
            assert_eq!(context.used_tokens, 100_000);
            assert_eq!(context.window_tokens, Some(window));
            assert_eq!(context.used_percent, Some(percent));
            assert_eq!(context.source, proto::ContextSource::Reported);
        }
        let prompt = HookDrop {
            agent: Some("codex".into()),
            ..drop_for("UserPromptSubmit", info.id)
        };
        drop_and_await_apply(state.path(), &prompt).await;
        let context = expect_context(&mut rx, info.id).await;
        assert_eq!(context.state, proto::ContextState::Working);
        assert_eq!(context.used_tokens, 100_000);
        assert_eq!(context.window_tokens, Some(1_000_000));
        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn a_cached_catalog_can_add_a_model_without_a_new_binary_or_network() {
        let state = tempfile::tempdir().unwrap();
        let cache = serde_json::json!({
            "fetched_at_ms": 1,
            "source": houston_core::model_catalog::CATALOG_URL,
            "document": {"claude-fixture": {
                "max_input_tokens": 500_000,
                "input_cost_per_token": 0.000001,
                "output_cost_per_token": 0.000002
            }}
        });
        std::fs::create_dir_all(state.path().join("usage")).unwrap();
        std::fs::write(
            houston_core::model_catalog::cache_path(state.path()),
            cache.to_string(),
        )
        .unwrap();
        let daemon = Daemon::new(houston_core::daemon::DaemonConfig {
            token: "test-token".into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        daemon
            .update_policy_set(proto::UpdatePolicy { check: false })
            .unwrap();
        daemon.refresh_model_catalog(false).await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();
        let path = transcript(
            dir.path(),
            "cached.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-fixture","usage":{"input_tokens":50000}}}"#,
            ],
        );
        hook_drop::write_drop(
            &hook_drop::drop_dir(state.path()),
            &stop_with_transcript(info.id, &path),
            hook_drop::now_ms(),
        )
        .unwrap();
        assert_eq!(daemon.hook_drop_tick_for_test(), 1);
        let context = expect_context(&mut rx, info.id).await;
        assert_eq!(context.window_tokens, Some(500_000));
        assert_eq!(context.used_percent, Some(10));

        let since = hook_drop::now_ms() as i64 + 86_400_000;
        let summary = daemon
            .usage_summary(since, since + 86_400_000, false)
            .unwrap();
        assert!(
            matches!(summary, proto::ServerMsg::UsageSummary { pricing, .. }
            if pricing.known_models == 1 && pricing.status == proto::UsagePricingStatus::Cached)
        );

        // A refreshed shared cache becomes visible to both consumers without a new daemon.
        let mut refreshed = cache;
        refreshed["fetched_at_ms"] = serde_json::json!(hook_drop::now_ms());
        refreshed["document"]["claude-fixture"]["max_input_tokens"] = serde_json::json!(250_000);
        refreshed["document"]["another-new-model"] = serde_json::json!({
            "max_input_tokens": 800_000, "input_cost_per_token": 0.000003,
            "output_cost_per_token": 0.000004
        });
        std::fs::write(
            houston_core::model_catalog::cache_path(state.path()),
            refreshed.to_string(),
        )
        .unwrap();
        let check_loop = tokio::spawn({
            let daemon = daemon.clone();
            async move { daemon.update_check_loop().await }
        });
        let updated = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                hook_drop::write_drop(
                    &hook_drop::drop_dir(state.path()),
                    &stop_with_transcript(info.id, &path),
                    hook_drop::now_ms(),
                )
                .unwrap();
                assert_eq!(daemon.hook_drop_tick_for_test(), 1);
                let context = expect_context(&mut rx, info.id).await;
                if context.window_tokens == Some(250_000) {
                    break context;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        check_loop.abort();
        let context = updated
            .expect("the scheduled cycle must load the shared catalog without opening Usage");
        assert_eq!(context.used_percent, Some(20));
        assert_eq!(daemon.update_state(), proto::UpdateState::Disabled);
        let summary = daemon
            .usage_summary(since, since + 86_400_000, false)
            .unwrap();
        assert!(
            matches!(summary, proto::ServerMsg::UsageSummary { pricing, .. }
            if pricing.known_models == 2)
        );
        assert!(!state.path().join("context-models.json").exists());
        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn turn_completes_broadcasts_context() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.used_tokens, 150_010);
        assert_eq!(ctx.window_tokens, Some(200_000));
        assert_eq!(ctx.used_percent, Some(75));
        assert_eq!(ctx.state, proto::ContextState::Idle);

        let listed = daemon.list();
        let row = listed.iter().find(|s| s.id == info.id).unwrap();
        assert_eq!(
            row.context.map(|c| c.used_tokens),
            Some(150_010),
            "SessionInfo carries the value too"
        );

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn compaction_sets_reset() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":180000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
                r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":180000,"postTokens":12000}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.used_tokens, 12_000);
        assert_eq!(ctx.state, proto::ContextState::Reset);

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn missing_transcript_is_unknown() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let missing = dir.path().join("does-not-exist.jsonl");
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &missing)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.state, proto::ContextState::Unknown);

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn working_keeps_last_value() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;
        let idle = expect_context(&mut rx, info.id).await;
        assert_eq!(idle.used_tokens, 150_010);

        drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
        let working = expect_context(&mut rx, info.id).await;
        assert_eq!(working.state, proto::ContextState::Working);
        assert_eq!(working.used_tokens, 150_010, "the last value is kept");

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn idle_carries_age() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.state, proto::ContextState::Idle);
        assert!(ctx.as_of_ms > 0, "an idle value carries when it was read");

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn unsupported_provider_has_no_context() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
            ],
        );
        let d = HookDrop {
            agent: Some("cursor".into()),
            transcript_path: Some(t.display().to_string()),
            ..drop_for("Stop", info.id)
        };
        drop_and_await_apply(state.path(), &d).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let listed = daemon.list();
        let row = listed.iter().find(|s| s.id == info.id).unwrap();
        assert!(
            row.context.is_none(),
            "an unsupported pane carries no context, even with a readable transcript"
        );

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn transcript_read_keeps_no_text() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":"SENTINEL-PROMPT-123"}}"#,
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;
        let ctx = expect_context(&mut rx, info.id).await;
        let serialized = serde_json::to_string(&ctx).unwrap();
        assert!(
            !serialized.contains("SENTINEL-PROMPT-123"),
            "context carries counts, never prompt text: {serialized}"
        );

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn claude_helper_forwards_snake_case_transcript_path() {
        helper_forwards_transcript(proto::AgentKind::Claude).await;
    }

    #[tokio::test]
    async fn codex_helper_forwards_reported_context_without_a_model_catalog() {
        helper_forwards_transcript(proto::AgentKind::Codex).await;
    }

    async fn helper_forwards_transcript(provider: proto::AgentKind) {
        let home = tempfile::tempdir().unwrap();
        let channel_dir = home.path().join(".houston-contexttest");
        std::fs::create_dir_all(&channel_dir).unwrap();

        let daemon = Daemon::new(houston_core::daemon::DaemonConfig {
            token: "test-token".to_string(),
            db_path: channel_dir.join("test.db"),
        })
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let info = daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Shell,
                project_dir: dir.path().to_path_buf(),
                cmd: Some(vec!["sleep".into(), "30".into()]),
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
            })
            .unwrap();
        let mut rx = daemon.observe();
        let transcript = dir.path().join("session.jsonl");
        let line = match provider {
            proto::AgentKind::Codex => {
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":150010},"total_token_usage":{"total_tokens":999999},"model_context_window":200000}}}"#
            }
            _ => {
                r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":10}}}"#
            }
        };
        std::fs::write(&transcript, line).unwrap();

        let mut helper = hermetic_command(env!("CARGO_BIN_EXE_tr-helper"), home.path());
        helper
            .args([
                "hook",
                "Stop",
                "--agent",
                houston_core::agent_hooks::provider_slug(provider),
            ])
            .env("HOUSTON_CHANNEL", "contexttest")
            .env("TR_SESSION", info.id.to_string())
            .current_dir(dir.path())
            .stdin(std::process::Stdio::piped());
        let mut child = helper.spawn().unwrap();
        std::io::Write::write_all(
            child.stdin.as_mut().unwrap(),
            serde_json::json!({"transcript_path": transcript})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());

        assert_eq!(daemon.hook_drop_tick_for_test(), 1);
        let context = expect_context(&mut rx, info.id).await;
        assert_eq!(context.used_tokens, 150_010);
        assert_eq!(context.window_tokens, Some(200_000));
        assert_eq!(
            context.source,
            if provider == proto::AgentKind::Codex {
                proto::ContextSource::Reported
            } else {
                proto::ContextSource::Derived
            }
        );
        assert_eq!(
            daemon
                .list()
                .into_iter()
                .find(|session| session.id == info.id)
                .unwrap()
                .detected_agent,
            Some(provider)
        );

        daemon.kill(info.id).ok();
    }
}

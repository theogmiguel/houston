#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{next_broadcast_control, start_daemon_with_handle};

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

mod context_downbar {
    use super::*;

    #[tokio::test]
    async fn turn_completes_broadcasts_context() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);
        let mut rx = daemon.observe();

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.used_tokens, 150_000);
        assert_eq!(ctx.window_tokens, Some(200_000));
        assert_eq!(ctx.used_percent, Some(75));
        assert_eq!(ctx.state, proto::ContextState::Idle);

        let listed = daemon.list();
        let row = listed.iter().find(|s| s.id == info.id).unwrap();
        assert_eq!(
            row.context.map(|c| c.used_tokens),
            Some(150_000),
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
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":180000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
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
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0,"output_tokens":10}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;
        let idle = expect_context(&mut rx, info.id).await;
        assert_eq!(idle.used_tokens, 150_000);

        drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
        let working = expect_context(&mut rx, info.id).await;
        assert_eq!(working.state, proto::ContextState::Working);
        assert_eq!(working.used_tokens, 150_000, "the last value is kept");

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
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
            ],
        );
        drop_and_await_apply(state.path(), &stop_with_transcript(info.id, &t)).await;

        let ctx = expect_context(&mut rx, info.id).await;
        assert_eq!(ctx.state, proto::ContextState::Idle);
        assert!(ctx.as_of_ms > 0, "an idle value carries when it was read");

        daemon.kill(info.id).ok();
    }

    #[tokio::test]
    async fn non_claude_provider_stays_not_tracked() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, dir) = a_pane(&daemon);

        let t = transcript(
            dir.path(),
            "sess.jsonl",
            &[
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":50000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
            ],
        );
        let d = HookDrop {
            agent: Some("codex".into()),
            transcript_path: Some(t.display().to_string()),
            ..drop_for("Stop", info.id)
        };
        drop_and_await_apply(state.path(), &d).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let listed = daemon.list();
        let row = listed.iter().find(|s| s.id == info.id).unwrap();
        assert!(
            row.context.is_none(),
            "a non-Claude pane carries no context, even with a readable transcript"
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
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
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
}

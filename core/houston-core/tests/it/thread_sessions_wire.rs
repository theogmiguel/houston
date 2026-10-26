//! Claude sessions in thread view, driven over `/ws` against a fake `claude` that replays
//! captured stream-json (tests/fixtures/threads, sanitised from real Claude Code output).

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_protocol as proto;
use proto::{ThreadEvent, ThreadEventKind, TurnOutcome};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/threads");

struct Rig {
    daemon: Arc<Daemon>,
    addr: std::net::SocketAddr,
    ws: WsStream,
    project: tempfile::TempDir,
    scratch: tempfile::TempDir,
    _shim: tempfile::TempDir,
    _state: tempfile::TempDir,
    env: houston_core::host_env::HostEnv,
}

fn fake_claude_env(shim: &Path, scratch: &Path) -> houston_core::host_env::HostEnv {
    install_fake_claude(shim);
    fake_claude_vars(hermetic_claude_env(shim), scratch)
}

#[test]
fn a_renamed_fake_leaves_no_claude_to_launch() {
    let shim = tempfile::tempdir().unwrap();
    let fake = install_fake_claude(shim.path());
    let env = hermetic_claude_env(shim.path());
    std::fs::rename(&fake, shim.path().join("renamed")).unwrap();
    assert_eq!(houston_core::exe_path::resolve_in(&env, "claude"), None);
}

fn fake_claude_vars(
    env: houston_core::host_env::HostEnv,
    scratch: &Path,
) -> houston_core::host_env::HostEnv {
    env.with(
        "HOUSTON_FAKE_CLAUDE_LOG",
        Some(scratch.join("launches.jsonl")),
    )
    .with("HOUSTON_FAKE_CLAUDE_FIXTURES", Some(FIXTURES))
}

impl Rig {
    async fn new() -> Self {
        let shim = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let env = fake_claude_env(shim.path(), scratch.path());
        let (addr, state, daemon) = start_daemon_with_handle_in(env.clone()).await;
        let mut ws = connect_and_hello(addr, TOKEN).await;
        let _ = next_control(&mut ws).await;
        Rig {
            daemon,
            addr,
            ws,
            project: tempfile::tempdir().unwrap(),
            scratch,
            _shim: shim,
            _state: state,
            env,
        }
    }

    async fn send(&mut self, msg: Value) {
        self.ws.send(Message::text(msg.to_string())).await.unwrap();
    }

    async fn create(&mut self, agent: &str, view: &str) -> Result<proto::SessionInfo, String> {
        self.send(json!({"type":"session_create","request":1,"agent":agent,
            "project_dir":self.project.path(),"view":view}))
            .await;
        loop {
            if let proto::ServerMsg::SessionCreateResult { info, error, .. } =
                next_control(&mut self.ws).await
            {
                return info.ok_or_else(|| error.unwrap_or_default());
            }
        }
    }

    async fn thread(&mut self) -> u32 {
        let info = self.create("claude", "thread").await.unwrap();
        assert_eq!(info.view, proto::SessionView::Thread);
        info.id
    }

    async fn say(&mut self, session: u32, text: &str) {
        self.send(json!({"type":"thread_send","session":session,"text":text}))
            .await;
    }

    /// Live events for `session` until one satisfies `done`, and the messages they came in.
    async fn events_until(
        &mut self,
        session: u32,
        done: impl Fn(&ThreadEvent) -> bool,
    ) -> (Vec<ThreadEvent>, usize) {
        let mut events = Vec::new();
        let mut messages = 0;
        loop {
            match next_control(&mut self.ws).await {
                proto::ServerMsg::ThreadEvents {
                    session: s,
                    events: batch,
                } if s == session => {
                    messages += 1;
                    let finished = batch.iter().any(&done);
                    events.extend(batch);
                    if finished {
                        return (events, messages);
                    }
                }
                proto::ServerMsg::Error { message, .. } => panic!("unexpected error: {message}"),
                _ => {}
            }
        }
    }

    async fn turn(&mut self, session: u32, text: &str) -> Vec<ThreadEvent> {
        self.say(session, text).await;
        self.events_until(session, |e| {
            matches!(e.kind, ThreadEventKind::TurnEnd { .. })
        })
        .await
        .0
    }

    async fn error(&mut self) -> (String, Option<String>) {
        loop {
            if let proto::ServerMsg::Error { message, context } = next_control(&mut self.ws).await {
                return (message, context);
            }
        }
    }

    async fn history(&mut self, session: u32) -> (Vec<ThreadEvent>, bool) {
        self.page(session, None, 500).await
    }

    async fn page(
        &mut self,
        session: u32,
        before: Option<u64>,
        limit: u32,
    ) -> (Vec<ThreadEvent>, bool) {
        self.send(
            json!({"type":"thread_history","session":session,"before_seq":before,"limit":limit}),
        )
        .await;
        loop {
            match next_control(&mut self.ws).await {
                proto::ServerMsg::ThreadHistory {
                    session: s,
                    before_seq,
                    events,
                    has_more,
                } if s == session => {
                    assert_eq!(before_seq, before, "the reply echoes its request");
                    return (events, has_more);
                }
                proto::ServerMsg::Error { message, .. } => panic!("history refused: {message}"),
                _ => {}
            }
        }
    }

    /// Thread launches of the fake, oldest first (a `--version` probe is not one).
    fn launches(&self) -> Vec<(u32, Vec<String>)> {
        jsonl_records(&self.scratch.path().join("launches.jsonl"))
            .into_iter()
            .filter_map(|record| {
                let argv: Vec<String> = serde_json::from_value(record["argv"].clone()).ok()?;
                argv.iter()
                    .any(|arg| arg == "-p")
                    .then(|| (record["pid"].as_u64().unwrap() as u32, argv))
            })
            .collect()
    }
}

fn arg_after(argv: &[String], flag: &str) -> Option<String> {
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A thread without a process is a live session waiting for its next message.
async fn assert_idle_and_running(daemon: &Daemon, id: u32) {
    wait_until("the thread to wait idle", || {
        daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;
    let info = daemon.list().into_iter().find(|s| s.id == id).unwrap();
    assert_eq!(info.state, proto::SessionState::Running);
}

fn stored(events: &[ThreadEvent]) -> Vec<ThreadEvent> {
    events
        .iter()
        .filter(|e| {
            !matches!(
                e.kind,
                ThreadEventKind::AssistantDelta { .. } | ThreadEventKind::ReasoningDelta { .. }
            )
        })
        .cloned()
        .collect()
}

#[tokio::test]
async fn a_replayed_thinking_turn_stores_one_reasoning_block_and_never_a_delta() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let live = rig.turn(id, "replay:thinking").await;
    assert!(
        live.iter()
            .any(|e| matches!(e.kind, ThreadEventKind::ReasoningDelta { .. })),
        "{live:?}"
    );

    let (history, _) = rig.history(id).await;
    assert_eq!(history, stored(&live));
    let reasoning: Vec<&ThreadEventKind> = history
        .iter()
        .map(|e| &e.kind)
        .filter(|kind| {
            matches!(
                kind,
                ThreadEventKind::Reasoning { .. } | ThreadEventKind::ReasoningDelta { .. }
            )
        })
        .collect();
    assert!(
        matches!(
            reasoning[..],
            [ThreadEventKind::Reasoning {
                message_id,
                text,
                truncated: false,
                duration_ms: Some(_),
                estimated_tokens: Some(196),
                redacted: false,
            }] if message_id == "msg_01:0" && text.is_empty()
        ),
        "{history:?}"
    );
}

#[tokio::test]
async fn an_edit_over_the_input_cap_keeps_its_summary_in_history() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.turn(id, "replay:large-edit").await;
    let (history, _) = rig.history(id).await;
    let edit = history
        .iter()
        .find_map(|e| match &e.kind {
            ThreadEventKind::ToolCall {
                name,
                truncated,
                summary,
                ..
            } if name == "Edit" => Some((*truncated, summary.clone())),
            _ => None,
        })
        .expect("the Edit call");
    assert_eq!(
        edit,
        (
            true,
            Some(proto::ToolSummary {
                kind: proto::ToolKind::Edit,
                target: "/work/repo/big.txt".into(),
                added: Some(110),
                removed: Some(110),
            })
        )
    );
}

#[tokio::test]
async fn a_thread_turn_streams_typed_events_and_keeps_them_as_history() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let live = rig.turn(id, "replay:tools").await;

    let launch = &rig.launches()[0].1;
    for flag in [
        "--input-format",
        "--output-format",
        "--verbose",
        "--include-partial-messages",
    ] {
        assert!(
            launch.iter().any(|arg| arg == flag),
            "{flag} missing from {launch:?}"
        );
    }
    assert_eq!(
        arg_after(launch, "--input-format").as_deref(),
        Some("stream-json")
    );
    assert!(arg_after(launch, "--session-id").is_some(), "{launch:?}");

    assert!(live.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    assert!(
        matches!(&live[0].kind, ThreadEventKind::UserMessage { text, .. } if text == "replay:tools")
    );
    let tools: Vec<&str> = live
        .iter()
        .filter_map(|e| match &e.kind {
            ThreadEventKind::ToolCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tools, ["Write", "Edit", "Bash"]);
    let results = live
        .iter()
        .filter(|e| matches!(e.kind, ThreadEventKind::ToolResult { .. }))
        .count();
    assert_eq!(results, tools.len());
    let (final_id, final_text) = live
        .iter()
        .rev()
        .find_map(|e| match &e.kind {
            ThreadEventKind::AssistantMessage {
                message_id, text, ..
            } => Some((message_id.clone(), text.clone())),
            _ => None,
        })
        .expect("a final assistant message");
    let streamed: String = live
        .iter()
        .filter_map(|e| match &e.kind {
            ThreadEventKind::AssistantDelta { message_id, text } if *message_id == final_id => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        streamed, final_text,
        "deltas add up to the message that supersedes them"
    );
    assert!(matches!(
        live.last().unwrap().kind,
        ThreadEventKind::TurnEnd {
            outcome: TurnOutcome::Completed,
            ..
        }
    ));

    let (history, has_more) = rig.history(id).await;
    assert!(!has_more);
    assert_eq!(
        history,
        stored(&live),
        "history is the live timeline without deltas"
    );
    let middle = history.len() / 2;
    let (earlier, more) = rig.page(id, Some(history[middle].seq), 3).await;
    assert!(more);
    assert_eq!(earlier.len(), 3);
    assert_eq!(earlier.last().unwrap().seq, history[middle - 1].seq);

    // No lifecycle hook reports for the fake, so the stream's result ended the turn.
    wait_until("the result to settle the status", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;
}

#[tokio::test]
async fn stop_ends_the_whole_process_tree_and_the_next_message_resumes() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    assert_idle_and_running(&rig.daemon, id).await;
    let pidfile = rig.scratch.path().join("sleeper.pid");
    rig.say(id, &format!("hang:{}", pidfile.display())).await;
    wait_until("the tool process to start", || pidfile.is_file()).await;
    let sleeper: u32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let (claude, first_argv) = rig.launches()[0].clone();
    let conversation = arg_after(&first_argv, "--session-id").unwrap();
    assert!(houston_core::pid::process_is_alive(sleeper));

    rig.send(json!({"type":"thread_stop","session":id})).await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    assert!(matches!(
        events.last().unwrap().kind,
        ThreadEventKind::TurnEnd {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    let kept = ThreadEventKind::AssistantMessage {
        message_id: "msg_hang:0".into(),
        text: "working".into(),
        truncated: true,
    };
    assert_eq!(
        events[events.len() - 2].kind,
        kept,
        "Stop keeps the partial answer"
    );
    assert!(rig.history(id).await.0.iter().any(|e| e.kind == kept));
    wait_until("Claude and its tool process to end", || {
        !houston_core::pid::process_is_alive(claude)
            && !houston_core::pid::process_is_alive(sleeper)
    })
    .await;
    assert_idle_and_running(&rig.daemon, id).await;

    let resumed = rig.turn(id, "replay:resumed").await;
    let launches = rig.launches();
    assert_eq!(launches.len(), 2);
    assert_eq!(arg_after(&launches[1].1, "--resume"), Some(conversation));
    assert!(arg_after(&launches[1].1, "--session-id").is_none());
    assert!(resumed[0].seq > events.last().unwrap().seq);
    assert!(resumed.iter().any(
        |e| matches!(&e.kind, ThreadEventKind::AssistantMessage { text, .. } if text == "RESUMED")
    ));
}

#[tokio::test]
async fn a_crash_is_a_notice_and_the_next_message_starts_claude_again() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.say(id, "crash").await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::Notice { .. }))
        .await;
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        ThreadEventKind::TurnEnd { outcome: TurnOutcome::Error, error: Some(error) } if error.contains("exit code 3")
    )));
    let notice = events
        .iter()
        .find_map(|e| match &e.kind {
            ThreadEventKind::Notice { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        notice.contains("exit code 3") && notice.contains("fatal: fake crash"),
        "{notice}"
    );
    assert!(events.iter().any(|e| e.kind
        == ThreadEventKind::AssistantMessage {
            message_id: "msg_crash:0".into(),
            text: "partial answer".into(),
            truncated: true,
        }));
    assert_idle_and_running(&rig.daemon, id).await;
    let next = rig.turn(id, "replay:warm").await;
    assert!(matches!(
        next.last().unwrap().kind,
        ThreadEventKind::TurnEnd {
            outcome: TurnOutcome::Completed,
            ..
        }
    ));
    assert!(arg_after(&rig.launches()[1].1, "--resume").is_some());
}

#[tokio::test]
async fn live_events_are_coalesced_to_thirty_messages_a_second() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let started = Instant::now();
    rig.say(id, "flood:3000").await;
    let (events, messages) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    let elapsed = started.elapsed();
    let allowed = (elapsed.as_millis() as usize).div_ceil(33) + 1;
    assert!(
        messages <= allowed,
        "{messages} thread_events messages in {elapsed:?}; at most {allowed} allowed"
    );
    let streamed: String = events
        .iter()
        .filter_map(|e| match &e.kind {
            ThreadEventKind::AssistantDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed.len(), 3000, "coalescing loses no delta text");
}

#[tokio::test]
async fn history_is_capped_with_one_notice_naming_the_cap() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    // 40 messages of 250 KiB pass the 8 MiB cap long before the event cap.
    rig.turn(id, "big:40:250").await;
    let (history, _) = rig.history(id).await;
    let notices: Vec<&ThreadEvent> = history
        .iter()
        .filter(|e| matches!(e.kind, ThreadEventKind::Notice { .. }))
        .collect();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(
        history[0].seq, notices[0].seq,
        "the notice heads the kept history"
    );
    match &notices[0].kind {
        ThreadEventKind::Notice { text } => assert!(text.contains("8 MiB"), "{text}"),
        _ => unreachable!(),
    }
    let bytes: usize = history
        .iter()
        .map(|e| serde_json::to_string(&e.kind).unwrap().len())
        .sum();
    assert!(bytes <= 8 * 1024 * 1024, "{bytes} bytes kept");
    assert!(history.len() < 42);
    assert!(matches!(
        history.last().unwrap().kind,
        ThreadEventKind::TurnEnd { .. }
    ));
}

#[tokio::test]
async fn history_survives_kill_and_is_deleted_when_the_session_closes() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.turn(id, "replay:warm").await;
    rig.daemon.kill(id).unwrap();
    let (kept, _) = rig.history(id).await;
    assert!(
        !kept.is_empty(),
        "a killed tile keeps its history for Restart"
    );
    rig.daemon.close(id).unwrap();
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    assert_eq!(db.thread_usage(id).unwrap(), (0, 0));
}

#[tokio::test]
async fn other_providers_and_terminal_sessions_are_refused_by_name() {
    let mut rig = Rig::new().await;
    let refused = rig.create("codex", "thread").await.unwrap_err();
    assert!(
        refused.contains("thread view supports Claude only; codex sessions open as terminals"),
        "{refused}"
    );
    let shell = rig.create("shell", "terminal").await.unwrap();
    assert_eq!(shell.view, proto::SessionView::Terminal);
    rig.say(shell.id, "hello").await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains("terminal session (view terminal)"),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{}", shell.id)));
    rig.send(json!({"type":"thread_history","session":shell.id,"limit":10}))
        .await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains(&format!("thread_history refused for session {}", shell.id))
            && message.contains("view terminal"),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{}", shell.id)));
    rig.send(json!({"type":"thread_history","session":9999,"limit":10}))
        .await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains("thread_history refused for session 9999: unknown session"),
        "{message}"
    );
    assert_eq!(context.as_deref(), Some("session:9999"));

    let id = rig.thread().await;
    let over = "x".repeat(proto::THREAD_USER_MESSAGE_MAX_BYTES + 1);
    rig.say(id, &over).await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains(&format!(
            "{} bytes",
            proto::THREAD_USER_MESSAGE_MAX_BYTES + 1
        )) && message.contains("THREAD_USER_MESSAGE_MAX_BYTES"),
        "{message}"
    );
    rig.send(json!({"type":"thread_history","session":id,"limit":501}))
        .await;
    assert!(rig.error().await.0.contains("THREAD_HISTORY_PAGE_MAX"));

    rig.ws
        .send(Message::binary(proto::encode_stdin_frame(id, b"ls\r")))
        .await
        .unwrap();
    let (message, context) = rig.error().await;
    assert!(
        message.contains("thread session (view thread)"),
        "{message}"
    );
    assert_eq!(context.as_deref(), Some("stdin"));
    assert!(
        rig.launches().len() == 1,
        "terminal input never started or reached Claude"
    );
}

#[tokio::test]
async fn a_restarted_daemon_restores_the_thread_with_its_history() {
    let rig = Rig::new().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let project = rig.project.path();
    let transcript = rig.scratch.path().join("conversation.jsonl");
    std::fs::write(&transcript, "{}\n").unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&thread_row(7, project)).unwrap();
        db.set_session_resume_handle(7, Some(("conv-7", Some(transcript.to_str().unwrap()))))
            .unwrap();
        for seq in 1..=3 {
            db.thread_event_insert(
                7,
                &ThreadEvent {
                    seq,
                    at_ms: seq,
                    kind: ThreadEventKind::Notice {
                        text: format!("stored {seq}"),
                    },
                },
            )
            .unwrap();
        }
    }
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path,
        rig.env.clone(),
    ))
    .unwrap();
    wait_until("the thread to be restored", || {
        daemon
            .list()
            .iter()
            .any(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
    })
    .await;
    let restored = daemon
        .list()
        .into_iter()
        .find(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
        .unwrap();
    assert_eq!(restored.view, proto::SessionView::Thread);
    let argv = rig.launches().last().unwrap().1.clone();
    assert_eq!(arg_after(&argv, "--resume").as_deref(), Some("conv-7"));
    match daemon.thread_history(restored.id, None, 10).unwrap() {
        proto::ServerMsg::ThreadHistory { events, .. } => {
            assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2, 3]);
        }
        other => panic!("expected history, got {other:?}"),
    }
    daemon.close(restored.id).unwrap();
}

fn queued_row(id: &str, text: &str) -> proto::ThreadQueuedMessage {
    proto::ThreadQueuedMessage {
        id: id.into(),
        text: text.into(),
        state: proto::QueuedState::Queued,
        hold_reason: None,
        created_at_ms: 1,
    }
}

async fn queue_snapshot(ws: &mut WsStream, session: u32) -> Vec<proto::ThreadQueuedMessage> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::ThreadQueue { session: s, items } if s == session => return items,
            proto::ServerMsg::Error { message, .. } => panic!("queue request refused: {message}"),
            _ => {}
        }
    }
}

async fn refusal(ws: &mut WsStream) -> (String, Option<String>) {
    loop {
        if let proto::ServerMsg::Error { message, context } = next_control(ws).await {
            return (message, context);
        }
    }
}

/// Nothing queued before a restart is sent by the next daemon; the queue follows the
/// restored row and can be edited and emptied over `/ws`.
#[tokio::test]
async fn a_restarted_daemon_holds_the_queue_and_the_user_edits_it() {
    let rig = Rig::new().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let transcript = rig.scratch.path().join("conversation.jsonl");
    std::fs::write(&transcript, "{}\n").unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&thread_row(7, rig.project.path()))
            .unwrap();
        db.set_session_resume_handle(7, Some(("conv-7", Some(transcript.to_str().unwrap()))))
            .unwrap();
        for (id, text) in [("a", "first"), ("b", "second")] {
            db.thread_queue_push(7, "thread_send", &queued_row(id, text))
                .unwrap();
        }
    }
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path.clone(),
        rig.env.clone(),
    ))
    .unwrap();
    let (addr, _server) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());
    wait_until("the thread to be restored", || {
        daemon
            .list()
            .iter()
            .any(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
    })
    .await;
    let id = daemon
        .list()
        .into_iter()
        .find(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
        .unwrap()
        .id;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    ws.send(Message::text(
        json!({"type":"thread_queue_list","session":id}).to_string(),
    ))
    .await
    .unwrap();
    let items = queue_snapshot(&mut ws, id).await;
    assert_eq!(
        items
            .iter()
            .map(|item| (item.id.as_str(), item.state, item.hold_reason.as_deref()))
            .collect::<Vec<_>>(),
        [
            (
                "a",
                proto::QueuedState::Held,
                Some(houston_core::db::THREAD_QUEUE_RESTART_REASON)
            ),
            (
                "b",
                proto::QueuedState::Held,
                Some(houston_core::db::THREAD_QUEUE_RESTART_REASON)
            ),
        ]
    );
    assert!(
        history_of(&daemon, id)
            .iter()
            .all(|e| !matches!(e.kind, ThreadEventKind::UserMessage { .. })),
        "a held message is never sent by itself"
    );

    ws.send(Message::text(
        json!({"type":"thread_queue_edit","session":id,"id":"b","text":"SECOND"}).to_string(),
    ))
    .await
    .unwrap();
    let items = queue_snapshot(&mut ws, id).await;
    assert_eq!(items[1].text, "SECOND");
    ws.send(Message::text(
        json!({"type":"thread_queue_remove","session":id,"id":"a"}).to_string(),
    ))
    .await
    .unwrap();
    let items = queue_snapshot(&mut ws, id).await;
    assert_eq!(
        items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["b"]
    );

    ws.send(Message::text(
        json!({"type":"thread_queue_remove","session":id,"id":"a"}).to_string(),
    ))
    .await
    .unwrap();
    let (message, context) = refusal(&mut ws).await;
    assert!(
        message.starts_with(&format!("thread_queue_remove refused for session {id}"))
            && message.contains("\"a\" is not in its queue"),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{id}")));
    ws.send(Message::text(
        json!({"type":"thread_queue_edit","session":id,"id":"b","text":"  "}).to_string(),
    ))
    .await
    .unwrap();
    let (message, _) = refusal(&mut ws).await;
    assert!(message.contains("the message is empty"), "{message}");

    daemon.close(id).unwrap();
    assert!(
        Db::open(&db_path)
            .unwrap()
            .thread_queue(id)
            .unwrap()
            .is_empty(),
        "closing the session deletes its queue"
    );
}

/// A daemon that dies mid-turn leaves a user message with no turn end and a running row.
#[tokio::test]
async fn a_turn_left_open_by_a_daemon_crash_ends_on_restore() {
    let rig = Rig::new().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let project = rig.project.path();
    let transcript = rig.scratch.path().join("conversation.jsonl");
    std::fs::write(&transcript, "{}\n").unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&proto::SessionInfo {
            state: proto::SessionState::Running,
            ..thread_row(7, project)
        })
        .unwrap();
        db.set_session_resume_handle(7, Some(("conv-7", Some(transcript.to_str().unwrap()))))
            .unwrap();
        let open_turn = [
            ThreadEventKind::UserMessage {
                text: "question".into(),
                delivery: Default::default(),
            },
            ThreadEventKind::ToolCall {
                tool_use_id: "toolu_1".into(),
                name: "Bash".into(),
                input: "{}".into(),
                truncated: false,
                summary: None,
            },
        ];
        for (seq, kind) in (1..).zip(open_turn) {
            db.thread_event_insert(
                7,
                &ThreadEvent {
                    seq,
                    at_ms: seq,
                    kind,
                },
            )
            .unwrap();
        }
    }
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path,
        rig.env.clone(),
    ))
    .unwrap();
    wait_until("the thread to be restored", || {
        daemon
            .list()
            .iter()
            .any(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
    })
    .await;
    let restored = daemon
        .list()
        .into_iter()
        .find(|s| s.session_origin == Some(7) && s.state == proto::SessionState::Running)
        .unwrap();
    let history = history_of(&daemon, restored.id);
    let tail: Vec<(u64, &ThreadEventKind)> =
        history.iter().skip(2).map(|e| (e.seq, &e.kind)).collect();
    assert_eq!(
        tail,
        [
            (
                3,
                &ThreadEventKind::TurnEnd {
                    outcome: TurnOutcome::Interrupted,
                    error: None
                }
            ),
            (
                4,
                &ThreadEventKind::Notice {
                    text: "Houston restarted while this turn ran.".into()
                }
            ),
        ],
        "{history:?}"
    );
    daemon.close(restored.id).unwrap();
}

/// Only a daemon crash leaves a thread's process group recorded for the next daemon.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_group_record_is_cleared_whenever_the_daemon_ends_the_tree() {
    let mut rig = Rig::new().await;
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    let id = rig.thread().await;
    let recorded = |db: &Db| db.thread_group(id).unwrap().is_some();
    wait_until("the first process's group record", || recorded(&db)).await;
    rig.daemon.thread_stop(id).unwrap();
    assert!(!recorded(&db), "Stop ended the tree");
    rig.turn(id, "crash").await;
    wait_until("the crash to clear the record", || {
        rig.launches().len() == 2 && !recorded(&db)
    })
    .await;
    rig.turn(id, "hello").await;
    assert!(recorded(&db), "the restarted process is recorded");
    let daemon = Arc::clone(&rig.daemon);
    within("kill", Duration::from_secs(10), move || daemon.kill(id))
        .await
        .unwrap();
    assert!(!recorded(&db), "Kill closed the thread and ended the tree");
}

fn thread_row(id: u32, project: &Path) -> proto::SessionInfo {
    let dir: PathBuf = project.to_path_buf();
    proto::SessionInfo {
        note: None,
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id,
        agent: proto::AgentKind::Claude,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Interrupted,
        title: format!("Thread-{id}"),
        codename: format!("Thread-{id}"),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by: None,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: true,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
        limit: None,
        view: proto::SessionView::Thread,
        permission_mode: None,
        transferred_at_ms: None,
        transfer_fork: false,
    }
}

#[tokio::test]
async fn orchestration_prompts_and_reads_a_thread_and_refuses_keys() {
    let mut rig = Rig::new().await;
    let parent = rig.create("shell", "terminal").await.unwrap().id;
    let child = rig.thread().await;
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    db.delegation_create(
        parent,
        child,
        Some("worker"),
        "task",
        houston_core::hook_drop::now_ms(),
    )
    .unwrap();
    rig.daemon.orchestration_set(true).unwrap();

    let refused = rig
        .daemon
        .orchestrate_send_keys(parent, child, &["enter".to_string()])
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("thread session (view thread)") && refused.contains("pane_prompt"),
        "{refused}"
    );

    let daemon = Arc::clone(&rig.daemon);
    tokio::task::spawn_blocking(move || {
        daemon.orchestrate_instruction_request(parent, child, "hello thread", None, Some("steer"))
    })
    .await
    .unwrap()
    .unwrap();
    let (events, _) = rig
        .events_until(child, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    assert!(events.iter().any(
        |e| matches!(&e.kind, ThreadEventKind::UserMessage { text, .. } if text.contains("hello thread"))
    ));
    let lines = rig
        .daemon
        .orchestrate_read(parent, child, 20, false)
        .unwrap();
    let text = lines.join("\n");
    assert!(
        text.contains("echo:")
            && text.contains("hello thread")
            && text.ends_with("[turn Completed]"),
        "{lines:?}"
    );
}

fn history_of(daemon: &Daemon, id: u32) -> Vec<ThreadEvent> {
    match daemon.thread_history(id, None, 500).unwrap() {
        proto::ServerMsg::ThreadHistory { events, .. } => events,
        other => panic!("expected history, got {other:?}"),
    }
}

fn truncated(message_id: &str, text: &str) -> ThreadEventKind {
    ThreadEventKind::AssistantMessage {
        message_id: message_id.into(),
        text: text.into(),
        truncated: true,
    }
}

/// Runs `work` on a detached thread and fails after `limit` instead of hanging the test.
async fn within<T: Send + 'static>(
    what: &str,
    limit: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    tokio::time::timeout(limit, rx)
        .await
        .unwrap_or_else(|_| panic!("{what} did not finish within {limit:?}"))
        .unwrap()
}

#[tokio::test]
async fn stop_and_kill_finish_while_a_message_write_is_blocked() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.turn(id, "mute").await;
    // Larger than any pipe buffer: the write blocks because Claude no longer reads.
    let big = "y".repeat(200 * 1024);
    let daemon = Arc::clone(&rig.daemon);
    let blocked = std::thread::spawn(move || daemon.thread_send(id, &big, false));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let daemon = Arc::clone(&rig.daemon);
    within("thread_stop", Duration::from_secs(10), move || {
        daemon.thread_stop(id)
    })
    .await
    .unwrap();
    within("the blocked write", Duration::from_secs(10), move || {
        blocked.join().unwrap()
    })
    .await
    .unwrap_err();
    let daemon = Arc::clone(&rig.daemon);
    within("kill", Duration::from_secs(10), move || daemon.kill(id))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_message_sent_during_stop_waits_for_the_old_process() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.say(id, "stubborn").await;
    rig.events_until(id, |e| {
        matches!(e.kind, ThreadEventKind::AssistantDelta { .. })
    })
    .await;
    let daemon = Arc::clone(&rig.daemon);
    let stop = std::thread::spawn(move || daemon.thread_stop(id));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let daemon = Arc::clone(&rig.daemon);
    within("thread_send", Duration::from_secs(10), move || {
        daemon.thread_send(id, "replay:warm", false)
    })
    .await
    .unwrap();
    stop.join().unwrap().unwrap();
    rig.events_until(id, |e| {
        matches!(
            e.kind,
            ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Completed,
                ..
            }
        )
    })
    .await;
    let history = history_of(&rig.daemon, id);
    let at = |pred: &dyn Fn(&ThreadEventKind) -> bool| {
        history
            .iter()
            .position(|e| pred(&e.kind))
            .unwrap_or_else(|| panic!("{history:?}"))
    };
    let partial = at(&|k| *k == truncated("msg_stubborn:0", "stubborn"));
    let stopped = at(&|k| {
        matches!(
            k,
            ThreadEventKind::TurnEnd {
                outcome: TurnOutcome::Interrupted,
                ..
            }
        )
    });
    let next =
        at(&|k| matches!(k, ThreadEventKind::UserMessage { text, .. } if text == "replay:warm"));
    assert!(partial < stopped && stopped < next, "{history:?}");
    wait_until("the resumed turn to settle", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;
    let launches = rig.launches();
    assert_eq!(launches.len(), 2);
    assert!(!houston_core::pid::process_is_alive(launches[0].0));
}

#[tokio::test]
async fn kill_mid_turn_keeps_the_partial_answer_and_names_the_cause() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let pidfile = rig.scratch.path().join("sleeper.pid");
    rig.say(id, &format!("hang:{}", pidfile.display())).await;
    rig.events_until(id, |e| {
        matches!(e.kind, ThreadEventKind::AssistantDelta { .. })
    })
    .await;
    let daemon = Arc::clone(&rig.daemon);
    within("kill", Duration::from_secs(10), move || daemon.kill(id))
        .await
        .unwrap();
    let history = history_of(&rig.daemon, id);
    let tail: Vec<&ThreadEventKind> = history.iter().rev().take(3).map(|e| &e.kind).collect();
    assert_eq!(*tail[2], truncated("msg_hang:0", "working"), "{history:?}");
    assert!(matches!(
        tail[1],
        ThreadEventKind::TurnEnd {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    assert!(
        matches!(tail[0], ThreadEventKind::Notice { text } if text.contains("killed")),
        "{history:?}"
    );
}

#[tokio::test]
async fn a_daemon_shutdown_mid_turn_is_recorded_and_restored() {
    let rig = Rig::new().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let first = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path.clone(),
        rig.env.clone(),
    ))
    .unwrap();
    let id = first
        .create_session_in_view(
            houston_core::daemon::CreateParams {
                agent: proto::AgentKind::Claude,
                project_dir: rig.project.path().to_path_buf(),
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
            },
            proto::SessionView::Thread,
        )
        .unwrap()
        .id;
    let pidfile = rig.scratch.path().join("sleeper.pid");
    first
        .thread_send(id, &format!("hang:{}", pidfile.display()), false)
        .unwrap();
    wait_until("the tool process to start", || pidfile.is_file()).await;
    // The fake streams its partial answer as it starts the tool process.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let shutting = Arc::clone(&first);
    within("shutdown", Duration::from_secs(20), move || {
        shutting.manage_shutdown().map(|_| ()).map_err(|e| e.reason)
    })
    .await
    .unwrap();
    drop(first);
    let second = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path,
        rig.env.clone(),
    ))
    .unwrap();
    wait_until("the thread to be restored", || {
        second
            .list()
            .iter()
            .any(|s| s.session_origin == Some(id) && s.state == proto::SessionState::Running)
    })
    .await;
    let restored = second
        .list()
        .into_iter()
        .find(|s| s.session_origin == Some(id) && s.state == proto::SessionState::Running)
        .unwrap();
    let history = history_of(&second, restored.id);
    assert!(
        history
            .iter()
            .any(|e| e.kind == truncated("msg_hang:0", "working")),
        "{history:?}"
    );
    assert!(
        history.iter().any(|e| matches!(&e.kind,
            ThreadEventKind::Notice { text } if text.contains("Houston stopped this thread") && text.contains("shut")
        )),
        "{history:?}"
    );
    second.close(restored.id).unwrap();
}

/// A Restart or shutdown closing a thread while its Stop has not settled the status.
#[cfg(any(target_os = "linux", feature = "test-barriers"))]
type DuringStop = fn(Arc<Daemon>, u32) -> Result<(), String>;

#[cfg(any(target_os = "linux", feature = "test-barriers"))]
fn restart(daemon: Arc<Daemon>, id: u32) -> Result<(), String> {
    daemon
        .respawn(id, false, None, None, true)
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

#[cfg(any(target_os = "linux", feature = "test-barriers"))]
fn shut_down(daemon: Arc<Daemon>, _: u32) -> Result<(), String> {
    daemon.manage_shutdown().map(|_| ()).map_err(|e| e.reason)
}

/// A thread mid-turn in a Claude that ignores SIGTERM and stdin.
#[cfg(any(target_os = "linux", feature = "test-barriers"))]
async fn stubborn_thread(rig: &mut Rig) -> u32 {
    let id = rig.thread().await;
    rig.say(id, "stubborn").await;
    rig.events_until(id, |e| {
        matches!(e.kind, ThreadEventKind::AssistantDelta { .. })
    })
    .await;
    // Headless Claude reports its turn through hooks; Stop settles only a working thread.
    rig.daemon.handle_hook(id, "UserPromptSubmit", None);
    assert_eq!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    id
}

/// Starts `during` while `stop` holds the thread, lets the Stop go on with `release`, and
/// requires both to finish: a closer holding the lock the Stop's settle takes deadlocks.
#[cfg(any(target_os = "linux", feature = "test-barriers"))]
async fn both_finish(
    rig: &Rig,
    id: u32,
    stop: std::thread::JoinHandle<anyhow::Result<()>>,
    during: DuringStop,
    release: impl FnOnce(),
) {
    let daemon = Arc::clone(&rig.daemon);
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(during(daemon, id));
    });
    // Long enough for `during` to reach the thread's close, which waits for the Stop.
    tokio::time::sleep(Duration::from_millis(500)).await;
    release();
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .expect("the Restart or shutdown deadlocked with the Stop")
        .unwrap()
        .unwrap();
    within("thread_stop", Duration::from_secs(10), move || {
        stop.join().unwrap()
    })
    .await
    .unwrap();
}

#[cfg(feature = "test-barriers")]
async fn close_while_stop_settles(during: DuringStop) {
    let mut rig = Rig::new().await;
    let id = stubborn_thread(&mut rig).await;
    let barrier = TestBarrier::arm("thread-stop-settle");
    let daemon = Arc::clone(&rig.daemon);
    let stop = std::thread::spawn(move || daemon.thread_stop(id));
    barrier.reached(id).await;
    both_finish(&rig, id, stop, during, || barrier.release()).await;
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_restart_while_stop_settles_finishes() {
    close_while_stop_settles(restart).await;
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_shutdown_while_stop_settles_finishes() {
    close_while_stop_settles(shut_down).await;
}

/// Linux gives a stopped Claude a grace period, so no barrier is needed to race it.
#[cfg(target_os = "linux")]
async fn close_during_stop_grace(during: DuringStop) {
    let mut rig = Rig::new().await;
    let id = stubborn_thread(&mut rig).await;
    let daemon = Arc::clone(&rig.daemon);
    let stop = std::thread::spawn(move || daemon.thread_stop(id));
    tokio::time::sleep(Duration::from_millis(100)).await;
    both_finish(&rig, id, stop, during, || {}).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_restart_during_the_stop_grace_finishes() {
    close_during_stop_grace(restart).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_shutdown_during_the_stop_grace_finishes() {
    close_during_stop_grace(shut_down).await;
}

/// npm installs `claude` as a `.cmd` shim; std quotes batch arguments itself. The MCP
/// config JSON carries quotes and a project path can carry `%`.
#[cfg(windows)]
#[tokio::test]
async fn a_cmd_shim_receives_quoted_json_and_percent_signs_verbatim() {
    const MODEL: &str = "model-%PATH%-\"quoted\"";
    let shim = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let fake = shim.path().join("fake-claude.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_fake_claude_stream"), &fake).unwrap();
    std::fs::write(
        shim.path().join("claude.cmd"),
        format!("@\"{}\" %*\r\n", fake.display()),
    )
    .unwrap();
    let env = fake_claude_vars(hermetic_claude_env(shim.path()), scratch.path());
    let (addr, _state, _daemon) = start_daemon_with_handle_in(env).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let parent = tempfile::tempdir().unwrap();
    let project = parent.path().join("pro%PATH%ject");
    std::fs::create_dir(&project).unwrap();
    ws.send(Message::text(
        json!({"type":"session_create","request":1,"agent":"claude","project_dir":project,"view":"thread","model":MODEL})
            .to_string(),
    ))
    .await
    .unwrap();
    let id = loop {
        if let proto::ServerMsg::SessionCreateResult { info, error, .. } =
            next_control(&mut ws).await
        {
            break info.unwrap_or_else(|| panic!("{error:?}")).id;
        }
    };
    ws.send(Message::text(
        json!({"type":"thread_send","session":id,"text":"replay:warm"}).to_string(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::ThreadEvents { events, .. }
                if events
                    .iter()
                    .any(|e| matches!(e.kind, ThreadEventKind::TurnEnd { .. })) =>
            {
                break
            }
            proto::ServerMsg::Error { message, .. } => panic!("{message}"),
            _ => {}
        }
    }
    let argv: Vec<String> = jsonl_records(&scratch.path().join("launches.jsonl"))
        .into_iter()
        .filter_map(|record| serde_json::from_value::<Vec<String>>(record["argv"].clone()).ok())
        .find(|argv| argv.iter().any(|arg| arg == "-p"))
        .unwrap();
    let config = arg_after(&argv, "--mcp-config").expect("the MCP config");
    let parsed: Value = serde_json::from_str(&config).expect("the JSON arrives intact");
    assert!(parsed.get("mcpServers").is_some(), "{config}");
    assert_eq!(
        arg_after(&argv, "--model").as_deref(),
        Some(MODEL),
        "quotes and % reach Claude unexpanded"
    );
}

/// The daemon's own `thread_*` status sources are not hooks: with hooks off, every turn's
/// `result` ends that turn, not only the first one.
#[tokio::test]
async fn with_hooks_off_every_stream_result_ends_its_turn() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    for turn in ["replay:warm", "replay:resumed"] {
        rig.turn(id, turn).await;
        wait_until("the result to settle the status", || {
            rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
        })
        .await;
        assert!(
            !rig.daemon.lifecycle_hook_seen_for_test(id),
            "after {turn}, the stream result marked hooks as seen and disabled the fallback"
        );
    }
}

impl Rig {
    async fn approve(
        &mut self,
        session: u32,
        request_id: &str,
        allow: bool,
        message: Option<&str>,
    ) {
        self.send(
            json!({"type":"thread_approve","session":session,"request_id":request_id,
            "allow":allow,"message":message}),
        )
        .await;
    }

    /// Asks for a tool that needs permission and returns the held request's id.
    async fn ask(&mut self, session: u32, command: &str) -> String {
        self.say(session, &format!("ask:Bash:{command}")).await;
        let (events, _) = self
            .events_until(session, |e| {
                matches!(e.kind, ThreadEventKind::ApprovalRequest { .. })
            })
            .await;
        match &events.last().unwrap().kind {
            ThreadEventKind::ApprovalRequest {
                request_id,
                tool_name,
                input,
                tool_use_id,
                truncated,
                ..
            } => {
                assert_eq!(tool_name, "Bash");
                assert!(tool_use_id.starts_with("toolu_ask_"), "{tool_use_id}");
                assert!(!truncated);
                let input: Value = serde_json::from_str(input).unwrap();
                assert_eq!(input["command"], command);
                request_id.clone()
            }
            other => panic!("expected an approval request, got {other:?}"),
        }
    }

    async fn mcp(&self, session: u32, body: Value) -> Value {
        let token = self
            .daemon
            .mcp_creds
            .issue(houston_core::mcp_creds::McpScope {
                session_id: session,
                workspace_id: self.project.path().display().to_string(),
            });
        reqwest::Client::new()
            .post(format!("http://{}/mcp", self.addr))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

fn resolution(events: &[ThreadEvent], id: &str) -> (proto::ApprovalDecision, Option<String>) {
    events
        .iter()
        .find_map(|e| match &e.kind {
            ThreadEventKind::ApprovalResolved {
                request_id,
                decision,
                reason,
            } if request_id == id => Some((*decision, reason.clone())),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no resolution of {id} in {events:?}"))
}

fn tool_result(events: &[ThreadEvent]) -> (bool, String) {
    events
        .iter()
        .find_map(|e| match &e.kind {
            ThreadEventKind::ToolResult {
                is_error, output, ..
            } => Some((*is_error, output.clone())),
            _ => None,
        })
        .expect("a tool result")
}

#[tokio::test]
async fn a_held_permission_request_is_answered_allow_and_deny() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let launch = &rig.launches()[0].1;
    assert_eq!(
        arg_after(launch, "--permission-prompt-tool").as_deref(),
        Some("mcp__houston__thread_permission"),
        "{launch:?}"
    );

    let allowed = rig.ask(id, "touch allowed.txt").await;
    assert_eq!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "a held request asks for input"
    );
    rig.approve(id, &allowed, true, None).await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    assert_eq!(
        resolution(&events, &allowed),
        (proto::ApprovalDecision::Allowed, None)
    );
    assert_eq!(
        tool_result(&events),
        (false, "ran: touch allowed.txt".into())
    );

    let denied = rig.ask(id, "rm -rf build").await;
    let long = "x".repeat(proto::APPROVAL_MESSAGE_MAX_BYTES + 1);
    rig.approve(id, &denied, false, Some(&long)).await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("4097 bytes") && message.contains("(APPROVAL_MESSAGE_MAX_BYTES)"),
        "{message}"
    );
    rig.approve(id, &denied, false, Some("not that directory"))
        .await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    assert_eq!(
        resolution(&events, &denied),
        (
            proto::ApprovalDecision::Denied,
            Some("not that directory".into())
        )
    );
    assert_eq!(tool_result(&events), (true, "not that directory".into()));
    wait_until("the turn to settle", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;

    rig.approve(id, &denied, true, None).await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains(&format!("no pending permission request {denied:?}")),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{id}")));

    let (history, _) = rig.history(id).await;
    let kinds: Vec<&str> = history
        .iter()
        .filter_map(|e| match &e.kind {
            ThreadEventKind::ApprovalRequest { .. } => Some("request"),
            ThreadEventKind::ApprovalResolved { .. } => Some("resolved"),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, ["request", "resolved", "request", "resolved"]);
}

#[tokio::test]
async fn a_pending_request_is_denied_when_the_session_is_stopped_or_killed() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let stopped = rig.ask(id, "make deploy").await;
    rig.send(json!({"type":"thread_stop","session":id})).await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    let (decision, reason) = resolution(&events, &stopped);
    assert_eq!(decision, proto::ApprovalDecision::Denied);
    assert!(reason.unwrap().contains("Stopped"));
    assert!(matches!(
        events.last().unwrap().kind,
        ThreadEventKind::TurnEnd {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    wait_until("Stop to settle the session", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;

    let killed = rig.ask(id, "make deploy").await;
    let (claude, _) = rig.launches().last().unwrap().clone();
    rig.daemon.kill(id).unwrap();
    wait_until("Claude to end", || {
        !houston_core::pid::process_is_alive(claude)
    })
    .await;
    let (history, _) = rig.history(id).await;
    let (decision, reason) = resolution(&history, &killed);
    assert_eq!(decision, proto::ApprovalDecision::Denied);
    assert!(reason.unwrap().contains("session ended"));
}

#[tokio::test]
async fn houston_answers_permission_prompts_for_threads_only() {
    let mut rig = Rig::new().await;
    let thread = rig.thread().await;
    let shell = rig.create("shell", "terminal").await.unwrap().id;
    let tool_names = |listed: &Value| -> Vec<String> {
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect()
    };
    let list = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    assert!(
        tool_names(&rig.mcp(thread, list.clone()).await).contains(&"thread_permission".to_string())
    );
    assert!(!tool_names(&rig.mcp(shell, list).await).contains(&"thread_permission".to_string()));

    let call = rig
        .mcp(
            shell,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"thread_permission",
                "arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_x"}}}),
        )
        .await;
    assert_eq!(call["result"]["isError"], true, "{call}");
    let text = call["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("never for a terminal pane") && text.contains(&format!("session {shell}")),
        "{text}"
    );
    rig.approve(shell, "any", true, None).await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("thread_approve refused") && message.contains("view terminal"),
        "{message}"
    );
}

#[tokio::test]
async fn changing_the_permission_mode_restarts_an_idle_thread_with_resume() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let info = rig.daemon.list().into_iter().find(|s| s.id == id).unwrap();
    assert_eq!(
        info.permission_mode,
        Some(proto::ThreadPermissionMode::Default)
    );
    rig.turn(id, "replay:warm").await;
    let conversation = arg_after(&rig.launches()[0].1, "--session-id").unwrap();

    rig.send(json!({"type":"thread_set_permission_mode","session":id,"mode":"accept_edits"}))
        .await;
    let updated = loop {
        if let proto::ServerMsg::SessionUpdated { info } = next_control(&mut rig.ws).await {
            if info.id == id {
                break info;
            }
        }
    };
    assert_eq!(
        updated.permission_mode,
        Some(proto::ThreadPermissionMode::AcceptEdits)
    );
    wait_until("the restarted process", || rig.launches().len() == 2).await;
    let restarted = &rig.launches()[1].1;
    assert_eq!(
        arg_after(restarted, "--permission-mode").as_deref(),
        Some("acceptEdits")
    );
    assert_eq!(arg_after(restarted, "--resume"), Some(conversation));
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    assert_eq!(
        db.session_approval_mode(id).unwrap().as_deref(),
        Some("accept_edits"),
        "a respawn keeps the mode"
    );

    let pending = rig.ask(id, "ls").await;
    rig.send(json!({"type":"thread_set_permission_mode","session":id,"mode":"bypass"}))
        .await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("thread_set_permission_mode refused")
            && message.contains("waiting for input"),
        "{message}"
    );
    assert_eq!(rig.launches().len(), 2, "a refused change restarts nothing");
    rig.approve(id, &pending, true, None).await;
}

fn hook(rig: &Rig, event: &str, session: u32, tool: &str, tool_use_id: &str) {
    let drop = houston_core::hook_drop::HookDrop {
        v: houston_core::hook_drop::DROP_V,
        event: event.to_string(),
        session,
        tool_name: Some(tool.to_string()),
        tool_use_id: Some(tool_use_id.to_string()),
        ..Default::default()
    };
    houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(rig._state.path()),
        &drop,
        houston_core::hook_drop::now_ms(),
    )
    .unwrap();
    rig.daemon.hook_drop_tick_for_test();
}

#[tokio::test]
async fn a_mode_change_is_refused_while_a_turn_is_open() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.say(id, "slow:1500").await;
    rig.send(json!({"type":"thread_set_permission_mode","session":id,"mode":"bypass"}))
        .await;
    let (message, _) = tokio::time::timeout(Duration::from_secs(20), rig.error())
        .await
        .expect("the mode change was accepted while a turn was open");
    assert!(
        message.contains("thread_set_permission_mode refused")
            && message.contains("a turn is open"),
        "{message}"
    );
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    assert!(
        events.iter().any(
            |e| matches!(&e.kind, ThreadEventKind::AssistantMessage { text, .. } if text == "slow")
        ),
        "the turn the change would have killed finished: {events:?}"
    );
    assert_eq!(rig.launches().len(), 1, "no restart");
}

#[tokio::test]
async fn tool_activity_and_late_permission_hooks_leave_approval_status_alone() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let held = rig.ask(id, "touch held.txt").await;
    hook(&rig, "PostToolUse", id, "Read", "toolu_other_read");
    assert_eq!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "another tool's activity does not hide a held request"
    );

    rig.approve(id, &held, true, None).await;
    rig.events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    wait_until("the turn to settle", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;
    hook(&rig, "PermissionRequest", id, "Bash", "toolu_late");
    assert_eq!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::Idle),
        "Claude's own permission hook never asks for input in a thread"
    );
}

#[tokio::test]
async fn a_malformed_ask_user_question_is_answered_with_a_reply_instruction() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let events = rig.turn(id, "ask:AskUserQuestion:red or blue").await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.kind, ThreadEventKind::ApprovalRequest { .. })),
        "{events:?}"
    );
    let (is_error, output) = tool_result(&events);
    assert!(is_error);
    assert_eq!(
        output,
        "Ask the question in your reply; Houston cannot show it as choices: \"questions\" must be a non-empty array."
    );
}

#[tokio::test]
async fn thread_answer_is_refused_unless_it_names_a_held_question() {
    let mut rig = Rig::new().await;
    let thread = rig.thread().await;
    let shell = rig.create("shell", "terminal").await.unwrap().id;
    rig.send(json!({"type":"thread_answer","session":shell,"request_id":"q1"}))
        .await;
    let (message, context) = rig.error().await;
    assert!(
        message.starts_with(&format!("thread_answer refused for session {shell}"))
            && message.contains("view terminal"),
        "{message}"
    );
    assert_eq!(
        context.as_deref(),
        Some(format!("session:{shell}").as_str())
    );
    rig.send(
        json!({"type":"thread_answer","session":thread,"request_id":"q1",
        "answers":[{"question":"Which colour?","selected":["Blue"]}]}),
    )
    .await;
    let (message, _) = rig.error().await;
    assert!(
        message.starts_with(&format!("thread_answer refused for session {thread}"))
            && message.contains("no held question \"q1\""),
        "{message}"
    );
}

const COLOUR_AND_FRUIT: &str = r#"{"questions":[{"question":"Which colour do you prefer?","header":"Colour","multiSelect":false,"options":[{"label":"Red","description":"Warm"},{"label":"Blue","description":"Cool"}]},{"question":"Which fruits?","header":"Fruit","multiSelect":true,"options":[{"label":"Plums","description":""},{"label":"Figs","description":""}]}]}"#;

impl Rig {
    /// Asks `AskUserQuestion` with `input` and returns the held question's id.
    async fn ask_question(&mut self, session: u32, input: &str) -> String {
        self.say(session, &format!("askq:{input}")).await;
        let (events, _) = self
            .events_until(session, |e| {
                matches!(e.kind, ThreadEventKind::QuestionRequest { .. })
            })
            .await;
        match &events.last().unwrap().kind {
            ThreadEventKind::QuestionRequest {
                request_id,
                tool_use_id,
                questions,
                truncated,
            } => {
                assert!(tool_use_id.starts_with("toolu_askq_"), "{tool_use_id}");
                assert!(!truncated);
                assert_eq!(questions[0].question, "Which colour do you prefer?");
                assert!(questions[1].multi_select);
                request_id.clone()
            }
            other => panic!("expected a question request, got {other:?}"),
        }
    }

    async fn answer(&mut self, session: u32, request_id: &str, answers: Value) {
        self.send(
            json!({"type":"thread_answer","session":session,"request_id":request_id,
            "answers":answers}),
        )
        .await;
    }
}

fn question_resolution(
    events: &[ThreadEvent],
    id: &str,
) -> (
    proto::QuestionOutcome,
    Vec<proto::QuestionAnswer>,
    Option<String>,
) {
    events
        .iter()
        .find_map(|e| match &e.kind {
            ThreadEventKind::QuestionResolved {
                request_id,
                outcome,
                answers,
                reason,
            } if request_id == id => Some((*outcome, answers.clone(), reason.clone())),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no resolution of question {id} in {events:?}"))
}

#[tokio::test]
async fn a_held_question_waits_for_input_and_claude_reads_the_answers() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let asked = rig.ask_question(id, COLOUR_AND_FRUIT).await;
    assert_eq!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "a held question asks for input"
    );

    rig.approve(id, &asked, true, None).await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("is a question; answer or skip it with thread_answer"),
        "{message}"
    );
    rig.answer(
        id,
        &asked,
        json!([{"question":"Which colour do you prefer?","selected":["Purple"]},
               {"question":"Which fruits?","selected":["Plums"]}]),
    )
    .await;
    let (message, context) = rig.error().await;
    assert!(
        message.starts_with(&format!("thread_answer refused for session {id}"))
            && message.contains("\"Purple\" is not an option"),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{id}")));

    let answers = json!([{"question":"Which colour do you prefer?","selected":["Blue"]},
        {"question":"Which fruits?","selected":["Plums","Figs"],"other":"pears"}]);
    rig.answer(id, &asked, answers.clone()).await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    let (outcome, recorded, reason) = question_resolution(&events, &asked);
    assert_eq!(outcome, proto::QuestionOutcome::Answered);
    assert_eq!(
        serde_json::to_value(&recorded).unwrap()[1]["other"],
        "pears"
    );
    assert_eq!(reason, None);
    assert_eq!(
        tool_result(&events),
        (
            false,
            "Your questions have been answered: \"Which colour do you prefer?\"=\"Blue\", \
             \"Which fruits?\"=\"Plums, Figs, pears\". You can now continue with these answers \
             in mind."
                .into()
        )
    );
    wait_until("the turn to settle", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;

    rig.answer(id, &asked, answers).await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains(&format!("no held question {asked:?}")),
        "an answered question cannot be answered again: {message}"
    );
    let (history, _) = rig.history(id).await;
    let (_, stored, _) = question_resolution(&history, &asked);
    assert_eq!(
        stored, recorded,
        "the answers are kept in the thread's history"
    );
}

#[tokio::test]
async fn a_skipped_question_is_denied_and_stop_denies_a_held_one() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let skipped = rig.ask_question(id, COLOUR_AND_FRUIT).await;
    rig.send(json!({"type":"thread_answer","session":id,"request_id":skipped}))
        .await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    let (outcome, answers, _) = question_resolution(&events, &skipped);
    assert_eq!(outcome, proto::QuestionOutcome::Skipped);
    assert!(answers.is_empty());
    assert_eq!(
        tool_result(&events),
        (true, "The user skipped the question.".into())
    );
    wait_until("the turn to settle", || {
        rig.daemon.session_status(id).ok().flatten() == Some(proto::AgentStatus::Idle)
    })
    .await;

    let stopped = rig.ask_question(id, COLOUR_AND_FRUIT).await;
    rig.send(json!({"type":"thread_stop","session":id})).await;
    let (events, _) = rig
        .events_until(id, |e| matches!(e.kind, ThreadEventKind::TurnEnd { .. }))
        .await;
    let (outcome, _, reason) = question_resolution(&events, &stopped);
    assert_eq!(outcome, proto::QuestionOutcome::Denied);
    assert!(reason.unwrap().contains("Stopped"));
    assert!(!events
        .iter()
        .any(|e| matches!(e.kind, ThreadEventKind::ApprovalResolved { .. })));
}

#[tokio::test]
async fn a_daemon_shutdown_withdraws_a_held_question() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let held = rig.ask_question(id, COLOUR_AND_FRUIT).await;
    let daemon = Arc::clone(&rig.daemon);
    tokio::task::spawn_blocking(move || daemon.manage_shutdown().map(|_| ()))
        .await
        .unwrap()
        .map_err(|failure| format!("{failure:?}"))
        .unwrap();
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    let (history, _) = db.thread_events_page(id, None, 500).unwrap();
    let (outcome, _, reason) = question_resolution(&history, &held);
    assert_eq!(outcome, proto::QuestionOutcome::Withdrawn);
    assert!(reason.unwrap().contains("Houston restarted"));
}

#[tokio::test]
async fn the_permission_mode_follows_what_claude_reports() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.send(json!({"type":"thread_set_permission_mode","session":id,"mode":"plan"}))
        .await;
    wait_until("the plan restart", || rig.launches().len() == 2).await;
    assert_eq!(
        arg_after(&rig.launches()[1].1, "--permission-mode").as_deref(),
        Some("plan")
    );

    rig.turn(id, "mode:default").await;
    wait_until("the reported mode", || {
        rig.daemon
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .and_then(|s| s.permission_mode)
            == Some(proto::ThreadPermissionMode::Default)
    })
    .await;
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    assert_eq!(
        db.session_approval_mode(id).unwrap().as_deref(),
        Some("default")
    );

    // Control requests run concurrently: a send racing the stop would reach the plan process.
    let (plan, _) = rig.launches().last().unwrap().clone();
    rig.send(json!({"type":"thread_stop","session":id})).await;
    wait_until("the stop to end the plan process", || {
        !houston_core::pid::process_is_alive(plan)
    })
    .await;
    rig.turn(id, "replay:warm").await;
    let launches = rig.launches();
    assert_eq!(launches.len(), 3, "the turn after the stop relaunches");
    let restarted = launches.last().unwrap().1.clone();
    assert!(
        !restarted.iter().any(|arg| arg == "--permission-mode"),
        "a restart after leaving plan mode does not return to it: {restarted:?}"
    );
}

#[tokio::test]
async fn a_daemon_shutdown_withdraws_a_held_request() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let held = rig.ask(id, "make deploy").await;
    let daemon = Arc::clone(&rig.daemon);
    tokio::task::spawn_blocking(move || daemon.manage_shutdown().map(|_| ()))
        .await
        .unwrap()
        .map_err(|failure| format!("{failure:?}"))
        .unwrap();
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    let (history, _) = db.thread_events_page(id, None, 500).unwrap();
    let (decision, reason) = resolution(&history, &held);
    assert_eq!(decision, proto::ApprovalDecision::Withdrawn);
    assert!(reason.unwrap().contains("Houston restarted"));
}

#[tokio::test]
async fn a_truncated_request_reports_its_full_size_and_requests_are_capped() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let big = "y".repeat(proto::THREAD_APPROVAL_INPUT_MAX_BYTES + 100);
    rig.say(id, &format!("ask:Bash:{big}")).await;
    let (events, _) = rig
        .events_until(id, |e| {
            matches!(e.kind, ThreadEventKind::ApprovalRequest { .. })
        })
        .await;
    match &events.last().unwrap().kind {
        ThreadEventKind::ApprovalRequest {
            input,
            truncated,
            input_bytes,
            ..
        } => {
            assert!(*truncated);
            assert_eq!(input.len(), proto::THREAD_APPROVAL_INPUT_MAX_BYTES);
            assert!(*input_bytes as usize > proto::THREAD_APPROVAL_INPUT_MAX_BYTES + 100);
        }
        other => panic!("expected an approval request, got {other:?}"),
    }

    let token = rig
        .daemon
        .mcp_creds
        .issue(houston_core::mcp_creds::McpScope {
            session_id: id,
            workspace_id: rig.project.path().display().to_string(),
        });
    let held: Vec<_> = (1..houston_core::thread_session::APPROVALS_PENDING_MAX)
        .map(|at| {
            let request = reqwest::Client::new()
                .post(format!("http://{}/mcp", rig.addr))
                .bearer_auth(token.clone())
                .json(
                    &json!({"jsonrpc":"2.0","id":at,"method":"tools/call","params":{
                    "name":"thread_permission",
                    "arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t"}}}),
                );
            tokio::spawn(async move { request.send().await })
        })
        .collect();
    wait_until("the requests to be held", || {
        rig.daemon.list().iter().any(|s| s.id == id) && held.iter().all(|call| !call.is_finished())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        held.iter().all(|call| !call.is_finished()),
        "held, not answered"
    );
    let refused = rig
        .mcp(
            id,
            json!({"jsonrpc":"2.0","id":99,"method":"tools/call","params":{
                "name":"thread_permission",
                "arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t"}}}),
        )
        .await;
    let text = refused["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("limit is 16") && text.contains("APPROVALS_PENDING_MAX"),
        "{text}"
    );
}

#[tokio::test]
async fn interactive_tool_hooks_neither_ask_for_input_nor_open_an_episode_in_a_thread() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.turn(id, "ask:AskUserQuestion:red or blue").await;
    let question = format!("toolu_ask_{}", rig.launches()[0].0);
    hook(&rig, "PreToolUse", id, "AskUserQuestion", &question);
    hook(&rig, "PreToolUse", id, "ExitPlanMode", "toolu_plan");
    assert_ne!(
        rig.daemon.session_status(id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "the prompt tool owns a thread's interactive tools; their hooks ask for nothing"
    );
    assert_eq!(rig.daemon.open_permission_episodes_for_test(id), 0);
}

/// Stop denies a held request and reports the status under the thread's operation lock;
/// a Restart or shutdown closing the thread meanwhile must not hold a lock that report takes.
#[cfg(feature = "test-barriers")]
async fn close_while_stop_denies_a_held_request(during: DuringStop) {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let held = rig.ask(id, "make deploy").await;
    let barrier = TestBarrier::arm("thread-approvals-report");
    let daemon = Arc::clone(&rig.daemon);
    let stop = std::thread::spawn(move || daemon.thread_stop(id));
    barrier.reached(id).await;
    both_finish(&rig, id, stop, during, || barrier.release()).await;
    // A Restart moves the history to its replacement session.
    let owner = rig
        .daemon
        .list()
        .into_iter()
        .filter(|s| s.view == proto::SessionView::Thread)
        .map(|s| s.id)
        .max()
        .unwrap_or(id);
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    let (history, _) = db.thread_events_page(owner, None, 500).unwrap();
    let (decision, reason) = resolution(&history, &held);
    assert_eq!(decision, proto::ApprovalDecision::Denied);
    assert!(reason.unwrap().contains("Stopped"));
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_restart_while_stop_denies_a_held_request_finishes() {
    close_while_stop_denies_a_held_request(restart).await;
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_shutdown_while_stop_denies_a_held_request_finishes() {
    close_while_stop_denies_a_held_request(shut_down).await;
}

#[test]
fn a_launch_record_still_being_written_is_left_for_the_next_read() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("launches.jsonl");
    std::fs::write(
        &log,
        "{\"pid\":1,\"argv\":[\"-p\"]}\n{\"pid\":2,\"argv\":[\"-p\",\"--ses",
    )
    .unwrap();
    let records = jsonl_records(&log);
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["pid"], 1);
    std::fs::write(&log, "").unwrap();
    assert!(jsonl_records(&log).is_empty());
}

impl Rig {
    /// Every message the fake read on stdin (logged beside its launch log), oldest first.
    fn stdin_texts(&self) -> Vec<String> {
        jsonl_records(&self.scratch.path().join("stdin.jsonl"))
            .into_iter()
            .filter_map(|record| record["text"].as_str().map(str::to_string))
            .collect()
    }

    /// A message whose turn stays open until the returned file exists.
    fn gate(&self, name: &str) -> (String, PathBuf) {
        let path = self.scratch.path().join(format!("gate-{name}"));
        (format!("gate:{}", path.display()), path)
    }

    async fn queue_until(
        &mut self,
        session: u32,
        done: impl Fn(&[proto::ThreadQueuedMessage]) -> bool,
    ) -> Vec<proto::ThreadQueuedMessage> {
        loop {
            match next_control(&mut self.ws).await {
                proto::ServerMsg::ThreadQueue { session: s, items } if s == session => {
                    if done(&items) {
                        return items;
                    }
                }
                proto::ServerMsg::Error { message, .. } => panic!("unexpected error: {message}"),
                _ => {}
            }
        }
    }

    /// Starts a turn that stays open, and waits until the fake has read it.
    async fn gated_turn(&mut self, session: u32, name: &str) -> (String, PathBuf) {
        let (text, open) = self.gate(name);
        self.say(session, &text).await;
        let expected = text.clone();
        wait_until("the gated message to reach the fake", || {
            self.stdin_texts().last() == Some(&expected)
        })
        .await;
        (text, open)
    }
}

/// User messages with their delivery and turn ends, in history order.
fn turn_log(daemon: &Daemon, id: u32) -> Vec<String> {
    history_of(daemon, id)
        .into_iter()
        .filter_map(|event| match event.kind {
            ThreadEventKind::UserMessage { text, delivery } => {
                Some(format!("{text} ({delivery:?})"))
            }
            ThreadEventKind::TurnEnd { outcome, .. } => Some(format!("end {outcome:?}")),
            _ => None,
        })
        .collect()
}

fn turn_ends(daemon: &Daemon, id: u32) -> usize {
    turn_log(daemon, id)
        .iter()
        .filter(|line| line.starts_with("end "))
        .count()
}

#[tokio::test]
async fn messages_sent_during_a_turn_wait_and_go_once_each_in_order() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (gate, open) = rig.gated_turn(id, "a").await;
    rig.say(id, "second").await;
    rig.say(id, "third").await;
    let queued = rig.queue_until(id, |items| items.len() == 2).await;
    assert_eq!(
        queued
            .iter()
            .map(|item| (item.text.as_str(), item.state))
            .collect::<Vec<_>>(),
        [
            ("second", proto::QueuedState::Queued),
            ("third", proto::QueuedState::Queued)
        ]
    );
    assert_eq!(
        rig.stdin_texts(),
        std::slice::from_ref(&gate),
        "nothing is written while a turn is open"
    );
    std::fs::write(&open, b"").unwrap();
    wait_until("both queued messages to be answered", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    assert_eq!(
        rig.stdin_texts(),
        [gate.clone(), "second".into(), "third".into()]
    );
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Completed".into(),
            "second (Queued)".into(),
            "end Completed".into(),
            "third (Queued)".into(),
            "end Completed".into(),
        ],
        "each message has its own turn"
    );
    assert!(matches!(
        rig.daemon.thread_queue_list(id).unwrap(),
        proto::ServerMsg::ThreadQueue { items, .. } if items.is_empty()
    ));
}

#[tokio::test]
async fn steering_a_queued_message_stops_the_turn_and_sends_it_first() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (gate, _open) = rig.gated_turn(id, "a").await;
    rig.say(id, "second").await;
    rig.say(id, "third").await;
    let queued = rig.queue_until(id, |items| items.len() == 2).await;
    rig.send(json!({"type":"thread_steer","session":id,"id":queued[1].id}))
        .await;
    wait_until("the steered and the queued message to be answered", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Interrupted".into(),
            "third (Steered)".into(),
            "end Completed".into(),
            "second (Queued)".into(),
            "end Completed".into(),
        ]
    );
    assert_eq!(rig.stdin_texts(), [gate, "third".into(), "second".into()]);
}

#[tokio::test]
async fn a_steered_send_goes_before_the_queue_and_an_idle_one_goes_at_once() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (gate, _open) = rig.gated_turn(id, "a").await;
    rig.say(id, "queued").await;
    rig.queue_until(id, |items| items.len() == 1).await;
    rig.send(json!({"type":"thread_send","session":id,"text":"now","steer":true}))
        .await;
    wait_until("the steered message and the queue to be answered", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    rig.send(json!({"type":"thread_send","session":id,"text":"idle","steer":true}))
        .await;
    wait_until("the idle steer to be answered", || {
        turn_ends(&rig.daemon, id) == 4
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Interrupted".into(),
            "now (Steered)".into(),
            "end Completed".into(),
            "queued (Queued)".into(),
            "end Completed".into(),
            "idle (Direct)".into(),
            "end Completed".into(),
        ]
    );
}

#[tokio::test]
async fn stop_holds_the_queue_until_the_user_sends_it() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (gate, _open) = rig.gated_turn(id, "a").await;
    rig.say(id, "later").await;
    rig.queue_until(id, |items| items.len() == 1).await;
    rig.send(json!({"type":"thread_stop","session":id})).await;
    let held = rig
        .queue_until(id, |items| {
            items
                .first()
                .is_some_and(|item| item.state == proto::QueuedState::Held)
        })
        .await;
    assert_eq!(
        held[0].hold_reason.as_deref(),
        Some("Stopped before this message was sent.")
    );

    rig.send(json!({"type":"session_set_view","session":id,"view":"terminal"}))
        .await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("1 queued messages wait in this thread; send or clear them first"),
        "{message}"
    );

    rig.say(id, "fresh").await;
    wait_until("the idle message to be answered", || {
        turn_ends(&rig.daemon, id) == 2
    })
    .await;
    assert_eq!(
        rig.stdin_texts(),
        [gate.clone(), "fresh".into()],
        "a held message waits; an idle send goes past it"
    );
    rig.send(json!({"type":"thread_queue_send","session":id,"id":held[0].id}))
        .await;
    wait_until("the held message to be answered", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Interrupted".into(),
            "fresh (Direct)".into(),
            "end Completed".into(),
            "later (Queued)".into(),
            "end Completed".into(),
        ]
    );
}

#[tokio::test]
async fn the_queue_refuses_a_message_past_its_limit_by_name() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.gated_turn(id, "a").await;
    for n in 0..proto::THREAD_QUEUE_MAX_ITEMS {
        rig.say(id, &format!("q{n}")).await;
    }
    rig.queue_until(id, |items| items.len() == proto::THREAD_QUEUE_MAX_ITEMS)
        .await;
    rig.say(id, "one too many").await;
    let (message, context) = rig.error().await;
    assert!(
        message.starts_with(&format!("thread_send refused for session {id}"))
            && message
                .contains("the queue holds 16 messages, the limit (THREAD_QUEUE_MAX_ITEMS) is 16")
            && message.contains("queue a message"),
        "{message}"
    );
    assert_eq!(context, Some(format!("session:{id}")));
    rig.daemon.close(id).unwrap();
}

#[tokio::test]
async fn an_orchestration_prompt_waits_behind_the_users_queue() {
    let mut rig = Rig::new().await;
    let parent = rig.create("shell", "terminal").await.unwrap().id;
    let child = rig.thread().await;
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    db.delegation_create(
        parent,
        child,
        Some("worker"),
        "task",
        houston_core::hook_drop::now_ms(),
    )
    .unwrap();
    rig.daemon.orchestration_set(true).unwrap();
    let (gate, open) = rig.gated_turn(child, "a").await;
    rig.say(child, "mine").await;
    rig.queue_until(child, |items| items.len() == 1).await;
    let daemon = Arc::clone(&rig.daemon);
    tokio::task::spawn_blocking(move || {
        daemon.orchestrate_instruction_request(parent, child, "from the parent", None, None)
    })
    .await
    .unwrap()
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(rig.stdin_texts(), std::slice::from_ref(&gate));
    std::fs::write(&open, b"").unwrap();
    wait_until("the queue and then the prompt to be delivered", || {
        rig.stdin_texts().len() == 3
    })
    .await;
    let written = rig.stdin_texts();
    assert_eq!(written[1], "mine", "{written:?}");
    assert!(written[2].contains("from the parent"), "{written:?}");
}

/// A Claude lifecycle hook with no tool, as the CLI writes it.
fn lifecycle_hook(rig: &Rig, event: &str, session: u32) {
    let drop = houston_core::hook_drop::HookDrop {
        v: houston_core::hook_drop::DROP_V,
        event: event.to_string(),
        session,
        ..Default::default()
    };
    houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(rig._state.path()),
        &drop,
        houston_core::hook_drop::now_ms(),
    )
    .unwrap();
    rig.daemon.hook_drop_tick_for_test();
}

#[tokio::test]
async fn a_late_stop_hook_leaves_the_next_queued_turn_working() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (_, open_a) = rig.gated_turn(id, "a").await;
    lifecycle_hook(&rig, "UserPromptSubmit", id);
    let status = |rig: &Rig| rig.daemon.session_status(id).ok().flatten();
    wait_until("the prompt hook to report working", || {
        status(&rig) == Some(proto::AgentStatus::Working)
    })
    .await;
    let (gate_b, open_b) = rig.gate("b");
    rig.say(id, &gate_b).await;
    rig.queue_until(id, |items| items.len() == 1).await;
    std::fs::write(&open_a, b"").unwrap();
    wait_until("the queued turn to start", || {
        rig.stdin_texts().last() == Some(&gate_b)
    })
    .await;
    lifecycle_hook(&rig, "Stop", id);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        status(&rig),
        Some(proto::AgentStatus::Working),
        "turn A's Stop hook must not report the running queued turn idle"
    );
    std::fs::write(&open_b, b"").unwrap();
    wait_until("the queued turn's end to apply the deferred hook", || {
        status(&rig) == Some(proto::AgentStatus::Idle)
    })
    .await;
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_steer_after_the_turn_ended_sends_once_as_queued() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let barrier = TestBarrier::arm("thread-queue-drain");
    let (gate, open) = rig.gated_turn(id, "a").await;
    rig.say(id, "next").await;
    let queued = rig.queue_until(id, |items| items.len() == 1).await;
    std::fs::write(&open, b"").unwrap();
    barrier.reached(id).await;
    rig.send(json!({"type":"thread_steer","session":id,"id":queued[0].id}))
        .await;
    wait_until("the steered message to be written", || {
        rig.stdin_texts().len() == 2
    })
    .await;
    barrier.release();
    wait_until("both turns to end", || turn_ends(&rig.daemon, id) == 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.stdin_texts(), [gate.clone(), "next".into()]);
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Completed".into(),
            "next (Queued)".into(),
            "end Completed".into(),
        ],
        "a turn that already ended is not stopped"
    );
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_steer_racing_the_drain_sends_the_message_once() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let barrier = TestBarrier::arm("thread-steer");
    let (gate, open) = rig.gated_turn(id, "a").await;
    rig.say(id, "next").await;
    let queued = rig.queue_until(id, |items| items.len() == 1).await;
    let daemon = Arc::clone(&rig.daemon);
    let message = queued[0].id.clone();
    let steer = std::thread::spawn(move || daemon.thread_steer(id, &message));
    barrier.reached(id).await;
    std::fs::write(&open, b"").unwrap();
    wait_until("the drain to send the queued message", || {
        rig.stdin_texts().len() == 2
    })
    .await;
    barrier.release();
    let refused = within("thread_steer", Duration::from_secs(10), move || {
        steer.join().unwrap()
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("is not in its queue"), "{refused}");
    wait_until("both turns to end", || turn_ends(&rig.daemon, id) == 2).await;
    assert_eq!(rig.stdin_texts(), [gate.clone(), "next".into()]);
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Completed".into(),
            "next (Queued)".into(),
            "end Completed".into(),
        ]
    );
}

fn queue_len(daemon: &Daemon, id: u32) -> usize {
    match daemon.thread_queue_list(id).unwrap() {
        proto::ServerMsg::ThreadQueue { items, .. } => items.len(),
        other => panic!("expected the queue, got {other:?}"),
    }
}

/// Claude starts a turn by itself (a background task's report): `system/init` opens it, so
/// a message sent meanwhile waits for its `result` instead of being folded into it.
#[tokio::test]
async fn a_message_sent_during_a_turn_claude_started_waits_for_it() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (_, open) = rig.gate("woken");
    let wake = format!("wake:{}", open.display());
    rig.say(id, &wake).await;
    rig.events_until(id, |e| {
        matches!(&e.kind, ThreadEventKind::AssistantDelta { message_id, .. } if message_id.starts_with("msg_wake"))
    })
    .await;
    rig.say(id, "mine").await;
    wait_until("the message to be queued", || {
        queue_len(&rig.daemon, id) == 1
    })
    .await;
    std::fs::write(&open, b"").unwrap();
    wait_until("the queued message to be answered", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{wake} (Direct)"),
            "end Completed".into(),
            "end Completed".into(),
            "mine (Queued)".into(),
            "end Completed".into(),
        ]
    );
    assert_eq!(rig.stdin_texts(), [wake, "mine".into()]);
}

/// A `SubagentStart` hook as the CLI writes it.
fn subagent_hook(rig: &Rig, session: u32, agent_id: &str) {
    let drop = houston_core::hook_drop::HookDrop {
        v: houston_core::hook_drop::DROP_V,
        event: "SubagentStart".to_string(),
        session,
        agent_id: Some(agent_id.to_string()),
        ..Default::default()
    };
    houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(rig._state.path()),
        &drop,
        houston_core::hook_drop::now_ms(),
    )
    .unwrap();
    rig.daemon.hook_drop_tick_for_test();
}

/// Headless Claude runs its Stop hook before `result`: only the status change waits for the
/// result, so a sub-agent still in flight keeps the thread working past it.
#[tokio::test]
async fn a_stop_hook_ahead_of_its_result_keeps_the_sub_agent_hold() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (_, open) = rig.gated_turn(id, "a").await;
    let status = |rig: &Rig| rig.daemon.session_status(id).ok().flatten();
    lifecycle_hook(&rig, "UserPromptSubmit", id);
    wait_until("the prompt hook to report working", || {
        status(&rig) == Some(proto::AgentStatus::Working)
    })
    .await;
    subagent_hook(&rig, id, "agent-1");
    lifecycle_hook(&rig, "Stop", id);
    std::fs::write(&open, b"").unwrap();
    wait_until("the turn to end", || turn_ends(&rig.daemon, id) == 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        status(&rig),
        Some(proto::AgentStatus::Working),
        "a sub-agent in flight holds the turn end"
    );
}

/// Stop settles the status itself, so a Stop hook deferred in the stopped turn is not
/// applied by the next turn's `result`.
#[tokio::test]
async fn stop_drops_a_deferred_stop_hook() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let status = |rig: &Rig| rig.daemon.session_status(id).ok().flatten();
    rig.gated_turn(id, "a").await;
    lifecycle_hook(&rig, "UserPromptSubmit", id);
    lifecycle_hook(&rig, "Stop", id);
    rig.send(json!({"type":"thread_stop","session":id})).await;
    wait_until("the stopped turn to end", || {
        turn_ends(&rig.daemon, id) == 1
    })
    .await;
    let (_, open_b) = rig.gated_turn(id, "b").await;
    lifecycle_hook(&rig, "UserPromptSubmit", id);
    wait_until("the next turn to report working", || {
        status(&rig) == Some(proto::AgentStatus::Working)
    })
    .await;
    std::fs::write(&open_b, b"").unwrap();
    wait_until("the next turn to end", || turn_ends(&rig.daemon, id) == 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        status(&rig),
        Some(proto::AgentStatus::Working),
        "only the next turn's own Stop hook ends it"
    );
    lifecycle_hook(&rig, "Stop", id);
    wait_until("its own Stop hook to report idle", || {
        status(&rig) == Some(proto::AgentStatus::Idle)
    })
    .await;
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_steer_that_finds_the_turn_ended_stops_nothing() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let barrier = TestBarrier::arm("thread-steer-stop");
    let (gate, open) = rig.gated_turn(id, "a").await;
    rig.say(id, "next").await;
    let queued = rig.queue_until(id, |items| items.len() == 1).await;
    let daemon = Arc::clone(&rig.daemon);
    let message = queued[0].id.clone();
    let steer = std::thread::spawn(move || daemon.thread_steer(id, &message));
    barrier.reached(id).await;
    std::fs::write(&open, b"").unwrap();
    wait_until("the turn to end", || turn_ends(&rig.daemon, id) == 1).await;
    barrier.release();
    within("thread_steer", Duration::from_secs(10), move || {
        steer.join().unwrap()
    })
    .await
    .unwrap();
    wait_until("the steered message to be answered", || {
        turn_ends(&rig.daemon, id) == 2
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            format!("{gate} (Direct)"),
            "end Completed".into(),
            "next (Queued)".into(),
            "end Completed".into(),
        ],
        "a turn that ended is not stopped, and its message is not labelled steered"
    );
    assert_eq!(rig.launches().len(), 1, "the idle process kept running");
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_failed_turn_holds_only_what_was_queued_before_it_ended() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let barrier = TestBarrier::arm("thread-queue-drain");
    rig.turn(id, "fail").await;
    barrier.reached(id).await;
    let (gate, open) = rig.gated_turn(id, "b").await;
    rig.say(id, "later").await;
    rig.queue_until(id, |items| items.len() == 1).await;
    barrier.release();
    tokio::time::sleep(Duration::from_millis(200)).await;
    std::fs::write(&open, b"").unwrap();
    wait_until("the message queued during the next turn to go", || {
        turn_ends(&rig.daemon, id) == 3
    })
    .await;
    assert_eq!(
        turn_log(&rig.daemon, id),
        [
            "fail (Direct)".into(),
            "end Error".into(),
            format!("{gate} (Direct)"),
            "end Completed".into(),
            "later (Queued)".into(),
            "end Completed".into(),
        ]
    );
}

/// Queue snapshots of the next `count` changes to `session`, in arrival order.
#[cfg(feature = "test-barriers")]
async fn queue_snapshots(
    ws: &mut WsStream,
    session: u32,
    count: usize,
) -> Vec<Vec<proto::ThreadQueuedMessage>> {
    let mut snapshots = Vec::new();
    while snapshots.len() < count {
        match next_control(ws).await {
            proto::ServerMsg::ThreadQueue { session: s, items } if s == session => {
                snapshots.push(items)
            }
            proto::ServerMsg::Error { message, .. } => panic!("unexpected error: {message}"),
            _ => {}
        }
    }
    snapshots
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn queue_snapshots_arrive_in_the_order_the_queue_changed() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (_, open) = rig.gated_turn(id, "a").await;
    rig.say(id, "first").await;
    rig.say(id, "second").await;
    let queued = rig.queue_until(id, |items| items.len() == 2).await;
    let barrier = TestBarrier::arm("thread-queue-publish");
    std::fs::write(&open, b"").unwrap();
    barrier.reached(id).await;
    rig.send(json!({"type":"thread_queue_remove","session":id,"id":queued[1].id}))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    barrier.release();
    let snapshots = queue_snapshots(&mut rig.ws, id, 2).await;
    let texts: Vec<Vec<&str>> = snapshots
        .iter()
        .map(|items| items.iter().map(|item| item.text.as_str()).collect())
        .collect();
    assert_eq!(
        texts,
        [vec!["second"], vec![]],
        "the last snapshot is the queue as it is"
    );
}

#[tokio::test]
async fn a_stop_hook_adds_no_inbox_text_ahead_of_queued_messages() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    rig.gated_turn(id, "a").await;
    rig.say(id, "mine").await;
    let queued = rig.queue_until(id, |items| items.len() == 1).await;
    let db = Db::open(&rig._state.path().join("test.db")).unwrap();
    let row = houston_core::db::NewInboxRow {
        to_session: id,
        workspace: rig.project.path().display().to_string(),
        from_session: None,
        request_id: None,
        kind: "result".into(),
        urgent: false,
        summary: "from a child".into(),
        body: "child result".into(),
        artifacts: Vec::new(),
        provisional: false,
        corrects: None,
        reason: None,
        ready: true,
    };
    db.inbox_insert(&row, houston_core::daemon::now_ms())
        .unwrap();
    let later = houston_core::daemon::now_ms() + 1_000;
    assert!(matches!(
        rig.daemon.inbox_reserve_for_stop_hook(id, later).unwrap(),
        houston_core::orchestrate::StopHookReserveOutcome::Empty
    ));
    rig.daemon.thread_queue_remove(id, &queued[0].id).unwrap();
    let reserved = rig.daemon.inbox_reserve_for_stop_hook(id, later).unwrap();
    assert!(
        matches!(
            reserved,
            houston_core::orchestrate::StopHookReserveOutcome::Reserved { .. }
        ),
        "{reserved:?}"
    );
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_prompt_that_loses_the_race_to_a_user_message_waits_for_the_next_idle() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    assert_idle_and_running(&rig.daemon, id).await;
    let barrier = TestBarrier::arm("thread-paste");
    let daemon = Arc::clone(&rig.daemon);
    let paste = std::thread::spawn(move || daemon.paste_text_for_test(id, "from a peer"));
    barrier.reached(id).await;
    let (gate, _open) = rig.gated_turn(id, "a").await;
    barrier.release();
    let pasted = within("the paste", Duration::from_secs(10), move || {
        paste.join().unwrap()
    })
    .await;
    assert!(
        matches!(pasted, Ok(false)),
        "a busy thread leaves the prompt to be retried: {pasted:?}"
    );
    assert_eq!(rig.stdin_texts(), [gate]);
}

/// A queued message whose write Stop cuts off is held once, and the timeline says so.
#[tokio::test]
async fn a_queued_message_stopped_mid_write_goes_back_once_with_a_notice() {
    let mut rig = Rig::new().await;
    let id = rig.thread().await;
    let (_, open) = rig.gate("deaf");
    let deafen = format!("deafen:{}", open.display());
    rig.say(id, &deafen).await;
    wait_until("the fake to read its message", || {
        rig.stdin_texts().last() == Some(&deafen)
    })
    .await;
    // Larger than any pipe buffer: the write blocks because the fake stops reading.
    let big = "y".repeat(200 * 1024);
    rig.say(id, &big).await;
    rig.queue_until(id, |items| items.len() == 1).await;
    std::fs::write(&open, b"").unwrap();
    let is_big = |line: &String| line.starts_with("yyyy") && line.ends_with("(Queued)");
    wait_until("the queued message to be taken", || {
        turn_log(&rig.daemon, id).iter().any(is_big)
    })
    .await;
    rig.send(json!({"type":"thread_stop","session":id})).await;
    let held = rig
        .queue_until(id, |items| {
            items
                .first()
                .is_some_and(|item| item.state == proto::QueuedState::Held)
        })
        .await;
    assert_eq!(held.len(), 1, "the message goes back once");
    assert_eq!(
        held[0].hold_reason.as_deref(),
        Some("Stopped before this message reached Claude.")
    );
    let notice = "Stopped before this message reached Claude; it is back in the queue, held.";
    wait_until("the notice", || {
        history_of(&rig.daemon, id)
            .iter()
            .any(|e| matches!(&e.kind, ThreadEventKind::Notice { text } if text == notice))
    })
    .await;
    assert_eq!(queue_len(&rig.daemon, id), 1);
}

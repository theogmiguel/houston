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
    ws: WsStream,
    project: tempfile::TempDir,
    scratch: tempfile::TempDir,
    _shim: tempfile::TempDir,
    _state: tempfile::TempDir,
    env: houston_core::host_env::HostEnv,
}

fn fake_claude_env(shim: &Path, scratch: &Path) -> houston_core::host_env::HostEnv {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    std::fs::copy(env!("CARGO_BIN_EXE_fake_claude_stream"), shim.join(name)).unwrap();
    let inherited = process_var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(shim.to_path_buf()).chain(std::env::split_paths(&inherited)),
    )
    .unwrap();
    base_env()
        .with("PATH", Some(path))
        .with(
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
        std::fs::read_to_string(self.scratch.path().join("launches.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
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
        .filter(|e| !matches!(e.kind, ThreadEventKind::AssistantDelta { .. }))
        .cloned()
        .collect()
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
        matches!(&live[0].kind, ThreadEventKind::UserMessage { text } if text == "replay:tools")
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

fn thread_row(id: u32, project: &Path) -> proto::SessionInfo {
    let dir: PathBuf = project.to_path_buf();
    proto::SessionInfo {
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
        |e| matches!(&e.kind, ThreadEventKind::UserMessage { text } if text.contains("hello thread"))
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
    rig.say(id, "deaf").await;
    rig.events_until(id, |e| {
        matches!(e.kind, ThreadEventKind::AssistantDelta { .. })
    })
    .await;
    // Larger than any pipe buffer: the write blocks because Claude no longer reads.
    let big = "y".repeat(200 * 1024);
    let daemon = Arc::clone(&rig.daemon);
    let blocked = std::thread::spawn(move || daemon.thread_send(id, &big));
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
        daemon.thread_send(id, "replay:warm")
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
    let next = at(&|k| matches!(k, ThreadEventKind::UserMessage { text } if text == "replay:warm"));
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
        .thread_send(id, &format!("hang:{}", pidfile.display()))
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
    let inherited = process_var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(shim.path().to_path_buf()).chain(std::env::split_paths(&inherited)),
    )
    .unwrap();
    let env = base_env()
        .with("PATH", Some(path))
        .with(
            "HOUSTON_FAKE_CLAUDE_LOG",
            Some(scratch.path().join("launches.jsonl")),
        )
        .with("HOUSTON_FAKE_CLAUDE_FIXTURES", Some(FIXTURES));
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
    let log = std::fs::read_to_string(scratch.path().join("launches.jsonl")).unwrap();
    let argv: Vec<String> = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
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

//! Moving a Claude conversation between terminal and thread view over `/ws`, against the
//! fake `claude` that also serves the thread tests (a terminal launch just waits on its PTY).

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::Daemon;
use houston_core::db::Db;
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use proto::ThreadEventKind;
use serde_json::{json, Value};
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
    state: tempfile::TempDir,
}

impl Rig {
    async fn new() -> Self {
        let shim = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        install_fake_claude(shim.path());
        // Only the fake can resolve as `claude`: a test that loses it must not reach the real CLI.
        let env = hermetic_claude_env(shim.path())
            .with(
                "HOUSTON_FAKE_CLAUDE_LOG",
                Some(scratch.path().join("launches.jsonl")),
            )
            .with("HOUSTON_FAKE_CLAUDE_FIXTURES", Some(FIXTURES));
        let (addr, state, daemon) = start_daemon_with_handle_in(env).await;
        let mut ws = connect_and_hello(addr, TOKEN).await;
        let _ = next_control(&mut ws).await;
        Rig {
            daemon,
            ws,
            project: tempfile::tempdir().unwrap(),
            scratch,
            _shim: shim,
            state,
        }
    }

    async fn send(&mut self, msg: Value) {
        self.ws.send(Message::text(msg.to_string())).await.unwrap();
    }

    async fn create(&mut self, view: &str) -> proto::SessionInfo {
        self.send(json!({"type":"session_create","request":1,"agent":"claude",
            "project_dir":self.project.path(),"view":view}))
            .await;
        loop {
            if let proto::ServerMsg::SessionCreateResult { info, error, .. } =
                next_control(&mut self.ws).await
            {
                return info.unwrap_or_else(|| panic!("create refused: {error:?}"));
            }
        }
    }

    async fn rename(&mut self, session: u32, title: &str) {
        self.send(json!({"type":"session_rename","session":session,"title":title}))
            .await;
        let daemon = Arc::clone(&self.daemon);
        wait_until("the rename", || {
            daemon
                .list()
                .iter()
                .any(|s| s.id == session && s.title == title)
        })
        .await;
    }

    async fn error(&mut self) -> (String, Option<String>) {
        loop {
            if let proto::ServerMsg::Error { message, context } = next_control(&mut self.ws).await {
                return (message, context);
            }
        }
    }

    /// The session that replaced `old` once the switch landed.
    async fn switched(&mut self, old: u32, view: &str) -> proto::SessionInfo {
        self.send(json!({"type":"session_set_view","session":old,"view":view}))
            .await;
        let daemon = Arc::clone(&self.daemon);
        wait_until("the switched session", || {
            daemon.list().iter().all(|s| s.id != old)
                && daemon
                    .list()
                    .iter()
                    .any(|s| s.id > old && s.view.as_str() == view)
        })
        .await;
        self.daemon
            .list()
            .into_iter()
            .find(|s| s.id > old && s.view.as_str() == view)
            .unwrap()
    }

    fn launches(&self) -> Vec<Vec<String>> {
        jsonl_records(&self.scratch.path().join("launches.jsonl"))
            .into_iter()
            .filter_map(|record| serde_json::from_value(record["argv"].clone()).ok())
            .filter(|argv: &Vec<String>| !argv.iter().any(|arg| arg == "--version"))
            .collect()
    }

    fn db(&self) -> Db {
        Db::open(&self.state.path().join("test.db")).unwrap()
    }

    /// A resumable conversation the session's fake CLI can be resumed into.
    fn give_conversation(&self, session: u32, conversation: &str) {
        let transcript = self.scratch.path().join(format!("{conversation}.jsonl"));
        std::fs::write(&transcript, "{}\n").unwrap();
        self.db()
            .set_session_resume_handle(
                session,
                Some((conversation, Some(transcript.to_str().unwrap()))),
            )
            .unwrap();
    }

    async fn hook(&self, event: &str, session: u32, conversation: &str) {
        let drop = HookDrop {
            event: event.into(),
            session,
            session_id: Some(conversation.into()),
            ..Default::default()
        };
        let path = hook_drop::write_drop(
            &hook_drop::drop_dir(self.state.path()),
            &drop,
            hook_drop::now_ms(),
        )
        .unwrap();
        wait_until("the hook drop to apply", || !path.exists()).await;
    }
}

fn arg_after(argv: &[String], flag: &str) -> Option<String> {
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn launch_conversation(argv: &[String]) -> String {
    arg_after(argv, "--session-id")
        .or_else(|| arg_after(argv, "--resume"))
        .unwrap_or_else(|| panic!("no conversation flag in {argv:?}"))
}

#[tokio::test]
async fn a_thread_opens_in_a_terminal_resuming_its_conversation() {
    let mut rig = Rig::new().await;
    let thread = rig.create("thread").await;
    rig.give_conversation(thread.id, "conv-thread");
    rig.rename(thread.id, "Rail flicker").await;
    let terminal = rig.switched(thread.id, "terminal").await;

    assert_eq!(
        terminal.title, "Rail flicker",
        "a renamed session keeps its name"
    );
    assert_eq!(terminal.state, proto::SessionState::Running);
    let argv = rig
        .launches()
        .into_iter()
        .rfind(|argv| !argv.iter().any(|arg| arg == "-p"))
        .expect("a terminal launch of claude");
    assert_eq!(arg_after(&argv, "--resume").as_deref(), Some("conv-thread"));
    rig.daemon.close(terminal.id).unwrap();
}

#[tokio::test]
async fn a_terminal_opens_as_a_thread_with_a_notice_for_its_terminal_turns() {
    let mut rig = Rig::new().await;
    let terminal = rig.create("terminal").await;
    let conversation = launch_conversation(&rig.launches()[0]);
    rig.hook("SessionStart", terminal.id, &conversation).await;
    for _ in 0..3 {
        rig.hook("UserPromptSubmit", terminal.id, &conversation)
            .await;
        rig.hook("Stop", terminal.id, &conversation).await;
    }
    rig.give_conversation(terminal.id, &conversation);
    assert_eq!(rig.db().terminal_turns(terminal.id).unwrap(), 3);
    rig.rename(terminal.id, "Release notes port").await;

    let thread = rig.switched(terminal.id, "thread").await;
    assert_eq!(
        thread.title, "Release notes port",
        "a renamed session keeps its name"
    );
    let argv = rig
        .launches()
        .into_iter()
        .rfind(|argv| argv.iter().any(|arg| arg == "-p"))
        .expect("a thread launch of claude");
    assert_eq!(
        arg_after(&argv, "--resume").as_deref(),
        Some(conversation.as_str())
    );
    match rig.daemon.thread_history(thread.id, None, 50).unwrap() {
        proto::ServerMsg::ThreadHistory { events, .. } => {
            let notices: Vec<&str> = events
                .iter()
                .filter_map(|e| match &e.kind {
                    ThreadEventKind::Notice { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                notices,
                ["3 turns happened in the terminal; this thread does not show them."]
            );
        }
        other => panic!("expected history, got {other:?}"),
    }
    assert_eq!(rig.db().terminal_turns(thread.id).unwrap(), 0);
    rig.daemon.close(thread.id).unwrap();
}

#[tokio::test]
async fn a_switch_is_refused_while_claude_works_and_names_the_status() {
    let mut rig = Rig::new().await;
    let terminal = rig.create("terminal").await;
    let conversation = launch_conversation(&rig.launches()[0]);
    rig.hook("SessionStart", terminal.id, &conversation).await;
    rig.hook("UserPromptSubmit", terminal.id, &conversation)
        .await;
    rig.send(json!({"type":"session_set_view","session":terminal.id,"view":"thread"}))
        .await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains("Open as thread refused")
            && message.contains("status is Working")
            && message.contains(&terminal.id.to_string()),
        "{message}"
    );
    assert_eq!(
        context.as_deref(),
        Some(format!("session:{}", terminal.id).as_str())
    );
    let still = rig
        .daemon
        .list()
        .into_iter()
        .find(|s| s.id == terminal.id)
        .unwrap();
    assert_eq!(still.view, proto::SessionView::Terminal, "nothing moved");

    rig.send(json!({"type":"session_set_view","session":terminal.id,"view":"terminal"}))
        .await;
    let (message, _) = rig.error().await;
    assert!(message.contains("already a terminal session"), "{message}");
    rig.daemon.close(terminal.id).unwrap();
}

#[tokio::test]
async fn a_shell_is_refused_by_name() {
    let mut rig = Rig::new().await;
    rig.send(json!({"type":"session_create","request":1,"agent":"shell",
        "project_dir":rig.project.path()}))
        .await;
    let shell = loop {
        if let proto::ServerMsg::SessionCreateResult { info, .. } = next_control(&mut rig.ws).await
        {
            break info.unwrap();
        }
    };
    rig.send(json!({"type":"session_set_view","session":shell.id,"view":"thread"}))
        .await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("supports Claude only") && message.contains("shell"),
        "{message}"
    );
    // Cleanup only: a fresh ConPTY shell can outlast the close's reader drain under load.
    let _ = rig.daemon.close(shell.id);
}

#[tokio::test]
async fn the_default_view_setting_round_trips_and_leaves_plain_creates_terminal() {
    let mut rig = Rig::new().await;
    rig.send(json!({"type":"default_view_get"})).await;
    let first = loop {
        if let proto::ServerMsg::DefaultView { view } = next_control(&mut rig.ws).await {
            break view;
        }
    };
    assert_eq!(first, proto::SessionView::Terminal);
    rig.send(json!({"type":"default_view_set","view":"thread"}))
        .await;
    let broadcast = loop {
        if let proto::ServerMsg::DefaultView { view } = next_control(&mut rig.ws).await {
            break view;
        }
    };
    assert_eq!(broadcast, proto::SessionView::Thread);
    assert_eq!(rig.daemon.default_view(), proto::SessionView::Thread);
    assert_eq!(
        rig.db().get_setting("default_view").unwrap().as_deref(),
        Some("thread")
    );

    rig.send(json!({"type":"session_create","request":1,"agent":"claude",
        "project_dir":rig.project.path()}))
        .await;
    let plain = loop {
        if let proto::ServerMsg::SessionCreateResult { info, .. } = next_control(&mut rig.ws).await
        {
            break info.unwrap();
        }
    };
    assert_eq!(
        plain.view,
        proto::SessionView::Terminal,
        "only the renderer's new-session flows apply the default"
    );
    rig.daemon.close(plain.id).unwrap();
}

impl Rig {
    fn history(&self, session: u32) -> Vec<proto::ThreadEvent> {
        match self.daemon.thread_history(session, None, 500).unwrap() {
            proto::ServerMsg::ThreadHistory { events, .. } => events,
            other => panic!("expected history, got {other:?}"),
        }
    }

    async fn thread_turn(&mut self, session: u32, text: &str) {
        self.send(json!({"type":"thread_send","session":session,"text":text}))
            .await;
        loop {
            match next_control(&mut self.ws).await {
                proto::ServerMsg::ThreadEvents { session: s, events }
                    if s == session
                        && events
                            .iter()
                            .any(|e| matches!(e.kind, ThreadEventKind::TurnEnd { .. })) =>
                {
                    return
                }
                proto::ServerMsg::Error { message, .. } => panic!("turn refused: {message}"),
                _ => {}
            }
        }
    }
}

fn notices(events: &[proto::ThreadEvent]) -> Vec<(u64, String)> {
    events
        .iter()
        .filter_map(|e| match &e.kind {
            ThreadEventKind::Notice { text } => Some((e.seq, text.clone())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_switch_is_refused_while_a_thread_turn_is_open() {
    let mut rig = Rig::new().await;
    let thread = rig.create("thread").await;
    let pidfile = rig.scratch.path().join("sleeper.pid");
    rig.send(json!({"type":"thread_send","session":thread.id,
        "text":format!("hang:{}", pidfile.display())}))
        .await;
    wait_until("the turn's tool to start", || pidfile.is_file()).await;
    rig.send(json!({"type":"session_set_view","session":thread.id,"view":"terminal"}))
        .await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("Open in terminal refused")
            && (message.contains("a thread turn is still open")
                || message.contains("status is Working")),
        "{message}"
    );
    assert!(
        rig.daemon.list().iter().any(|s| s.id == thread.id),
        "the thread stays"
    );
    rig.send(json!({"type":"thread_stop","session":thread.id}))
        .await;
    rig.daemon.close(thread.id).unwrap();
}

#[tokio::test]
async fn a_round_trip_puts_the_turns_notice_after_the_old_history() {
    let mut rig = Rig::new().await;
    let thread = rig.create("thread").await;
    rig.thread_turn(thread.id, "replay:tools").await;
    let conversation = launch_conversation(
        rig.launches()
            .iter()
            .find(|argv| argv.iter().any(|arg| arg == "-p"))
            .unwrap(),
    );
    rig.give_conversation(thread.id, &conversation);
    let before = rig.history(thread.id);
    let last_old = before.last().unwrap().seq;

    let terminal = rig.switched(thread.id, "terminal").await;
    rig.hook("SessionStart", terminal.id, &conversation).await;
    for _ in 0..2 {
        rig.hook("UserPromptSubmit", terminal.id, &conversation)
            .await;
        rig.hook("Stop", terminal.id, &conversation).await;
    }
    rig.give_conversation(terminal.id, &conversation);
    let back = rig.switched(terminal.id, "thread").await;

    let history = rig.history(back.id);
    assert!(history.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    let (seq, text) = notices(&history).pop().expect("the turns notice");
    assert_eq!(
        text,
        "2 turns happened in the terminal; this thread does not show them."
    );
    assert!(seq > last_old, "the notice follows the old history");
    assert_eq!(
        history
            .iter()
            .filter(|e| e.seq <= last_old)
            .map(|e| e.seq)
            .collect::<Vec<_>>(),
        before.iter().map(|e| e.seq).collect::<Vec<_>>(),
        "the old history moved intact"
    );
    rig.thread_turn(back.id, "replay:warm").await;
    let after = rig.history(back.id);
    let warm = after
        .iter()
        .find(|e| matches!(&e.kind, ThreadEventKind::UserMessage { text } if text == "replay:warm"))
        .expect("the new turn's message");
    assert!(warm.seq > seq, "new events follow the notice");
    assert!(after.last().unwrap().seq > seq);
    rig.daemon.close(back.id).unwrap();
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_message_sent_during_a_switch_is_refused_and_no_turn_is_killed() {
    let mut rig = Rig::new().await;
    let thread = rig.create("thread").await;
    rig.give_conversation(thread.id, "conv-race");
    let barrier = TestBarrier::arm("view-switch-checked");
    let daemon = Arc::clone(&rig.daemon);
    let id = thread.id;
    let switch = tokio::task::spawn_blocking(move || {
        daemon.set_session_view(id, proto::SessionView::Terminal)
    });
    barrier.reached(thread.id).await;

    let pidfile = rig.scratch.path().join("raced.pid");
    rig.send(json!({"type":"thread_send","session":thread.id,
        "text":format!("hang:{}", pidfile.display())}))
        .await;
    let (message, _) = rig.error().await;
    assert!(
        message.contains("thread_send refused") && message.contains("moving to another view"),
        "{message}"
    );
    barrier.release();
    let terminal = switch.await.unwrap().unwrap();
    assert_eq!(terminal.view, proto::SessionView::Terminal);
    assert!(
        !pidfile.exists(),
        "the refused message never started a turn"
    );
    rig.daemon.close(terminal.id).unwrap();
}

#[cfg(feature = "test-barriers")]
#[tokio::test]
async fn a_turn_that_starts_during_a_switch_refuses_it_and_rolls_the_view_back() {
    let mut rig = Rig::new().await;
    let terminal = rig.create("terminal").await;
    let conversation = launch_conversation(&rig.launches()[0]);
    rig.hook("SessionStart", terminal.id, &conversation).await;
    rig.hook("UserPromptSubmit", terminal.id, &conversation)
        .await;
    rig.hook("Stop", terminal.id, &conversation).await;
    rig.give_conversation(terminal.id, &conversation);
    let barrier = TestBarrier::arm("view-switch-checked");
    let daemon = Arc::clone(&rig.daemon);
    let id = terminal.id;
    let switch = tokio::task::spawn_blocking(move || {
        daemon.set_session_view(id, proto::SessionView::Thread)
    });
    barrier.reached(terminal.id).await;
    // Typed into the terminal before the switch's lock: Claude reports the turn it started.
    rig.hook("UserPromptSubmit", terminal.id, &conversation)
        .await;
    barrier.release();

    let refused = format!("{:#}", switch.await.unwrap().unwrap_err());
    assert!(
        refused.contains("Open as thread refused") && refused.contains("status is Working"),
        "{refused}"
    );
    let db = rig.db();
    assert_eq!(
        db.session_view(terminal.id).unwrap(),
        proto::SessionView::Terminal,
        "the view rolls back"
    );
    assert_eq!(
        db.thread_max_seq(terminal.id).unwrap(),
        None,
        "no turns notice is left behind"
    );
    let still = rig
        .daemon
        .list()
        .into_iter()
        .find(|s| s.id == terminal.id)
        .expect("the terminal keeps running");
    assert_eq!(still.state, proto::SessionState::Running);
    rig.daemon.close(terminal.id).unwrap();
}

#[tokio::test]
async fn a_switch_is_refused_while_an_approval_is_held() {
    let mut rig = Rig::new().await;
    let thread = rig.create("thread").await;
    rig.send(json!({"type":"thread_send","session":thread.id,"text":"ask:Bash:touch held.txt"}))
        .await;
    let request_id = loop {
        if let proto::ServerMsg::ThreadEvents { session, events } = next_control(&mut rig.ws).await
        {
            if session != thread.id {
                continue;
            }
            if let Some(id) = events.iter().find_map(|e| match &e.kind {
                ThreadEventKind::ApprovalRequest { request_id, .. } => Some(request_id.clone()),
                _ => None,
            }) {
                break id;
            }
        }
    };
    rig.send(json!({"type":"session_set_view","session":thread.id,"view":"terminal"}))
        .await;
    let (message, context) = rig.error().await;
    assert!(
        message.contains("Open in terminal refused")
            && message.contains("waiting for an answer to a permission request"),
        "{message}"
    );
    assert_eq!(
        context.as_deref(),
        Some(format!("session:{}", thread.id).as_str())
    );
    let still = rig
        .daemon
        .list()
        .into_iter()
        .find(|s| s.id == thread.id)
        .unwrap();
    assert_eq!(still.view, proto::SessionView::Thread, "nothing moved");
    rig.send(
        json!({"type":"thread_approve","session":thread.id,"request_id":request_id,
        "allow":false,"message":null}),
    )
    .await;
    rig.daemon.close(thread.id).unwrap();
}

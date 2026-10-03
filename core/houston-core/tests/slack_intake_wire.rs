#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

//! The Slack intake against a fake Slack on loopback: Web API methods over
//! HTTP and a Socket Mode WebSocket the test pushes envelopes through.

mod common;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::routing::{any, get};
use axum::{Json, Router};
use common::start_daemon_with_handle;
use houston_core::daemon::Daemon;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::broadcast;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

const OWNER: &str = "UOWNER";
const REQUESTER: &str = "UREQ";
const CHANNEL: &str = "C0TEST";

/// A Claude that stays up without hooks, like the task Start tests use.
fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let path = dir.join("claude");
        std::fs::write(
            &path,
            "#!/bin/sh\nstty -echo -icanon 2>/dev/null\necho FIXTURE-READY\nexec cat\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
        keyring_core::set_default_store(keyring_core::mock::Store::new().expect("mock keychain"));
        dir
    })
    .clone()
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[derive(Default)]
struct Recorded {
    posts: Vec<Value>,
    reactions: Vec<Value>,
    acks: Vec<String>,
    history: Vec<Value>,
    next_ts: u64,
}

#[derive(Clone)]
struct Fake {
    rec: Arc<Mutex<Recorded>>,
    push: broadcast::Sender<String>,
    addr: std::net::SocketAddr,
}

impl Fake {
    async fn start() -> Fake {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (push, _) = broadcast::channel(64);
        let fake = Fake {
            rec: Arc::default(),
            push,
            addr,
        };
        let app = Router::new()
            .route("/api/{method}", any(api))
            .route("/socket", get(socket))
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        fake
    }

    fn base(&self) -> String {
        format!("http://{}/api/", self.addr)
    }

    fn send_event(&self, envelope_id: &str, event: Value) {
        let env = json!({
            "envelope_id": envelope_id,
            "type": "events_api",
            "accepts_response_payload": false,
            "payload": {"team_id": "T1", "event_id": format!("Ev{envelope_id}"), "event": event},
        });
        self.push.send(env.to_string()).expect("a connected socket");
    }

    fn posts(&self) -> Vec<Value> {
        self.rec.lock().unwrap().posts.clone()
    }

    async fn await_post(&self, needle: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(p) = self
                .posts()
                .into_iter()
                .find(|p| p["text"].as_str().is_some_and(|t| t.contains(needle)))
            {
                return p;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no post containing {needle:?}; posts: {:?}",
                self.posts()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn api(
    State(fake): State<Fake>,
    axum::extract::Path(method): axum::extract::Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Json<Value> {
    let mut rec = fake.rec.lock().unwrap();
    rec.next_ts += 1;
    let ts = format!("1900000000.{:06}", rec.next_ts);
    Json(match method.as_str() {
        "auth.test" => json!({"ok": true, "team_id": "T1", "team": "Test team", "user_id": "UBOT"}),
        "apps.connections.open" => json!({"ok": true, "url": format!("ws://{}/socket", fake.addr)}),
        "chat.postMessage" => {
            rec.posts
                .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            json!({"ok": true, "ts": ts})
        }
        "reactions.add" => {
            rec.reactions.push(json!(query));
            json!({"ok": true})
        }
        "chat.getPermalink" => {
            json!({"ok": true, "permalink": format!("https://test.slack.com/archives/{}/p{}", query["channel"], query["message_ts"].replace('.', ""))})
        }
        "conversations.history" => {
            json!({"ok": true, "messages": rec.history.iter().rev().cloned().collect::<Vec<_>>()})
        }
        "conversations.replies" => json!({"ok": true, "messages": []}),
        other => json!({"ok": false, "error": format!("unknown_method:{other}")}),
    })
}

async fn socket(State(fake): State<Fake>, ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(move |socket| serve_socket(fake, socket))
}

async fn serve_socket(fake: Fake, mut socket: WebSocket) {
    let mut rx = fake.push.subscribe();
    if socket
        .send(WsMessage::Text(
            json!({"type": "hello", "num_connections": 1})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        if let Some(id) = v["envelope_id"].as_str() {
                            fake.rec.lock().unwrap().acks.push(id.to_string());
                        }
                    }
                }
                Some(Ok(_)) => {}
                _ => return,
            },
            out = rx.recv() => match out {
                Ok(text) => {
                    let close = text.contains("\"disconnect\"");
                    if socket.send(WsMessage::Text(text.into())).await.is_err() || close {
                        return;
                    }
                }
                Err(_) => return,
            },
        }
    }
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
    fake: Fake,
}

async fn rig(name: &str) -> Rig {
    shim_dir();
    let fake = Fake::start().await;
    std::env::set_var(houston_core::slack::api::BASE_ENV, fake.base());
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    git(&ws_dir, &["init", "-b", "main"]);
    git(&ws_dir, &["config", "user.email", "t@t.local"]);
    git(&ws_dir, &["config", "user.name", "t"]);
    std::fs::write(ws_dir.join("README.md"), "hello\n").unwrap();
    git(&ws_dir, &["add", "-A"]);
    git(&ws_dir, &["commit", "-m", "init"]);
    let ws_dir = ws_dir.canonicalize().unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    tokio::spawn(daemon.clone().slack_loops());
    let r = Rig {
        daemon,
        state,
        ws_dir,
        fake,
    };
    let configured = r.daemon.slack_configure(
        Some(OWNER),
        &[proto::SlackChannelMap {
            channel_id: CHANNEL.into(),
            workspace: r.workspace(),
        }],
    );
    assert!(
        matches!(configured, proto::ServerMsg::Slack { refusal: None, .. }),
        "{configured:?}"
    );
    let connected = r
        .daemon
        .slack_connect(Some("xapp-1-test"), Some("xoxb-1-test"));
    assert!(
        matches!(connected, proto::ServerMsg::Slack { refusal: None, .. }),
        "{connected:?}"
    );
    r.await_connected().await;
    r
}

impl Rig {
    fn workspace(&self) -> String {
        self.ws_dir.display().to_string()
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state.path().join("test.db")).unwrap()
    }

    async fn await_connected(&self) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while self.daemon.slack_info().connection != proto::SlackConnection::Connected {
            assert!(
                tokio::time::Instant::now() < deadline,
                "never connected: {:?}",
                self.daemon.slack_info()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// (id, created_by, ref_url) of every task.
    fn tasks(&self) -> Vec<(i64, String, Option<String>)> {
        let conn = self.db();
        let mut stmt = conn
            .prepare("SELECT id, created_by, ref_url FROM backlog_tasks ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// (task_id, session_id, state) of every run.
    /// Runs that have their pane: a Start inserts the row before the session
    /// exists, so one still preparing is not counted yet.
    fn runs(&self) -> Vec<(i64, u32, String)> {
        let conn = self.db();
        let mut stmt = conn
            .prepare(
                "SELECT task_id, session_id, state FROM backlog_task_runs \
                 WHERE session_id IS NOT NULL ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    async fn await_runs(&self, n: usize) -> Vec<(i64, u32, String)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let runs = self.runs();
            if runs.len() >= n {
                return runs;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "expected {n} runs, have {runs:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn await_tasks(&self, n: usize) -> Vec<(i64, String, Option<String>)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let tasks = self.tasks();
            if tasks.len() >= n {
                return tasks;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "expected {n} tasks, have {tasks:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn finish(&self) {
        self.daemon.slack_disconnect();
    }
}

fn mention(ts: &str, user: &str, text: &str) -> Value {
    json!({"type": "app_mention", "channel": CHANNEL, "user": user, "team": "T1", "ts": ts, "text": format!("<@UBOT> {text}")})
}

fn check_mark(ts: &str, user: &str) -> Value {
    json!({"type": "reaction_added", "user": user, "reaction": "white_check_mark",
        "item": {"type": "message", "channel": CHANNEL, "ts": ts}})
}

#[tokio::test]
async fn a_mention_is_filed_pending_and_only_the_owners_check_mark_starts_it() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-accept").await;

    r.fake.send_event(
        "e1",
        mention(
            "1800000000.000100",
            REQUESTER,
            "fix the footer\nit overlaps",
        ),
    );
    let tasks = r.await_tasks(1).await;
    assert_eq!(tasks[0].1, format!("slack:{REQUESTER}"));
    assert!(
        tasks[0].2.as_deref().is_some_and(|u| u.contains(CHANNEL)),
        "permalink as ref_url: {tasks:?}"
    );
    let filed = r.fake.await_post("Filed as HOU-").await;
    assert_eq!(
        filed["thread_ts"], "1800000000.000100",
        "replies go to the request's thread"
    );
    assert!(
        r.fake.rec.lock().unwrap().acks.contains(&"e1".to_string()),
        "the envelope was acknowledged"
    );

    r.fake.send_event(
        "e1-retry",
        mention(
            "1800000000.000100",
            REQUESTER,
            "fix the footer\nit overlaps",
        ),
    );
    let mut bot = mention("1800000000.000200", REQUESTER, "from a bot");
    bot["bot_id"] = json!("B1");
    r.fake.send_event("e2", bot);
    let mut foreign = mention("1800000000.000300", REQUESTER, "from another org");
    foreign["user_team"] = json!("T2");
    r.fake.send_event("e3", foreign);
    r.fake
        .send_event("e4", check_mark("1800000000.000100", REQUESTER));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        r.tasks().len(),
        1,
        "a redelivery, a bot and another team file nothing"
    );
    assert!(
        r.runs().is_empty(),
        "the requester's own check mark starts nothing"
    );

    r.fake
        .send_event("e5", check_mark("1800000000.000100", OWNER));
    let runs = r.await_runs(1).await;
    assert_eq!(runs[0].0, tasks[0].0);
    r.fake.await_post("Started HOU-").await;
    r.finish();
}

#[tokio::test]
async fn a_question_goes_to_the_thread_and_a_result_comes_back_to_it() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-ask").await;
    r.fake.send_event(
        "q1",
        mention("1800000001.000100", REQUESTER, "rename the button"),
    );
    let task_id = r.await_tasks(1).await[0].0;
    r.fake
        .send_event("q2", check_mark("1800000001.000100", OWNER));
    let session = r.await_runs(1).await[0].1;

    let posted = r
        .daemon
        .slack_task_ask(session, "Which label: Save or Submit?")
        .unwrap();
    assert!(posted.contains("End your turn"), "{posted}");
    let err = r
        .daemon
        .slack_task_ask(session, "and a second one?")
        .unwrap_err()
        .to_string();
    assert!(err.contains("already has a question waiting"), "{err}");
    let asked = r
        .fake
        .await_post("asks: Which label: Save or Submit?")
        .await;
    assert_eq!(asked["thread_ts"], "1800000001.000100");

    let reply = |user: &str, text: &str, ts: &str| {
        json!({"type": "message", "channel": CHANNEL, "user": user, "team": "T1", "ts": ts,
            "thread_ts": "1800000001.000100", "text": text})
    };
    r.fake
        .send_event("q3", reply("USOMEONE", "Cancel", "1900000009.000001"));
    r.fake
        .send_event("q4", reply(REQUESTER, "Submit", "1900000009.000002"));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let answer = loop {
        let got: Option<(String, String)> = r
            .db()
            .query_row(
                "SELECT answer, answered_by FROM intake_questions WHERE answer IS NOT NULL",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some(a) = got {
            break a;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the requester's reply never answered the question"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(
        answer,
        ("Submit".to_string(), "requester".to_string()),
        "a bystander's reply is not the answer"
    );

    let handed = r
        .daemon
        .task_handback(
            &r.workspace(),
            task_id,
            &format!("Renamed it in {}/src/a.rs", r.workspace()),
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    assert!(matches!(handed, proto::ServerMsg::TaskChanged { .. }));
    let result = r.fake.await_post("is ready for review").await;
    let text = result["text"].as_str().unwrap();
    assert!(text.contains("Branch: `houston/task/hou-"), "{text}");
    assert!(
        text.contains("./src/a.rs") && !text.contains(&r.workspace()),
        "no local paths: {text}"
    );
    r.finish();
}

#[tokio::test]
async fn accepted_requests_past_the_working_cap_wait_in_a_queue() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-queue").await;
    for i in 1..=3 {
        r.fake.send_event(
            &format!("m{i}"),
            mention(
                &format!("1800000002.00000{i}"),
                REQUESTER,
                &format!("request {i}"),
            ),
        );
    }
    r.await_tasks(3).await;
    for i in 1..=3 {
        r.fake.send_event(
            &format!("a{i}"),
            check_mark(&format!("1800000002.00000{i}"), OWNER),
        );
    }
    let runs = r.await_runs(2).await;
    let queued = r.fake.await_post("number 1 in the queue").await;
    assert_eq!(queued["thread_ts"], "1800000002.000003");
    assert!(queued["text"]
        .as_str()
        .unwrap()
        .contains(&format!("the limit is {}", proto::SLACK_RUNS_WORKING_MAX)));
    assert_eq!(r.runs().len(), 2, "the third waits");

    let (task_id, session, _) = runs[0];
    r.daemon
        .task_handback(
            &r.workspace(),
            task_id,
            "done",
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    let runs = r.await_runs(3).await;
    assert_eq!(runs.len(), 3, "a freed slot starts the queued request");
    r.finish();
}

#[tokio::test]
async fn a_reconnect_replays_what_was_missed_while_offline() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-catchup").await;
    let offline_ts = format!(
        "{}.000100",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 5
    );
    r.fake.rec.lock().unwrap().history.push(json!({
        "type": "message", "user": REQUESTER, "team": "T1", "ts": offline_ts,
        "text": "<@UBOT> sent while Houston was offline",
        "reactions": [{"name": "white_check_mark", "users": [OWNER], "count": 1}],
    }));
    r.fake
        .push
        .send(json!({"type": "disconnect", "reason": "refresh_requested"}).to_string())
        .unwrap();
    let tasks = r.await_tasks(1).await;
    assert_eq!(tasks[0].1, format!("slack:{REQUESTER}"));
    r.await_runs(1).await;
    assert!(r.daemon.slack_info().last_catchup_at_ms.is_some());
    r.finish();
}

#[tokio::test]
async fn configuration_refuses_bad_ids_and_unknown_workspaces_by_name() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-config").await;
    let refused = |msg: proto::ServerMsg| match msg {
        proto::ServerMsg::Slack {
            refusal: Some(why), ..
        } => why,
        other => panic!("expected a refusal, got {other:?}"),
    };
    let why = refused(r.daemon.slack_configure(Some("@augusto"), &[]));
    assert!(
        why.contains("\"@augusto\"") && why.contains("member ID"),
        "{why}"
    );
    let why = refused(r.daemon.slack_configure(
        None,
        &[proto::SlackChannelMap {
            channel_id: "#general".into(),
            workspace: r.workspace(),
        }],
    ));
    assert!(why.contains("\"#general\""), "{why}");
    let why = refused(r.daemon.slack_configure(
        None,
        &[proto::SlackChannelMap {
            channel_id: "C1X".into(),
            workspace: "/nope".into(),
        }],
    ));
    assert!(why.contains("\"/nope\" is not registered"), "{why}");
    let why = refused(r.daemon.slack_connect(Some("xoxb-swapped"), Some("xoxb-1")));
    assert!(why.contains("\"xapp-\""), "{why}");
    assert_eq!(
        r.daemon.slack_info().owner_user_id.as_deref(),
        Some(OWNER),
        "a refusal changes nothing"
    );

    let off = r.daemon.slack_disconnect();
    assert!(
        matches!(off, proto::ServerMsg::Slack { refusal: None, ref info } if !info.enabled && !info.has_tokens),
        "{off:?}"
    );
}

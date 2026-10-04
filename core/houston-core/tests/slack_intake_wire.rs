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
use houston_core::slack::form::{Outcome, QuestionForm, ResultForm};
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
const DM: &str = "D0OWNER";

/// A Claude that stays up without hooks, like the task Start tests use, and
/// prints its arguments so a test can read the brief it was started with.
fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let path = dir.join("claude");
        std::fs::write(
            &path,
            "#!/bin/sh\nstty -echo -icanon 2>/dev/null\nprintf '%s\\n' \"$@\"\necho FIXTURE-READY\nexec cat\n",
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
    /// (method, arguments) of every write besides `chat.postMessage`.
    calls: Vec<(String, Value)>,
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

    fn send_interactive(&self, envelope_id: &str, payload: Value) {
        let env = json!({"envelope_id": envelope_id, "type": "interactive", "payload": payload});
        self.push.send(env.to_string()).expect("a connected socket");
    }

    fn posts(&self) -> Vec<Value> {
        self.rec.lock().unwrap().posts.clone()
    }

    fn thread_posts(&self) -> Vec<Value> {
        self.posts()
            .into_iter()
            .filter(|p| p["channel"] == CHANNEL)
            .collect()
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        self.rec
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, v)| v.clone())
            .collect()
    }

    /// The reactions Houston leaves on the message at `ts`, after every add
    /// and remove it made.
    fn reactions_on(&self, ts: &str) -> Vec<String> {
        let mut shown: Vec<String> = Vec::new();
        for (method, args) in self.rec.lock().unwrap().calls.iter() {
            if args["timestamp"] != ts {
                continue;
            }
            let name = args["name"].as_str().unwrap_or_default().to_string();
            match method.as_str() {
                "reactions.add" if !shown.contains(&name) => shown.push(name),
                "reactions.remove" => shown.retain(|n| *n != name),
                _ => {}
            }
        }
        shown
    }

    async fn await_reactions(&self, ts: &str, expected: &[&str]) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while self.reactions_on(ts) != expected {
            assert!(
                tokio::time::Instant::now() < deadline,
                "reactions on {ts} are {:?}, expected {expected:?}",
                self.reactions_on(ts)
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The first `chat.postMessage` (or, with `method`, call) whose JSON
    /// contains `needle`, waiting for it.
    async fn await_call(&self, method: &str, needle: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let pool = if method == "chat.postMessage" {
                self.posts()
            } else {
                self.calls(method)
            };
            if let Some(p) = pool.into_iter().find(|p| p.to_string().contains(needle)) {
                return p;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no {method} containing {needle:?}; posts: {:?}; calls: {:?}",
                self.posts(),
                self.rec.lock().unwrap().calls
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn await_post(&self, needle: &str) -> Value {
        self.await_call("chat.postMessage", needle).await
    }

    async fn await_dm(&self, needle: &str) -> Value {
        let dm = self.await_post(needle).await;
        assert_eq!(dm["channel"], DM, "{dm}");
        dm
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
    let args: Value = if body.is_empty() {
        json!(query)
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    Json(match method.as_str() {
        "auth.test" => json!({"ok": true, "team_id": "T1", "team": "Test team", "user_id": "UBOT"}),
        "apps.connections.open" => json!({"ok": true, "url": format!("ws://{}/socket", fake.addr)}),
        "chat.postMessage" => {
            rec.posts.push(args);
            json!({"ok": true, "ts": ts})
        }
        "reactions.add" | "reactions.remove" | "chat.update" | "chat.postEphemeral"
        | "views.open" => {
            rec.calls.push((method.clone(), args));
            json!({"ok": true})
        }
        "conversations.open" => {
            assert_eq!(args["users"], OWNER, "a DM goes to the owner only");
            rec.calls.push((method.clone(), args));
            json!({"ok": true, "channel": {"id": DM}})
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
        Some(proto::SlackLanguage::PtBr),
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

    async fn await_output(&self, session: u32, needle: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let replay = self.daemon.scrollback(session, None).unwrap();
            let text = String::from_utf8_lossy(&replay.data).into_owned();
            if text.contains(needle) {
                return text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "session {session} never printed {needle:?}: {text:?}"
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

fn click(user: &str, action_id: &str, value: &str) -> Value {
    json!({"type": "block_actions", "team": {"id": "T1"}, "user": {"id": user},
        "trigger_id": "13345224609.738474920.8088930838d88f008e0", "channel": {"id": DM},
        "actions": [{"action_id": action_id, "value": value, "type": "button"}]})
}

fn refuse_submission(user: &str, intake_id: &str, reason: Option<&str>) -> Value {
    json!({"type": "view_submission", "team": {"id": "T1"}, "user": {"id": user},
        "view": {"callback_id": "houston_refuse", "private_metadata": intake_id,
            "state": {"values": {"reason": {"reason": {"type": "plain_text_input", "value": reason}}}}}})
}

/// The request id the owner's new-request message carries on its buttons.
fn accept_value(dm: &Value) -> String {
    dm["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["elements"].as_array())
        .flatten()
        .find(|e| e["action_id"] == "houston_accept")
        .and_then(|e| e["value"].as_str())
        .expect("an Accept button")
        .to_string()
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
    r.fake.await_reactions("1800000000.000100", &["eyes"]).await;
    let dm = r.fake.await_dm("Novo pedido").await;
    let dm_text = dm.to_string();
    assert!(
        dm_text.contains(&format!("<@{REQUESTER}>"))
            && dm_text.contains(&format!("<#{CHANNEL}>"))
            && dm_text.contains("fix the footer"),
        "the owner's message names the requester, the channel and the request: {dm_text}"
    );
    assert!(
        dm_text.contains("Aceitar")
            && dm_text.contains("Recusar")
            && dm_text.contains("Ver mensagem"),
        "{dm_text}"
    );
    assert!(
        dm_text.contains("nenhum trabalho em andamento, começa na hora"),
        "{dm_text}"
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
    r.await_output(runs[0].1, "in Brazilian Portuguese (pt-BR)")
        .await;
    r.fake.await_reactions("1800000000.000100", &["gear"]).await;
    r.fake.await_call("chat.update", "Aceito · começou").await;
    assert!(
        r.fake.thread_posts().is_empty(),
        "nothing is written in the thread before the agent writes: {:?}",
        r.fake.thread_posts()
    );
    assert!(
        !r.fake
            .posts()
            .iter()
            .any(|p| p.to_string().contains("HOU-")),
        "no message names the task key: {:?}",
        r.fake.posts()
    );
    r.finish();
}

#[tokio::test]
async fn the_owners_accept_button_starts_the_request_and_nobody_elses_does() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-accept-button").await;
    r.fake.send_event(
        "e1",
        mention("1800000000.000100", REQUESTER, "rename the button"),
    );
    r.await_tasks(1).await;
    let dm = r.fake.await_dm("Novo pedido").await;
    let id = accept_value(&dm);

    r.fake
        .send_interactive("i1", click(REQUESTER, "houston_accept", &id));
    let mut foreign = click(OWNER, "houston_accept", &id);
    foreign["team"]["id"] = json!("T2");
    r.fake.send_interactive("i2", foreign);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        r.runs().is_empty(),
        "a click from someone other than the owner, or from another team, starts nothing"
    );
    assert!(
        r.fake.rec.lock().unwrap().acks.contains(&"i1".to_string()),
        "the interaction was acknowledged"
    );

    r.fake
        .send_interactive("i3", click(OWNER, "houston_accept", &id));
    r.await_runs(1).await;
    r.fake.await_reactions("1800000000.000100", &["gear"]).await;
    r.finish();
}

#[tokio::test]
async fn the_owner_refuses_with_a_reason_that_reaches_the_thread_as_written() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-refuse").await;
    r.fake.send_event(
        "e1",
        mention("1800000000.000100", REQUESTER, "delete production"),
    );
    r.fake.send_event(
        "e2",
        mention("1800000000.000200", REQUESTER, "rename the button"),
    );
    let tasks = r.await_tasks(2).await;
    r.fake.await_dm("delete production").await;
    let first = accept_value(&r.fake.await_dm("delete production").await);
    let second = accept_value(&r.fake.await_dm("rename the button").await);

    r.fake
        .send_interactive("i1", click(OWNER, "houston_refuse", &first));
    let view = r.fake.await_call("views.open", "houston_refuse").await;
    assert_eq!(
        view["trigger_id"], "13345224609.738474920.8088930838d88f008e0",
        "the modal opens on the click's trigger"
    );
    assert!(view.to_string().contains("Motivo (opcional)"), "{view}");

    r.fake.send_interactive(
        "i2",
        refuse_submission(REQUESTER, &first, Some("not from you")),
    );
    r.fake.send_interactive(
        "i3",
        refuse_submission(
            OWNER,
            &first,
            Some("Isso precisa passar pelo time de dados."),
        ),
    );
    let posted = r
        .fake
        .await_post("Isso precisa passar pelo time de dados.")
        .await;
    assert_eq!(posted["thread_ts"], "1800000000.000100");
    assert_eq!(posted["text"], "Isso precisa passar pelo time de dados.");
    r.fake
        .await_reactions("1800000000.000100", &["no_entry_sign"])
        .await;
    r.fake.await_call("chat.update", "Recusado por você").await;

    r.fake
        .send_interactive("i4", refuse_submission(OWNER, &second, None));
    r.fake
        .await_reactions("1800000000.000200", &["no_entry_sign"])
        .await;
    assert_eq!(
        r.fake.thread_posts().len(),
        1,
        "without a reason the request only gets 🚫: {:?}",
        r.fake.thread_posts()
    );
    assert!(
        !r.fake
            .posts()
            .iter()
            .any(|p| p.to_string().contains("not from you")),
        "a submission by someone else is ignored"
    );
    let statuses: Vec<String> = {
        let conn = r.db();
        let mut stmt = conn
            .prepare("SELECT status FROM backlog_tasks ORDER BY id")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(statuses, ["canceled", "canceled"], "{tasks:?}");

    r.fake
        .send_event("e3", check_mark("1800000000.000100", OWNER));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(r.runs().is_empty(), "a refused request does not start");
    r.finish();
}

#[tokio::test]
async fn a_request_over_the_text_limit_is_marked_and_the_owner_is_told_why() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-too-long").await;
    let long = "x".repeat(proto::SLACK_REQUEST_TEXT_MAX + 1);
    r.fake
        .send_event("e1", mention("1800000000.000100", REQUESTER, &long));
    r.fake
        .await_reactions("1800000000.000100", &["warning"])
        .await;
    let dm = r
        .fake
        .await_dm(&format!(
            "acima do limite de {}",
            proto::SLACK_REQUEST_TEXT_MAX
        ))
        .await;
    assert!(dm.to_string().contains("Atenção"), "{dm}");
    assert!(r.tasks().is_empty(), "nothing was filed");
    assert!(
        r.fake.thread_posts().is_empty(),
        "the requester reads no text"
    );
    r.finish();
}

#[tokio::test]
async fn a_task_canceled_before_it_starts_closes_its_request() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-canceled").await;
    r.fake.send_event(
        "e1",
        mention("1800000000.000100", REQUESTER, "rename the button"),
    );
    let tasks = r.await_tasks(1).await;
    r.fake.await_dm("Novo pedido").await;
    let revision: i64 = r
        .db()
        .query_row(
            "SELECT revision FROM backlog_tasks WHERE id = ?1",
            [tasks[0].0],
            |row| row.get(0),
        )
        .unwrap();
    let canceled = r
        .daemon
        .task_save(
            &r.workspace(),
            Some(tasks[0].0),
            Some(revision),
            proto::TaskPatch {
                status: Some(proto::TaskStatus::Canceled),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        matches!(canceled, proto::ServerMsg::TaskChanged { .. }),
        "{canceled:?}"
    );

    r.fake
        .await_reactions("1800000000.000100", &["no_entry_sign"])
        .await;
    r.fake
        .await_call("chat.update", "Fechado no Houston antes de começar")
        .await;
    assert!(r.fake.thread_posts().is_empty());
    let state: String = r
        .db()
        .query_row("SELECT state FROM intake_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "refused");

    r.fake
        .send_event("e2", check_mark("1800000000.000100", OWNER));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(r.runs().is_empty(), "a closed request does not start");
    r.finish();
}

fn label_question() -> QuestionForm {
    QuestionForm {
        context: Some("The form's main button gets a new label.".into()),
        question: "Which label?".into(),
        options: vec!["Save".into(), "Submit".into()],
        recommended: Some(2),
    }
}

async fn await_answer(r: &Rig, question_id: i64) -> (String, String) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let got: Option<(String, String)> = r
            .db()
            .query_row(
                "SELECT answer, answered_by FROM intake_questions WHERE id = ?1 AND answer IS NOT NULL",
                [question_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some(a) = got {
            return a;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "question {question_id} was never answered"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn last_question_id(r: &Rig) -> i64 {
    r.db()
        .query_row("SELECT MAX(id) FROM intake_questions", [], |row| row.get(0))
        .unwrap()
}

#[tokio::test]
async fn a_question_has_a_button_per_option_and_only_the_requester_or_owner_answers() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-buttons").await;
    r.fake.send_event(
        "q1",
        mention("1800000001.000100", REQUESTER, "rename the button"),
    );
    r.await_tasks(1).await;
    r.fake
        .send_event("q2", check_mark("1800000001.000100", OWNER));
    let session = r.await_runs(1).await[0].1;

    let err = r
        .daemon
        .slack_task_ask(
            session,
            QuestionForm {
                options: vec!["only one".into()],
                ..label_question()
            },
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("1 options given, expected 2 to 4"), "{err}");

    r.daemon.slack_task_ask(session, label_question()).unwrap();
    let id = last_question_id(&r);
    let asked = r.fake.await_post("Which label?").await;
    let blocks = asked["blocks"].to_string();
    assert!(
        blocks.contains("The form's main button gets a new label.")
            && blocks.contains("*Which label?*")
            && blocks.contains("Submit _(recomendado)_")
            && blocks.contains(&format!("\"{id}:1\""))
            && blocks.contains(&format!("\"{id}:2\""))
            && blocks.contains("Outra resposta…"),
        "context, question, a button per option with the recommended one marked, and an own-words button: {blocks}"
    );
    assert!(
        !asked.to_string().contains("HOU-"),
        "the question names no task key: {asked}"
    );
    r.fake
        .await_reactions("1800000001.000100", &["question"])
        .await;

    let mut bystander = click("USOMEONE", "houston_answer", &format!("{id}:1"));
    bystander["channel"]["id"] = json!(CHANNEL);
    r.fake.send_interactive("c1", bystander);
    let told = r.fake.await_call("chat.postEphemeral", "USOMEONE").await;
    assert!(
        told["text"]
            .as_str()
            .unwrap()
            .contains(&format!("<@{REQUESTER}>")),
        "{told}"
    );
    assert_eq!(told["thread_ts"], "1800000001.000100");

    let mut chosen = click(REQUESTER, "houston_answer", &format!("{id}:2"));
    chosen["container"] = json!({"message_ts": asked["ts"]});
    r.fake.send_interactive("c2", chosen);
    assert_eq!(
        await_answer(&r, id).await,
        ("Submit".to_string(), "requester".to_string())
    );
    let edited = r.fake.await_call("chat.update", "*Resposta:* Submit").await;
    assert!(
        edited
            .to_string()
            .contains(&format!("Respondido por <@{REQUESTER}>"))
            && !edited.to_string().contains("houston_answer"),
        "the answered question shows the choice and loses its buttons: {edited}"
    );
    r.fake
        .send_interactive("c3", click(OWNER, "houston_answer", &format!("{id}:1")));
    r.fake
        .await_call("chat.postEphemeral", "já foi respondida")
        .await;
    r.fake.await_reactions("1800000001.000100", &["gear"]).await;

    r.daemon.slack_task_ask(session, label_question()).unwrap();
    let id = last_question_id(&r);
    r.fake
        .send_interactive("c4", click(OWNER, "houston_other", &id.to_string()));
    let view = r.fake.await_call("views.open", "Sua resposta").await;
    assert_eq!(view["view"]["private_metadata"], id.to_string());
    r.fake.send_interactive(
        "c5",
        json!({"type": "view_submission", "team": {"id": "T1"}, "user": {"id": OWNER},
            "view": {"callback_id": "houston_answer", "private_metadata": id.to_string(),
                "state": {"values": {"answer": {"answer": {"type": "plain_text_input", "value": "Neither: use Send"}}}}}}),
    );
    assert_eq!(
        await_answer(&r, id).await,
        ("Neither: use Send".to_string(), "owner".to_string())
    );
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

    let posted = r.daemon.slack_task_ask(session, label_question()).unwrap();
    assert!(posted.contains("End your turn"), "{posted}");
    let err = r
        .daemon
        .slack_task_ask(session, label_question())
        .unwrap_err()
        .to_string();
    assert!(err.contains("already has a question waiting"), "{err}");
    let asked = r.fake.await_post("Which label?").await;
    assert_eq!(asked["thread_ts"], "1800000001.000100");
    let reply = |user: &str, text: &str, ts: &str| {
        json!({"type": "message", "channel": CHANNEL, "user": user, "team": "T1", "ts": ts,
            "thread_ts": "1800000001.000100", "text": text})
    };
    r.fake
        .send_event("q3", reply("USOMEONE", "Cancel", "1900000009.000001"));
    r.fake
        .send_event("q4", reply(REQUESTER, "Submit", "1900000009.000002"));
    let answer = await_answer(&r, last_question_id(&r)).await;
    assert_eq!(
        answer,
        ("Submit".to_string(), "requester".to_string()),
        "a bystander's reply is not the answer"
    );
    r.fake.await_call("chat.update", "*Resposta:* Submit").await;

    let refused = r
        .daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            Some("Renamed it"),
            None,
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("--subject and --changes"),
        "a Slack-filed task hands back fields, not a one-line summary: {refused}"
    );

    let worktree: String = r
        .db()
        .query_row(
            "SELECT worktree_path FROM backlog_task_runs WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .unwrap();
    let worktree = PathBuf::from(worktree);
    std::fs::write(worktree.join("form.txt"), "Submit\nCancel\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-m", "rename the button"]);

    let handed = r
        .daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            None,
            Some(ResultForm {
                subject: "Botão do formulário com o rótulo Enviar".into(),
                changes: format!(
                    "O botão principal passa a dizer Enviar. ({}/src/a.rs)",
                    r.workspace()
                ),
                steps: vec!["Abrir o formulário.".into(), "Ver o botão.".into()],
                caveats: Some("Só na tela de cadastro.".into()),
                live_note: Some("Está no ar: o botão já diz Enviar.".into()),
                dropped_note: Some("Este pedido não vai seguir.".into()),
                notes: vec!["Testes verdes".into(), "tela não conferida".into()],
                warnings: vec![
                    "A revisão automática não rodou: a orquestração está desligada".into(),
                ],
                ..Default::default()
            }),
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    assert!(matches!(handed, proto::ServerMsg::TaskChanged { .. }));
    let result = r.fake.await_post("Pronto, aguardando revisão").await;
    assert_eq!(result["channel"], CHANNEL);
    let thread = result.to_string();
    assert!(
        thread.contains("*O que muda.* O botão principal passa a dizer Enviar.")
            && thread.contains("1. Abrir o formulário.")
            && thread.contains("Só na tela de cadastro.")
            && thread.contains("ainda revisa a mudança"),
        "{thread}"
    );
    assert!(
        !thread.contains("HOU-")
            && !thread.contains("houston/task/")
            && !thread.contains(&r.workspace()),
        "no task key, branch or local path in the thread: {thread}"
    );
    r.fake
        .await_reactions("1800000001.000100", &["checkered_flag"])
        .await;
    let dm = r
        .fake
        .await_dm("Pronto para revisão: Botão do formulário com o rótulo Enviar")
        .await
        .to_string();
    assert!(
        dm.contains("*Tamanho: pequeno* · 1 arquivo · +2 −0 linhas")
            && dm.contains("Branch `houston/task/hou-")
            && dm.contains("não enviada")
            && dm.contains("⚠️ A revisão automática não rodou")
            && dm.contains("Testes verdes · tela não conferida · ")
            && dm.contains("min de trabalho")
            && dm.contains("Ver thread"),
        "{dm}"
    );
    let comment: String = r
        .db()
        .query_row(
            "SELECT body FROM backlog_task_comments WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
            [task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        comment.contains("Botão do formulário") && comment.contains("Live note: Está no ar"),
        "the task keeps every field: {comment}"
    );

    close_task(&r, task_id, proto::TaskStatus::Done);
    let live = r
        .fake
        .await_post("Está no ar: o botão já diz Enviar.")
        .await;
    assert_eq!(live["thread_ts"], "1800000001.000100");
    r.fake
        .await_reactions("1800000001.000100", &["rocket"])
        .await;
    assert!(
        !r.fake
            .posts()
            .iter()
            .any(|p| p.to_string().contains("Este pedido não vai seguir.")),
        "only the note for the state the task reached is posted"
    );
    r.finish();
}

fn close_task(r: &Rig, task_id: i64, status: proto::TaskStatus) {
    let revision: i64 = r
        .db()
        .query_row(
            "SELECT revision FROM backlog_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .unwrap();
    let closed = r
        .daemon
        .task_save(
            &r.workspace(),
            Some(task_id),
            Some(revision),
            proto::TaskPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        matches!(closed, proto::ServerMsg::TaskChanged { .. }),
        "{closed:?}"
    );
}

#[tokio::test]
async fn a_task_canceled_after_its_hand_back_posts_the_dropped_note() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-dropped").await;
    r.fake.send_event(
        "d1",
        mention("1800000004.000100", REQUESTER, "rename the button"),
    );
    let task_id = r.await_tasks(1).await[0].0;
    r.fake
        .send_event("d2", check_mark("1800000004.000100", OWNER));
    let session = r.await_runs(1).await[0].1;
    r.daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            None,
            Some(ResultForm {
                subject: "Rótulo do botão".into(),
                changes: "O botão diz Enviar.".into(),
                steps: vec!["Abrir o formulário.".into()],
                live_note: Some("Está no ar.".into()),
                dropped_note: Some("Este pedido não vai seguir; o rótulo continua Salvar.".into()),
                ..Default::default()
            }),
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    r.fake
        .await_reactions("1800000004.000100", &["checkered_flag"])
        .await;
    close_task(&r, task_id, proto::TaskStatus::Canceled);
    r.fake
        .await_post("Este pedido não vai seguir; o rótulo continua Salvar.")
        .await;
    r.fake
        .await_reactions("1800000004.000100", &["no_entry_sign"])
        .await;
    r.finish();
}

#[tokio::test]
async fn a_refusal_at_triage_tells_the_thread_why_and_marks_the_request() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-triage-refusal").await;
    r.fake.send_event(
        "t1",
        mention("1800000003.000100", REQUESTER, "email every client"),
    );
    let task_id = r.await_tasks(1).await[0].0;
    r.fake
        .send_event("t2", check_mark("1800000003.000100", OWNER));
    let session = r.await_runs(1).await[0].1;
    r.daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            None,
            Some(ResultForm {
                outcome: Outcome::Refused,
                subject: "E-mail para todos os clientes".into(),
                changes: "Enviar mensagens a clientes precisa de uma pessoa. Com o texto aprovado, dá para preparar o envio.".into(),
                ..Default::default()
            }),
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    let posted = r.fake.await_post("Não vai seguir").await.to_string();
    assert!(posted.contains("precisa de uma pessoa"), "{posted}");
    assert!(!posted.contains("ainda revisa"), "{posted}");
    r.fake
        .await_reactions("1800000003.000100", &["no_entry_sign"])
        .await;
    r.fake
        .await_dm("Recusado na triagem: E-mail para todos os clientes")
        .await;
    close_task(&r, task_id, proto::TaskStatus::Canceled);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        r.fake.thread_posts().len(),
        1,
        "a refusal already said why; canceling it adds nothing: {:?}",
        r.fake.thread_posts()
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
    r.fake
        .await_call("chat.update", "Aceito · na fila, posição 1")
        .await;
    assert_eq!(r.runs().len(), 2, "the third waits");
    assert!(
        r.fake.thread_posts().is_empty(),
        "the queue is the owner's business, not the thread's"
    );

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
    let why = refused(r.daemon.slack_configure(Some("@augusto"), &[], None));
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
        None,
    ));
    assert!(why.contains("\"#general\""), "{why}");
    let why = refused(r.daemon.slack_configure(
        None,
        &[proto::SlackChannelMap {
            channel_id: "C1X".into(),
            workspace: "/nope".into(),
        }],
        None,
    ));
    assert!(why.contains("\"/nope\" is not registered"), "{why}");
    let why = refused(r.daemon.slack_connect(Some("xoxb-swapped"), Some("xoxb-1")));
    assert!(why.contains("\"xapp-\""), "{why}");
    assert_eq!(
        r.daemon.slack_info().owner_user_id.as_deref(),
        Some(OWNER),
        "a refusal changes nothing"
    );
    let kept = r.daemon.slack_configure(
        Some(OWNER),
        &[proto::SlackChannelMap {
            channel_id: CHANNEL.into(),
            workspace: r.workspace(),
        }],
        None,
    );
    assert!(
        matches!(kept, proto::ServerMsg::Slack { refusal: None, ref info } if info.language == proto::SlackLanguage::PtBr),
        "a configure without a language keeps the current one: {kept:?}"
    );

    let off = r.daemon.slack_disconnect();
    assert!(
        matches!(off, proto::ServerMsg::Slack { refusal: None, ref info } if !info.enabled && !info.has_tokens),
        "{off:?}"
    );
}

fn ready_result(subject: &str) -> ResultForm {
    ResultForm {
        subject: subject.into(),
        changes: "O botão diz Enviar.".into(),
        steps: vec!["Abrir o formulário.".into()],
        live_note: Some("Está no ar.".into()),
        dropped_note: Some("Não vai seguir.".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_reply_after_the_result_is_an_adjustment_the_owner_accepts_into_a_new_attempt() {
    let _guard = SERIAL.lock().await;
    let r = rig("slack-adjust").await;
    let request = "1800000005.000100";
    r.fake
        .send_event("a1", mention(request, REQUESTER, "rename the button"));
    let task_id = r.await_tasks(1).await[0].0;
    r.fake.send_event("a2", check_mark(request, OWNER));
    let session = r.await_runs(1).await[0].1;
    r.daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            None,
            Some(ready_result("Rótulo do botão")),
            session,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    r.fake.await_reactions(request, &["checkered_flag"]).await;

    let reply = |user: &str, text: &str, ts: &str| {
        json!({"type": "message", "channel": CHANNEL, "user": user, "team": "T1", "ts": ts,
            "thread_ts": request, "text": text})
    };
    let later = |n: u64| {
        format!(
            "{}.{n:06}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 5
        )
    };
    let bystander_ts = later(1);
    r.fake
        .send_event("a3", reply("USOMEONE", "make it red", &bystander_ts));
    let adjust_ts = later(2);
    r.fake.send_event(
        "a4",
        reply(
            REQUESTER,
            "Pode ser Confirmar em vez de Enviar?",
            &adjust_ts,
        ),
    );
    r.fake.await_reactions(&adjust_ts, &["eyes"]).await;
    let dm = r.fake.await_dm("Pedido de ajuste").await.to_string();
    assert!(
        dm.contains("Rótulo do botão")
            && dm.contains("> Pode ser Confirmar em vez de Enviar?")
            && dm.contains("houston_adjust_accept"),
        "the owner's message names the request by its subject and quotes the reply: {dm}"
    );
    assert!(
        r.fake.reactions_on(&bystander_ts).is_empty(),
        "a bystander's reply is not an adjustment"
    );

    r.fake.send_event("a5", check_mark(&adjust_ts, OWNER));
    let runs = r.await_runs(2).await;
    assert_eq!(
        runs[1].0, task_id,
        "the new attempt belongs to the same task"
    );
    r.await_output(runs[1].1, "Pode ser Confirmar em vez de Enviar?")
        .await;
    r.fake
        .await_call("chat.update", "Aceito · nova tentativa começou")
        .await;
    r.fake.await_reactions(request, &["gear"]).await;
    let worktrees: Vec<String> = {
        let conn = r.db();
        let mut stmt = conn
            .prepare("SELECT worktree_path FROM backlog_task_runs WHERE task_id = ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([task_id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(
        worktrees[0], worktrees[1],
        "the same worktree: {worktrees:?}"
    );

    r.daemon
        .task_handback_from(
            &r.workspace(),
            task_id,
            None,
            Some(ready_result("Rótulo do botão")),
            runs[1].1,
            "agent:one (operator)",
            "task_handback",
        )
        .unwrap();
    r.fake.await_reactions(request, &["checkered_flag"]).await;
    let second_ts = later(3);
    r.fake
        .send_event("a6", reply(REQUESTER, "E a cor também?", &second_ts));
    r.fake.await_reactions(&second_ts, &["eyes"]).await;
    let id: i64 = r
        .db()
        .query_row("SELECT MAX(id) FROM intake_adjustments", [], |row| {
            row.get(0)
        })
        .unwrap();
    r.fake
        .send_interactive("a7", click(OWNER, "houston_adjust_refuse", &id.to_string()));
    r.fake.await_reactions(&second_ts, &["no_entry_sign"]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(r.runs().len(), 2, "a refused adjustment starts nothing");
    r.finish();
}

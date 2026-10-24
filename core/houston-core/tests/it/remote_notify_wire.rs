#![cfg(unix)]

use crate::common;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use common::{connect_and_hello, start_daemon_with_handle, WsStream, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// Every test shares one in-process credential store; the host keyring is never touched.
fn use_mock_keychain() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
        keyring_core::set_default_store(
            keyring_core::mock::Store::new().expect("building the mock credential store"),
        );
    });
}

#[derive(Debug, Clone)]
struct Posted {
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Posted {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Inbox = Arc<Mutex<Vec<Posted>>>;

/// A stand-in ntfy server that records every publish.
async fn fixture_ntfy() -> (SocketAddr, Inbox) {
    let inbox: Inbox = Arc::default();
    async fn publish(
        State(inbox): State<Inbox>,
        uri: axum::http::Uri,
        headers: HeaderMap,
        body: String,
    ) -> &'static str {
        inbox.lock().unwrap().push(Posted {
            path: uri.path().to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect(),
            body,
        });
        "{}"
    }
    let app = axum::Router::new()
        .route("/{topic}", post(publish))
        .with_state(inbox.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, inbox)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn notifying_daemon(
    ntfy: SocketAddr,
    delay_secs: u32,
    extra: ConfigPatch,
) -> (Arc<Daemon>, tempfile::TempDir) {
    let (_addr, daemon, state) = notifying_daemon_at(ntfy, delay_secs, extra).await;
    (daemon, state)
}

async fn notifying_daemon_at(
    ntfy: SocketAddr,
    delay_secs: u32,
    extra: ConfigPatch,
) -> (SocketAddr, Arc<Daemon>, tempfile::TempDir) {
    use_mock_keychain();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{}", free_port())),
            public_url: Some("https://box.tail1.ts.net".into()),
            ntfy_url: Some(format!("http://{ntfy}/houston-test-topic")),
            notify_delay_secs: Some(delay_secs),
            ..extra
        })
        .unwrap();
    (addr, daemon, state)
}

fn pane(daemon: &Arc<Daemon>) -> (proto::SessionInfo, tempfile::TempDir) {
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
            model: None,
            effort: None,
        })
        .unwrap();
    (info, dir)
}

async fn wait_for_posts(inbox: &Inbox, n: usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while inbox.lock().unwrap().len() < n {
        assert!(
            tokio::time::Instant::now() < deadline,
            "expected {n} notification(s), got {:?}",
            inbox.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_sustained_needs_input_sends_one_generic_notification() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(ntfy, 1, ConfigPatch::default()).await;
    assert_eq!(
        daemon.remote_config().ntfy_server.as_deref(),
        Some(format!("http://{ntfy}").as_str()),
        "only the server origin is kept outside the keychain"
    );
    let (info, dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "nothing goes out before the delay"
    );
    wait_for_posts(&inbox, 1).await;

    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let posts = inbox.lock().unwrap().clone();
    assert_eq!(posts.len(), 1, "one notification per entry: {posts:?}");
    let post = &posts[0];
    assert_eq!(post.path, "/houston-test-topic");
    assert_eq!(post.header("Title"), Some("Houston"));
    assert_eq!(post.header("Priority"), Some("high"));
    assert_eq!(
        post.header("Click"),
        Some(format!("https://box.tail1.ts.net#session={}", info.id).as_str())
    );
    assert_eq!(post.body, "An agent needs your input");
    let dir_text = dir.path().to_string_lossy();
    assert!(!post.body.contains(dir_text.as_ref()));
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn an_answer_within_the_delay_sends_nothing() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(ntfy, 1, ConfigPatch::default()).await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "answered on the desktop within the delay: {:?}",
        inbox.lock().unwrap()
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn pane_name_detail_and_finished_turns_are_opt_in() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(
        ntfy,
        0,
        ConfigPatch {
            notify_detail: Some("pane_name".into()),
            ..Default::default()
        },
    )
    .await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "Stop", None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "finished turns stay quiet until notify_finished is on"
    );

    daemon
        .remote_configure(ConfigPatch {
            notify_finished: Some(true),
            ..Default::default()
        })
        .unwrap();
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "Stop", None);
    wait_for_posts(&inbox, 1).await;
    let post = inbox.lock().unwrap()[0].clone();
    assert!(
        post.body.ends_with("finished its turn") && post.body != "An agent finished its turn",
        "pane_name names the pane: {:?}",
        post.body
    );
    assert_eq!(post.header("Priority"), Some("default"));

    daemon
        .remote_configure(ConfigPatch {
            ntfy_url: Some(String::new()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(daemon.remote_config().ntfy_server, None);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        inbox.lock().unwrap().len(),
        1,
        "clearing the URL turns it off"
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn turning_remote_access_off_silences_notifications() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(ntfy, 0, ConfigPatch::default()).await;
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(false),
            ..Default::default()
        })
        .unwrap();
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(inbox.lock().unwrap().is_empty());
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn an_invalid_ntfy_url_is_refused_without_echoing_it() {
    use_mock_keychain();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .remote_configure(ConfigPatch {
            ntfy_url: Some("https://user:pw@ntfy.sh/secret-topic".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(err.contains("credentials"), "{err}");
    assert!(!err.contains("secret-topic"), "{err}");
    let err = daemon
        .remote_configure(ConfigPatch {
            notify_delay_secs: Some(601),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(err.contains("601") && err.contains("600"), "{err}");
}

#[tokio::test]
async fn finished_notification_click_opens_the_session_fragment() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(
        ntfy,
        0,
        ConfigPatch {
            notify_finished: Some(true),
            ..Default::default()
        },
    )
    .await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "Stop", None);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if !inbox.lock().unwrap().is_empty() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no finished notification"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let posts = inbox.lock().unwrap().clone();
    assert_eq!(posts[0].body, "An agent finished its turn");
    assert_eq!(
        posts[0].header("Click"),
        Some(format!("https://box.tail1.ts.net#session={}", info.id).as_str())
    );
    daemon.kill(info.id).unwrap();
}

#[tokio::test]
async fn status_churn_has_one_owned_deadline_and_close_releases_it() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(ntfy, 600, ConfigPatch::default()).await;
    let (info, _dir) = pane(&daemon);
    for _ in 0..300 {
        daemon.handle_hook(info.id, "UserPromptSubmit", None);
        daemon.handle_hook(info.id, "PermissionRequest", None);
        tokio::task::yield_now().await;
        assert!(daemon.remote_pending_notifications_for_test() <= 1);
    }
    // Allow the bounded event queue to drain, then schedule a fresh current event.
    tokio::time::sleep(Duration::from_millis(100)).await;
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while daemon.remote_pending_notifications_for_test() == 0 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    daemon.close(info.id).unwrap();
    assert_eq!(daemon.remote_pending_notifications_for_test(), 0);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(daemon.remote_pending_notifications_for_test(), 0);
    assert!(inbox.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pending_finished_notification_obeys_the_current_policy_and_topic() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (daemon, _state) = notifying_daemon(
        ntfy,
        1,
        ConfigPatch {
            notify_finished: Some(true),
            ..Default::default()
        },
    )
    .await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "Stop", None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    daemon
        .remote_configure(ConfigPatch {
            notify_finished: Some(false),
            ..Default::default()
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "disabled finished notifications must stay quiet"
    );
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    daemon
        .remote_configure(ConfigPatch {
            ntfy_url: Some(format!("http://{ntfy}/new-topic")),
            ..Default::default()
        })
        .unwrap();
    wait_for_posts(&inbox, 1).await;
    assert_eq!(inbox.lock().unwrap()[0].path, "/new-topic");
    daemon.close(info.id).unwrap();
}

async fn report_presence(ws: &mut WsStream, daemon: &Daemon, active: bool) {
    let msg = proto::ClientMsg::DesktopPresence { active };
    ws.send(Message::text(serde_json::to_string(&msg).unwrap()))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while daemon.remote_presence_held_for_test() != active {
        assert!(
            tokio::time::Instant::now() < deadline,
            "presence {active} never applied"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn an_active_desktop_holds_phone_notifications_until_it_goes_away() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (addr, daemon, _state) = notifying_daemon_at(
        ntfy,
        0,
        ConfigPatch {
            notify_finished: Some(true),
            ..Default::default()
        },
    )
    .await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    report_presence(&mut ws, &daemon, true).await;
    let (finished, _dir) = pane(&daemon);
    let (waiting, _dir2) = pane(&daemon);
    daemon.handle_hook(finished.id, "UserPromptSubmit", None);
    daemon.handle_hook(finished.id, "Stop", None);
    daemon.handle_hook(waiting.id, "UserPromptSubmit", None);
    daemon.handle_hook(waiting.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "nothing goes to the phone while the desktop is in use: {:?}",
        inbox.lock().unwrap()
    );
    assert_eq!(daemon.remote_pending_notifications_for_test(), 2);

    report_presence(&mut ws, &daemon, false).await;
    wait_for_posts(&inbox, 2).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut bodies: Vec<String> = inbox
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.body.clone())
        .collect();
    bodies.sort();
    assert_eq!(
        bodies,
        vec!["An agent finished its turn", "An agent needs your input"],
        "each held notification flushes exactly once"
    );
    daemon.kill(finished.id).ok();
    daemon.kill(waiting.id).ok();
}

/// Presence is handled on the connection task, so it is never refused for want of a
/// control slot nor reordered against an earlier report from the same socket.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_away_report_applies_while_every_control_slot_of_its_connection_is_busy() {
    let (ntfy, _inbox) = fixture_ntfy().await;
    let (addr, daemon, _state) = notifying_daemon_at(ntfy, 0, ConfigPatch::default()).await;
    let dir = tempfile::tempdir().unwrap();
    let busy = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec![
                "/bin/sh".into(),
                "-c".into(),
                "while :; do echo busy; sleep 0.05; done".into(),
            ]),
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
    let mut observer = daemon.observe();
    common::collect_broadcast_until(&mut observer, busy.id, "busy").await;
    drop(observer);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    report_presence(&mut ws, &daemon, true).await;
    for request in 0..16 {
        let wait = proto::ClientMsg::WaitForIdle {
            request,
            session: busy.id,
            timeout_ms: Some(60_000),
            idle_quiet_ms: Some(30_000),
        };
        ws.send(Message::text(serde_json::to_string(&wait).unwrap()))
            .await
            .unwrap();
    }
    ws.send(Message::text(r#"{"type":"session_list"}"#))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let proto::ServerMsg::Error {
                context: Some(context),
                ..
            } = common::next_control(&mut ws).await
            {
                if context.starts_with("control_admission") {
                    break;
                }
            }
        }
    })
    .await
    .expect("sixteen idle waits fill the connection's control slots");

    report_presence(&mut ws, &daemon, false).await;
    daemon.kill(busy.id).ok();
}

#[tokio::test]
async fn closing_the_desktop_connection_releases_held_notifications() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (addr, daemon, _state) = notifying_daemon_at(ntfy, 0, ConfigPatch::default()).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    report_presence(&mut ws, &daemon, true).await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(inbox.lock().unwrap().is_empty());

    drop(ws);
    wait_for_posts(&inbox, 1).await;
    assert!(!daemon.remote_presence_held_for_test());
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn an_answer_while_held_sends_nothing_when_the_desktop_leaves() {
    let (ntfy, inbox) = fixture_ntfy().await;
    let (addr, daemon, _state) = notifying_daemon_at(ntfy, 0, ConfigPatch::default()).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    report_presence(&mut ws, &daemon, true).await;
    let (info, _dir) = pane(&daemon);
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    daemon.handle_hook(info.id, "PermissionRequest", None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    daemon.handle_hook(info.id, "UserPromptSubmit", None);
    report_presence(&mut ws, &daemon, false).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "answered at the desk: {:?}",
        inbox.lock().unwrap()
    );
    daemon.kill(info.id).ok();
}

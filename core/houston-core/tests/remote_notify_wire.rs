#![cfg(unix)]

mod common;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    use_mock_keychain();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
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
    (daemon, state)
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
        Some(format!("https://box.tail1.ts.net/#session={}", info.id).as_str())
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

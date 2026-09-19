mod common;

use common::TOKEN;
use houston_protocol as proto;

fn manage_url(addr: std::net::SocketAddr) -> String {
    format!("http://{addr}/manage")
}

async fn manage_request(
    addr: std::net::SocketAddr,
    token: &str,
    manage_version: u32,
    verb: proto::ManageVerb,
) -> reqwest::Response {
    let client = reqwest::Client::new();
    client
        .post(manage_url(addr))
        .header("Authorization", format!("Bearer {token}"))
        .json(&proto::ManageRequest {
            manage_version,
            verb,
            candidate_bin: None,
        })
        .send()
        .await
        .expect("sending /manage request")
}

#[tokio::test]
async fn daemon_status_reports_live_counts_with_the_right_manage_version() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonStatus,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let status: proto::ManageDaemonStatus = resp.json().await.expect("decoding ManageDaemonStatus");
    assert_eq!(status.manage_version, proto::MANAGE_VERSION);
    assert_eq!(status.protocol_version, proto::PROTOCOL_VERSION);
    assert_eq!(status.live_sessions.count, 0);
    assert!(status.live_sessions.ids.is_empty());
    assert_eq!(
        status.clients_connected, 0,
        "a /manage probe is not a /ws client"
    );
    assert!(
        !status.handoff.supported,
        "this test daemon has no registered listener/lock/supervisor, so handoff must read as \
         unsupported here even though it is implemented (see daemon_adoption_wire.rs for the real path)"
    );
    assert!(
        status.started_at.ends_with('Z') && status.started_at.contains('T'),
        "started_at must be an RFC 3339 UTC string, got {:?}",
        status.started_at
    );
}

#[tokio::test]
async fn wrong_token_is_unauthorized_never_a_pane_credential() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request(
        addr,
        "not-the-daemon-token",
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonStatus,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn missing_bearer_is_unauthorized() {
    let (addr, _dir) = common::start_daemon().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(manage_url(addr))
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonStatus,
            candidate_bin: None,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_manage_version_mismatch_is_refused_by_name() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION + 1,
        proto::ManageVerb::DaemonStatus,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);
    let body: proto::ManageErrorBody = resp.json().await.unwrap();
    assert!(
        body.error
            .contains(&(proto::MANAGE_VERSION + 1).to_string()),
        "the refusal must name the caller's version: {:?}",
        body.error
    );
}

#[tokio::test]
async fn daemon_handoff_is_refused_without_a_registered_listener() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonHandoff,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: proto::ManageDaemonHandoffResult = resp.json().await.unwrap();
    assert!(!body.accepted);
    assert!(
        body.reason
            .as_deref()
            .unwrap_or_default()
            .contains("listener"),
        "refusal must name why, got {:?}",
        body.reason
    );
    assert_eq!(body.generation, None);
    assert_eq!(body.sessions_transferred, None);
}

#[tokio::test]
async fn daemon_shutdown_kills_live_sessions_and_reports_them() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let mut ws = common::connect_and_hello(addr, TOKEN).await;
    common::next_control(&mut ws).await;
    let create = common::create_custom_msg(vec!["sleep", "5"], dir.path());
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(create))
        .await
        .unwrap();
    common::expect_created(&mut ws).await;

    let daemon_json_path = dir.path().join("daemon.json");
    let supervisor_json_path = dir.path().join("supervisor.json");
    std::fs::write(&daemon_json_path, "{\"pid\":1}").expect("seed daemon.json");
    std::fs::write(&supervisor_json_path, "{\"pid\":1,\"generation\":1}")
        .expect("seed supervisor.json");

    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let exited = exited.clone();
        daemon.reap_set_exit_hook_for_test(Box::new(move || {
            exited.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
    }

    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonShutdown,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: proto::ManageDaemonShutdownOk = resp.json().await.unwrap();
    assert!(body.ok);
    assert_eq!(body.stopped_sessions, 1);

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !exited.load(std::sync::atomic::Ordering::SeqCst) {
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon_shutdown's response landed but the exit hook never fired");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    assert!(
        !daemon_json_path.exists(),
        "a successful daemon_shutdown must remove daemon.json, same as the SIGTERM/SIGINT path"
    );
    assert!(
        !supervisor_json_path.exists(),
        "a successful daemon_shutdown must remove supervisor.json when present"
    );
}

#[tokio::test]
async fn daemon_shutdown_if_idle_refuses_live_sessions_and_stops_nothing() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let mut ws = common::connect_and_hello(addr, TOKEN).await;
    common::next_control(&mut ws).await;
    let create = common::create_custom_msg(vec!["sleep", "5"], dir.path());
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(create))
        .await
        .unwrap();
    common::expect_created(&mut ws).await;

    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let exited = exited.clone();
        daemon.reap_set_exit_hook_for_test(Box::new(move || {
            exited.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
    }

    let daemon_json_path = dir.path().join("daemon.json");
    std::fs::write(&daemon_json_path, "{\"pid\":1}").expect("seed daemon.json");

    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonShutdownIfIdle,
    )
    .await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::OK,
        "a refusal to retire is a 200 with ok:false, like daemon_shutdown's failure shape"
    );
    let body: proto::ManageDaemonShutdownFailed = resp.json().await.unwrap();
    assert!(!body.ok);
    assert_eq!(
        body.unterminated,
        vec![1],
        "the refusal must name the session"
    );
    assert!(
        body.error.contains("1 live session") && body.error.contains("nothing was stopped"),
        "the refusal must name the count and that nothing was stopped: {}",
        body.error
    );

    // Nothing stopped: the daemon still answers and still reports the session,
    // which is the whole point of the verb for an update installer.
    let status_resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonStatus,
    )
    .await;
    let status: proto::ManageDaemonStatus = status_resp.json().await.unwrap();
    assert_eq!(status.live_sessions.count, 1);
    assert!(
        !exited.load(std::sync::atomic::Ordering::SeqCst),
        "a refused retire must not run the exit hook"
    );
    assert!(
        dir.path().join("daemon.json").exists(),
        "a refused retire must not remove the daemon's discovery files"
    );
}

#[tokio::test]
async fn daemon_shutdown_if_idle_stops_an_idle_daemon() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let daemon_json_path = dir.path().join("daemon.json");
    std::fs::write(&daemon_json_path, "{\"pid\":1}").expect("seed daemon.json");

    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let exited = exited.clone();
        daemon.reap_set_exit_hook_for_test(Box::new(move || {
            exited.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
    }

    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonShutdownIfIdle,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: proto::ManageDaemonShutdownOk = resp.json().await.unwrap();
    assert!(body.ok);
    assert_eq!(body.stopped_sessions, 0);

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !exited.load(std::sync::atomic::Ordering::SeqCst) {
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon_shutdown_if_idle's ok:true landed but the exit hook never fired");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        !daemon_json_path.exists(),
        "an idle retire must remove daemon.json like any clean shutdown"
    );
}

#[tokio::test]
async fn preflight_from_the_webview_origin_gets_the_cors_headers() {
    let (addr, _dir) = common::start_daemon().await;
    let client = reqwest::Client::new();
    let resp = client
        .request(reqwest::Method::OPTIONS, manage_url(addr))
        .header("Origin", "tauri://localhost")
        .header("Access-Control-Request-Method", "POST")
        .header(
            "Access-Control-Request-Headers",
            "authorization,content-type",
        )
        .send()
        .await
        .expect("sending OPTIONS /manage request");
    assert_eq!(resp.status(), reqwest::StatusCode::NO_CONTENT);
    let headers = resp.headers();
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "tauri://localhost"
    );
    assert_eq!(
        headers.get("access-control-allow-methods").unwrap(),
        "POST, OPTIONS"
    );
    assert_eq!(
        headers.get("access-control-allow-headers").unwrap(),
        "authorization, content-type"
    );
    assert_eq!(headers.get("access-control-max-age").unwrap(), "600");
    assert_eq!(headers.get("vary").unwrap(), "Origin");
}

#[tokio::test]
async fn preflight_from_an_unlisted_origin_is_refused_by_name() {
    let (addr, _dir) = common::start_daemon().await;
    let client = reqwest::Client::new();
    let resp = client
        .request(reqwest::Method::OPTIONS, manage_url(addr))
        .header("Origin", "http://evil.example")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .expect("sending OPTIONS /manage request");
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
    let body: proto::ManageErrorBody = resp.json().await.unwrap();
    assert!(
        body.error.contains("http://evil.example"),
        "refusal must name the offending origin: {:?}",
        body.error
    );
}

#[tokio::test]
async fn post_from_the_webview_origin_gets_the_cors_header_on_the_response() {
    let (addr, _dir) = common::start_daemon().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(manage_url(addr))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .header("Origin", "tauri://localhost")
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonStatus,
            candidate_bin: None,
        })
        .send()
        .await
        .expect("sending /manage request");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    assert_eq!(
        resp.headers().get("access-control-allow-origin").unwrap(),
        "tauri://localhost"
    );
}

#[tokio::test]
async fn post_without_an_origin_gets_no_cors_header() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request(
        addr,
        TOKEN,
        proto::MANAGE_VERSION,
        proto::ManageVerb::DaemonStatus,
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    assert!(resp.headers().get("access-control-allow-origin").is_none());
}

async fn manage_request_with_candidate(
    addr: std::net::SocketAddr,
    token: &str,
    verb: proto::ManageVerb,
    candidate_bin: Option<&str>,
) -> reqwest::Response {
    let client = reqwest::Client::new();
    client
        .post(manage_url(addr))
        .header("Authorization", format!("Bearer {token}"))
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb,
            candidate_bin: candidate_bin.map(str::to_string),
        })
        .send()
        .await
        .expect("sending /manage request")
}

#[tokio::test]
async fn daemon_handoff_refuses_an_invalid_candidate_by_name_before_anything_moves() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request_with_candidate(
        addr,
        TOKEN,
        proto::ManageVerb::DaemonHandoff,
        Some("relative/houston-core"),
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: proto::ManageDaemonHandoffResult = resp.json().await.unwrap();
    assert!(!body.accepted);
    let reason = body.reason.unwrap_or_default();
    assert!(
        reason.contains("relative/houston-core") && reason.contains("absolute"),
        "the refusal must name the candidate and the shape it expected: {reason}"
    );
}

#[tokio::test]
async fn candidate_bin_is_refused_on_verbs_that_do_not_use_it() {
    let (addr, _dir) = common::start_daemon().await;
    let resp = manage_request_with_candidate(
        addr,
        TOKEN,
        proto::ManageVerb::DaemonStatus,
        Some("/usr/bin/houston-core"),
    )
    .await;
    assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: proto::ManageErrorBody = resp.json().await.unwrap();
    assert!(body.error.contains("candidate_bin"), "{}", body.error);
    assert!(
        body.error.contains("daemon_handoff"),
        "the refusal must name the verb that does take it: {}",
        body.error
    );
}

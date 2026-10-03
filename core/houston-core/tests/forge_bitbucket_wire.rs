#![allow(clippy::disallowed_methods)]

mod common;

use axum::extract::{OriginalUri, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

// The keychain store is process-wide, so the tests that write the token take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const EMAIL: &str = "me@example.com";
const SECRET: &str = "ATATT-wire-secret-token";
const PR: &str = "/repositories/ws/repo/pullrequests/7";

fn use_mock_keychain() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
        keyring_core::set_default_store(
            keyring_core::mock::Store::new().expect("building the mock credential store"),
        );
    });
}

#[derive(Clone, Default)]
struct Fixture {
    requests: Arc<Mutex<Vec<String>>>,
    base: Arc<Mutex<String>>,
}

impl Fixture {
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn body(path: &str, query: &str) -> Option<&'static str> {
    Some(match path {
        "/repositories/ws/repo/pullrequests" if query.contains("feat%2Freader") => {
            include_str!("fixtures/bitbucket/branch_pullrequests.json")
        }
        "/repositories/ws/repo/pullrequests" => include_str!("fixtures/bitbucket/empty_page.json"),
        PR => include_str!("fixtures/bitbucket/pullrequest.json"),
        "/repositories/ws/repo/pullrequests/7/statuses" => {
            include_str!("fixtures/bitbucket/statuses.json")
        }
        "/repositories/ws/repo/pullrequests/7/comments" => {
            include_str!("fixtures/bitbucket/comments.json")
        }
        "/repositories/ws/repo/pullrequests/7/diffstat" => {
            include_str!("fixtures/bitbucket/diffstat.json")
        }
        "/repositories/ws/repo/pullrequests/7/commits" => {
            include_str!("fixtures/bitbucket/commits.json")
        }
        _ => return None,
    })
}

async fn serve(State(fx): State<Fixture>, OriginalUri(uri): OriginalUri) -> Response {
    let query = uri.query().unwrap_or_default().to_string();
    fx.requests
        .lock()
        .unwrap()
        .push(format!("{}?{query}", uri.path()));
    match body(uri.path(), &query) {
        Some(json) => (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            json,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn start_fixture() -> (Fixture, String) {
    let fx = Fixture::default();
    let app = axum::Router::new().fallback(serve).with_state(fx.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *fx.base.lock().unwrap() = base.clone();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (fx, base)
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

fn init_repo(dir: &Path, branch: &str) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
    git(dir, &["checkout", "-b", branch]);
    git(
        dir,
        &["remote", "add", "origin", "git@bitbucket.org:ws/repo.git"],
    );
}

async fn start_daemon_on(db_path: PathBuf, api_base: &str) -> (std::net::SocketAddr, Arc<Daemon>) {
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();
    daemon.set_bitbucket_api_base_for_test(api_base).unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    (addr, daemon)
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

/// The next control message matching `pick`, asserting that no message on the
/// way carries the token or names the Basic credentials.
async fn expect<T>(ws: &mut WsStream, pick: impl Fn(proto::ServerMsg) -> Option<T>) -> T {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("timed out waiting for a control message")
            .expect("socket closed")
            .expect("socket error");
        let Message::Text(text) = frame else {
            continue;
        };
        assert!(
            !text.contains(SECRET),
            "a wire message carried the token: {text}"
        );
        assert!(
            !text.contains("Basic "),
            "a wire message carried credentials: {text}"
        );
        let msg: proto::ServerMsg = serde_json::from_str(&text).unwrap();
        if let proto::ServerMsg::Error { message, .. } = &msg {
            panic!("daemon error: {message}");
        }
        if let Some(found) = pick(msg) {
            return found;
        }
    }
}

struct Detail {
    access: proto::ForgeAccess,
    link: Option<proto::PullRequestLink>,
    detail: Option<proto::PrDetail>,
    hint: Option<String>,
    message: Option<String>,
}

async fn pr_detail(ws: &mut WsStream, dir: &str, request: u32) -> Detail {
    send(
        ws,
        &proto::ClientMsg::PrDetail {
            dir: dir.to_string(),
            request,
            number: None,
        },
    )
    .await;
    expect(ws, |m| match m {
        proto::ServerMsg::PrDetail {
            request: r,
            access,
            link,
            detail,
            hint,
            message,
            ..
        } if r == request => Some(Detail {
            access,
            link,
            detail,
            hint,
            message,
        }),
        _ => None,
    })
    .await
}

async fn forge_settings(ws: &mut WsStream) -> (bool, Option<String>) {
    expect(ws, |m| match m {
        proto::ServerMsg::ForgeSettings {
            bitbucket_enabled,
            bitbucket_account,
            ..
        } => Some((bitbucket_enabled, bitbucket_account)),
        _ => None,
    })
    .await
}

fn bitbucket(state: proto::BitbucketAccess) -> proto::ForgeAccess {
    proto::ForgeAccess::Bitbucket { state }
}

#[tokio::test]
async fn a_bitbucket_workspace_is_read_only_after_opt_in_and_silent_before() {
    let _serial = SERIAL.lock().await;
    use_mock_keychain();
    let (fx, base) = start_fixture().await;
    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db"), &base).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path(), "feat/reader");
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, &proto::ClientMsg::BitbucketTokenClear).await;
    assert_eq!(forge_settings(&mut ws).await, (false, None));

    let off = pr_detail(&mut ws, &dir, 1).await;
    assert_eq!(off.access, bitbucket(proto::BitbucketAccess::Off));
    assert!(off.link.is_none() && off.detail.is_none() && off.message.is_none());
    assert!(off.hint.is_some());
    assert_eq!(fx.count(), 0, "a disabled forge sends nothing");

    send(
        &mut ws,
        &proto::ClientMsg::BitbucketEnabledSet { enabled: true },
    )
    .await;
    assert_eq!(forge_settings(&mut ws).await, (true, None));
    let no_token = pr_detail(&mut ws, &dir, 2).await;
    assert_eq!(no_token.access, bitbucket(proto::BitbucketAccess::NoToken));
    assert_eq!(fx.count(), 0, "no token, no request");

    send(
        &mut ws,
        &proto::ClientMsg::BitbucketTokenSet {
            email: EMAIL.to_string(),
            token: SECRET.to_string(),
        },
    )
    .await;
    assert_eq!(
        forge_settings(&mut ws).await,
        (true, Some(EMAIL.to_string()))
    );
    assert_eq!(fx.count(), 0, "saving a token is not a request");

    let ready = pr_detail(&mut ws, &dir, 3).await;
    assert_eq!(ready.access, bitbucket(proto::BitbucketAccess::Ready));
    assert_eq!(ready.message, None);
    let link = ready.link.expect("the branch's pull request");
    assert_eq!(link.host, "Bitbucket");
    assert_eq!(link.number, 7);
    assert_eq!(link.source, proto::PullRequestLinkSource::Detected);
    let detail = ready.detail.expect("its detail");
    assert_eq!(detail.checks.len(), 3);
    assert_eq!(detail.reviews_total, 2);
    assert_eq!(detail.threads.len(), 2);
    assert!(detail.read_only.is_some());
    assert_eq!(detail.merge_disabled_reason, detail.read_only);
    let reads = fx.count();
    assert_eq!(
        reads, 6,
        "branch lookup, the pull request and four follow-ups"
    );
    let branch_query = fx.requests.lock().unwrap()[0].clone();
    assert!(branch_query.contains("feat%2Freader"), "{branch_query}");

    for (msg, what) in [
        (
            proto::ClientMsg::PrComment {
                dir: dir.clone(),
                number: 7,
                body: "hi".into(),
                request: 10,
            },
            "comment",
        ),
        (
            proto::ClientMsg::PrMerge {
                dir: dir.clone(),
                number: 7,
                method: proto::PrMergeMethod::Squash,
                expected_head_sha: "0123456789abcdef0123456789abcdef01234567".into(),
                request: 11,
            },
            "merge",
        ),
    ] {
        send(&mut ws, &msg).await;
        let refusal = expect(&mut ws, |m| match m {
            proto::ServerMsg::PrMutation { ok, message, .. }
            | proto::ServerMsg::PrMerged { ok, message, .. } => Some((ok, message)),
            _ => None,
        })
        .await;
        assert!(!refusal.0, "{what} must be refused");
        let message = refusal.1.unwrap_or_default();
        assert!(message.contains("Bitbucket"), "{what}: {message}");
        assert!(message.contains(what), "{what}: {message}");
    }
    send(
        &mut ws,
        &proto::ClientMsg::PrCreate {
            dir: dir.clone(),
            title: Some("t".into()),
            body: Some("b".into()),
        },
    )
    .await;
    let created = expect(&mut ws, |m| match m {
        proto::ServerMsg::PrCreate { pr, message, .. } => Some((pr, message)),
        _ => None,
    })
    .await;
    assert!(created.0.is_none());
    assert!(created.1.unwrap_or_default().contains("Bitbucket"));
    assert_eq!(fx.count(), reads, "a refused write sends nothing");

    send(&mut ws, &proto::ClientMsg::BitbucketTokenClear).await;
    assert_eq!(forge_settings(&mut ws).await, (true, None));
    let cleared = pr_detail(&mut ws, &dir, 4).await;
    assert_eq!(cleared.access, bitbucket(proto::BitbucketAccess::NoToken));
    assert_eq!(fx.count(), reads);
}

#[tokio::test]
async fn a_branch_without_a_bitbucket_pull_request_is_the_empty_state() {
    let _serial = SERIAL.lock().await;
    use_mock_keychain();
    let (fx, base) = start_fixture().await;
    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db"), &base).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path(), "feat/nothing");
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::BitbucketEnabledSet { enabled: true },
    )
    .await;
    let _ = forge_settings(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::BitbucketTokenSet {
            email: EMAIL.to_string(),
            token: SECRET.to_string(),
        },
    )
    .await;
    let _ = forge_settings(&mut ws).await;

    let empty = pr_detail(&mut ws, &dir, 1).await;
    assert_eq!(empty.access, bitbucket(proto::BitbucketAccess::Ready));
    assert!(empty.link.is_none());
    assert!(empty.detail.is_none());
    assert_eq!(empty.message, None);
    assert_eq!(fx.count(), 1, "only the branch lookup");

    send(&mut ws, &proto::ClientMsg::BitbucketTokenClear).await;
    let _ = forge_settings(&mut ws).await;
}

#[tokio::test]
async fn a_daemon_outside_the_installed_state_dir_never_touches_the_installed_token() {
    let _serial = SERIAL.lock().await;
    use_mock_keychain();
    let installed = keyring::Entry::new("houston-forge", "bitbucket-cloud").unwrap();
    let _ = installed.delete_credential();
    let (_fx, base) = start_fixture().await;
    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db"), &base).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::BitbucketTokenSet {
            email: EMAIL.to_string(),
            token: SECRET.to_string(),
        },
    )
    .await;
    assert_eq!(forge_settings(&mut ws).await.1, Some(EMAIL.to_string()));
    assert!(
        matches!(installed.get_password(), Err(keyring::Error::NoEntry)),
        "a test daemon wrote the installed build's keychain entry"
    );

    installed
        .set_password(r#"{"email":"installed@example.com","token":"kept"}"#)
        .unwrap();
    send(&mut ws, &proto::ClientMsg::BitbucketTokenClear).await;
    assert_eq!(forge_settings(&mut ws).await.1, None);
    assert!(
        installed.get_password().is_ok(),
        "Disconnect on a test daemon deleted the installed build's token"
    );
    installed.delete_credential().unwrap();
}

#[tokio::test]
async fn a_refused_token_comes_back_to_the_accounts_section_by_context() {
    let _serial = SERIAL.lock().await;
    use_mock_keychain();
    let (fx, base) = start_fixture().await;
    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db"), &base).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let oversized = "t".repeat(proto::BITBUCKET_TOKEN_LEN_MAX as usize + 1);
    send(
        &mut ws,
        &proto::ClientMsg::BitbucketTokenSet {
            email: EMAIL.to_string(),
            token: oversized.clone(),
        },
    )
    .await;
    let (message, context) = loop {
        let msg = next_control(&mut ws).await;
        if let proto::ServerMsg::Error { message, context } = msg {
            break (message, context);
        }
    };
    assert_eq!(context.as_deref(), Some("forge_settings"));
    assert!(message.contains("1024-byte limit"), "{message}");
    assert!(!message.contains(&oversized), "{message}");
    assert_eq!(fx.count(), 0);
}

#[tokio::test]
async fn a_reader_that_cannot_be_built_is_not_called_a_keychain_failure() {
    let _serial = SERIAL.lock().await;
    use_mock_keychain();
    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) =
        start_daemon_on(state.path().join("test.db"), "http://127.0.0.1:99999").await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path(), "feat/reader");
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::BitbucketEnabledSet { enabled: true },
    )
    .await;
    let _ = forge_settings(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::BitbucketTokenSet {
            email: EMAIL.to_string(),
            token: SECRET.to_string(),
        },
    )
    .await;
    let _ = forge_settings(&mut ws).await;

    let read = pr_detail(&mut ws, &dir, 1).await;
    assert_eq!(read.access, bitbucket(proto::BitbucketAccess::Ready));
    let message = read.message.expect("the build failure is named");
    assert!(message.contains("HTTP client"), "{message}");
    assert!(!message.contains("keychain"), "{message}");
    assert!(read.hint.is_none());

    send(&mut ws, &proto::ClientMsg::BitbucketTokenClear).await;
    let _ = forge_settings(&mut ws).await;
}

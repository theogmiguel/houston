//! The `/ws` endpoint: one socket carries control as JSON text frames and PTY
//! bytes as binary frames, in both directions. It binds loopback only, since
//! the renderer's WebSocket API cannot dial a unix socket.
#[path = "server_orchestration_doors.rs"]
mod orchestration_doors;

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::Router;
use base64::Engine;
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;

use crate::daemon::{CreateParams, Daemon, Outbound, OUTBOUND_CAPACITY};
use crate::frame_queue::{FrameTap, Queued};
use tokio::sync::Notify;

// Bound per-request CLI process fan-out while covering the usual visible rail viewport.
const MAX_PR_STATUS_BATCH_DIRS: usize = 32;

fn check_pr_status_batch_size(actual: usize) -> Result<()> {
    if actual > MAX_PR_STATUS_BATCH_DIRS {
        anyhow::bail!(
            "PrStatusBatch limit is {MAX_PR_STATUS_BATCH_DIRS} dirs; {actual} dirs requested by this request"
        );
    }
    Ok(())
}

pub async fn start(daemon: Arc<Daemon>, addr: SocketAddr) -> Result<(SocketAddr, JoinHandle<()>)> {
    let listener = bind(addr).await?;
    start_with_listener(daemon, listener).await
}

pub async fn bind(addr: SocketAddr) -> Result<tokio::net::TcpListener> {
    Ok(tokio::net::TcpListener::bind(addr).await?)
}

pub async fn start_with_listener(
    daemon: Arc<Daemon>,
    listener: tokio::net::TcpListener,
) -> Result<(SocketAddr, JoinHandle<()>)> {
    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route(
            "/mcp",
            post(mcp_post)
                .get(mcp_listen)
                .delete(mcp_method_not_allowed),
        )
        .route("/orchestrate/whoami", get(orch_whoami))
        .route("/orchestrate/list", get(orch_list))
        .route("/orchestrate/read", get(orch_read))
        .route("/orchestrate/get", get(orch_get))
        .route("/orchestrate/keys", post(orch_send_keys))
        .route("/orchestrate/spawn", post(orch_spawn))
        .route("/orchestrate/prompt", post(orch_prompt))
        .route("/orchestrate/wait", post(orch_wait))
        .route("/orchestrate/kill", post(orch_kill))
        .route("/orchestrate/submit", post(orch_submit))
        .route("/orchestrate/report", post(orch_report))
        .route("/orchestrate/reply", post(orch_reply))
        .route("/orchestrate/message", post(orch_message))
        .route("/orchestrate/deny", post(orchestration_doors::deny))
        .route("/orchestrate/escalate", post(orchestration_doors::escalate))
        .route(
            "/orchestrate/instruction-list",
            get(orchestration_doors::instruction_list),
        )
        .route(
            "/orchestrate/instruction-get",
            get(orchestration_doors::instruction_get),
        )
        .route(
            "/orchestrate/instruction-cancel",
            post(orchestration_doors::instruction_cancel),
        )
        .route(
            "/orchestrate/instruction-resume",
            post(orchestration_doors::instruction_resume),
        )
        .route("/orchestrate/pr-watch", post(orch_pr_watch))
        .route("/orchestrate/pr-unwatch", post(orch_pr_unwatch))
        .route("/orchestrate/pr-enqueue", post(orch_pr_enqueue))
        .route("/orchestrate/pr-dequeue", post(orch_pr_dequeue))
        .route("/orchestrate/build-slot", post(orch_build_slot))
        .route("/harness/publish", post(harness_publish))
        .route("/night/{verb}", post(night_post))
        .route("/task/next", get(task_next))
        .route("/task/list", get(task_list))
        .route("/task/get", get(task_get))
        .route("/task/create", post(task_create))
        .route("/task/update", post(task_update))
        .route("/task/comment", post(task_comment))
        .route("/task/check", post(task_check))
        .route("/task/claim", post(task_claim))
        .route("/task/handback", post(task_handback))
        .route("/task/ask", post(task_ask))
        .route("/inbox/tool-boundary", post(inbox_tool_boundary))
        .route("/inbox/reserve", post(inbox_reserve))
        .route("/inbox/delivered", post(inbox_delivered))
        .route(
            "/manage",
            post(manage_post)
                .options(manage_preflight)
                .layer(middleware::from_fn(manage_cors_layer)),
        )
        .with_state(daemon.clone());
    let local = listener.local_addr()?;
    let listener = listener.tap_io(enable_tcp_nodelay);
    #[cfg(unix)]
    let shutdown = {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        daemon.set_server_shutdown(tx);
        async move {
            let _ = rx.await;
        }
    };
    #[cfg(not(unix))]
    let shutdown = std::future::pending::<()>();
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await
        {
            tracing::error!("server terminated: {e}");
        }
    });
    Ok((local, handle))
}

fn enable_tcp_nodelay(stream: &mut tokio::net::TcpStream) {
    if let Err(err) = stream.set_nodelay(true) {
        tracing::debug!("setting TCP_NODELAY on an accepted socket failed: {err}");
    }
}

// Constant-time compare: token lengths are fixed (UUIDv4), so the early
// length check leaks nothing. A plain `==` would let a caller recover the
// daemon token byte by byte from response timing.
fn token_matches(expected: &str, got: &str) -> bool {
    let (a, b) = (expected.as_bytes(), got.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn ws_upgrade(State(daemon): State<Arc<Daemon>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| client_loop(daemon, socket))
}

struct SharedFrame(Arc<Vec<u8>>);

impl AsRef<[u8]> for SharedFrame {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl crate::mcp_server::McpHost for Daemon {
    fn resolve(&self, raw_token: &str) -> Option<crate::mcp_creds::McpScope> {
        self.mcp_creds.resolve(raw_token)
    }

    fn tools(&self) -> &crate::mcp_server::ToolRegistry {
        &self.mcp_tools
    }

    fn agent_kind(&self, session: u32) -> Option<proto::AgentKind> {
        self.agent_kind_of(session)
    }

    fn progress_tick(&self) -> std::time::Duration {
        self.mcp_progress_tick()
    }

    fn notifier(&self) -> Option<&crate::mcp_server::NotifierRegistry> {
        Some(&self.mcp_notify)
    }

    fn shutting_down(&self) -> bool {
        self.refusing_mutations()
    }
}

async fn mcp_post(State(daemon): State<Arc<Daemon>>, headers: HeaderMap, body: Bytes) -> Response {
    crate::mcp_server::handle_post(daemon.as_ref(), &headers, body).await
}

async fn mcp_listen(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    crate::mcp_server::handle_listen(daemon.as_ref(), &headers).await
}

async fn mcp_method_not_allowed(method: Method) -> Response {
    crate::mcp_server::handle_unsupported_method(method.as_str())
}

fn manage_json<T: serde::Serialize>(status: StatusCode, body: &T) -> Response {
    (status, axum::Json(body)).into_response()
}

fn manage_error(status: StatusCode, message: impl Into<String>) -> Response {
    manage_json(
        status,
        &proto::ManageErrorBody {
            error: message.into(),
        },
    )
}

const MANAGE_WEBVIEW_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

fn allowed_webview_origin(headers: &HeaderMap) -> Option<&str> {
    let origin = headers.get(axum::http::header::ORIGIN)?.to_str().ok()?;
    MANAGE_WEBVIEW_ORIGINS.contains(&origin).then_some(origin)
}

async fn manage_preflight(headers: HeaderMap) -> Response {
    let Some(origin_header) = headers.get(axum::http::header::ORIGIN) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if allowed_webview_origin(&headers).is_none() {
        let origin = origin_header.to_str().unwrap_or("<non-utf8 origin>");
        return manage_error(
            StatusCode::FORBIDDEN,
            format!(
                "origin {origin:?} may not call /manage; allowed origins are {MANAGE_WEBVIEW_ORIGINS:?}"
            ),
        );
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    let h = res.headers_mut();
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST, OPTIONS"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    res
}

async fn manage_cors_layer(request: Request, next: Next) -> Response {
    let allowed_origin = allowed_webview_origin(request.headers()).map(str::to_owned);
    let mut res = next.run(request).await;
    if let Some(origin) = allowed_origin {
        let h = res.headers_mut();
        h.insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_str(&origin).expect("origin already validated as ASCII"),
        );
        h.insert(axum::http::header::VARY, HeaderValue::from_static("Origin"));
    }
    res
}

async fn manage_post(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(token) = crate::mcp_server::bearer_token(&headers) else {
        return manage_error(StatusCode::UNAUTHORIZED, "missing bearer token");
    };
    if !token_matches(&daemon.token, &token) {
        return manage_error(StatusCode::UNAUTHORIZED, "invalid token");
    }
    let request: proto::ManageRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return manage_error(
                StatusCode::BAD_REQUEST,
                format!("invalid manage request: {e}"),
            );
        }
    };
    if request.manage_version != proto::MANAGE_VERSION {
        return manage_error(
            StatusCode::CONFLICT,
            format!(
                "manage version mismatch: daemon {}, caller {}",
                proto::MANAGE_VERSION,
                request.manage_version
            ),
        );
    }
    if request.candidate_bin.is_some() && request.verb != proto::ManageVerb::DaemonHandoff {
        return manage_error(
            StatusCode::BAD_REQUEST,
            format!(
                "candidate_bin is only meaningful with daemon_handoff, not {:?}",
                request.verb
            ),
        );
    }
    if request.expected_sessions.is_some()
        && request.verb != proto::ManageVerb::DaemonShutdownIfSessions
    {
        return manage_error(
            StatusCode::BAD_REQUEST,
            format!(
                "expected_sessions is only meaningful with daemon_shutdown_if_sessions, not {:?}",
                request.verb
            ),
        );
    }
    if request.verb == proto::ManageVerb::DaemonShutdownIfSessions
        && request.expected_sessions.is_none()
    {
        return manage_error(
            StatusCode::BAD_REQUEST,
            "daemon_shutdown_if_sessions requires expected_sessions: the array of live session \
             ids the caller confirmed (an empty array confirms that none are live)",
        );
    }
    if request.path.is_some() && request.verb != proto::ManageVerb::WorkspaceOpen {
        return manage_error(
            StatusCode::BAD_REQUEST,
            format!(
                "path is only meaningful with workspace_open, not {:?}",
                request.verb
            ),
        );
    }
    match request.verb {
        proto::ManageVerb::DaemonStatus => manage_json(StatusCode::OK, &daemon.manage_status()),
        proto::ManageVerb::WorkspaceOpen => manage_workspace_open(daemon, request.path).await,
        proto::ManageVerb::DaemonHandoff => {
            let candidate_bin = request.candidate_bin.clone();
            let for_handoff = Arc::clone(&daemon);
            let result = tokio::task::spawn_blocking(move || {
                for_handoff.begin_handoff(candidate_bin.as_deref())
            })
            .await
            .unwrap_or_else(|e| proto::ManageDaemonHandoffResult {
                accepted: false,
                reason: Some(format!("handoff task panicked: {e}")),
                generation: None,
                sessions_transferred: None,
            });
            if result.accepted {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    daemon.call_exit_hook();
                });
            }
            manage_json(StatusCode::OK, &result)
        }
        proto::ManageVerb::DaemonShutdown
        | proto::ManageVerb::DaemonShutdownIfIdle
        | proto::ManageVerb::DaemonShutdownIfSessions => {
            let verb = request.verb;
            let expected = request.expected_sessions.clone().unwrap_or_default();
            let for_shutdown = Arc::clone(&daemon);
            let result = tokio::task::spawn_blocking(move || match verb {
                proto::ManageVerb::DaemonShutdownIfIdle => for_shutdown.manage_shutdown_if_idle(),
                proto::ManageVerb::DaemonShutdownIfSessions => {
                    for_shutdown.manage_shutdown_if_sessions(&expected)
                }
                _ => for_shutdown.manage_shutdown(),
            })
            .await
            .unwrap_or_else(|e| {
                Err(crate::daemon::ShutdownFailure {
                    reason: format!("shutdown task panicked: {e}"),
                    unterminated: Vec::new(),
                })
            });
            match result {
                Ok(ok) => {
                    let res = manage_json(StatusCode::OK, &ok);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        daemon.call_exit_hook();
                    });
                    res
                }
                Err(failure) => manage_json(
                    StatusCode::OK,
                    &proto::ManageDaemonShutdownFailed {
                        ok: false,
                        error: failure.reason,
                        unterminated: failure.unterminated,
                    },
                ),
            }
        }
    }
}

async fn manage_workspace_open(daemon: Arc<Daemon>, path: Option<String>) -> Response {
    let Some(path) = path else {
        return manage_error(
            StatusCode::BAD_REQUEST,
            "workspace_open requires path: an absolute directory path",
        );
    };
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return manage_error(
            StatusCode::BAD_REQUEST,
            format!("workspace_open path {path:?} is not an existing absolute directory; expected an absolute directory path"),
        );
    }
    let daemon_bg = Arc::clone(&daemon);
    let added = path.clone();
    let result = tokio::task::spawn_blocking(move || daemon_bg.workspace_add(&added))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("workspace add task panicked: {e}")));
    match result {
        Ok(workspaces) => {
            daemon.broadcast_control(&proto::ServerMsg::WorkspaceList { workspaces });
            daemon.broadcast_control(&proto::ServerMsg::WorkspaceFocus { path: path.clone() });
            manage_json(
                StatusCode::OK,
                &proto::ManageWorkspaceOpenOk { ok: true, path },
            )
        }
        Err(e) => manage_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("workspace_open {path:?} failed: {e:#}"),
        ),
    }
}

async fn client_loop(daemon: Arc<Daemon>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    let authed = match stream.next().await {
        Some(Ok(Message::Text(text))) => match serde_json::from_str::<proto::ClientMsg>(&text) {
            Ok(proto::ClientMsg::Hello { token, protocol }) => {
                if protocol != proto::PROTOCOL_VERSION {
                    send_error(
                        &mut sink,
                        format!(
                            "protocol mismatch: client {protocol}, daemon {}",
                            proto::PROTOCOL_VERSION
                        ),
                        None,
                    )
                    .await;
                    false
                } else if !token_matches(&daemon.token, &token) {
                    send_error(&mut sink, "invalid token".into(), None).await;
                    false
                } else {
                    true
                }
            }
            _ => {
                send_error(&mut sink, "expected hello as first message".into(), None).await;
                false
            }
        },
        _ => false,
    };
    if !authed {
        let _ = sink.close().await;
        return;
    }

    // Subscribe before taking the snapshot so a transition cannot fall into
    // the gap between HelloOk construction and the live stream.
    let mut rx = daemon.subscribe();
    let flags = daemon.safe_mode_flags();
    let hello_ok = proto::ServerMsg::HelloOk {
        protocol: proto::PROTOCOL_VERSION,
        sessions: daemon.list(),
        workspaces: daemon.workspace_list().unwrap_or_default(),
        recovery: daemon.recovery_summary(),
        safe_mode: proto::SafeModeSummary {
            disable_auto_restore: flags.disable_auto_restore,
            disable_swarm_autolaunch: flags.disable_swarm_autolaunch,
        },
        tags: daemon.tag_list(),
        snapshot_attach: crate::vt::available(),
        snapshot_format_version: crate::vt::snapshot_format_version(),
    };
    if send_msg(&mut sink, &hello_ok).await.is_err() {
        return;
    }

    let wake = Arc::new(Notify::new());
    // The session this connection last typed into; flush_frames drains its tap
    // first so a keystroke echo never queues behind a turn of every busy pane.
    let last_typed = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let mut frames_wanted = AttachSet::new(Arc::clone(&daemon), Arc::clone(&wake));
    let conn_id = daemon.conn_register();

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<ControlReply>(CONTROL_REPLY_QUEUE);
    let replies = ReplySink {
        tx: reply_tx,
        bytes: Arc::new(tokio::sync::Semaphore::new(CONTROL_REPLY_BYTES)),
        failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        wake: Arc::clone(&wake),
    };
    let handlers = Arc::new(tokio::sync::Semaphore::new(CONTROL_HANDLERS_PER_CONNECTION));
    // This loop owns every write; while a send waits on a slow client it reads nothing,
    // so the socket's read half lives on its own task and stdin never waits behind output.
    let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::channel::<Inbound>(CONTROL_INBOUND_QUEUE);
    let mut reader = AbortOnDrop(tokio::spawn(read_client(
        Arc::clone(&daemon),
        stream,
        inbound_tx,
        conn_id,
        Arc::clone(&last_typed),
    )));
    let mut on_loop = OnLoop::default();
    let mut reader_done = false;
    loop {
        if reader_done && on_loop.is_idle() {
            break;
        }
        tokio::select! {
            Some(landed) = on_loop.landing.next(), if !on_loop.landing.is_empty() => {
                on_loop.land(&mut sink, &mut frames_wanted, landed).await;
                while let Some(deferred) = on_loop.next_ready() {
                    handle_control(&daemon, &mut sink, &replies, &handlers, &deferred.text, &mut frames_wanted, &mut on_loop, conn_id)
                        .await;
                }
            }
            Some(reply) = reply_rx.recv() => {
                if sink.send(reply.message).await.is_err() {
                    break;
                }
            }
            _ = wake.notified() => {
                if replies.failed.load(std::sync::atomic::Ordering::Acquire) {
                    break;
                }
                if !flush_frames(&mut sink, &frames_wanted, &last_typed).await {
                    break;
                }
            }
            out = rx.recv() => match out {
                Ok(Outbound::Frame(_)) => {
                }
                Ok(Outbound::Control(json)) => {
                    if let Some(session) = removed_session(&json) {
                        frames_wanted.forget(session);
                        daemon.conn_set_visibility(conn_id, session, true);
                    }
                    if sink.send(Message::Text(json.as_str().to_owned().into())).await.is_err() {
                        break;
                    }
                }
                Ok(Outbound::ControlFor(conn, json)) => {
                    if conn != conn_id {
                        continue;
                    }
                    if sink.send(Message::Text(json.as_str().to_owned().into())).await.is_err() {
                        break;
                    }
                }
                // PTY frames may drop with a gap because the pane re-attaches,
                // but a missed control event cannot be replayed: the honest
                // recovery is a reconnect whose `hello_ok` re-sends all state.
                Err(RecvError::Lagged(n)) => {
                    send_error(
                        &mut sink,
                        format!(
                            "control channel lagged: this connection missed {n} control messages \
                             (broadcast capacity {OUTBOUND_CAPACITY}); closing so a reconnect \
                             resyncs the full state"
                        ),
                        Some("control_lag".into()),
                    )
                    .await;
                    break;
                }
                Err(RecvError::Closed) => break,
            },
            incoming = inbound_rx.recv(), if !reader_done && on_loop.deferred.len() < CONTROL_INBOUND_QUEUE => match incoming {
                Some(Inbound::Control(text, bytes)) => {
                    if let Some(deferred) = on_loop.order(text, bytes) {
                        handle_control(&daemon, &mut sink, &replies, &handlers, &deferred.text, &mut frames_wanted, &mut on_loop, conn_id)
                            .await;
                    }
                }
                Some(Inbound::StdinError(message)) => {
                    send_error(&mut sink, message, Some("stdin".into())).await;
                }
                // Requests already admitted still land and send their replies before the loop ends.
                None => reader_done = true,
            },
        }
    }
    // Await the aborted reader so no stdin is delivered for a forgotten connection and the
    // socket closes once both halves are dropped.
    reader.0.abort();
    if let Err(error) = (&mut reader.0).await {
        if error.is_panic() {
            tracing::warn!("client reader failed: {error}");
        }
    }
    daemon.conn_forget(conn_id);
}

// Control messages wait here, in socket order, while the connection loop is busy writing.
// A reconnect burst (an attach per pane plus a few list requests) fits; past either bound
// the reader stops reading until the loop catches up, which is the pre-split backpressure.
const CONTROL_INBOUND_QUEUE: usize = 256;
const CONTROL_INBOUND_BYTES: usize = 1024 * 1024;

enum Inbound {
    Control(
        axum::extract::ws::Utf8Bytes,
        tokio::sync::OwnedSemaphorePermit,
    ),
    StdinError(String),
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Delivers stdin frames to their PTYs as they arrive and forwards control text, in order,
/// to the connection loop. Returning (close, error or a closed loop) ends the connection.
async fn read_client(
    daemon: Arc<Daemon>,
    mut stream: futures_util::stream::SplitStream<WebSocket>,
    inbound: tokio::sync::mpsc::Sender<Inbound>,
    conn_id: u64,
    last_typed: Arc<std::sync::atomic::AtomicU32>,
) {
    let bytes = Arc::new(tokio::sync::Semaphore::new(CONTROL_INBOUND_BYTES));
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                // A message larger than the budget still passes, alone, as before the split.
                let size = text.len().clamp(1, CONTROL_INBOUND_BYTES) as u32;
                let Ok(permit) = Arc::clone(&bytes).acquire_many_owned(size).await else {
                    return;
                };
                if inbound.send(Inbound::Control(text, permit)).await.is_err() {
                    return;
                }
            }
            Some(Ok(Message::Binary(buf))) => {
                let Some((id, payload)) = proto::decode_stdin_frame(&buf) else {
                    continue;
                };
                last_typed.store(id, std::sync::atomic::Ordering::Relaxed);
                daemon.note_operator_keystroke(id, payload);
                if let Err(e) = daemon.enqueue_stdin_from_renderer(id, payload, conn_id) {
                    if vanished(&daemon, id, "stdin") {
                        continue;
                    }
                    let message = e.to_string();
                    // Refusals are advisory and the loop may be blocked on a slow client;
                    // waiting here would stall input for every other pane on the socket.
                    match inbound.try_send(Inbound::StdinError(message.clone())) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => tracing::warn!(
                            "session {id} stdin refusal not reported: connection queue holds \
                             {CONTROL_INBOUND_QUEUE} of {CONTROL_INBOUND_QUEUE} messages; {message}"
                        ),
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return,
                    }
                }
            }
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                tracing::debug!("client socket error: {e}");
                return;
            }
        }
    }
}

// Payload one session sends per flush turn, and the last-typed session's tap is drained
// first, so its echo never waits behind one turn of every busy pane, only its own write.
const FLUSH_TURN_BYTES: usize = 64 * 1024;

async fn flush_frames(
    sink: &mut (impl SinkExt<Message> + Unpin),
    taps: &AttachSet,
    last_typed: &std::sync::atomic::AtomicU32,
) -> bool {
    let typed = last_typed.load(std::sync::atomic::Ordering::Relaxed);
    let mut fed = false;
    for tap in taps.taps((typed != 0).then_some(typed)) {
        let Some(session) = tap.session() else {
            continue;
        };
        let (items, more) = tap.drain_up_to(FLUSH_TURN_BYTES);
        // Leftovers re-arm the wake, so the loop serves control traffic between turns.
        if more {
            taps.wake.notify_one();
        }
        for item in items {
            let bytes = match item {
                Queued::Frame(frame) => Bytes::from_owner(SharedFrame(frame)),
                Queued::Gap { anchor, dropped } => {
                    tracing::info!(
                        "session {session}: this connection fell behind, {dropped} bytes \
                         dropped from offset {anchor}; sending a gap so the pane re-attaches"
                    );
                    Bytes::from(proto::encode_gap_frame(session, anchor, dropped))
                }
            };
            if sink.feed(Message::Binary(bytes)).await.is_err() {
                return false;
            }
            fed = true;
        }
    }
    !fed || sink.flush().await.is_ok()
}

fn removed_session(json: &str) -> Option<u32> {
    #[derive(serde::Deserialize)]
    struct Header<'a> {
        #[serde(rename = "type", borrow)]
        kind: &'a str,
        session: Option<u32>,
    }
    let header: Header<'_> = serde_json::from_str(json).ok()?;
    (header.kind == "session_removed")
        .then_some(header.session)
        .flatten()
}

struct AttachSet {
    taps: std::collections::HashMap<u32, Arc<FrameTap>>,
    visible: std::collections::HashSet<u32>,
    attempts: std::collections::HashMap<u32, u32>,
    // Sessions whose attach reply is still being prepared; their frames wait behind it.
    held: std::collections::HashSet<u32>,
    daemon: Arc<Daemon>,
    wake: Arc<Notify>,
}

impl AttachSet {
    fn new(daemon: Arc<Daemon>, wake: Arc<Notify>) -> Self {
        Self {
            taps: std::collections::HashMap::new(),
            visible: std::collections::HashSet::new(),
            attempts: std::collections::HashMap::new(),
            held: std::collections::HashSet::new(),
            daemon,
            wake,
        }
    }

    fn hold(&mut self, session: u32) {
        self.held.insert(session);
    }

    fn release(&mut self, session: u32) {
        if self.held.remove(&session) {
            self.wake.notify_one();
        }
    }

    fn insert(&mut self, session: u32) {
        if !self.daemon.has_session(session) || !self.visible.insert(session) {
            return;
        }
        let tap = self
            .taps
            .entry(session)
            .or_insert_with(|| FrameTap::new(Some(session), Arc::clone(&self.wake)));
        tap.clear();
        self.daemon.frame_taps().register(tap);
        self.daemon.ws_attach(session);
    }

    fn remove(&mut self, session: u32) {
        if !self.visible.remove(&session) {
            return;
        }
        if let Some(tap) = self.taps.remove(&session) {
            self.daemon.frame_taps().unregister(&tap);
            tap.clear();
        }
        self.daemon.ws_detach(session);
    }

    fn forget(&mut self, session: u32) {
        self.remove(session);
        self.attempts.remove(&session);
    }

    fn attach(&mut self, session: u32, bytes_seen: Option<u64>) -> u32 {
        self.insert(session);
        let attempts = &mut self.attempts;
        self.taps
            .get(&session)
            .map(|tap| {
                tap.attach(bytes_seen);
                let attempt = attempts.entry(session).or_default();
                *attempt = attempt.saturating_add(1);
                *attempt
            })
            .unwrap_or(0)
    }

    /// Visible taps with `priority` (this connection's last-typed session) first, so
    /// its echo does not wait behind one turn of every busy pane in HashSet order. Taps held
    /// behind an attach reply are skipped until it lands.
    fn taps(&self, priority: Option<u32>) -> Vec<Arc<FrameTap>> {
        let mut ordered = Vec::with_capacity(self.visible.len());
        if let Some(id) = priority {
            if self.visible.contains(&id) && !self.held.contains(&id) {
                if let Some(tap) = self.taps.get(&id) {
                    ordered.push(Arc::clone(tap));
                }
            }
        }
        ordered.extend(
            self.visible
                .iter()
                .filter(|id| Some(**id) != priority)
                .filter(|id| !self.held.contains(id))
                .filter_map(|id| self.taps.get(id).cloned()),
        );
        ordered
    }
}

impl Drop for AttachSet {
    fn drop(&mut self) {
        for session in self.visible.iter() {
            if let Some(tap) = self.taps.get(session) {
                self.daemon.frame_taps().unregister(tap);
            }
            self.daemon.ws_detach(*session);
        }
    }
}

fn is_read_only_during_shutdown(msg: &proto::ClientMsg) -> bool {
    matches!(
        msg,
        proto::ClientMsg::SessionList
            | proto::ClientMsg::SkillSync
            | proto::ClientMsg::OrchestrationSettingsGet
            | proto::ClientMsg::HostInfoGet
            | proto::ClientMsg::UsageSummaryGet { .. }
            | proto::ClientMsg::UsageActivitySummaryGet { .. }
            | proto::ClientMsg::CommandHistoryIgnoreGlobsGet
            | proto::ClientMsg::McpState
            | proto::ClientMsg::AgentProfileList
            | proto::ClientMsg::RoutineList
            | proto::ClientMsg::AgentHooks
            | proto::ClientMsg::VoiceSettingsGet
            | proto::ClientMsg::VoiceDevicesGet
            | proto::ClientMsg::SessionCwd { .. }
            | proto::ClientMsg::SessionCwds { .. }
            | proto::ClientMsg::SessionRunningProcs { .. }
            | proto::ClientMsg::WorkspaceList
            | proto::ClientMsg::WorkspaceLocalServers { .. }
            | proto::ClientMsg::GitStatus { .. }
            | proto::ClientMsg::GitDiff { .. }
            | proto::ClientMsg::HistoryCount
            | proto::ClientMsg::GitBranch { .. }
            | proto::ClientMsg::GitBranchCommits { .. }
            | proto::ClientMsg::PrStatus { .. }
            | proto::ClientMsg::PrStatusBatch { .. }
            | proto::ClientMsg::PrCheckLog { .. }
            | proto::ClientMsg::PrDetail { .. }
            | proto::ClientMsg::PrWatchList
            | proto::ClientMsg::MergeQueueGet { .. }
            | proto::ClientMsg::MergeQueueSummaryGet
            | proto::ClientMsg::GitReviewDiffs { .. }
            | proto::ClientMsg::GitBranches { .. }
            | proto::ClientMsg::GitWorktrees { .. }
            | proto::ClientMsg::WorktreeCleanupStatus { .. }
            | proto::ClientMsg::WorktreeIdleRemovalDaysGet
            | proto::ClientMsg::GitCheckpoints { .. }
            | proto::ClientMsg::GitCheckpointDiff { .. }
            | proto::ClientMsg::SshProfileList
            | proto::ClientMsg::SshConfigHosts
            | proto::ClientMsg::SessionPolicyGet
            | proto::ClientMsg::UpdateGet
            | proto::ClientMsg::SlackGet
            | proto::ClientMsg::TaskTrackerSettingsGet { .. }
            | proto::ClientMsg::TaskTrackerLinksGet { .. }
            | proto::ClientMsg::KeymapGet
            | proto::ClientMsg::WaitForIdle { .. }
            | proto::ClientMsg::BrowserRelayRegister { .. }
            | proto::ClientMsg::BrowserToolResult { .. }
            | proto::ClientMsg::InboxList { .. }
            | proto::ClientMsg::DelegationResultsList { .. }
            | proto::ClientMsg::DelegationResultGet { .. }
            | proto::ClientMsg::InstructionQueueList { .. }
            | proto::ClientMsg::InstructionGet { .. }
            | proto::ClientMsg::TaskSnapshot { .. }
            | proto::ClientMsg::TaskGet { .. }
            | proto::ClientMsg::TaskProjectsList { .. }
            | proto::ClientMsg::TaskProjectGet { .. }
            | proto::ClientMsg::TaskDomainGet { .. }
            | proto::ClientMsg::TasksAccessGet { .. }
            | proto::ClientMsg::TaskStartSettingsGet { .. }
            | proto::ClientMsg::TaskReviewSettingsGet { .. }
            | proto::ClientMsg::RemoteGet
            | proto::ClientMsg::WorkspaceActionsGet { .. }
    )
}

// Finite reconnect bursts fit while stalled clients cannot retain arbitrary work.
const CONTROL_REPLY_QUEUE: usize = 256;
const CONTROL_REPLY_BYTES: usize = 8 * 1024 * 1024;
const CONTROL_HANDLERS_PER_CONNECTION: usize = 16;
const CONTROL_HANDLERS_PROCESS: usize = 64;

fn control_handlers() -> &'static Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    LIMIT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(CONTROL_HANDLERS_PROCESS)))
}

fn control_tasks() -> &'static std::sync::Mutex<tokio::task::JoinSet<()>> {
    static TASKS: std::sync::OnceLock<std::sync::Mutex<tokio::task::JoinSet<()>>> =
        std::sync::OnceLock::new();
    TASKS.get_or_init(|| std::sync::Mutex::new(tokio::task::JoinSet::new()))
}

#[cfg(feature = "test-barriers")]
pub struct ControlTestGate {
    pub started: std::sync::atomic::AtomicUsize,
    pub finished: std::sync::atomic::AtomicUsize,
    pub release: tokio::sync::Semaphore,
}

#[cfg(feature = "test-barriers")]
impl Default for ControlTestGate {
    fn default() -> Self {
        Self {
            started: std::sync::atomic::AtomicUsize::new(0),
            finished: std::sync::atomic::AtomicUsize::new(0),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}

#[cfg(feature = "test-barriers")]
type ControlFixture = Option<(std::sync::Weak<Daemon>, Arc<ControlTestGate>)>;
#[cfg(feature = "test-barriers")]
static CONTROL_FIXTURE: std::sync::Mutex<ControlFixture> = std::sync::Mutex::new(None);

#[cfg(feature = "test-barriers")]
#[doc(hidden)]
pub fn active_control_handlers_for_test() -> usize {
    CONTROL_HANDLERS_PROCESS - control_handlers().available_permits()
}

#[cfg(feature = "test-barriers")]
#[doc(hidden)]
pub fn set_control_test(daemon: &Arc<Daemon>, fixture: Arc<ControlTestGate>) {
    *CONTROL_FIXTURE.lock().expect("control fixture lock") =
        Some((Arc::downgrade(daemon), fixture));
}

#[cfg(feature = "test-barriers")]
fn control_fixture(daemon: &Daemon, msg: &proto::ClientMsg) -> Option<Arc<ControlTestGate>> {
    if !matches!(
        msg,
        proto::ClientMsg::SessionList | proto::ClientMsg::WaitForIdle { .. }
    ) {
        return None;
    }
    CONTROL_FIXTURE
        .lock()
        .expect("control fixture lock")
        .as_ref()
        .and_then(|(owner, fixture)| {
            owner
                .upgrade()
                .filter(|owner| std::ptr::eq(owner.as_ref(), daemon))
                .map(|_| Arc::clone(fixture))
        })
}

struct ControlReply {
    message: Message,
    _bytes: tokio::sync::OwnedSemaphorePermit,
}

#[derive(Clone)]
struct ReplySink {
    tx: tokio::sync::mpsc::Sender<ControlReply>,
    bytes: Arc<tokio::sync::Semaphore>,
    failed: Arc<std::sync::atomic::AtomicBool>,
    wake: Arc<Notify>,
}

impl futures_util::Sink<Message> for ReplySink {
    type Error = std::io::Error;

    fn poll_ready(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        let size = match &message {
            Message::Text(text) => text.len(),
            Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
            Message::Close(Some(frame)) => frame.reason.len() + 2,
            Message::Close(None) => 2,
        }
        .max(1);
        let permit = u32::try_from(size)
            .ok()
            .and_then(|size| Arc::clone(&self.bytes).try_acquire_many_owned(size).ok());
        if let Some(permit) = permit {
            if self
                .tx
                .try_send(ControlReply {
                    message,
                    _bytes: permit,
                })
                .is_ok()
            {
                return Ok(());
            }
        }
        self.failed
            .store(true, std::sync::atomic::Ordering::Release);
        self.wake.notify_one();
        Err(std::io::Error::other(format!(
            "control reply limits: {CONTROL_REPLY_QUEUE} items, {CONTROL_REPLY_BYTES} bytes; actual {} items, {} bytes; requested 1 reply of {size} bytes; reconnect to resync",
            CONTROL_REPLY_QUEUE - self.tx.capacity(),
            CONTROL_REPLY_BYTES - self.bytes.available_permits(),
        )))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_close(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.poll_flush(cx)
    }
}

// Attach-family messages are ordered by the connection task because they mutate its
// own `AttachSet`; everything else runs off-task. An awaited handler would hold frame
// flushing and resize acks, leaving the CLI in an 80x24 box, so spawns land via `OnLoop`.
fn runs_on_connection_task(msg: &proto::ClientMsg) -> bool {
    matches!(
        msg,
        proto::ClientMsg::SessionCreate { .. }
            | proto::ClientMsg::SessionRespawn { .. }
            | proto::ClientMsg::SessionWake { .. }
            | proto::ClientMsg::SessionAttach { .. }
            | proto::ClientMsg::SessionVisibility { .. }
    )
}

/// Attach-family requests whose blocking work (a spawn, an attach's copy and encode) runs off
/// the connection loop. The loop edits its frame set and replies when the work lands; requests
/// that depend on it wait here, in socket order, while frames and other replies keep flowing.
#[derive(Default)]
struct OnLoop {
    landing: FuturesUnordered<BoxFuture<'static, Landed>>,
    spawning: bool,
    busy: std::collections::HashSet<u32>,
    deferred: std::collections::VecDeque<Deferred>,
}

struct Deferred {
    text: axum::extract::ws::Utf8Bytes,
    _bytes: tokio::sync::OwnedSemaphorePermit,
    family: bool,
    sessions: Vec<u32>,
}

enum Landed {
    Created {
        request: Option<u32>,
        busy: Vec<u32>,
        result: anyhow::Result<proto::SessionInfo>,
    },
    Spawned {
        session: u32,
        result: anyhow::Result<proto::SessionInfo>,
        context: Option<String>,
    },
    Attached {
        session: u32,
        result: anyhow::Result<AttachReply>,
        context: Option<String>,
    },
}

/// An attach reply prepared off the loop, its payload already base64-encoded.
enum AttachReply {
    Snapshot {
        generation: u32,
        output_offset: u64,
        format_version: u32,
        state: String,
    },
    Replay {
        data: String,
        generation: u32,
        replayed_bytes: u64,
        bytes_seen: u64,
    },
}

// Attaches prepared at once per connection: a startup or grid switch attaches every pane, and
// each holds a replay (up to the ring) plus its base64 copy until it is sent.
const ON_LOOP_IN_FLIGHT: usize = 4;

impl OnLoop {
    fn is_idle(&self) -> bool {
        self.landing.is_empty() && self.deferred.is_empty()
    }

    fn waits(&self, family: bool, sessions: &[u32]) -> bool {
        let full = self.spawning || self.landing.len() >= ON_LOOP_IN_FLIGHT;
        (family && full) || sessions.iter().any(|session| self.busy.contains(session))
    }

    /// Returns the request when it can run now. An attach-family request waits for an in-flight
    /// spawn, and any request naming a busy session — through `session`, `parent`, `child`,
    /// `cwd_from`, `orchestrator_session` or `sessions` — waits behind earlier waiters.
    fn order(
        &mut self,
        text: axum::extract::ws::Utf8Bytes,
        bytes: tokio::sync::OwnedSemaphorePermit,
    ) -> Option<Deferred> {
        let (family, sessions) = if self.is_idle() {
            (false, Vec::new())
        } else {
            classify(&text)
        };
        let behind = self.deferred.iter().any(|earlier| {
            (family && earlier.family)
                || earlier
                    .sessions
                    .iter()
                    .any(|earlier| sessions.contains(earlier))
        });
        let request = Deferred {
            text,
            _bytes: bytes,
            family,
            sessions,
        };
        if behind || self.waits(family, &request.sessions) {
            self.deferred.push_back(request);
            return None;
        }
        Some(request)
    }

    fn next_ready(&mut self) -> Option<Deferred> {
        let front = self.deferred.front()?;
        if self.waits(front.family, &front.sessions) {
            return None;
        }
        self.deferred.pop_front()
    }

    /// Starts a spawn or an attach off the loop, or hands back a request that runs inline.
    fn start(
        &mut self,
        daemon: &Arc<Daemon>,
        msg: proto::ClientMsg,
        context: Option<String>,
        frames_wanted: &mut AttachSet,
    ) -> Option<proto::ClientMsg> {
        let daemon = Arc::clone(daemon);
        let (busy, work): (Vec<u32>, BoxFuture<'static, Landed>) = match msg {
            proto::ClientMsg::SessionAttach {
                session,
                replay_bytes,
                snapshot,
                from_offset,
                generation,
            } => {
                // Tapped before the copy so no output falls between its cutoff and the tap.
                frames_wanted.insert(session);
                frames_wanted.hold(session);
                let task = tokio::task::spawn_blocking(move || {
                    prepare_attach(
                        &daemon,
                        session,
                        replay_bytes,
                        snapshot,
                        from_offset,
                        generation,
                    )
                });
                let work = async move {
                    let result = task
                        .await
                        .unwrap_or_else(|e| Err(anyhow::anyhow!("attach task panicked: {e}")));
                    Landed::Attached {
                        session,
                        result,
                        context,
                    }
                };
                self.busy.insert(session);
                self.landing.push(work.boxed());
                return None;
            }
            proto::ClientMsg::SessionCreate {
                request,
                agent,
                project_dir,
                cmd,
                cols,
                rows,
                cwd_from,
                shell_integration,
                auto_approve,
                acp,
                profile,
                prompt,
                model,
                effort,
            } => {
                let busy: Vec<u32> = cwd_from.iter().copied().collect();
                let params = CreateParams {
                    agent,
                    project_dir: PathBuf::from(project_dir),
                    cmd,
                    cols: cols.unwrap_or(80),
                    rows: rows.unwrap_or(24),
                    cwd_from,
                    shell_integration: shell_integration.unwrap_or(true),
                    auto_approve: auto_approve.unwrap_or(false),
                    acp,
                    profile,
                    prompt,
                    model,
                    effort,
                };
                let task = tokio::task::spawn_blocking(move || daemon.create_session(params));
                let landed_busy = busy.clone();
                let work = async move {
                    let result = task
                        .await
                        .unwrap_or_else(|e| Err(anyhow::anyhow!("create task panicked: {e}")));
                    Landed::Created {
                        request,
                        busy: landed_busy,
                        result,
                    }
                };
                (busy, work.boxed())
            }
            proto::ClientMsg::SessionRespawn {
                session,
                shell_integration,
                cwd,
                shell,
                force,
                fresh,
            } => {
                let conversation = if fresh.unwrap_or(false) {
                    crate::daemon::RespawnConversation::Fresh
                } else {
                    crate::daemon::RespawnConversation::Resume
                };
                let task = tokio::task::spawn_blocking(move || {
                    daemon.respawn_with(
                        session,
                        shell_integration.unwrap_or(true),
                        cwd.map(PathBuf::from),
                        shell,
                        force.unwrap_or(false),
                        conversation,
                    )
                });
                let busy = vec![session];
                let work = async move {
                    let result = task
                        .await
                        .unwrap_or_else(|e| Err(anyhow::anyhow!("respawn task panicked: {e}")));
                    Landed::Spawned {
                        session,
                        result,
                        context,
                    }
                };
                (busy, work.boxed())
            }
            proto::ClientMsg::SessionWake { session } => {
                let task = tokio::task::spawn_blocking(move || daemon.wake_session(session));
                let busy = vec![session];
                let work = async move {
                    let result = task
                        .await
                        .unwrap_or_else(|e| Err(anyhow::anyhow!("Wake task panicked: {e}")));
                    Landed::Spawned {
                        session,
                        result,
                        context,
                    }
                };
                (busy, work.boxed())
            }
            other => return Some(other),
        };
        self.spawning = true;
        self.busy.extend(busy);
        self.landing.push(work);
        None
    }

    /// Taps the new session before replying, so none of its frames precede the reply.
    async fn land(
        &mut self,
        sink: &mut (impl SinkExt<Message> + Unpin),
        frames_wanted: &mut AttachSet,
        landed: Landed,
    ) {
        match landed {
            Landed::Attached {
                session,
                result,
                context,
            } => {
                self.busy.remove(&session);
                land_attach(sink, frames_wanted, session, result, context).await;
            }
            Landed::Created {
                request,
                busy,
                result,
            } => {
                self.spawning = false;
                for session in busy {
                    self.busy.remove(&session);
                }
                if let Ok(info) = &result {
                    frames_wanted.insert(info.id);
                }
                let result = match request {
                    Some(request) => {
                        let (info, error) = match result {
                            Ok(info) => (Some(info), None),
                            Err(error) => (None, Some(format!("{error:#}"))),
                        };
                        let reply = proto::ServerMsg::SessionCreateResult {
                            request,
                            info,
                            error,
                        };
                        send_msg(sink, &reply)
                            .await
                            .map_err(|_| anyhow::anyhow!("sending create result failed"))
                    }
                    None => result.map(|_| ()),
                };
                report(sink, result, None).await;
            }
            Landed::Spawned {
                session,
                result,
                context,
            } => {
                self.spawning = false;
                self.busy.remove(&session);
                let result = result.map(|info| frames_wanted.insert(info.id));
                report(sink, result, context).await;
            }
        }
    }
}

/// Whether a request is attach-family and every session id it names, read only while
/// something is in flight.
fn classify(text: &str) -> (bool, Vec<u32>) {
    #[derive(serde::Deserialize)]
    struct Named {
        #[serde(default)]
        session: Option<serde_json::Value>,
        #[serde(default)]
        parent: Option<serde_json::Value>,
        #[serde(default)]
        child: Option<serde_json::Value>,
        #[serde(default)]
        cwd_from: Option<serde_json::Value>,
        #[serde(default)]
        orchestrator_session: Option<serde_json::Value>,
        #[serde(default)]
        sessions: Vec<serde_json::Value>,
    }
    impl Named {
        fn sessions(self) -> Vec<u32> {
            let mut found = Vec::new();
            for value in [
                self.session,
                self.parent,
                self.child,
                self.cwd_from,
                self.orchestrator_session,
            ]
            .into_iter()
            .flatten()
            .chain(self.sessions)
            {
                if let Some(session) = value.as_u64().and_then(|s| u32::try_from(s).ok()) {
                    if !found.contains(&session) {
                        found.push(session);
                    }
                }
            }
            found
        }
    }
    let family = serde_json::from_str::<proto::ClientMsg>(text)
        .is_ok_and(|msg| runs_on_connection_task(&msg));
    let sessions = serde_json::from_str::<Named>(text)
        .map(Named::sessions)
        .unwrap_or_default();
    (family, sessions)
}

/// Copies and encodes an attach's snapshot or replay; runs on a blocking thread.
fn prepare_attach(
    daemon: &Daemon,
    session: u32,
    replay_bytes: Option<u64>,
    snapshot: Option<bool>,
    from_offset: Option<u64>,
    generation: Option<u32>,
) -> anyhow::Result<AttachReply> {
    let taken = if snapshot == Some(true) {
        daemon
            .attach_snapshot(session)
            .inspect_err(|e| {
                tracing::warn!(
                    "session {session}: no snapshot for this attach ({e}); replying with a byte \
                     replay instead"
                );
            })
            .ok()
    } else {
        None
    };
    if let Some(taken) = taken {
        return Ok(AttachReply::Snapshot {
            generation: taken.generation,
            output_offset: taken.output_offset,
            format_version: taken.format_version,
            state: base64::engine::general_purpose::STANDARD.encode(taken.state),
        });
    }
    let replay = match (from_offset, generation) {
        (Some(offset), Some(generation)) => daemon
            .scrollback_from(session, offset, generation)
            .transpose()
            .unwrap_or_else(|| daemon.scrollback(session, replay_bytes)),
        _ => daemon.scrollback(session, replay_bytes),
    }?;
    Ok(AttachReply::Replay {
        data: base64::engine::general_purpose::STANDARD.encode(replay.data),
        generation: replay.generation,
        replayed_bytes: replay.replayed_bytes,
        bytes_seen: replay.bytes_seen,
    })
}

/// Prunes what the reply covers from the held tap, replies, then lets the tap's frames follow.
async fn land_attach(
    sink: &mut (impl SinkExt<Message> + Unpin),
    frames_wanted: &mut AttachSet,
    session: u32,
    result: anyhow::Result<AttachReply>,
    context: Option<String>,
) {
    frames_wanted.release(session);
    if vanished(&frames_wanted.daemon, session, "attach") {
        frames_wanted.forget(session);
        return;
    }
    let reply = match result {
        Ok(AttachReply::Snapshot {
            generation,
            output_offset,
            format_version,
            state,
        }) => proto::ServerMsg::AttachSnapshot {
            session,
            generation,
            attempt: frames_wanted.attach(session, Some(output_offset)),
            output_offset,
            format_version,
            state,
        },
        Ok(AttachReply::Replay {
            data,
            generation,
            replayed_bytes,
            bytes_seen,
        }) => proto::ServerMsg::Scrollback {
            session,
            data,
            generation,
            replayed_bytes,
            bytes_seen,
            attempt: frames_wanted.attach(session, Some(bytes_seen)),
        },
        Err(e) => {
            frames_wanted.attach(session, None);
            report(sink, Err(e), context).await;
            return;
        }
    };
    let _ = send_msg(sink, &reply).await;
}

#[allow(clippy::too_many_arguments)]
async fn handle_control(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    reply_tx: &ReplySink,
    handlers: &Arc<tokio::sync::Semaphore>,
    text: &str,
    frames_wanted: &mut AttachSet,
    on_loop: &mut OnLoop,
    conn_id: u64,
) {
    let msg: proto::ClientMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            let credential_message = text.contains("credential")
                || serde_json::from_str::<serde_json::Value>(text).is_ok_and(|value| {
                    value
                        .as_object()
                        .is_some_and(|fields| fields.contains_key("token"))
                });
            let (message, context) = if credential_message {
                (
                    "unparseable credential message: check its type and required fields".into(),
                    None,
                )
            } else {
                (
                    format!("unparseable control message: {e}"),
                    Some(text.chars().take(200).collect()),
                )
            };
            send_error(sink, message, context).await;
            return;
        }
    };

    if daemon.refusing_mutations() && !is_read_only_during_shutdown(&msg) {
        let (message, context) = if daemon.is_handing_off() {
            (
                "refused: a handoff to a new daemon generation is in progress".to_string(),
                "handing_off".to_string(),
            )
        } else {
            (
                "refused: daemon is shutting down".to_string(),
                "shutting_down".to_string(),
            )
        };
        send_error(sink, message, Some(context)).await;
        return;
    }

    let context = session_error_context(&msg);
    if runs_on_connection_task(&msg) {
        let Some(msg) = on_loop.start(daemon, msg, context.clone(), frames_wanted) else {
            return;
        };
        let result = dispatch(daemon, sink, msg, Some(frames_wanted), conn_id).await;
        report(sink, result, context).await;
        return;
    }
    let local = Arc::clone(handlers).try_acquire_owned();
    let global = Arc::clone(control_handlers()).try_acquire_owned();
    let (Ok(local), Ok(global)) = (local, global) else {
        let (refused, context) = control_admission_refusal(text);
        send_error(sink, format!(
            "control handler limits: connection {CONTROL_HANDLERS_PER_CONNECTION}, process {CONTROL_HANDLERS_PROCESS}; active connection {}, process {}; refused control request {refused}",
            CONTROL_HANDLERS_PER_CONNECTION - handlers.available_permits(),
            CONTROL_HANDLERS_PROCESS - control_handlers().available_permits(),
        ), Some(context)).await;
        return;
    };
    let daemon = Arc::clone(daemon);
    let mut tx = reply_tx.clone();
    let mut tasks = control_tasks().lock().expect("control task lock");
    while let Some(result) = tasks.try_join_next() {
        if let Err(error) = result {
            tracing::warn!("control handler failed: {error}");
        }
    }
    // Admitted mutations finish even on disconnect. Retain permits through blocking
    // mutations and subprocess cleanup; aborting their async wrapper is not cancellation.
    #[cfg(feature = "test-barriers")]
    let fixture = control_fixture(daemon.as_ref(), &msg);
    tasks.spawn(async move {
        let _permits = (local, global);
        #[cfg(feature = "test-barriers")]
        if let Some(fixture) = fixture {
            fixture
                .started
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = fixture
                .release
                .acquire()
                .await
                .map(|permit| permit.forget());
            fixture
                .finished
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        // Idle waits only observe state; retain admission until they resolve, and
        // release them when their requesting connection can no longer receive replies.
        let result = if matches!(msg, proto::ClientMsg::WaitForIdle { .. }) {
            let connection = tx.tx.clone();
            tokio::select! {
                _ = connection.closed() => return,
                result = dispatch(&daemon, &mut tx, msg, None, conn_id) => result,
            }
        } else {
            dispatch(&daemon, &mut tx, msg, None, conn_id).await
        };
        report(&mut tx, result, context).await;
    });
}

/// Names the refused request for a client that must settle or retry it: its message type and
/// the `dir` or `request` id it carried. The context is `control_admission:<type>[:<dir|request>]`.
fn control_admission_refusal(text: &str) -> (String, String) {
    let fields = serde_json::from_str::<serde_json::Value>(text).ok();
    let field = |name: &str| fields.as_ref().and_then(|value| value.get(name));
    let kind = field("type")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let detail = match (field("dir"), field("request")) {
        (Some(serde_json::Value::String(dir)), _) => Some(("dir", dir.clone())),
        (_, Some(request)) if request.is_number() => Some(("request", request.to_string())),
        _ => None,
    };
    match detail {
        Some((label, value)) => (
            format!("{kind} ({label} {value})"),
            format!("control_admission:{kind}:{value}"),
        ),
        None => (kind.to_string(), format!("control_admission:{kind}")),
    }
}

/// Pane lifecycle requests name their session in an error's `context` (`session:<id>`), so a
/// client can attribute the failure to its pane.
fn session_error_context(msg: &proto::ClientMsg) -> Option<String> {
    match msg {
        proto::ClientMsg::SessionClose { session, .. }
        | proto::ClientMsg::SessionRespawn { session, .. }
        | proto::ClientMsg::SessionWake { session }
        | proto::ClientMsg::SessionAttach { session, .. }
        | proto::ClientMsg::SessionResize { session, .. }
        | proto::ClientMsg::SessionVisibility { session, .. } => Some(format!("session:{session}")),
        _ => None,
    }
}

async fn report(
    sink: &mut (impl SinkExt<Message> + Unpin),
    result: anyhow::Result<()>,
    context: Option<String>,
) {
    if let Err(e) = result {
        let msg = format!("{e:#}");
        tracing::warn!("control request failed: {msg}");
        send_error(sink, msg, context).await;
    }
}

async fn dispatch(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    msg: proto::ClientMsg,
    frames_wanted: Option<&mut AttachSet>,
    conn_id: u64,
) -> anyhow::Result<()> {
    match msg {
        proto::ClientMsg::PrWatchList => match daemon.pr_watch_infos() {
            Ok(watches) => send_msg(sink, &proto::ServerMsg::PrWatchList { watches })
                .await
                .map_err(|_| anyhow::anyhow!("sending PR watch list failed")),
            Err(e) => Err(e),
        },
        proto::ClientMsg::PrWatchUnwatch { session, number } => {
            daemon.pr_watch_stop(session, number).map(|_| ())
        }
        proto::ClientMsg::MergeQueueGet { dir } => {
            let d = Arc::clone(daemon);
            let reply = tokio::task::spawn_blocking(move || d.merge_queue_reply(&dir))
                .await
                .map_err(|e| anyhow::anyhow!("merge queue read panicked: {e}"))?;
            send_msg(sink, &reply)
                .await
                .map_err(|_| anyhow::anyhow!("sending the merge queue failed"))
        }
        proto::ClientMsg::MergeQueueEnqueue {
            dir,
            number,
            depends_on,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || {
                d.merge_queue_enqueue(&at, &number.to_string(), depends_on, None)
                    .map(|entry| {
                        format!(
                            "PR #{number} is number {} in the merge queue",
                            entry.position
                        )
                    })
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue enqueue panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, number, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueueDequeue {
            dir,
            number,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || {
                d.merge_queue_dequeue(&at, &number.to_string())
                    .map(|()| format!("PR #{number} left the merge queue"))
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue dequeue panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, number, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueueMergeHead {
            dir,
            number,
            expected_head_sha,
            method,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || {
                d.merge_queue_merge_head(&at, number, &expected_head_sha, method)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue merge panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, number, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueueSettingsSet {
            dir,
            merge_when_verified,
            verification_command,
            time_limit_minutes,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || {
                d.merge_queue_settings_set(
                    &at,
                    merge_when_verified,
                    &verification_command,
                    time_limit_minutes,
                )
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue settings panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, 0, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueuePause {
            dir,
            paused,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result =
                tokio::task::spawn_blocking(move || d.merge_queue_pause(Some(&at), paused))
                    .await
                    .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue pause panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, 0, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueuePauseAll { paused } => {
            let d = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || d.merge_queue_pause(None, paused))
                .await
                .map_err(|e| anyhow::anyhow!("merge queue pause panicked: {e}"))?
                .map(|_| ())
        }
        proto::ClientMsg::MergeQueueRetry {
            dir,
            number,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || d.merge_queue_retry(&at, number))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue retry panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, number, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueueRevert {
            dir,
            number,
            request,
        } => {
            let d = Arc::clone(daemon);
            let at = dir.clone();
            let result = tokio::task::spawn_blocking(move || d.merge_queue_revert(&at, number))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("merge queue revert panicked: {e}")));
            send_merge_queue_reply(sink, dir, request, number, result).await;
            Ok(())
        }
        proto::ClientMsg::MergeQueueAcknowledge { dir } => {
            let d = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || d.merge_queue_acknowledge(&dir))
                .await
                .map_err(|e| anyhow::anyhow!("merge queue acknowledge panicked: {e}"))?
        }
        proto::ClientMsg::MergeQueueSummaryGet => {
            let d = Arc::clone(daemon);
            let summary = tokio::task::spawn_blocking(move || d.merge_queue_summary())
                .await
                .map_err(|e| anyhow::anyhow!("merge queue summary panicked: {e}"))??;
            send_msg(sink, &summary)
                .await
                .map_err(|_| anyhow::anyhow!("sending the merge queue summary failed"))
        }
        proto::ClientMsg::Hello { .. } => Err(anyhow::anyhow!("already authenticated")),
        proto::ClientMsg::SessionCreate { .. }
        | proto::ClientMsg::SessionRespawn { .. }
        | proto::ClientMsg::SessionWake { .. }
        | proto::ClientMsg::SessionAttach { .. } => Err(anyhow::anyhow!(
            "spawn and attach requests land through the connection loop, not dispatch"
        )),
        proto::ClientMsg::SessionKill {
            session,
            confirm_children,
        } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                daemon.session_kill_checked(session, confirm_children.unwrap_or(false))
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("kill task panicked: {e}")))
        }
        proto::ClientMsg::SessionResize {
            session,
            cols,
            rows,
        } => {
            let resizer = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || resizer.resize(session, cols, rows))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("resize task panicked: {e}")));
            match result {
                Ok((cols, rows)) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::SessionResized {
                            session,
                            cols,
                            rows,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(_) if vanished(daemon, session, "resize") => Ok(()),
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::SessionList => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::SessionList {
                    sessions: daemon.list(),
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::WorkspaceLocalServers { workspace } => {
            let msg = daemon.workspace_local_servers(workspace);
            send_msg(sink, &msg)
                .await
                .map_err(|_| anyhow::anyhow!("sending workspace local servers failed"))
        }
        proto::ClientMsg::SkillSync => {
            let _ = send_msg(sink, &daemon.skill_sync_state()).await;
            Ok(())
        }
        proto::ClientMsg::SkillPush { tool, skill } => {
            daemon.broadcast_control(&daemon.skill_push(tool, skill));
            Ok(())
        }
        proto::ClientMsg::SkillPushUndo { tool, skill } => {
            daemon.broadcast_control(&daemon.skill_push_undo(tool, skill));
            Ok(())
        }
        proto::ClientMsg::SkillAutoPushSet { enabled } => {
            daemon.broadcast_control(&daemon.skill_auto_push_set(enabled));
            Ok(())
        }
        proto::ClientMsg::OrchestrationSettingsGet => {
            let _ = send_msg(sink, &daemon.orchestration_state()).await;
            Ok(())
        }
        proto::ClientMsg::OrchestrationSet { enabled } => {
            let daemon_for_set = Arc::clone(daemon);
            let daemon_for_broadcast = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || daemon_for_set.orchestration_set(enabled))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestration set panicked: {e}")))
                .map(|msg| daemon_for_broadcast.broadcast_control(&msg))
        }
        proto::ClientMsg::HostInfoGet => {
            let _ = send_msg(sink, &daemon.host_info()).await;
            Ok(())
        }
        proto::ClientMsg::StorageReclaim => {
            let d = Arc::clone(daemon);
            let reply = tokio::task::spawn_blocking(move || d.reclaim_storage())
                .await
                .map_err(|e| anyhow::anyhow!("storage reclaim panicked: {e}"))?;
            let reclaimed = matches!(
                reply,
                proto::ServerMsg::StorageReclaimed { refusal: None, .. }
            );
            let _ = send_msg(sink, &reply).await;
            if reclaimed {
                daemon.broadcast_control(&daemon.host_info());
            }
            Ok(())
        }
        proto::ClientMsg::UsageSummaryGet {
            since_ms,
            until_ms,
            refresh_pricing,
            workspace,
        } => {
            let daemon = Arc::clone(daemon);
            match tokio::task::spawn_blocking(move || {
                daemon.usage_summary_filtered(since_ms, until_ms, refresh_pricing, workspace)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("usage scan panicked: {e}")))
            {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                Err(e) => {
                    send_error(
                        sink,
                        format!("{e:#}"),
                        Some(USAGE_SUMMARY_ERROR_CONTEXT.into()),
                    )
                    .await;
                    Ok(())
                }
            }
        }
        proto::ClientMsg::UsageActivitySummaryGet {
            since_ms,
            until_ms,
            workspace,
        } => {
            let daemon = Arc::clone(daemon);
            match tokio::task::spawn_blocking(move || {
                daemon.usage_activity_summary(since_ms, until_ms, workspace)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("usage activity summary panicked: {e}")))
            {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                Err(e) => {
                    send_error(
                        sink,
                        format!("{e:#}"),
                        Some(USAGE_ACTIVITY_ERROR_CONTEXT.into()),
                    )
                    .await;
                    Ok(())
                }
            }
        }
        proto::ClientMsg::RestoreBudgetSet { budget } => daemon
            .set_restore_budget(budget)
            .map(|_| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::RestoreResumeSet { enabled } => daemon
            .set_restore_resume(enabled)
            .map(|_| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::MailboxRetentionSet { hours } => daemon
            .set_mailbox_retention_hours(hours)
            .map(|_| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::WorktreeCleanupSet {
            enabled,
            grace_hours,
        } => daemon
            .set_worktree_cleanup(enabled, grace_hours)
            .map(|()| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::WorktreeCleanupStatus { dir } => {
            let d = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || d.worktree_cleanup_status(&dir))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("worktree cleanup status panicked: {e}")));
            match result {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        // The pass's own broadcast is the reply, so every open dialog sees the result.
        proto::ClientMsg::WorktreeCleanupRun { dir, paths } => {
            let d = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || d.worktree_cleanup_run(&dir, paths))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("worktree cleanup pass panicked: {e}")))
        }
        proto::ClientMsg::WorktreeIdleRemovalDaysGet => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::WorktreeIdleRemovalDays {
                    days: daemon.worktree_idle_removal_days(),
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::WorktreeIdleRemovalDaysSet { days } => daemon
            .set_worktree_idle_removal_days(days)
            .map(|()| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::WorktreeIdleRemove { dir, path } => {
            let d = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || d.worktree_idle_remove(&dir, &path))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("stale worktree removal panicked: {e}")))
        }
        proto::ClientMsg::SettledRetentionSet { hours } => {
            daemon.set_settled_retention_hours(hours)?;
            daemon.broadcast_control(&daemon.host_info());
            Ok(())
        }
        proto::ClientMsg::WorkspaceRoutingGet { workspace } => {
            let routes = daemon.workspace_routing(&workspace)?;
            let _ = send_msg(
                sink,
                &proto::ServerMsg::WorkspaceRouting { workspace, routes },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::WorkspaceRoutingSet { workspace, routes } => {
            daemon.set_workspace_routing(&workspace, &routes)?;
            daemon.broadcast_control(&proto::ServerMsg::WorkspaceRouting { workspace, routes });
            Ok(())
        }
        proto::ClientMsg::WorkspaceActionsGet { workspace } => {
            let actions = daemon.workspace_actions(&workspace)?;
            let _ = send_msg(
                sink,
                &proto::ServerMsg::WorkspaceActions { workspace, actions },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::WorkspaceActionSet { workspace, action } => {
            let msg = daemon.set_workspace_action(&workspace, action)?;
            match msg {
                msg @ proto::ServerMsg::WorkspaceActionRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                }
                msg => daemon.broadcast_control(&msg),
            }
            Ok(())
        }
        proto::ClientMsg::WorkspaceActionDelete { workspace, id } => {
            let msg = daemon.delete_workspace_action(&workspace, &id)?;
            daemon.broadcast_control(&msg);
            Ok(())
        }
        proto::ClientMsg::OrchestrationCapsSet {
            max_live_children,
            max_spawn_depth,
        } => daemon
            .set_orchestration_caps(max_live_children, max_spawn_depth)
            .map(|()| daemon.broadcast_control(&daemon.orchestration_state())),
        proto::ClientMsg::CommandHistoryIgnoreGlobsGet => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::CommandHistoryIgnoreGlobs {
                    globs: daemon.command_history_ignore_globs(),
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::CommandHistoryIgnoreGlobsSet { globs } => daemon
            .set_command_history_ignore_globs(&globs)
            .map(|globs| {
                daemon.broadcast_control(&proto::ServerMsg::CommandHistoryIgnoreGlobs { globs })
            }),
        proto::ClientMsg::McpState => {
            let _ = send_msg(sink, &daemon.mcp_state()).await;
            Ok(())
        }
        proto::ClientMsg::McpSync { tool } => {
            daemon.broadcast_control(&daemon.mcp_sync(tool));
            Ok(())
        }
        proto::ClientMsg::McpImport { tool } => {
            daemon.broadcast_control(&daemon.mcp_import(tool));
            Ok(())
        }
        proto::ClientMsg::McpSetEnabled { name, enabled } => {
            daemon.broadcast_control(&daemon.mcp_set_enabled(&name, enabled));
            Ok(())
        }
        proto::ClientMsg::McpServerUpsert {
            previous_name,
            server,
        } => {
            daemon.broadcast_control(&daemon.mcp_server_upsert(previous_name.as_deref(), server));
            Ok(())
        }
        proto::ClientMsg::McpServerRemove { name } => {
            daemon.broadcast_control(&daemon.mcp_server_remove(&name));
            Ok(())
        }
        proto::ClientMsg::McpTest { name } => {
            daemon.mcp_test(name);
            Ok(())
        }
        proto::ClientMsg::AgentProfileList => {
            let _ = send_msg(sink, &daemon.agent_profile_state()).await;
            Ok(())
        }
        proto::ClientMsg::AgentProfileUpsert {
            id,
            agent,
            name,
            config_dir,
        } => match daemon.agent_profile_upsert(id, agent, &name, &config_dir) {
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::AgentProfileDelete { id } => match daemon.agent_profile_delete(id) {
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::AgentProfileSetActive { agent, id } => {
            match daemon.agent_profile_set_active(agent, id) {
                Ok(msg) => {
                    daemon.broadcast_control(&msg);
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::RoutineList => {
            let _ = send_msg(sink, &daemon.routine_list()).await;
            Ok(())
        }
        proto::ClientMsg::RoutineCreate {
            name,
            prompt,
            cadence,
            workspace_id,
            engine,
            model,
            effort,
            permission_mode,
            isolate,
        } => match daemon.routine_create_full(
            &name,
            &prompt,
            cadence,
            workspace_id,
            engine,
            model,
            effort,
            permission_mode,
            isolate,
        ) {
            Ok(msg @ proto::ServerMsg::RoutineRefused { .. }) => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::RoutineUpdate {
            id,
            expected_revision,
            name,
            prompt,
            cadence,
            enabled,
            workspace_id,
            engine,
            model,
            effort,
            permission_mode,
            isolate,
        } => match daemon.routine_update_full(
            id,
            &expected_revision,
            crate::daemon::RoutinePatch {
                name,
                prompt,
                cadence,
                enabled,
                workspace_id,
                engine,
                model,
                effort,
                permission_mode,
                isolate,
            },
        ) {
            Ok(msg @ proto::ServerMsg::RoutineRefused { .. }) => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::RoutineDelete {
            id,
            expected_revision,
        } => match daemon.routine_delete(id, &expected_revision) {
            Ok(msg @ proto::ServerMsg::RoutineRefused { .. }) => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::RoutineRunNow { id } => match daemon.routine_run_now(id) {
            Ok(msg @ proto::ServerMsg::RoutineRefused { .. }) => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            Ok(msg) => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::RoutineRuns { routine_id } => {
            let _ = send_msg(sink, &daemon.routine_runs_list(routine_id)).await;
            Ok(())
        }
        proto::ClientMsg::HarnessState { workspace } => {
            let msg = daemon.harness_state(&workspace)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::HarnessRoutineCreate {
            workspace,
            engine,
            model,
            effort,
            cadence,
            enabled,
        } => match daemon
            .harness_routine_create(&workspace, engine, model, effort, cadence, enabled)?
        {
            msg @ proto::ServerMsg::RoutineRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::HarnessReport { review_id } => {
            match daemon.harness_report(review_id) {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                }
                Err(error) => {
                    let message = format!("{error:#}");
                    tracing::warn!("control request failed: {message}");
                    send_error(sink, message, Some(format!("harness_report:{review_id}"))).await;
                }
            }
            Ok(())
        }
        proto::ClientMsg::NightShiftCreate { workspace } => {
            let msg = daemon.night_shift_create(&workspace)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::NightShiftState {
            workspace,
            preflight_until_ms,
        } => {
            let msg = daemon.night_shift_state(&workspace, preflight_until_ms)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::NightShiftUpdate {
            routine_id,
            settings,
            expected_revision,
        } => {
            let msg = daemon.night_shift_update(routine_id, settings, &expected_revision)?;
            daemon.broadcast_control(&msg);
            Ok(())
        }
        proto::ClientMsg::NightShiftRunNow {
            routine_id,
            until_ms,
        } => daemon.night_shift_run_now(routine_id, until_ms).map(|_| ()),
        proto::ClientMsg::NightShiftWrapUp { run_id } => daemon.night_shift_wrap_up_now(run_id),
        proto::ClientMsg::NightShiftStop { run_id } => daemon.night_shift_stop_now(run_id),
        proto::ClientMsg::NightShiftDecide { entry_id, choice } => {
            daemon.night_shift_decide(entry_id, &choice)
        }
        proto::ClientMsg::NightShiftQaPassed { entry_id } => daemon.night_shift_qa_passed(entry_id),
        proto::ClientMsg::NightShiftReport { run_id } => {
            match daemon.night_shift_report(run_id) {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                }
                Err(error) => {
                    let message = format!("{error:#}");
                    tracing::warn!("control request failed: {message}");
                    send_error(sink, message, Some(format!("night_shift_report:{run_id}"))).await;
                }
            }
            Ok(())
        }
        proto::ClientMsg::HarnessDecide {
            workspace,
            key,
            state,
        } => daemon.harness_decide(&workspace, &key, state),
        proto::ClientMsg::HarnessFixTask {
            workspace,
            key,
            agent,
            start,
            prompt,
        } => match daemon.harness_fix_task(&workspace, &key, agent, start, prompt.as_deref())? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::HarnessOverviewGet => {
            let _ = send_msg(sink, &daemon.harness_overview()?).await;
            Ok(())
        }
        proto::ClientMsg::HarnessSeen {
            workspace,
            review_id,
        } => daemon.harness_seen(&workspace, review_id),
        proto::ClientMsg::TaskSnapshot { scope } => {
            let msg = daemon.task_snapshot(&scope)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskGet { id } => {
            let msg = daemon.task_get(id)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerSettingsGet { workspace } => {
            let msg = daemon.task_tracker_settings(&workspace)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerSettingsSet { settings } => {
            let msg = daemon.task_tracker_settings_set(*settings).await?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerCredentialSet {
            workspace,
            provider,
            token,
        } => {
            let msg = daemon.task_tracker_credential_set(&workspace, provider, &token)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerCredentialClear {
            workspace,
            provider,
        } => {
            let msg = daemon.task_tracker_credential_clear(&workspace, provider)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerLinksGet { task_id } => {
            let msg = daemon.task_tracker_links(task_id)?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerConflictResolve {
            task_id,
            expected_task_revision,
            expected_project_revision,
            provider,
            external_id,
            field,
            expected_revision,
            resolution,
        } => {
            let msg = daemon.task_tracker_conflict_resolve(
                task_id,
                expected_task_revision,
                expected_project_revision,
                provider,
                &external_id,
                &field,
                expected_revision,
                resolution,
            )?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskTrackerSyncNow { workspace } => {
            let msg = daemon.task_tracker_sync_now(&workspace).await?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::TaskProjectsList { workspace } => {
            let _ = send_msg(sink, &daemon.task_projects_list(&workspace)?).await;
            Ok(())
        }
        proto::ClientMsg::TaskProjectGet { id } => {
            let _ = send_msg(sink, &daemon.task_project_get(id)?).await;
            Ok(())
        }
        proto::ClientMsg::TaskProjectSave {
            workspace,
            id,
            expected_revision,
            name,
            external_url,
            tracker_description,
            local_decisions,
        } => match daemon.task_project_save(
            &workspace,
            id,
            expected_revision,
            &name,
            external_url,
            tracker_description,
            local_decisions,
        )? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskProjectArchive {
            id,
            archived,
            expected_revision,
        } => match daemon.task_project_archive(id, expected_revision, archived)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskDomainGet { id } => {
            let _ = send_msg(sink, &daemon.task_domain_state(id)?).await;
            Ok(())
        }
        proto::ClientMsg::TaskDomainSave {
            id,
            expected_revision,
            kind,
            project_id,
            blocked_by,
        } => match daemon.task_domain_save(id, expected_revision, kind, project_id, blocked_by)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskPlanStart {
            id,
            expected_revision,
            agent,
        } => {
            match daemon.task_plan_start(id, expected_revision, agent)? {
                msg @ proto::ServerMsg::TaskRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                }
                msg => {
                    let _ = send_msg(sink, &msg).await;
                }
            }
            Ok(())
        }
        proto::ClientMsg::TaskPlanAnswer {
            id,
            expected_revision,
            question,
            answer,
        } => match daemon.task_plan_answer(id, expected_revision, &question, &answer)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskPlanApprove {
            id,
            expected_revision,
            plan_revision,
        } => match daemon.task_plan_approve(id, expected_revision, plan_revision)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskSave {
            workspace,
            id,
            expected_revision,
            patch,
        } => match daemon.task_save(
            workspace.as_deref().unwrap_or(""),
            id,
            expected_revision,
            patch,
        )? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskComment { id, body } => match daemon.task_comment(id, &body)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskCheck { id, item, checked } => {
            match daemon.task_check(id, item, checked)? {
                msg @ proto::ServerMsg::TaskRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                msg => {
                    daemon.broadcast_control(&msg);
                    Ok(())
                }
            }
        }
        proto::ClientMsg::TaskArchive {
            id,
            archived,
            expected_revision,
        } => match daemon.task_archive(id, archived, expected_revision)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TasksAccessGet { workspace } => {
            let _ = send_msg(sink, &daemon.tasks_access_state(&workspace)).await;
            Ok(())
        }
        proto::ClientMsg::TasksAccessSet { workspace, access } => {
            match daemon.tasks_access_set(&workspace, access)? {
                msg @ proto::ServerMsg::TaskRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                msg => {
                    daemon.broadcast_control(&msg);
                    Ok(())
                }
            }
        }
        proto::ClientMsg::TaskStartSettingsGet { workspace } => {
            let _ = send_msg(sink, &daemon.tasks_start_settings_state(&workspace)).await;
            Ok(())
        }
        proto::ClientMsg::TaskStartSettingsSet {
            workspace,
            agent,
            delivery,
        } => match daemon.tasks_start_settings_set(&workspace, agent, delivery)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskReviewSettingsGet { workspace } => {
            let _ = send_msg(sink, &daemon.tasks_review_settings_state(&workspace)).await;
            Ok(())
        }
        proto::ClientMsg::TaskReviewSettingsSet {
            workspace,
            reviewer,
            rework_rounds,
        } => match daemon.tasks_review_settings_set(&workspace, reviewer, rework_rounds)? {
            msg @ proto::ServerMsg::TaskRefused { .. } => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            msg => {
                daemon.broadcast_control(&msg);
                Ok(())
            }
        },
        proto::ClientMsg::TaskStart {
            id,
            agent,
            base,
            workspace,
            override_readiness,
        } => {
            let started =
                daemon.task_start_with_override(id, agent, base, workspace, override_readiness)?;
            match started {
                msg @ proto::ServerMsg::TaskRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                }
                msg => daemon.broadcast_control(&msg),
            }
            Ok(())
        }
        proto::ClientMsg::TaskRunControl { run_id, action } => {
            match daemon.task_run_control(run_id, action)? {
                msg @ proto::ServerMsg::TaskRefused { .. } => {
                    let _ = send_msg(sink, &msg).await;
                }
                msg => daemon.broadcast_control(&msg),
            }
            Ok(())
        }
        proto::ClientMsg::TaskQueueRun {
            orchestrator_session,
            count,
            agent,
        } => {
            // The queue's answer is the requester's own: the started tasks each
            // broadcast their own TaskChanged/TaskRunChanged.
            let _ = send_msg(
                sink,
                &daemon.task_queue_run(orchestrator_session, count, agent)?,
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::AgentHooks => {
            let models = Arc::clone(daemon);
            tokio::spawn(async move { models.refresh_model_catalog(false).await });
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                let providers = daemon.agent_hooks_state_rescanned();
                daemon.send_control_to(conn_id, &proto::ServerMsg::AgentHooks { providers });
                daemon.send_control_to(conn_id, &daemon.agent_accounts_state());
            });
            Ok(())
        }
        proto::ClientMsg::AgentHooksSet { provider, enabled } => {
            let providers = daemon.agent_hooks_set(provider, enabled);
            daemon.broadcast_control(&proto::ServerMsg::AgentHooks { providers });
            Ok(())
        }
        proto::ClientMsg::VoiceSettingsGet => {
            let _ = send_msg(sink, &daemon.voice_settings_reply()).await;
            Ok(())
        }
        proto::ClientMsg::VoiceSettingsSet { settings } => {
            match daemon.voice_settings_set(&settings) {
                Ok(()) => {
                    daemon.broadcast_control(&daemon.voice_settings_reply());
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::VoiceKeySet { provider, key } => {
            match daemon.voice_key_set(provider, key) {
                Ok(()) => {
                    daemon.broadcast_control(&daemon.voice_settings_reply());
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::VoiceKeyClear { provider } => match daemon.voice_key_clear(provider) {
            Ok(()) => {
                daemon.broadcast_control(&daemon.voice_settings_reply());
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::VoiceDevicesGet => {
            let devices = daemon.voice_devices();
            let _ = send_msg(sink, &proto::ServerMsg::VoiceDevices { devices }).await;
            Ok(())
        }
        proto::ClientMsg::VoiceStart { session } => {
            daemon.voice_start(session);
            Ok(())
        }
        proto::ClientMsg::VoiceStop { session } => {
            daemon.voice_stop(session).await;
            Ok(())
        }
        proto::ClientMsg::VoiceModelDownload { model_id } => {
            daemon.voice_model_download(model_id);
            Ok(())
        }
        proto::ClientMsg::VoiceModelDelete { model_id } => {
            daemon.broadcast_control(&daemon.voice_model_delete(&model_id)?);
            daemon.broadcast_control(&daemon.voice_settings_reply());
            Ok(())
        }
        proto::ClientMsg::VoiceModelsScan => {
            let reply = daemon.voice_models_scan().await?;
            let _ = send_msg(sink, &reply).await;
            Ok(())
        }
        proto::ClientMsg::VoiceModelReuse {
            model_id,
            path,
            copy,
        } => {
            daemon
                .voice_model_reuse(model_id, std::path::PathBuf::from(path), copy)
                .await
        }
        proto::ClientMsg::VoiceLevelMonitor { enabled } => {
            daemon.voice_level_monitor(conn_id, enabled);
            Ok(())
        }
        proto::ClientMsg::SessionSleep { session } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || daemon.sleep_session(session))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("Sleep task panicked: {e}")))
        }
        proto::ClientMsg::SessionMemoryGet { session } => {
            let daemon = Arc::clone(daemon);
            let (bytes, unavailable_reason) =
                tokio::task::spawn_blocking(move || daemon.session_memory(session))
                    .await
                    .unwrap_or_else(|e| {
                        (None, Some(format!("memory measurement task failed: {e}")))
                    });
            let measured_at_ms = bytes.map(|_| crate::daemon::now_ms());
            let _ = send_msg(
                sink,
                &proto::ServerMsg::SessionMemory {
                    session,
                    bytes,
                    measured_at_ms,
                    unavailable_reason,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::SessionCwd { session } => match daemon.session_cwd(session) {
            Ok(cwd) => {
                let _ = send_msg(sink, &proto::ServerMsg::SessionCwd { session, cwd }).await;
                Ok(())
            }
            Err(_) if vanished(daemon, session, "cwd") => Ok(()),
            Err(e) => Err(e),
        },
        proto::ClientMsg::SessionClose {
            session,
            confirm_children,
        } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                daemon.session_close_checked(session, confirm_children.unwrap_or(false))
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("close task panicked: {e}")))
        }
        proto::ClientMsg::SessionTitleGenerate { session } => daemon.generate_title(session),
        proto::ClientMsg::GeneratedTitlesGet {} => send_msg(
            sink,
            &proto::ServerMsg::GeneratedTitles {
                enabled: daemon.generated_titles_enabled(),
            },
        )
        .await
        .map_err(|_| anyhow::anyhow!("sending generated-title setting failed")),
        proto::ClientMsg::GeneratedTitlesSet { enabled } => daemon.set_generated_titles(enabled),
        proto::ClientMsg::SessionTitleReset { session } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || daemon.reset_title(session))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("title reset task panicked: {e}")))
        }
        proto::ClientMsg::SessionRename { session, title } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || daemon.rename(session, &title))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("rename task panicked: {e}")))
        }
        proto::ClientMsg::SessionReparent {
            session,
            project_dir,
        } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                daemon.reparent_session(session, std::path::Path::new(&project_dir))
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("reparent task panicked: {e}")))
        }
        proto::ClientMsg::SessionSetTags { session, tags } => daemon
            .set_session_tags(session, tags)
            .map_err(|e| e.context("setting session tags")),
        proto::ClientMsg::TagCreate { name, color } => daemon
            .tag_create(&name, &color)
            .map_err(|e| e.context("creating tag")),
        proto::ClientMsg::TagUpdate { tag, name, color } => daemon
            .tag_update(tag, &name, &color)
            .map_err(|e| e.context("updating tag")),
        proto::ClientMsg::TagDelete { tag } => daemon
            .tag_delete(tag)
            .map_err(|e| e.context("deleting tag")),
        proto::ClientMsg::WorkspaceAdd { path } => {
            let daemon_bg = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || daemon_bg.workspace_add(&path))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("workspace add task panicked: {e}")));
            match result {
                Ok(workspaces) => {
                    daemon.broadcast_control(&proto::ServerMsg::WorkspaceList { workspaces });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::WorkspaceRemove { path } => {
            let daemon_bg = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || daemon_bg.workspace_remove(&path))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("workspace remove task panicked: {e}")));
            match result {
                Ok(workspaces) => {
                    daemon.broadcast_control(&proto::ServerMsg::WorkspaceList { workspaces });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::WorkspaceRename { path, name } => {
            let daemon_bg = Arc::clone(daemon);
            let result =
                tokio::task::spawn_blocking(move || daemon_bg.workspace_rename(&path, &name))
                    .await
                    .unwrap_or_else(|e| {
                        Err(anyhow::anyhow!("workspace rename task panicked: {e}"))
                    });
            match result {
                Ok(workspaces) => {
                    daemon.broadcast_control(&proto::ServerMsg::WorkspaceList { workspaces });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::WorkspaceList => {
            let workspaces = daemon.workspace_list().unwrap_or_default();
            let _ = send_msg(sink, &proto::ServerMsg::WorkspaceList { workspaces }).await;
            Ok(())
        }
        proto::ClientMsg::DelegationResultsList {
            parent,
            before_message_id,
        } => {
            let daemon = Arc::clone(daemon);
            let msg = tokio::task::spawn_blocking(move || {
                daemon.delegation_results_page(parent, before_message_id)
            })
            .await
            .map_err(|e| anyhow::anyhow!("result lookup task panicked: {e}"))??;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::DelegationResultGet { parent, message_id } => {
            let daemon = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || {
                daemon.delegation_result_get(parent, message_id)
            })
            .await
            .map_err(|error| anyhow::anyhow!("result detail task panicked: {error}"))?;
            let msg = result.unwrap_or_else(|error| proto::ServerMsg::DelegationResultRefused {
                parent,
                message_id,
                message: error.to_string(),
            });
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::InstructionQueueList { session } => {
            let daemon = Arc::clone(daemon);
            let result =
                tokio::task::spawn_blocking(move || daemon.instruction_queue(None, session))
                    .await
                    .map_err(|error| anyhow::anyhow!("instruction queue task panicked: {error}"))?;
            let msg = match result {
                Ok(snapshot) => proto::ServerMsg::InstructionQueue { snapshot },
                Err(error) => proto::ServerMsg::InstructionRefused {
                    session,
                    instruction_id: None,
                    message: error.to_string(),
                },
            };
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::InstructionGet {
            session,
            instruction_id,
        } => {
            let daemon = Arc::clone(daemon);
            let id = instruction_id.clone();
            let result =
                tokio::task::spawn_blocking(move || daemon.instruction_get(None, session, &id))
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!("instruction detail task panicked: {error}")
                    })?;
            let msg = match result {
                Ok(detail) => proto::ServerMsg::InstructionDetail { detail },
                Err(error) => proto::ServerMsg::InstructionRefused {
                    session,
                    instruction_id: Some(instruction_id),
                    message: error.to_string(),
                },
            };
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::InstructionCancel {
            session,
            instruction_id,
        } => {
            let daemon = Arc::clone(daemon);
            let id = instruction_id.clone();
            let result =
                tokio::task::spawn_blocking(move || daemon.instruction_cancel(None, session, &id))
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!("instruction cancellation task panicked: {error}")
                    })?;
            let msg = match result {
                Ok(snapshot) => proto::ServerMsg::InstructionQueue { snapshot },
                Err(error) => proto::ServerMsg::InstructionRefused {
                    session,
                    instruction_id: Some(instruction_id),
                    message: error.to_string(),
                },
            };
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::InstructionResume {
            session,
            instruction_id,
        } => {
            let daemon = Arc::clone(daemon);
            let id = instruction_id.clone();
            let result =
                tokio::task::spawn_blocking(move || daemon.instruction_resume(None, session, &id))
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!("instruction resumption task panicked: {error}")
                    })?;
            let msg = match result {
                Ok(snapshot) => proto::ServerMsg::InstructionQueue { snapshot },
                Err(error) => proto::ServerMsg::InstructionRefused {
                    session,
                    instruction_id: Some(instruction_id),
                    message: error.to_string(),
                },
            };
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::InboxList { workspace } => match daemon.inbox_list(&workspace) {
            Ok(msg) => {
                let _ = send_msg(sink, &msg).await;
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::InboxAck { id } => match daemon.inbox_ack(id) {
            Ok(row) => {
                daemon.broadcast_control(&proto::ServerMsg::InboxChanged {
                    workspace: row.workspace.clone(),
                    row,
                });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::InboxResolve { id } => match daemon.inbox_resolve(id) {
            Ok(row) => {
                daemon.broadcast_control(&proto::ServerMsg::InboxChanged {
                    workspace: row.workspace.clone(),
                    row,
                });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::ChildInputResolve { child, id } => daemon.child_input_resolve(child, &id),
        proto::ClientMsg::InboxDeliverNow { session } => daemon.inbox_deliver_now(session),
        proto::ClientMsg::GitStatus { dir, base } => send_git_status(sink, dir, base).await,
        proto::ClientMsg::GitDiff { dir, path, base } => {
            let d = PathBuf::from(&dir);
            let p = path.clone();
            let b = base.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::git::diff(&d, p.as_deref(), b.as_deref())
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("git diff task panicked: {e}")));
            match result {
                Ok(diff) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitDiff {
                            dir,
                            path,
                            patch: diff.patch,
                            truncated: diff.truncated,
                            base,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::HandoffGenerate {
            session,
            provider,
            cmd,
        } => {
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || daemon.handoff_generate(session, provider, cmd))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("handoff task panicked: {e}")))
                .map(|_| ())
        }
        proto::ClientMsg::HandoffCancel { request } => daemon.handoff_cancel(request),
        proto::ClientMsg::HistoryClear { workspace } => daemon
            .history_clear(workspace.as_deref())
            .map(|n| tracing::info!("cleared {n} command-history row(s)")),
        proto::ClientMsg::HistoryCount => match daemon.history_count() {
            Ok(count) => {
                let _ = send_msg(sink, &proto::ServerMsg::HistoryCount { count }).await;
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::GitBranch { dir } => {
            let d = PathBuf::from(&dir);
            let facts = tokio::task::spawn_blocking(move || crate::git::checkout_facts(&d))
                .await
                .unwrap_or_default();
            let _ = send_msg(
                sink,
                &proto::ServerMsg::GitBranch {
                    dir,
                    branch: facts.branch,
                    toplevel: facts.toplevel,
                    common_dir: facts.common_dir,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::GitBranchCommits { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::branch_commits(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git branch commits task panicked: {e}")));
            match result {
                Ok((commits, total, truncated)) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitBranchCommits {
                            dir,
                            commits,
                            total,
                            truncated,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitStage { dir, paths } => {
            let d = PathBuf::from(&dir);
            match tokio::task::spawn_blocking(move || crate::git::stage(&d, &paths))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git stage task panicked: {e}")))
            {
                Ok(()) => send_git_status(sink, dir, None).await,
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitUnstage { dir, paths } => {
            let d = PathBuf::from(&dir);
            match tokio::task::spawn_blocking(move || crate::git::unstage(&d, &paths))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git unstage task panicked: {e}")))
            {
                Ok(()) => send_git_status(sink, dir, None).await,
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCommit {
            dir,
            message,
            amend,
        } => {
            let d = PathBuf::from(&dir);
            match tokio::task::spawn_blocking(move || crate::git::commit(&d, &message, amend))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git commit task panicked: {e}")))
            {
                Ok(res) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitCommit {
                            dir: dir.clone(),
                            sha: res.sha,
                            summary: res.summary,
                        },
                    )
                    .await;
                    send_git_status(sink, dir, None).await
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitPush { dir } => {
            let d = PathBuf::from(&dir);
            match tokio::task::spawn_blocking(move || crate::git::push(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git push task panicked: {e}")))
            {
                Ok(summary) => {
                    tracing::info!("git push in {dir}: {summary}");
                    send_git_status(sink, dir, None).await
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitDiscard { dir, path, kind } => {
            let d = PathBuf::from(&dir);
            let p = path.clone();
            match tokio::task::spawn_blocking(move || crate::git::discard(&d, &p, kind))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git discard task panicked: {e}")))
            {
                Ok(()) => send_git_status(sink, dir, None).await,
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::PrStatus { dir } => {
            let d = PathBuf::from(&dir);
            let st = tokio::task::spawn_blocking(move || crate::gh::pr_status_cached(&d))
                .await
                .unwrap_or_else(|e| {
                    tracing::error!("pr_status: spawn_blocking join failed for {dir:?}: {e}");
                    crate::gh::PrStatus {
                        gh: proto::GhState::Missing,
                        has_upstream: false,
                        pr: None,
                        hint: Some(crate::gh::MISSING_HINT.to_string()),
                    }
                });
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrStatus {
                    dir,
                    gh: st.gh,
                    has_upstream: st.has_upstream,
                    pr: st.pr,
                    hint: st.hint,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrStatusBatch { dirs } => {
            check_pr_status_batch_size(dirs.len())?;
            let requested = dirs.len();
            let paths: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
            let statuses = tokio::task::spawn_blocking(move || {
                paths
                    .iter()
                    .map(|path| crate::gh::pr_status_cached(path))
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_else(|e| {
                tracing::error!("pr_status batch: spawn_blocking join failed: {e}");
                (0..requested)
                    .map(|_| crate::gh::PrStatus {
                        gh: proto::GhState::Missing,
                        has_upstream: false,
                        pr: None,
                        hint: Some(crate::gh::MISSING_HINT.to_string()),
                    })
                    .collect()
            });
            for (dir, st) in dirs.into_iter().zip(statuses) {
                let _ = send_msg(
                    sink,
                    &proto::ServerMsg::PrStatus {
                        dir,
                        gh: st.gh,
                        has_upstream: st.has_upstream,
                        pr: st.pr,
                        hint: st.hint,
                    },
                )
                .await;
            }
            Ok(())
        }
        proto::ClientMsg::PrCheckLog { dir, run_id } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::gh::pr_check_log(&d, run_id))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("check log task panicked: {e}")));
            let (lines, truncated, available) = match result {
                Ok(log) => (log.lines, log.truncated, log.available),
                Err(e) => {
                    tracing::warn!("pr_check_log in {dir}: {e:#}");
                    (Vec::new(), false, false)
                }
            };
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrCheckLog {
                    dir,
                    run_id,
                    lines,
                    truncated,
                    available,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrCreate { dir, title, body } => {
            let d = PathBuf::from(&dir);
            let res = tokio::task::spawn_blocking(move || {
                crate::gh::pr_create(&d, title.as_deref(), body.as_deref())
            })
            .await
            .unwrap_or_else(|e| crate::gh::PrCreate {
                gh: proto::GhState::Ready,
                pr: None,
                message: Some(format!("gh pr create task panicked: {e}")),
            });
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrCreate {
                    dir,
                    gh: res.gh,
                    pr: res.pr,
                    message: res.message,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrDetail {
            dir,
            request,
            number,
        } => {
            send_pr_detail(daemon, sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrLink {
            dir,
            number,
            request,
        } => {
            link_pull_request(daemon, sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrUnlink { dir, request } => {
            unlink_pull_request(daemon, sink, dir, request).await;
            Ok(())
        }
        proto::ClientMsg::PrMerge {
            dir,
            number,
            method,
            expected_head_sha,
            request,
        } => {
            merge_pull_request(
                daemon,
                sink,
                dir,
                number,
                method,
                expected_head_sha,
                request,
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrAction {
            dir,
            number,
            action,
            merge_method,
            update_method,
            request,
        } => {
            pr_action(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                action,
                merge_method,
                update_method,
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrEdit {
            dir,
            number,
            title,
            body,
            request,
        } => {
            pr_edit(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                title,
                body,
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrComment {
            dir,
            number,
            body,
            request,
        } => {
            let target = PrWriteTarget {
                dir,
                number,
                request,
            };
            if let Some(refusal) = crate::gh::body_refusal(&body) {
                send_pr_mutation(
                    sink,
                    &target,
                    proto::PrMutationKind::Comment,
                    false,
                    Some(refusal),
                )
                .await;
                return Ok(());
            }
            run_pr_write(
                daemon,
                sink,
                target,
                proto::PrMutationKind::Comment,
                move |d, _| Ok(crate::gh::pr_comment(&d, number, &body)),
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrCommentEdit {
            dir,
            number,
            comment_id,
            kind,
            body,
            request,
        } => {
            let target = PrWriteTarget {
                dir,
                number,
                request,
            };
            if let Some(refusal) = crate::gh::body_refusal(&body) {
                send_pr_mutation(
                    sink,
                    &target,
                    proto::PrMutationKind::CommentEdit,
                    false,
                    Some(refusal),
                )
                .await;
                return Ok(());
            }
            run_pr_write(
                daemon,
                sink,
                target,
                proto::PrMutationKind::CommentEdit,
                move |d, _| Ok(crate::gh::pr_comment_edit(&d, &comment_id, kind, &body)),
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrReview {
            dir,
            number,
            verdict,
            body,
            comments,
            request,
        } => {
            pr_review(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                verdict,
                body,
                comments,
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrThreadReply {
            dir,
            number,
            thread_id,
            body,
            request,
        } => {
            let target = PrWriteTarget {
                dir,
                number,
                request,
            };
            if let Some(refusal) = crate::gh::body_refusal(&body) {
                send_pr_mutation(
                    sink,
                    &target,
                    proto::PrMutationKind::ThreadReply,
                    false,
                    Some(refusal),
                )
                .await;
                return Ok(());
            }
            run_pr_write(
                daemon,
                sink,
                target,
                proto::PrMutationKind::ThreadReply,
                move |d, _| Ok(crate::gh::pr_thread_reply(&d, &thread_id, &body)),
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrThreadResolve {
            dir,
            number,
            thread_id,
            resolved,
            request,
        } => {
            run_pr_write(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                proto::PrMutationKind::ThreadResolve,
                move |d, stored| {
                    let (link, _detail) = read_target(&d, number, stored.as_ref())?;
                    let repository = crate::pull_requests::repository_for(&d, &link)?;
                    crate::pull_requests::require_access(
                        &d,
                        &repository,
                        number,
                        crate::pull_requests::PrNeed::Resolve,
                        None,
                    )?;
                    Ok(crate::gh::pr_thread_resolve(&d, &thread_id, resolved))
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrReaction {
            dir,
            number,
            subject_id,
            content,
            reacted,
            request,
        } => {
            run_pr_write(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                proto::PrMutationKind::Reaction,
                move |d, stored| {
                    let (link, _detail) = read_target(&d, number, stored.as_ref())?;
                    let repository = crate::pull_requests::repository_for(&d, &link)?;
                    Ok(crate::gh::pr_reaction(
                        &d,
                        number,
                        &repository,
                        subject_id.as_deref(),
                        content,
                        reacted,
                    ))
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrReviewers {
            dir,
            number,
            request,
        } => {
            send_pr_reviewer_candidates(daemon, sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrReviewerSet {
            dir,
            number,
            reviewers,
            requested,
            request,
        } => {
            run_pr_write(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                proto::PrMutationKind::ReviewerSet,
                move |d, stored| {
                    let (link, _detail) = read_target(&d, number, stored.as_ref())?;
                    let repository = crate::pull_requests::repository_for(&d, &link)?;
                    crate::pull_requests::require_access(
                        &d,
                        &repository,
                        number,
                        crate::pull_requests::PrNeed::Write,
                        None,
                    )?;
                    Ok(crate::gh::pr_reviewer_set(
                        &d, number, &reviewers, requested,
                    ))
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrLabels {
            dir,
            number,
            request,
        } => {
            send_pr_label_candidates(daemon, sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrLabelSet {
            dir,
            number,
            labels,
            applied,
            request,
        } => {
            run_pr_write(
                daemon,
                sink,
                PrWriteTarget {
                    dir,
                    number,
                    request,
                },
                proto::PrMutationKind::LabelSet,
                move |d, stored| {
                    let (link, _detail) = read_target(&d, number, stored.as_ref())?;
                    let repository = crate::pull_requests::repository_for(&d, &link)?;
                    crate::pull_requests::require_access(
                        &d,
                        &repository,
                        number,
                        crate::pull_requests::PrNeed::Triage,
                        None,
                    )?;
                    Ok(crate::gh::pr_label_set(&d, number, &labels, applied))
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::PrList {
            dir,
            state,
            involvement,
            query,
            limit,
            sort,
            request,
        } => {
            send_pr_list(sink, dir, state, involvement, query, limit, sort, request).await;
            Ok(())
        }
        proto::ClientMsg::PrDiff {
            dir,
            number,
            request,
        } => {
            send_pr_diff(sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrStack {
            dir,
            number,
            request,
        } => {
            send_pr_stack(sink, dir, number, request).await;
            Ok(())
        }
        proto::ClientMsg::PrStackMerge {
            dir,
            number,
            stack_number,
            heads,
            merge_method,
            request,
        } => {
            pr_stack_merge(
                daemon,
                sink,
                PrStackMergeRequest {
                    dir,
                    number,
                    stack_number,
                    heads,
                    merge_method,
                    request,
                },
            )
            .await;
            Ok(())
        }
        proto::ClientMsg::GitReviewDiffs { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::review_diffs(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git review diffs task panicked: {e}")));
            match result {
                Ok(bundle) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitReviewDiffs {
                            dir,
                            branch: bundle.branch,
                            upstream: bundle.upstream,
                            ahead: bundle.ahead,
                            behind: bundle.behind,
                            head: bundle.head,
                            files: bundle.files,
                            sections: bundle.sections,
                            blocked_paths: bundle.blocked_paths,
                            warnings: bundle.warnings,
                            truncated: bundle.truncated,
                            redacted: bundle.redacted,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitBranches { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::list_branches(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git branches task panicked: {e}")));
            match result {
                Ok(list) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitBranches {
                            dir,
                            branches: list.branches.into_iter().map(branch_info).collect(),
                            remotes: list.remotes.into_iter().map(branch_info).collect(),
                            default_branch: list.default_branch,
                            truncated: list.truncated,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitWorktrees { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || {
                let list = crate::worktrees::list(&d)?;
                Ok::<_, anyhow::Error>(
                    list.into_iter()
                        .map(|wt| {
                            let dirty = !wt.is_bare
                                && wt.path.is_dir()
                                && crate::worktrees::is_dirty(&wt.path);
                            proto::GitWorktreeInfo {
                                path: wt.path.display().to_string(),
                                branch: wt.branch,
                                head: wt.head,
                                is_main: wt.is_main,
                                is_detached: wt.is_detached,
                                is_bare: wt.is_bare,
                                dirty,
                            }
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("git worktrees task panicked: {e}")));
            match result {
                Ok(worktrees) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitWorktrees {
                            dir,
                            worktrees,
                            message: None,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCheckpoints { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::checkpoints::list(&d, None))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git checkpoints task panicked: {e}")));
            match result {
                Ok(list) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitCheckpoints {
                            dir,
                            checkpoints: list.into_iter().map(checkpoint_info).collect(),
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCheckpointDiff {
            dir,
            r#ref,
            against,
        } => {
            let d = PathBuf::from(&dir);
            let against = match against {
                proto::GitCheckpointAgainst::Working => {
                    crate::checkpoints::CheckpointAgainst::Working
                }
                proto::GitCheckpointAgainst::Head => crate::checkpoints::CheckpointAgainst::Head,
            };
            let r = r#ref.clone();
            let result =
                tokio::task::spawn_blocking(move || crate::checkpoints::diff(&d, &r, against))
                    .await
                    .unwrap_or_else(|e| Err(anyhow::anyhow!("checkpoint diff task panicked: {e}")));
            match result {
                Ok((patch, truncated, redacted)) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitCheckpointDiff {
                            dir,
                            r#ref,
                            patch,
                            truncated,
                            redacted,
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitPull { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::pull(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git pull task panicked: {e}")));
            match result {
                Ok(outcome) => {
                    let status = match outcome.status {
                        crate::git::PullStatus::Pulled => proto::GitPullStatus::Pulled,
                        crate::git::PullStatus::UpToDate => proto::GitPullStatus::UpToDate,
                    };
                    let _ = send_msg(sink, &proto::ServerMsg::GitPull { dir, status }).await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitFetch { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::fetch(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git fetch task panicked: {e}")));
            match result {
                Ok(summary) => {
                    let _ = send_msg(sink, &proto::ServerMsg::GitFetch { dir, summary }).await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitBranchCreate {
            dir,
            name,
            base,
            switch_to,
        } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || {
                crate::git::create_branch(&d, &name, base.as_deref(), switch_to)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("git branch create task panicked: {e}")));
            match result {
                Ok(_) => {
                    send_refreshed_branches(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitBranchSwitch { dir, name } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::git::switch_branch(&d, &name))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git branch switch task panicked: {e}")));
            match result {
                Ok(_) => {
                    send_refreshed_branches(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitBranchRename { dir, from, to } => {
            let d = PathBuf::from(&dir);
            let result =
                tokio::task::spawn_blocking(move || crate::git::rename_branch(&d, &from, &to))
                    .await
                    .unwrap_or_else(|e| {
                        Err(anyhow::anyhow!("git branch rename task panicked: {e}"))
                    });
            match result {
                Ok(_) => {
                    send_refreshed_branches(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitBranchDelete { dir, name, force } => {
            let d = PathBuf::from(&dir);
            let result =
                tokio::task::spawn_blocking(move || crate::git::delete_branch(&d, &name, force))
                    .await
                    .unwrap_or_else(|e| {
                        Err(anyhow::anyhow!("git branch delete task panicked: {e}"))
                    });
            match result {
                Ok(()) => {
                    send_refreshed_branches(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitWorktreeCreate { dir, name, base } => {
            let d = PathBuf::from(&dir);
            let daemon = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || {
                daemon.git_worktree_create(&d, &name, base.as_deref())
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("git worktree create task panicked: {e}")));
            match result {
                Ok((wt, include_warnings)) => {
                    let mut message = format!(
                        "Created worktree at {} (branch {}).",
                        wt.path.display(),
                        wt.branch.as_deref().unwrap_or("detached")
                    );
                    for warning in include_warnings {
                        message.push(' ');
                        message.push_str(&warning);
                    }
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitWorktrees {
                            dir,
                            worktrees: Vec::new(),
                            message: Some(message),
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitWorktreeRemove { dir, path, force } => {
            let d = PathBuf::from(&dir);
            let wt = PathBuf::from(&path);
            let daemon = Arc::clone(daemon);
            let result =
                tokio::task::spawn_blocking(move || daemon.git_worktree_remove(&d, &wt, force))
                    .await
                    .unwrap_or_else(|e| {
                        Err(anyhow::anyhow!("git worktree remove task panicked: {e}"))
                    });
            match result {
                Ok(()) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitWorktrees {
                            dir,
                            worktrees: Vec::new(),
                            message: Some(format!("Removed worktree {path}.")),
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitWorktreePrune { dir } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || crate::worktrees::prune(&d))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("git worktree prune task panicked: {e}")));
            match result {
                Ok(summary) => {
                    let message = if summary.trim().is_empty() {
                        "Nothing to prune.".to_string()
                    } else {
                        summary
                    };
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitWorktrees {
                            dir,
                            worktrees: Vec::new(),
                            message: Some(message),
                        },
                    )
                    .await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCheckpointCreate { dir, label } => {
            let d = PathBuf::from(&dir);
            let result = tokio::task::spawn_blocking(move || {
                crate::checkpoints::capture_unique(&d, CHECKPOINT_OWNER, &label)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("checkpoint create task panicked: {e}")));
            match result {
                Ok(_) => {
                    send_checkpoints(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCheckpointRestore { dir, r#ref } => {
            let d = PathBuf::from(&dir);
            let r = r#ref.clone();
            let result =
                tokio::task::spawn_blocking(move || crate::checkpoints::revert_ref(&d, &r))
                    .await
                    .unwrap_or_else(|e| {
                        Err(anyhow::anyhow!("checkpoint restore task panicked: {e}"))
                    });
            match result {
                Ok(()) => {
                    send_checkpoints(sink, &dir).await?;
                    send_git_status(sink, dir, None).await
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::GitCheckpointDelete { dir, r#ref } => {
            let d = PathBuf::from(&dir);
            let r = r#ref.clone();
            let result = tokio::task::spawn_blocking(move || crate::checkpoints::delete(&d, &r))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("checkpoint delete task panicked: {e}")));
            match result {
                Ok(()) => {
                    send_checkpoints(sink, &dir).await?;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::SshConnect {
            request,
            host,
            port,
            user,
            auth,
            cols,
            rows,
            profile,
            default_dir,
        } => {
            let mut params = crate::ssh::SshParams {
                host,
                port: port.unwrap_or(22),
                user,
                auth,
                cols: cols.unwrap_or(80),
                rows: rows.unwrap_or(24),
                config_identity: None,
                default_dir,
            };
            crate::ssh::apply_ssh_config(&mut params);
            daemon.ssh_connect(request, params, profile);
            Ok(())
        }
        proto::ClientMsg::SshHostKeyAnswer { request, accept } => {
            daemon.ssh_host_key_answer(request, accept)
        }
        proto::ClientMsg::SshUploadTerminalFile {
            request,
            session,
            local_path,
            remote_name,
        } => daemon.ssh_upload_terminal_file(request, session, local_path, remote_name),
        proto::ClientMsg::SshProfileSave { profile } => match daemon.ssh_profile_save(&profile) {
            Ok(profiles) => {
                daemon.broadcast_control(&proto::ServerMsg::SshProfiles {
                    profiles,
                    keyring_error: crate::ssh_credentials::keyring_error(daemon.state_dir()),
                });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::SshProfileDelete { name } => match daemon.ssh_profile_delete(&name) {
            Ok(profiles) => {
                daemon.broadcast_control(&proto::ServerMsg::SshProfiles {
                    profiles,
                    keyring_error: crate::ssh_credentials::keyring_error(daemon.state_dir()),
                });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::SshProfileList => match daemon.ssh_profiles() {
            Ok(profiles) => {
                let _ = send_msg(
                    sink,
                    &proto::ServerMsg::SshProfiles {
                        profiles,
                        keyring_error: crate::ssh_credentials::keyring_error(daemon.state_dir()),
                    },
                )
                .await;
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::SshCredentialSet { profile, password } => {
            match daemon.ssh_credential_set(&profile, crate::ssh_credentials::Secret::new(password))
            {
                Ok(profiles) => {
                    daemon.broadcast_control(&proto::ServerMsg::SshProfiles {
                        profiles,
                        keyring_error: crate::ssh_credentials::keyring_error(daemon.state_dir()),
                    });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::SshCredentialClear { profile } => {
            match daemon.ssh_credential_clear(&profile) {
                Ok(profiles) => {
                    daemon.broadcast_control(&proto::ServerMsg::SshProfiles {
                        profiles,
                        keyring_error: crate::ssh_credentials::keyring_error(daemon.state_dir()),
                    });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::SshConfigHosts => match daemon.ssh_config_hosts() {
            Ok(hosts) => {
                let _ = send_msg(sink, &proto::ServerMsg::SshConfigHosts { hosts }).await;
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::SessionCwds { sessions } => {
            let entries = daemon.session_cwds(&sessions);
            let _ = send_msg(sink, &proto::ServerMsg::SessionCwds { entries }).await;
            Ok(())
        }
        proto::ClientMsg::SessionRunningProcs { sessions } => {
            let entries = daemon.session_running_procs(&sessions);
            let _ = send_msg(sink, &proto::ServerMsg::SessionRunningProcs { entries }).await;
            Ok(())
        }
        proto::ClientMsg::SessionVisibility { session, visible } => {
            let frames_wanted =
                frames_wanted.expect("an attach-family message runs on the connection task");
            if !daemon.has_session(session) {
                // Pane mount and cleanup can race removal; discard connection state without
                // recreating a visibility vote for a session that no longer exists.
                tracing::debug!("visibility {visible} for unknown session {session} ignored");
                frames_wanted.forget(session);
                daemon.conn_set_visibility(conn_id, session, true);
                return Ok(());
            }
            if visible {
                frames_wanted.insert(session);
            } else {
                frames_wanted.remove(session);
            }
            daemon.conn_set_visibility(conn_id, session, visible);
            Ok(())
        }
        proto::ClientMsg::WaitForIdle {
            request,
            session,
            timeout_ms,
            idle_quiet_ms,
        } => {
            daemon
                .wait_for_idle(request, session, timeout_ms, idle_quiet_ms)
                .await
        }
        proto::ClientMsg::SessionPolicyGet => {
            let policy = daemon.session_policy();
            let _ = send_msg(sink, &proto::ServerMsg::SessionPolicy { policy }).await;
            Ok(())
        }
        proto::ClientMsg::SessionPolicySet { policy } => match daemon.session_policy_set(policy) {
            Ok(policy) => {
                daemon.broadcast_control(&proto::ServerMsg::SessionPolicy { policy });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::UpdateGet => {
            let _ = send_msg(sink, &daemon.update_snapshot()).await;
            Ok(())
        }
        proto::ClientMsg::UpdatePolicySet { policy } => {
            daemon.update_policy_set(policy)?;
            daemon.broadcast_control(&daemon.update_snapshot());
            Ok(())
        }
        proto::ClientMsg::UpdateCheckNow => {
            daemon.update_wake.notify_one();
            Ok(())
        }
        proto::ClientMsg::SlackGet => {
            let d = daemon.clone();
            let msg = tokio::task::spawn_blocking(move || d.slack_state_msg(None)).await?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::SlackConnect {
            app_token,
            bot_token,
        } => {
            let d = daemon.clone();
            let msg = tokio::task::spawn_blocking(move || {
                d.slack_connect(app_token.as_deref(), bot_token.as_deref())
            })
            .await?;
            slack_reply(daemon, sink, msg).await;
            Ok(())
        }
        proto::ClientMsg::SlackDisconnect => {
            let d = daemon.clone();
            let msg = tokio::task::spawn_blocking(move || d.slack_disconnect()).await?;
            slack_reply(daemon, sink, msg).await;
            Ok(())
        }
        proto::ClientMsg::SlackConfigure {
            owner_user_id,
            channels,
            language,
        } => {
            let d = daemon.clone();
            let msg = tokio::task::spawn_blocking(move || {
                d.slack_configure(owner_user_id.as_deref(), &channels, language)
            })
            .await?;
            slack_reply(daemon, sink, msg).await;
            Ok(())
        }
        proto::ClientMsg::KeymapGet => {
            let overrides = daemon.keymap_overrides();
            let _ = send_msg(sink, &proto::ServerMsg::Keymap { overrides }).await;
            Ok(())
        }
        proto::ClientMsg::KeymapSet { overrides } => {
            match daemon.keymap_overrides_set(&overrides) {
                Ok(()) => {
                    daemon.broadcast_control(&proto::ServerMsg::Keymap { overrides });
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::BrowserRelayRegister {} => {
            daemon.browser_relay.register(conn_id);
            Ok(())
        }
        proto::ClientMsg::BrowserToolResult {
            request_id,
            ok,
            output,
            error,
        } => {
            daemon
                .browser_relay
                .deliver_result(conn_id, request_id, ok, output, error);
            Ok(())
        }
        proto::ClientMsg::RemoteGet => {
            let d = Arc::clone(daemon);
            let msg = tokio::task::spawn_blocking(move || d.remote_state_msg())
                .await
                .map_err(|e| anyhow::anyhow!("remote state panicked: {e}"))?;
            let _ = send_msg(sink, &msg).await;
            Ok(())
        }
        proto::ClientMsg::RemoteConfigure {
            enabled,
            bind,
            public_url,
            ntfy_url,
            notify_delay_secs,
            notify_detail,
            notify_finished,
            dictation,
        } => {
            let d = Arc::clone(daemon);
            let patch = crate::remote::ConfigPatch {
                enabled,
                bind,
                public_url,
                ntfy_url,
                notify_delay_secs,
                notify_detail: notify_detail.map(|v| match v {
                    proto::RemoteNotifyDetail::Generic => "generic".to_string(),
                    proto::RemoteNotifyDetail::PaneName => "pane_name".to_string(),
                }),
                notify_finished,
                dictation,
            };
            let result = tokio::task::spawn_blocking(move || d.remote_configure(patch))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("remote configure panicked: {e}")));
            remote_reply(sink, result).await;
            Ok(())
        }
        proto::ClientMsg::RemoteCaRegenerate => {
            let d = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || d.remote_regenerate_authority())
                .await
                .unwrap_or_else(|e| {
                    Err(anyhow::anyhow!(
                        "regenerating the certificate panicked: {e}"
                    ))
                });
            remote_reply(sink, result).await;
            Ok(())
        }
        proto::ClientMsg::RemotePairStart => {
            let d = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || d.remote_pairing_msg())
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("remote pairing panicked: {e}")));
            match result {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                }
                Err(e) => send_error(sink, format!("{e:#}"), Some("remote".into())).await,
            }
            Ok(())
        }
        proto::ClientMsg::RemoteDeviceRevoke { id } => {
            let d = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || d.remote_device_revoke(id))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("remote revoke panicked: {e}")));
            remote_reply(sink, result).await;
            Ok(())
        }
        proto::ClientMsg::RemoteDeviceSetTier { id, tier } => {
            let d = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || d.remote_device_set_tier(id, tier))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("remote tier change panicked: {e}")));
            remote_reply(sink, result).await;
            Ok(())
        }
        proto::ClientMsg::RemoteGridsPublish { grids } => {
            if let Err(e) = daemon.remote_grids_publish(grids) {
                send_error(sink, format!("{e:#}"), Some("remote".into())).await;
            }
            Ok(())
        }
    }
}

// Mirrored by the renderer in App.tsx.
const USAGE_SUMMARY_ERROR_CONTEXT: &str = "usage_summary";
const USAGE_ACTIVITY_ERROR_CONTEXT: &str = "usage_activity";

const GIT_STATUS_ERROR_CONTEXT: &str = "git_status";

async fn send_git_status(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    base: Option<String>,
) -> anyhow::Result<()> {
    let d = PathBuf::from(&dir);
    let b = base.clone();
    let probed = tokio::task::spawn_blocking(move || {
        // A missing directory stays an error; one that exists without git is
        // a workspace the panel reports as such, not a failed request.
        if d.is_dir() && !crate::git::probe_repo(&d)? {
            return anyhow::Ok((Vec::new(), crate::git::SyncStatus::default(), None, true));
        }
        let files = match b.as_deref() {
            Some(base) => crate::git::status_vs_base(&d, base)?,
            None => crate::git::status(&d)?,
        };
        let sync = crate::git::sync(&d);
        let default_base = crate::git::default_base(&d);
        anyhow::Ok((files, sync, default_base, false))
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("git status task panicked: {e}")));
    // The rail and overview poll every workspace in the background, so the
    // context lets clients keep these failures out of global notices.
    let (files, sync, default_base, not_a_repo) = match probed {
        Ok(status) => status,
        Err(e) => {
            send_error(
                sink,
                format!("{e:#}"),
                Some(GIT_STATUS_ERROR_CONTEXT.into()),
            )
            .await;
            return Ok(());
        }
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::GitStatus {
            dir,
            files,
            branch: sync.branch,
            upstream: sync.upstream,
            ahead: sync.ahead,
            behind: sync.behind,
            base,
            default_base,
            not_a_repo,
        },
    )
    .await;
    Ok(())
}

/// The owner segment panel-created checkpoints live under. Turn automation
/// would use a session owner; today the panel is the only producer.
const CHECKPOINT_OWNER: &str = "manual";

fn branch_info(b: crate::git::BranchInfo) -> proto::GitBranchInfo {
    proto::GitBranchInfo {
        name: b.name,
        current: b.current,
        is_default: b.is_default,
        is_remote: b.is_remote,
        remote_name: b.remote_name,
        upstream: b.upstream,
        worktree_path: b.worktree_path,
        ahead: b.ahead,
        behind: b.behind,
        committed_at: b.committed_at,
    }
}

fn checkpoint_info(c: crate::checkpoints::Checkpoint) -> proto::GitCheckpointInfo {
    proto::GitCheckpointInfo {
        r#ref: c.r#ref,
        label: c.label,
        owner: c.owner,
        sha: c.sha,
        created_ms: c.created_ms,
    }
}

/// A branch mutation changed more than the list: HEAD may have moved, which is
/// a new `git_status`. Both are pushed so the panel redraws from the daemon's
/// own state rather than guessing.
async fn send_refreshed_branches(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: &str,
) -> anyhow::Result<()> {
    let d = PathBuf::from(dir);
    let list = tokio::task::spawn_blocking(move || crate::git::list_branches(&d))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("git branches task panicked: {e}")))?;
    let _ = send_msg(
        sink,
        &proto::ServerMsg::GitBranches {
            dir: dir.to_string(),
            branches: list.branches.into_iter().map(branch_info).collect(),
            remotes: list.remotes.into_iter().map(branch_info).collect(),
            default_branch: list.default_branch,
            truncated: list.truncated,
        },
    )
    .await;
    send_git_status(sink, dir.to_string(), None).await
}

async fn send_checkpoints(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: &str,
) -> anyhow::Result<()> {
    let d = PathBuf::from(dir);
    let list = tokio::task::spawn_blocking(move || crate::checkpoints::list(&d, None))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("git checkpoints task panicked: {e}")))?;
    let _ = send_msg(
        sink,
        &proto::ServerMsg::GitCheckpoints {
            dir: dir.to_string(),
            checkpoints: list.into_iter().map(checkpoint_info).collect(),
        },
    )
    .await;
    Ok(())
}

/// One `pr_detail` reading: the persisted association first, then `gh` through
/// the engine. A `gh` problem is a `gh`+`hint` payload, never an error; `number`
/// reads one pull request without linking it, absent is the branch's own.
fn read_pr_detail(
    dir: &Path,
    stored: Option<proto::PullRequestLink>,
    number: Option<u32>,
    request: u32,
) -> proto::ServerMsg {
    let dir_string = dir.display().to_string();
    let gh = crate::gh::state(dir);
    let has_upstream = crate::git::sync(dir).upstream.is_some();
    let linked = match number {
        Some(n) => stored.as_ref().is_some_and(|l| l.number == n),
        None => stored.is_some(),
    };
    if let Some(0) = number {
        return proto::ServerMsg::PrDetail {
            dir: dir_string,
            request,
            gh,
            has_upstream,
            link: stored,
            detail: None,
            linked,
            hint: None,
            message: Some("pull request number must be positive; 0 was asked".to_string()),
        };
    }
    if gh != proto::GhState::Ready {
        return proto::ServerMsg::PrDetail {
            dir: dir_string,
            request,
            gh,
            has_upstream,
            link: stored,
            detail: None,
            linked,
            hint: crate::gh::hint_for(gh),
            message: None,
        };
    }
    let stored_link = stored
        .as_ref()
        .filter(|l| number.is_none_or(|n| l.number == n));
    let read = match number {
        Some(n) => crate::pull_requests::read(
            dir,
            Some(n),
            stored_link
                .map(|l| l.source)
                .unwrap_or(proto::PullRequestLinkSource::Detected),
            stored_link,
        )
        .map(Some),
        None => match stored_link {
            Some(link) => {
                crate::pull_requests::read(dir, Some(link.number), link.source, Some(link))
                    .map(Some)
            }
            None => crate::pull_requests::read_branch(dir),
        },
    };
    match read {
        Ok(Some((link, detail))) => proto::ServerMsg::PrDetail {
            dir: dir_string,
            request,
            gh,
            has_upstream,
            link: Some(link),
            detail: Some(detail),
            linked,
            hint: None,
            message: None,
        },
        Ok(None) => proto::ServerMsg::PrDetail {
            dir: dir_string,
            request,
            gh,
            has_upstream,
            link: None,
            detail: None,
            linked,
            hint: None,
            message: None,
        },
        Err(e) => proto::ServerMsg::PrDetail {
            dir: dir_string,
            request,
            gh,
            has_upstream,
            link: stored,
            detail: None,
            linked,
            hint: None,
            message: Some(e.to_string()),
        },
    }
}

async fn send_pr_detail(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: Option<u32>,
    request: u32,
) {
    let stored = match daemon.db().pull_request_link(&dir) {
        Ok(link) => link,
        Err(e) => {
            tracing::warn!("reading the pull request link for {dir:?}: {e}");
            None
        }
    };
    let d = PathBuf::from(&dir);
    let msg = tokio::task::spawn_blocking(move || read_pr_detail(&d, stored, number, request))
        .await
        .unwrap_or_else(|e| proto::ServerMsg::PrDetail {
            dir,
            request,
            gh: proto::GhState::Missing,
            has_upstream: false,
            link: None,
            detail: None,
            linked: false,
            hint: Some(crate::gh::MISSING_HINT.to_string()),
            message: Some(format!("pull request read task panicked: {e}")),
        });
    let _ = send_msg(sink, &msg).await;
}

async fn link_pull_request(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    request: u32,
) {
    if number == 0 {
        let _ = send_msg(
            sink,
            &proto::ServerMsg::PrLinked {
                dir,
                request,
                ok: false,
                message: Some("pull request number must be positive; 0 was asked".to_string()),
            },
        )
        .await;
        return;
    }
    let d = PathBuf::from(&dir);
    let read = tokio::task::spawn_blocking(move || {
        let gh = crate::gh::state(&d);
        if gh != proto::GhState::Ready {
            return Err(crate::gh::hint_for(gh)
                .unwrap_or_else(|| "gh is not ready to link a pull request".to_string()));
        }
        crate::pull_requests::read(&d, Some(number), proto::PullRequestLinkSource::Manual, None)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(format!("pull request link task panicked: {e}")));
    match read {
        Ok((link, _detail)) => match daemon.db().set_pull_request_link(&dir, &link) {
            Ok(()) => {
                let _ = send_msg(
                    sink,
                    &proto::ServerMsg::PrLinked {
                        dir: dir.clone(),
                        request,
                        ok: true,
                        message: None,
                    },
                )
                .await;
                send_pr_detail(daemon, sink, dir, None, request).await;
            }
            Err(e) => {
                let _ = send_msg(
                    sink,
                    &proto::ServerMsg::PrLinked {
                        dir,
                        request,
                        ok: false,
                        message: Some(format!("could not store the pull request link: {e}")),
                    },
                )
                .await;
            }
        },
        Err(message) => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrLinked {
                    dir,
                    request,
                    ok: false,
                    message: Some(message),
                },
            )
            .await;
        }
    }
}

async fn unlink_pull_request(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    request: u32,
) {
    match daemon.db().clear_pull_request_link(&dir) {
        Ok(Some(link)) => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrUnlinked {
                    dir: dir.clone(),
                    request,
                    number: Some(link.number),
                    ok: true,
                    message: None,
                },
            )
            .await;
            send_pr_detail(daemon, sink, dir, None, request).await;
        }
        Ok(None) => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrUnlinked {
                    dir: dir.clone(),
                    request,
                    number: None,
                    ok: false,
                    message: Some(format!("no pull request is linked to {dir}")),
                },
            )
            .await;
        }
        Err(e) => {
            let _ = send_msg(
                sink,
                &proto::ServerMsg::PrUnlinked {
                    dir,
                    request,
                    number: None,
                    ok: false,
                    message: Some(format!("could not clear the pull request link: {e}")),
                },
            )
            .await;
        }
    }
}

async fn send_merge_queue_reply(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    request: u32,
    number: u32,
    result: anyhow::Result<String>,
) {
    let (ok, message) = match result {
        Ok(message) => (true, Some(message)),
        Err(e) => (false, Some(format!("{e:#}"))),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::MergeQueueReply {
            dir,
            request,
            number,
            ok,
            message,
        },
    )
    .await;
}

/// A commit sha a merge may be pinned to: gh reports and the UI sends the full
/// 40-character hex head, so anything else is refused rather than guessed.
fn valid_head_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn send_merge_reply(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: &str,
    request: u32,
    number: u32,
    ok: bool,
    message: Option<String>,
) {
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrMerged {
            dir: dir.to_string(),
            request,
            number,
            ok,
            message,
        },
    )
    .await;
}

/// Merge rechecks the whole gate server-side — the UI's disabled reason is a
/// hint, not the authority — and pins the head sha the user saw, so a push that
/// lands between reading and merging is refused rather than merged unseen.
async fn merge_pull_request(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    method: proto::PrMergeMethod,
    expected_head_sha: String,
    request: u32,
) {
    if number == 0 {
        return send_merge_reply(
            sink,
            &dir,
            request,
            number,
            false,
            Some("pull request number must be positive; 0 was asked".to_string()),
        )
        .await;
    }
    if !valid_head_sha(&expected_head_sha) {
        return send_merge_reply(
            sink,
            &dir,
            request,
            number,
            false,
            Some(format!(
                "expected_head_sha {expected_head_sha:?} is not a full 40-character hex commit sha; refusing to merge PR #{number}"
            )),
        )
        .await;
    }
    let d = PathBuf::from(&dir);
    let sha = expected_head_sha.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let gh = crate::gh::state(&d);
        if gh != proto::GhState::Ready {
            return Err(
                crate::gh::hint_for(gh).unwrap_or_else(|| "gh is not ready to merge".to_string())
            );
        }
        let (link, detail, _) = crate::pull_requests::read_core(
            &d,
            Some(number),
            proto::PullRequestLinkSource::Manual,
            None,
        )
        .map_err(|e| e.to_string())?;
        if detail.head_sha != sha {
            return Err(format!(
                "PR #{number} head moved from {sha} to {}; refusing to merge an unseen commit",
                detail.head_sha
            ));
        }
        if let Some(reason) = crate::pull_requests::merge_disabled_reason(number, &link, &detail) {
            return Err(reason);
        }
        let res = crate::gh::pr_merge(&d, number, &sha, method);
        if res.ok {
            Ok(())
        } else {
            Err(res
                .message
                .unwrap_or_else(|| format!("gh pr merge {number} failed")))
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("pull request merge task panicked: {e}")));
    match outcome {
        Ok(()) => {
            send_merge_reply(sink, &dir, request, number, true, None).await;
            send_pr_detail(daemon, sink, dir, None, request).await;
        }
        Err(message) => send_merge_reply(sink, &dir, request, number, false, Some(message)).await,
    }
}

/// The one shape every pull-request write handler needs: which workspace, which
/// pull request, and the id its reply carries back.
struct PrWriteTarget {
    dir: String,
    number: u32,
    request: u32,
}

/// The identity and core reading of a write's target: a persisted association
/// keeps its source and linked time; anything else is read as detected.
fn read_target(
    dir: &Path,
    number: u32,
    stored: Option<&proto::PullRequestLink>,
) -> anyhow::Result<(proto::PullRequestLink, proto::PrDetail)> {
    let existing = stored.filter(|l| l.number == number);
    let source = existing
        .map(|l| l.source)
        .unwrap_or(proto::PullRequestLinkSource::Detected);
    let (link, detail, _) = crate::pull_requests::read_core(dir, Some(number), source, existing)?;
    Ok((link, detail))
}

async fn send_pr_mutation(
    sink: &mut (impl SinkExt<Message> + Unpin),
    target: &PrWriteTarget,
    kind: proto::PrMutationKind,
    ok: bool,
    message: Option<String>,
) {
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrMutation {
            dir: target.dir.clone(),
            request: target.request,
            number: target.number,
            kind,
            ok,
            message,
        },
    )
    .await;
}

/// Run one pull-request write off the async runtime, then answer with the one
/// mutation reply shape and, on success, a fresh detail read carrying the same
/// request id — which is what releases the UI's in-flight guard.
async fn run_pr_write<F>(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    target: PrWriteTarget,
    kind: proto::PrMutationKind,
    work: F,
) where
    F: FnOnce(PathBuf, Option<proto::PullRequestLink>) -> anyhow::Result<crate::gh::Outcome>
        + Send
        + 'static,
{
    if target.number == 0 {
        send_pr_mutation(
            sink,
            &target,
            kind,
            false,
            Some("pull request number must be positive; 0 was asked".to_string()),
        )
        .await;
        return;
    }
    let stored = match daemon.db().pull_request_link(&target.dir) {
        Ok(link) => link,
        Err(e) => {
            tracing::warn!("reading the pull request link for {:?}: {e}", target.dir);
            None
        }
    };
    let d = PathBuf::from(&target.dir);
    let outcome = tokio::task::spawn_blocking(move || work(d, stored))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("pull request write task panicked: {e}")));
    match outcome {
        Ok(o) => {
            send_pr_mutation(sink, &target, kind, o.ok, o.message).await;
            if o.ok {
                send_pr_detail(daemon, sink, target.dir, None, target.request).await;
            }
        }
        Err(e) => {
            send_pr_mutation(sink, &target, kind, false, Some(e.to_string())).await;
        }
    }
}

async fn pr_action(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    target: PrWriteTarget,
    action: proto::PrAction,
    merge_method: Option<proto::PrMergeMethod>,
    update_method: Option<proto::PrUpdateMethod>,
) {
    let number = target.number;
    run_pr_write(
        daemon,
        sink,
        target,
        proto::PrMutationKind::Action,
        move |d, stored| {
            let (link, _detail) = read_target(&d, number, stored.as_ref())?;
            let repository = crate::pull_requests::repository_for(&d, &link)?;
            let outcome = match action {
                proto::PrAction::Revert => {
                    crate::pull_requests::require_access(
                        &d,
                        &repository,
                        number,
                        crate::pull_requests::PrNeed::Write,
                        None,
                    )?;
                    crate::gh::pr_revert(&d, &repository, number)
                }
                proto::PrAction::ApproveWorkflows => {
                    crate::pull_requests::require_access(
                        &d,
                        &repository,
                        number,
                        crate::pull_requests::PrNeed::Write,
                        None,
                    )?;
                    let message = crate::pull_requests::approve_workflows(&d, number)?;
                    crate::gh::Outcome {
                        ok: true,
                        message: Some(message),
                    }
                }
                other => {
                    let need = match other {
                        proto::PrAction::Ready
                        | proto::PrAction::Draft
                        | proto::PrAction::Close
                        | proto::PrAction::Reopen => crate::pull_requests::PrNeed::Update,
                        proto::PrAction::UpdateBranch => crate::pull_requests::PrNeed::UpdateBranch,
                        _ => crate::pull_requests::PrNeed::Write,
                    };
                    crate::pull_requests::require_access(&d, &repository, number, need, None)?;
                    crate::gh::pr_action(&d, number, other, merge_method, update_method)
                }
            };
            Ok(outcome)
        },
    )
    .await;
}

async fn pr_edit(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    target: PrWriteTarget,
    title: Option<String>,
    body: Option<String>,
) {
    if title.is_none() && body.is_none() {
        send_pr_mutation(
            sink,
            &target,
            proto::PrMutationKind::Edit,
            false,
            Some("an edit needs a title or a body; both were absent".to_string()),
        )
        .await;
        return;
    }
    let number = target.number;
    run_pr_write(
        daemon,
        sink,
        target,
        proto::PrMutationKind::Edit,
        move |d, _| {
            Ok(crate::gh::pr_edit(
                &d,
                number,
                title.as_deref(),
                body.as_deref(),
            ))
        },
    )
    .await;
}

async fn pr_review(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    target: PrWriteTarget,
    verdict: proto::PrReviewVerdict,
    body: String,
    comments: Vec<proto::PrReviewDraft>,
) {
    if let Some(refusal) = crate::gh::body_refusal(&body) {
        send_pr_mutation(
            sink,
            &target,
            proto::PrMutationKind::Review,
            false,
            Some(refusal),
        )
        .await;
        return;
    }
    if comments.len() > crate::gh::PR_REVIEW_DRAFT_MAX {
        send_pr_mutation(
            sink,
            &target,
            proto::PrMutationKind::Review,
            false,
            Some(format!(
                "{} inline drafts were sent and the limit is {}",
                comments.len(),
                crate::gh::PR_REVIEW_DRAFT_MAX
            )),
        )
        .await;
        return;
    }
    let number = target.number;
    run_pr_write(
        daemon,
        sink,
        target,
        proto::PrMutationKind::Review,
        move |d, stored| {
            let (link, _detail) = read_target(&d, number, stored.as_ref())?;
            let repository = crate::pull_requests::repository_for(&d, &link)?;
            let permissions = crate::pull_requests::read_access(&d, &repository, number)?;
            if permissions.did_author && verdict != proto::PrReviewVerdict::Comment {
                let verb = match verdict {
                    proto::PrReviewVerdict::Approve => "approval",
                    proto::PrReviewVerdict::RequestChanges => "request for changes",
                    proto::PrReviewVerdict::Comment => "comment",
                };
                return Ok(crate::gh::Outcome::refused(format!(
                    "GitHub refuses an author's own {verb} on PR #{number}; comment instead"
                )));
            }
            Ok(crate::gh::pr_review(
                &d,
                number,
                &repository,
                verdict,
                &body,
                &comments,
            ))
        },
    )
    .await;
}

async fn send_pr_reviewer_candidates(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    request: u32,
) {
    let stored = match daemon.db().pull_request_link(&dir) {
        Ok(link) => link,
        Err(e) => {
            tracing::warn!("reading the pull request link for {dir:?}: {e}");
            None
        }
    };
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || {
        if number == 0 {
            anyhow::bail!("pull request number must be positive; 0 was asked");
        }
        let (link, _detail) = read_target(&d, number, stored.as_ref())?;
        let repository = crate::pull_requests::repository_for(&d, &link)?;
        crate::pull_requests::github::reviewer_candidates(&d, &repository, number)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("reviewer candidates task panicked: {e}")));
    let (candidates, truncated, message) = match result {
        Ok((candidates, truncated)) => (candidates, truncated, None),
        Err(e) => (Vec::new(), false, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrReviewerCandidates {
            dir,
            request,
            candidates,
            truncated,
            message,
        },
    )
    .await;
}

async fn send_pr_label_candidates(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    request: u32,
) {
    let stored = match daemon.db().pull_request_link(&dir) {
        Ok(link) => link,
        Err(e) => {
            tracing::warn!("reading the pull request link for {dir:?}: {e}");
            None
        }
    };
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || {
        if number == 0 {
            anyhow::bail!("pull request number must be positive; 0 was asked");
        }
        let (link, _detail) = read_target(&d, number, stored.as_ref())?;
        let repository = crate::pull_requests::repository_for(&d, &link)?;
        crate::pull_requests::github::label_candidates(&d, &repository, number)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("label candidates task panicked: {e}")));
    let (candidates, truncated, message) = match result {
        Ok((candidates, truncated)) => (candidates, truncated, None),
        Err(e) => (Vec::new(), false, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrLabelCandidates {
            dir,
            request,
            candidates,
            truncated,
            message,
        },
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn send_pr_list(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    state: proto::PrListState,
    involvement: proto::PrListInvolvement,
    query: Option<String>,
    limit: u32,
    sort: proto::PrSort,
    request: u32,
) {
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || {
        crate::gh::pr_list(&d, state, involvement, query.as_deref(), limit, sort)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("pull request listing task panicked: {e}")));
    let (items, truncated, viewer_login, message) = match result {
        Ok(list) => (list.items, list.truncated, list.viewer_login, None),
        Err(e) => (Vec::new(), false, None, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrList {
            viewer_login,
            dir,
            request,
            items,
            truncated,
            message,
        },
    )
    .await;
}

async fn send_pr_diff(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    request: u32,
) {
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || crate::gh::pr_diff(&d, number))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("pull request diff task panicked: {e}")));
    let (patch, truncated, message) = match result {
        Ok((patch, truncated)) => (patch, truncated, None),
        Err(e) => (String::new(), false, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrDiff {
            dir,
            request,
            number,
            patch,
            truncated,
            message,
        },
    )
    .await;
}

async fn send_pr_stack(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    number: u32,
    request: u32,
) {
    if number == 0 {
        let _ = send_msg(
            sink,
            &proto::ServerMsg::PrStack {
                dir,
                request,
                stack: None,
                message: Some("pull request number must be positive; 0 was asked".to_string()),
            },
        )
        .await;
        return;
    }
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || crate::gh::pr_stack(&d, number))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("pull request stack task panicked: {e}")));
    let (stack, message) = match result {
        Ok(Some(stack)) => (
            Some(crate::pull_requests::github::stack_to_proto(&stack)),
            None,
        ),
        Ok(None) => (None, None),
        Err(e) => (None, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrStack {
            dir,
            request,
            stack,
            message,
        },
    )
    .await;
}

/// The whole of a stack-merge request, kept as one value so the handler keeps
/// its argument count down without hiding which field is which.
struct PrStackMergeRequest {
    dir: String,
    number: u32,
    stack_number: u32,
    heads: Vec<proto::PrStackHead>,
    merge_method: Option<proto::PrMergeMethod>,
    request: u32,
}

async fn pr_stack_merge(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    req: PrStackMergeRequest,
) {
    let number = req.number;
    let target = PrWriteTarget {
        dir: req.dir,
        number,
        request: req.request,
    };
    let stack_number = req.stack_number;
    let heads = req.heads;
    let method = req.merge_method.unwrap_or(proto::PrMergeMethod::Merge);
    run_pr_write(
        daemon,
        sink,
        target,
        proto::PrMutationKind::Action,
        move |d, stored| {
            let (link, _detail) = read_target(&d, number, stored.as_ref())?;
            let repository = crate::pull_requests::repository_for(&d, &link)?;
            crate::pull_requests::require_access(
                &d,
                &repository,
                number,
                crate::pull_requests::PrNeed::Write,
                None,
            )?;
            Ok(crate::gh::pr_stack_merge(
                &d,
                number,
                stack_number,
                &heads,
                method,
            ))
        },
    )
    .await;
}

async fn send_msg(
    sink: &mut (impl SinkExt<Message> + Unpin),
    msg: &proto::ServerMsg,
) -> Result<(), ()> {
    let json = serde_json::to_string(msg).expect("ServerMsg serializes");
    sink.send(Message::Text(json.into())).await.map_err(|_| ())
}

/// Remote-access refusals carry `context: "remote"` so Settings can show them in place.
async fn remote_reply(sink: &mut (impl SinkExt<Message> + Unpin), result: anyhow::Result<()>) {
    if let Err(e) = result {
        send_error(sink, format!("{e:#}"), Some("remote".into())).await;
    }
}

/// A refused Slack change goes back to the asker only; an applied one
/// reaches every client, so each Settings view shows the same state.
async fn slack_reply(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    msg: proto::ServerMsg,
) {
    match &msg {
        proto::ServerMsg::Slack {
            refusal: Some(_), ..
        } => {
            let _ = send_msg(sink, &msg).await;
        }
        _ => daemon.broadcast_control(&msg),
    }
}

/// Pane mount, focus and teardown race session removal: a request for an id that is neither
/// live nor retained is dropped with a debug log instead of an error frame.
fn vanished(daemon: &Daemon, session: u32, request: &str) -> bool {
    let gone = !daemon.has_session(session);
    if gone {
        tracing::debug!("{request} for unknown session {session} ignored");
    }
    gone
}

async fn send_error(
    sink: &mut (impl SinkExt<Message> + Unpin),
    message: String,
    context: Option<String>,
) {
    let _ = send_msg(sink, &proto::ServerMsg::Error { message, context }).await;
}

use axum::extract::Query;
use serde::Deserialize;
use serde_json::json;

fn orch_scope(
    daemon: &Daemon,
    headers: &HeaderMap,
) -> std::result::Result<crate::mcp_creds::McpScope, Box<Response>> {
    let token =
        crate::mcp_server::bearer_token(headers).ok_or_else(crate::mcp_server::unauthorized)?;
    daemon
        .mcp_creds
        .resolve(&token)
        .ok_or_else(|| Box::new(crate::mcp_server::unauthorized()))
}

fn orch_error(status: StatusCode, err: anyhow::Error) -> Response {
    (status, axum::Json(json!({ "error": format!("{err:#}") }))).into_response()
}

fn orch_err_response(err: anyhow::Error) -> Response {
    let text = format!("{err:#}");
    let conflict = text.contains("refused")
        || text.contains("confirmation_required")
        || text.contains("prompt_stalled")
        || text.contains("not enabled");
    if conflict {
        orch_error(StatusCode::CONFLICT, err)
    } else {
        orch_error(StatusCode::INTERNAL_SERVER_ERROR, err)
    }
}

async fn orch_whoami(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match daemon.orchestrate_whoami_json(scope.session_id) {
        Ok(info) => (StatusCode::OK, axum::Json(info)).into_response(),
        Err(e) => orch_error(StatusCode::NOT_FOUND, e),
    }
}

async fn orch_list(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match daemon.orchestrate_list(scope.session_id) {
        Ok(children) => {
            (StatusCode::OK, axum::Json(json!({ "children": children }))).into_response()
        }
        Err(e) => orch_error(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct SendKeysBody {
    session: u32,
    keys: Vec<String>,
}

async fn orch_send_keys(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<SendKeysBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match daemon.orchestrate_send_keys(scope.session_id, body.session, &body.keys) {
        Ok(()) => (
            StatusCode::OK,
            axum::Json(json!({ "sent": body.keys, "session": body.session })),
        )
            .into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct GetQuery {
    session: u32,
    result_id: Option<i64>,
}

async fn orch_get(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(q): Query<GetQuery>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    if let Some(id) = q.result_id {
        return match daemon.orchestrate_result(scope.session_id, q.session, id) {
            Ok(row) => (
                StatusCode::OK,
                axum::Json(json!({"result_id":id,"body":row.body})),
            )
                .into_response(),
            Err(e) => orch_err_response(e),
        };
    }
    match daemon.orchestrate_get(scope.session_id, q.session) {
        Ok(detail) => (StatusCode::OK, axum::Json(detail)).into_response(),
        Err(e) => orch_error(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct ReadQuery {
    session: u32,
    lines: Option<usize>,
    source: Option<String>,
}

async fn orch_read(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(q): Query<ReadQuery>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let lines = q.lines.unwrap_or(40);
    if lines > 500 {
        return orch_error(
            StatusCode::BAD_REQUEST,
            anyhow::anyhow!("read refused: {lines} lines exceeds the 500-line cap"),
        );
    }
    let screen = match crate::orchestrate::read_source_is_screen(q.source.as_deref()) {
        Ok(s) => s,
        Err(e) => return orch_error(StatusCode::BAD_REQUEST, anyhow::anyhow!("{e}")),
    };
    match daemon.orchestrate_read(scope.session_id, q.session, lines, screen) {
        Ok(lines) => (StatusCode::OK, axum::Json(json!({ "lines": lines }))).into_response(),
        Err(e) => orch_error(StatusCode::NOT_FOUND, e),
    }
}

type SpawnBody = crate::orchestrate::SpawnRequest;

async fn orch_spawn(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<SpawnBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let reusable = body.reusable;
    let handoff = body.handoff;
    let effort = body.effort;
    let result = tokio::task::spawn_blocking(move || {
        daemon.orchestrate_spawn_request(scope.session_id, body)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestrate spawn panicked: {e}")));
    match result {
        Ok(outcome) => {
            let info = outcome.session;
            (
            StatusCode::OK,
            axum::Json(json!({
                "session_id": info.id,
                "title": info.title,
                "codename": info.codename,
                "workspace": info.project_dir,
                "reusable": reusable,
                "handoff": handoff,
                "effort": effort.map(|effort| serde_json::to_value(effort).expect("effort serializes")).unwrap_or(json!("CLI default")),
                "warning": outcome.warning,
                "warnings": outcome.warnings,
                "next_action": if handoff {
                    crate::orchestrate::HANDOFF_NEXT_ACTION
                } else {
                    crate::orchestrate::SPAWN_NEXT_ACTION
                },
            })),
        )
            .into_response()
        }
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct PromptBody {
    session: u32,
    text: String,
    client_request_id: Option<String>,
    mode: Option<String>,
}

async fn orch_prompt(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<axum::Json<PromptBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let axum::Json(body) = match payload {
        Ok(body) => body,
        Err(error) => return orch_error(StatusCode::BAD_REQUEST, anyhow::anyhow!(
            "prompt payload: expected {{session: positive integer, text: nonblank string, client_request_id?: string, mode?: queue|steer|restart}}; {}", error.body_text()
        )),
    };
    let mode = body.mode.clone().unwrap_or_else(|| "queue".into());
    let result = tokio::task::spawn_blocking(move || {
        daemon.orchestrate_instruction_request(
            scope.session_id,
            body.session,
            &body.text,
            body.client_request_id.as_deref(),
            body.mode.as_deref(),
        )
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestrate prompt panicked: {e}")));
    let (acceptance, source, status) = match result {
        Ok(result) => result,
        Err(e) => return orch_err_response(e),
    };
    (
        StatusCode::OK,
        axum::Json(crate::orchestrate::doors::prompt_output(
            acceptance, source, status, &mode,
        )),
    )
        .into_response()
}

#[derive(Deserialize)]
struct WaitBody {
    #[serde(default)]
    session: Option<u32>,
    #[serde(default)]
    kind: Option<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    stall_guard: bool,
    #[serde(default)]
    until: Option<String>,
}

struct WaitResponseDelivery {
    daemon: Arc<Daemon>,
    caller: u32,
    delivery_id: String,
    sent: bool,
}

impl Drop for WaitResponseDelivery {
    fn drop(&mut self) {
        if !self.sent {
            self.daemon
                .finish_wait_delivery(self.caller, &self.delivery_id, false);
        }
    }
}

async fn orch_wait(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<WaitBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    if body.until.is_some() {
        return orch_error(
            StatusCode::BAD_REQUEST,
            anyhow::anyhow!(crate::orchestrate::UNTIL_REMOVED_MSG),
        );
    }
    let kind = match body.kind.as_deref() {
        None => None,
        Some(k) => match crate::orchestrate::InboxKind::parse(k) {
            Some(k) => Some(k),
            None => {
                return orch_error(
                    StatusCode::BAD_REQUEST,
                    anyhow::anyhow!(
                        "kind {k:?} is not a pane_inbox kind — one of {}",
                        crate::orchestrate::INBOX_KIND_VALUES.join(", ")
                    ),
                )
            }
        },
    };
    let timeout_ms = body.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
    let (provider, cap) = daemon.orchestration_wait_cap(scope.session_id);
    let cap_note = crate::orchestrate::wait_cap_note(provider, timeout_ms, cap);
    let outcome = daemon
        .orchestrate_wait_reserved(
            scope.session_id,
            body.session,
            kind,
            timeout_ms,
            body.stall_guard,
        )
        .await;
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => return orch_err_response(e),
    };
    use crate::orchestrate::InboxWaitOutcome;
    let message = outcome.message();
    match outcome {
        InboxWaitOutcome::Delivered {
            rows,
            delivery_id,
            has_more,
            waited_ms: _,
        } => {
            let wire_rows: Vec<proto::InboxRow> = rows.into_iter().map(|mut row| {
                if let Some(excerpt) = crate::orchestrate::result_body_excerpt(&row) {
                    row.body = excerpt;
                }
                row.into()
            }).collect();
            let value = json!({
                "rows": wire_rows,
                "delivery_id": delivery_id,
                "has_more": has_more,
                "wait_cap_ms": cap,
                "requested_timeout_ms": timeout_ms,
                "provider": provider,
                "cap_note": cap_note,
            });
            let bytes = axum::body::Bytes::from(value.to_string());
            let delivery = WaitResponseDelivery {
                daemon,
                caller: scope.session_id,
                delivery_id,
                sent: false,
            };
            let stream = futures_util::stream::unfold(
                (Some(bytes), delivery),
                |(bytes, mut delivery)| async move {
                    if let Some(bytes) = bytes {
                        Some((Ok::<_, std::convert::Infallible>(bytes), (None, delivery)))
                    } else {
                        delivery.daemon.finish_wait_delivery(
                            delivery.caller,
                            &delivery.delivery_id,
                            true,
                        );
                        delivery.sent = true;
                        drop(delivery);
                        None
                    }
                },
            );
            Response::builder()
                .status(StatusCode::OK)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from_stream(stream))
                .expect("static wait response headers")
        }
        InboxWaitOutcome::TimedOut {
            waited_ms,
            status,
            status_source,
        } => {
            let next_action = daemon
                .orchestration_wait_timeout_next_action(scope.session_id, body.session);
            (
                StatusCode::REQUEST_TIMEOUT,
                axum::Json(json!({
                    "rows": [],
                    "timed_out": true,
                    "waited_ms": waited_ms,
                    "wait_cap_ms": cap,
                    "requested_timeout_ms": timeout_ms,
                    "provider": provider,
                    "cap_note": cap_note,
                    "status": status,
                    "status_source": status_source,
                    "next_action": next_action,
                })),
            )
                .into_response()
        },
        InboxWaitOutcome::Restarting { waited_ms } => (
            StatusCode::REQUEST_TIMEOUT,
            axum::Json(json!({
                "rows": [], "timed_out": true, "restarting": true,
                "waited_ms": waited_ms, "wait_cap_ms": cap,
                "requested_timeout_ms": timeout_ms, "provider": provider,
                "cap_note": cap_note, "next_action": message,
            })),
        ).into_response(),
        InboxWaitOutcome::Superseded => (
            StatusCode::OK,
            axum::Json(json!({"superseded":true,"rows":[]})),
        )
            .into_response(),
        InboxWaitOutcome::NothingToWaitOn => (
            StatusCode::OK,
            axum::Json(json!({"nothing_to_wait_on":true,"live_children":0,"rows":[],"wait_cap_ms":cap,"requested_timeout_ms":timeout_ms,"provider":provider,"cap_note":cap_note})),
        )
            .into_response(),
        InboxWaitOutcome::Stalled { .. } => (
            StatusCode::CONFLICT,
            axum::Json(json!({
                "error": message,
                "reason": "prompt_stalled",
            })),
        )
            .into_response(),
    }
}

const DEFAULT_WAIT_TIMEOUT_MS: u64 = crate::orchestrate::DEFAULT_WAIT_TIMEOUT_MS;

#[derive(Deserialize)]
struct KillBody {
    session: u32,
    #[serde(default)]
    confirm_children: bool,
}

async fn orch_kill(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<KillBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let result = tokio::task::spawn_blocking(move || {
        daemon.orchestrate_kill(scope.session_id, body.session, body.confirm_children)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestrate kill panicked: {e}")));
    match result {
        Ok(()) => (
            StatusCode::OK,
            axum::Json(json!({ "killed": body.session })),
        )
            .into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct PrWatchBody {
    pr: String,
}

async fn orch_pr_watch(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PrWatchBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let target = body.pr;
    let start_target = target.clone();
    let result =
        tokio::task::spawn_blocking(move || daemon.pr_watch_start(scope.session_id, &start_target))
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("PR watch panicked: {e}")));
    match result {
        Ok(()) => (StatusCode::OK, axum::Json(json!({"watching": true, "pr": target, "note": "End your turn now; Houston wakes this pane on the next PR change."}))).into_response(),
        Err(e) => orch_err_response(e),
    }
}

async fn orch_pr_unwatch(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let result = tokio::task::spawn_blocking(move || daemon.pr_watch_stop_all(scope.session_id))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("PR unwatch panicked: {e}")));
    match result {
        Ok(stopped) => (StatusCode::OK, axum::Json(json!({"stopped": stopped}))).into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct PrEnqueueBody {
    pr: String,
    #[serde(default)]
    depends_on: Option<u32>,
}

async fn orch_pr_enqueue(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PrEnqueueBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let result = tokio::task::spawn_blocking(move || {
        daemon.merge_queue_enqueue_from_pane(scope.session_id, &body.pr, body.depends_on)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("PR enqueue panicked: {e}")));
    match result {
        Ok(entry) => (
            StatusCode::OK,
            axum::Json(crate::mcp_orchestration::enqueue_result(&entry)),
        )
            .into_response(),
        Err(e) => orch_error(StatusCode::CONFLICT, e),
    }
}

#[derive(serde::Deserialize)]
struct BuildSlotBody {
    action: String,
    #[serde(default)]
    lease: Option<String>,
}

async fn orch_build_slot(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<BuildSlotBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let result = tokio::task::spawn_blocking(move || {
        daemon.build_slot_request(scope.session_id, &body.action, body.lease.as_deref())
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("build slot request panicked: {e}")));
    match result {
        Ok(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        Err(e) => orch_error(StatusCode::CONFLICT, e),
    }
}

async fn orch_pr_dequeue(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PrWatchBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let target = body.pr;
    let dequeue_target = target.clone();
    let result = tokio::task::spawn_blocking(move || {
        daemon.merge_queue_dequeue_from_pane(scope.session_id, &dequeue_target)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("PR dequeue panicked: {e}")));
    match result {
        Ok(()) => (
            StatusCode::OK,
            axum::Json(json!({"dequeued": true, "pr": target})),
        )
            .into_response(),
        Err(e) => orch_error(StatusCode::CONFLICT, e),
    }
}

#[derive(Deserialize)]
struct SubmitBody {
    body: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    artifacts: Vec<String>,
    #[serde(default)]
    request_id: Option<u32>,
}

#[derive(serde::Deserialize)]
struct PublishBody {
    #[serde(default)]
    summary: Option<String>,
}

async fn night_post(
    State(daemon): State<Arc<Daemon>>,
    axum::extract::Path(verb): axum::extract::Path<String>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let result =
        tokio::task::spawn_blocking(move || daemon.night_tool(scope.session_id, &verb, &payload))
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("night tool panicked: {e}")));
    match result {
        Ok(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        Err(e) => orch_err_response(e),
    }
}

async fn harness_publish(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<PublishBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let result = tokio::task::spawn_blocking(move || {
        daemon.harness_publish(scope.session_id, payload.summary)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("harness publish panicked: {e}")));
    match result {
        Ok(note) => (
            StatusCode::OK,
            axum::Json(json!({ "published": true, "note": note })),
        )
            .into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct TaskGetQuery {
    key: Option<String>,
    id: Option<i64>,
}

#[derive(Deserialize)]
struct TaskListParams {
    #[serde(default)]
    mine: bool,
    #[serde(default)]
    ready: bool,
    status: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
struct TaskIdBody {
    key: Option<String>,
    id: Option<i64>,
}

fn deserialize_task_workspace<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct TaskCreateBody {
    #[serde(default, deserialize_with = "deserialize_task_workspace")]
    workspace: Option<Option<String>>,
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<proto::TaskStatus>,
    #[serde(default)]
    priority: Option<proto::TaskPriority>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    acceptance: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct TaskUpdateBody {
    #[serde(default, deserialize_with = "deserialize_task_workspace")]
    workspace: Option<Option<String>>,
    key: Option<String>,
    id: Option<i64>,
    expected_revision: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<proto::TaskStatus>,
    #[serde(default)]
    priority: Option<proto::TaskPriority>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    acceptance: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct TaskCommentBody {
    key: Option<String>,
    id: Option<i64>,
    body: String,
}

#[derive(Deserialize)]
struct TaskCheckBody {
    key: Option<String>,
    id: Option<i64>,
    item: u32,
}

#[derive(Deserialize)]
struct TaskHandbackBody {
    key: Option<String>,
    id: Option<i64>,
    #[serde(default)]
    summary: Option<String>,
    /// A Slack-filed task's fields for the thread and the owner.
    #[serde(default)]
    result: Option<crate::slack::form::ResultForm>,
}

/// Resolves global task references and checks the caller's agent scope.
fn task_id_from(
    daemon: &Daemon,
    workspace: &str,
    key: Option<&str>,
    id: Option<i64>,
    operation: &str,
) -> anyhow::Result<i64> {
    let value = match (key, id) {
        (Some(key), _) => json!(key),
        (None, Some(id)) => json!(id),
        _ => anyhow::bail!(
            "{operation} refused: a task key or id is required (expected HOU-1 or integer id)"
        ),
    };
    daemon.task_ref_in(workspace, &value, operation)
}

/// One `/task/*` call: the pane's scope is the workspace, a child is refused by
/// the shared task-tool check, and the reply is broadcast so the Tasks tab sees
/// an agent's write.
async fn task_request<F>(daemon: Arc<Daemon>, headers: HeaderMap, call: F) -> Response
where
    F: FnOnce(&Daemon, &crate::mcp_creds::McpScope, &str) -> anyhow::Result<proto::ServerMsg>
        + Send
        + 'static,
{
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let actor = match daemon.task_actor(scope.session_id) {
        Ok(actor) => actor,
        Err(e) => return orch_error(StatusCode::CONFLICT, e),
    };
    let worker = Arc::clone(&daemon);
    let result = tokio::task::spawn_blocking(move || call(&worker, &scope, &actor))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("task request panicked: {e}")));
    match result {
        Ok(proto::ServerMsg::TaskRefused { message, .. }) => {
            orch_error(StatusCode::CONFLICT, anyhow::anyhow!("{message}"))
        }
        Ok(msg) => {
            daemon.broadcast_control(&msg);
            match serde_json::to_value(&msg) {
                Ok(value) => (StatusCode::OK, axum::Json(value)).into_response(),
                Err(e) => orch_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    anyhow::anyhow!("serializing the task reply: {e}"),
                ),
            }
        }
        Err(e) => orch_err_response(e),
    }
}

async fn task_next(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    task_request(daemon, headers, |d, scope, _actor| {
        d.task_next(&scope.workspace_id)
    })
    .await
}

async fn task_list(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(params): Query<TaskListParams>,
) -> Response {
    let status = match params.status.as_deref() {
        Some(raw) => match crate::db::from_wire::<proto::TaskStatus>(raw) {
            Some(status) => Some(status),
            None => {
                return orch_error(
                    StatusCode::BAD_REQUEST,
                    anyhow::anyhow!(
                        "status {raw:?} is not a task status; expected one of backlog, todo, \
                         in_progress, in_review, done, canceled"
                    ),
                )
            }
        },
        None => None,
    };
    task_request(daemon, headers, move |d, scope, _actor| {
        d.task_list(
            &scope.workspace_id,
            scope.session_id,
            &crate::daemon::tasks::TaskListQuery {
                status,
                ready: params.ready,
                mine: params.mine,
                query: params.query.as_deref(),
                limit: params.limit,
            },
        )
    })
    .await
}

async fn task_get(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(params): Query<TaskGetQuery>,
) -> Response {
    task_request(daemon, headers, move |d, scope, _actor| {
        let id = task_id_from(
            d,
            &scope.workspace_id,
            params.key.as_deref(),
            params.id,
            "task_get",
        )?;
        d.task_get_in(&scope.workspace_id, id)
    })
    .await
}

async fn task_create(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskCreateBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let parent_id = match body.parent.as_deref() {
            Some(key) => Some(
                d.task_id_for_key(&scope.workspace_id, key)?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "parent key {key:?} does not exist in workspace {:?} (expected an \
                             existing HOU-<number>)",
                            scope.workspace_id
                        )
                    })?,
            ),
            None => None,
        };
        d.task_save_as(
            &scope.workspace_id,
            None,
            None,
            proto::TaskPatch {
                title: Some(body.title),
                description: body.description,
                status: body.status,
                priority: body.priority,
                parent_id: parent_id.map(Some),
                ref_url: None,
                acceptance: body.acceptance,
                workspace: body.workspace,
            },
            actor,
            "task_create",
        )
    })
    .await
}

async fn task_update(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskUpdateBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let id = task_id_from(d, &scope.workspace_id, body.key.as_deref(), body.id, "task")?;
        let parent_id = body
            .parent
            .as_deref()
            .map(|key| {
                d.task_id_for_key(&scope.workspace_id, key)?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "parent key {key:?} does not exist in workspace {:?} (expected an \
                         existing HOU-<number>)",
                        scope.workspace_id
                    )
                })
            })
            .transpose()?;
        d.task_save_as(
            &scope.workspace_id,
            Some(id),
            Some(body.expected_revision),
            proto::TaskPatch {
                title: body.title,
                description: body.description,
                status: body.status,
                priority: body.priority,
                parent_id: parent_id.map(Some),
                ref_url: None,
                acceptance: body.acceptance,
                workspace: body.workspace,
            },
            actor,
            "task_update",
        )
    })
    .await
}

async fn task_comment(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskCommentBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let id = task_id_from(d, &scope.workspace_id, body.key.as_deref(), body.id, "task")?;
        d.task_comment_as(
            Some(&scope.workspace_id),
            id,
            &body.body,
            actor,
            "task_comment",
        )
    })
    .await
}

async fn task_check(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskCheckBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let id = task_id_from(d, &scope.workspace_id, body.key.as_deref(), body.id, "task")?;
        let items = match d.task_get_in(&scope.workspace_id, id)? {
            proto::ServerMsg::TaskDetail { acceptance, .. } => acceptance,
            refreshed @ proto::ServerMsg::TaskRefused { .. } => return Ok(refreshed),
            _ => unreachable!("task_get answers a detail or a refusal"),
        };
        if body.item == 0 {
            anyhow::bail!(
                "acceptance item {item} is not a position; expected 1..={count}",
                item = body.item,
                count = items.len()
            );
        }
        let Some(item) = items.get((body.item - 1) as usize) else {
            anyhow::bail!(
                "acceptance item {item} is out of range; task {id} has {count} item(s) (expected \
                 1..={count})",
                item = body.item,
                count = items.len()
            );
        };
        d.task_check_as(
            Some(&scope.workspace_id),
            id,
            item.id,
            true,
            actor,
            Some(scope.session_id),
            "task_check",
        )
    })
    .await
}

async fn task_claim(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskIdBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let id = task_id_from(d, &scope.workspace_id, body.key.as_deref(), body.id, "task")?;
        d.task_claim(
            &scope.workspace_id,
            id,
            scope.session_id,
            actor,
            "task_claim",
        )
    })
    .await
}

async fn task_handback(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<TaskHandbackBody>,
) -> Response {
    task_request(daemon, headers, move |d, scope, actor| {
        let id = task_id_from(d, &scope.workspace_id, body.key.as_deref(), body.id, "task")?;
        d.task_handback_from(
            &scope.workspace_id,
            id,
            body.summary.as_deref(),
            body.result,
            scope.session_id,
            actor,
            "task_handback",
        )
    })
    .await
}

/// Posts a Slack-filed task's question to its thread and returns at once; the
/// answer reaches the pane later as a prompt, never as this call's result.
async fn task_ask(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<crate::slack::form::QuestionForm>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match tokio::task::spawn_blocking(move || daemon.slack_task_ask(scope.session_id, body)).await {
        Ok(Ok(text)) => (StatusCode::OK, axum::Json(json!({"text": text}))).into_response(),
        Ok(Err(e)) => orch_error(StatusCode::CONFLICT, e),
        Err(e) => orch_err_response(anyhow::anyhow!("task ask worker failed: {e}")),
    }
}

async fn orch_submit(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<SubmitBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let result = tokio::task::spawn_blocking(move || {
        daemon.orchestrate_submit(
            scope.session_id,
            crate::orchestrate::Submission {
                body: payload.body,
                summary: payload.summary,
                artifacts: payload.artifacts,
                request_id: payload.request_id,
            },
        )
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestrate submit panicked: {e}")));
    match result {
        Ok(outcome) => (
            StatusCode::OK,
            axum::Json(json!({
                "submitted": true,
                "message_id": outcome.row_id,
                "request_id": outcome.request_id,
                "reason": outcome.reason,
                "note": outcome.note,
            })),
        )
            .into_response(),
        Err(e) => orch_err_response(e),
    }
}

async fn orch_report(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<crate::orchestrate::WorkerReport>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(r) => return *r,
    };
    match tokio::task::spawn_blocking(move || daemon.orchestrate_report(scope.session_id, payload))
        .await
    {
        Ok(Ok(value)) => (StatusCode::OK, axum::Json(value)).into_response(),
        Ok(Err(e)) => orch_err_response(e),
        Err(e) => orch_err_response(anyhow::anyhow!("report worker failed: {e}")),
    }
}

async fn orch_message(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<crate::orchestrate::SiblingMessage>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(r) => return *r,
    };
    match tokio::task::spawn_blocking(move || daemon.orchestrate_message(scope.session_id, payload))
        .await
    {
        Ok(Ok(value)) => (StatusCode::OK, axum::Json(value)).into_response(),
        Ok(Err(e)) => orch_err_response(e),
        Err(e) => orch_err_response(anyhow::anyhow!("message worker failed: {e}")),
    }
}

async fn orch_reply(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<crate::orchestrate::WorkerReply>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(r) => return *r,
    };
    match tokio::task::spawn_blocking(move || daemon.orchestrate_reply(scope.session_id, payload))
        .await
    {
        Ok(Ok(value)) => (StatusCode::OK, axum::Json(value)).into_response(),
        Ok(Err(e)) => orch_err_response(e),
        Err(e) => orch_err_response(anyhow::anyhow!("reply worker failed: {e}")),
    }
}

async fn inbox_tool_boundary(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match tokio::task::spawn_blocking(move || daemon.inbox_tool_boundary(scope.session_id)).await {
        Ok(Ok(text)) => (StatusCode::OK, axum::Json(json!({"text": text}))).into_response(),
        Ok(Err(e)) => orch_err_response(e),
        Err(e) => orch_err_response(anyhow::anyhow!("inbox tool-boundary worker failed: {e}")),
    }
}

async fn inbox_reserve(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(_body): axum::Json<serde_json::Value>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let outcome =
        match daemon.inbox_reserve_for_stop_hook(scope.session_id, crate::daemon::now_ms()) {
            Ok(o) => o,
            Err(e) => return orch_err_response(e),
        };
    use crate::orchestrate::StopHookReserveOutcome;
    match outcome {
        StopHookReserveOutcome::Empty => {
            (StatusCode::OK, axum::Json(json!({ "rows": [] }))).into_response()
        }
        StopHookReserveOutcome::Capped { limit, blocks } => (
            StatusCode::OK,
            axum::Json(json!({ "rows": [], "capped": true, "limit": limit, "blocks": blocks })),
        )
            .into_response(),
        StopHookReserveOutcome::Reserved {
            rows,
            delivery_id,
            expires_at,
            text,
        } => {
            let wire_rows: Vec<proto::InboxRow> = rows.into_iter().map(Into::into).collect();
            (
                StatusCode::OK,
                axum::Json(json!({
                    "delivery_id": delivery_id,
                    "expires_at": expires_at,
                    "rows": wire_rows,
                    "text": text,
                })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct InboxDeliveredBody {
    #[serde(default)]
    delivery_id: Option<String>,
}

async fn inbox_delivered(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<InboxDeliveredBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let Some(delivery_id) = body.delivery_id.filter(|s| !s.trim().is_empty()) else {
        return orch_error(
            StatusCode::BAD_REQUEST,
            anyhow::anyhow!(
                "delivery_id is required — confirm the reservation /inbox/reserve returned"
            ),
        );
    };
    match daemon.inbox_confirm_stop_hook(scope.session_id, &delivery_id, crate::daemon::now_ms()) {
        Ok(marked) => (StatusCode::OK, axum::Json(json!({ "marked": marked }))).into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[cfg(test)]
mod frame_flush_tests {
    use super::*;
    use axum::serve::Listener;
    use futures_util::{FutureExt, Sink};
    use std::pin::Pin;
    use std::task::{Context, Poll};

    #[derive(Default)]
    struct RecordingSink {
        messages: Vec<Message>,
        flushes: usize,
    }

    impl Sink<Message> for RecordingSink {
        type Error = std::io::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.messages.push(item);
            Ok(())
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    struct LiveSession {
        daemon: Arc<Daemon>,
        id: u32,
        _state: tempfile::TempDir,
    }

    impl LiveSession {
        fn new() -> Self {
            let state = tempfile::tempdir().unwrap();
            let daemon = Daemon::new(crate::daemon::DaemonConfig::new(
                "token".into(),
                state.path().join("test.db"),
                crate::host_env::HostEnv::capture_with_home(state.path()),
            ))
            .unwrap();
            let id = Self::spawn(&daemon, state.path());
            Self {
                daemon,
                id,
                _state: state,
            }
        }

        fn spawn(daemon: &Arc<Daemon>, dir: &Path) -> u32 {
            daemon
                .create_session(crate::daemon::CreateParams {
                    agent: proto::AgentKind::Custom,
                    project_dir: dir.to_path_buf(),
                    cmd: Some(if cfg!(windows) {
                        vec!["cmd.exe".into(), "/d".into(), "/c".into(), "more".into()]
                    } else {
                        vec!["cat".into()]
                    }),
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
                .unwrap()
                .id
        }
    }

    impl Drop for LiveSession {
        fn drop(&mut self) {
            let _ = self.daemon.close(self.id);
        }
    }

    #[test]
    fn hiding_releases_queued_bytes_and_keeps_attach_attempts_and_cutoffs() {
        let fixture = LiveSession::new();
        let id = fixture.id;
        let mut taps = AttachSet::new(Arc::clone(&fixture.daemon), Arc::new(Notify::new()));
        assert_eq!(taps.attach(id, Some(0)), 1);
        let tap = Arc::clone(taps.taps.get(&id).unwrap());
        let payload = vec![b'x'; 16 * 1024];
        let cutoff = 1024 * 1024;
        for offset in (0..cutoff).step_by(payload.len()) {
            tap.offer(
                offset as u64,
                payload.len(),
                &Arc::new(proto::encode_output_frame(id, offset as u64, &payload)),
            );
        }
        // A live ConPTY can also enqueue startup control sequences. The retained
        // payload is a lower bound; hide and close must still clear every byte.
        assert!(tap.queued_bytes_for_test() >= cutoff);
        taps.remove(id);
        assert_eq!(
            tap.queued_bytes_for_test(),
            0,
            "hide immediately clears queued output"
        );
        assert!(!taps.taps.contains_key(&id));
        assert_eq!(
            taps.attach(id, Some(cutoff as u64)),
            2,
            "reattach numbers remain monotonic for the live session"
        );
        let shown = taps.taps.get(&id).unwrap();
        shown.offer(
            0,
            8,
            &Arc::new(proto::encode_output_frame(id, 0, b"old-data")),
        );
        shown.offer(
            cutoff as u64,
            3,
            &Arc::new(proto::encode_output_frame(id, cutoff as u64, b"new")),
        );
        let frames = shown.drain();
        assert_eq!(frames.len(), 1);
        let Queued::Frame(frame) = &frames[0] else {
            panic!("expected output")
        };
        assert_eq!(
            proto::decode_output_frame(frame).unwrap(),
            (id, cutoff as u64, b"new".as_slice())
        );
        shown.offer(
            cutoff as u64 + 3,
            4,
            &Arc::new(proto::encode_output_frame(id, cutoff as u64 + 3, b"held")),
        );
        let retained = Arc::clone(shown);
        fixture.daemon.close(id).unwrap();
        assert_eq!(
            retained.queued_bytes_for_test(),
            0,
            "close clears output even before the connection receives removal"
        );
        taps.forget(id);
        assert!(!taps.attempts.contains_key(&id));
        taps.insert(id + 1000);
        assert!(
            !taps.taps.contains_key(&(id + 1000)),
            "invalid IDs do not allocate taps"
        );
    }

    #[tokio::test]
    async fn drained_frames_are_fed_in_order_before_a_single_flush() {
        let fixture = LiveSession::new();
        let id = fixture.id;
        let mut taps = AttachSet::new(Arc::clone(&fixture.daemon), Arc::new(Notify::new()));
        taps.insert(id);
        let tap = taps.taps.get(&id).unwrap();
        // This checks socket flushing of controlled frames, independently of PTY
        // startup output. Unregister before clearing to exclude concurrent offers.
        fixture.daemon.frame_taps().unregister(tap);
        tap.clear();
        for (offset, payload) in [(0, b"first".as_slice()), (10, b"second".as_slice())] {
            tap.offer(
                offset,
                payload.len(),
                &Arc::new(proto::encode_output_frame(id, offset, payload)),
            );
        }

        let mut sink = RecordingSink::default();
        assert!(flush_frames(&mut sink, &taps, &std::sync::atomic::AtomicU32::new(0)).await);
        assert_eq!(sink.flushes, 1);
        let payloads = sink
            .messages
            .iter()
            .map(|message| match message {
                Message::Binary(bytes) => proto::decode_output_frame(bytes).unwrap().2.to_vec(),
                other => panic!("expected binary output frame, got {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(payloads, [b"first".to_vec(), b"second".to_vec()]);
    }

    #[tokio::test]
    async fn a_flush_sends_one_turn_per_session_and_rearms_for_the_rest() {
        let fixture = LiveSession::new();
        let id = fixture.id;
        let wake = Arc::new(Notify::new());
        let mut taps = AttachSet::new(Arc::clone(&fixture.daemon), Arc::clone(&wake));
        taps.insert(id);
        let tap = taps.taps.get(&id).unwrap();
        fixture.daemon.frame_taps().unregister(tap);
        tap.clear();
        let backlog = 2 * FLUSH_TURN_BYTES + 100;
        tap.offer(
            0,
            backlog,
            &Arc::new(proto::encode_output_frame(id, 0, &vec![b'x'; backlog])),
        );

        let mut sink = RecordingSink::default();
        let mut turns = Vec::new();
        loop {
            assert!(flush_frames(&mut sink, &taps, &std::sync::atomic::AtomicU32::new(0)).await);
            let sent = std::mem::take(&mut sink.messages);
            turns.push(sent.len());
            for message in sent {
                let Message::Binary(bytes) = message else {
                    panic!("expected binary output frame, got {message:?}");
                };
                let (_, offset, payload) = proto::decode_output_frame(&bytes).unwrap();
                assert!(payload.len() <= FLUSH_TURN_BYTES);
                assert_eq!(offset as usize, (turns.len() - 1) * FLUSH_TURN_BYTES);
            }
            if wake.notified().now_or_never().is_none() {
                break;
            }
        }
        assert_eq!(turns, [1, 1, 1], "three turns cover the backlog, in order");
    }

    #[tokio::test]
    async fn the_last_typed_sessions_echo_flushes_before_flooding_neighbours() {
        let fixture = LiveSession::new();
        let quiet = fixture.id;
        let busy: Vec<u32> = (0..3)
            .map(|_| LiveSession::spawn(&fixture.daemon, fixture._state.path()))
            .collect();
        let backlog = 2 * FLUSH_TURN_BYTES + 100;
        // A fresh AttachSet per round re-seeds the HashSet, so the unordered
        // baseline rotates instead of passing every round by one lucky order.
        for round in 0..24 {
            let mut taps = AttachSet::new(Arc::clone(&fixture.daemon), Arc::new(Notify::new()));
            for id in std::iter::once(quiet).chain(busy.iter().copied()) {
                taps.insert(id);
                let tap = taps.taps.get(&id).unwrap();
                fixture.daemon.frame_taps().unregister(tap);
                tap.clear();
            }
            for id in &busy {
                taps.taps.get(id).unwrap().offer(
                    0,
                    backlog,
                    &Arc::new(proto::encode_output_frame(*id, 0, &vec![b'x'; backlog])),
                );
            }
            taps.taps.get(&quiet).unwrap().offer(
                0,
                4,
                &Arc::new(proto::encode_output_frame(quiet, 0, b"echo")),
            );
            let last_typed = Arc::new(std::sync::atomic::AtomicU32::new(quiet));
            let mut sink = RecordingSink::default();
            assert!(flush_frames(&mut sink, &taps, &last_typed).await);
            assert_eq!(
                sink.messages.len(),
                4,
                "one turn per busy neighbour plus the echo"
            );
            let mut bytes_before = 0usize;
            let mut echo = None;
            for message in &sink.messages {
                let Message::Binary(bytes) = message else {
                    panic!("expected binary output frame, got {message:?}");
                };
                let (session, _, payload) = proto::decode_output_frame(bytes).unwrap();
                if session == quiet {
                    echo = Some(payload.to_vec());
                    break;
                }
                bytes_before += payload.len();
            }
            let payload = echo
                .unwrap_or_else(|| panic!("round {round}: the typed session's echo never flushed"));
            println!("round {round}: {bytes_before} bytes precede the typed session's echo");
            assert_eq!(payload, b"echo");
            assert_eq!(
                bytes_before, 0,
                "round {round}: the typed session's echo waited behind {bytes_before} bytes \
                 of neighbour turns"
            );
        }
    }

    #[tokio::test]
    async fn accepted_tcp_sockets_enable_nodelay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut listener = listener.tap_io(enable_tcp_nodelay);
        let accept = tokio::spawn(async move {
            let (stream, _) = listener.accept().await;
            stream.nodelay().unwrap()
        });
        let _client = tokio::net::TcpStream::connect(address).await.unwrap();
        assert!(accept.await.unwrap());
    }
}

#[cfg(test)]
mod pr_surface_tests {
    use super::*;

    #[test]
    fn pr_status_batch_names_the_limit_and_requested_count() {
        assert!(check_pr_status_batch_size(MAX_PR_STATUS_BATCH_DIRS).is_ok());
        let error = check_pr_status_batch_size(MAX_PR_STATUS_BATCH_DIRS + 1)
            .unwrap_err()
            .to_string();
        assert!(error.contains("32") && error.contains("33") && error.contains("request"));
    }
}

#[cfg(test)]
mod reply_admission_tests {
    use super::*;

    fn sink(items: usize, bytes: usize) -> (ReplySink, tokio::sync::mpsc::Receiver<ControlReply>) {
        let (tx, rx) = tokio::sync::mpsc::channel(items);
        (
            ReplySink {
                tx,
                bytes: Arc::new(tokio::sync::Semaphore::new(bytes)),
                failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                wake: Arc::new(Notify::new()),
            },
            rx,
        )
    }

    #[tokio::test]
    async fn cloned_reply_senders_cannot_expand_item_or_byte_admission() {
        let (sink, mut rx) = sink(2, 10);
        sink.clone()
            .send(Message::Text("12345".into()))
            .await
            .unwrap();
        sink.clone()
            .send(Message::Text("12345".into()))
            .await
            .unwrap();
        for _ in 0..1000 {
            assert!(sink.clone().send(Message::Text("x".into())).await.is_err());
        }
        assert_eq!(rx.len(), 2);
        assert_eq!(sink.bytes.available_permits(), 0);
        let active = rx.recv().await.unwrap();
        assert_eq!(
            sink.bytes.available_permits(),
            0,
            "socket-active reply remains byte admitted"
        );
        drop(active);
        assert_eq!(sink.bytes.available_permits(), 5);
        sink.clone()
            .send(Message::Text("12345".into()))
            .await
            .unwrap();
        assert!(sink
            .clone()
            .send(Message::Text("123456".into()))
            .await
            .is_err());
        drop(rx);
        assert_eq!(sink.bytes.available_permits(), 10);
    }
}

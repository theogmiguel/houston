//! The `/ws` endpoint: one socket carries control as JSON text frames and PTY
//! bytes as binary frames, in both directions. It binds loopback only, since
//! the renderer's WebSocket API cannot dial a unix socket.
use anyhow::Result;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
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
    match request.verb {
        proto::ManageVerb::DaemonStatus => manage_json(StatusCode::OK, &daemon.manage_status()),
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
        proto::ManageVerb::DaemonShutdown | proto::ManageVerb::DaemonShutdownIfIdle => {
            let if_idle = request.verb == proto::ManageVerb::DaemonShutdownIfIdle;
            let for_shutdown = Arc::clone(&daemon);
            let result = tokio::task::spawn_blocking(move || {
                if if_idle {
                    for_shutdown.manage_shutdown_if_idle()
                } else {
                    for_shutdown.manage_shutdown()
                }
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
    let mut frames_wanted = AttachSet::new(Arc::clone(&daemon), Arc::clone(&wake));
    let conn_id = daemon.conn_register();

    let (reply_tx, mut reply_rx) = futures_channel::mpsc::channel::<Message>(CONTROL_REPLY_QUEUE);
    loop {
        tokio::select! {
            Some(reply) = reply_rx.next() => {
                if sink.send(reply).await.is_err() {
                    break;
                }
            }
            _ = wake.notified() => {
                if !flush_frames(&mut sink, &frames_wanted).await {
                    break;
                }
            }
            out = rx.recv() => match out {
                Ok(Outbound::Frame(_)) => {
                }
                Ok(Outbound::Control(json)) => {
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
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    handle_control(&daemon, &mut sink, &reply_tx, &text, &mut frames_wanted, conn_id)
                        .await;
                }
                Some(Ok(Message::Binary(buf))) => {
                    if let Some((id, payload)) = proto::decode_stdin_frame(&buf) {
                        daemon.note_operator_keystroke(id);
                        if let Err(e) = daemon.write_stdin(id, payload) {
                            send_error(&mut sink, e.to_string(), Some("stdin".into())).await;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::debug!("client socket error: {e}");
                    break;
                }
            },
        }
    }
    daemon.conn_forget(conn_id);
}

async fn flush_frames(sink: &mut (impl SinkExt<Message> + Unpin), taps: &AttachSet) -> bool {
    for tap in taps.taps() {
        let Some(session) = tap.session() else {
            continue;
        };
        for item in tap.drain() {
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
            if sink.send(Message::Binary(bytes)).await.is_err() {
                return false;
            }
        }
    }
    true
}

struct AttachSet {
    taps: std::collections::HashMap<u32, Arc<FrameTap>>,
    visible: std::collections::HashSet<u32>,
    daemon: Arc<Daemon>,
    wake: Arc<Notify>,
}

impl AttachSet {
    fn new(daemon: Arc<Daemon>, wake: Arc<Notify>) -> Self {
        Self {
            taps: std::collections::HashMap::new(),
            visible: std::collections::HashSet::new(),
            daemon,
            wake,
        }
    }

    fn insert(&mut self, session: u32) {
        if !self.visible.insert(session) {
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
        if let Some(tap) = self.taps.get(&session) {
            self.daemon.frame_taps().unregister(tap);
        }
        self.daemon.ws_detach(session);
    }

    fn attach(&mut self, session: u32, bytes_seen: Option<u64>) -> u32 {
        self.insert(session);
        self.taps
            .get(&session)
            .map(|tap| tap.attach(bytes_seen))
            .unwrap_or(0)
    }

    fn taps(&self) -> Vec<Arc<FrameTap>> {
        self.visible
            .iter()
            .filter_map(|id| self.taps.get(id).cloned())
            .collect()
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
            | proto::ClientMsg::GitStatus { .. }
            | proto::ClientMsg::GitDiff { .. }
            | proto::ClientMsg::HistoryCount
            | proto::ClientMsg::GitBranch { .. }
            | proto::ClientMsg::PrStatus { .. }
            | proto::ClientMsg::PrDetail { .. }
            | proto::ClientMsg::GitReviewDiffs { .. }
            | proto::ClientMsg::GitBranches { .. }
            | proto::ClientMsg::GitWorktrees { .. }
            | proto::ClientMsg::GitCheckpoints { .. }
            | proto::ClientMsg::GitCheckpointDiff { .. }
            | proto::ClientMsg::SshProfileList
            | proto::ClientMsg::SshConfigHosts
            | proto::ClientMsg::SessionPolicyGet
            | proto::ClientMsg::UpdateGet
            | proto::ClientMsg::KeymapGet
            | proto::ClientMsg::WaitForIdle { .. }
            | proto::ClientMsg::BrowserToolResult { .. }
            | proto::ClientMsg::InboxList { .. }
    )
}

// How many replies one connection's off-task handlers may queue before
// they wait on the socket: a reconnect burst is a few dozen, so 256 leaves
// headroom without letting a stalled socket hoard memory behind it.
const CONTROL_REPLY_QUEUE: usize = 256;

// Attach-family messages run on the connection task because they mutate its
// own `AttachSet`; everything else runs off-task. An awaited handler would
// hold frame flushing and resize acks, leaving the CLI in an 80x24 box.
fn runs_on_connection_task(msg: &proto::ClientMsg) -> bool {
    matches!(
        msg,
        proto::ClientMsg::SessionCreate { .. }
            | proto::ClientMsg::SessionRespawn { .. }
            | proto::ClientMsg::SessionAttach { .. }
            | proto::ClientMsg::SessionVisibility { .. }
    )
}

async fn handle_control(
    daemon: &Arc<Daemon>,
    sink: &mut (impl SinkExt<Message> + Unpin),
    reply_tx: &futures_channel::mpsc::Sender<Message>,
    text: &str,
    frames_wanted: &mut AttachSet,
    conn_id: u64,
) {
    let msg: proto::ClientMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            send_error(
                sink,
                format!("unparseable control message: {e}"),
                Some(text.chars().take(200).collect()),
            )
            .await;
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

    if runs_on_connection_task(&msg) {
        let result = dispatch(daemon, sink, msg, Some(frames_wanted), conn_id).await;
        report(sink, result).await;
        return;
    }
    let daemon = Arc::clone(daemon);
    let mut tx = reply_tx.clone();
    tokio::spawn(async move {
        let result = dispatch(&daemon, &mut tx, msg, None, conn_id).await;
        report(&mut tx, result).await;
    });
}

async fn report(sink: &mut (impl SinkExt<Message> + Unpin), result: anyhow::Result<()>) {
    if let Err(e) = result {
        let msg = format!("{e:#}");
        tracing::warn!("control request failed: {msg}");
        send_error(sink, msg, None).await;
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
        proto::ClientMsg::Hello { .. } => Err(anyhow::anyhow!("already authenticated")),
        proto::ClientMsg::SessionCreate {
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
        } => {
            let frames_wanted =
                frames_wanted.expect("an attach-family message runs on the connection task");
            let daemon = Arc::clone(daemon);
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
            };
            tokio::task::spawn_blocking(move || daemon.create_session(params))
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("create task panicked: {e}")))
                .map(|info| {
                    frames_wanted.insert(info.id);
                })
        }
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
            let daemon = Arc::clone(daemon);
            let result = tokio::task::spawn_blocking(move || daemon.resize(session, cols, rows))
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
        proto::ClientMsg::UsageSummaryGet {
            since_ms,
            until_ms,
            refresh_pricing,
        } => {
            let daemon = Arc::clone(daemon);
            match tokio::task::spawn_blocking(move || {
                daemon.usage_summary(since_ms, until_ms, refresh_pricing)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("usage scan panicked: {e}")))
            {
                Ok(msg) => {
                    let _ = send_msg(sink, &msg).await;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        proto::ClientMsg::RestoreBudgetSet { budget } => daemon
            .set_restore_budget(budget)
            .map(|_| daemon.broadcast_control(&daemon.host_info())),
        proto::ClientMsg::MailboxRetentionSet { hours } => daemon
            .set_mailbox_retention_hours(hours)
            .map(|_| daemon.broadcast_control(&daemon.host_info())),
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
        proto::ClientMsg::AgentHooks => {
            let models = Arc::clone(daemon);
            tokio::spawn(async move { models.refresh_model_catalog(false).await });
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                let providers = daemon.agent_hooks_state_rescanned();
                daemon.send_control_to(conn_id, &proto::ServerMsg::AgentHooks { providers });
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
            daemon.broadcast_control(&daemon.voice_model_delete(&model_id));
            daemon.broadcast_control(&daemon.voice_settings_reply());
            Ok(())
        }
        proto::ClientMsg::VoiceLevelMonitor { enabled } => {
            daemon.voice_level_monitor(conn_id, enabled);
            Ok(())
        }
        proto::ClientMsg::SessionAttach {
            session,
            replay_bytes,
            snapshot,
        } => {
            let frames_wanted =
                frames_wanted.expect("an attach-family message runs on the connection task");
            frames_wanted.insert(session);
            let taken = if snapshot == Some(true) {
                daemon
                    .attach_snapshot(session)
                    .inspect_err(|e| {
                        tracing::warn!(
                            "session {session}: no snapshot for this attach ({e}); replying \
                             with a byte replay instead"
                        );
                    })
                    .ok()
            } else {
                None
            };
            if let Some(taken) = taken {
                let attempt = frames_wanted.attach(session, Some(taken.output_offset));
                let state = base64::engine::general_purpose::STANDARD.encode(taken.state);
                let _ = send_msg(
                    sink,
                    &proto::ServerMsg::AttachSnapshot {
                        session,
                        generation: taken.generation,
                        attempt,
                        output_offset: taken.output_offset,
                        format_version: taken.format_version,
                        state,
                    },
                )
                .await;
                Ok(())
            } else {
                match daemon.scrollback(session, replay_bytes) {
                    Ok(replay) => {
                        let attempt = frames_wanted.attach(session, Some(replay.bytes_seen));
                        let data = base64::engine::general_purpose::STANDARD.encode(replay.data);
                        let _ = send_msg(
                            sink,
                            &proto::ServerMsg::Scrollback {
                                session,
                                data,
                                generation: replay.generation,
                                replayed_bytes: replay.replayed_bytes,
                                bytes_seen: replay.bytes_seen,
                                attempt,
                            },
                        )
                        .await;
                        Ok(())
                    }
                    Err(e) => {
                        frames_wanted.attach(session, None);
                        Err(e)
                    }
                }
            }
        }
        proto::ClientMsg::SessionRespawn {
            session,
            shell_integration,
            cwd,
            shell,
            force,
        } => {
            let frames_wanted =
                frames_wanted.expect("an attach-family message runs on the connection task");
            let daemon = Arc::clone(daemon);
            tokio::task::spawn_blocking(move || {
                daemon.respawn(
                    session,
                    shell_integration.unwrap_or(true),
                    cwd.map(PathBuf::from),
                    shell,
                    force.unwrap_or(false),
                )
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("respawn task panicked: {e}")))
            .map(|info| {
                frames_wanted.insert(info.id);
            })
        }
        proto::ClientMsg::SessionCwd { session } => match daemon.session_cwd(session) {
            Ok(cwd) => {
                let _ = send_msg(sink, &proto::ServerMsg::SessionCwd { session, cwd }).await;
                Ok(())
            }
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
            let branch = tokio::task::spawn_blocking(move || crate::git::branch(&d))
                .await
                .unwrap_or(None);
            let _ = send_msg(sink, &proto::ServerMsg::GitBranch { dir, branch }).await;
            Ok(())
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
        proto::ClientMsg::GitCommit { dir, message } => {
            let d = PathBuf::from(&dir);
            match tokio::task::spawn_blocking(move || crate::git::commit(&d, &message))
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
            let st = tokio::task::spawn_blocking(move || crate::gh::pr_status(&d))
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
            request,
        } => {
            send_pr_list(sink, dir, state, involvement, query, limit, request).await;
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
                Ok(wt) => {
                    let _ = send_msg(
                        sink,
                        &proto::ServerMsg::GitWorktrees {
                            dir,
                            worktrees: Vec::new(),
                            message: Some(format!(
                                "Created worktree at {} (branch {}).",
                                wt.path.display(),
                                wt.branch.as_deref().unwrap_or("detached")
                            )),
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
            let result =
                tokio::task::spawn_blocking(move || crate::worktrees::remove(&d, &wt, force))
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
        } => {
            let mut params = crate::ssh::SshParams {
                host,
                port: port.unwrap_or(22),
                user,
                auth,
                cols: cols.unwrap_or(80),
                rows: rows.unwrap_or(24),
                config_identity: None,
            };
            if matches!(params.auth, proto::SshAuth::SshConfig) {
                crate::ssh::apply_ssh_config(&mut params);
            }
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
                    keyring_error: crate::ssh_credentials::keyring_error(),
                });
                Ok(())
            }
            Err(e) => Err(e),
        },
        proto::ClientMsg::SshProfileDelete { name } => match daemon.ssh_profile_delete(&name) {
            Ok(profiles) => {
                daemon.broadcast_control(&proto::ServerMsg::SshProfiles {
                    profiles,
                    keyring_error: crate::ssh_credentials::keyring_error(),
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
                        keyring_error: crate::ssh_credentials::keyring_error(),
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
                        keyring_error: crate::ssh_credentials::keyring_error(),
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
                        keyring_error: crate::ssh_credentials::keyring_error(),
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
        } => daemon.wait_for_idle(request, session, timeout_ms, idle_quiet_ms),
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
        proto::ClientMsg::BrowserToolResult {
            request_id,
            ok,
            output,
            error,
        } => {
            daemon
                .browser_relay
                .deliver_result(request_id, ok, output, error);
            Ok(())
        }
    }
}

async fn send_git_status(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    base: Option<String>,
) -> anyhow::Result<()> {
    let d = PathBuf::from(&dir);
    let b = base.clone();
    let (files, sync, default_base) = tokio::task::spawn_blocking(move || {
        let files = match b.as_deref() {
            Some(base) => crate::git::status_vs_base(&d, base)?,
            None => crate::git::status(&d)?,
        };
        let sync = crate::git::sync(&d);
        let default_base = crate::git::default_base(&d);
        anyhow::Ok((files, sync, default_base))
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("git status task panicked: {e}")))?;
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

async fn send_pr_list(
    sink: &mut (impl SinkExt<Message> + Unpin),
    dir: String,
    state: proto::PrListState,
    involvement: proto::PrListInvolvement,
    query: Option<String>,
    limit: u32,
    request: u32,
) {
    let d = PathBuf::from(&dir);
    let result = tokio::task::spawn_blocking(move || {
        crate::gh::pr_list(&d, state, involvement, query.as_deref(), limit)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("pull request listing task panicked: {e}")));
    let (items, truncated, message) = match result {
        Ok((items, truncated)) => (items, truncated, None),
        Err(e) => (Vec::new(), false, Some(e.to_string())),
    };
    let _ = send_msg(
        sink,
        &proto::ServerMsg::PrList {
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

#[derive(Deserialize)]
struct SpawnBody {
    kind: proto::AgentKind,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    prompt: String,
    // Approval bypass for a delegated child: on by default, opposite of the
    // operator's own `session_create` default, because a child has nobody at
    // its keyboard. Absent keeps the CLI's auto mode; `true` is the bypass.
    #[serde(default)]
    auto_approve: Option<bool>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    target_workspace: Option<String>,
    #[serde(default)]
    reusable: bool,
    #[serde(default)]
    effort: Option<proto::ChatEffort>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    boundaries: Option<String>,
}

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
    let result = tokio::task::spawn_blocking(move || {
        daemon.orchestrate_spawn_with_options(
            scope.session_id,
            body.kind,
            body.model,
            body.cwd,
            crate::orchestrate::Brief {
                prompt: body.prompt,
                output_format: body.output_format,
                boundaries: body.boundaries,
            },
            body.auto_approve,
            body.profile,
            body.role,
            body.target_workspace,
            body.reusable,
            body.effort,
        )
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!("orchestrate spawn panicked: {e}")));
    match result {
        Ok(info) => (
            StatusCode::OK,
            axum::Json(json!({
                "session_id": info.id,
                "title": info.title,
                "codename": info.codename,
                "workspace": info.project_dir,
                "reusable": reusable,
            })),
        )
            .into_response(),
        Err(e) => orch_err_response(e),
    }
}

#[derive(Deserialize)]
struct PromptBody {
    session: u32,
    text: String,
}

async fn orch_prompt(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PromptBody>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let (source, status) =
        match daemon.orchestrate_prompt(scope.session_id, body.session, &body.text) {
            Ok(v) => v,
            Err(e) => return orch_err_response(e),
        };
    (
        StatusCode::OK,
        axum::Json(json!({
            "queued": true,
            "status_source": source,
            "status_after": status,
        })),
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
    let outcome = daemon
        .orchestrate_wait(
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
            waited_ms,
        } => {
            let wire_rows: Vec<proto::InboxRow> = rows.into_iter().map(Into::into).collect();
            (
                StatusCode::OK,
                axum::Json(json!({
                    "rows": wire_rows,
                    "delivery_id": delivery_id,
                    "has_more": has_more,
                    "waited_ms": waited_ms,
                })),
            )
                .into_response()
        }
        InboxWaitOutcome::TimedOut {
            waited_ms,
            status,
            status_source,
        } => (
            StatusCode::REQUEST_TIMEOUT,
            axum::Json(json!({
                "rows": [],
                "timed_out": true,
                "waited_ms": waited_ms,
                "status": status,
                "status_source": status_source,
            })),
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
struct SubmitBody {
    body: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    artifacts: Vec<String>,
    #[serde(default)]
    request_id: Option<u32>,
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

//! The daemon's side of remote access: persisted settings, the listener loop,
//! pairing, and the observe-and-answer operations the HTTP API exposes.
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use houston_protocol as proto;
use serde::Serialize;

use super::{now_ms, Daemon};
use crate::db::RemoteDeviceRow;
use crate::remote::{self, ApiError, Config, ConfigPatch, ListenState, NotifyDetail};

const BIND_BACKOFF_START: Duration = Duration::from_secs(1);
// A retiring generation releases the port within seconds; 30 s bounds the
// retry cost when another program holds it for good.
const BIND_BACKOFF_MAX: Duration = Duration::from_secs(30);
// Matches the paste path: a TUI that sees text and Enter in one read treats the
// Enter as part of a paste instead of a submit.
const INPUT_SETTLE: Duration = Duration::from_millis(40);

#[derive(Debug, Clone)]
pub struct RemotePairing {
    pub url: String,
    pub code: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteWorkspace {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteSession {
    pub id: u32,
    pub title: String,
    pub workspace: RemoteWorkspace,
    pub kind: proto::AgentKind,
    pub state: proto::SessionState,
    pub status: Option<proto::AgentStatus>,
    pub reason: Option<String>,
    pub status_since: Option<u64>,
}

impl Daemon {
    /// The current remote configuration, read from the settings table once.
    pub fn remote_config(&self) -> Config {
        let mut slot = self.remote.config.lock().expect("remote config lock");
        if let Some(cfg) = slot.as_ref() {
            return cfg.clone();
        }
        let cfg = self.remote_config_from_db();
        *slot = Some(cfg.clone());
        cfg
    }

    fn remote_config_from_db(&self) -> Config {
        let get = |key: &str| self.db.get_setting(key).ok().flatten();
        let default = Config::default();
        Config {
            enabled: get(remote::KEY_ENABLED).as_deref() == Some("1"),
            bind: get(remote::KEY_BIND)
                .and_then(|v| remote::parse_bind(&v).ok())
                .unwrap_or(default.bind),
            public_url: get(remote::KEY_PUBLIC_URL)
                .and_then(|v| remote::parse_public_url(&v).ok().flatten()),
            notify_delay_secs: get(remote::KEY_NOTIFY_DELAY)
                .and_then(|v| v.parse().ok())
                .and_then(|v| remote::validate_notify_delay(v).ok())
                .unwrap_or(default.notify_delay_secs),
            notify_detail: get(remote::KEY_NOTIFY_DETAIL)
                .and_then(|v| NotifyDetail::parse(&v).ok())
                .unwrap_or(default.notify_detail),
            notify_finished: get(remote::KEY_NOTIFY_FINISHED).as_deref() == Some("1"),
            ntfy_server: get(remote::KEY_NTFY_SERVER).filter(|v| !v.is_empty()),
        }
    }

    /// Validates every field before persisting any, so a refused patch changes nothing.
    pub fn remote_configure(&self, patch: ConfigPatch) -> Result<()> {
        let mut next = self.remote_config();
        if let Some(enabled) = patch.enabled {
            next.enabled = enabled;
        }
        if let Some(bind) = &patch.bind {
            next.bind = remote::parse_bind(bind).map_err(|e| anyhow!(e))?;
        }
        if let Some(url) = &patch.public_url {
            next.public_url = remote::parse_public_url(url).map_err(|e| anyhow!(e))?;
        }
        if let Some(secs) = patch.notify_delay_secs {
            next.notify_delay_secs = remote::validate_notify_delay(secs).map_err(|e| anyhow!(e))?;
        }
        if let Some(detail) = &patch.notify_detail {
            next.notify_detail = NotifyDetail::parse(detail).map_err(|e| anyhow!(e))?;
        }
        if let Some(finished) = patch.notify_finished {
            next.notify_finished = finished;
        }
        let ntfy = match &patch.ntfy_url {
            Some(raw) => Some(remote::parse_ntfy_url(raw).map_err(|e| anyhow!(e))?),
            None => None,
        };
        if let Some(url) = &ntfy {
            match url {
                Some(url) => remote::ntfy::store_url(&self.state_dir, url)?,
                None => remote::ntfy::delete_url(&self.state_dir)?,
            }
            next.ntfy_server = url.as_deref().and_then(remote::ntfy_server);
            *self.remote.ntfy_url.lock().expect("remote ntfy lock") =
                url.clone().map(zeroize::Zeroizing::new);
        }
        let flag = |b: bool| if b { "1" } else { "0" };
        self.db
            .set_setting(remote::KEY_ENABLED, flag(next.enabled))?;
        self.db
            .set_setting(remote::KEY_BIND, &next.bind.to_string())?;
        self.db.set_setting(
            remote::KEY_PUBLIC_URL,
            next.public_url.as_deref().unwrap_or(""),
        )?;
        self.db.set_setting(
            remote::KEY_NOTIFY_DELAY,
            &next.notify_delay_secs.to_string(),
        )?;
        self.db
            .set_setting(remote::KEY_NOTIFY_DETAIL, next.notify_detail.as_str())?;
        self.db
            .set_setting(remote::KEY_NOTIFY_FINISHED, flag(next.notify_finished))?;
        self.db.set_setting(
            remote::KEY_NTFY_SERVER,
            next.ntfy_server.as_deref().unwrap_or(""),
        )?;
        *self.remote.config.lock().expect("remote config lock") = Some(next);
        self.remote.reconfigured.send_modify(|n| *n += 1);
        self.remote_broadcast_state();
        Ok(())
    }

    /// Settings > Remote access: the configured values, listener state and devices.
    pub fn remote_state_msg(&self) -> proto::ServerMsg {
        let cfg = self.remote_config();
        let listen = self.remote_listen_state();
        let devices = self
            .db
            .remote_devices()
            .unwrap_or_else(|e| {
                tracing::warn!("remote access: reading paired devices: {e}");
                Vec::new()
            })
            .into_iter()
            .map(|d| proto::RemoteDevice {
                id: d.id,
                name: d.name,
                created_at: d.created_at,
                last_seen_at: d.last_seen_at,
            })
            .collect();
        proto::ServerMsg::RemoteState {
            remote: proto::RemoteInfo {
                enabled: cfg.enabled,
                bind: cfg.bind.to_string(),
                url: cfg.effective_url(),
                public_url: cfg.public_url.clone(),
                listening: listen.listening.is_some(),
                error: listen.error,
                ntfy_server: cfg.ntfy_server.clone(),
                notify_delay_secs: cfg.notify_delay_secs,
                notify_detail: match cfg.notify_detail {
                    NotifyDetail::Generic => proto::RemoteNotifyDetail::Generic,
                    NotifyDetail::PaneName => proto::RemoteNotifyDetail::PaneName,
                },
                notify_finished: cfg.notify_finished,
                devices,
            },
        }
    }

    fn remote_broadcast_state(&self) {
        self.broadcast_control(&self.remote_state_msg());
    }

    /// The pairing link and its QR code for Settings; any earlier code stops working.
    pub fn remote_pairing_msg(&self) -> Result<proto::ServerMsg> {
        let pairing = self.remote_pair_start();
        Ok(proto::ServerMsg::RemotePairing {
            qr_svg: remote::qr::svg(&pairing.url)?,
            url: pairing.url,
            expires_at: pairing.expires_at_ms,
        })
    }

    pub fn remote_listen_state(&self) -> ListenState {
        self.remote.listen_state()
    }

    fn remote_set_listen(&self, state: ListenState) {
        {
            let mut slot = self.remote.listen.lock().expect("remote listen lock");
            if *slot == state {
                return;
            }
            if let Some(error) = &state.error {
                tracing::warn!("remote access: {error}");
            } else if let Some(addr) = state.listening {
                tracing::info!("remote access listening on {addr}");
            }
            *slot = state;
        }
        self.remote_broadcast_state();
    }

    /// A one-time code for the URL fragment; it never reaches a proxy log.
    pub fn remote_pair_start(&self) -> RemotePairing {
        let code = self.remote.start_pairing(Instant::now());
        let url = format!("{}/#pair={code}", self.remote_config().effective_url());
        RemotePairing {
            url,
            code,
            expires_at_ms: now_ms() + remote::PAIRING_TTL.as_millis() as u64,
        }
    }

    pub fn remote_devices(&self) -> Result<Vec<RemoteDeviceRow>> {
        self.db.remote_devices()
    }

    pub fn remote_device_revoke(&self, id: i64) -> Result<()> {
        if !self.db.remote_device_delete(id)? {
            anyhow::bail!("no paired device has id {id}: expected an id from the device list");
        }
        self.remote
            .last_seen_written
            .lock()
            .expect("remote last-seen lock")
            .remove(&id);
        self.remote_broadcast_state();
        Ok(())
    }

    pub(crate) fn remote_authenticate(&self, raw_token: &str) -> Option<RemoteDeviceRow> {
        let row = self
            .db
            .remote_device_by_hash(&remote::hash_secret(raw_token))
            .unwrap_or_else(|e| {
                tracing::warn!("remote access: reading paired devices: {e}");
                None
            })?;
        let now = now_ms();
        let due = {
            let mut written = self
                .remote
                .last_seen_written
                .lock()
                .expect("remote last-seen lock");
            let last = written
                .get(&row.id)
                .copied()
                .or(row.last_seen_at)
                .unwrap_or(0);
            let due = now.saturating_sub(last) >= remote::LAST_SEEN_WRITE_INTERVAL_MS;
            if due {
                written.insert(row.id, now);
            }
            due
        };
        if due {
            if let Err(e) = self.db.remote_device_touch(row.id, now) {
                tracing::warn!(
                    "remote access: recording last-seen for device {}: {e}",
                    row.id
                );
            }
            self.remote_broadcast_state();
        }
        Some(row)
    }

    pub(crate) fn remote_pair(
        &self,
        code: &str,
        device_name: &str,
    ) -> Result<(String, i64), ApiError> {
        let name = remote::validate_device_name(device_name).map_err(ApiError::BadRequest)?;
        self.remote
            .redeem_pairing(code, Instant::now())
            .map_err(|e| ApiError::Unauthorized(e.to_string()))?;
        let token = remote::mint_secret();
        let id = self
            .db
            .remote_device_insert(&name, &remote::hash_secret(&token), now_ms())
            .map_err(|e| ApiError::Internal(format!("recording the paired device: {e}")))?;
        tracing::info!("remote access: paired device {id}");
        self.remote_broadcast_state();
        Ok((token, id))
    }

    pub fn remote_sessions(&self) -> Vec<RemoteSession> {
        let workspaces = self.db.list_workspaces().unwrap_or_default();
        let mut out: Vec<RemoteSession> = self
            .list()
            .into_iter()
            .filter(|info| !info.hidden)
            .map(|info| {
                let workspace = workspaces
                    .iter()
                    .find(|w| w.path == info.project_dir)
                    .map(|w| RemoteWorkspace {
                        name: w.name.clone(),
                        path: w.path.clone(),
                    })
                    .unwrap_or_else(|| RemoteWorkspace {
                        name: std::path::Path::new(&info.project_dir)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| info.project_dir.clone()),
                        path: info.project_dir.clone(),
                    });
                let seen = self
                    .remote
                    .seen(info.id)
                    .filter(|s| Some(s.status) == info.status);
                RemoteSession {
                    id: info.id,
                    title: info.title.clone(),
                    workspace,
                    kind: info.detected_agent.unwrap_or(info.agent),
                    state: info.state,
                    status: info.status,
                    reason: None,
                    status_since: seen.map(|s| s.since_ms),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            remote::status_rank(a.status, a.state.is_live())
                .cmp(&remote::status_rank(b.status, b.state.is_live()))
                .then_with(|| a.workspace.name.cmp(&b.workspace.name))
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    fn remote_target(&self, id: u32) -> Result<Arc<super::Session>, ApiError> {
        match self.get(id) {
            Ok(s) if !s.info.hidden => Ok(s),
            _ => Err(ApiError::NotFound(format!(
                "no pane has id {id}: expected an id from /api/sessions"
            ))),
        }
    }

    /// The same text extraction `pane_read` uses. It never attaches, so it
    /// answers no terminal query and never resizes the PTY.
    pub fn remote_screen(&self, id: u32, lines: usize) -> Result<Vec<String>, ApiError> {
        if lines == 0 || lines > remote::SCREEN_LINES_MAX {
            return Err(ApiError::BadRequest(format!(
                "lines={lines} is out of range: expected 1 to {}",
                remote::SCREEN_LINES_MAX
            )));
        }
        let s = self.remote_target(id)?;
        Ok(crate::orchestrate::cap_read_tail(
            self.session_screen(&s, lines),
            lines,
        ))
    }

    /// Text first, then keys, through the desktop's stdin path. Multi-line text
    /// goes as a bracketed paste so a newline does not submit it early.
    pub fn remote_input(
        &self,
        id: u32,
        text: Option<&str>,
        keys: &[String],
    ) -> Result<(), ApiError> {
        let text = text
            .map(remote::validate_input_text)
            .transpose()
            .map_err(ApiError::BadRequest)?
            .filter(|t| !t.is_empty());
        let key_bytes = remote::keys_to_bytes(keys).map_err(ApiError::BadRequest)?;
        if text.is_none() && key_bytes.is_empty() {
            return Err(ApiError::BadRequest(
                "nothing to send: expected non-empty `text`, `keys`, or both".to_string(),
            ));
        }
        let s = self.remote_target(id)?;
        if !s.state.lock().expect("state lock").is_live() {
            return Err(ApiError::Conflict(format!(
                "pane {id} is not running: input needs a live pane"
            )));
        }
        let write = |bytes: &[u8]| -> Result<(), ApiError> {
            self.note_operator_keystroke(id, bytes);
            self.write_stdin_from_renderer(id, bytes)
                .map_err(|e| ApiError::Conflict(format!("writing to pane {id}: {e}")))
        };
        if let Some(text) = &text {
            if text.contains('\n') {
                write(&super::bracketed_paste(text))?;
            } else {
                write(text.as_bytes())?;
            }
            if !key_bytes.is_empty() {
                std::thread::sleep(INPUT_SETTLE);
            }
        }
        if !key_bytes.is_empty() {
            write(&key_bytes)?;
        }
        Ok(())
    }

    pub(crate) fn remote_note_status(&self, id: u32, status: proto::AgentStatus) {
        self.remote.note_status(id, status, now_ms());
    }

    /// Idle until Settings > Remote access turns the listener on; re-binds when
    /// the bind address changes.
    pub async fn remote_loops(self: Arc<Self>) {
        let rx = self
            .remote
            .status_rx
            .lock()
            .expect("remote status rx lock")
            .take();
        let Some(rx) = rx else {
            tracing::warn!("remote access: the loops are already running; ignoring a second start");
            return;
        };
        tokio::join!(
            Arc::clone(&self).remote_listen_loop(),
            Arc::clone(&self).remote_notify_loop(rx)
        );
    }

    async fn remote_listen_loop(self: Arc<Self>) {
        let mut changes = self.remote.reconfigured.subscribe();
        let mut backoff = BIND_BACKOFF_START;
        loop {
            changes.borrow_and_update();
            let cfg = self.remote_config();
            if !cfg.enabled {
                self.remote_set_listen(ListenState::default());
                if changes.changed().await.is_err() {
                    return;
                }
                continue;
            }
            match tokio::net::TcpListener::bind(cfg.bind).await {
                Ok(listener) => {
                    backoff = BIND_BACKOFF_START;
                    self.remote_set_listen(ListenState {
                        listening: listener.local_addr().ok(),
                        error: None,
                    });
                    let this = Arc::clone(&self);
                    let mut watch = changes.clone();
                    let bind = cfg.bind;
                    let shutdown = async move {
                        loop {
                            if watch.changed().await.is_err() {
                                std::future::pending::<()>().await;
                            }
                            let now = this.remote_config();
                            if !now.enabled || now.bind != bind {
                                return;
                            }
                        }
                    };
                    let app = remote::http::router(Arc::clone(&self));
                    if let Err(e) = axum::serve(listener, app)
                        .with_graceful_shutdown(shutdown)
                        .await
                    {
                        self.remote_set_listen(ListenState {
                            listening: None,
                            error: Some(format!("the listener on {bind} stopped: {e}")),
                        });
                        tokio::time::sleep(backoff).await;
                    }
                }
                Err(e) => {
                    self.remote_set_listen(ListenState {
                        listening: None,
                        error: Some(format!("cannot listen on {}: {e}", cfg.bind)),
                    });
                    tokio::select! {
                        changed = changes.changed() => {
                            if changed.is_err() {
                                return;
                            }
                            backoff = BIND_BACKOFF_START;
                        }
                        _ = tokio::time::sleep(backoff) => {
                            backoff = (backoff * 2).min(BIND_BACKOFF_MAX);
                        }
                    }
                }
            }
        }
    }

    /// The topic URL from the in-memory cache, else the keychain. Only called
    /// once a notification is due, so a daemon without ntfy never asks the keychain.
    async fn remote_ntfy_url(self: &Arc<Self>) -> Option<zeroize::Zeroizing<String>> {
        if let Some(url) = self
            .remote
            .ntfy_url
            .lock()
            .expect("remote ntfy lock")
            .clone()
        {
            return Some(url);
        }
        let state_dir = self.state_dir.clone();
        match tokio::task::spawn_blocking(move || remote::ntfy::load_url(&state_dir)).await {
            Ok(Ok(Some(url))) => {
                *self.remote.ntfy_url.lock().expect("remote ntfy lock") = Some(url.clone());
                Some(url)
            }
            Ok(Ok(None)) => {
                tracing::warn!(
                    "remote access: ntfy is configured but the keychain holds no topic URL"
                );
                None
            }
            Ok(Err(e)) => {
                tracing::warn!("remote access: {e:#}");
                None
            }
            Err(e) => {
                tracing::warn!("remote access: reading the ntfy topic URL panicked: {e}");
                None
            }
        }
    }

    /// One timer per status transition; the epoch check makes it a no-op once
    /// the pane has moved on, which is the debounce and the desktop-answer case.
    async fn remote_notify_loop(
        self: Arc<Self>,
        mut rx: tokio::sync::mpsc::Receiver<remote::StatusEvent>,
    ) {
        let client = match reqwest::Client::builder()
            .timeout(remote::ntfy::SEND_TIMEOUT)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    "remote access: building the ntfy client failed, notifications are off: {e}"
                );
                return;
            }
        };
        while let Some(ev) = rx.recv().await {
            let cfg = self.remote_config();
            if !cfg.enabled || cfg.ntfy_server.is_none() {
                continue;
            }
            let kind = match (ev.from, ev.to) {
                (_, proto::AgentStatus::NeedsInput) => remote::ntfy::Kind::NeedsInput,
                (Some(proto::AgentStatus::Working), proto::AgentStatus::Idle)
                    if cfg.notify_finished =>
                {
                    remote::ntfy::Kind::Finished
                }
                _ => continue,
            };
            let this = Arc::clone(&self);
            let client = client.clone();
            let delay = Duration::from_secs(u64::from(cfg.notify_delay_secs));
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if this.remote.seen(ev.session).map(|s| s.epoch) != Some(ev.epoch) {
                    return;
                }
                let Ok(session) = this.get(ev.session) else {
                    return;
                };
                if session.info.hidden || !session.state.lock().expect("state lock").is_live() {
                    return;
                }
                let title = session.title.lock().expect("title lock").clone();
                let cfg = this.remote_config();
                if !cfg.enabled || cfg.ntfy_server.is_none() {
                    return;
                }
                let Some(url) = this.remote_ntfy_url().await else {
                    return;
                };
                let msg = remote::ntfy::compose(
                    kind,
                    cfg.notify_detail,
                    &title,
                    &cfg.effective_url(),
                    ev.session,
                );
                let server = cfg.ntfy_server.as_deref().unwrap_or("ntfy");
                match remote::ntfy::send(&client, &url, &msg).await {
                    Ok(()) => {
                        tracing::info!("remote access: notified {server} about pane {}", ev.session)
                    }
                    Err(e) => tracing::warn!(
                        "remote access: notifying {server} about pane {} failed: {e}",
                        ev.session
                    ),
                }
            });
        }
    }
}

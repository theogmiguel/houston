//! The daemon's side of remote access: persisted settings, the listener loop,
//! pairing, and the observe-and-answer operations the HTTP API exposes.
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use houston_protocol as proto;
use serde::Serialize;

use super::{now_ms, Daemon};
use crate::db::RemoteDeviceRow;
use crate::remote::feed::{self, Answered, Card, Change, FeedItem, HookFeed, Pending, Refusal};
use crate::remote::{self, tls, ApiError, Config, ConfigPatch, ListenState, NotifyDetail};

const BIND_BACKOFF_START: Duration = Duration::from_secs(1);
// A retiring generation releases the port within seconds; 30 s bounds the
// retry cost when another program holds it for good.
const BIND_BACKOFF_MAX: Duration = Duration::from_secs(30);
// Once the listener is told to stop, event streams end at once and other
// requests finish within a second; one that takes longer is left to finish on
// its own connection rather than hold up a re-bind.
const LISTENER_DRAIN: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct RemotePairing {
    pub url: String,
    pub code: String,
    pub expires_at_ms: u64,
}

/// A pane's text for a device; `source` is `screen` from the emulator, or
/// `scrollback` (raw output tail) where this build has no emulator.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteScreen {
    pub lines: Vec<String>,
    pub source: &'static str,
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
    pub parent: Option<u32>,
    pub role: Option<String>,
    pub workspace: RemoteWorkspace,
    pub kind: proto::AgentKind,
    pub state: proto::SessionState,
    pub status: Option<proto::AgentStatus>,
    pub reason: Option<String>,
    pub status_since: Option<u64>,
    /// The decision card the pane waits on, while it needs input.
    pub pending: Option<feed::PendingView>,
    pub waiting_since: Option<u64>,
    pub last_reply_excerpt: Option<String>,
    pub last_step: Option<String>,
}

/// A device's recording, transcribed and assembled as the desktop would insert it.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDictation {
    pub text: String,
    pub engine: String,
    pub translated: bool,
}

/// A voice failure as a device reads it; the desktop shows the same facts.
fn dictation_refusal(failure: proto::VoiceFailure) -> ApiError {
    use proto::VoiceFailure as F;
    match failure {
        F::NoModel { model_id } => ApiError::Conflict(format!(
            "no speech model is installed ({model_id}): download it in Settings > Dictation on the \
             computer running Houston, or switch to Groq there"
        )),
        F::MissingKey { .. } => ApiError::Conflict(
            "no Groq API key is stored: add one in Settings > Dictation on the computer running \
             Houston, or switch to the local engine there"
                .to_string(),
        ),
        F::TooQuiet { rms, floor } => ApiError::Unprocessable(format!(
            "the recording is too quiet to transcribe: measured RMS {rms:.4}, the floor is \
             {floor:.4}; speak closer to the microphone"
        )),
        F::TooShort { seconds, minimum } => ApiError::Unprocessable(format!(
            "the recording is too short to transcribe: {seconds:.2} s, the minimum is {minimum:.2} s"
        )),
        F::NoSpeech => ApiError::Unprocessable("no speech was recognised".to_string()),
        F::TargetGone { session } => {
            ApiError::NotFound(format!("pane {session} closed before the transcript arrived"))
        }
        F::Engine { message } => ApiError::Internal(format!("transcription failed: {message}")),
        F::DeviceUnavailable { device } => {
            ApiError::Internal(format!("transcription failed: {device}"))
        }
        F::RingBufferOverrun { dropped } => {
            ApiError::Internal(format!("transcription failed: {dropped} samples were lost"))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteFeed {
    pub id: u32,
    /// Changes when the daemon restarts or remote access is turned off and on;
    /// sequence numbers from another epoch do not continue this one.
    pub epoch: String,
    pub entries: Vec<feed::FeedEntry>,
    pub first_seq: u64,
    pub last_seq: u64,
    pub truncated: bool,
    pub pending: Option<feed::PendingView>,
}

impl Daemon {
    /// The current remote configuration, read from the settings table once.
    pub fn remote_config(&self) -> Config {
        let mut slot = self.remote.config.lock().expect("remote config lock");
        if let Some(cfg) = slot.as_ref() {
            return cfg.clone();
        }
        let cfg = self.remote_config_from_db();
        self.remote.feed.set_collecting(cfg.enabled);
        *slot = Some(cfg.clone());
        cfg
    }

    fn remote_config_from_db(&self) -> Config {
        let get = |key: &str| self.db.get_setting(key).ok().flatten();
        let default = Config {
            bind: remote::default_bind(self.channel()),
            ..Config::default()
        };
        let mut cfg = Config {
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
            dictation: get(remote::KEY_DICTATION).as_deref() == Some("1"),
        };
        cfg.upgrade_public_scheme();
        cfg
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
        if let Some(dictation) = patch.dictation {
            next.dictation = dictation;
        }
        if next.bind.ip().is_unspecified() && next.public_url.is_none() {
            anyhow::bail!(
                "remote bind {} listens on every interface, so there is no single address to \
                 pair devices with: set the public URL to the address devices open (for example \
                 https://192.168.1.20:{}), or bind one address",
                next.bind,
                next.bind.port()
            );
        }
        if let Some(refusal) = next.tls_refusal() {
            anyhow::bail!(refusal);
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
            let mut cached = self.remote.ntfy_url.lock().expect("remote ntfy lock");
            self.remote
                .ntfy_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            *cached = url.clone().map(zeroize::Zeroizing::new);
        }
        let flag = |b: bool| if b { "1" } else { "0" };
        let bind = next.bind.to_string();
        let delay = next.notify_delay_secs.to_string();
        self.db.set_settings_atomic(&[
            (remote::KEY_ENABLED, flag(next.enabled)),
            (remote::KEY_BIND, &bind),
            (
                remote::KEY_PUBLIC_URL,
                next.public_url.as_deref().unwrap_or(""),
            ),
            (remote::KEY_NOTIFY_DELAY, &delay),
            (remote::KEY_NOTIFY_DETAIL, next.notify_detail.as_str()),
            (remote::KEY_NOTIFY_FINISHED, flag(next.notify_finished)),
            (remote::KEY_DICTATION, flag(next.dictation)),
            (
                remote::KEY_NTFY_SERVER,
                next.ntfy_server.as_deref().unwrap_or(""),
            ),
        ])?;
        let enabled = next.enabled;
        *self.remote.config.lock().expect("remote config lock") = Some(next);
        self.remote.feed.set_collecting(enabled);
        if !enabled {
            self.remote.stop_streams(Some("disabled"));
        }
        self.remote.reconfigured.send_modify(|n| *n += 1);
        self.remote.notification_wake.notify_one();
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
                tier: d.tier,
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
                dictation: cfg.dictation,
                tls: cfg.serves_tls(),
                ca_fingerprint: self.remote_authority_fingerprint(),
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
        let now = now_ms();
        let code = self.remote.start_pairing(now);
        let url = format!("{}/#pair={code}", self.remote_config().effective_url());
        RemotePairing {
            url,
            code,
            expires_at_ms: now + remote::PAIRING_TTL.as_millis() as u64,
        }
    }

    pub fn remote_devices(&self) -> Result<Vec<RemoteDeviceRow>> {
        self.db.remote_devices()
    }

    /// Takes effect on the device's next request: every request re-reads its row.
    pub fn remote_device_set_tier(&self, id: i64, tier: proto::RemoteTier) -> Result<()> {
        if !self.db.remote_device_set_tier(id, tier)? {
            anyhow::bail!("no paired device has id {id}: expected an id from the device list");
        }
        self.remote_broadcast_state();
        Ok(())
    }

    pub fn remote_device_revoke(&self, id: i64) -> Result<()> {
        let hash = self.db.remote_device_hash(id)?;
        if !self.db.remote_device_delete(id)? {
            anyhow::bail!("no paired device has id {id}: expected an id from the device list");
        }
        self.remote
            .last_seen_written
            .lock()
            .expect("remote last-seen lock")
            .remove(&id);
        if let Some(hash) = hash {
            self.remote.remember_revoked(hash);
        }
        self.remote.stop_device_streams(id);
        self.remote_broadcast_state();
        Ok(())
    }

    pub(crate) fn remote_check_stream_device(&self, id: i64) {
        if !self.remote_config().enabled {
            self.remote.stop_streams(Some("disabled"));
        } else if matches!(self.db.remote_device_hash(id), Ok(None)) {
            self.remote.stop_device_streams(id);
        }
    }

    /// `Err` is a database failure, which is neither a wrong token nor a revocation.
    pub(crate) fn remote_authenticate(
        &self,
        raw_token: &str,
    ) -> Result<Option<RemoteDeviceRow>, String> {
        let row = match self
            .db
            .remote_device_by_hash(&remote::hash_secret(raw_token))
        {
            Ok(Some(row)) => row,
            Ok(None) => return Ok(None),
            Err(e) => {
                tracing::warn!("remote access: reading paired devices: {e}");
                return Err(e.to_string());
            }
        };
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
        Ok(Some(row))
    }

    pub(crate) fn remote_pair(
        &self,
        code: &str,
        device_name: &str,
    ) -> Result<(String, i64), ApiError> {
        let name = remote::validate_device_name(device_name).map_err(ApiError::BadRequest)?;
        self.remote
            .redeem_pairing(code, now_ms())
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
                let summary = self.remote.feed.summary(info.id);
                let waiting =
                    info.state.is_live() && info.status == Some(proto::AgentStatus::NeedsInput);
                RemoteSession {
                    id: info.id,
                    title: info.title.clone(),
                    parent: info.spawned_by,
                    role: self
                        .delegation_of(info.id)
                        .and_then(|d| d.role)
                        .map(|role| feed::mask(&role)),
                    workspace,
                    kind: info.detected_agent.unwrap_or(info.agent),
                    state: info.state,
                    status: info.status,
                    reason: None,
                    status_since: seen.map(|s| s.since_ms),
                    pending: summary.pending.filter(|_| waiting),
                    waiting_since: seen.filter(|_| waiting).map(|s| s.since_ms),
                    last_reply_excerpt: summary.last_reply_excerpt,
                    last_step: summary.last_step,
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

    /// Replaces the grids devices group panes by. Refuses a set over the
    /// limits instead of trimming it, naming the limit that tripped.
    pub fn remote_grids_publish(&self, grids: Vec<proto::RemoteGrid>) -> anyhow::Result<()> {
        if grids.len() > proto::REMOTE_GRIDS_MAX {
            anyhow::bail!(
                "remote grids: {} grids exceed the limit of {}; publish at most {} grids",
                grids.len(),
                proto::REMOTE_GRIDS_MAX,
                proto::REMOTE_GRIDS_MAX
            );
        }
        for grid in &grids {
            if grid.id.is_empty() {
                anyhow::bail!(
                    "remote grids: a grid named {:?} has an empty id; expected a non-empty grid id",
                    grid.name
                );
            }
            if grid.sessions.len() > proto::REMOTE_GRID_SESSIONS_MAX {
                anyhow::bail!(
                    "remote grids: grid {:?} holds {} panes, over the limit of {} panes per grid",
                    grid.id,
                    grid.sessions.len(),
                    proto::REMOTE_GRID_SESSIONS_MAX
                );
            }
            let chars = grid.name.chars().count();
            if chars > proto::REMOTE_GRID_NAME_MAX {
                anyhow::bail!(
                    "remote grids: grid {:?} has a {chars}-character name, over the limit of {} characters",
                    grid.id,
                    proto::REMOTE_GRID_NAME_MAX
                );
            }
        }
        let mut held = self.remote.grids.lock().expect("remote grids lock");
        if *held != grids {
            *held = grids;
            drop(held);
            self.remote.emit(Change::Grids);
        }
        Ok(())
    }

    /// The published grids restricted to `sessions`, in their published order.
    /// A pane listed by two grids stays in the first; grids left empty are dropped.
    pub fn remote_grids(&self, sessions: &[RemoteSession]) -> Vec<proto::RemoteGrid> {
        let visible: HashSet<u32> = sessions.iter().map(|s| s.id).collect();
        let mut placed = HashSet::new();
        let held = self.remote.grids.lock().expect("remote grids lock");
        held.iter()
            .filter_map(|grid| {
                let ids: Vec<u32> = grid
                    .sessions
                    .iter()
                    .copied()
                    .filter(|id| visible.contains(id) && placed.insert(*id))
                    .collect();
                (!ids.is_empty()).then(|| proto::RemoteGrid {
                    sessions: ids,
                    ..grid.clone()
                })
            })
            .collect()
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
    pub fn remote_screen(&self, id: u32, lines: usize) -> Result<RemoteScreen, ApiError> {
        if lines == 0 || lines > remote::SCREEN_LINES_MAX {
            return Err(ApiError::BadRequest(format!(
                "lines={lines} is out of range: expected 1 to {}",
                remote::SCREEN_LINES_MAX
            )));
        }
        let s = self.remote_target(id)?;
        let screen = s.vt().as_mut().map(|emulator| emulator.screen_text(lines));
        let (text, source) = match screen {
            Some(text) => (text, "screen"),
            None => {
                let tail = s
                    .scrollback
                    .lock()
                    .expect("scrollback lock")
                    .tail_lines(lines);
                (
                    tail.iter().map(|l| strip_escapes(l)).collect(),
                    "scrollback",
                )
            }
        };
        Ok(RemoteScreen {
            lines: crate::orchestrate::cap_read_tail(text, lines),
            source,
        })
    }

    /// Text first, then keys, through the desktop's stdin path. Multi-line text is
    /// a bracketed paste, and only when the program enabled paste mode, as the
    /// desktop does; otherwise its newlines would submit it line by line.
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
        let Some(_claim) = self.remote.claim_input(id) else {
            return Err(ApiError::Conflict(format!(
                "input for pane {id} is still being written: wait for it to finish, then send again"
            )));
        };
        let multi_line = text.as_ref().is_some_and(|t| t.contains('\n'));
        if multi_line {
            match s.vt().as_mut().map(|emulator| emulator.bracketed_paste()) {
                Some(true) => {}
                Some(false) => {
                    return Err(ApiError::Conflict(format!(
                        "pane {id}'s program has not turned on bracketed paste, so a multi-line \
                         answer would submit line by line: send one line at a time"
                    )))
                }
                None => {
                    return Err(ApiError::Conflict(format!(
                        "this build has no terminal emulator to tell whether pane {id} accepts a \
                         multi-line paste: send one line at a time"
                    )))
                }
            }
        }
        let write = |bytes: &[u8]| -> Result<(), ApiError> {
            self.remote_note_keystroke_from(id, "from this phone");
            self.note_operator_keystroke(id, bytes);
            self.write_stdin_from_renderer(id, bytes)
                .map_err(|e| ApiError::Conflict(format!("writing to pane {id}: {e}")))
        };
        if let Some(text) = &text {
            if multi_line {
                write(&super::bracketed_paste(text))?;
            } else {
                write(text.as_bytes())?;
            }
            if !key_bytes.is_empty() {
                std::thread::sleep(self.paste_submit_settle(id));
            }
        }
        if !key_bytes.is_empty() {
            write(&key_bytes)?;
        }
        Ok(())
    }

    /// Refusals that need no audio, checked before a recording is read. Returns
    /// the voice settings the transcription uses.
    pub(crate) fn remote_dictate_check(&self, id: u32) -> Result<proto::VoiceSettings, ApiError> {
        if !self.remote_config().dictation {
            return Err(ApiError::Forbidden(
                "dictation from paired devices is off: turn on Allow dictation from paired \
                 devices in Settings > Remote access on the computer running Houston"
                    .to_string(),
            ));
        }
        let s = self.remote_target(id)?;
        if !s.state.lock().expect("state lock").is_live() {
            return Err(ApiError::Conflict(format!(
                "pane {id} is not running: dictation needs a live pane"
            )));
        }
        let settings = self.voice_settings();
        let local = matches!(settings.engine, proto::VoiceEngine::Local { .. });
        if local && cfg!(not(unix)) {
            return Err(ApiError::Conflict(format!(
                "{}: choose Groq in Settings > Dictation for remote dictation on this computer",
                crate::voice::runtime::LOCAL_ENGINE_UNAVAILABLE
            )));
        }
        match self.voice_engine_refusal(&settings) {
            Some(proto::VoiceFailure::Engine { message }) => Err(ApiError::Conflict(message)),
            Some(failure) => Err(dictation_refusal(failure)),
            None => Ok(settings),
        }
    }

    /// Transcribes one recording from a device. It never opens this computer's
    /// microphone, changes the desktop's dictation state or broadcasts the
    /// transcript; the text goes back to the device only. Blocking.
    pub(crate) fn remote_dictate(
        &self,
        id: u32,
        settings: &proto::VoiceSettings,
        samples: Vec<f32>,
    ) -> Result<RemoteDictation, ApiError> {
        let _engine = self.voice.claim_engine_remote().map_err(|busy| {
            ApiError::Conflict(match busy {
                crate::voice::runtime::EngineBusy::Desktop => {
                    "the desktop is transcribing a dictation and the engine runs one at a time: \
                     send the recording again in a moment"
                        .to_string()
                }
                crate::voice::runtime::EngineBusy::Remote => {
                    "another device's recording is being transcribed; remote dictation \
                     transcribes one recording at a time: send it again when that finishes"
                        .to_string()
                }
            })
        })?;
        let audio = crate::voice::AudioBuffer {
            samples,
            sample_rate: crate::voice::capture::TARGET_SAMPLE_RATE,
        };
        let t = self
            .voice_transcribe(&audio, settings)
            .map_err(dictation_refusal)?;
        let text =
            self.voice
                .dictation_text(id, &t.text, settings.output_mode, settings.agent_preamble);
        if text.is_empty() {
            return Err(dictation_refusal(proto::VoiceFailure::NoSpeech));
        }
        Ok(RemoteDictation {
            text,
            engine: t.engine,
            translated: t.translated,
        })
    }

    pub(crate) fn remote_note_status(&self, id: u32, status: proto::AgentStatus) {
        let _retention = self.remote.retention.lock().expect("remote retention lock");
        if self.get(id).is_err() {
            return;
        }
        let now = now_ms();
        let from = self.remote.note_status(id, status, now);
        {
            let mut seen = self.remote.seen.lock().expect("remote seen lock");
            if seen.len() > remote::SEEN_PRUNE_AT {
                let live = self.sessions.lock().expect("sessions lock");
                seen.retain(|id, _| live.contains_key(id));
            }
        }
        // Every transition retires the card, even with remote access off, so a
        // card can never outlive the request it was built from.
        if status != proto::AgentStatus::NeedsInput {
            if status == proto::AgentStatus::Working
                && self
                    .remote
                    .feed
                    .pending(id)
                    .is_some_and(|p| p.answered.is_none())
            {
                self.remote_activity(id, "answered", Some("in the terminal"));
            }
            self.remote.feed.resolve_pending(id);
        }
        if !self.remote_config().enabled {
            return;
        }
        if status == proto::AgentStatus::NeedsInput {
            if from != Some(status) {
                self.remote_activity(id, "needs_you", None);
            }
            self.remote.feed.set_pending(
                id,
                Pending {
                    seq: 0,
                    card: Card::Input,
                    title: feed::card_title(&Card::Input, None),
                    detail: String::new(),
                    diff: None,
                    provider: self.remote_provider(id),
                    truncated: false,
                    since_ms: now,
                    answered: None,
                },
            );
        }
        self.remote_emit(id, Change::Session(id));
    }

    /// A keystroke reached pane `id` from the desktop or a device: a card still
    /// open was answered there, so a device can no longer answer it with a tap.
    pub(crate) fn remote_note_keystroke(&self, id: u32) {
        self.remote_note_keystroke_from(id, "in the terminal");
    }

    fn remote_note_keystroke_from(&self, id: u32, origin: &'static str) {
        if self.remote.feed.note_keystroke(id) || self.remote.feed.note_input_answer(id) {
            self.remote_activity(id, "answered", Some(origin));
            self.remote_emit(id, Change::Session(id));
        }
    }

    fn remote_activity(&self, id: u32, kind: &'static str, excerpt: Option<&str>) {
        if let Ok(session) = self.remote_target(id) {
            let title = session.title.lock().expect("title lock").clone();
            self.remote
                .feed
                .activity_push(id, kind, &title, excerpt, now_ms());
        }
    }

    fn remote_provider(&self, id: u32) -> proto::AgentKind {
        self.get(id)
            .map(|s| s.info.detected_agent.unwrap_or(s.info.agent))
            .unwrap_or(proto::AgentKind::Custom)
    }

    /// Hidden panes are not served remotely, so their changes are not announced.
    fn remote_emit(&self, id: u32, change: Change) {
        if self.get(id).is_ok_and(|s| !s.info.hidden) {
            self.remote.emit(change);
        }
    }

    fn remote_push(&self, id: u32, item: FeedItem, now: u64) -> Option<u64> {
        let seq = self.remote.feed.push(id, item, now)?;
        self.remote_emit(id, Change::Feed(id, seq));
        Some(seq)
    }

    /// Feeds an applied hook drop into the pane's activity feed. Only while
    /// remote access is on: nothing is collected for a listener that is off.
    pub(crate) fn remote_feed_hook(&self, d: &crate::hook_drop::HookDrop) {
        let _retention = self.remote.retention.lock().expect("remote retention lock");
        if !self.remote_config().enabled || self.get(d.session).is_err() {
            return;
        }
        let provider = match d.agent.as_deref() {
            None => proto::AgentKind::Claude,
            Some(slug) => match crate::agent_hooks::provider_from_slug(slug) {
                Ok(kind) => kind,
                Err(_) => return,
            },
        };
        let id = d.session;
        let now = now_ms();
        match &d.feed {
            Some(HookFeed::Prompt { text }) if !d.internal_prompt => {
                self.remote_push(id, FeedItem::Prompt { text: text.clone() }, now);
            }
            Some(HookFeed::Question {
                tool_use_id,
                questions,
            }) => {
                let Some(seq) = self.remote_push(
                    id,
                    FeedItem::Question {
                        tool_use_id: tool_use_id.clone(),
                        questions: questions.clone(),
                        answers: None,
                    },
                    now,
                ) else {
                    return;
                };
                let card = Card::Question {
                    tool_use_id: tool_use_id.clone(),
                    questions: questions.clone(),
                };
                self.remote_set_card(
                    id,
                    Pending {
                        seq,
                        title: feed::card_title(&card, None),
                        card,
                        detail: String::new(),
                        diff: None,
                        truncated: false,
                        provider,
                        since_ms: now,
                        answered: None,
                    },
                );
            }
            Some(HookFeed::Answered {
                tool_use_id,
                answers,
            }) => {
                if self
                    .remote
                    .feed
                    .answer_question(id, tool_use_id.as_deref(), answers.clone())
                {
                    self.remote_push(
                        id,
                        FeedItem::Answer {
                            answers: answers.clone(),
                        },
                        now,
                    );
                    self.remote_emit(id, Change::Session(id));
                }
            }
            Some(HookFeed::Permission {
                tool,
                target,
                always,
                truncated,
                diff,
            }) => {
                let Some(seq) = self.remote_push(
                    id,
                    FeedItem::Permission {
                        tool: tool.clone(),
                        target: target.clone(),
                        always: *always,
                        truncated: *truncated,
                        outcome: None,
                        diff: diff.clone(),
                    },
                    now,
                ) else {
                    return;
                };
                let card = Card::Permission { always: *always };
                self.remote_set_card(
                    id,
                    Pending {
                        seq,
                        title: feed::card_title(&card, Some(tool)),
                        card,
                        detail: target.clone(),
                        diff: diff.clone(),
                        truncated: *truncated,
                        provider,
                        since_ms: now,
                        answered: None,
                    },
                );
            }
            Some(HookFeed::Step {
                tool,
                target,
                edited_path,
                failed,
            }) => {
                if let Some(path) = edited_path {
                    self.remote.feed.note_edited_path(id, path);
                }
                self.remote_push(
                    id,
                    FeedItem::Step {
                        failed: *failed,
                        tool: tool.clone(),
                        target: target.clone(),
                    },
                    now,
                );
            }
            Some(HookFeed::Prompt { .. }) | None => {}
        }
        let event = crate::agent_events::AgentEvent::from_provider(provider, &d.event);
        use crate::agent_events::AgentEvent;
        let turn_ended = matches!(
            event,
            Some(AgentEvent::TurnEnded | AgentEvent::TurnFailed | AgentEvent::TurnInterrupted)
        ) && d.fully_idle != Some(false)
            && d.subagent_type.is_none()
            && d.agent_id.is_none();
        let speaks =
            turn_ended || (provider == proto::AgentKind::Cursor && d.event == "afterAgentResponse");
        if speaks {
            if let Some(text) = d
                .last_message
                .as_deref()
                .map(feed::reply_text)
                .filter(|t| !t.is_empty())
            {
                self.remote_push(id, FeedItem::Reply { text }, now);
            }
        }
        if turn_ended {
            let outcome = match event {
                Some(AgentEvent::TurnFailed) => "failed",
                Some(AgentEvent::TurnInterrupted) => "stopped",
                _ => "done",
            };
            if let Some(summary) = self.remote.feed.end_turn(id, outcome, now) {
                self.remote_push(id, summary, now);
            }
            self.remote_push(id, FeedItem::Status { status: "finished" }, now);
            let excerpt = d.last_message.as_deref().map(feed::reply_text);
            self.remote_activity(id, "finished", excerpt.as_deref());
        }
        if self.remote.feed.session_count() > remote::SEEN_PRUNE_AT {
            let live: std::collections::HashSet<u32> = self
                .sessions
                .lock()
                .expect("sessions lock")
                .keys()
                .copied()
                .collect();
            self.remote
                .feed
                .prune(remote::SEEN_PRUNE_AT, |id| live.contains(&id));
        }
    }

    fn remote_set_card(&self, id: u32, pending: Pending) {
        self.remote.feed.set_pending(id, pending);
        self.remote_emit(id, Change::Session(id));
    }

    pub(crate) fn remote_note_exit(&self, id: u32) {
        let _retention = self.remote.retention.lock().expect("remote retention lock");
        if self.get(id).is_err() {
            return;
        }
        if !self.remote_config().enabled {
            return;
        }
        self.remote.feed.resolve_pending(id);
        self.remote_push(id, FeedItem::Status { status: "exited" }, now_ms());
        self.remote_emit(id, Change::Session(id));
    }

    pub(crate) fn remote_forget_session(&self, id: u32) {
        // Serialize against a waiter or hook that obtained the pane before close.
        let _retention = self.remote.retention.lock().expect("remote retention lock");
        self.remote.feed.forget(id);
        self.remote
            .notifications
            .lock()
            .expect("remote notifications lock")
            .remove(&id);
        self.remote.notification_wake.notify_one();
        self.remote
            .seen
            .lock()
            .expect("remote seen lock")
            .remove(&id);
    }

    #[doc(hidden)]
    pub fn remote_feed_session_count_for_test(&self) -> usize {
        self.remote.feed.session_count()
    }

    #[doc(hidden)]
    pub fn remote_pending_notifications_for_test(&self) -> usize {
        self.remote
            .notifications
            .lock()
            .expect("remote notifications lock")
            .len()
    }

    pub fn remote_feed(&self, id: u32, after: u64) -> Result<RemoteFeed, ApiError> {
        self.remote_target(id)?;
        let page = self.remote.feed.page(id, after);
        let waiting =
            self.session_status(id).ok().flatten() == Some(proto::AgentStatus::NeedsInput);
        Ok(RemoteFeed {
            id,
            epoch: page.epoch,
            entries: page.entries,
            first_seq: page.first_seq,
            last_seq: page.last_seq,
            truncated: page.truncated,
            pending: page.pending.filter(|_| waiting),
        })
    }

    /// Answers the pane's pending card with the keys its provider's prompt takes,
    /// through the same stdin path as typed input.
    pub fn remote_decide(
        &self,
        id: u32,
        epoch: &str,
        entry_seq: u64,
        choice: &str,
        text: Option<&str>,
    ) -> Result<(), ApiError> {
        let choice = feed::Choice::parse(choice, text).map_err(ApiError::BadRequest)?;
        let s = self.remote_target(id)?;
        if !s.state.lock().expect("state lock").is_live() {
            return Err(ApiError::Conflict(format!(
                "pane {id} is not running: a decision needs a live pane"
            )));
        }
        let waiting =
            *s.status.lock().expect("status lock") == Some(proto::AgentStatus::NeedsInput);
        let plan = self
            .remote
            .feed
            .begin_decision(id, epoch, entry_seq, &choice, waiting)
            .map_err(|r| decision_refused(id, entry_seq, r))?;
        let Some(_claim) = self.remote.claim_input(id) else {
            self.remote.feed.clear_sent(id, entry_seq);
            return Err(ApiError::Conflict(format!(
                "input for pane {id} is still being written: wait for it to finish, then send again"
            )));
        };
        for (i, bytes) in plan.writes.iter().enumerate() {
            if i > 0 {
                std::thread::sleep(Duration::from_millis(plan.settle_ms));
            }
            self.note_operator_keystroke(id, bytes);
            if let Err(e) = self.write_stdin_from_renderer(id, bytes) {
                self.remote.feed.clear_sent(id, entry_seq);
                return Err(ApiError::Conflict(format!("writing to pane {id}: {e}")));
            }
        }
        self.remote_activity(id, "answered", Some("from this phone"));
        self.remote_emit(id, Change::Session(id));
        Ok(())
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
            let https = cfg.serves_tls();
            let mut hosts = cfg.allowed_hosts();
            let mut generation = self.remote.authority_generation.load(Ordering::Acquire);
            let key = if https {
                self.remote_server_key(hosts.clone()).await.map(Some)
            } else {
                Ok(None)
            };
            let prepared = match key {
                Ok(key) => tokio::net::TcpListener::bind(cfg.bind)
                    .await
                    .map(|listener| (listener, key.map(tls::ServerCert::new)))
                    .map_err(|e| format!("cannot listen on {}: {e}", cfg.bind)),
                Err(e) => Err(format!("cannot serve HTTPS on {}: {e:#}", cfg.bind)),
            };
            match prepared {
                Ok((listener, cert)) => {
                    let tls = match cert
                        .as_ref()
                        .map(tls::ServerCert::server_config)
                        .transpose()
                    {
                        Ok(tls) => tls,
                        Err(e) => {
                            self.remote_set_listen(ListenState {
                                listening: None,
                                error: Some(format!("cannot serve HTTPS: {e:#}")),
                            });
                            tokio::time::sleep(backoff).await;
                            continue;
                        }
                    };
                    backoff = BIND_BACKOFF_START;
                    self.remote_set_listen(ListenState {
                        listening: listener.local_addr().ok(),
                        error: None,
                    });
                    let this = Arc::clone(&self);
                    let mut watch = changes.clone();
                    let bind = cfg.bind;
                    let (stopping, stopped) = tokio::sync::oneshot::channel::<()>();
                    let shutdown = async move {
                        loop {
                            if watch.changed().await.is_err() {
                                std::future::pending::<()>().await;
                            }
                            let now = this.remote_config();
                            if !now.enabled || now.bind != bind || now.serves_tls() != https {
                                break;
                            }
                            let Some(cert) = cert.as_ref() else {
                                continue;
                            };
                            let current = this.remote.authority_generation.load(Ordering::Acquire);
                            if now.allowed_hosts() != hosts || current != generation {
                                hosts = now.allowed_hosts();
                                generation = current;
                                match this.remote_server_key(hosts.clone()).await {
                                    Ok(key) => cert.set(key),
                                    Err(e) => tracing::warn!(
                                        "remote access: keeping the previous certificate: {e:#}"
                                    ),
                                }
                            }
                        }
                        // Event streams never end on their own; graceful shutdown
                        // waits for every connection, so they are ended here.
                        this.remote.stop_streams(if this.remote_config().enabled {
                            None
                        } else {
                            Some("disabled")
                        });
                        let _ = stopping.send(());
                    };
                    let drained = async {
                        match stopped.await {
                            Ok(()) => tokio::time::sleep(LISTENER_DRAIN).await,
                            Err(_) => std::future::pending::<()>().await,
                        }
                    };
                    let served = tokio::select! {
                        served = remote::http::serve(Arc::clone(&self), listener, tls, shutdown) => served,
                        () = drained => {
                            tracing::warn!(
                                "remote access: requests on {bind} were still open {} s after the \
                                 listener stopped; leaving them to finish",
                                LISTENER_DRAIN.as_secs()
                            );
                            Ok(())
                        }
                    };
                    if let Err(e) = served {
                        self.remote_set_listen(ListenState {
                            listening: None,
                            error: Some(format!("the listener on {bind} stopped: {e}")),
                        });
                        tokio::time::sleep(backoff).await;
                    }
                }
                Err(error) => {
                    self.remote_set_listen(ListenState {
                        listening: None,
                        error: Some(error),
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

    /// A server certificate for `hosts`, signed by the local authority; the
    /// keychain is read off the async runtime.
    async fn remote_server_key(
        self: &Arc<Self>,
        hosts: Vec<String>,
    ) -> Result<Arc<tokio_rustls::rustls::sign::CertifiedKey>> {
        let this = Arc::clone(self);
        tokio::task::spawn_blocking(move || this.remote_authority()?.server_key(&hosts))
            .await
            .map_err(|e| anyhow!("preparing the certificate panicked: {e}"))?
    }

    /// The local certificate authority, from settings and the keychain, or a new
    /// one stored there on first use. A lost key makes a new authority, which
    /// devices have to trust again.
    pub fn remote_authority(&self) -> Result<Arc<tls::Authority>> {
        let mut slot = self.remote.authority.lock().expect("remote authority lock");
        if let Some(authority) = slot.as_ref() {
            return Ok(Arc::clone(authority));
        }
        let get = |key: &str| {
            self.db
                .get_setting(key)
                .ok()
                .flatten()
                .filter(|v| !v.is_empty())
        };
        let stored = match (get(tls::KEY_CA_NAME), get(tls::KEY_CA_CERT)) {
            (Some(name), Some(cert)) => match tls::load_key(&self.state_dir)? {
                Some(key) => Some(tls::Authority::from_parts(&name, &cert, &key)?),
                None => {
                    tracing::warn!(
                        "remote access: the keychain holds no key for the stored certificate \
                         authority; creating a new one, which paired devices must trust again"
                    );
                    None
                }
            },
            _ => None,
        };
        let authority = Arc::new(match stored {
            Some(authority) => authority,
            None => self.remote_new_authority()?,
        });
        *slot = Some(Arc::clone(&authority));
        Ok(authority)
    }

    fn remote_new_authority(&self) -> Result<tls::Authority> {
        let authority = tls::Authority::generate(&remote::host_name())?;
        tls::store_key(&self.state_dir, &authority.key_pem())?;
        self.db.set_settings_atomic(&[
            (tls::KEY_CA_NAME, authority.name()),
            (tls::KEY_CA_CERT, authority.cert_pem()),
        ])?;
        tracing::info!(
            "remote access: created certificate authority {} ({})",
            authority.name(),
            authority.fingerprint()
        );
        Ok(authority)
    }

    /// Replaces the authority; the listener's next handshakes use a certificate
    /// from the new one, and every device must trust it again.
    pub fn remote_regenerate_authority(&self) -> Result<()> {
        let authority = Arc::new(self.remote_new_authority()?);
        *self.remote.authority.lock().expect("remote authority lock") = Some(authority);
        self.remote
            .authority_generation
            .fetch_add(1, Ordering::AcqRel);
        self.remote.reconfigured.send_modify(|n| *n += 1);
        self.remote_broadcast_state();
        Ok(())
    }

    /// The certificate authority's fingerprint once it exists, without reading
    /// the keychain.
    fn remote_authority_fingerprint(&self) -> Option<String> {
        self.remote
            .authority
            .lock()
            .expect("remote authority lock")
            .as_ref()
            .map(|a| a.fingerprint())
            .or_else(|| {
                let pem = self.db.get_setting(tls::KEY_CA_CERT).ok().flatten()?;
                tls::fingerprint_of_pem(&pem)
            })
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
        let generation = self
            .remote
            .ntfy_generation
            .load(std::sync::atomic::Ordering::Acquire);
        let state_dir = self.state_dir.clone();
        match tokio::task::spawn_blocking(move || remote::ntfy::load_url(&state_dir)).await {
            Ok(Ok(Some(url))) => {
                let mut cached = self.remote.ntfy_url.lock().expect("remote ntfy lock");
                if generation
                    != self
                        .remote
                        .ntfy_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                {
                    return None;
                }
                // A configuration write may have installed a newer topic while we loaded.
                if let Some(current) = cached.as_ref() {
                    return Some(current.clone());
                }
                *cached = Some(url.clone());
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

    /// One owned sender and one replaceable deadline per pane. Status churn cannot
    /// accumulate sleeping tasks, and close releases a deadline immediately.
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
        loop {
            let cfg = self.remote_config();
            let due = {
                let mut pending = self
                    .remote
                    .notifications
                    .lock()
                    .expect("remote notifications lock");
                pending.retain(|id, n| {
                    cfg.enabled
                        && cfg.ntfy_server.is_some()
                        && (n.kind != remote::ntfy::Kind::Finished || cfg.notify_finished)
                        && self.remote.seen(*id).map(|s| s.epoch) == Some(n.event.epoch)
                        && self.get(*id).is_ok()
                });
                pending.values().map(|n| n.due).min()
            };
            tokio::select! {
                event = rx.recv() => {
                    let Some(ev) = event else { break };
                    let _retention = self.remote.retention.lock().expect("remote retention lock");
                    let cfg = self.remote_config();
                    if !cfg.enabled || cfg.ntfy_server.is_none() || self.get(ev.session).is_err()
                        || self.remote.seen(ev.session).map(|s| s.epoch) != Some(ev.epoch) {
                        continue;
                    }
                    let kind = match (ev.from, ev.to) {
                        (_, proto::AgentStatus::NeedsInput) => remote::ntfy::Kind::NeedsInput,
                        (Some(proto::AgentStatus::Working), proto::AgentStatus::Idle) if cfg.notify_finished => remote::ntfy::Kind::Finished,
                        _ => continue,
                    };
                    self.remote.notifications.lock().expect("remote notifications lock").insert(ev.session, remote::PendingNotification {
                        event: ev,
                        kind,
                        due: tokio::time::Instant::now() + Duration::from_secs(u64::from(cfg.notify_delay_secs)),
                    });
                }
                _ = self.remote.notification_wake.notified() => {}
                _ = async {
                    match due {
                        Some(due) => tokio::time::sleep_until(due).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    let next = {
                        let mut pending = self.remote.notifications.lock().expect("remote notifications lock");
                        let id = pending.iter().filter(|(_, n)| n.due <= tokio::time::Instant::now()).min_by_key(|(_, n)| n.due).map(|(id, _)| *id);
                        id.and_then(|id| pending.remove(&id))
                    };
                    if let Some(next) = next {
                        self.remote_send_notification(&client, next).await;
                    }
                }
            }
        }
        self.remote
            .notifications
            .lock()
            .expect("remote notifications lock")
            .clear();
    }

    async fn remote_send_notification(
        self: &Arc<Self>,
        client: &reqwest::Client,
        n: remote::PendingNotification,
    ) {
        let revision = *self.remote.reconfigured.borrow();
        let generation = self
            .remote
            .ntfy_generation
            .load(std::sync::atomic::Ordering::Acquire);
        let Some(url) = self.remote_ntfy_url().await else {
            return;
        };
        let cfg = self.remote_config();
        if revision != *self.remote.reconfigured.borrow()
            || generation
                != self
                    .remote
                    .ntfy_generation
                    .load(std::sync::atomic::Ordering::Acquire)
            || !cfg.enabled
            || cfg.ntfy_server.is_none()
            || cfg.ntfy_server.as_deref() != remote::ntfy_server(&url).as_deref()
            || (n.kind == remote::ntfy::Kind::Finished && !cfg.notify_finished)
            || self.remote.seen(n.event.session).map(|s| s.epoch) != Some(n.event.epoch)
        {
            return;
        }
        let Ok(session) = self.get(n.event.session) else {
            return;
        };
        if session.info.hidden || !session.state.lock().expect("state lock").is_live() {
            return;
        }
        let title = session.title.lock().expect("title lock").clone();
        let msg = remote::ntfy::compose(
            n.kind,
            cfg.notify_detail,
            &title,
            &cfg.effective_url(),
            n.event.session,
        );
        match remote::ntfy::send(client, &url, &msg).await {
            Ok(()) => tracing::info!(
                "remote access: notified {} about pane {}",
                cfg.ntfy_server.as_deref().unwrap_or("ntfy"),
                n.event.session
            ),
            Err(e) => tracing::warn!(
                "remote access: notifying pane {} failed: {e}",
                n.event.session
            ),
        }
    }
}

fn decision_refused(id: u32, entry_seq: u64, refusal: Refusal) -> ApiError {
    match refusal {
        Refusal::Epoch => ApiError::Conflict(format!(
            "entry {entry_seq} is from an earlier feed: the daemon restarted or remote access was \
             turned off and on since it was shown; reload pane {id}"
        )),
        Refusal::NotPending(now) => ApiError::Conflict(format!(
            "entry {entry_seq} is not pane {id}'s pending decision: {}",
            match now {
                Some(seq) => format!("it now waits on entry {seq}"),
                None => "it has no decision Houston can answer".to_string(),
            }
        )),
        Refusal::Answered(Answered::Sent) => ApiError::Conflict(format!(
            "entry {entry_seq} was already answered from a device and the agent has not moved on \
             yet: wait for it, or use the terminal"
        )),
        Refusal::Answered(Answered::Elsewhere) => ApiError::Conflict(format!(
            "entry {entry_seq} was answered in pane {id}'s terminal: a key reached the pane after \
             the request arrived; use View screen"
        )),
        Refusal::Unsupported(why) => ApiError::Conflict(why),
        Refusal::Partial => ApiError::Conflict(format!(
            "entry {entry_seq} shows only part of what the tool runs (it was cut, or invisible \
             characters were removed): read it in pane {id}'s terminal and approve there, or deny"
        )),
        Refusal::PartialDiff { lines, line_chars, bytes } => ApiError::Conflict(format!(
            "approval of entry {entry_seq} for pane {id} refused: its edit preview is incomplete; \
             retained {lines} lines (DIFF_MAX_LINES={}), longest retained line {line_chars} characters \
             (DIFF_LINE_MAX_CHARS={}), serialized preview {bytes} bytes (DIFF_MAX_BYTES={}); \
             read the full request in the pane's terminal and approve there, or deny",
            feed::DIFF_MAX_LINES, feed::DIFF_LINE_MAX_CHARS, feed::DIFF_MAX_BYTES
        )),
        Refusal::Choice(why) => ApiError::BadRequest(why),
    }
}

/// Drops CSI, OSC and two-byte escape sequences and carriage returns from raw
/// output, for the no-emulator fallback.
fn strip_escapes(line: &str) -> String {
    static ESCAPES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = ESCAPES.get_or_init(|| {
        regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|\r")
            .expect("escape pattern compiles")
    });
    re.replace_all(line, "").into_owned()
}

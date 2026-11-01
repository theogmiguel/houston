//! SnapShot core: capture state, the pending-capture queue, the acknowledge/attach
//! flow and the Tauri commands behind `window.desktopBridge`. The desktop APIs are
//! reached only through `platform::SnapShotPlatform`.

mod platform;

#[cfg(any(target_os = "windows", test))]
mod capture_image;
#[cfg(any(target_os = "windows", test))]
mod input_shortcut;
#[cfg(any(target_os = "windows", test))]
mod window_identity;

#[cfg(target_os = "linux")]
mod capture_config_edit;
#[cfg(target_os = "linux")]
mod capture_config_kdl;
#[cfg(target_os = "linux")]
mod capture_shortcut_config;
#[cfg(target_os = "linux")]
mod gnome_capture_setup;
#[cfg(target_os = "linux")]
mod hyprland_snapshot;
#[cfg(target_os = "linux")]
mod kde_snapshot;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod linux_capture_session;
#[cfg(target_os = "linux")]
mod native_capture_feedback;
#[cfg(target_os = "linux")]
mod niri_snapshot;
#[cfg(target_os = "linux")]
mod portal_capture_shortcut;
#[cfg(test)]
mod snapshot_transition;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod windows_capture;
#[cfg(target_os = "windows")]
mod windows_feedback;
#[cfg(target_os = "windows")]
mod windows_input;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use platform::{
    new_platform, CaptureFeedback, CaptureOptions, CaptureOutput, ConfigDesktop, PlatformPaths,
    ShortcutStatus, SnapShotPlatform, SnapShotShortcut,
};

const SHORTCUT_COOLDOWN: Duration = Duration::from_millis(200);
const EVENT_NAME: &str = "v2-snap-shot-event";
const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapShotSettings {
    pub enabled: bool,
    pub include_accessibility: bool,
    pub shortcut: SnapShotShortcut,
    pub flash: bool,
    pub animations: bool,
}

impl Default for SnapShotSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            include_accessibility: true,
            shortcut: SnapShotShortcut::default(),
            flash: true,
            animations: true,
        }
    }
}

impl SnapShotSettings {
    fn shortcut_inputs(&self) -> (bool, bool, SnapShotShortcut) {
        (
            self.enabled,
            self.include_accessibility,
            self.shortcut.clone(),
        )
    }
}

#[derive(Default)]
struct Inner {
    settings: SnapShotSettings,
    message: Option<String>,
    shortcut: Option<ShortcutStatus>,
    shortcut_verified: bool,
    shortcut_suppressed: bool,
    initialized: bool,
    last_capture: Option<SystemTime>,
    feedback: Option<(String, Box<dyn CaptureFeedback>)>,
}

pub struct SnapShotHost {
    inner: Mutex<Inner>,
    captures_dir: PathBuf,
    platform: Box<dyn SnapShotPlatform>,
    paths: PlatformPaths,
    app_id: String,
}

impl SnapShotHost {
    pub fn new(state_dir: PathBuf, app_id: String) -> Self {
        #[cfg(target_os = "linux")]
        let paths = PlatformPaths {
            home: dirs::home_dir().unwrap_or_default(),
            config_home: std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config")),
            data_home: std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local")
                        .join("share")
                }),
            state_dir: state_dir.clone(),
        };
        #[cfg(target_os = "windows")]
        let paths = PlatformPaths {
            state_dir: state_dir.clone(),
        };
        Self {
            inner: Mutex::new(Inner::default()),
            captures_dir: state_dir.join("snap-shots"),
            platform: new_platform(),
            paths,
            app_id,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn configure_with_app(&self, settings: SnapShotSettings, app: tauri::AppHandle) {
        self.platform.attach_app(&app);
        let mode = self.platform.mode();
        let mut inner = self.lock();
        let previous_inputs = inner.settings.shortcut_inputs();
        let next_inputs = settings.shortcut_inputs();
        let first = !inner.initialized;
        inner.initialized = true;
        inner.settings = settings.clone();
        let inputs_unchanged = previous_inputs.0 == next_inputs.0
            && previous_inputs.1 == next_inputs.1
            && platform::same_shortcut(&previous_inputs.2, &next_inputs.2);

        if !settings.enabled || mode.is_unavailable() {
            self.platform.release_shortcut();
            inner.shortcut = None;
            inner.shortcut_verified = false;
            inner.message = if mode.is_unavailable() {
                Some(unavailable_message())
            } else {
                None
            };
            return;
        }
        if !first && inputs_unchanged && inner.shortcut.is_some() {
            return;
        }
        drop(inner);

        let capture_app = app.clone();
        let host: Arc<SnapShotHost> = app
            .try_state::<Arc<SnapShotHost>>()
            .map(|state| Arc::clone(&state))
            .unwrap_or_else(|| {
                Arc::new(Self::new(self.paths.state_dir.clone(), self.app_id.clone()))
            });
        let on_capture: platform::TriggerCallback = {
            let host = Arc::clone(&host);
            let app = capture_app;
            Arc::new(move || {
                let host = Arc::clone(&host);
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = host.capture_blocking(&app);
                });
            })
        };
        let on_changed: platform::ChangedCallback = {
            let host = Arc::clone(&host);
            let app = app.clone();
            Arc::new(move || {
                host.emit_shortcut_changed(&app);
            })
        };
        let status = self.platform.configure_shortcut(
            &self.app_id,
            &settings.shortcut,
            on_capture,
            on_changed,
        );
        let mut inner = self.lock();
        inner.message = None;
        inner.shortcut_verified = false;
        inner.shortcut = Some(status);
    }

    fn emit(&self, app: &tauri::AppHandle, event: Value) {
        let _ = app.emit(EVENT_NAME, event);
    }

    fn emit_shortcut_changed(&self, app: &tauri::AppHandle) {
        if let Some(status) = self.platform.shortcut_status() {
            if let Ok(mut inner) = self.inner.lock() {
                inner.shortcut = Some(status);
                inner.shortcut_verified = false;
            }
        }
        self.emit(app, json!({ "type": "shortcut-changed" }));
    }

    fn state_value(&self) -> Value {
        let inner = self.lock();
        let mode = self.platform.mode();
        let support = self.platform.support();
        let status = self
            .platform
            .shortcut_status()
            .or_else(|| inner.shortcut.clone())
            .unwrap_or_default();
        let mut map = Map::new();
        map.insert("mode".into(), Value::String(mode.as_str().into()));
        map.insert(
            "shortcut".into(),
            serde_json::to_value(&inner.settings.shortcut).unwrap_or(Value::Null),
        );
        map.insert("shortcutRegistered".into(), Value::Bool(status.registered));
        map.insert(
            "shortcutMessage".into(),
            status.message.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "message".into(),
            inner
                .message
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        if let Some(pending) = status.pending {
            map.insert("shortcutPending".into(), Value::Bool(pending));
        }
        if let Some(can_retry) = status.can_retry {
            map.insert("shortcutCanRetry".into(), Value::Bool(can_retry));
        }
        if let Some(label) = status.label {
            map.insert("shortcutLabel".into(), Value::String(label));
        }
        if let Some(binding) = status.binding {
            map.insert("shortcutBinding".into(), Value::String(binding));
        }
        if let Some(path) = status.config_path {
            map.insert("shortcutConfigPath".into(), Value::String(path));
        }
        if let Some(registered) = status.action_registered {
            map.insert("shortcutActionRegistered".into(), Value::Bool(registered));
        }
        if mode.is_portal() {
            if let Some(desktop) = linux_desktop() {
                map.insert("linuxDesktop".into(), Value::String(desktop));
            }
            if let Some(backend) = support.linux_backend {
                map.insert("linuxBackend".into(), Value::String(backend));
            }
            map.insert(
                "linuxFeedbackAvailable".into(),
                Value::Bool(support.feedback_available),
            );
        }
        if let Some(desktop) = self.platform.config_desktop() {
            if let Some(path) = self.platform.shortcut_config_path(&self.paths) {
                map.insert(
                    "shortcutConfigPath".into(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
            let _ = desktop;
        }
        map.insert(
            "shortcutVerified".into(),
            Value::Bool(inner.shortcut_verified),
        );
        for (key, value) in self.platform.state_extras(&self.paths) {
            map.insert(key, value);
        }
        Value::Object(map)
    }

    fn capture_blocking(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.platform.attach_app(app);
        let (settings, suppressed, last) = {
            let inner = self.lock();
            (
                inner.settings.clone(),
                inner.shortcut_suppressed,
                inner.last_capture,
            )
        };
        if suppressed {
            return Ok(());
        }
        if !settings.enabled {
            let message = "Enable SnapShots in Settings first.".to_string();
            self.fail(app, None, &message);
            return Err(message);
        }
        if self.platform.mode().is_unavailable() {
            let message = unavailable_message();
            self.fail(app, None, &message);
            return Err(message);
        }
        if let Some(last) = last {
            if SystemTime::now().duration_since(last).unwrap_or_default() < SHORTCUT_COOLDOWN {
                return Ok(());
            }
        }
        {
            let mut inner = self.lock();
            inner.last_capture = Some(SystemTime::now());
        }

        let id = Uuid::new_v4().to_string();
        self.emit(app, json!({ "type": "requested", "id": id }));
        let options = CaptureOptions {
            flash: settings.flash,
            animate: settings.animations,
        };
        let output =
            match self
                .platform
                .capture(&self.app_id, options, &self.paths, &self.captures_dir)
            {
                Ok(output) => output,
                Err(error) => {
                    self.fail(app, Some(&id), &error);
                    return Err(error);
                }
            };
        if output
            .feedback
            .as_ref()
            .is_some_and(|feedback| feedback.animation_started())
        {
            self.emit(app, json!({ "type": "started", "id": id }));
        }
        match self.persist(&id, output) {
            Ok(()) => {
                {
                    let mut inner = self.lock();
                    inner.message = None;
                    inner.shortcut_verified = true;
                }
                self.emit(app, json!({ "type": "ready", "id": id }));
                Ok(())
            }
            Err(error) => {
                self.discard(&id);
                self.fail(app, Some(&id), &error);
                Err(error)
            }
        }
    }

    fn fail(&self, app: &tauri::AppHandle, id: Option<&str>, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.message = Some(message.to_string());
        }
        self.emit(
            app,
            match id {
                Some(id) => json!({ "type": "failed", "id": id }),
                None => json!({ "type": "failed" }),
            },
        );
    }

    fn persist(&self, id: &str, output: CaptureOutput) -> Result<(), String> {
        if output.png.len() > MAX_PNG_BYTES || !is_png(&output.png) {
            return Err("The captured image is not a valid PNG.".to_string());
        }
        fs::create_dir_all(&self.captures_dir)
            .map_err(|error| format!("creating {}: {error}", self.captures_dir.display()))?;
        let captured_at = iso_now();
        let (app_name, window_title, app_identifier) = match output.window.as_ref() {
            Some(window) => (
                platform::bounded_snapshot_string(&window.app_name, 255)
                    .unwrap_or_else(|| "Window".to_string()),
                platform::bounded_snapshot_string(&window.title, 1_000).unwrap_or_default(),
                platform::bounded_snapshot_string(&window.app_identifier, 255),
            ),
            None => ("Screen".to_string(), String::new(), None),
        };
        let mut source = Map::new();
        source.insert("kind".into(), Value::String("snap-shot".into()));
        source.insert("capturedAt".into(), Value::String(captured_at.clone()));
        source.insert("appName".into(), Value::String(app_name));
        source.insert("windowTitle".into(), Value::String(window_title));
        if let Some(identifier) = app_identifier {
            source.insert("appIdentifier".into(), Value::String(identifier));
        }
        let metadata = json!({
            "id": id,
            "name": format!("window-{}.png", captured_at.replace(':', "-")),
            "mimeType": "image/png",
            "sizeBytes": output.png.len(),
            "source": Value::Object(source),
        });
        write_atomic(&self.captures_dir.join(format!("{id}.png")), &output.png)?;
        write_atomic(
            &self.captures_dir.join(format!("{id}.json")),
            metadata.to_string().as_bytes(),
        )?;
        if let Some(feedback) = output.feedback {
            let mut inner = self.lock();
            inner.feedback = Some((id.to_string(), feedback));
        }
        Ok(())
    }

    fn discard(&self, id: &str) {
        for suffix in ["png", "json"] {
            let _ = fs::remove_file(self.captures_dir.join(format!("{id}.{suffix}")));
        }
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .feedback
                .as_ref()
                .is_some_and(|(feedback_id, _)| feedback_id == id)
            {
                inner.feedback = None;
            }
        }
    }

    fn list_pending(&self) -> Result<Vec<Value>, String> {
        let entries = match fs::read_dir(&self.captures_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("listing snapshots: {error}")),
        };
        let mut pending = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    pending.push(value);
                }
            }
        }
        pending.sort_by(|left, right| {
            let key = |value: &Value| {
                value
                    .get("source")
                    .and_then(|source| source.get("capturedAt"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            key(left).cmp(&key(right))
        });
        Ok(pending)
    }

    fn read(&self, id: &str) -> Result<Value, String> {
        validate_id(id)?;
        let text = fs::read_to_string(self.captures_dir.join(format!("{id}.json")))
            .map_err(|error| format!("reading snapshot {id}: {error}"))?;
        let mut metadata: Value = serde_json::from_str(&text)
            .map_err(|error| format!("snapshot {id} metadata: {error}"))?;
        let png = fs::read(self.captures_dir.join(format!("{id}.png")))
            .map_err(|error| format!("reading snapshot image {id}: {error}"))?;
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        );
        metadata
            .as_object_mut()
            .ok_or_else(|| format!("snapshot {id} metadata is not an object"))?
            .insert("dataUrl".into(), Value::String(data_url));
        Ok(metadata)
    }

    fn acknowledge(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .feedback
                .as_ref()
                .is_some_and(|(feedback_id, _)| feedback_id == id)
            {
                if let Some((_, mut feedback)) = inner.feedback.take() {
                    feedback.complete();
                }
            }
        }
        for suffix in ["json", "png"] {
            let _ = fs::remove_file(self.captures_dir.join(format!("{id}.{suffix}")));
        }
        Ok(())
    }
}

fn unavailable_message() -> String {
    if cfg!(target_os = "linux") {
        "SnapShots require a Wayland session. X11 capture is not supported.".to_string()
    } else {
        "SnapShots are not available on this platform yet.".to_string()
    }
}

fn linux_desktop() -> Option<String> {
    std::env::var("XDG_CURRENT_DESKTOP").ok().and_then(|value| {
        value
            .to_lowercase()
            .split(':')
            .find(|name| matches!(*name, "gnome" | "kde" | "niri" | "hyprland"))
            .map(str::to_string)
    })
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(format!(
            "invalid snapshot id {id:?}: expected 1-64 hex digits or hyphens"
        ));
    }
    Ok(())
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("creating {}: {error}", temporary.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("writing {}: {error}", temporary.display()))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "renaming {} to {}: {error}",
            temporary.display(),
            path.display()
        )
    })
}

/// ISO-8601 UTC with milliseconds, without pulling in a date crate.
pub fn iso_now() -> String {
    iso_from_unix(SystemTime::now())
}

fn iso_from_unix(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = duration.as_secs();
    let millis = duration.subsec_millis();
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[tauri::command]
pub async fn snap_shot_configure(
    settings: SnapShotSettings,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    host.configure_with_app(settings, app);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_state(host: State<'_, Arc<SnapShotHost>>) -> Result<Value, String> {
    Ok(host.state_value())
}

#[tauri::command]
pub async fn snap_shot_capture(
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let host = Arc::clone(&host);
    tauri::async_runtime::spawn_blocking(move || host.capture_blocking(&app))
        .await
        .map_err(|error| format!("snapshot task stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn snap_shot_check_shortcut(
    shortcut: SnapShotShortcut,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    let availability = host.platform.check_shortcut(&shortcut);
    Ok(json!({
        "available": availability.available,
        "message": availability.message,
    }))
}

#[tauri::command]
pub async fn snap_shot_setup(
    action: String,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    host.platform.setup(&action, &host.paths)?;
    if action == "retry-shortcut" {
        let settings = host.lock().settings.clone();
        host.configure_with_app(settings, app);
    }
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_preview_config(
    request: Value,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<Option<Value>, String> {
    let choose_file = request
        .get("chooseFile")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let selected = if choose_file {
        let extension = if host.platform.config_desktop() == Some(ConfigDesktop::Niri) {
            "kdl"
        } else {
            "conf"
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .add_filter("Desktop config", &[extension, "lua"])
            .pick_file(move |picked| {
                let _ = tx.send(picked.and_then(|file| file.into_path().ok()));
            });
        match rx.await.ok().flatten() {
            Some(path) => Some(path),
            None => return Ok(None),
        }
    } else {
        None
    };
    let preview =
        host.platform
            .preview_config(&host.app_id, &request, selected.as_deref(), &host.paths)?;
    Ok(Some(preview))
}

#[tauri::command]
pub async fn snap_shot_apply_config(
    preview_id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    let applied = host.platform.apply_config(&preview_id)?;
    host.lock().shortcut_verified = false;
    Ok(applied)
}

#[tauri::command]
pub async fn snap_shot_set_shortcut_suppressed(
    suppressed: bool,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    host.lock().shortcut_suppressed = suppressed;
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_list_pending(
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Vec<Value>, String> {
    host.list_pending()
}

#[tauri::command]
pub async fn snap_shot_read(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    host.read(&id)
}

#[tauri::command]
pub async fn snap_shot_acknowledge(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    host.acknowledge(&id)
}

#[tauri::command]
pub async fn snap_shot_set_animation_destination(
    id: String,
    destination: Value,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let frame = destination
        .get("relativeFrame")
        .and_then(parse_normalized_frame);
    let mut inner = host.lock();
    if let Some((feedback_id, feedback)) = inner.feedback.as_mut() {
        if feedback_id == &id {
            if let Some(frame) = frame {
                let _ = feedback.animate_to(frame);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_dismiss_animation(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let mut inner = host.lock();
    if inner
        .feedback
        .as_ref()
        .is_some_and(|(feedback_id, _)| feedback_id == &id)
    {
        if let Some((_, mut feedback)) = inner.feedback.take() {
            feedback.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_request_permissions(_include_accessibility: bool) -> Result<(), String> {
    Ok(())
}

fn parse_normalized_frame(value: &Value) -> Option<platform::NormalizedFrame> {
    Some(platform::NormalizedFrame {
        x: value.get("x")?.as_f64()?,
        y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?,
        height: value.get("height")?.as_f64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::platform::Bounds;

    #[test]
    fn iso_epoch_is_formatted_as_utc() {
        assert_eq!(
            iso_from_unix(UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z".to_string()
        );
    }

    #[test]
    fn iso_keeps_calendar_boundaries() {
        assert_eq!(
            iso_from_unix(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z".to_string()
        );
        assert_eq!(
            iso_from_unix(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            "2023-11-14T22:13:20.000Z".to_string()
        );
    }

    #[test]
    fn snapshot_ids_cannot_escape_the_capture_directory() {
        assert!(validate_id("../../etc/passwd").is_err());
        assert!(validate_id("0b8e6f2a-1c4d-4a8e-9f1a-2b3c4d5e6f70").is_ok());
        assert!(validate_id("ABC-def-123").is_ok());
    }

    #[test]
    fn png_header_is_checked_before_persisting() {
        assert!(is_png(&[137, 80, 78, 71, 13, 10, 26, 10, 0]));
        assert!(!is_png(b"not a png"));
    }

    #[test]
    fn settings_default_matches_the_contract_defaults() {
        let settings = SnapShotSettings::default();
        assert!(!settings.enabled);
        assert!(settings.include_accessibility);
        assert_eq!(settings.shortcut, SnapShotShortcut::default());
    }

    fn test_host() -> (SnapShotHost, PathBuf) {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join(".agent-tmp")
            .join(format!("snapshot-test-{}", Uuid::new_v4().simple()));
        let host = SnapShotHost::new(base.clone(), "dev.houston.desktop".to_string());
        (host, base)
    }

    #[test]
    fn pending_captures_round_trip_and_acknowledge_removes_them() {
        let (host, base) = test_host();
        let png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3].to_vec();
        let output = CaptureOutput {
            png,
            window: Some(platform::WindowMetadata {
                title: "Editor".to_string(),
                app_name: "Text Editor".to_string(),
                app_identifier: "org.gnome.TextEditor".to_string(),
                process_id: 42,
                bounds: Bounds {
                    x: 10,
                    y: 20,
                    width: 800,
                    height: 600,
                },
                client_bounds: None,
                accessibility_bounds_reliable: None,
            }),
            feedback: None,
        };
        host.persist("0b8e6f2a-1c4d-4a8e-9f1a-2b3c4d5e6f70", output)
            .expect("persist");
        let pending = host.list_pending().expect("list");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["source"]["appName"], "Text Editor");
        let capture = host
            .read("0b8e6f2a-1c4d-4a8e-9f1a-2b3c4d5e6f70")
            .expect("read");
        assert!(capture["dataUrl"]
            .as_str()
            .expect("dataUrl")
            .starts_with("data:image/png;base64,"));
        host.acknowledge("0b8e6f2a-1c4d-4a8e-9f1a-2b3c4d5e6f70")
            .expect("acknowledge");
        assert!(host.list_pending().expect("list after ack").is_empty());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "reads this machine's desktop session"]
    fn reports_this_machines_state_json() {
        let (host, base) = test_host();
        println!("{}", host.state_value());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn invalid_png_is_refused_before_writing_metadata() {
        let (host, base) = test_host();
        let output = CaptureOutput {
            png: b"not a png".to_vec(),
            window: None,
            feedback: None,
        };
        assert!(host
            .persist("0b8e6f2a-1c4d-4a8e-9f1a-2b3c4d5e6f70", output)
            .is_err());
        assert!(host.list_pending().expect("list").is_empty());
        let _ = fs::remove_dir_all(base);
    }
}

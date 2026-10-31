//! Linux platform: backend detection, capture dispatch, shortcut registration and
//! compositor config setup. Mirrors upstream `LinuxSnapShot.ts` and the parts of
//! `DesktopSnapShot.ts` that select between them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use zbus::blocking::{Connection, Proxy};
use zbus::message::Type;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as ZValue};
use zbus::{MatchRule, MessageStream, Proxy as AsyncProxy};

use super::capture_shortcut_config::{niri_capture_config_path, CaptureShortcutConfig};
use super::gnome_capture_setup::GnomeCaptureSetup;
use super::hyprland_snapshot::{HyprlandCaptureSetup, HyprlandShortcut};
use super::kde_snapshot::{KdeCapturePaths, KdeCaptureSetup};
use super::linux_capture_session::{
    is_gnome_capture_session, is_hyprland_capture_session, is_kde_capture_session,
    is_wayland_session, niri_capture_binding, portal_shortcut_trigger, read_portal_png, sandboxed,
};
use super::niri_snapshot::{capture_window as capture_niri_window, niri_socket_path};
use super::platform::{
    Bounds, CaptureFeedback, CaptureOptions, CaptureOutput, CaptureSupport, ChangedCallback,
    ConfigDesktop, NormalizedFrame, PlatformPaths, ShortcutAvailability, ShortcutStatus,
    SnapShotMode, SnapShotPlatform, SnapShotShortcut, TriggerCallback, WindowMetadata,
};
use super::portal_capture_shortcut::PortalCaptureShortcut;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREENSHOT: &str = "org.freedesktop.portal.Screenshot";
const REQUEST: &str = "org.freedesktop.portal.Request";
const KWIN: &str = "org.kde.KWin.ScreenShot2";
const KWIN_PATH: &str = "/org/kde/KWin/ScreenShot2";
const EXTENSION: &str = "org.gnome.Shell.Extensions.T3SnapShot";
const EXTENSION_PATH: &str = "/org/gnome/Shell/Extensions/T3SnapShot";
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(120);
const WAYLAND_PAIR_MESSAGE: &str = "Modifier-pair shortcuts aren't available in this Wayland session. Choose another shortcut or use Take snapshot from the command palette.";

pub struct LinuxPlatform {
    portal: Mutex<Option<PortalCaptureShortcut>>,
    config: CaptureShortcutConfig,
    last_portal_status: Mutex<Option<ShortcutStatus>>,
}

impl LinuxPlatform {
    pub fn new() -> Self {
        Self {
            portal: Mutex::new(None),
            config: CaptureShortcutConfig::default(),
            last_portal_status: Mutex::new(None),
        }
    }

    fn backend(&self) -> Result<String, String> {
        if is_hyprland_capture_session() {
            return Ok("hyprland".to_string());
        }
        if niri_socket_path().is_some() {
            return Ok("niri".to_string());
        }
        if is_kde_capture_session() {
            if let Some(properties) = blocking_properties(KWIN, KWIN_PATH, KWIN) {
                let version = properties
                    .get("Version")
                    .cloned()
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(0);
                if version >= 2 {
                    return Ok("kde".to_string());
                }
            }
        }
        if !sandboxed() {
            let _ = blocking_registry_register();
        }
        if let Some(properties) = blocking_properties(PORTAL, PORTAL_PATH, SCREENSHOT) {
            let version = properties
                .get("version")
                .cloned()
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            let targets = properties
                .get("AvailableTargets")
                .cloned()
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            if version >= 3 && targets & 8 != 0 {
                return Ok("screenshot-portal".to_string());
            }
        }
        if is_gnome_capture_session() {
            if let Some(properties) = blocking_properties(EXTENSION, EXTENSION_PATH, EXTENSION) {
                let version = properties
                    .get("Version")
                    .cloned()
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(0);
                if version == 1 || version == 2 {
                    return Ok("gnome-extension".to_string());
                }
            }
        }
        Ok("picker".to_string())
    }
}

impl Default for LinuxPlatform {
    fn default() -> Self {
        Self::new()
    }
}

fn blocking_properties(
    destination: &str,
    path: &str,
    interface: &str,
) -> Option<HashMap<String, OwnedValue>> {
    let connection = Connection::session().ok()?;
    let proxy = Proxy::new(
        &connection,
        destination,
        path,
        "org.freedesktop.DBus.Properties",
    )
    .ok()?;
    proxy.call("GetAll", &(interface,)).ok()
}

fn blocking_registry_register() -> Result<(), String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let proxy = Proxy::new(
        &connection,
        PORTAL,
        PORTAL_PATH,
        "org.freedesktop.host.portal.Registry",
    )
    .map_err(|error| error.to_string())?;
    let options: HashMap<String, ZValue<'_>> = HashMap::new();
    proxy
        .call::<_, _, ()>("Register", &("dev.houston.desktop", options))
        .map_err(|error| error.to_string())
}

fn window_from_extension(value: &Value) -> Option<WindowMetadata> {
    let bounds = value.get("bounds")?;
    Some(WindowMetadata {
        title: value.get("title")?.as_str()?.to_string(),
        app_name: value.get("appName")?.as_str()?.to_string(),
        app_identifier: value.get("appIdentifier")?.as_str()?.to_string(),
        process_id: value.get("processId")?.as_u64()?,
        bounds: Bounds {
            x: bounds.get("x")?.as_i64()?,
            y: bounds.get("y")?.as_i64()?,
            width: bounds.get("width")?.as_i64()?,
            height: bounds.get("height")?.as_i64()?,
        },
        client_bounds: value.get("clientBounds").and_then(|bounds| {
            Some(Bounds {
                x: bounds.get("x")?.as_i64()?,
                y: bounds.get("y")?.as_i64()?,
                width: bounds.get("width")?.as_i64()?,
                height: bounds.get("height")?.as_i64()?,
            })
        }),
        accessibility_bounds_reliable: None,
    })
}

struct ExtensionFeedback {
    connection: Connection,
    animation_started: bool,
}

impl CaptureFeedback for ExtensionFeedback {
    fn animation_started(&self) -> bool {
        self.animation_started
    }

    fn animate_to(&mut self, frame: NormalizedFrame) -> Result<(), String> {
        let proxy = Proxy::new(&self.connection, EXTENSION, EXTENSION_PATH, EXTENSION)
            .map_err(|error| error.to_string())?;
        proxy
            .call::<_, _, ()>("Animate", &(frame.x, frame.y, frame.width, frame.height))
            .map_err(|error| error.to_string())
    }

    fn complete(&mut self) {}

    fn close(&mut self) {}
}

fn capture_extension(app_id: &str, options: CaptureOptions) -> Result<CaptureOutput, String> {
    let connection =
        Connection::session().map_err(|error| format!("connecting to GNOME capture: {error}"))?;
    let _ = connection.request_name(format!("{app_id}.SnapShot"));
    let proxy = Proxy::new(&connection, EXTENSION, EXTENSION_PATH, EXTENSION)
        .map_err(|error| format!("GNOME capture extension: {error}"))?;
    let with_feedback = options.flash || options.animate;
    let (png, window, animation_started) = if with_feedback {
        let (png, window, started): (Vec<u8>, String, bool) = proxy
            .call("CaptureWithFeedback", &(options.flash, options.animate))
            .map_err(|error| format!("the GNOME extension did not capture: {error}"))?;
        (png, window, started)
    } else {
        let (png, window): (Vec<u8>, String) = proxy
            .call("Capture", &())
            .map_err(|error| format!("the GNOME extension did not capture: {error}"))?;
        (png, window, false)
    };
    super::linux_capture_session::validate_png(&png)?;
    let window: Value = serde_json::from_str(&window).map_err(|error| {
        format!("the GNOME extension returned invalid window metadata: {error}")
    })?;
    let window = window_from_extension(&window);
    let feedback = with_feedback.then(|| {
        Box::new(ExtensionFeedback {
            connection,
            animation_started,
        }) as Box<dyn CaptureFeedback>
    });
    Ok(CaptureOutput {
        png,
        window,
        feedback,
    })
}

async fn portal_screenshot(interactive: bool) -> Result<Vec<u8>, String> {
    let connection = zbus::Connection::session()
        .await
        .map_err(|error| format!("connecting to the screenshot portal: {error}"))?;
    let unique = connection
        .unique_name()
        .map(|name| name.as_str().trim_start_matches(':').replace('.', "_"))
        .unwrap_or_else(|| "unknown".to_string());
    let namespace = format!("{PORTAL_PATH}/request/{unique}/");
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(REQUEST)
        .map_err(|error| error.to_string())?
        .member("Response")
        .map_err(|error| error.to_string())?
        .path_namespace(namespace.trim_end_matches('/'))
        .map_err(|error| error.to_string())?
        .build();
    let mut responses = MessageStream::for_match_rule(rule, &connection, Some(8))
        .await
        .map_err(|error| format!("subscribing to screenshot responses: {error}"))?;
    let proxy = AsyncProxy::new(&connection, PORTAL, PORTAL_PATH, SCREENSHOT)
        .await
        .map_err(|error| format!("screenshot portal: {error}"))?;
    let token = format!("houston_{}", uuid::Uuid::new_v4().simple());
    let mut options: HashMap<String, ZValue<'_>> = HashMap::new();
    options.insert("handle_token".to_string(), ZValue::from(token));
    options.insert("interactive".to_string(), ZValue::from(interactive));
    options.insert("modal".to_string(), ZValue::from(true));
    let _handle: OwnedObjectPath = proxy
        .call("Screenshot", &("", options))
        .await
        .map_err(|error| format!("the screenshot portal did not start: {error}"))?;
    let message = tokio::time::timeout(SCREENSHOT_TIMEOUT, responses.next())
        .await
        .map_err(|_| "Snapshot timed out.".to_string())?
        .ok_or_else(|| "The screenshot portal disconnected.".to_string())?
        .map_err(|error| format!("screenshot portal response: {error}"))?;
    let (status, results): (u32, HashMap<String, OwnedValue>) = message
        .body()
        .deserialize()
        .map_err(|error| format!("screenshot portal response body: {error}"))?;
    if status == 1 {
        return Err("Snapshot was cancelled.".to_string());
    }
    if status != 0 {
        return Err("Your desktop did not allow the snapshot.".to_string());
    }
    let uri = results
        .get("uri")
        .cloned()
        .and_then(|value| String::try_from(value).ok())
        .ok_or_else(|| "The screenshot portal returned no image.".to_string())?;
    read_portal_png(&uri)
}

impl SnapShotPlatform for LinuxPlatform {
    fn mode(&self) -> SnapShotMode {
        if is_wayland_session() {
            SnapShotMode::Portal
        } else {
            SnapShotMode::Unavailable
        }
    }

    fn support(&self) -> CaptureSupport {
        let backend = self.backend().ok();
        let feedback_available = backend.as_deref() == Some("gnome-extension")
            && blocking_properties(EXTENSION, EXTENSION_PATH, EXTENSION).and_then(|properties| {
                properties
                    .get("Version")
                    .cloned()
                    .and_then(|value| u32::try_from(value).ok())
            }) == Some(2);
        CaptureSupport {
            linux_backend: backend,
            feedback_available,
        }
    }

    fn capture(
        &self,
        app_id: &str,
        options: CaptureOptions,
        paths: &PlatformPaths,
        temp_dir: &Path,
    ) -> Result<CaptureOutput, String> {
        let backend = self.backend()?;
        match backend.as_str() {
            "hyprland" => super::hyprland_snapshot::capture(paths, options, temp_dir),
            "niri" => {
                let socket = niri_socket_path()
                    .ok_or_else(|| "Niri is no longer available in this session.".to_string())?;
                std::fs::create_dir_all(temp_dir)
                    .map_err(|error| format!("creating {}: {error}", temp_dir.display()))?;
                let directory = temp_dir.join(format!("niri-{}", uuid::Uuid::new_v4().simple()));
                std::fs::create_dir_all(&directory)
                    .map_err(|error| format!("creating {}: {error}", directory.display()))?;
                let result = capture_niri_window(&socket, &directory);
                let _ = std::fs::remove_dir_all(&directory);
                result
            }
            "kde" => super::kde_snapshot::capture(
                &KdeCapturePaths {
                    bundle: paths.state_dir.join("kde-capture").join("t3-kde-snap-shot"),
                    data_home: paths.data_home.clone(),
                },
                options,
                temp_dir,
            ),
            "gnome-extension" => capture_extension(app_id, options),
            "screenshot-portal" => Ok(CaptureOutput {
                png: tauri::async_runtime::block_on(portal_screenshot(false))?,
                window: None,
                feedback: None,
            }),
            _ => Ok(CaptureOutput {
                png: tauri::async_runtime::block_on(portal_screenshot(true))?,
                window: None,
                feedback: None,
            }),
        }
    }

    fn configure_shortcut(
        &self,
        app_id: &str,
        shortcut: &SnapShotShortcut,
        on_capture: TriggerCallback,
        on_changed: ChangedCallback,
    ) -> ShortcutStatus {
        self.release_shortcut();
        if is_hyprland_capture_session() {
            let shortcut_info = super::hyprland_snapshot::capture_shortcut(
                app_id,
                &std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config")),
            );
            return match shortcut_info {
                Ok(HyprlandShortcut {
                    binding,
                    config_path,
                }) => ShortcutStatus {
                    registered: false,
                    message: Some(
                        "Managed by Hyprland. Add the binding to your config and save it."
                            .to_string(),
                    ),
                    binding: Some(binding),
                    config_path: Some(config_path.to_string_lossy().into_owned()),
                    action_registered: Some(false),
                    ..Default::default()
                },
                Err(error) => ShortcutStatus {
                    message: Some(error),
                    ..Default::default()
                },
            };
        }
        if niri_socket_path().is_some() {
            return ShortcutStatus {
                registered: false,
                message: Some("Set up the shortcut to add it to your Niri config.".to_string()),
                binding: Some(niri_capture_binding(app_id)),
                config_path: Some(
                    niri_capture_config_path(&PlatformPaths {
                        home: dirs::home_dir().unwrap_or_default(),
                        state_dir: PathBuf::new(),
                        config_home: std::env::var_os("XDG_CONFIG_HOME")
                            .map(PathBuf::from)
                            .unwrap_or_else(|| {
                                dirs::home_dir().unwrap_or_default().join(".config")
                            }),
                        data_home: PathBuf::new(),
                    })
                    .to_string_lossy()
                    .into_owned(),
                ),
                action_registered: Some(false),
                ..Default::default()
            };
        }
        if shortcut.is_modifier_pair() {
            return ShortcutStatus {
                registered: false,
                message: Some(WAYLAND_PAIR_MESSAGE.to_string()),
                ..Default::default()
            };
        }
        let SnapShotShortcut::Chord(chord) = shortcut else {
            return ShortcutStatus::default();
        };
        let portal =
            PortalCaptureShortcut::start(app_id.to_string(), chord.clone(), on_capture, on_changed);
        let status = portal_status(&portal.state());
        if let Ok(mut last) = self.last_portal_status.lock() {
            *last = Some(status.clone());
        }
        if let Ok(mut slot) = self.portal.lock() {
            *slot = Some(portal);
        }
        status
    }

    fn release_shortcut(&self) {
        if let Ok(mut slot) = self.portal.lock() {
            if let Some(portal) = slot.take() {
                portal.release();
            }
        }
        if let Ok(mut last) = self.last_portal_status.lock() {
            *last = None;
        }
    }

    fn shortcut_status(&self) -> Option<ShortcutStatus> {
        if let Ok(slot) = self.portal.lock() {
            if let Some(portal) = slot.as_ref() {
                let status = portal_status(&portal.state());
                if let Ok(mut last) = self.last_portal_status.lock() {
                    *last = Some(status.clone());
                }
                return Some(status);
            }
        }
        self.last_portal_status
            .lock()
            .ok()
            .and_then(|status| status.clone())
    }

    fn state_extras(&self, paths: &PlatformPaths) -> serde_json::Map<String, Value> {
        let mut extras = serde_json::Map::new();
        if self.mode() != SnapShotMode::Portal {
            return extras;
        }
        if is_gnome_capture_session() {
            let state = GnomeCaptureSetup::new(
                paths.state_dir.join("gnome-extension"),
                paths.data_home.clone(),
            )
            .state();
            if let Ok(value) = serde_json::to_value(state) {
                extras.insert("gnomeExtension".to_string(), value);
            }
        }
        let backend = self.backend().unwrap_or_default();
        if backend == "kde" {
            let state = KdeCaptureSetup::new(KdeCapturePaths {
                bundle: paths.state_dir.join("kde-capture").join("t3-kde-snap-shot"),
                data_home: paths.data_home.clone(),
            })
            .state();
            if let Ok(value) = serde_json::to_value(state) {
                extras.insert("kdeHelper".to_string(), value);
            }
        }
        if backend == "hyprland" {
            let setup = HyprlandCaptureSetup::new(paths.clone());
            let state = setup.state();
            let feedback = state.status == "ready" && state.feedback_available == Some(true);
            if let Ok(value) = serde_json::to_value(state) {
                extras.insert("hyprlandHelper".to_string(), value);
            }
            extras.insert("linuxFeedbackAvailable".to_string(), Value::Bool(feedback));
            if let Ok(shortcut) = super::hyprland_snapshot::capture_shortcut(
                "dev.houston.desktop",
                &paths.config_home,
            ) {
                extras.insert(
                    "shortcutBinding".to_string(),
                    Value::String(shortcut.binding),
                );
                extras.insert(
                    "shortcutConfigPath".to_string(),
                    Value::String(shortcut.config_path.to_string_lossy().into_owned()),
                );
            }
        }
        extras
    }

    fn check_shortcut(&self, shortcut: &SnapShotShortcut) -> ShortcutAvailability {
        if self.mode() == SnapShotMode::Unavailable {
            return ShortcutAvailability {
                available: false,
                message: Some("SnapShots are not supported on this platform.".to_string()),
            };
        }
        if niri_socket_path().is_some() {
            return ShortcutAvailability {
                available: false,
                message: Some(
                    "Configure the capture shortcut in your Niri config, not in Houston."
                        .to_string(),
                ),
            };
        }
        if is_hyprland_capture_session() {
            return ShortcutAvailability {
                available: false,
                message: Some(
                    "Change the capture binding in your Hyprland config, then save it.".to_string(),
                ),
            };
        }
        if shortcut.is_modifier_pair() {
            return ShortcutAvailability {
                available: false,
                message: Some(WAYLAND_PAIR_MESSAGE.to_string()),
            };
        }
        if let Some(conflict) = super::platform::system_conflict(shortcut) {
            return ShortcutAvailability {
                available: false,
                message: Some(conflict),
            };
        }
        let SnapShotShortcut::Chord(chord) = shortcut else {
            return ShortcutAvailability {
                available: false,
                message: Some("Unsupported shortcut.".to_string()),
            };
        };
        match portal_shortcut_trigger(chord) {
            Ok(_) => ShortcutAvailability {
                available: true,
                message: Some(
                    "Your desktop will confirm this shortcut when you save it.".to_string(),
                ),
            },
            Err(message) => ShortcutAvailability {
                available: false,
                message: Some(message),
            },
        }
    }

    fn setup(&self, action: &str, paths: &PlatformPaths) -> Result<(), String> {
        if action == "retry-shortcut" {
            return Ok(());
        }
        if matches!(
            action,
            "test-mac-capture" | "allow-screen-recording" | "allow-accessibility"
        ) {
            return Err("That setup action requires macOS.".to_string());
        }
        if action == "install-kde-helper" || action == "remove-kde-helper" {
            if !is_kde_capture_session() {
                return Err(
                    "Helper setup requires a KDE Plasma Wayland session outside a sandbox."
                        .to_string(),
                );
            }
            return KdeCaptureSetup::new(KdeCapturePaths {
                bundle: paths.state_dir.join("kde-capture").join("t3-kde-snap-shot"),
                data_home: paths.data_home.clone(),
            })
            .perform(action);
        }
        if action == "install-hyprland-helper" || action == "remove-hyprland-helper" {
            if !is_hyprland_capture_session() {
                return Err(
                    "Helper setup requires a Hyprland Wayland session outside a sandbox."
                        .to_string(),
                );
            }
            return HyprlandCaptureSetup::new(paths.clone()).perform(action);
        }
        if !is_gnome_capture_session() {
            return Err(
                "Extension setup requires a GNOME Wayland session outside a sandbox.".to_string(),
            );
        }
        GnomeCaptureSetup::new(
            paths.state_dir.join("gnome-extension"),
            paths.data_home.clone(),
        )
        .perform(action)
    }

    fn config_desktop(&self) -> Option<ConfigDesktop> {
        if self.mode() != SnapShotMode::Portal {
            return None;
        }
        if niri_socket_path().is_some() {
            return Some(ConfigDesktop::Niri);
        }
        is_hyprland_capture_session().then_some(ConfigDesktop::Hyprland)
    }

    fn shortcut_config_path(&self, paths: &PlatformPaths) -> Option<PathBuf> {
        match self.config_desktop()? {
            ConfigDesktop::Niri => Some(niri_capture_config_path(paths)),
            ConfigDesktop::Hyprland => super::hyprland_snapshot::capture_shortcut(
                "dev.houston.desktop",
                &paths.config_home,
            )
            .ok()
            .map(|shortcut| shortcut.config_path),
        }
    }

    fn preview_config(
        &self,
        app_id: &str,
        request: &Value,
        selected_path: Option<&Path>,
        paths: &PlatformPaths,
    ) -> Result<Value, String> {
        let desktop = self
            .config_desktop()
            .ok_or_else(|| "Config setup requires a Niri or Hyprland session.".to_string())?;
        self.config
            .preview(request, selected_path, paths, app_id, desktop)
    }

    fn apply_config(&self, id: &str) -> Result<Value, String> {
        let desktop = self
            .config_desktop()
            .ok_or_else(|| "Config setup requires a Niri or Hyprland session.".to_string())?;
        self.config.apply(id, desktop)
    }
}

fn portal_status(state: &super::portal_capture_shortcut::PortalShortcutState) -> ShortcutStatus {
    ShortcutStatus {
        registered: state.registered,
        message: state.message.clone(),
        pending: Some(state.pending),
        can_retry: Some(state.can_retry),
        label: state.label.clone(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads this machine's desktop session"]
    fn reports_the_real_session_backend() {
        let platform = LinuxPlatform::new();
        let support = platform.support();
        println!(
            "session={:?} desktop={:?} backend={:?} feedback={}",
            std::env::var("XDG_SESSION_TYPE").ok(),
            std::env::var("XDG_CURRENT_DESKTOP").ok(),
            support.linux_backend,
            support.feedback_available
        );
        assert_eq!(platform.mode(), SnapShotMode::Portal);
    }
}

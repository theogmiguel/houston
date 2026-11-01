//! Windows platform: active-window capture, the global shortcut (chord or polled
//! modifier pair) and the capture flash. Mirrors upstream `DesktopSnapShot.ts`'s
//! `direct` mode, `GlobalShiftShortcutWorker.ts` and `WindowsCaptureFeedback.ts`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::input_shortcut::{
    chord_failure_message, chord_spec, observed_pair_message, pair_failure_message,
};
use super::platform::{
    Bounds, CaptureFeedback, CaptureOptions, CaptureOutput, CaptureSupport, ChangedCallback,
    PlatformPaths, ShortcutAvailability, ShortcutStatus, SnapShotMode, SnapShotPlatform,
    SnapShotShortcut, TriggerCallback, WindowMetadata,
};
use super::windows_input::{ChordShortcut, ModifierPairShortcut};

const WINDOW_UNAVAILABLE: &str = "The active window is not available for capture.";
const CAPTURE_FAILED: &str = "Could not capture the active window.";

enum Shortcut {
    Chord(ChordShortcut),
    Pair(ModifierPairShortcut),
}

impl Shortcut {
    fn stop(self) {
        match self {
            Self::Chord(worker) => drop(worker),
            Self::Pair(worker) => drop(worker),
        }
    }
}

pub struct WindowsPlatform {
    app: Mutex<Option<tauri::AppHandle>>,
    shortcut: Mutex<Option<Shortcut>>,
    status: Mutex<Option<ShortcutStatus>>,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        Self {
            app: Mutex::new(None),
            shortcut: Mutex::new(None),
            status: Mutex::new(None),
        }
    }

    fn set_status(&self, status: ShortcutStatus) -> ShortcutStatus {
        if let Ok(mut slot) = self.status.lock() {
            *slot = Some(status.clone());
        }
        status
    }

    fn store_shortcut(&self, shortcut: Shortcut) {
        if let Ok(mut slot) = self.shortcut.lock() {
            *slot = Some(shortcut);
        }
    }
}

impl Default for WindowsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapShotPlatform for WindowsPlatform {
    fn mode(&self) -> SnapShotMode {
        SnapShotMode::Direct
    }

    fn support(&self) -> CaptureSupport {
        CaptureSupport {
            linux_backend: None,
            feedback_available: true,
        }
    }

    fn attach_app(&self, app: &tauri::AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app.clone());
        }
    }

    fn capture(
        &self,
        _app_id: &str,
        options: CaptureOptions,
        _paths: &PlatformPaths,
        _temp_dir: &Path,
    ) -> Result<CaptureOutput, String> {
        let active = super::windows_capture::active_window().ok_or_else(|| {
            format!("{WINDOW_UNAVAILABLE} Expected a foreground window with visible bounds.")
        })?;
        let bitmap = super::windows_capture::capture_bounds(active.bounds)
            .map_err(|error| format!("{CAPTURE_FAILED} {error}"))?;
        let png = super::capture_image::encode_capture(&bitmap.pixels, bitmap.width, bitmap.height)
            .map_err(|error| format!("{CAPTURE_FAILED} {error}"))?;
        let feedback = if options.flash {
            self.app
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .and_then(|app| super::windows_feedback::show(&app, active.bounds, options))
                .map(|flash| Box::new(flash) as Box<dyn CaptureFeedback>)
        } else {
            None
        };
        Ok(CaptureOutput {
            png,
            window: Some(WindowMetadata {
                title: active.title,
                app_name: active.app_name,
                app_identifier: String::new(),
                process_id: u64::from(active.process_id),
                bounds: Bounds {
                    x: active.bounds.x,
                    y: active.bounds.y,
                    width: active.bounds.width,
                    height: active.bounds.height,
                },
                client_bounds: None,
                accessibility_bounds_reliable: None,
            }),
            feedback,
        })
    }

    fn configure_shortcut(
        &self,
        _app_id: &str,
        shortcut: &SnapShotShortcut,
        on_capture: TriggerCallback,
        _on_changed: ChangedCallback,
    ) -> ShortcutStatus {
        self.release_shortcut();
        let status = if let Some(modifier) = shortcut.modifier_pair() {
            match ModifierPairShortcut::start(modifier, on_capture) {
                Ok(worker) => {
                    self.store_shortcut(Shortcut::Pair(worker));
                    ShortcutStatus {
                        registered: true,
                        message: Some(observed_pair_message(modifier)),
                        ..Default::default()
                    }
                }
                Err(error) => ShortcutStatus {
                    registered: false,
                    message: Some(format!("{} {error}", pair_failure_message(modifier))),
                    ..Default::default()
                },
            }
        } else {
            let SnapShotShortcut::Chord(chord) = shortcut else {
                return ShortcutStatus::default();
            };
            match chord_spec(chord) {
                Ok(spec) => match ChordShortcut::start(spec, on_capture) {
                    Ok(worker) => {
                        self.store_shortcut(Shortcut::Chord(worker));
                        ShortcutStatus {
                            registered: true,
                            ..Default::default()
                        }
                    }
                    Err(error) => ShortcutStatus {
                        registered: false,
                        message: Some(error),
                        ..Default::default()
                    },
                },
                Err(message) => ShortcutStatus {
                    registered: false,
                    message: Some(message),
                    ..Default::default()
                },
            }
        };
        self.set_status(status)
    }

    fn release_shortcut(&self) {
        if let Ok(mut slot) = self.shortcut.lock() {
            if let Some(shortcut) = slot.take() {
                shortcut.stop();
            }
        }
        if let Ok(mut slot) = self.status.lock() {
            *slot = None;
        }
    }

    fn shortcut_status(&self) -> Option<ShortcutStatus> {
        self.status.lock().ok().and_then(|status| status.clone())
    }

    fn state_extras(&self, _paths: &PlatformPaths) -> serde_json::Map<String, Value> {
        let mut extras = serde_json::Map::new();
        extras.insert("windows".to_string(), Value::Bool(true));
        extras
    }

    fn check_shortcut(&self, shortcut: &SnapShotShortcut) -> ShortcutAvailability {
        if let Some(modifier) = shortcut.modifier_pair() {
            let probe: TriggerCallback = Arc::new(|| {});
            return match ModifierPairShortcut::start(modifier, probe) {
                Ok(_) => ShortcutAvailability {
                    available: true,
                    message: Some(observed_pair_message(modifier)),
                },
                Err(error) => ShortcutAvailability {
                    available: false,
                    message: Some(format!("{} {error}", pair_failure_message(modifier))),
                },
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
        let probe: TriggerCallback = Arc::new(|| {});
        match chord_spec(chord) {
            Ok(spec) => match ChordShortcut::start(spec, probe) {
                Ok(_) => ShortcutAvailability {
                    available: true,
                    message: None,
                },
                Err(_) => ShortcutAvailability {
                    available: false,
                    message: Some(chord_failure_message()),
                },
            },
            Err(message) => ShortcutAvailability {
                available: false,
                message: Some(message),
            },
        }
    }

    fn setup(&self, action: &str, _paths: &PlatformPaths) -> Result<(), String> {
        if action == "retry-shortcut" {
            return Ok(());
        }
        if matches!(
            action,
            "allow-screen-recording" | "allow-accessibility" | "test-mac-capture"
        ) {
            return Err("That setup action requires macOS.".to_string());
        }
        Err("That setup action requires a Linux desktop session.".to_string())
    }
}

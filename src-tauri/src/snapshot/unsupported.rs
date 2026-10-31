//! Windows and macOS have no capture backend yet. The state mirrors upstream's
//! unsupported-platform answer instead of pretending a shortcut was registered.

use super::platform::{
    CaptureOptions, CaptureOutput, CaptureSupport, ChangedCallback, PlatformPaths,
    ShortcutAvailability, ShortcutStatus, SnapShotMode, SnapShotPlatform, SnapShotShortcut,
    TriggerCallback,
};

pub struct UnsupportedPlatform;

impl SnapShotPlatform for UnsupportedPlatform {
    fn mode(&self) -> SnapShotMode {
        SnapShotMode::Unavailable
    }

    fn support(&self) -> CaptureSupport {
        CaptureSupport::default()
    }

    fn capture(
        &self,
        _app_id: &str,
        _options: CaptureOptions,
        _paths: &PlatformPaths,
        _temp_dir: &std::path::Path,
    ) -> Result<CaptureOutput, String> {
        Err("SnapShots are not available on this platform yet.".to_string())
    }

    fn configure_shortcut(
        &self,
        _app_id: &str,
        _shortcut: &SnapShotShortcut,
        _on_capture: TriggerCallback,
        _on_changed: ChangedCallback,
    ) -> ShortcutStatus {
        ShortcutStatus::default()
    }

    fn release_shortcut(&self) {}

    fn check_shortcut(&self, _shortcut: &SnapShotShortcut) -> ShortcutAvailability {
        ShortcutAvailability {
            available: false,
            message: Some("SnapShots are not supported on this platform.".to_string()),
        }
    }

    fn setup(&self, _action: &str, _paths: &PlatformPaths) -> Result<(), String> {
        Err("SnapShots are not available on this platform yet.".to_string())
    }
}

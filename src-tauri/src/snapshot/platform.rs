//! The per-OS seam. The core state machine in `mod.rs` never mentions a desktop
//! API: Linux lives in `linux.rs`, Windows in `windows.rs`, and macOS gets
//! `unsupported.rs`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapShotMode {
    #[cfg(target_os = "windows")]
    Direct,
    #[cfg(target_os = "linux")]
    Portal,
    #[cfg(target_os = "linux")]
    Unavailable,
}

impl SnapShotMode {
    pub fn as_str(self) -> &'static str {
        match self {
            #[cfg(target_os = "windows")]
            Self::Direct => "direct",
            #[cfg(target_os = "linux")]
            Self::Portal => "portal",
            #[cfg(target_os = "linux")]
            Self::Unavailable => "unavailable",
        }
    }

    /// The core state machine asks without naming a platform-specific variant.
    pub fn is_portal(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            matches!(self, Self::Portal)
        }
        #[cfg(target_os = "windows")]
        {
            false
        }
    }

    pub fn is_unavailable(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            matches!(self, Self::Unavailable)
        }
        #[cfg(target_os = "windows")]
        {
            false
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyChord {
    pub key: String,
    #[serde(default)]
    pub meta_key: bool,
    #[serde(default)]
    pub ctrl_key: bool,
    #[serde(default)]
    pub shift_key: bool,
    #[serde(default)]
    pub alt_key: bool,
    #[serde(default)]
    pub mod_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ModifierPairShortcut {
    BothShiftKeys,
    ModifierPair { modifier: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SnapShotShortcut {
    Pair(ModifierPairShortcut),
    Chord(KeyChord),
}

impl Default for SnapShotShortcut {
    fn default() -> Self {
        Self::Pair(ModifierPairShortcut::BothShiftKeys)
    }
}

impl SnapShotShortcut {
    pub fn modifier_pair(&self) -> Option<&str> {
        match self {
            Self::Pair(ModifierPairShortcut::BothShiftKeys) => Some("shift"),
            Self::Pair(ModifierPairShortcut::ModifierPair { modifier }) => Some(modifier),
            Self::Chord(_) => None,
        }
    }

    pub fn is_modifier_pair(&self) -> bool {
        self.modifier_pair().is_some()
    }

    /// Portal triggers and Electron accelerators both compare a chord's meaning,
    /// not its field order.
    pub fn accelerator(&self) -> String {
        match self {
            Self::Pair(pair) => match pair {
                ModifierPairShortcut::BothShiftKeys => "Shift+Shift".to_string(),
                ModifierPairShortcut::ModifierPair { modifier } => {
                    format!("{modifier}+{modifier}")
                }
            },
            Self::Chord(chord) => {
                let mut parts: Vec<String> = Vec::new();
                if chord.mod_key {
                    parts.push("CommandOrControl".to_string());
                }
                if chord.meta_key {
                    parts.push("Super".to_string());
                }
                if chord.ctrl_key {
                    parts.push("Control".to_string());
                }
                if chord.alt_key {
                    parts.push("Alt".to_string());
                }
                if chord.shift_key {
                    parts.push("Shift".to_string());
                }
                parts.push(electron_key_name(&chord.key));
                parts.join("+")
            }
        }
    }
}

fn electron_key_name(key: &str) -> String {
    match key {
        " " => "Space".to_string(),
        "+" => "Plus".to_string(),
        "ArrowDown" => "Down".to_string(),
        "ArrowLeft" => "Left".to_string(),
        "ArrowRight" => "Right".to_string(),
        "ArrowUp" => "Up".to_string(),
        "Escape" => "Esc".to_string(),
        other => other.to_uppercase(),
    }
}

pub fn bounded_snapshot_string(value: &str, max_chars: usize) -> Option<String> {
    let candidate = value.replace('\0', "");
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return None;
    }
    Some(candidate.chars().take(max_chars).collect())
}

pub fn same_shortcut(left: &SnapShotShortcut, right: &SnapShotShortcut) -> bool {
    if left.is_modifier_pair() || right.is_modifier_pair() {
        return left.modifier_pair() == right.modifier_pair();
    }
    left.accelerator() == right.accelerator()
}

pub fn system_conflict(shortcut: &SnapShotShortcut) -> Option<String> {
    let SnapShotShortcut::Chord(chord) = shortcut else {
        return None;
    };
    let modifier_count = [
        chord.mod_key,
        chord.meta_key,
        chord.ctrl_key,
        chord.alt_key,
        chord.shift_key,
    ]
    .into_iter()
    .filter(|pressed| *pressed)
    .count();
    if modifier_count != 1 {
        return None;
    }
    if chord.shift_key {
        return Some(
            "Shift combinations are used for typing and text selection. Add another modifier."
                .to_string(),
        );
    }
    let key = chord.key.to_lowercase();
    if chord.mod_key {
        let action = match key.as_str() {
            "a" => Some("Select All"),
            "c" => Some("Copy"),
            "f" => Some("Find"),
            "n" => Some("New"),
            "o" => Some("Open"),
            "p" => Some("Print"),
            "q" => Some("Quit"),
            "s" => Some("Save"),
            "t" => Some("New Tab"),
            "v" => Some("Paste"),
            "w" => Some("Close Window"),
            "x" => Some("Cut"),
            "z" => Some("Undo"),
            _ => None,
        };
        return action.map(|action| format!("This shortcut is {action} in most apps."));
    }
    if chord.ctrl_key && matches!(key.as_str(), "c" | "d" | "z") {
        return Some("This shortcut controls running commands in terminals.".to_string());
    }
    if chord.alt_key && key == "tab" {
        return Some("The system uses Alt+Tab to switch apps.".to_string());
    }
    if chord.meta_key && matches!(key.as_str(), "l" | " ") {
        return Some("The system already uses this shortcut.".to_string());
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigDesktop {
    Niri,
    #[cfg(target_os = "linux")]
    Hyprland,
}

#[derive(Debug, Clone, Default)]
pub struct ShortcutStatus {
    pub registered: bool,
    pub message: Option<String>,
    pub pending: Option<bool>,
    pub can_retry: Option<bool>,
    pub label: Option<String>,
    pub binding: Option<String>,
    pub config_path: Option<String>,
    pub action_registered: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutAvailability {
    pub available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CaptureSupport {
    pub linux_backend: Option<String>,
    pub feedback_available: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureOptions {
    pub flash: bool,
    pub animate: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NormalizedFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMetadata {
    pub title: String,
    pub app_name: String,
    pub app_identifier: String,
    pub process_id: u64,
    pub bounds: Bounds,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_bounds: Option<Bounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility_bounds_reliable: Option<bool>,
}

pub trait CaptureFeedback: Send {
    fn animation_started(&self) -> bool;
    fn animate_to(&mut self, frame: NormalizedFrame) -> Result<(), String>;
    fn complete(&mut self);
    fn close(&mut self);
}

pub struct CaptureOutput {
    pub png: Vec<u8>,
    pub window: Option<WindowMetadata>,
    pub feedback: Option<Box<dyn CaptureFeedback>>,
}

#[derive(Debug, Clone, Default)]
pub struct PlatformPaths {
    /// Desktop config locations only exist for the compositor-managed setups.
    #[cfg(target_os = "linux")]
    pub home: PathBuf,
    pub state_dir: PathBuf,
    #[cfg(target_os = "linux")]
    pub config_home: PathBuf,
    #[cfg(target_os = "linux")]
    pub data_home: PathBuf,
}

pub type TriggerCallback = Arc<dyn Fn() + Send + Sync>;
pub type ChangedCallback = Arc<dyn Fn() + Send + Sync>;

pub trait SnapShotPlatform: Send + Sync {
    fn mode(&self) -> SnapShotMode;
    /// Hands the platform the application handle it needs for native overlays.
    fn attach_app(&self, _app: &tauri::AppHandle) {}
    fn support(&self) -> CaptureSupport;
    fn capture(
        &self,
        app_id: &str,
        options: CaptureOptions,
        paths: &PlatformPaths,
        temp_dir: &Path,
    ) -> Result<CaptureOutput, String>;
    fn configure_shortcut(
        &self,
        app_id: &str,
        shortcut: &SnapShotShortcut,
        on_capture: TriggerCallback,
        on_changed: ChangedCallback,
    ) -> ShortcutStatus;
    fn release_shortcut(&self);
    fn shortcut_status(&self) -> Option<ShortcutStatus> {
        None
    }
    fn state_extras(&self, _paths: &PlatformPaths) -> serde_json::Map<String, Value> {
        serde_json::Map::new()
    }
    fn check_shortcut(&self, shortcut: &SnapShotShortcut) -> ShortcutAvailability;
    fn setup(&self, action: &str, paths: &PlatformPaths) -> Result<(), String>;
    fn config_desktop(&self) -> Option<ConfigDesktop> {
        None
    }
    fn shortcut_config_path(&self, _paths: &PlatformPaths) -> Option<PathBuf> {
        None
    }
    fn preview_config(
        &self,
        _app_id: &str,
        _request: &Value,
        _selected_path: Option<&Path>,
        _paths: &PlatformPaths,
    ) -> Result<Value, String> {
        Err("Config setup is not available on this platform.".to_string())
    }
    fn apply_config(&self, _id: &str) -> Result<Value, String> {
        Err("Config setup is not available on this platform.".to_string())
    }
}

#[cfg(target_os = "linux")]
pub fn new_platform() -> Box<dyn SnapShotPlatform> {
    Box::new(super::linux::LinuxPlatform::new())
}

#[cfg(target_os = "windows")]
pub fn new_platform() -> Box<dyn SnapShotPlatform> {
    Box::new(super::windows::WindowsPlatform::new())
}

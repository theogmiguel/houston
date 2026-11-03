//! The quick composer: a system-wide shortcut and a small always-on-top window that
//! starts a thread without bringing the main window forward.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const WINDOW_LABEL: &str = "quick-composer";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

impl Default for KeyChord {
    fn default() -> Self {
        // Ctrl+Shift+Space matches the documented default and leaves plain typing alone.
        KeyChord {
            key: " ".to_string(),
            meta_key: false,
            ctrl_key: true,
            shift_key: true,
            alt_key: false,
            mod_key: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickComposerSettings {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default = "default_shortcut")]
    pub shortcut: Option<KeyChord>,
}

fn enabled_by_default() -> bool {
    true
}

fn default_shortcut() -> Option<KeyChord> {
    Some(KeyChord::default())
}

impl Default for QuickComposerSettings {
    fn default() -> Self {
        QuickComposerSettings {
            enabled: true,
            shortcut: Some(KeyChord::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickComposerStatus {
    pub enabled: bool,
    pub shortcut: Option<KeyChord>,
    pub registered: bool,
    pub reason: Option<String>,
}

pub struct QuickComposerHost {
    state_dir: PathBuf,
    settings: Mutex<QuickComposerSettings>,
    status: Mutex<QuickComposerStatus>,
}

impl QuickComposerHost {
    pub fn new(state_dir: PathBuf) -> Arc<Self> {
        let settings = load_settings(&state_dir);
        let status = QuickComposerStatus {
            enabled: settings.enabled,
            shortcut: settings.shortcut.clone(),
            registered: false,
            reason: None,
        };
        Arc::new(QuickComposerHost {
            state_dir,
            settings: Mutex::new(settings),
            status: Mutex::new(status),
        })
    }

    fn view(&self) -> QuickComposerStatus {
        self.status.lock().expect("quick composer status").clone()
    }
}

fn settings_path(state_dir: &Path) -> PathBuf {
    state_dir.join("quick-composer.json")
}

pub fn load_settings(state_dir: &Path) -> QuickComposerSettings {
    let file = settings_path(state_dir);
    let body = match fs::read_to_string(&file) {
        Ok(body) => body,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return QuickComposerSettings::default()
        }
        Err(err) => {
            eprintln!(
                "houston-tauri: {} unreadable ({err}), keeping the default quick composer shortcut",
                file.display()
            );
            return QuickComposerSettings::default();
        }
    };
    match serde_json::from_str::<QuickComposerSettings>(&body) {
        Ok(settings) => settings,
        Err(err) => {
            eprintln!(
                "houston-tauri: {} is corrupt ({err}), keeping the default quick composer shortcut",
                file.display()
            );
            QuickComposerSettings::default()
        }
    }
}

pub fn save_settings(state_dir: &Path, settings: &QuickComposerSettings) -> io::Result<()> {
    let dest = settings_path(state_dir);
    let tmp = state_dir.join("quick-composer.json.tmp");
    let body = serde_json::to_string_pretty(settings)
        .expect("quick composer settings are plain data; serialization cannot fail");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &dest)
}

fn chord_label(chord: &KeyChord) -> String {
    let mut parts: Vec<String> = Vec::new();
    if chord.ctrl_key || chord.mod_key {
        parts.push("Ctrl".to_string());
    }
    if chord.alt_key {
        parts.push("Alt".to_string());
    }
    if chord.shift_key {
        parts.push("Shift".to_string());
    }
    if chord.meta_key {
        parts.push("Super".to_string());
    }
    parts.push(if chord.key == " " {
        "Space".to_string()
    } else {
        chord.key.clone()
    });
    parts.join("+")
}

fn key_token(key: &str) -> Result<String, String> {
    if key == " " {
        return Ok("Space".to_string());
    }
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(
            "A global shortcut needs a key. Use a letter, digit, function key or Space."
                .to_string(),
        );
    }
    if trimmed.eq_ignore_ascii_case("space") {
        return Ok("Space".to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper.len() == 1 {
        let character = upper.chars().next().expect("one character");
        if character.is_ascii_alphabetic() {
            return Ok(format!("Key{character}"));
        }
        if character.is_ascii_digit() {
            return Ok(format!("Digit{character}"));
        }
    }
    if let Some(number) = upper.strip_prefix('F') {
        if let Ok(value) = number.parse::<u8>() {
            if (1..=24).contains(&value) {
                return Ok(upper);
            }
        }
    }
    let named = match upper.as_str() {
        "TAB" => "Tab",
        "ENTER" | "RETURN" => "Enter",
        "ESC" | "ESCAPE" => "Escape",
        "BACKSPACE" => "Backspace",
        "DELETE" | "DEL" => "Delete",
        "INSERT" | "INS" => "Insert",
        "HOME" => "Home",
        "END" => "End",
        "PAGEUP" => "PageUp",
        "PAGEDOWN" => "PageDown",
        "ARROWLEFT" | "LEFT" => "ArrowLeft",
        "ARROWRIGHT" | "RIGHT" => "ArrowRight",
        "ARROWUP" | "UP" => "ArrowUp",
        "ARROWDOWN" | "DOWN" => "ArrowDown",
        "`" | "BACKQUOTE" => "Backquote",
        "\\" | "BACKSLASH" => "Backslash",
        "[" | "BRACKETLEFT" => "BracketLeft",
        "]" | "BRACKETRIGHT" => "BracketRight",
        "," | "COMMA" => "Comma",
        "-" | "MINUS" => "Minus",
        "=" | "EQUAL" => "Equal",
        "." | "PERIOD" => "Period",
        "'" | "QUOTE" => "Quote",
        ";" | "SEMICOLON" => "Semicolon",
        "/" | "SLASH" => "Slash",
        _ => {
            return Err(format!(
                "Houston cannot use {trimmed:?} as a global shortcut key. Use a letter, digit, function key, arrow or Space."
            ))
        }
    };
    Ok(named.to_string())
}

/// The accelerator string the global-shortcut plugin parses. A chord with no modifier is
/// refused: it would take that key from every application.
pub fn accelerator(chord: &KeyChord) -> Result<String, String> {
    let key = key_token(&chord.key)?;
    let mut parts: Vec<String> = Vec::new();
    if chord.ctrl_key || chord.mod_key {
        parts.push("Control".to_string());
    }
    if chord.alt_key {
        parts.push("Alt".to_string());
    }
    if chord.shift_key {
        parts.push("Shift".to_string());
    }
    if chord.meta_key {
        parts.push("Meta".to_string());
    }
    if parts.is_empty() {
        return Err(format!(
            "{} has no modifier. Add Ctrl, Alt, Shift or Super so the shortcut does not take a plain key from every app.",
            chord_label(chord)
        ));
    }
    parts.push(key);
    Ok(parts.join("+"))
}

fn session_is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
}

pub fn registration_failure_reason(chord: &KeyChord, error: &str, wayland: bool) -> String {
    let label = chord_label(chord);
    if wayland {
        format!(
            "Wayland does not let apps register global shortcuts, so {label} is unavailable. Use the tray's New thread item instead. ({error})"
        )
    } else {
        format!("{label} could not be registered: {error}. Another app may already use it; choose another shortcut in Settings > Keybindings.")
    }
}

fn apply(app: &AppHandle, host: &Arc<QuickComposerHost>, settings: &QuickComposerSettings) {
    let _ = app.global_shortcut().unregister_all();
    let mut status = QuickComposerStatus {
        enabled: settings.enabled,
        shortcut: settings.shortcut.clone(),
        registered: false,
        reason: None,
    };
    if settings.enabled {
        match settings.shortcut.as_ref() {
            None => {
                status.reason = Some(
                    "No shortcut is configured. Choose one in Settings > Keybindings.".to_string(),
                );
            }
            // global-hotkey registers through XGrabKey, which a Wayland session has no X
            // server to answer: asking it there would report a shortcut that never fires.
            Some(chord) if session_is_wayland() => {
                status.reason = Some(registration_failure_reason(
                    chord,
                    "a Wayland session has no X server for global hotkeys",
                    true,
                ));
            }
            Some(chord) => match accelerator(chord) {
                Ok(accelerator) => {
                    let registered =
                        app.global_shortcut()
                            .on_shortcut(accelerator.as_str(), |app, _, event| {
                                if event.state == ShortcutState::Pressed {
                                    toggle_from_shortcut(app);
                                }
                            });
                    match registered {
                        Ok(()) => status.registered = true,
                        Err(err) => {
                            status.reason = Some(registration_failure_reason(
                                chord,
                                &err.to_string(),
                                session_is_wayland(),
                            ));
                        }
                    }
                }
                Err(err) => status.reason = Some(err),
            },
        }
    }
    *host.status.lock().expect("quick composer status") = status;
}

pub fn register_saved(app: &AppHandle, host: &Arc<QuickComposerHost>) {
    let settings = host
        .settings
        .lock()
        .expect("quick composer settings")
        .clone();
    apply(app, host, &settings);
}

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

pub fn open(app: &AppHandle) {
    if let Some(window) = window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let host = app.state::<Arc<QuickComposerHost>>().inner().clone();
    let script = crate::v2_initialization_script(app);
    let built = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html#/quick-composer".into()),
    )
    .title("New thread")
    .inner_size(560.0, 380.0)
    .min_inner_size(420.0, 260.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(true)
    .center()
    .data_directory(crate::webview_data_dir_for(&host.state_dir))
    .initialization_script(&script)
    .build();
    match built {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!(
            "houston-tauri: could not open the quick composer window: {err}. Try the tray's New thread item again."
        ),
    }
}

fn toggle_from_shortcut(app: &AppHandle) {
    match window(app) {
        Some(window) => {
            let _ = window.close();
        }
        None => open(app),
    }
}

#[tauri::command]
pub fn quick_composer_status(
    host: tauri::State<'_, Arc<QuickComposerHost>>,
) -> QuickComposerStatus {
    host.view()
}

#[tauri::command]
pub fn quick_composer_set_shortcut(
    app: AppHandle,
    host: tauri::State<'_, Arc<QuickComposerHost>>,
    shortcut: Option<KeyChord>,
) -> Result<QuickComposerStatus, String> {
    let host = host.inner().clone();
    let next = {
        let current = host.settings.lock().expect("quick composer settings");
        QuickComposerSettings {
            enabled: shortcut.is_some(),
            shortcut: shortcut.or_else(|| current.shortcut.clone()),
        }
    };
    save_settings(&host.state_dir, &next).map_err(|err| {
        format!(
            "Could not save the quick composer shortcut to {}: {err}. It applies until Houston restarts.",
            settings_path(&host.state_dir).display()
        )
    })?;
    *host.settings.lock().expect("quick composer settings") = next.clone();
    apply(&app, &host, &next);
    Ok(host.view())
}

#[tauri::command]
pub fn quick_composer_open(app: AppHandle) {
    open(&app);
}

#[tauri::command]
pub fn quick_composer_close(app: AppHandle) {
    if let Some(window) = window(&app) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_channel_has_ctrl_shift_space() {
        let settings = QuickComposerSettings::default();
        assert!(settings.enabled);
        assert_eq!(
            accelerator(settings.shortcut.as_ref().unwrap()).unwrap(),
            "Control+Shift+Space"
        );
    }

    #[test]
    fn a_saved_choice_survives_a_reload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = QuickComposerSettings {
            enabled: false,
            shortcut: Some(KeyChord {
                key: "k".to_string(),
                ..KeyChord::default()
            }),
        };
        save_settings(dir.path(), &settings).expect("save");
        assert_eq!(load_settings(dir.path()), settings);
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(settings_path(dir.path()), "{ not json").expect("write");
        assert_eq!(load_settings(dir.path()), QuickComposerSettings::default());
    }

    #[test]
    fn accelerator_names_every_modifier_and_key_shape() {
        let chord = |key: &str| KeyChord {
            key: key.to_string(),
            ctrl_key: true,
            shift_key: true,
            meta_key: true,
            alt_key: true,
            mod_key: false,
        };
        assert_eq!(
            accelerator(&chord("a")).unwrap(),
            "Control+Alt+Shift+Meta+KeyA"
        );
        assert_eq!(
            accelerator(&chord("7")).unwrap(),
            "Control+Alt+Shift+Meta+Digit7"
        );
        assert_eq!(
            accelerator(&chord("f12")).unwrap(),
            "Control+Alt+Shift+Meta+F12"
        );
        assert_eq!(
            accelerator(&chord(" ")).unwrap(),
            "Control+Alt+Shift+Meta+Space"
        );
        assert_eq!(
            accelerator(&chord("escape")).unwrap(),
            "Control+Alt+Shift+Meta+Escape"
        );
    }

    #[test]
    fn a_mod_key_is_control_on_the_supported_platforms() {
        let chord = KeyChord {
            key: "j".to_string(),
            mod_key: true,
            ctrl_key: false,
            shift_key: false,
            ..KeyChord::default()
        };
        assert_eq!(accelerator(&chord).unwrap(), "Control+KeyJ");
    }

    #[test]
    fn a_chord_without_a_modifier_is_refused_and_names_it() {
        let error = accelerator(&KeyChord {
            key: "j".to_string(),
            ctrl_key: false,
            shift_key: false,
            ..KeyChord::default()
        })
        .unwrap_err();
        assert!(error.contains("j"), "{error}");
        assert!(error.contains("no modifier"), "{error}");
    }

    #[test]
    fn an_unknown_key_is_refused_and_names_it() {
        let error = accelerator(&KeyChord {
            key: "hyperdrive".to_string(),
            ctrl_key: true,
            ..KeyChord::default()
        })
        .unwrap_err();
        assert!(error.contains("hyperdrive"), "{error}");
    }

    #[test]
    fn a_wayland_failure_names_wayland_and_the_chord() {
        let reason = registration_failure_reason(&KeyChord::default(), "not supported", true);
        assert!(reason.contains("Wayland"), "{reason}");
        assert!(reason.contains("Ctrl+Shift+Space"), "{reason}");
    }

    #[test]
    fn an_occupied_chord_points_at_settings() {
        let reason =
            registration_failure_reason(&KeyChord::default(), "hot key already registered", false);
        assert!(reason.contains("Ctrl+Shift+Space"), "{reason}");
        assert!(reason.contains("Settings > Keybindings"), "{reason}");
    }

    #[test]
    fn the_bridge_exposes_the_quick_composer_commands() {
        let bridge = include_str!("v2_bridge.js");
        for method in [
            "getQuickComposerStatus",
            "setQuickComposerShortcut",
            "openQuickComposer",
            "closeQuickComposer",
        ] {
            assert!(
                bridge.contains(&format!("{method}: function")),
                "v2_bridge.js is missing {method}"
            );
        }
        for command in [
            "quick_composer_status",
            "quick_composer_set_shortcut",
            "quick_composer_open",
            "quick_composer_close",
        ] {
            assert!(
                bridge.contains(&format!("\"{command}\"")),
                "v2_bridge.js is missing the {command} invoke"
            );
        }
    }
}

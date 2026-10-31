//! Desktop detection, portal shortcut triggers and the portal-owned PNG boundary.
//! Mirrors upstream `linuxCaptureSession.ts`.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};

use super::platform::KeyChord;

pub const HYPRLAND_CAPTURE_ACTION: &str = "capture-window";
pub const NIRI_CAPTURE_PATH: &str = "/com/t3tools/SnapShot";
pub const NIRI_CAPTURE_INTERFACE: &str = "com.t3tools.SnapShot";

const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
const PNG_HEADER: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

pub fn sandboxed() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || std::env::var_os("SNAP").is_some()
}

fn is_desktop_session(desktop: &str) -> bool {
    if sandboxed() {
        return false;
    }
    std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .is_some_and(|value| {
            value
                .split(':')
                .any(|name| name.eq_ignore_ascii_case(desktop))
        })
}

pub fn is_gnome_capture_session() -> bool {
    is_desktop_session("gnome")
}

pub fn is_kde_capture_session() -> bool {
    is_desktop_session("kde")
}

pub fn is_hyprland_capture_session() -> bool {
    is_desktop_session("hyprland")
}

pub fn niri_capture_binding(app_id: &str) -> String {
    format!(
        "Ctrl+Shift+2 repeat=false {{ spawn \"gdbus\" \"call\" \"--session\" \"--dest\" \"{app_id}.SnapShot\" \"--object-path\" \"{NIRI_CAPTURE_PATH}\" \"--method\" \"{NIRI_CAPTURE_INTERFACE}.Capture\"; }}"
    )
}

fn key_name(key: &str) -> Option<&'static str> {
    Some(match key {
        " " => "space",
        "escape" | "esc" => "Escape",
        "enter" => "Return",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "+" => "plus",
        "-" => "minus",
        "=" => "equal",
        "," => "comma",
        "." => "period",
        "/" => "slash",
        ";" => "semicolon",
        "'" => "apostrophe",
        "[" => "bracketleft",
        "]" => "bracketright",
        "\\" => "backslash",
        "`" => "grave",
        "!" => "exclam",
        "@" => "at",
        "#" => "numbersign",
        "$" => "dollar",
        "%" => "percent",
        "^" => "asciicircum",
        "&" => "ampersand",
        "*" => "asterisk",
        "(" => "parenleft",
        ")" => "parenright",
        "_" => "underscore",
        ":" => "colon",
        "\"" => "quotedbl",
        "{" => "braceleft",
        "}" => "braceright",
        "|" => "bar",
        "<" => "less",
        ">" => "greater",
        "?" => "question",
        "~" => "asciitilde",
        _ => return None,
    })
}

pub fn portal_shortcut_trigger(shortcut: &KeyChord) -> Result<String, String> {
    let key = shortcut.key.to_lowercase();
    let keysym = match key_name(&key) {
        Some(name) => name.to_string(),
        None => {
            let function_key = key
                .strip_prefix('f')
                .and_then(|digits| digits.parse::<u8>().ok())
                .is_some_and(|number| (1..=24).contains(&number));
            if key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric()) || function_key {
                key.to_uppercase()
            } else {
                return Err(
                    "This key isn't supported as a Wayland capture shortcut. Choose another key."
                        .to_string(),
                );
            }
        }
    };
    Ok([
        (shortcut.ctrl_key || shortcut.mod_key).then_some("CTRL"),
        shortcut.alt_key.then_some("ALT"),
        shortcut.shift_key.then_some("SHIFT"),
        shortcut.meta_key.then_some("LOGO"),
        Some(keysym.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("+"))
}

pub fn read_portal_png(uri: &str) -> Result<Vec<u8>, String> {
    let path = file_uri_to_path(uri)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("reading portal screenshot {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "portal screenshot {} is not a regular file",
            path.display()
        ));
    }
    if metadata.len() > MAX_PNG_BYTES as u64 {
        return Err(format!(
            "portal screenshot is {} bytes; the limit is {MAX_PNG_BYTES}",
            metadata.len()
        ));
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("reading portal screenshot {}: {error}", path.display()))?;
    validate_png(&bytes)?;
    Ok(bytes)
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf, String> {
    let rest = uri
        .strip_prefix("file://")
        .ok_or_else(|| format!("portal returned a non-local screenshot URI {uri:?}"))?;
    if !rest.starts_with('/') {
        return Err(format!(
            "portal returned a screenshot URI with a remote host: {uri:?}"
        ));
    }
    Ok(PathBuf::from(percent_decode(rest)?))
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3).ok_or_else(|| {
                format!("portal screenshot URI has a truncated escape: {value:?}")
            })?;
            let hex = std::str::from_utf8(hex)
                .map_err(|_| format!("portal screenshot URI has an invalid escape: {value:?}"))?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| format!("portal screenshot URI has an invalid escape: {value:?}"))?;
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| format!("portal screenshot URI is not UTF-8: {value:?}"))
}

pub fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(format!(
            "window screenshot is {} bytes; the limit is {MAX_PNG_BYTES}",
            bytes.len()
        ));
    }
    if !bytes.starts_with(&PNG_HEADER) {
        return Err("Invalid or oversized window screenshot.".to_string());
    }
    Ok(())
}

pub fn is_wayland_session_from(
    platform: &str,
    environment: &dyn Fn(&str) -> Option<String>,
) -> bool {
    if platform != "linux" {
        return false;
    }
    let session_type = environment("XDG_SESSION_TYPE").map(|value| value.to_lowercase());
    if session_type.as_deref() == Some("wayland")
        || environment("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    if session_type.as_deref() == Some("x11") {
        return false;
    }
    let Some(runtime) = environment("XDG_RUNTIME_DIR") else {
        return false;
    };
    let runtime = Path::new(&runtime);
    let live_sockets: HashSet<String> = fs::read_to_string("/proc/net/unix")
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_whitespace().last().map(str::to_string))
        .collect();
    fs::read_dir(runtime)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("wayland-")
                    || !name[8..].chars().all(|c| c.is_ascii_digit())
                    || name.len() == 8
                {
                    return false;
                }
                let Ok(file_type) = entry.file_type() else {
                    return false;
                };
                file_type.is_socket()
                    && live_sockets.contains(&entry.path().to_string_lossy().into_owned())
            })
        })
        .unwrap_or(false)
}

pub fn is_wayland_session() -> bool {
    is_wayland_session_from("linux", &|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_trigger_uses_wayland_key_names() {
        let chord = |key: &str| KeyChord {
            key: key.to_string(),
            ctrl_key: true,
            shift_key: true,
            ..Default::default()
        };
        assert_eq!(
            portal_shortcut_trigger(&chord("2")).unwrap(),
            "CTRL+SHIFT+2"
        );
        assert_eq!(
            portal_shortcut_trigger(&chord(" ")).unwrap(),
            "CTRL+SHIFT+space"
        );
        assert_eq!(
            portal_shortcut_trigger(&chord("ArrowUp")).unwrap(),
            "CTRL+SHIFT+Up"
        );
        assert_eq!(
            portal_shortcut_trigger(&chord("f12")).unwrap(),
            "CTRL+SHIFT+F12"
        );
        assert!(portal_shortcut_trigger(&chord("F25")).is_err());
    }

    #[test]
    fn portal_trigger_accepts_super_and_mod() {
        let chord = KeyChord {
            key: "y".to_string(),
            meta_key: true,
            mod_key: true,
            alt_key: true,
            ..Default::default()
        };
        assert_eq!(portal_shortcut_trigger(&chord).unwrap(), "CTRL+ALT+LOGO+Y");
    }

    #[test]
    fn file_uri_must_be_local() {
        assert!(file_uri_to_path("https://example.com/a.png").is_err());
        assert!(file_uri_to_path("file://remote/a.png").is_err());
        assert_eq!(
            file_uri_to_path("file:///tmp/a.png").unwrap(),
            PathBuf::from("/tmp/a.png")
        );
    }

    #[test]
    fn png_header_is_required() {
        assert!(validate_png(&PNG_HEADER).is_ok());
        assert!(validate_png(b"not a png").is_err());
    }

    #[test]
    fn session_detection_prefers_explicit_variables() {
        let wayland = |name: &str| (name == "XDG_SESSION_TYPE").then(|| "wayland".to_string());
        assert!(is_wayland_session_from("linux", &wayland));
        assert!(!is_wayland_session_from("darwin", &wayland));
        let x11 = |name: &str| (name == "XDG_SESSION_TYPE").then(|| "x11".to_string());
        assert!(!is_wayland_session_from("linux", &x11));
        let display = |name: &str| (name == "WAYLAND_DISPLAY").then(|| "wayland-0".to_string());
        assert!(is_wayland_session_from("linux", &display));
        let empty = |_: &str| None;
        assert!(!is_wayland_session_from("linux", &empty));
    }
}

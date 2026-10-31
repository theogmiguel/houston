//! Niri's local Unix-socket API. Mirrors upstream `NiriSnapShot.ts` without the
//! Electron feedback overlay: capture, focused-window identity and size checks.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::platform::{Bounds, CaptureOutput, WindowMetadata};

const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

pub fn niri_socket_path_from(environment: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if environment("FLATPAK_ID").is_some() || environment("SNAP").is_some() {
        return None;
    }
    let desktop = environment("XDG_CURRENT_DESKTOP")?;
    if !desktop
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("niri"))
    {
        return None;
    }
    let socket = environment("NIRI_SOCKET")?;
    let path = PathBuf::from(socket);
    path.is_absolute().then_some(path)
}

pub fn niri_socket_path() -> Option<PathBuf> {
    niri_socket_path_from(&|name| std::env::var(name).ok())
}

fn request(path: &Path, message: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(path)
        .map_err(|error| format!("connecting to Niri at {}: {error}", path.display()))?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|error| format!("Niri read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|error| format!("Niri write timeout: {error}"))?;
    stream
        .write_all(format!("{message}\n").as_bytes())
        .map_err(|error| format!("writing to Niri: {error}"))?;
    let mut reader = BufReader::new(stream);
    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader
            .read_line(&mut buffer)
            .map_err(|error| format!("reading from Niri: {error}"))?;
        if read == 0 {
            return Err("Niri disconnected.".to_string());
        }
        if buffer.len() > MAX_MESSAGE_BYTES {
            return Err("Niri returned an oversized message.".to_string());
        }
        let value: Value = serde_json::from_str(buffer.trim())
            .map_err(|error| format!("Niri returned an invalid message: {error}"))?;
        if let Some(error) = value.get("Err").and_then(Value::as_str) {
            return Err(format!("Niri: {error}"));
        }
        if let Some(ok) = value.get("Ok") {
            return Ok(ok.clone());
        }
    }
}

pub fn niri_version_supported(version: &str) -> bool {
    let Some((major, minor)) = version
        .trim_start_matches("niri ")
        .split_once('.')
        .and_then(|(major, rest)| {
            let minor = rest.split('.').next().unwrap_or(rest);
            Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?))
        })
    else {
        return false;
    };
    major > 25 || (major == 25 && minor >= 11)
}

pub fn check_capture_support(path: &Path) -> Result<(), String> {
    let version = request(path, json!("Version"))?
        .get("Version")
        .and_then(Value::as_str)
        .ok_or_else(|| "Niri returned no version.".to_string())?
        .to_string();
    if !niri_version_supported(&version) {
        return Err("SnapShots require Niri 25.11 or newer.".to_string());
    }
    Ok(())
}

fn window_from(value: &Value) -> Option<WindowMetadata> {
    let title = value.get("title")?.as_str()?.to_string();
    let app_id = value
        .get("app_id")
        .and_then(Value::as_str)
        .unwrap_or("Application")
        .to_string();
    let process_id = value.get("pid").and_then(Value::as_u64).unwrap_or(0);
    let size = value.get("layout")?.get("window_size")?.as_array()?;
    let width = size.first()?.as_u64()? as i64;
    let height = size.get(1)?.as_u64()? as i64;
    Some(WindowMetadata {
        title,
        app_name: app_id.clone(),
        app_identifier: app_id,
        process_id,
        bounds: Bounds {
            x: 0,
            y: 0,
            width,
            height,
        },
        client_bounds: None,
        accessibility_bounds_reliable: Some(false),
    })
}

pub fn capture_window(path: &Path, directory: &Path) -> Result<CaptureOutput, String> {
    check_capture_support(path)?;
    let focused = request(path, json!("FocusedWindow"))?
        .get("FocusedWindow")
        .cloned()
        .ok_or_else(|| "Niri has no focused window to capture.".to_string())?;
    let id = focused
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Niri returned a window without an id.".to_string())?;
    let image_path = directory.join("capture.png");
    request(
        path,
        json!({
            "Action": {
                "ScreenshotWindow": {
                    "id": id,
                    "write_to_disk": true,
                    "show_pointer": false,
                    "path": image_path.to_string_lossy(),
                }
            }
        }),
    )?;
    let deadline = Instant::now() + TIMEOUT;
    while !image_path.exists() {
        if Instant::now() >= deadline {
            return Err("Niri did not write the window screenshot.".to_string());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let png =
        super::linux_capture_session::read_portal_png(&format!("file://{}", image_path.display()))?;
    let after = request(path, json!("Windows"))?
        .get("Windows")
        .and_then(Value::as_array)
        .and_then(|windows| {
            windows
                .iter()
                .find(|window| window.get("id").and_then(Value::as_u64) == Some(id))
                .cloned()
        });
    let window = after.as_ref().and_then(|after| {
        let unchanged = after.get("pid") == focused.get("pid")
            && after.get("title") == focused.get("title")
            && after.get("app_id") == focused.get("app_id")
            && after.get("layout") == focused.get("layout");
        unchanged.then(|| window_from(after)).flatten()
    });
    Ok(CaptureOutput {
        png,
        window,
        feedback: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn requires_an_unsandboxed_niri_session_and_an_absolute_socket() {
        let niri = environment(&[
            ("XDG_CURRENT_DESKTOP", "niri"),
            ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
        ]);
        assert_eq!(
            niri_socket_path_from(&niri),
            Some(PathBuf::from("/run/user/1000/niri.sock"))
        );
        let relative = environment(&[
            ("XDG_CURRENT_DESKTOP", "niri"),
            ("NIRI_SOCKET", "niri.sock"),
        ]);
        assert_eq!(niri_socket_path_from(&relative), None);
        let sandboxed = environment(&[
            ("XDG_CURRENT_DESKTOP", "niri"),
            ("NIRI_SOCKET", "/run/niri.sock"),
            ("FLATPAK_ID", "com.example.App"),
        ]);
        assert_eq!(niri_socket_path_from(&sandboxed), None);
        let gnome = environment(&[
            ("XDG_CURRENT_DESKTOP", "GNOME"),
            ("NIRI_SOCKET", "/run/niri.sock"),
        ]);
        assert_eq!(niri_socket_path_from(&gnome), None);
    }

    #[test]
    fn rejects_versions_before_caller_selected_screenshot_paths() {
        assert!(niri_version_supported("25.11"));
        assert!(niri_version_supported("niri 26.0"));
        assert!(!niri_version_supported("25.10"));
        assert!(!niri_version_supported("24.8"));
        assert!(!niri_version_supported("unknown"));
    }
}

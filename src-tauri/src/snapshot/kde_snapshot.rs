//! KDE's installed capture helper. Mirrors upstream `KdeSnapShot.ts`. Houston
//! does not bundle `t3-kde-snap-shot`, so setup reports the missing bundle and
//! capture asks for setup instead of pretending to work.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::linux_capture_session::read_portal_png;
use super::native_capture_feedback::NativeCaptureFeedback;
use super::platform::{Bounds, CaptureFeedback, CaptureOptions, CaptureOutput, WindowMetadata};

pub const KDE_CAPTURE_EXECUTABLE: &str = "t3-kde-snap-shot";
const DESKTOP_FILE: &str = "com.t3tools.T3Code.KdeCapture.desktop";
const MARKER: &str = "X-T3Code-Capture-Helper=true";
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHelperState {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback_available: Option<bool>,
}

fn state(status: &str, message: &str, feedback: Option<bool>) -> CaptureHelperState {
    CaptureHelperState {
        status: status.to_string(),
        message: message.to_string(),
        feedback_available: feedback,
    }
}

#[derive(Debug, Clone)]
pub struct KdeCapturePaths {
    pub bundle: PathBuf,
    pub data_home: PathBuf,
}

fn installed(paths: &KdeCapturePaths) -> (PathBuf, PathBuf) {
    (
        paths
            .data_home
            .join("t3code")
            .join("kde-capture")
            .join(KDE_CAPTURE_EXECUTABLE),
        paths.data_home.join("applications").join(DESKTOP_FILE),
    )
}

fn escape_desktop_entry_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn escape_exec_argument(value: &str) -> String {
    let quoted = value
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('"', "\\\"")
        .replace('%', "%%");
    escape_desktop_entry_string(&format!("\"{quoted}\""))
}

fn desktop_entry(executable: &Path) -> String {
    [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Houston SnapShots",
        "NoDisplay=true",
        &format!(
            "Exec={} check",
            escape_exec_argument(&executable.to_string_lossy())
        ),
        "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
        MARKER,
        "",
    ]
    .join("\n")
}

fn run(executable: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = crate::sys::spawn::command(executable);
    command.args(args);
    let output = crate::sys::spawn::output_within(command, RUN_TIMEOUT)
        .map_err(|error| format!("running {}: {error}", executable.display()))?
        .ok_or_else(|| format!("{} timed out", executable.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("NoAuthorized") {
        return Err(
            "KDE hasn't granted capture access. Reinstall the capture helper in setup, then try again."
                .to_string(),
        );
    }
    Err(if stderr.trim().is_empty() {
        "The KDE capture helper did not respond. Reopen capture setup and check access.".to_string()
    } else {
        stderr.trim().to_string()
    })
}

fn regular_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("checking {}: {error}", path.display())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "Capture helper files must be regular files: {} is not",
            path.display()
        ));
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("reading {}: {error}", path.display()))
}

pub struct KdeCaptureSetup {
    paths: KdeCapturePaths,
}

impl KdeCaptureSetup {
    pub fn new(paths: KdeCapturePaths) -> Self {
        Self { paths }
    }

    pub fn state(&self) -> CaptureHelperState {
        match self.check() {
            Ok(state) => state,
            Err(error) => state("error", &error, None),
        }
    }

    fn check(&self) -> Result<CaptureHelperState, String> {
        let (executable, desktop) = installed(&self.paths);
        let installed_bytes = regular_file(&executable)?;
        let entry = regular_file(&desktop)?;
        let (Some(_), Some(entry)) = (installed_bytes.as_ref(), entry.as_ref()) else {
            return Ok(state(
                "not-installed",
                "Install the bundled helper to capture the window you're using without a picker.",
                None,
            ));
        };
        let Some(bundle) = regular_file(&self.paths.bundle)? else {
            return Ok(state(
                "error",
                "The capture helper is missing from this build. Update or reinstall Houston.",
                None,
            ));
        };
        if installed_bytes.as_deref() != Some(bundle.as_slice())
            || entry.as_slice() != desktop_entry(&executable).as_bytes()
        {
            return Ok(state(
                "update-required",
                "Update the bundled capture helper to continue.",
                None,
            ));
        }
        let capabilities = run(&executable, &["check"])?;
        let capabilities: Value = serde_json::from_str(&capabilities)
            .map_err(|error| format!("the KDE capture helper returned invalid JSON: {error}"))?;
        Ok(state(
            "ready",
            "KDE capture access is ready. Next, choose your shortcut.",
            capabilities
                .get("feedbackAvailable")
                .and_then(Value::as_bool)
                .or(Some(false)),
        ))
    }

    pub fn perform(&self, action: &str) -> Result<(), String> {
        let (executable, desktop) = installed(&self.paths);
        let entry = regular_file(&desktop)?;
        if let Some(entry) = entry.as_ref() {
            if !String::from_utf8_lossy(entry)
                .lines()
                .any(|line| line == MARKER)
            {
                return Err(
                    "Another desktop entry uses the capture helper's name. Rename it before continuing."
                        .to_string(),
                );
            }
        }
        let directory = executable
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", executable.display()))?;
        if let Ok(metadata) = fs::symlink_metadata(directory) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("The capture helper directory is not a regular directory.".to_string());
            }
        }
        let _ = regular_file(&executable)?;
        if action == "remove-kde-helper" {
            if entry.is_some() {
                fs::remove_file(&desktop)
                    .map_err(|error| format!("removing {}: {error}", desktop.display()))?;
            }
            let _ = fs::remove_file(&executable);
        } else if action == "install-kde-helper" {
            let bundle = regular_file(&self.paths.bundle)?.ok_or_else(|| {
                "The capture helper is missing from this build. Update or reinstall Houston."
                    .to_string()
            })?;
            fs::create_dir_all(directory)
                .map_err(|error| format!("creating {}: {error}", directory.display()))?;
            fs::create_dir_all(desktop.parent().unwrap_or(directory))
                .map_err(|error| format!("creating the applications directory: {error}"))?;
            fs::write(&executable, &bundle)
                .map_err(|error| format!("writing {}: {error}", executable.display()))?;
            let mut file = fs::File::create(&desktop)
                .map_err(|error| format!("writing {}: {error}", desktop.display()))?;
            file.write_all(desktop_entry(&executable).as_bytes())
                .map_err(|error| format!("writing {}: {error}", desktop.display()))?;
        } else {
            return Err(format!(
                "unknown KDE capture setup action {action:?}; expected install-kde-helper or remove-kde-helper"
            ));
        }
        let _ = run(Path::new("kbuildsycoca6"), &["--noincremental"]);
        Ok(())
    }
}

fn decode_window(value: &Value) -> Option<WindowMetadata> {
    let window = value.get("window")?;
    if window.is_null() {
        return None;
    }
    let bounds = window.get("bounds")?;
    Some(WindowMetadata {
        title: window.get("title")?.as_str()?.to_string(),
        app_name: window.get("appName")?.as_str()?.to_string(),
        app_identifier: window.get("appIdentifier")?.as_str()?.to_string(),
        process_id: window.get("processId")?.as_u64()?,
        bounds: Bounds {
            x: bounds.get("x")?.as_i64()?,
            y: bounds.get("y")?.as_i64()?,
            width: bounds.get("width")?.as_i64()?,
            height: bounds.get("height")?.as_i64()?,
        },
        client_bounds: window.get("clientBounds").and_then(|bounds| {
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

pub fn capture(
    paths: &KdeCapturePaths,
    options: CaptureOptions,
    temp_dir: &Path,
) -> Result<CaptureOutput, String> {
    let setup = KdeCaptureSetup::new(paths.clone());
    let helper = setup.state();
    if helper.status != "ready" {
        return Err(format!(
            "{} Open Settings → SnapShots to continue setup.",
            helper.message
        ));
    }
    let (executable, _) = installed(paths);
    fs::create_dir_all(temp_dir)
        .map_err(|error| format!("creating {}: {error}", temp_dir.display()))?;
    let directory = temp_dir.join(format!("kde-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("creating {}: {error}", directory.display()))?;
    let cleanup = |directory: &Path| {
        let _ = fs::remove_dir_all(directory);
    };
    let result = (|| {
        let output = run(&executable, &["capture", &directory.to_string_lossy()])?;
        let result: Value = serde_json::from_str(&output)
            .map_err(|error| format!("the KDE capture helper returned invalid JSON: {error}"))?;
        let png = read_portal_png(&format!(
            "file://{}",
            directory.join("capture.png").display()
        ))?;
        let window = decode_window(&result);
        let feedback = if helper.feedback_available.unwrap_or(false)
            && window.is_some()
            && (options.flash || options.animate)
        {
            window.as_ref().and_then(|window| {
                NativeCaptureFeedback::start(
                    &executable,
                    &directory,
                    window.bounds,
                    std::process::id(),
                    options.flash,
                    options.animate,
                )
                .ok()
                .map(|feedback| Box::new(feedback) as Box<dyn CaptureFeedback>)
            })
        } else {
            None
        };
        Ok(CaptureOutput {
            png,
            window,
            feedback,
        })
    })();
    if result.is_err() {
        cleanup(&directory);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_quotes_the_exec_path() {
        let entry = desktop_entry(Path::new("/home/user/Houston App/helper"));
        assert!(entry.contains("Exec=\"/home/user/Houston App/helper\" check"));
        assert!(entry.contains(MARKER));
        assert!(entry.contains("X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2"));
    }

    #[test]
    fn missing_helpers_report_not_installed() {
        let setup = KdeCaptureSetup::new(KdeCapturePaths {
            bundle: PathBuf::from("/nonexistent/bundle"),
            data_home: PathBuf::from("/nonexistent/data"),
        });
        assert_eq!(setup.state().status, "not-installed");
    }

    #[test]
    fn window_metadata_needs_positive_bounds() {
        let value = serde_json::json!({
            "window": {
                "title": "Editor",
                "appName": "Kate",
                "appIdentifier": "org.kde.kate",
                "processId": 42,
                "bounds": { "x": -10, "y": 5, "width": 800, "height": 600 },
                "clientBounds": { "x": -10, "y": 5, "width": 800, "height": 600 }
            }
        });
        let window = decode_window(&value).unwrap();
        assert_eq!(window.bounds.x, -10);
        assert_eq!(window.app_identifier, "org.kde.kate");
        assert!(decode_window(&serde_json::json!({ "window": null })).is_none());
    }

    #[test]
    fn capabilities_are_optional() {
        let value = serde_json::json!({ "feedbackAvailable": false });
        assert_eq!(
            value.get("feedbackAvailable").and_then(Value::as_bool),
            Some(false)
        );
    }
}

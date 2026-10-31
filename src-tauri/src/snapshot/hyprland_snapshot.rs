//! Hyprland's installed capture helper and its user-owned shortcut binding.
//! Mirrors upstream `HyprlandSnapShot.ts`; Houston does not bundle the helper.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::linux_capture_session::{read_portal_png, HYPRLAND_CAPTURE_ACTION};
use super::native_capture_feedback::NativeCaptureFeedback;
use super::platform::{
    Bounds, CaptureFeedback, CaptureOptions, CaptureOutput, PlatformPaths, WindowMetadata,
};

pub const HYPRLAND_CAPTURE_EXECUTABLE: &str = "t3-hyprland-snap-shot";
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

pub fn capture_executable(paths: &PlatformPaths) -> PathBuf {
    paths
        .data_home
        .join("t3code")
        .join("hyprland-capture")
        .join(HYPRLAND_CAPTURE_EXECUTABLE)
}

fn bundle_path(paths: &PlatformPaths) -> PathBuf {
    paths
        .state_dir
        .join("hyprland-capture")
        .join(HYPRLAND_CAPTURE_EXECUTABLE)
}

fn binding(app_id: &str, lua: bool) -> Result<String, String> {
    if app_id.is_empty()
        || !app_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err("Invalid capture application ID.".to_string());
    }
    let action = format!("{app_id}:{HYPRLAND_CAPTURE_ACTION}");
    Ok(if lua {
        format!("hl.bind(\"CTRL + SHIFT + 2\", hl.dsp.global(\"{action}\"))")
    } else {
        format!("bind = CTRL SHIFT, 2, global, {action}")
    })
}

pub struct HyprlandShortcut {
    pub binding: String,
    pub config_path: PathBuf,
}

pub fn capture_shortcut(app_id: &str, config_home: &Path) -> Result<HyprlandShortcut, String> {
    let directory = config_home.join("hypr");
    let exists = |name: &str| directory.join(name).exists();
    let lua = exists("hyprland.lua");
    let bindings = if lua { "bindings.lua" } else { "bindings.conf" };
    let config = if exists(bindings) {
        bindings
    } else if lua {
        "hyprland.lua"
    } else {
        "hyprland.conf"
    };
    Ok(HyprlandShortcut {
        binding: binding(app_id, lua)?,
        config_path: directory.join(config),
    })
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
    Err(if stderr.trim().is_empty() {
        "Hyprland capture did not respond. Check capture setup and try again.".to_string()
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
            "The capture helper must be a regular file: {} is not",
            path.display()
        ));
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("reading {}: {error}", path.display()))
}

pub struct HyprlandCaptureSetup {
    paths: PlatformPaths,
}

impl HyprlandCaptureSetup {
    pub fn new(paths: PlatformPaths) -> Self {
        Self { paths }
    }

    pub fn state(&self) -> CaptureHelperState {
        match self.check() {
            Ok(state) => state,
            Err(error) => state("error", &error, None),
        }
    }

    fn check(&self) -> Result<CaptureHelperState, String> {
        let executable = capture_executable(&self.paths);
        let Some(installed) = regular_file(&executable)? else {
            return Ok(state(
                "not-installed",
                "Install the bundled helper to capture the window you're using.",
                None,
            ));
        };
        let Some(bundle) = regular_file(&bundle_path(&self.paths))? else {
            return Err(
                "The Hyprland capture helper is missing from this build. Update or reinstall Houston."
                    .to_string(),
            );
        };
        if installed != bundle {
            return Ok(state(
                "update-required",
                "Update the bundled capture helper to continue.",
                None,
            ));
        }
        let capabilities = run(&executable, &["check"])?;
        let capabilities: Value = serde_json::from_str(&capabilities).map_err(|error| {
            format!("the Hyprland capture helper returned invalid JSON: {error}")
        })?;
        Ok(state(
            "ready",
            "Helper ready. Hyprland may ask for screen-sharing permission on your first capture.",
            capabilities
                .get("feedbackAvailable")
                .and_then(Value::as_bool),
        ))
    }

    pub fn perform(&self, action: &str) -> Result<(), String> {
        let executable = capture_executable(&self.paths);
        let directory = executable
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", executable.display()))?;
        if let Ok(metadata) = fs::symlink_metadata(directory) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("The capture helper directory must not be a link.".to_string());
            }
        }
        let _ = regular_file(&executable)?;
        if action == "remove-hyprland-helper" {
            let _ = fs::remove_file(&executable);
            return Ok(());
        }
        if action != "install-hyprland-helper" {
            return Err(format!(
                "unknown Hyprland capture setup action {action:?}; expected install-hyprland-helper or remove-hyprland-helper"
            ));
        }
        let bundle = regular_file(&bundle_path(&self.paths))?
            .ok_or_else(|| "The Hyprland capture helper is missing from this build.".to_string())?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("creating {}: {error}", directory.display()))?;
        let mut file = fs::File::create(&executable)
            .map_err(|error| format!("writing {}: {error}", executable.display()))?;
        file.write_all(&bundle)
            .map_err(|error| format!("writing {}: {error}", executable.display()))?;
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
    paths: &PlatformPaths,
    options: CaptureOptions,
    temp_dir: &Path,
) -> Result<CaptureOutput, String> {
    let setup = HyprlandCaptureSetup::new(paths.clone());
    let helper = setup.state();
    if helper.status != "ready" {
        return Err(format!(
            "{} Open Settings → SnapShots to continue setup.",
            helper.message
        ));
    }
    let executable = capture_executable(paths);
    fs::create_dir_all(temp_dir)
        .map_err(|error| format!("creating {}: {error}", temp_dir.display()))?;
    let directory = temp_dir.join(format!("hyprland-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("creating {}: {error}", directory.display()))?;
    let result = (|| {
        let output = run(&executable, &["capture", &directory.to_string_lossy()])?;
        let result: Value = serde_json::from_str(&output).map_err(|error| {
            format!("the Hyprland capture helper returned invalid JSON: {error}")
        })?;
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
        let _ = fs::remove_dir_all(&directory);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join(".agent-tmp")
            .join(format!("{name}-{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn shortcut_points_at_bindings_when_present() {
        let home = test_home("hyprland-test");
        let hypr = home.join("hypr");
        fs::create_dir_all(&hypr).unwrap();
        fs::write(hypr.join("hyprland.conf"), "").unwrap();
        fs::write(hypr.join("bindings.conf"), "").unwrap();
        let shortcut = capture_shortcut("dev.houston.desktop", &home).unwrap();
        assert_eq!(shortcut.config_path, hypr.join("bindings.conf"));
        assert_eq!(
            shortcut.binding,
            "bind = CTRL SHIFT, 2, global, dev.houston.desktop:capture-window"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lua_configs_use_the_lua_binding() {
        let home = test_home("hyprland-lua-test");
        let hypr = home.join("hypr");
        fs::create_dir_all(&hypr).unwrap();
        fs::write(hypr.join("hyprland.lua"), "").unwrap();
        let shortcut = capture_shortcut("dev.houston.desktop", &home).unwrap();
        assert_eq!(shortcut.config_path, hypr.join("hyprland.lua"));
        assert!(shortcut.binding.contains("hl.bind"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn invalid_app_ids_are_refused() {
        assert!(capture_shortcut("bad app", Path::new("/tmp")).is_err());
    }
}

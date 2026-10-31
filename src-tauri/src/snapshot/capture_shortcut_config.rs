//! Consent-gated Niri/Hyprland config I/O. Mirrors upstream
//! `CaptureShortcutConfig.ts`; the renderer can apply only the proposal the
//! desktop process retained.

use std::fs;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::capture_config_edit::{
    capture_config_keys, edit_capture_config, niri_config_conflict, niri_config_includes,
    CaptureConfigFormat,
};
use super::platform::{ConfigDesktop, PlatformPaths};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_FILES: usize = 64;
const TOOL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct Snapshot {
    path: PathBuf,
    resolved_path: PathBuf,
    text: String,
    bytes: Vec<u8>,
    mode: u32,
    inode: u64,
    uid: u32,
}

#[derive(Debug, Clone)]
struct Pending {
    preview: Value,
    preview_id: String,
    desktop: ConfigDesktop,
    app_id: String,
    files: Vec<Snapshot>,
    missing: Vec<PathBuf>,
    check_hyprland_keys: bool,
    shortcut: String,
}

pub struct CaptureShortcutConfig {
    pending: Mutex<Option<Pending>>,
    applying: AtomicBool,
}

impl Default for CaptureShortcutConfig {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            applying: AtomicBool::new(false),
        }
    }
}

pub fn niri_capture_config_path(paths: &PlatformPaths) -> PathBuf {
    std::env::var_os("NIRI_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.config_home.join("niri").join("config.kdl"))
}

fn read_snapshot(path: &Path) -> Result<Snapshot, String> {
    let resolved_path =
        fs::canonicalize(path).map_err(|error| format!("resolving {}: {error}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved_path)
        .map_err(|error| format!("opening {}: {error}", resolved_path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("checking {}: {error}", resolved_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", resolved_path.display()));
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("Choose a config file smaller than 1 MB.".to_string());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("reading {}: {error}", resolved_path.display()))?;
    if bytes.len() > MAX_BYTES {
        return Err("Choose a config file smaller than 1 MB.".to_string());
    }
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "Choose a UTF-8 text config file.".to_string())?;
    if text.contains('\0') {
        return Err("Choose a text config file.".to_string());
    }
    Ok(Snapshot {
        path: path.to_path_buf(),
        resolved_path,
        text,
        bytes,
        mode: metadata.mode() & 0o777,
        inode: metadata.ino(),
        uid: metadata.uid(),
    })
}

fn run_tool(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = crate::sys::spawn::command(program);
    command.args(args);
    let output = crate::sys::spawn::output_within(command, TOOL_TIMEOUT)
        .map_err(|error| format!("running {program}: {error}"))?
        .ok_or_else(|| format!("{program} timed out"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn validate_niri(path: &Path) -> Result<(), String> {
    run_tool("niri", &["validate", "--config", &path.to_string_lossy()]).map(|_| {
    })
    .map_err(|_| {
        "Niri couldn't validate the proposed config. Nothing was changed. Check your config in Advanced."
            .to_string()
    })
}

fn hyprland_bindings() -> Result<Vec<Value>, String> {
    let output = run_tool("hyprctl", &["-j", "binds"]).map_err(|_| {
        "Couldn't check Hyprland's current shortcuts. Try again from your Hyprland session."
            .to_string()
    })?;
    serde_json::from_str(&output)
        .map_err(|error| format!("hyprctl binds returned invalid JSON: {error}"))
}

fn check_hyprland_keys(app_id: &str, shortcut: &str) -> Result<(), String> {
    let keys = capture_config_keys(shortcut)?;
    let bindings = hyprland_bindings()?;
    if bindings.iter().any(|binding| {
        binding.get("modmask").and_then(Value::as_u64) == Some(keys.mask as u64)
            && binding
                .get("key")
                .and_then(Value::as_str)
                .is_some_and(|key| key.eq_ignore_ascii_case(&keys.key))
            && !(binding.get("dispatcher").and_then(Value::as_str) == Some("global")
                && binding.get("arg").and_then(Value::as_str)
                    == Some(format!("{app_id}:capture-window").as_str()))
    }) {
        return Err(format!(
            "{} is already used by Hyprland. Choose another shortcut.",
            keys.label
        ));
    }
    Ok(())
}

fn format_for(desktop: ConfigDesktop, path: &Path) -> Result<CaptureConfigFormat, String> {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    match (desktop, extension) {
        (ConfigDesktop::Niri, "kdl") => Ok(CaptureConfigFormat::Niri),
        (ConfigDesktop::Hyprland, "lua") => Ok(CaptureConfigFormat::HyprlandLua),
        (ConfigDesktop::Hyprland, "conf") => Ok(CaptureConfigFormat::Hyprland),
        _ => Err("Choose a .kdl Niri config or a .conf/.lua Hyprland config.".to_string()),
    }
}

impl CaptureShortcutConfig {
    pub fn preview(
        &self,
        request: &Value,
        selected_path: Option<&Path>,
        paths: &PlatformPaths,
        app_id: &str,
        desktop: ConfigDesktop,
    ) -> Result<Value, String> {
        if self.applying.load(Ordering::SeqCst) {
            return Err("Wait for the current config change to finish.".to_string());
        }
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
        let operation = request
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("install");
        if !matches!(operation, "install" | "remove") {
            return Err(format!(
                "unknown config operation {operation:?}; expected install or remove"
            ));
        }
        let shortcut = request.get("shortcut").and_then(Value::as_str);
        let default_path = match desktop {
            ConfigDesktop::Niri => niri_capture_config_path(paths),
            ConfigDesktop::Hyprland => {
                super::hyprland_snapshot::capture_shortcut(app_id, &paths.config_home)
                    .map(|shortcut| shortcut.config_path)?
            }
        };
        let root = read_snapshot(selected_path.unwrap_or(&default_path)).map_err(|_| {
            "Couldn't read your settings file. Choose a different file in Advanced.".to_string()
        })?;
        if root.uid != unsafe { libc::getuid() }
            || root
                .resolved_path
                .to_string_lossy()
                .contains("/omarchy/default/")
        {
            return Err("Choose your own config, not system or Omarchy defaults.".to_string());
        }
        let format = format_for(desktop, &root.path)?;
        let edit = edit_capture_config(&root.text, format, app_id, operation, shortcut)?;
        let must_check_hyprland_keys = operation == "install"
            && (format == CaptureConfigFormat::Hyprland
                || (format == CaptureConfigFormat::HyprlandLua && edit.after != root.text));
        let mut files = vec![root];
        let mut missing = Vec::new();
        if desktop == ConfigDesktop::Niri {
            let mut index = 0;
            while index < files.len() {
                if index > 10 || files.len() > MAX_FILES {
                    return Err(
                        "This config has too many included files. Use manual setup in Advanced."
                            .to_string(),
                    );
                }
                let file = files[index].clone();
                let includes = niri_config_includes(&file.text)?;
                for (include_path, optional) in includes {
                    if include_path.contains('$')
                        || include_path.contains('*')
                        || include_path.contains('?')
                        || include_path.contains('[')
                        || include_path.contains(']')
                    {
                        return Err(
                            "This config uses a dynamic include. Use manual setup in Advanced."
                                .to_string(),
                        );
                    }
                    let path = if let Some(rest) = include_path.strip_prefix("~/") {
                        paths.home.join(rest)
                    } else {
                        file.path
                            .parent()
                            .unwrap_or(Path::new("/"))
                            .join(&include_path)
                    };
                    let child = match read_snapshot(&path) {
                        Ok(child) => child,
                        Err(_) if optional && !path.exists() => {
                            missing.push(path);
                            continue;
                        }
                        Err(_) => {
                            return Err(
                                "Couldn't read an included Niri config. Check its location in Advanced."
                                    .to_string(),
                            )
                        }
                    };
                    if files
                        .iter()
                        .any(|item| item.resolved_path == child.resolved_path)
                    {
                        continue;
                    }
                    if operation == "install"
                        && niri_config_conflict(&child.text, app_id, &edit.shortcut)?
                    {
                        return Err(format!(
                            "{} is already used in {}. Choose another shortcut.",
                            edit.shortcut,
                            child.path.display()
                        ));
                    }
                    files.push(child);
                }
                index += 1;
            }
        } else if must_check_hyprland_keys {
            check_hyprland_keys(app_id, &edit.shortcut)?;
        }
        let preview_id = uuid::Uuid::new_v4().to_string();
        let preview = json!({
            "id": preview_id,
            "path": files[0].path,
            "resolvedPath": files[0].resolved_path,
            "before": files[0].text,
            "after": edit.after,
            "shortcut": edit.shortcut,
            "operation": operation,
        });
        if let Ok(mut pending) = self.pending.lock() {
            *pending = Some(Pending {
                preview: preview.clone(),
                preview_id,
                desktop,
                app_id: app_id.to_string(),
                files,
                missing,
                check_hyprland_keys: must_check_hyprland_keys,
                shortcut: edit.shortcut,
            });
        }
        Ok(preview)
    }

    pub fn apply(&self, id: &str, desktop: ConfigDesktop) -> Result<Value, String> {
        if self.applying.swap(true, Ordering::SeqCst) {
            return Err("This preview expired. Review changes again before saving.".to_string());
        }
        let result = self.apply_inner(id, desktop);
        self.applying.store(false, Ordering::SeqCst);
        result
    }

    fn apply_inner(&self, id: &str, desktop: ConfigDesktop) -> Result<Value, String> {
        let pending = {
            let mut slot = self
                .pending
                .lock()
                .map_err(|_| "The config preview state is unavailable.".to_string())?;
            match slot.take() {
                Some(pending) if pending.preview_id == id && pending.desktop == desktop => pending,
                _ => {
                    return Err(
                        "This preview expired. Review changes again before saving.".to_string()
                    )
                }
            }
        };
        let root = pending
            .files
            .first()
            .cloned()
            .ok_or_else(|| "The config preview has no root file.".to_string())?;
        let directory = root
            .resolved_path
            .parent()
            .ok_or_else(|| "The config file has no parent directory.".to_string())?
            .to_path_buf();
        let temporary = directory.join(format!(
            ".houston-capture-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let unchanged = || -> Result<(), String> {
            for path in &pending.missing {
                if path.exists() {
                    return Err(
                        "Your config changed since this preview. Review changes again before saving."
                            .to_string(),
                    );
                }
            }
            for original in &pending.files {
                let current = read_snapshot(&original.path).map_err(|_| {
                    "Your config changed since this preview. Nothing was saved. Review changes again before saving."
                        .to_string()
                })?;
                if current.resolved_path != original.resolved_path
                    || current.inode != original.inode
                    || current.mode != original.mode
                    || current.bytes != original.bytes
                {
                    return Err(
                        "Your config changed since this preview. Nothing was saved. Review changes again before saving."
                            .to_string(),
                    );
                }
            }
            Ok(())
        };
        unchanged()?;
        if pending.check_hyprland_keys {
            check_hyprland_keys(&pending.app_id, &pending.shortcut)?;
        }
        let before = pending
            .preview
            .get("before")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let after = pending
            .preview
            .get("after")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if before == after {
            return Ok(json!({ "backupPath": Value::Null, "warning": Value::Null }));
        }
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(root.mode)
                .open(&temporary)
                .map_err(|error| format!("creating {}: {error}", temporary.display()))?;
            use std::io::Write;
            file.write_all(after.as_bytes())
                .map_err(|error| format!("writing {}: {error}", temporary.display()))?;
        }
        fs::set_permissions(&temporary, fs::Permissions::from_mode(root.mode))
            .map_err(|error| format!("setting permissions on {}: {error}", temporary.display()))?;
        if desktop == ConfigDesktop::Niri {
            validate_niri(&temporary)?;
        }
        unchanged()?;
        let backup = root.resolved_path.with_extension(format!(
            "houston-capture-backup-{}",
            uuid::Uuid::new_v4().simple()
        ));
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&backup)
                .map_err(|error| format!("creating {}: {error}", backup.display()))?;
            use std::io::Write;
            file.write_all(&root.bytes)
                .map_err(|error| format!("writing {}: {error}", backup.display()))?;
        }
        fs::rename(&temporary, &root.resolved_path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "renaming {} to {}: {error}",
                temporary.display(),
                root.resolved_path.display()
            )
        })?;
        let mut warning = Value::Null;
        if desktop == ConfigDesktop::Hyprland {
            let reload = run_tool("hyprctl", &["reload"]).and_then(|_| {
                let errors = run_tool("hyprctl", &["configerrors"])?;
                if errors.trim().is_empty() {
                    Ok(())
                } else {
                    Err("Hyprland reported config errors.".to_string())
                }
            });
            if reload.is_err() {
                warning = Value::String(
                    "Config saved, but Hyprland couldn't reload it cleanly. Check hyprctl configerrors, then run hyprctl reload."
                        .to_string(),
                );
            }
        }
        Ok(json!({
            "backupPath": backup.to_string_lossy(),
            "warning": warning,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_requires_the_matching_extension() {
        assert!(format_for(ConfigDesktop::Niri, Path::new("config.kdl")).is_ok());
        assert!(format_for(ConfigDesktop::Niri, Path::new("config.conf")).is_err());
        assert!(format_for(ConfigDesktop::Hyprland, Path::new("bindings.lua")).is_ok());
        assert!(format_for(ConfigDesktop::Hyprland, Path::new("bindings.conf")).is_ok());
        assert!(format_for(ConfigDesktop::Hyprland, Path::new("bindings.kdl")).is_err());
    }
}

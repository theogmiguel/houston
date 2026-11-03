//! `houston://` deep links and `houston <folder>` activation, handed to the renderer
//! once it is ready to receive them.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub const WEB_LINK_EVENT: &str = "v2-web-link-open";
pub const ACTIVATION_EVENT: &str = "v2-app-activation-request";
pub const SCHEME: &str = "houston";

/// One launch's targets: deep links and workspace folders, in argument order.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchTargets {
    pub web_links: Vec<String>,
    pub workspaces: Vec<PathBuf>,
}

/// Registers the `houston://` handler for the installed release channel. A dev,
/// nightly or other named channel leaves the system default untouched.
pub fn ensure_protocol_registered() {
    if crate::sys::paths::channel().ok().flatten().is_some() {
        return;
    }
    #[cfg(target_os = "linux")]
    register_linux();
    #[cfg(windows)]
    register_windows();
}

#[cfg(target_os = "linux")]
fn desktop_entry(exec: &str) -> String {
    let quoted = if exec.contains(' ') {
        format!("\"{exec}\"")
    } else {
        exec.to_string()
    };
    format!(
        "[Desktop Entry]\n\
         Name=Houston\n\
         Comment=Mission control for CLI coding agents\n\
         Exec={quoted} %u\n\
         Terminal=false\n\
         Type=Application\n\
         MimeType=x-scheme-handler/{SCHEME};\n\
         NoDisplay=true\n\
         Categories=DeveloperTool;\n\
         StartupWMClass=houston\n"
    )
}

#[cfg(target_os = "linux")]
fn register_linux() {
    use std::fs;

    let executable = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let Some(executable) = executable else {
        return;
    };
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let applications = data_home.join("applications");
    if let Err(error) = fs::create_dir_all(&applications) {
        eprintln!(
            "houston-tauri: could not create {} to register {SCHEME}:// links: {error}",
            applications.display()
        );
        return;
    }
    let desktop_file = applications.join("houston.desktop");
    let entry = desktop_entry(&executable.display().to_string());
    if let Err(error) = fs::write(&desktop_file, entry) {
        eprintln!(
            "houston-tauri: could not write {} to register {SCHEME}:// links: {error}",
            desktop_file.display()
        );
        return;
    }
    let _ = crate::sys::spawn::command("update-desktop-database")
        .arg(&applications)
        .status();
    let _ = crate::sys::spawn::command("xdg-mime")
        .args([
            "default",
            "houston.desktop",
            &format!("x-scheme-handler/{SCHEME}"),
        ])
        .status();
}

#[cfg(windows)]
fn register_windows() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let class = format!("Software\\Classes\\{SCHEME}");
    let run = |args: &[&str]| {
        let _ = crate::sys::spawn::command("reg").args(args).status();
    };
    run(&["add", &class, "/ve", "/d", "URL:Houston", "/f"]);
    run(&["add", &class, "/v", "URL Protocol", "/d", "", "/f"]);
    let command = format!("\"{}\" \"%1\"", executable.display());
    let subkey = format!("{class}\\shell\\open\\command");
    run(&["add", &subkey, "/ve", "/d", &command, "/f"]);
}

pub fn is_web_link(arg: &str) -> bool {
    match url::Url::parse(arg) {
        Ok(url) => url.scheme() == SCHEME,
        Err(_) => false,
    }
}

/// Whether an argument names an existing folder that `houston <folder>` would open.
pub fn is_workspace_argument(arg: &str, cwd: &Path) -> bool {
    workspace_argument(arg, cwd).is_some()
}

/// Resolves a `houston <folder>` argument, relative paths against the launch's cwd.
fn workspace_argument(arg: &str, cwd: &Path) -> Option<PathBuf> {
    if arg.starts_with('-') {
        return None;
    }
    let path = Path::new(arg);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    path.is_dir().then_some(path)
}

/// Splits a process launch's arguments into open targets, ignoring flags and anything
/// that is neither a link nor a folder.
pub fn launch_targets(args: &[String], cwd: &Path) -> LaunchTargets {
    let mut targets = LaunchTargets::default();
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--channel" {
            i += 2;
            continue;
        }
        if arg.starts_with("--channel=") || arg == "--print-target" {
            i += 1;
            continue;
        }
        if is_web_link(arg) {
            targets.web_links.push(arg.clone());
        } else if let Some(path) = workspace_argument(arg, cwd) {
            targets.workspaces.push(path);
        }
        i += 1;
    }
    targets
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest {
    version: u32,
    request_id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    workspace_root: String,
    platform: &'static str,
}

fn platform_label() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

#[derive(Default)]
struct Pending {
    web_links: Vec<String>,
    activations: Vec<Value>,
    web_links_ready: bool,
    activation_ready: bool,
    next_request_id: u64,
}

pub struct DeepLinkHost {
    pending: Mutex<Pending>,
}

impl DeepLinkHost {
    pub fn new(web_links: Vec<String>, workspaces: Vec<PathBuf>) -> Self {
        let mut pending = Pending {
            web_links,
            ..Pending::default()
        };
        for workspace in workspaces {
            let request = activation_request(&mut pending, &workspace);
            pending.activations.push(request);
        }
        Self {
            pending: Mutex::new(pending),
        }
    }

    fn push_web_link(&self, app: &AppHandle, url: String) {
        let queued = {
            let mut pending = self.pending.lock().expect("deep link queue");
            if pending.web_links_ready {
                false
            } else {
                pending.web_links.push(url.clone());
                true
            }
        };
        if !queued {
            emit_to_main(app, WEB_LINK_EVENT, url);
        }
    }

    fn push_workspace(&self, app: &AppHandle, workspace: &Path) {
        let request = {
            let mut pending = self.pending.lock().expect("deep link queue");
            let request = activation_request(&mut pending, workspace);
            if !pending.activation_ready {
                pending.activations.push(request.clone());
                return;
            }
            request
        };
        emit_to_main(app, ACTIVATION_EVENT, request);
    }

    fn set_web_links_ready(&self, app: &AppHandle, ready: bool) {
        let flush = {
            let mut pending = self.pending.lock().expect("deep link queue");
            pending.web_links_ready = ready;
            if ready {
                std::mem::take(&mut pending.web_links)
            } else {
                Vec::new()
            }
        };
        for url in flush {
            emit_to_main(app, WEB_LINK_EVENT, url);
        }
    }

    fn set_activation_ready(&self, app: &AppHandle, ready: bool) {
        let flush = {
            let mut pending = self.pending.lock().expect("deep link queue");
            pending.activation_ready = ready;
            if ready {
                std::mem::take(&mut pending.activations)
            } else {
                Vec::new()
            }
        };
        for request in flush {
            emit_to_main(app, ACTIVATION_EVENT, request);
        }
    }
}

fn activation_request(pending: &mut Pending, workspace: &Path) -> Value {
    pending.next_request_id += 1;
    serde_json::to_value(ActivationRequest {
        version: 1,
        request_id: format!("app-activation-{}", pending.next_request_id),
        kind: "open-workspace",
        workspace_root: workspace.display().to_string(),
        platform: platform_label(),
    })
    .expect("activation request serializes")
}

fn emit_to_main<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Err(error) = app.emit_to("main", event, payload) {
        eprintln!("houston-tauri: delivering {event} to the window: {error}");
    }
    crate::tray::show_main_window(app);
}

/// Hands a second launch's deep links and workspace folders to the running window.
pub fn forward(app: &AppHandle, argv: &[String], cwd: &str) {
    let targets = launch_targets(argv, Path::new(cwd));
    let host = app.state::<DeepLinkHost>();
    for url in targets.web_links {
        host.push_web_link(app, url);
    }
    for workspace in targets.workspaces {
        host.push_workspace(app, &workspace);
    }
}

#[tauri::command]
pub fn v2_web_links_set_ready(
    app: AppHandle,
    host: State<'_, DeepLinkHost>,
    ready: bool,
) -> Result<(), String> {
    host.set_web_links_ready(&app, ready);
    Ok(())
}

#[tauri::command]
pub fn v2_app_activation_set_ready(
    app: AppHandle,
    host: State<'_, DeepLinkHost>,
    ready: bool,
) -> Result<(), String> {
    host.set_activation_ready(&app, ready);
    Ok(())
}

/// The renderer answers an activation with its thread, or with a refusal it shows itself.
#[tauri::command]
pub fn v2_app_activation_complete(response: Value) -> Result<(), String> {
    if !response.is_object() {
        return Err(format!(
            "v2_app_activation_complete expects an activation response object, got {response}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(rest: &[&str]) -> Vec<String> {
        std::iter::once("houston")
            .chain(rest.iter().copied())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn houston_links_and_existing_folders_are_launch_targets() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        std::fs::create_dir(&workspace).unwrap();
        let targets = launch_targets(
            &args(&[
                "--channel",
                "dev",
                "houston://pair?url=https%3A%2F%2Fexample.com",
                workspace.to_str().unwrap(),
                "missing-folder",
            ]),
            dir.path(),
        );
        assert_eq!(
            targets.web_links,
            vec!["houston://pair?url=https%3A%2F%2Fexample.com"]
        );
        assert_eq!(targets.workspaces, vec![workspace]);
    }

    #[test]
    fn relative_folders_resolve_against_the_launch_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("relative")).unwrap();
        assert_eq!(
            launch_targets(&args(&["relative"]), dir.path()).workspaces,
            vec![dir.path().join("relative")]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_desktop_entry_registers_the_scheme_and_quotes_a_path_with_spaces() {
        let entry = desktop_entry("/opt/Houston App/houston");
        assert!(
            entry.contains("MimeType=x-scheme-handler/houston;"),
            "{entry}"
        );
        assert!(
            entry.contains("Exec=\"/opt/Houston App/houston\" %u"),
            "{entry}"
        );
    }

    #[test]
    fn other_schemes_and_transfer_files_are_not_launch_targets() {
        let dir = tempfile::tempdir().unwrap();
        let targets = launch_targets(
            &args(&["https://example.com", "work.houston-transfer"]),
            dir.path(),
        );
        assert!(targets.web_links.is_empty());
        assert!(targets.workspaces.is_empty());
    }
}

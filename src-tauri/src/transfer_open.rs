//! Opening a workspace transfer file with the app: the first launch keeps the path for
//! the renderer to take once; a later launch hands it to the running window as an event.

use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

pub const EVENT: &str = "transfer-open";
pub const EXTENSION: &str = "houston-transfer";

/// The transfer file among a launch's arguments, resolved against the launch's `cwd`.
pub fn file_argument(args: &[String], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find_map(|arg| {
        let path = Path::new(arg);
        let named = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION));
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        (named && path.is_file()).then(|| path.display().to_string())
    })
}

pub struct LaunchFile(Mutex<Option<String>>);

impl LaunchFile {
    pub fn new(path: Option<String>) -> Self {
        Self(Mutex::new(path))
    }
}

#[tauri::command]
pub fn transfer_launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state.0.lock().map(|mut file| file.take()).unwrap_or(None)
}

/// Hands a second launch's transfer file to the running window.
pub fn forward<R: Runtime>(app: &AppHandle<R>, argv: &[String], cwd: &str) {
    if let Some(path) = file_argument(argv, Path::new(cwd)) {
        if let Err(error) = app.emit(EVENT, path) {
            eprintln!("houston-tauri: forwarding a transfer file to the window: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_existing_transfer_file_argument_counts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("work.houston-transfer");
        std::fs::write(&file, b"x").unwrap();
        let args = |rest: &[&str]| {
            std::iter::once("houston")
                .chain(rest.iter().copied())
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            file_argument(
                &args(&["--channel", "dev", "work.houston-transfer"]),
                dir.path()
            ),
            Some(file.display().to_string())
        );
        assert_eq!(
            file_argument(&args(&["missing.houston-transfer"]), dir.path()),
            None
        );
        assert_eq!(
            file_argument(&args(&["--channel", "dev"]), dir.path()),
            None
        );
    }
}

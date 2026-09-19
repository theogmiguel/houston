use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraySettings {
    pub keep_in_tray: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        TraySettings { keep_in_tray: true }
    }
}

fn path(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join("tray.json")
}

pub fn load(state_dir: &Path) -> TraySettings {
    let file = path(state_dir);
    let body = match fs::read_to_string(&file) {
        Ok(body) => body,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return TraySettings::default(),
        Err(err) => {
            eprintln!(
                "houston-tauri: {} unreadable ({err}), keeping the default tray setting",
                file.display()
            );
            return TraySettings::default();
        }
    };
    match serde_json::from_str::<TraySettings>(&body) {
        Ok(settings) => settings,
        Err(err) => {
            eprintln!(
                "houston-tauri: {} is corrupt ({err}), keeping the default tray setting",
                file.display()
            );
            TraySettings::default()
        }
    }
}

pub fn save(state_dir: &Path, settings: &TraySettings) -> io::Result<()> {
    let dest = path(state_dir);
    let tmp = state_dir.join("tray.json.tmp");
    let body = serde_json::to_string_pretty(settings)
        .expect("TraySettings is one bool; serialization cannot fail");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_channel_keeps_houston_in_the_tray() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(load(dir.path()).keep_in_tray);
    }

    #[test]
    fn a_saved_choice_survives_a_reload() {
        let dir = tempfile::tempdir().expect("tempdir");
        save(
            dir.path(),
            &TraySettings {
                keep_in_tray: false,
            },
        )
        .expect("save");
        assert!(!load(dir.path()).keep_in_tray);
        save(dir.path(), &TraySettings { keep_in_tray: true }).expect("save");
        assert!(load(dir.path()).keep_in_tray);
    }

    #[test]
    fn a_corrupt_file_falls_back_rather_than_trapping_the_window() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("tray.json"), "{ not json").expect("write");
        assert!(load(dir.path()).keep_in_tray);
    }
}
